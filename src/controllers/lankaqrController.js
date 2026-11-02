const lankaqr = require('../groceryPayments/lankaqrPayments');
const providers = require('../groceryPayments/providers');

// =====================================================
// LANKAQR SCAN-TO-PAY (phase 49) - HTTP layer
// Shopper (/api/shopper, own orders only, rate limited per shopper):
//   POST /lankaqr/preview              { orderId, shopId, qrPayload, amount? }
//   POST /lankaqr/pay                  { orderId, shopId, qrPayload, amount, idempotencyKey }
//   GET  /lankaqr/attempts/:id         status poll / resume after restart
//   POST /lankaqr/merchant-submissions { orderId, shopId, qrPayload, note? }
// Admin (/api/admin):
//   GET   /lankaqr/status              grocery.view   provider card (no secrets)
//   GET   /lankaqr/merchants           grocery.view   store QRs per shop
//   POST  /lankaqr/merchants           grocery.manage add + approve a checked QR
//   PATCH /lankaqr/merchants/:id       grocery.manage approve | reject | disable
// Public (/api/payments):
//   POST /lankaqr/callback             always refused: no provider sends
//                                      verifiable callbacks yet
// No QR payload, bank data or provider secret is ever logged.
// =====================================================

const sendError = (res, error, fallback) => {
  if (!error?.status) console.error(`❌ ${fallback}:`, error?.message || error);
  return res.status(error?.status || 500).json({
    success: false,
    code: error?.code,
    field: error?.field,
    qrError: error?.qrError,
    attemptId: error?.attemptId,
    blockingShopId: error?.blockingShopId,
    canSubmit: error?.canSubmit,
    merchant: error?.merchant,
    provider: error?.provider,
    message: error?.status ? error.message : fallback,
  });
};

