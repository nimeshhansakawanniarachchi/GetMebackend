const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const {
  listNotifications,
  notificationSummary,
  markNotificationRead,
  markAllNotificationsRead,
  orderActivity,
} = require('../notifications/customerNotifications');

// =====================================================
// CUSTOMER NOTIFICATIONS + ORDER ACTIVITY (phase 57)
// Mounted at /api/customer; every query is limited to the
// signed-in customer (req.customer.customerId).
// =====================================================

const router = express.Router();

router.get('/notifications', authMiddleware, listNotifications);
router.get('/notifications/summary', authMiddleware, notificationSummary);
router.post('/notifications/read-all', authMiddleware, markAllNotificationsRead);
router.post('/notifications/:id/read', authMiddleware, markNotificationRead);
router.get('/orders/:orderId/activity', authMiddleware, orderActivity);

module.exports = router;
