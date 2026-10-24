const db = require('../config/db');

const { broadcastOrderChange } = require('../realtime');

// =====================================================
// DELIVERY PHOTO (Instacart "Order complete")
// POST /api/shopper/orders/:orderId/delivery-photo
//   photo -> image file
// The shopper's photo of the order at the door. The customer sees
// it at the top of the finished order. Allowed from arrival until
// a day after delivery (the PIN check marks the order delivered
// first, so the photo usually comes just after).
// =====================================================

const PHOTO_STATUSES = ['out_for_delivery', 'arrived', 'delivered'];

const PHOTO_WINDOW_HOURS = 24;

const getShopperId = (req) =>
  req.shopper?.shopperId ||
  req.shopper?.id ||
  req.shopperId ||
  req.user?.shopperId ||
  req.user?.id ||
  null;

// "D:/.../src/uploads/deliveries/x.jpg" -> "/uploads/deliveries/x.jpg"
const toUploadUrl = (file) => {
  const uploadedPath = file?.path ? file.path.replace(/\\/g, '/') : '';
  const uploadsIndex = uploadedPath.indexOf('uploads/');

  return uploadsIndex !== -1 ? `/${uploadedPath.substring(uploadsIndex)}` : null;
};

const uploadDeliveryPhoto = async (req, res) => {
  const shopperId = Number(getShopperId(req));
  const orderId = Number(req.params.orderId);

  if (!Number.isInteger(shopperId)) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid order ID',
    });
  }

  const photoUrl = toUploadUrl(req.file);

  if (!photoUrl) {
    return res.status(400).json({
      success: false,
      message: 'Please take a photo of the delivery',
    });
  }

  try {
    const orderResult = await db.query(
      `
      SELECT id, customer_id, shopper_id, status, delivered_at
      FROM orders
      WHERE id = $1
      LIMIT 1
      `,
      [orderId]
    );

    const order = orderResult.rows[0];

    if (!order || Number(order.shopper_id) !== shopperId) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    const tooLate =
      order.status === 'delivered' &&
      order.delivered_at &&
      Date.now() - new Date(order.delivered_at).getTime() >
        PHOTO_WINDOW_HOURS * 60 * 60 * 1000;

    if (!PHOTO_STATUSES.includes(order.status) || tooLate) {
      return res.status(400).json({
        success: false,
        message: 'A delivery photo can only be added while delivering this order',
      });
    }

    const result = await db.query(
      `
      UPDATE orders
      SET
        delivery_photo_url = $1,
        delivery_photo_at = NOW(),
        updated_at = NOW()
      WHERE id = $2
      RETURNING delivery_photo_url, delivery_photo_at
      `,
      [photoUrl, orderId]
    );

    const saved = result.rows[0];

    const payload = {
      orderId,
      deliveryPhotoUrl: saved.delivery_photo_url,
      delivery_photo_url: saved.delivery_photo_url,
      deliveryPhotoAt: saved.delivery_photo_at,
      delivery_photo_at: saved.delivery_photo_at,
    };

    // Customer app (and admin / shop websites)
    try {
      const io = req.app.get('io');

      if (io) {
        io.to(`customer:${order.customer_id}`).emit('order-delivery-photo', payload);
        io.to(`order:${orderId}`).emit('order-delivery-photo', payload);
        broadcastOrderChange(io, orderId, { event: 'order-delivery-photo', ...payload });
      }
    } catch (error) {
      console.error('❌ DELIVERY PHOTO EMIT ERROR:', error.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Delivery photo saved',
      ...payload,
    });
  } catch (error) {
    console.error('❌ DELIVERY PHOTO ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Could not save the delivery photo',
    });
  }
};

module.exports = {
  uploadDeliveryPhoto,
};
