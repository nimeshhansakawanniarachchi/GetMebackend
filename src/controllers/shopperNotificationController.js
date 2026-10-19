const db = require('../config/db');

// =====================================================
// GET SHOPPER ID
// =====================================================

const getShopperId = (req) =>
  req.shopper?.shopperId ||
  req.shopper?.id ||
  null;

const toNotification = (row) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  body: row.body,
  orderId: row.order_id,
  read: Boolean(row.read_at),
  readAt: row.read_at,
  createdAt: row.created_at,
});

// =====================================================
// CREATE NOTIFICATION
// Saves it and pushes it live to the shopper's socket room.
// Never throws - a failed notification must not break the order flow.
// =====================================================

const createShopperNotification = async ({
  io,
  shopperId,
  type,
  title,
  body = null,
  orderId = null,
}) => {
  try {
    const normalizedShopperId = Number(shopperId);

    if (!normalizedShopperId) {
      return null;
    }

    const result = await db.query(
      `
      INSERT INTO shopper_notifications
        (shopper_id, type, title, body, order_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        normalizedShopperId,
        type,
        title,
        body,
        orderId ? Number(orderId) : null,
      ]
    );

    const notification = toNotification(result.rows[0]);

    if (io) {
      io.to(`shopper:${normalizedShopperId}`).emit(
        'shopper-notification',
        notification
      );
    }

    return notification;
  } catch (error) {
    console.error('❌ createShopperNotification error:', error.message);

    return null;
  }
};

// =====================================================
// GET NOTIFICATIONS
// GET /api/shopper/notifications
// =====================================================

const getNotifications = async (req, res) => {
  try {
    const shopperId = getShopperId(req);

    const [listResult, unreadResult] = await Promise.all([
      db.query(
        `
        SELECT *
        FROM shopper_notifications
        WHERE shopper_id = $1
        ORDER BY created_at DESC
        LIMIT 50
        `,
        [shopperId]
      ),
      db.query(
        `
        SELECT COUNT(*)::int AS count
        FROM shopper_notifications
        WHERE shopper_id = $1 AND read_at IS NULL
        `,
        [shopperId]
      ),
    ]);

    return res.json({
      success: true,
      unreadCount: unreadResult.rows[0].count,
      notifications: listResult.rows.map(toNotification),
    });
  } catch (error) {
    console.error('❌ getNotifications error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to load notifications',
    });
  }
};

// =====================================================
// MARK ALL READ
// POST /api/shopper/notifications/read-all
// =====================================================

const markAllNotificationsRead = async (req, res) => {
  try {
    const shopperId = getShopperId(req);

    await db.query(
      `
      UPDATE shopper_notifications
      SET read_at = NOW()
      WHERE shopper_id = $1 AND read_at IS NULL
      `,
      [shopperId]
    );

    return res.json({ success: true, unreadCount: 0 });
  } catch (error) {
    console.error('❌ markAllNotificationsRead error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to update notifications',
    });
  }
};

// =====================================================
// MARK ONE READ
// POST /api/shopper/notifications/:notificationId/read
// =====================================================

const markNotificationRead = async (req, res) => {
  try {
    const shopperId = getShopperId(req);
    const notificationId = Number(req.params.notificationId);

    if (!Number.isInteger(notificationId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid notification ID',
      });
    }

    const result = await db.query(
      `
      UPDATE shopper_notifications
      SET read_at = COALESCE(read_at, NOW())
      WHERE id = $1 AND shopper_id = $2
      `,
      [notificationId, shopperId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found',
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ markNotificationRead error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to update notification',
    });
  }
};

module.exports = {
  createShopperNotification,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
};