const shopperIdOf = (req) => Number(req.shopper?.shopperId ?? req.shopper?.id);
const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Small in-memory limiter per shopper + action (one backend process)
const LIMITS = { preview: [60, 60_000], pay: [40, 60_000], status: [240, 60_000], submit: [10, 600_000] };
const hits = new Map();
const limited = (action, shopperId) => {
  const [max, windowMs] = LIMITS[action];
  const key = `${action}:${shopperId}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((at) => now - at < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((at) => now - at < 600_000)) hits.delete(k);
  }
  return list.length > max;
};
const tooMany = (res) =>
  res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many tries. Wait a minute and try again.' });

// The simulator's test header (ignored unless the simulator is active)
const testOutcomeOf = (req) => {
  const state = providers.current();
  if (!state.usable || !state.simulator) return null;
  const value = String(req.get('x-getme-simulator-outcome') || '').trim();
  return value ? value.slice(0, 40) : null;
};

const base = (req) => ({
  shopperId: shopperIdOf(req),
  orderId: toId(req.body?.orderId),
  shopId: toId(req.body?.shopId),
});

const needsIds = (res, ids) => {
  if (!ids.orderId || !ids.shopId) {
    res.status(400).json({ success: false, code: 'INVALID', message: 'Order and shop are required' });
    return true;
  }
  return false;
};

// ---------------- Shopper ----------------

const preview = async (req, res) => {
  const ids = base(req);
  if (needsIds(res, ids)) return undefined;
  if (limited('preview', ids.shopperId)) return tooMany(res);
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      ...(await lankaqr.preview({ ...ids, qrPayload: req.body?.qrPayload, amount: req.body?.amount, billTotal: req.body?.billTotal, source: req.body?.source })),
    });
  } catch (error) {
    return sendError(res, error, 'Unable to check this QR code');
  }
};

const pay = async (req, res) => {
  const ids = base(req);
  if (needsIds(res, ids)) return undefined;
  if (limited('pay', ids.shopperId)) return tooMany(res);
  try {
    const result = await lankaqr.pay({
      ...ids,
      qrPayload: req.body?.qrPayload,
      amount: req.body?.amount,
      idempotencyKey: req.body?.idempotencyKey,
      // Phase 56: shopper's own bank account + bill total before scanning
      billTotal: req.body?.billTotal,
      source: req.body?.source,
      // Where the test simulator's approval page lives (the address the
      // phone used); a real bank sends its own page
      authBaseUrl: require('../payments/payhere').publicBaseUrl(req),
      testOutcome: testOutcomeOf(req),
      io: req.app.get('io'),
    });
    return res.status(result.duplicate ? 200 : 201).json({ success: true, duplicate: result.duplicate, attempt: result.attempt });
  } catch (error) {
    return sendError(res, error, 'Unable to make the payment');
  }
};

const status = async (req, res) => {
  const shopperId = shopperIdOf(req);
  const attemptId = toId(req.params.id);
  if (!attemptId) return res.status(400).json({ success: false, message: 'Invalid payment' });
  if (limited('status', shopperId)) return tooMany(res);
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...(await lankaqr.status({ shopperId, attemptId, testOutcome: testOutcomeOf(req), io: req.app.get('io') })) });
  } catch (error) {
    return sendError(res, error, 'Unable to load the payment');
  }
};

// POST /lankaqr/attempts/:id/cancel (phase 56)
const cancel = async (req, res) => {
  const shopperId = shopperIdOf(req);
  const attemptId = toId(req.params.id);
  if (!attemptId) return res.status(400).json({ success: false, message: 'Invalid payment' });
  if (limited('status', shopperId)) return tooMany(res);
  try {
    return res.json({ success: true, ...(await lankaqr.cancel({ shopperId, attemptId, io: req.app.get('io') })) });
  } catch (error) {
    return sendError(res, error, 'Unable to cancel the payment');
  }
};

// ---------------- Test simulator approval page (phase 56) ----------------
// Stands in for a bank's approval page while GROCERY_QR_PROVIDER=simulator
// outside production. It never asks for a PIN, OTP or card number.
const simulatorPageAllowed = () => {
  const state = providers.current();
  return state.usable && state.simulator && String(process.env.NODE_ENV || '').toLowerCase() !== 'production';
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const testAuthPage = (req, res) => {
  if (!simulatorPageAllowed()) return res.status(404).send('Not found');
  const simulator = require('../groceryPayments/providers/simulator');
  const session = simulator.testSession(req.params.token);
  res.set('Cache-Control', 'no-store');
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
  if (!session) return res.status(404).send('This test payment link is not valid any more.');
  const done = session.decision || session.expiresAt.getTime() < Date.now();
  const state = session.decision ? { approve: 'approved', decline: 'declined', cancel: 'cancelled' }[session.decision] : 'expired';
  const button = (decision, label, color) =>
    `<form method="post" action="${escapeHtml(req.params.token)}"><input type="hidden" name="decision" value="${decision}"><button style="background:${color}">${label}</button></form>`;
  return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test bank approval</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f5f5f4;color:#1c1917}main{max-width:420px;margin:0 auto;padding:20px}
.banner{background:#b45309;color:#fff;padding:12px;border-radius:10px;font-weight:700;text-align:center}.card{background:#fff;border-radius:12px;padding:16px;margin-top:14px}
.amount{font-size:30px;font-weight:800;margin:8px 0}button{width:100%;padding:14px;border:0;border-radius:10px;color:#fff;font-size:16px;font-weight:700;margin-top:10px}
.muted{color:#57534e;font-size:14px}</style></head><body><main>
<div class="banner">TEST SIMULATOR — no money moves</div>
<div class="card"><div class="muted">A real bank would ask for your PIN / OTP here. This test page never does.</div>
<div class="amount">Rs ${escapeHtml(session.amount.toFixed(2))}</div><div>${escapeHtml(session.merchant)}</div><div class="muted">${escapeHtml(session.reference || '')}</div></div>
${done ? `<div class="card"><b>This test payment was ${state}.</b><div class="muted">Go back to the GetMe app.</div></div>`
  : `<div class="card">${button('approve', 'Approve (test)', '#15803d')}${button('decline', 'Decline (test)', '#b91c1c')}${button('cancel', 'Cancel', '#57534e')}</div>`}
</main></body></html>`);
};

