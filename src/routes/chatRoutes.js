const express = require('express');

const authMiddleware =
  require('../middleware/authMiddleware');

const shopperAuthMiddleware =
  require('../middleware/shopperAuthMiddleware');

const {
  getMessages,
  sendMessage,
} = require('../controllers/chatController');

const router = express.Router();


// ==================================================
// CUSTOMER CHAT
// ==================================================

// GET CUSTOMER MESSAGES

router.get(
  '/customer/orders/:orderId/messages',
  authMiddleware,
  getMessages
);


// POST CUSTOMER MESSAGE

router.post(
  '/customer/orders/:orderId/messages',
  authMiddleware,
  sendMessage
);


// ==================================================
// SHOPPER CHAT
// ==================================================

// GET SHOPPER MESSAGES

router.get(
  '/shopper/orders/:orderId/messages',
  shopperAuthMiddleware,
  getMessages
);


// POST SHOPPER MESSAGE

router.post(
  '/shopper/orders/:orderId/messages',
  shopperAuthMiddleware,
  sendMessage
);


module.exports = router;