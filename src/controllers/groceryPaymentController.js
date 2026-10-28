const grocery = require('../groceryPayments/groceryPayments');
const admin = require('../groceryPayments/adminGroceryPayments');

// =====================================================
// SUPERMARKET PAYMENTS (phase 38) - HTTP layer
// Shopper (/api/shopper, own orders only):
//   GET  /orders/:orderId/grocery-payment?shopId=&platform=  methods, limit, attempts
//   POST /orders/:orderId/grocery-payment/attempts           { shopId, method, requestId, platform }
//   POST /grocery-payment-attempts/:id/result                { outcome: paid|failed|reversed, ... }
//   POST /grocery-payment-attempts/:id/cancel
// Admin: see src/groceryPayments/adminGroceryPayments.js
// =====================================================

const sendError = (res, error, fallback) => {
  if (!error?.status) console.error(`❌ ${fallback}:`, error?.message || error);

  // Checkout blocks (extra item requests) keep their original body
  if (error?.body) return res.status(error.status).json(error.body);

  return res.status(error?.status || 500).json({
    success: false,
    code: error?.code,
    field: error?.field,
    attemptId: error?.attemptId,
    blockingShopId: error?.blockingShopId,
    payment: error?.payment,
    message: error?.status ? error.message : fallback,
  });
};

const shopperIdOf = (req) => Number(req.shopper?.shopperId ?? req.shopper?.id);
const adminIdOf = (req) => Number(req.admin?.adminId);
const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const platformOf = (value) => (['ios', 'android'].includes(String(value)) ? String(value) : null);

// ---------------- Shopper ----------------

const getPaymentScreen = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const shopId = toId(req.query.shopId);
  if (!orderId || !shopId) return res.status(400).json({ success: false, message: 'Order and shop are required' });

  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...(await grocery.paymentScreen({ shopperId: shopperIdOf(req), orderId, shopId, platform: platformOf(req.query.platform) })) });
  } catch (error) {
    return sendError(res, error, 'Unable to load the payment options');
  }
};

const startAttempt = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const shopId = toId(req.body?.shopId);
  if (!orderId || !shopId) return res.status(400).json({ success: false, message: 'Order and shop are required' });

  try {
    const result = await grocery.startAttempt({
      shopperId: shopperIdOf(req),
      orderId,
      shopId,
      method: req.body?.method,
      requestId: req.body?.requestId,
      platform: platformOf(req.body?.platform),
    });
    return res.status(result.duplicate ? 200 : 201).json({
      success: true,
      message: result.attempt.funding === 'getme' ? 'Pay with your GetMe card at the till, then report the result.' : 'Pay at the till, then report the result.',
      attempt: result.attempt,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to start the payment');
  }
};

const reportResult = async (req, res) => {
  try {
    const result = await grocery.reportResult({
      shopperId: shopperIdOf(req),
      attemptId: toId(req.params.id),
      outcome: String(req.body?.outcome || ''),
      amountPaid: req.body?.amountPaid,
      reference: req.body?.reference,
      note: req.body?.note,
      reason: req.body?.reason,
      io: req.app.get('io'),
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to record the payment result');
  }
};

const cancelAttempt = async (req, res) => {
  try {
    return res.json({ success: true, ...(await grocery.cancelAttempt({ shopperId: shopperIdOf(req), attemptId: toId(req.params.id) })) });
  } catch (error) {
    return sendError(res, error, 'Unable to cancel the payment');
  }
};

// ---------------- Admin ----------------

const wrap = (fallback, fn, status = 200) => async (req, res) => {
  try {
    const result = await fn(req);
    return res.status(status).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, fallback);
  }
};

const adminHandlers = {
  listPayments: wrap('Unable to load supermarket payments', async (req) => admin.listPayments(req.query)),
  orderDetail: wrap('Unable to load the order payments', async (req) => admin.orderDetail(req.params.orderId)),
  paymentAction: wrap('Unable to update the payment', async (req) => admin.adminAction(req.params.id, req.body || {}, adminIdOf(req))),
  changeLimit: wrap('Unable to change the limit', async (req) => ({ reservation: await admin.changeLimit(req.params.id, req.body || {}, adminIdOf(req)) })),
  methodsConfig: wrap('Unable to load payment methods', async () => admin.methodsConfig()),
  updateMethod: wrap('Unable to update the payment method', async (req) => admin.updateMethod(req.params.key, req.body || {}, adminIdOf(req))),
  setShopException: wrap('Unable to update the shop', async (req) => admin.setShopException(req.params.key, req.params.shopId, req.body || {}, adminIdOf(req))),
  updateSettings: wrap('Unable to update the settings', async (req) => admin.updateSettings(req.body || {}, adminIdOf(req))),
  listCards: wrap('Unable to load GetMe cards', async () => ({ cards: await admin.listCards() })),
  createCard: wrap('Unable to register the card', async (req) => ({ card: await admin.createCard(req.body || {}, adminIdOf(req)) }), 201),
  updateCard: wrap('Unable to update the card', async (req) => ({ card: await admin.updateCard(req.params.id, req.body || {}) })),
  recordFunds: wrap('Unable to record the funds', async (req) => ({ card: await admin.recordFunds(req.params.id, req.body || {}, adminIdOf(req)) }), 201),
};

module.exports = { getPaymentScreen, startAttempt, reportResult, cancelAttempt, admin: adminHandlers };
