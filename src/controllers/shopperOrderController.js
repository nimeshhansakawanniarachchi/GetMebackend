
// =====================================================
// SHOPPER ORDER CONTROLLER
// COMPATIBILITY / EXPORTS
// =====================================================

// Available orders
const {
  getAvailableOrders,
} = require('./shopperAvailableOrdersController');

// My orders
const {
  getMyOrders,
} = require('./shopperMyOrdersController');

// Order details
const {
  getMyOrderById,
} = require('./shopperOrderDetailsController');

// Nearby shoppers
const {
  getNearbyShoppersForOrder,
} = require('./shopperNearbyController');

// Order status
const {
  acceptOrder,
  startShopping,
  startDelivery,
  confirmArrival,
  verifyDeliveryPin,
} = require('./shopperOrderStatusController');

// Item operations
const {
  uploadItemPhoto,
  uploadReplacementPhoto,
  updateItemShoppingStatus,
  verifyItemBarcode,
} = require('./shopperItemController');

// Payment and bills
const {
  updateOrderPayment,
  uploadBill,
} = require('./shopperPaymentController');

// =====================================================
// EXPORT ALL CONTROLLER FUNCTIONS
// =====================================================
module.exports = {
  getAvailableOrders,
  getMyOrders,
  getMyOrderById,
  getNearbyShoppersForOrder,

  acceptOrder,
  startShopping,
  startDelivery,
  confirmArrival,
  verifyDeliveryPin,

  uploadItemPhoto,
  uploadReplacementPhoto,
  updateItemShoppingStatus,
  verifyItemBarcode,

  updateOrderPayment,
  uploadBill,
};
