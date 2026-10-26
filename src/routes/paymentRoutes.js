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

// Shopper: pay a store's bill at checkout
router.get('/shopper/orders/:orderId/store-bill', shopperAuthMiddleware, payment.getStoreBillPayment);
router.post('/shopper/orders/:orderId/store-bill', shopperAuthMiddleware, payment.payStoreBill);

// Pages the apps' web view opens (the setup ref is the key)
router.get('/cards/checkout/:ref', payment.cardCheckoutPage);
router.get('/cards/return', payment.cardReturnPage);
router.get('/cards/cancel', payment.cardCancelPage);

// PayHere server callback (md5sig verified)
router.post('/payhere/notify', payment.payhereNotify);

// Test mode only: stand-in for PayHere's card page
router.post('/test-gateway/preapprove', payment.testGatewayPage);

module.exports = router;
