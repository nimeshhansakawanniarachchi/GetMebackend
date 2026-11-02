const crypto = require('crypto');

// =====================================================
// BANK PAYMENT ADAPTER FACTORY (phase 55, payment audit 2026-10-31)
//
// Every bank that may one day pay a LankaQR merchant from GetMe's
// account (DFCC, Commercial Bank, Sampath, HNB, BOC, ...) plugs in
// through this factory, so the bank-independent parts are written once:
//   - configuration from the environment, per bank prefix:
//       <PREFIX>_ENV             sandbox | production
//       <PREFIX>_SANDBOX_URL     base URL the bank gives for its sandbox
//       <PREFIX>_PRODUCTION_URL  base URL for production
//       <PREFIX>_CLIENT_ID / <PREFIX>_CLIENT_SECRET   API credentials
//       <PREFIX>_CALLBACK_SECRET shared secret of signed callbacks
//     These are GetMe's own setting names. The URLs and credentials are
//     whatever the bank issues; nothing here is a bank endpoint.
//   - production needs NODE_ENV=production + https; sandbox never runs
//     with NODE_ENV=production (sandbox money is not real money)
//   - our payment reference format (GETME-<order>-<attempt>) is checked
//     before anything is sent or accepted
//   - timeouts / network errors / unreadable answers become 'unknown'
//     (never 'failed': the bank may have paid)
//   - signed callbacks: HMAC over the raw body, compared in constant
//     time, with a timestamp window against replays
//
// The bank-specific part is an `implementation` object the bank's
// adapter file supplies once the bank publishes its API:
//   buildInitiate(ctx, input)   -> { path, method, headers, body }
//   parseInitiate(ctx, reply)   -> { status, providerRef?, amount?, message?,
//                                    authUrl?, expiresAt? }
//   buildStatus(ctx, input)     -> { path, method, headers, body? }
//   parseStatus(ctx, reply)     -> same shape as parseInitiate
//   buildCancel / parseCancel   (optional) stop a payment the payer has
//                               not approved yet
//   buildReverse / parseReverse (optional) reverse a completed payment
//   callback: { signatureHeader, timestampHeader?, algorithm, parse(body) -> { reference, providerRef, status, amount } }
//   auth(ctx)                   -> extra headers (e.g. an OAuth token)
//
// Phase 56 (scan-to-pay from the shopper's own account): input
// fundingSource is 'company' (GetMe's account, phase 49) or 'payer'
// (the shopper's own linked account - the CBSL-compliant third-party
// app model). A payer payment usually answers 'action_required' with
// authUrl: the BANK's page where the shopper approves (PIN / OTP at the
// bank; GetMe never sees them). The result is only ever taken from the
// bank (status query / signed callback), never from the app.
// Without an implementation the adapter reports "not configured" and
// refuses every call: no money can move through it.
// =====================================================

// action_required: waiting for the payer to approve at their bank
const PROVIDER_STATUSES = ['accepted', 'pending', 'action_required', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired', 'reversed', 'unknown'];
// GETME-<order>-<attempt> (supermarket), GETMEF-<fuel payment> (fuel)
const REFERENCE = /^(GETME-\d{1,10}-\d{1,10}|GETMEF-\d{1,12})$/;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

const validReference = (reference) => REFERENCE.test(String(reference || ''));

// Constant-time HMAC check of a signed callback
const verifyHmac = ({ rawBody, signature, secret, algorithm = 'sha256', timestamp = null, maxAgeSeconds = 300 }) => {
  if (!secret || !rawBody || !signature) return { valid: false, reason: 'Missing signature, body or secret' };
  if (timestamp != null) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > maxAgeSeconds) {
      return { valid: false, reason: 'Callback timestamp outside the allowed window' };
    }
  }
  const signed = timestamp != null ? `${timestamp}.${rawBody}` : rawBody;
  const expected = crypto.createHmac(algorithm, secret).update(signed).digest('hex');
  const given = String(signature).trim().toLowerCase().replace(/^sha\d+=/, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? { valid: true } : { valid: false, reason: 'Signature does not match' };
};

