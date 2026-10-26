const express = require('express');

const authMiddleware =
  require('../middleware/authMiddleware');

const shopperAuthMiddleware =
  require('../middleware/shopperAuthMiddleware');

const {
  getMessages,
  sendMessage,
} = require('../controllers/chatController');

const chatUnread = require('../controllers/chatUnreadController');

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


// ==================================================
// UNREAD COUNTS, READ STATUS, PUSH TOKENS
// (both apps; the token decides whose)
// ==================================================

const unreadRoutes = (prefix, auth) => {
  router.get(`/${prefix}/unread`, auth, chatUnread.getUnread);
  router.post(`/${prefix}/orders/:orderId/read`, auth, chatUnread.markRead);
  router.post(`/${prefix}/push-token`, auth, chatUnread.savePushToken);
  router.delete(`/${prefix}/push-token`, auth, chatUnread.deletePushToken);
};

unreadRoutes('customer', authMiddleware);
unreadRoutes('shopper', shopperAuthMiddleware);

module.exports = router;