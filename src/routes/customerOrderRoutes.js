
const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');

const upload = require('../middleware/uploadMiddleware');

const {
  createOrder,
  getQuote,
  getDeliverySlots,
} = require('../controllers/customerCreateOrderController');

const {
  getCustomerOrders,
  getCustomerOrderById,
  getNearbyShoppersForOrder,
  cancelCustomerOrder,
  updateReplacementStatus,
  uploadCustomItemMedia,
   startShopperSearch,
  stopShopperSearch,
} = require('../controllers/customerOrderController');

const router = express.Router();


// ==================================================
// PRICE A CART (server-side, nothing saved)
// ==================================================

router.post(
  '/orders/quote',
  authMiddleware,
  getQuote
);

router.get(
  '/delivery-slots',
  authMiddleware,
  getDeliverySlots
);


// ==================================================
// CREATE ORDER
// ==================================================

router.post(
  '/orders',
  authMiddleware,
  createOrder
);


// ==================================================
// UPLOAD CUSTOM ITEM MEDIA
// CUSTOMER PHOTO + VOICE NOTE
// ==================================================

router.post(
  '/orders/upload-media',
  authMiddleware,
  upload.array('files', 2),
  uploadCustomItemMedia
);


// ==================================================
// GET CUSTOMER ORDERS
// ==================================================

router.get(
  '/orders',
  authMiddleware,
  getCustomerOrders
);


// ==================================================
// GET SINGLE ORDER
// ==================================================

router.get(
  '/orders/:orderId',
  authMiddleware,
  getCustomerOrderById
);


// ==================================================
// GET NEARBY ONLINE SHOPPERS
// ==================================================

router.get(
  '/orders/:orderId/nearby-shoppers',
  authMiddleware,
  getNearbyShoppersForOrder
);


// ==================================================
// CANCEL ORDER
// ==================================================

router.patch(
  '/orders/:orderId/cancel',
  authMiddleware,
  cancelCustomerOrder
);


// ==================================================
// UPDATE REPLACEMENT STATUS
// OLD ROUTE
// ==================================================

router.patch(
  '/orders/:orderId/items/:itemId/replacements/:replacementId/status',
  authMiddleware,
  updateReplacementStatus
);


// ==================================================
// UPDATE REPLACEMENT DECISION
// CUSTOMER APP
// ==================================================

router.patch(
  '/orders/:orderId/replacements/:replacementId/decision',
  authMiddleware,
  updateReplacementStatus
);





router.patch(
  '/orders/:orderId/start-search',
  authMiddleware,
  startShopperSearch
);

router.patch(
  '/orders/:orderId/stop-search',
  authMiddleware,
  stopShopperSearch
);





module.exports = router;























