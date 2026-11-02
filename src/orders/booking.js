// =====================================================
// BOOK AN ORDER (phase 65: shared by start-search and the
// one-checkout parent order)
// bookOrderRow: inside the caller's transaction, moves a placed order
//   (pending_shopper_search) to its first live status and prices it for
//   the booked vehicle - the same status rules start-search always used:
//     pickup        -> awaiting_pickup (no rider)
//     shop_delivery -> shop_shipping (the store delivers)
//     delivery      -> waiting_for_shopper (rider / shopper search)
//   -> the updated order row, or null when it can't be booked (already
//      booked, cancelled, or a shopper already has it)
// announceBooking: after COMMIT - tells the customer's app, the order
//   room and the right people: shoppers nearby for groceries; the store
//   for clothing / restaurant orders (the rider search starts when the
//   store accepts).
// =====================================================

const { applyVehiclePrice } = require('../pricing/vehicles');
const { broadcastOrderChange } = require('../realtime');

const bookOrderRow = async (client, { orderId, customerId, preferredVehicle = null }) => {
  let result = await client.query(
    `
    UPDATE orders
    SET
      -- Phase 59: a customer-pickup merchant order needs no rider
      -- Phase 60: the store delivers it itself (no rider search)
      status = CASE WHEN fulfilment_method = 'pickup' THEN 'awaiting_pickup'
                    WHEN fulfilment_method = 'shop_delivery' THEN 'shop_shipping'
                    ELSE 'waiting_for_shopper' END,
      preferred_vehicle_type = CASE WHEN fulfilment_method IN ('pickup', 'shop_delivery') THEN NULL ELSE $3 END,
      shopper_search_started_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE
      id = $1
      AND customer_id = $2
      -- shopper_search_cancelled: stopped before customers could
      -- book again; those orders can be booked again too
      AND status IN ('pending_shopper_search', 'shopper_search_cancelled')
      AND shopper_id IS NULL
    RETURNING *
    `,
    [orderId, customerId, preferredVehicle]
  );

  if (result.rows.length > 0 && preferredVehicle && result.rows[0].fulfilment_method === 'delivery') {
    result = { rows: [await applyVehiclePrice(client, result.rows[0], preferredVehicle)] };
  }

  return result.rows[0] || null;
};

const announceBooking = ({ io, order }) => {
  if (!order) return;
  const orderId = Number(order.id);
  const customerId = Number(order.customer_id);
  const payload = {
    orderId,
    order_id: orderId,
    customerId,
    customer_id: customerId,
    status: order.status,
    order: { ...order, id: orderId, orderId, status: order.status },
  };

  try {
    io?.to(`customer:${customerId}`).emit('order-status-changed', payload);
    io?.to(`order:${orderId}`).emit('order-status-changed', payload);
  } catch (error) {
    console.error('❌ announceBooking socket:', error.message);
  }
  broadcastOrderChange(io, orderId, { event: 'order-status-changed', status: order.status });

  if (order.business_type && order.business_type !== 'grocery') {
    require('../marketplace/merchantOrders').onMerchantOrderConfirmed({ io, order });
  } else {
    // Not awaited - alerting shoppers must not slow the customer down
    require('../controllers/shopperBatchAlerts').notifyNearbyShoppersOfNewBatch({ io, order });
  }
};

module.exports = { bookOrderRow, announceBooking };
