const db = require('../config/db');

const {
  OFFER_RADIUS_KM,
  shopperPayForOrder,
  distanceKm,
} = require('./shopperPay');

const {
  createShopperNotification,
} = require('./shopperNotificationController');

const {
  emitToAdmins,
  emitToOrderShops,
} = require('../realtime');

// =====================================================
// NEW BATCH -> ALERT NEARBY ONLINE SHOPPERS
// Called when a customer starts the shopper search.
// Pushes 'new-order' to each shopper's socket room (the app refreshes
// its batch list and plays the alarm) and saves a notification.
// Never throws.
// =====================================================

const notifyNearbyShoppersOfNewBatch = async ({ io, order }) => {
  try {
    const orderId = Number(order?.id);

    if (!orderId) {
      return;
    }

    // A new search means a fresh countdown for every shopper
    await db.query(
      'DELETE FROM shopper_order_offers WHERE order_id = $1',
      [orderId]
    );

    const [shopsResult, shoppersResult] = await Promise.all([
      db.query(
        `
        SELECT s.shop_name, s.latitude, s.longitude
        FROM order_shops os
        INNER JOIN shops s ON s.id = os.shop_id
        WHERE os.order_id = $1
          AND s.latitude IS NOT NULL
          AND s.longitude IS NOT NULL
        `,
        [orderId]
      ),
      db.query(
        `
        SELECT id, latitude, longitude
        FROM shoppers
        WHERE status = 'online'
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
        `
      ),
    ]);

    const shops = shopsResult.rows;

    if (shops.length === 0) {
      return;
    }

    // Same rule as the batch list: every shop within the offer radius
    const nearbyShoppers = shoppersResult.rows.filter((shopper) =>
      shops.every(
        (shop) =>
          distanceKm(
            Number(shopper.latitude),
            Number(shopper.longitude),
            Number(shop.latitude),
            Number(shop.longitude)
          ) <= OFFER_RADIUS_KM
      )
    );

    const shopNames = shops.map((shop) => shop.shop_name).join(' + ');
    const pay = shopperPayForOrder(order).toFixed(2);

    for (const shopper of nearbyShoppers) {
      if (io) {
        io.to(`shopper:${shopper.id}`).emit('new-order', {
          orderId,
          order_id: orderId,
        });
      }

      await createShopperNotification({
        io,
        shopperId: shopper.id,
        type: 'new_batch',
        title: 'New batch available',
        body: `${shopNames} · Earn LKR ${pay}. Accept it before it's gone.`,
        orderId,
      });
    }

    console.log(
      `🔔 NEW BATCH #${orderId} sent to ${nearbyShoppers.length} nearby shopper(s)`
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
