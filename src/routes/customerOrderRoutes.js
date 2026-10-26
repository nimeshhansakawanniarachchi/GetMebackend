
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
  getNearbyVehiclesForOrder,
  cancelCustomerOrder,
  getCancelPreview,
  getCancelPolicy,
  updateReplacementStatus,
  uploadCustomItemMedia,
   startShopperSearch,
  stopShopperSearch,
} = require('../controllers/customerOrderController');

const {
  rateOrder,
  getMyRatings,
} = require('../controllers/customerRatingController');

const {
  updateDeliveryInstructions,
  addItemsToOrder,
  rescheduleOrder,
} = require('../controllers/customerOrderChangesController');

const {
  customerListRequests,
  customerRequestItems,
  customerApproveItem,
  customerDeclineItem,
  customerCancelRequest,
} = require('../controllers/orderItemRequestsController');

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


// Cancellation rules + reasons (before /orders/:orderId)
router.get('/orders/cancel-policy', authMiddleware, getCancelPolicy);

// What cancelling this order would mean (allowed? refund / owed)
router.get('/orders/:orderId/cancel-preview', authMiddleware, getCancelPreview);

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
// NEARBY VEHICLES (approximate, for the map)
// ==================================================

router.get(
  '/orders/:orderId/nearby-vehicles',
  authMiddleware,
  getNearbyVehiclesForOrder
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


// ==================================================
// RATINGS (delivered orders)
// ==================================================

router.post(
  '/orders/:orderId/rating',
  authMiddleware,
  rateOrder
);

// ==================================================
// ORDER CHANGES (Instacart order page)
// ==================================================

router.patch(
  '/orders/:orderId/delivery-instructions',
  authMiddleware,
  updateDeliveryInstructions
);

// Until shopping begins: confirm false = price only
router.post(
  '/orders/:orderId/add-items',
  authMiddleware,
  addItemsToOrder
);

router.post(
  '/orders/:orderId/reschedule',
  authMiddleware,
  rescheduleOrder
);

// While shopping: extra items go to the shopper as requests;
// items the shopper adds wait for the customer's approval
router.get('/orders/:orderId/item-requests', authMiddleware, customerListRequests);
router.post('/orders/:orderId/item-requests', authMiddleware, customerRequestItems);
router.post('/orders/:orderId/item-requests/:requestId/approve', authMiddleware, customerApproveItem);
router.post('/orders/:orderId/item-requests/:requestId/decline', authMiddleware, customerDeclineItem);
router.post('/orders/:orderId/item-requests/:requestId/cancel', authMiddleware, customerCancelRequest);

router.get(
  '/order-ratings',
  authMiddleware,
  getMyRatings
);





module.exports = router;























