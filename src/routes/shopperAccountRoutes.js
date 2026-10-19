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
} = require('../controllers/shopperProfileController');

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

module.exports = router;
