
const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');

const upload = require('../middleware/uploadMiddleware');

const {
  createOrder,
  getCustomerOrders,
  getCustomerOrderById,
  getNearbyShoppersForOrder,
  cancelCustomerOrder,
  updateReplacementStatus,
  uploadCustomItemMedia,
} = require('../controllers/customerOrderController');

const router = express.Router();


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


module.exports = router;























