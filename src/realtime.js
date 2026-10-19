const db = require('./config/db');

// =====================================================
// REALTIME HELPERS
// Rooms (joined in bin/www after socket auth):
//   admins          - every signed-in admin
//   shop:{shopId}   - a shop's website
//   shopper:{id}, customer:{id}, order:{id} - mobile apps
// None of these throw: realtime must never break a request.
// =====================================================

const emitToAdmins = (io, event, payload = {}) => {
  try {
    if (io) {
      io.to('admins').emit(event, payload);
    }
  } catch (error) {
    console.error('❌ emitToAdmins error:', error.message);
  }
};

// Sends an event to every shop that has items in the order
const emitToOrderShops = async (io, orderId, event, payload = {}) => {
  try {
    if (!io || !orderId) {
      return;
    }

    const result = await db.query(
      'SELECT DISTINCT shop_id FROM order_shops WHERE order_id = $1',
      [Number(orderId)]
    );

    result.rows.forEach((row) => {
      io.to(`shop:${row.shop_id}`).emit(event, {
        ...payload,
        orderId: Number(orderId),
      });
    });
  } catch (error) {
    console.error('❌ emitToOrderShops error:', error.message);
  }
};

// One call for "something changed on this order": admins + shops
const broadcastOrderChange = (io, orderId, payload = {}) => {
  const data = { ...payload, orderId: Number(orderId) };

  emitToAdmins(io, 'admin:order-updated', data);
  emitToOrderShops(io, orderId, 'shop:order-updated', data);
};

module.exports = {
  emitToAdmins,
  emitToOrderShops,
  broadcastOrderChange,
};
