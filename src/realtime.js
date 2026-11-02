const db = require('./config/db');

// =====================================================
// REALTIME HELPERS
// Rooms (joined in bin/www after socket auth):
//   admins          - every signed-in admin
//   shop:{shopId}   - a shop's website
//   customers       - every customer app (catalog changes)
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

// Live operations map only (admins with owner / operations /
// support role join 'admins:live' in bin/www)
const emitToLiveOps = (io, event, payload = {}) => {
  try {
    if (io) {
      io.to('admins:live').emit(event, payload);
    }
  } catch (error) {
    console.error('❌ emitToLiveOps error:', error.message);
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
  // Shops only need to know that something changed (they refetch):
  // no delivery details or door photos in shop rooms (B-17)
  emitToOrderShops(io, orderId, 'shop:order-updated', {
    event: data.event || null,
    status: data.status || null,
  });
};

// A shop's catalog changed (products, prices, stock, offers, or
// the shop itself: open/closed, approved, name, logo). Customer
// apps refetch what they show for that shop - the event carries
// no prices, so the app always gets them from the same server
// pricing as checkout. kind: 'products' | 'offers' | 'shop'.
const broadcastCatalogChange = (io, shopId, kind = 'products') => {
  try {
    const id = Number(shopId);

    if (io && Number.isInteger(id) && id > 0) {
      const payload = { shopId: id, kind, at: Date.now() };

      io.to('customers').emit('catalog-updated', payload);
      emitToAdmins(io, 'admin:catalog-updated', payload);
    }
  } catch (error) {
    console.error('❌ broadcastCatalogChange error:', error.message);
  }
};

// Shopper sockets in order:{id} other than the order's current shopper
// leave the room (after a release / re-dispatch), so they stop getting
// its GPS, photos and payment events.
const pruneOrderRoom = async (io, orderId, keepShopperId = null) => {
  try {
    if (!io) return;
    const sockets = await io.in(`order:${Number(orderId)}`).fetchSockets();
    sockets.forEach((socket) => {
      if (socket.data?.userType !== 'shopper') return;
      if (keepShopperId != null && Number(socket.data.shopperId) === Number(keepShopperId)) return;
      socket.leave(`order:${Number(orderId)}`);
    });
  } catch (error) {
    console.error('❌ pruneOrderRoom error:', error.message);
  }
};

module.exports = {
  emitToAdmins,
  emitToLiveOps,
  emitToOrderShops,
  broadcastOrderChange,
  broadcastCatalogChange,
  pruneOrderRoom,
};
