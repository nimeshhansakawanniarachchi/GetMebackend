const dfcc = require('./dfcc');
const banks = require('./banks');
const simulator = require('./simulator');

// =====================================================
// LANKAQR PAYMENT PROVIDERS (phase 49)
// GROCERY_QR_PROVIDER picks one:
//   unset / none  no provider (production default): getme_lankaqr is
//                 unavailable, its endpoints answer 503
//   dfcc, combank, sampath, hnb, boc
//                 bank adapters (phase 55, providers/banks.js): not
//                 connected until the bank publishes an API
//   simulator     TEST SIMULATOR: only when NODE_ENV !== 'production'
//                 and GROCERY_QR_LIVE is not 'true'
// GROCERY_QR_LIVE=true is required (in addition to a configured
// provider) for a LIVE provider; it can never be used with the
// simulator.
//
// Provider interface:
//   describe()  -> { key, label, configured, live, simulator, reason }
//   initiate({ attemptId, idempotencyKey, amount, currency, merchant, reference })
//               -> { status: accepted|pending|succeeded|failed|rejected|unknown,
//                    providerRef?, amount?, message? }
//   queryStatus({ attemptId, providerRef, idempotencyKey, amount })
//               -> same statuses
//   verifyCallback(req) -> { valid, reason?, ... }
// =====================================================

const none = {
  key: 'none',
  label: 'No provider',
  describe: () => ({
    key: 'none',
    label: 'No provider',
    configured: false,
    live: false,
    simulator: false,
    reason: 'No LANKAQR payment provider is configured on this server (GROCERY_QR_PROVIDER is not set).',
  }),
  initiate: async () => {
    throw Object.assign(new Error('No LANKAQR payment provider is configured'), { status: 503, code: 'PROVIDER_NOT_CONFIGURED' });
  },
  queryStatus: async () => {
    throw Object.assign(new Error('No LANKAQR payment provider is configured'), { status: 503, code: 'PROVIDER_NOT_CONFIGURED' });
  },
  verifyCallback: () => ({ valid: false, reason: 'No provider is configured' }),
};

const truthy = (value) => String(value ?? '').trim().toLowerCase() === 'true';

// Picks the provider from an environment (process.env by default)
const resolve = (env = process.env) => {
  const key = String(env.GROCERY_QR_PROVIDER ?? '').trim().toLowerCase();
  const liveFlag = truthy(env.GROCERY_QR_LIVE);

  if (!key || key === 'none') return none;
  if (key === 'dfcc') return dfcc.create();
  if (banks.BANKS[key]) return banks.create(key);

  if (key === 'simulator') {
    if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
      return simulator.create({ disabledReason: 'The test simulator can never run in production (NODE_ENV=production).' });
    }
    if (liveFlag) {
      return simulator.create({ disabledReason: 'The test simulator can never run together with live mode (GROCERY_QR_LIVE=true).' });
    }
    return simulator.create();
  }

  return {
    ...none,
    key,
    describe: () => ({ key, label: 'Unknown provider', configured: false, live: false, simulator: false, reason: `Unknown GROCERY_QR_PROVIDER value "${key.slice(0, 20)}".` }),
  };
};

// Provider + whether payments may be made with it now:
//   usable = configured AND (simulator: never live, never production;
//            a live provider: GROCERY_QR_LIVE=true)
const state = (env = process.env) => {
  const provider = resolve(env);
  const info = provider.describe();
  const liveFlag = truthy(env.GROCERY_QR_LIVE);
  let usable = Boolean(info.configured);
  let reason = info.reason;

  if (usable && !info.simulator && !liveFlag) {
    usable = false;
    reason = 'The provider is configured but live mode is off (GROCERY_QR_LIVE is not true).';
  }

  return {
    provider,
    key: info.key,
    label: info.label,
    configured: Boolean(info.configured),
    simulator: Boolean(info.simulator),
    live: Boolean(usable && !info.simulator),
    liveFlag,
    usable,
    reason,
  };
};

const current = () => state(process.env);

// Phase 50: what each provider key can do, read from THIS code (never
// from an account number or a bank's name). transactionTypes[type] =
// true only when the module really implements it:
//   dfcc       stub: implements nothing (DFCC has not provided an API)
//   simulator  TEST SIMULATOR: implements the LankaQR merchant payment
//              for automated tests only (never production / live)
// bankKeys: the company bank accounts a provider can pay from (null =
// any; the simulator moves no money). Company accounts choose one of
// these keys (src/companyAccounts/integration.js).
const REGISTRY = {
  // Phase 55: one entry per bank adapter (providers/banks.js);
  // lankaqr_merchant_payment is true only once an implementation exists
  ...Object.fromEntries(
    Object.values(banks.BANKS).map((bank) => [
      bank.key,
      {
        key: bank.key,
        label: bank.implementation ? bank.label : `${bank.label} (not connected)`,
        bankKeys: bank.bankKeys,
        testOnly: false,
        transactionTypes: { lankaqr_merchant_payment: Boolean(bank.implementation && bank.capabilities.lankaqrMerchantPayment) },
        note: bank.implementation ? null : bank.waitingFor,
      },
    ])
  ),
  simulator: {
    key: 'simulator',
    label: simulator.NOTICE,
    bankKeys: null,
    testOnly: true,
    transactionTypes: { lankaqr_merchant_payment: true },
    note: 'Test simulator for automated tests only. No money moves; never production.',
  },
};

const registry = () => Object.values(REGISTRY).map((entry) => ({ ...entry, transactionTypes: { ...entry.transactionTypes } }));
const registryEntry = (key) => (REGISTRY[key] ? { ...REGISTRY[key], transactionTypes: { ...REGISTRY[key].transactionTypes } } : null);

// describe() of a provider key as this server's environment would run
// it (credentials / switches come from the environment only)
const describeKey = (key, env = process.env) => resolve({ ...env, GROCERY_QR_PROVIDER: key }).describe();

module.exports = { resolve, state, current, none, registry, registryEntry, describeKey };
