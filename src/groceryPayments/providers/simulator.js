// =====================================================
// LANKAQR TEST SIMULATOR (phase 49, phase 56) - TESTS ONLY
//
// NO MONEY MOVES. Enabled only when NODE_ENV !== 'production' AND
// GROCERY_QR_PROVIDER=simulator, and never together with
// GROCERY_QR_LIVE=true (providers/index.js). Every simulated attempt is
// stored with provider + verification 'simulator' and is never counted
// as bank-verified.
//
// Deterministic outcomes from the amount's cents (or the test header
// X-GetMe-Simulator-Outcome, honoured only by this simulator):
//   .00 (and anything not listed)  succeed            -> succeeded
//   .01  fail                       -> failed
//   .02  reject                     -> rejected
//   .03  pending_then_succeed       -> pending; status query: succeeded
//   .04  timeout_then_succeed       -> unknown (timeout); query: succeeded
//   .05  unknown_then_fail          -> unknown; query: failed
//
// Phase 56 - payer-funded payments (fundingSource 'payer', the shopper's
// own account): the simulator answers 'action_required' with a LOCAL
// TEST page (/api/payments/lankaqr/test-auth/<token>) standing in for
// the bank's approval page. "Approve" there gives the scenario above;
// "Decline" -> failed; "Cancel" -> cancelled; nothing within 5 minutes
// -> expired. The sessions live in this process only (a restart loses
// them: the payment then expires). A real bank's page asks for the
// shopper's PIN / OTP; this page never asks for anything secret.
// =====================================================

const crypto = require('crypto');

const SCENARIOS = {
  '00': 'succeed',
  '01': 'fail',
  '02': 'reject',
  '03': 'pending_then_succeed',
  '04': 'timeout_then_succeed',
  '05': 'unknown_then_fail',
};
const NAMED = new Set(Object.values(SCENARIOS));

const NOTICE = 'TEST SIMULATOR — no money moves';
const AUTH_MINUTES = 5;

const scenarioOf = (amount, override) => {
  if (override && NAMED.has(override)) return override;
  const cents = Math.round(Number(amount) * 100) % 100;
  return SCENARIOS[String(cents).padStart(2, '0')] || 'succeed';
};

