const express = require('express');

const shopperAuthMiddleware = require('../middleware/shopperAuthMiddleware');

const {
  dismissOrderOffer,
} = require('../controllers/shopperAvailableOrdersController');

const {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} = require('../controllers/shopperNotificationController');

const {
  getEarnings,
} = require('../controllers/shopperEarningsController');

const {
  getProfile,
  updateProfile,
  receivePhoto,
  uploadProfilePhoto,
  removeProfilePhoto,
} = require('../controllers/shopperProfileController');

const {
  getNearbyShops,
} = require('../controllers/shopperNearbyShopsController');

const {
  getLastFound,
} = require('../controllers/shopperItemHistoryController');

const {
  getProductDetails,
  getProductByBarcode,
} = require('../controllers/shopperProductController');

const router = express.Router();

// Every route here needs a shopper token that carries shopperId
const requireShopper = (req, res, next) =>
  shopperAuthMiddleware(req, res, () => {
    if (!req.shopper?.shopperId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid shopper token',
      });
    }

    next();
  });


// =====================================================
// BATCH COUNTDOWN
// =====================================================

router.post('/orders/:orderId/dismiss', requireShopper, dismissOrderOffer);


// =====================================================
// NOTIFICATIONS
// =====================================================

router.get('/notifications', requireShopper, getNotifications);

router.post('/notifications/read-all', requireShopper, markAllNotificationsRead);

router.post('/notifications/:notificationId/read', requireShopper, markNotificationRead);


// =====================================================
// EARNINGS
// =====================================================

router.get('/earnings', requireShopper, getEarnings);


// =====================================================
// PROFILE
// =====================================================

router.get('/me', requireShopper, getProfile);

router.put('/me', requireShopper, updateProfile);

// Face customers see on the map pin + shopper card
router.post('/me/photo', requireShopper, receivePhoto, uploadProfilePhoto);

router.delete('/me/photo', requireShopper, removeProfilePhoto);


// =====================================================
// NEARBY SHOPS (Home map)
// =====================================================

router.get('/nearby-shops', requireShopper, getNearbyShops);


// =====================================================
// ITEM LAST FOUND ("Item might still be here")
// =====================================================

router.get('/products/:productId/last-found', requireShopper, getLastFound);


// =====================================================
// PRODUCT LOOKUPS (replacement scan flow)
// =====================================================

router.get('/products/:productId', requireShopper, getProductDetails);

router.get(
  '/shops/:shopId/products/by-barcode/:barcode',
  requireShopper,
  getProductByBarcode
);

module.exports = router;
