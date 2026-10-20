const db = require('../config/db');

const { dispatchOrder } = require('./shopperDispatch');

const {
  emitToAdmins,
  emitToOrderShops,
} = require('../realtime');

// =====================================================
// NEW BATCH -> OFFER IT TO THE CLOSEST SHOPPER
// Called when a customer starts the shopper search.
// Clears earlier offers, then dispatchOrder() offers the batch to
// the shopper closest to the shop (and alerts them); the next
// closest is added every 5 s until someone accepts.
// See shopperDispatch.js.
// Never throws.
// =====================================================

const notifyNearbyShoppersOfNewBatch = async ({ io, order }) => {
  try {
    const orderId = Number(order?.id);

    if (!orderId) {
      return;
    }

    // A new search means every shopper gets a fresh turn
    await db.query(
      'DELETE FROM shopper_order_offers WHERE order_id = $1',
      [orderId]
    );

    const offer = await dispatchOrder({ io, orderId });

    console.log(
      offer?.shopperIds?.length
        ? `🔔 NEW BATCH #${orderId} offered to closest shopper #${offer.shopperIds[0]}`
        : `🔔 NEW BATCH #${orderId}: no shopper in range yet`
    );

    // Shop websites get "new order" for their store; admins refresh
    emitToOrderShops(io, orderId, 'shop:new-order', {});
    emitToAdmins(io, 'admin:order-updated', { orderId, event: 'new-order' });
  } catch (error) {
    console.error('❌ notifyNearbyShoppersOfNewBatch error:', error.message);
  }
};

module.exports = {
  notifyNearbyShoppersOfNewBatch,
};