// A bank result in our provider vocabulary; anything unrecognised is unknown
const normalise = (result) => {
  const status = PROVIDER_STATUSES.includes(result?.status) ? result.status : 'unknown';
  const amount = result?.amount != null && Number.isFinite(Number(result.amount)) ? Math.round(Number(result.amount) * 100) / 100 : undefined;
  // The bank's approval page: https only (http only for the local test
  // simulator page, which never runs in production)
  const authUrl = typeof result?.authUrl === 'string' && /^https:\/\//i.test(result.authUrl) ? result.authUrl.slice(0, 2000) : undefined;
  const expires = result?.expiresAt ? new Date(result.expiresAt) : null;
  return {
    status: status === 'action_required' && !authUrl ? 'pending' : status,
    providerRef: result?.providerRef ? String(result.providerRef).slice(0, 80) : undefined,
    amount,
    message: result?.message ? String(result.message).slice(0, 300) : undefined,
    authUrl,
    expiresAt: expires && Number.isFinite(expires.getTime()) ? expires.toISOString() : undefined,
  };
};

const settingsFor = (prefix, env = process.env) => {
  const read = (name) => String(env[`${prefix}_${name}`] ?? '').trim();
  const mode = read('ENV').toLowerCase();
  return {
    mode: mode === 'production' || mode === 'sandbox' ? mode : null,
    baseUrl: mode === 'production' ? read('PRODUCTION_URL') : mode === 'sandbox' ? read('SANDBOX_URL') : '',
    clientId: read('CLIENT_ID'),
    clientSecret: read('CLIENT_SECRET'),
    callbackSecret: read('CALLBACK_SECRET'),
  };
};

