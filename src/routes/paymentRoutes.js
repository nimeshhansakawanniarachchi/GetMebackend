const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const shopperAuthMiddleware = require('../middleware/shopperAuthMiddleware');

const payment = require('../controllers/paymentController');

const router = express.Router();

// =====================================================
// PAYMENTS (/api/payments)
// Saved cards + card payments through PayHere
// (controllers/paymentController.js, payments/*).
// =====================================================

router.get('/health', (req, res) => {
  return res.status(200).json({
    success: true,
    message: 'GetMe payment routes are working',
  });
});

router.get('/config', payment.getConfig);

// LankaQR (GetMe pays, phase 49): no provider sends verifiable callbacks
// yet, so every callback is refused (401) and nothing changes
router.post('/lankaqr/callback', require('../controllers/lankaqrController').callback);
// Phase 56: TEST SIMULATOR stand-in for a bank's approval page (404
// unless GROCERY_QR_PROVIDER=simulator outside production)
router.get('/lankaqr/test-auth/:token', require('../controllers/lankaqrController').testAuthPage);
router.post('/lankaqr/test-auth/:token', require('../controllers/lankaqrController').testAuthDecide);

// Saved cards: same handlers for both apps; the token decides whose
const cardRoutes = (prefix, auth) => {
  router.get(`/${prefix}/cards`, auth, payment.listCards);
  router.post(`/${prefix}/cards/setup`, auth, payment.startCardSetup);
  router.get(`/${prefix}/cards/setup/:ref`, auth, payment.getCardSetupStatus);
  router.patch(`/${prefix}/cards/:cardId/default`, auth, payment.makeDefaultCard);
  router.delete(`/${prefix}/cards/:cardId`, auth, payment.deleteCard);
};

cardRoutes('customer', authMiddleware);
cardRoutes('shopper', shopperAuthMiddleware);

// Customer: payment status + transactions of an order
router.get('/customer/orders/:orderId', authMiddleware, payment.getCustomerOrderPayment);

// Phase 55: customer says they paid GetMe's LankaQR (HelaPOS) for an
// order. Off unless CUSTOMER_LANKAQR_ENABLED=true; a claim is only a
// claim - finance verifies it against the HelaPOS app (two admins).
const receivedQr = require('../payments/receivedQrPayments');
const qrSend = (handler, okStatus = 200) => async (req, res) => {
  try {
    return res.status(okStatus).json({ success: true, ...(await handler(req)) });
  } catch (caught) {
    if (!caught.status) console.error('❌ customer LankaQR error:', caught.message);
    return res.status(caught.status || 500).json({ success: false, code: caught.code, field: caught.field, message: caught.status ? caught.message : 'Unable to complete the request' });
  }
};
router.get('/customer/orders/:orderId/lankaqr', authMiddleware, qrSend((req) => receivedQr.customerList({ customerId: Number(req.customer.customerId), orderId: req.params.orderId })));
router.post('/customer/orders/:orderId/lankaqr', authMiddleware, qrSend((req) => receivedQr.customerClaim({ customerId: Number(req.customer.customerId), orderId: req.params.orderId, body: req.body }), 201));

// Shopper: a store bill paid by card (read only)
router.get('/shopper/orders/:orderId/store-bill', shopperAuthMiddleware, payment.getStoreBillPayment);
// Retired (payment audit P-05, 2026-10-31): it charged the shopper's own
// card into GetMe's PayHere account - the supermarket was not paid and
// nothing reimbursed it. Supermarket payments use the grocery payment
// flow (record-and-verify / company card / provider).
router.post('/shopper/orders/:orderId/store-bill', shopperAuthMiddleware, (req, res) =>
  res.status(410).json({ success: false, code: 'GONE', message: 'Pay the supermarket from the payment screen in the order.' })
);

// Pages the apps' web view opens (the setup ref is the key)
router.get('/cards/checkout/:ref', payment.cardCheckoutPage);
router.get('/cards/return', payment.cardReturnPage);
router.get('/cards/cancel', payment.cardCancelPage);

// PayHere server callback (md5sig verified)
router.post('/payhere/notify', payment.payhereNotify);

// Test mode only: stand-in for PayHere's card page
router.post('/test-gateway/preapprove', payment.testGatewayPage);

module.exports = router;