const testAuthDecide = (req, res) => {
  if (!simulatorPageAllowed()) return res.status(404).send('Not found');
  const simulator = require('../groceryPayments/providers/simulator');
  const session = simulator.decideTestSession(req.params.token, String(req.body?.decision || ''));
  if (!session) return res.status(404).send('This test payment link is not valid any more.');
  return res.redirect(303, req.params.token);
};

const submitMerchant = async (req, res) => {
  const ids = base(req);
  if (needsIds(res, ids)) return undefined;
  if (limited('submit', ids.shopperId)) return tooMany(res);
  try {
    const result = await lankaqr.submitMerchant({ ...ids, qrPayload: req.body?.qrPayload, note: req.body?.note });
    return res.status(result.created ? 201 : 200).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to send the QR code');
  }
};

// ---------------- Public callback ----------------

// No provider sends callbacks GetMe can verify (DFCC hasn't defined
// one; the simulator never accepts one): every callback is refused and
// nothing is changed.
// Phase 55: a provider callback is accepted only when the provider in
// use is live/usable and its signature verifies (bankAdapter.js); the
// reference must be ours (GETME-<order>-<attempt>) and match an attempt
// of that provider. The outcome goes through the same applyOutcome as a
// status check (idempotent; amount compared there).
const callback = async (req, res) => {
  const state = providers.current();
  if (!state.usable || state.simulator) {
    return res.status(401).json({ success: false, code: 'CALLBACK_REJECTED', message: 'Callback not accepted' });
  }
  const verdict = state.provider.verifyCallback(req);
  if (!verdict?.valid || !verdict.result) {
    console.error('❌ LANKAQR CALLBACK REJECTED:', state.key, verdict?.reason || 'invalid');
    return res.status(401).json({ success: false, code: 'CALLBACK_REJECTED', message: 'Callback not accepted' });
  }
  try {
    const [, orderId, attemptId] = verdict.result.reference.split('-');
    const attempt = (
      await require('../config/db').query(
        'SELECT id FROM grocery_payment_attempts WHERE id = $1 AND order_id = $2 AND provider = $3',
        [Number(attemptId), Number(orderId), state.key]
      )
    ).rows[0];
    if (!attempt) return res.status(404).json({ success: false, code: 'UNKNOWN_REFERENCE', message: 'Unknown reference' });
    await lankaqr.applyOutcome(attempt.id, verdict.result, { source: 'callback', io: req.app.get('io') });
    return res.json({ success: true });
  } catch (error) {
    console.error('❌ LANKAQR CALLBACK ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Callback could not be processed' });
  }
};

// ---------------- Admin ----------------

const wrap = (fallback, fn, okStatus = 200) => async (req, res) => {
  try {
    const result = await fn(req);
    if (result?.audit) {
      res.locals.audit = result.audit;
      delete result.audit;
    }
    return res.status(okStatus).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, fallback);
  }
};

const admin = {
  status: wrap('Unable to load the LankaQR status', async () => lankaqr.adminStatus()),
  listMerchants: wrap('Unable to load the store QRs', async (req) => lankaqr.listMerchants(req.query)),
  createMerchant: wrap(
    'Unable to add the store QR',
    async (req) => {
      try {
        return await lankaqr.createMerchant(req.body || {}, req.admin);
      } finally {
        // The audit log records that a store QR was added, not its raw text
        if (req.body && req.body.qrPayload) req.body.qrPayload = '[store QR text not logged]';
      }
    },
    201
  ),
  reviewMerchant: wrap('Unable to update the store QR', async (req) => lankaqr.reviewMerchant(req.params.id, req.body || {}, req.admin)),
};

module.exports = { preview, pay, status, cancel, submitMerchant, callback, testAuthPage, testAuthDecide, admin };