// Why this adapter can't run here (null = it can)
const configProblem = ({ label, envPrefix, implementation, waitingFor }, env = process.env) => {
  if (!implementation) return waitingFor || `${label} has not provided an API for paying LankaQR merchants from a corporate account`;
  const settings = settingsFor(envPrefix, env);
  if (!settings.mode) return `${envPrefix}_ENV is not set (sandbox or production)`;
  const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
  if (settings.mode === 'sandbox' && production) return `${label}: the bank sandbox can never run with NODE_ENV=production`;
  if (settings.mode === 'production' && !production) return `${label}: production needs NODE_ENV=production`;
  if (!settings.baseUrl) return `${envPrefix}_${settings.mode === 'production' ? 'PRODUCTION' : 'SANDBOX'}_URL is not set`;
  if (!/^https:\/\//i.test(settings.baseUrl)) return `${label}: the bank URL must be https`;
  if (!settings.clientId || !settings.clientSecret) return `${envPrefix}_CLIENT_ID / ${envPrefix}_CLIENT_SECRET are not set`;
  return null;
};

// What a provider can do (only true with a real implementation)
const CAPABILITIES = ['lankaqrMerchantPayment', 'companyFunded', 'payerFunded', 'payerAuth', 'statusQuery', 'signedCallbacks', 'cancel', 'reversal'];
const capabilityView = (implemented, capabilities = {}) =>
  Object.fromEntries(CAPABILITIES.map((name) => [name, Boolean(implemented && capabilities[name])]));

const createBankAdapter = (spec) => {
  const { key, label, envPrefix, implementation = null, capabilities = {}, timeoutMs = 20000 } = spec;

  const describe = (env = process.env) => {
    const problem = configProblem(spec, env);
    const settings = settingsFor(envPrefix, env);
    return {
      key,
      label: implementation ? label : `${label} (not connected)`,
      configured: !problem,
      live: false,
      simulator: false,
      environment: settings.mode,
      capabilities: capabilityView(Boolean(implementation), capabilities),
      reason: problem,
    };
  };

  const ready = () => {
    const problem = configProblem(spec);
    if (problem) throw fail(503, 'PROVIDER_NOT_CONFIGURED', `The ${label} payment provider is not configured: ${problem}`);
    return { settings: settingsFor(envPrefix), label, key };
  };

  // One HTTP call to the bank; transport problems are 'unknown'
  const call = async (ctx, request, parse) => {
    let response;
    try {
      const extra = implementation.auth ? await implementation.auth(ctx) : {};
      response = await fetch(`${ctx.settings.baseUrl}${request.path}`, {
        method: request.method || 'POST',
        headers: { 'Content-Type': 'application/json', ...extra, ...(request.headers || {}) },
        body: request.body != null ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { status: 'unknown', message: `No answer from ${label} (${error.name === 'TimeoutError' ? 'timeout' : 'network error'})` };
    }
    const data = await response.json().catch(() => null);
    if (!data || response.status >= 500) {
      return { status: 'unknown', message: `No clear answer from ${label} (HTTP ${response.status})` };
    }
    return normalise(parse(ctx, { httpStatus: response.status, data }));
  };

  return {
    key,
    label,
    describe: () => describe(process.env),
    initiate: async (input) => {
      const ctx = ready();
      if (!validReference(input?.reference)) throw fail(400, 'BAD_REFERENCE', 'Payment reference is not a GetMe reference');
      if (!(Number(input?.amount) > 0)) throw fail(400, 'BAD_AMOUNT', 'Payment amount must be above zero');
      const source = input?.fundingSource === 'payer' ? 'payerFunded' : 'companyFunded';
      if (!capabilities[source]) throw fail(409, 'NOT_SUPPORTED', `${label} does not support ${source === 'payerFunded' ? "payments from the payer's own account" : "payments from GetMe's account"}`);
      return call(ctx, implementation.buildInitiate(ctx, input), implementation.parseInitiate);
    },
    // Optional operations: 'unknown' when the bank offers none
    cancel: async (input) => {
      const ctx = ready();
      if (!capabilities.cancel || !implementation.buildCancel) return { status: 'unknown', message: `${label} has no cancel operation` };
      return call(ctx, implementation.buildCancel(ctx, input), implementation.parseCancel);
    },
    reverse: async (input) => {
      const ctx = ready();
      if (!capabilities.reversal || !implementation.buildReverse) return { status: 'unknown', message: `${label} has no reversal operation` };
      return call(ctx, implementation.buildReverse(ctx, input), implementation.parseReverse);
    },
    queryStatus: async (input) => {
      const ctx = ready();
      if (!capabilities.statusQuery) return { status: 'unknown', message: `${label} has no status enquiry` };
      return call(ctx, implementation.buildStatus(ctx, input), implementation.parseStatus);
    },
    // -> { valid, reason?, result?: { reference, providerRef, status, amount } }
    verifyCallback: (req) => {
      if (!implementation?.callback || !capabilities.signedCallbacks) {
        return { valid: false, reason: `${label} does not send signed callbacks (not supported)` };
      }
      if (configProblem(spec)) return { valid: false, reason: 'Provider not configured' };
      const settings = settingsFor(envPrefix);
      const { signatureHeader, timestampHeader, algorithm } = implementation.callback;
      const check = verifyHmac({
        rawBody: req.rawBody,
        signature: req.get(signatureHeader),
        secret: settings.callbackSecret,
        algorithm,
        timestamp: timestampHeader ? req.get(timestampHeader) : null,
      });
      if (!check.valid) return check;
      let parsed;
      try {
        parsed = implementation.callback.parse(req.body);
      } catch (error) {
        return { valid: false, reason: 'Callback body not understood' };
      }
      if (!validReference(parsed?.reference)) return { valid: false, reason: 'Callback reference is not a GetMe reference' };
      return { valid: true, result: { reference: parsed.reference, ...normalise(parsed) } };
    },
  };
};

module.exports = { createBankAdapter, verifyHmac, validReference, normalise, settingsFor, configProblem, capabilityView, CAPABILITIES, PROVIDER_STATUSES };