const refFor = (attemptId) => `SIM-${attemptId}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

// Payer approval sessions: token -> { key, amount, merchant, reference,
// expiresAt, decision: null | 'approve' | 'decline' | 'cancel', providerRef }
const sessions = new Map();
const byKey = new Map();
const sessionFor = (key) => sessions.get(byKey.get(String(key)));

const startSession = ({ key, amount, merchant, reference, authBaseUrl, testOutcome }) => {
  const existing = sessionFor(key);
  if (existing) return existing;
  const token = crypto.randomBytes(18).toString('base64url');
  const session = {
    token,
    key: String(key),
    amount: Number(amount),
    merchant: merchant ? `${merchant.name}, ${merchant.city}` : 'Merchant',
    reference,
    expiresAt: new Date(Date.now() + AUTH_MINUTES * 60 * 1000),
    decision: null,
    testOutcome,
    providerRef: refFor(key),
    authUrl: `${String(authBaseUrl || '').replace(/\/+$/, '')}/api/payments/lankaqr/test-auth/${token}`,
  };
  sessions.set(token, session);
  byKey.set(session.key, token);
  return session;
};

// Outcome of a payer session as the "bank" reports it
const sessionResult = (session) => {
  if (session.decision === 'cancel') return { status: 'cancelled', providerRef: session.providerRef, message: `${NOTICE}: cancelled by the payer` };
  if (session.decision === 'decline') return { status: 'failed', providerRef: session.providerRef, message: `${NOTICE}: the payer declined at the bank` };
  if (session.decision === 'approve') {
    const scenario = scenarioOf(session.amount, session.testOutcome);
    if (['fail', 'unknown_then_fail'].includes(scenario)) return { status: 'failed', providerRef: session.providerRef, message: `${NOTICE}: simulated decline after approval` };
    if (scenario === 'reject') return { status: 'rejected', providerRef: session.providerRef, message: `${NOTICE}: simulated rejection` };
    return { status: 'succeeded', providerRef: session.providerRef, amount: session.amount, message: `${NOTICE}: approved by the payer (simulated)` };
  }
  if (session.expiresAt.getTime() < Date.now()) return { status: 'expired', providerRef: session.providerRef, message: `${NOTICE}: not approved in time` };
  return {
    status: 'action_required',
    providerRef: session.providerRef,
    authUrl: session.authUrl,
    expiresAt: session.expiresAt.toISOString(),
    message: `${NOTICE}: waiting for the payer to approve`,
  };
};

const create = ({ disabledReason = null } = {}) => {
  const configured = !disabledReason;

  const guard = () => {
    if (!configured) {
      throw Object.assign(new Error(`The LANKAQR test simulator is off: ${disabledReason}`), { status: 503, code: 'PROVIDER_NOT_CONFIGURED' });
    }
  };

  return {
    key: 'simulator',
    label: NOTICE,
    describe: () => ({
      key: 'simulator',
      label: NOTICE,
      configured,
      live: false,
      simulator: true,
      // Everything, simulated (phase 56)
      capabilities: {
        lankaqrMerchantPayment: configured,
        companyFunded: configured,
        payerFunded: configured,
        payerAuth: configured,
        statusQuery: configured,
        signedCallbacks: false,
        cancel: configured,
        reversal: configured,
      },
      reason: configured ? 'Test simulator for automated tests. No money moves; nothing is bank-verified.' : disabledReason,
    }),

    initiate: async ({ attemptId, amount, testOutcome, fundingSource, merchant, reference, authBaseUrl }) => {
      guard();
      if (fundingSource === 'payer') {
        return sessionResult(startSession({ key: attemptId, amount, merchant, reference, authBaseUrl, testOutcome }));
      }
      const scenario = scenarioOf(amount, testOutcome);
      const providerRef = refFor(attemptId);
      switch (scenario) {
        case 'fail':
          return { status: 'failed', providerRef, message: `${NOTICE}: simulated decline` };
        case 'reject':
          return { status: 'rejected', providerRef, message: `${NOTICE}: simulated rejection (merchant not payable)` };
        case 'pending_then_succeed':
          return { status: 'pending', providerRef, message: `${NOTICE}: simulated pending` };
        case 'timeout_then_succeed':
          // Like a lost reply: no reference came back
          return { status: 'unknown', message: `${NOTICE}: simulated timeout` };
        case 'unknown_then_fail':
          return { status: 'unknown', providerRef, message: `${NOTICE}: simulated unknown outcome` };
        default:
          return { status: 'succeeded', providerRef, amount: Number(amount), message: `${NOTICE}: simulated success` };
      }
    },

    queryStatus: async ({ attemptId, providerRef, amount, testOutcome }) => {
      guard();
      const session = sessionFor(attemptId);
      if (session) return sessionResult(session);
      const scenario = scenarioOf(amount, testOutcome);
      const ref = providerRef || refFor(attemptId);
      if (['fail', 'unknown_then_fail'].includes(scenario)) return { status: 'failed', providerRef: ref, message: `${NOTICE}: simulated failure on status check` };
      if (scenario === 'reject') return { status: 'rejected', providerRef: ref, message: `${NOTICE}: simulated rejection` };
      return { status: 'succeeded', providerRef: ref, amount: Number(amount), message: `${NOTICE}: simulated success on status check` };
    },

    // Stops a payer payment that was not approved yet
    cancel: async ({ attemptId }) => {
      guard();
      const session = sessionFor(attemptId);
      if (!session) return { status: 'unknown', message: `${NOTICE}: no such payment` };
      if (!session.decision) session.decision = 'cancel';
      return sessionResult(session);
    },

    reverse: async ({ attemptId, providerRef, amount }) => {
      guard();
      return { status: 'reversed', providerRef: providerRef || refFor(attemptId), amount: Number(amount), message: `${NOTICE}: simulated reversal` };
    },

    // The simulator never accepts a callback: any callback is forged
    verifyCallback: () => ({ valid: false, reason: 'The test simulator does not accept callbacks' }),
  };
};

// Test approval page support (paymentRoutes, never in production)
const testSession = (token) => sessions.get(String(token)) || null;
const decideTestSession = (token, decision) => {
  const session = testSession(token);
  if (!session || !['approve', 'decline', 'cancel'].includes(decision)) return null;
  if (!session.decision && session.expiresAt.getTime() >= Date.now()) session.decision = decision;
  return session;
};

module.exports = { create, scenarioOf, NOTICE, SCENARIOS, testSession, decideTestSession };
