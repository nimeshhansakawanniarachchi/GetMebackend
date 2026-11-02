// =====================================================
// PHASE 59: MERCHANT ORDERS (clothing shops + restaurants)
// The store's side of an order (accept / reject / preparing / ready /
// customer collected), the customer's view (list, detail, timeline,
// PINs) and the shopper's pickup step. Delivery itself reuses the
// existing shopper flow (confirm-arrival, delivery PIN, earnings).
// =====================================================

const crypto = require('crypto');
const {
  pool,
  round2,
  toId,
  fail,
  text,
  num,
  MERCHANT_ACTIVE,
  allowedVehiclesFor,
} = require('./common');
const { broadcastOrderChange } = require('../realtime');
const { reconcileInBackground } = require('../payments/paymentService');

const PAGE_SIZE = 20;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 30;

// -----------------------------------------------------
// Stage / labels / timeline
// -----------------------------------------------------

const stageOf = (order) => {
  if (order.status === 'cancelled') return order.merchant_status === 'rejected' ? 'rejected' : 'cancelled';
  if (order.status === 'delivered') return 'completed';
  if (order.status === 'pending_shopper_search' || order.status === 'shopper_search_cancelled') return 'awaiting_confirmation';
  if (order.status === 'arrived') return 'arrived';
  if (order.status === 'out_for_delivery') return 'on_the_way';
  // Phase 60: store-managed delivery handed to the store's courier
  if (order.merchant_status === 'shipped') return 'on_the_way';
  return { new: 'waiting_store', accepted: 'accepted', preparing: 'preparing', ready: 'ready' }[order.merchant_status] || 'waiting_store';
};

const stageLabelOf = (order) => {
  const food = order.business_type === 'restaurant';
  const pickup = order.fulfilment_method === 'pickup';
  const ships = order.fulfilment_method === 'shop_delivery';
  return {
    awaiting_confirmation: 'Confirm your order',
    waiting_store: 'Waiting for the store to accept',
    accepted: 'Order accepted',
    preparing: food ? 'Preparing your food' : 'Packing your order',
    ready: pickup ? 'Ready to collect' : ships ? 'Packed, being sent to you' : 'Ready, waiting for your rider',
    on_the_way: ships ? `On the way${order.courier_name ? ` with ${order.courier_name}` : ' with the store'}` : 'Your rider is on the way',
    arrived: 'Your rider has arrived',
    completed: pickup ? 'Collected' : 'Delivered',
    rejected: 'The store could not take this order',
    cancelled: 'Order cancelled',
  }[stageOf(order)];
};

// Phase 61: category-specific steps, each ticked only by a real
// timestamp (or implied by a later real step, e.g. "Preparing" when the
// store went straight to ready). Restaurant / shop delivery by a GetMe
// rider: received -> accepted -> preparing / packing -> ready ->
// rider assigned -> picked up -> on the way -> delivered. A rider can be
// assigned while the store prepares, so "assigned" may tick before
// "ready"; "picked up" implies everything before it.
const timelineOf = (order) => {
  const food = order.business_type === 'restaurant';
  const store = food ? 'Restaurant' : 'Shop';
  const pickup = order.fulfilment_method === 'pickup';
  const ships = order.fulfilment_method === 'shop_delivery';
  const merchantSteps = [
    { key: 'placed', label: 'Order received', at: order.shopper_search_started_at || order.created_at },
    { key: 'accepted', label: `${store} accepted`, at: order.merchant_accepted_at },
    { key: 'preparing', label: food ? 'Preparing' : 'Processing / packing', at: order.merchant_preparing_at },
  ];
  let steps;
  if (pickup) {
    steps = [
      ...merchantSteps,
      { key: 'ready', label: 'Ready to collect', at: order.merchant_ready_at },
      { key: 'completed', label: 'Collected', at: order.delivered_at },
    ];
  } else if (ships) {
    // Packed -> sent with the store's courier -> delivered
    steps = [
      ...merchantSteps,
      { key: 'ready', label: 'Packed', at: order.merchant_ready_at },
      { key: 'on_the_way', label: order.courier_name ? `Sent with ${order.courier_name}` : 'Sent by the store', at: order.merchant_shipped_at },
      { key: 'completed', label: 'Delivered', at: order.delivered_at },
    ];
  } else {
    steps = [
      ...merchantSteps,
      { key: 'ready', label: 'Ready for pickup', at: order.merchant_ready_at },
      { key: 'assigned', label: food ? 'Bike shopper assigned' : 'Delivery assigned', at: order.shopper_id ? order.accepted_at || null : null },
      { key: 'picked_up', label: 'Picked up', at: order.merchant_picked_up_at },
      { key: 'on_the_way', label: 'On the way', at: order.out_for_delivery_at },
      { key: 'completed', label: 'Delivered', at: order.delivered_at },
    ];
  }

  // Implied by a later real step
  const idx = (key) => steps.findIndex((s) => s.key === key);
  const done = steps.map((s) => !!s.at);
  const imply = (fromKey, keys) => {
    if (done[idx(fromKey)]) for (const k of keys) if (idx(k) >= 0) done[idx(k)] = true;
  };
  imply('completed', steps.map((s) => s.key));
  imply('on_the_way', ['placed', 'accepted', 'preparing', 'ready', 'assigned', 'picked_up']);
  imply('picked_up', ['placed', 'accepted', 'preparing', 'ready', 'assigned']);
  imply('ready', ['placed', 'accepted', 'preparing']);
  imply('preparing', ['placed', 'accepted']);
  imply('assigned', ['placed', 'accepted']);
  imply('accepted', ['placed']);

  const finished = ['cancelled', 'delivered'].includes(order.status);
  const currentIndex = finished ? -1 : done.findIndex((d) => !d);
  return steps.map((step, i) => ({
    key: step.key,
    label: step.label,
    at: step.at || null,
    done: done[i],
    current: i === currentIndex,
  }));
};

const items = async (orderId, client = pool) =>
  (
    await client.query(
      `SELECT oi.*, COALESCE(p.image_url, oi.image) AS product_image
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1 ORDER BY oi.id`,
      [orderId]
    )
  ).rows;

const returnRows = async (orderId, client = pool) =>
  (
    await client.query(
      `SELECT r.*, oi.item_name, oi.variant_label FROM merchant_return_requests r
       JOIN order_items oi ON oi.id = r.order_item_id
       WHERE r.order_id = $1 ORDER BY r.id DESC`,
      [orderId]
    )
  ).rows;

const toReturn = (row) => ({
  id: Number(row.id),
  orderId: Number(row.order_id),
  orderItemId: Number(row.order_item_id),
  itemName: row.item_name || null,
  variantLabel: row.variant_label || null,
  quantity: Number(row.quantity),
  reasonCode: row.reason_code,
  reasonText: row.reason_text || null,
  photoUrls: Array.isArray(row.photo_urls) ? row.photo_urls : [],
  status: row.status,
  merchantNote: row.merchant_note || null,
  refundAmount: num(row.refund_amount),
  refundMethod: row.refund_method || null,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  receivedAt: row.received_at,
  refundedAt: row.refunded_at,
  ...(row.customer_first_name ? { customerFirstName: row.customer_first_name } : {}),
});

const returnWindowDays = async (type, client = pool) =>
  Number((await client.query('SELECT return_window_days FROM business_types WHERE key = $1', [type])).rows[0]?.return_window_days) || 0;

const toItem = (row, { returnOpen = false, returnable = false } = {}) => {
  const quantity = Number(row.quantity);
  const returned = Number(row.returned_quantity) || 0;
  const returnableQuantity = Math.max(0, quantity - returned);
  return {
    id: Number(row.id),
    productId: num(row.product_id),
    variantId: num(row.variant_id),
    name: row.item_name,
    variantLabel: row.variant_label || null,
    options: Array.isArray(row.options) ? row.options : [],
    quantity,
    unitPrice: round2(row.unit_price ?? row.price),
    lineTotal: round2(row.line_total ?? Number(row.price) * quantity),
    note: row.details || null,
    image: row.product_image || row.image || null,
    returnedQuantity: returned,
    returnable: returnable && returnableQuantity > 0 && !returnOpen,
    returnableQuantity,
  };
};

// -----------------------------------------------------
// Customer view
// -----------------------------------------------------

const summarizeForCustomer = async (orderId, customerId, client = pool) => {
  const order = (
    await client.query(
      `SELECT o.*, s.shop_name, s.image_url AS shop_logo, s.cover_url AS shop_cover, s.address AS shop_address,
              COALESCE(s.contact_phone, s.mobile) AS shop_phone, s.latitude AS shop_lat, s.longitude AS shop_lng,
              sh.full_name AS shopper_name, sh.mobile AS shopper_phone, sh.profile_image_url AS shopper_photo,
              sh.vehicle_type AS shopper_vehicle, sh.latitude AS shopper_lat, sh.longitude AS shopper_lng
       FROM orders o
       JOIN shops s ON s.id = o.shop_id
       LEFT JOIN shoppers sh ON sh.id = o.shopper_id
       WHERE o.id = $1 AND o.customer_id = $2 AND o.business_type <> 'grocery'`,
      [orderId, customerId]
    )
  ).rows[0];
  if (!order) return null;

  const [lines, returns] = await Promise.all([items(order.id, client), returnRows(order.id, client)]);
  const windowDays = order.business_type === 'clothing' ? await returnWindowDays('clothing', client) : 0;
  const windowEnds = order.delivered_at && windowDays > 0
    ? new Date(new Date(order.delivered_at).getTime() + windowDays * 86400000)
    : null;
  const canReturn = order.status === 'delivered' && windowEnds && windowEnds > new Date();
  const openReturnItems = new Set(
    returns.filter((r) => ['requested', 'approved', 'received', 'refund_pending'].includes(r.status)).map((r) => Number(r.order_item_id))
  );

  return {
    id: Number(order.id),
    businessType: order.business_type,
    fulfilment: order.fulfilment_method,
    // Phase 61
    allowedVehicles: order.fulfilment_method === 'delivery' ? allowedVehiclesFor(order.business_type) : null,
    ageCheck: order.min_customer_age ? { minAge: Number(order.min_customer_age), confirmedAt: order.age_confirmed_at || null } : null,
    status: order.status,
    merchantStatus: order.merchant_status,
    stage: stageOf(order),
    stageLabel: stageLabelOf(order),
    shop: {
      id: Number(order.shop_id),
      name: order.shop_name,
      logoUrl: order.shop_logo || null,
      coverUrl: order.shop_cover || null,
      address: order.shop_address || null,
      phone: order.shop_phone || null,
      latitude: num(order.shop_lat),
      longitude: num(order.shop_lng),
    },
    items: lines.map((row) => toItem(row, { returnOpen: openReturnItems.has(Number(row.id)), returnable: !!canReturn })),
    itemsTotal: round2(order.items_total),
    deliveryFee: round2(order.delivery_fee),
    tipAmount: round2(order.tip_amount),
    totalAmount: round2(order.total_amount),
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status || null,
    deliveryAddress: order.delivery_address || null,
    deliveryLatitude: num(order.delivery_latitude),
    deliveryLongitude: num(order.delivery_longitude),
    deliveryDropoff: order.delivery_dropoff || null,
    deliveryInstructions: order.delivery_instructions || null,
    prepMinutes: num(order.merchant_prep_minutes),
    readyBy: order.merchant_ready_by || null,
    createdAt: order.created_at,
    acceptedAt: order.merchant_accepted_at,
    preparingAt: order.merchant_preparing_at,
    readyAt: order.merchant_ready_at,
    pickedUpAt: order.merchant_picked_up_at,
    deliveredAt: order.delivered_at,
    cancelledAt: order.cancelled_at,
    cancelReason: order.cancel_reason || null,
    merchantNote: order.merchant_note || null,
    shopper: order.shopper_id
      ? {
          id: Number(order.shopper_id),
          name: order.shopper_name,
          phone: order.shopper_phone || null,
          photoUrl: order.shopper_photo || null,
          vehicleType: order.shopper_vehicle || null,
          latitude: num(order.shopper_lat),
          longitude: num(order.shopper_lng),
        }
      : null,
    deliveryPin: order.status === 'arrived' && order.fulfilment_method === 'delivery' ? order.delivery_pin || null : null,
    // Phase 60: store-managed delivery
    deliveryDistrict: order.delivery_district || null,
    shipMinDays: num(order.ship_min_days),
    shipMaxDays: num(order.ship_max_days),
    courierName: order.courier_name || null,
    trackingNumber: order.tracking_number || null,
    shippedAt: order.merchant_shipped_at || null,
    canConfirmReceived: order.fulfilment_method === 'shop_delivery' && order.merchant_status === 'shipped' && order.status === 'shop_shipping',
    pickupCode:
      order.fulfilment_method === 'pickup' && order.merchant_status === 'ready' && order.status === 'awaiting_pickup'
        ? order.delivery_pin || null
        : null,
    timeline: timelineOf(order),
    returns: returns.map(toReturn),
    returnWindowEndsAt: windowEnds ? windowEnds.toISOString() : null,
    canCancel:
      order.merchant_status === 'new' &&
      ['pending_shopper_search', 'waiting_for_shopper', 'awaiting_pickup', 'shop_shipping', 'shopper_search_cancelled'].includes(order.status),
  };
};

const listCustomerOrders = async (req, res) => {
  try {
    const customerId = Number(req.customer.customerId);
    const scope = req.query.scope === 'past' ? 'past' : req.query.scope === 'active' ? 'active' : 'all';
    const rows = (
      await pool.query(
        `SELECT o.id, o.business_type, o.fulfilment_method, o.status, o.merchant_status, o.created_at, o.delivered_at,
                o.total_amount, o.items_total, o.merchant_ready_by, o.cancelled_at,
                s.shop_name, s.image_url AS shop_logo,
                (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items WHERE order_id = o.id) AS item_count,
                (SELECT string_agg(item_name, ', ' ORDER BY id) FROM (SELECT item_name, id FROM order_items WHERE order_id = o.id LIMIT 3) t) AS item_names
         FROM orders o JOIN shops s ON s.id = o.shop_id
         WHERE o.customer_id = $1 AND o.business_type <> 'grocery'
           AND ($2 = 'all'
                OR ($2 = 'active' AND o.status NOT IN ('delivered', 'cancelled'))
                OR ($2 = 'past' AND o.status IN ('delivered', 'cancelled')))
         ORDER BY o.created_at DESC
         LIMIT 100`,
        [customerId, scope]
      )
    ).rows;

    return res.json({
      success: true,
      orders: rows.map((o) => ({
        id: Number(o.id),
        businessType: o.business_type,
        fulfilment: o.fulfilment_method,
        status: o.status,
        merchantStatus: o.merchant_status,
        stage: stageOf(o),
        stageLabel: stageLabelOf(o),
        shopName: o.shop_name,
        shopLogoUrl: o.shop_logo || null,
        itemCount: Number(o.item_count) || 0,
        itemNames: o.item_names || '',
        totalAmount: round2(o.total_amount),
        readyBy: o.merchant_ready_by || null,
        createdAt: o.created_at,
        deliveredAt: o.delivered_at,
        cancelledAt: o.cancelled_at,
      })),
    });
  } catch (error) {
    console.error('❌ MERCHANT ORDERS LIST ERROR:', error.message);
    return fail(res, 500, "We couldn't load your orders. Please try again.");
  }
};

const getCustomerOrder = async (req, res) => {
  try {
    const id = toId(req.params.orderId);
    const order = id ? await summarizeForCustomer(id, Number(req.customer.customerId)) : null;
    if (!order) return fail(res, 404, 'Order not found', 'NOT_FOUND');
    return res.json({ success: true, order });
  } catch (error) {
    console.error('❌ MERCHANT ORDER ERROR:', error.message);
    return fail(res, 500, "We couldn't load this order. Please try again.");
  }
};

// -----------------------------------------------------
// Events
// -----------------------------------------------------

const emitMerchantChange = (io, order, event = 'merchant-order-updated') => {
  if (!io || !order) return;
  const payload = {
    orderId: Number(order.id),
    order_id: Number(order.id),
    status: order.status,
    merchantStatus: order.merchant_status,
    businessType: order.business_type,
  };
  io.to(`shop:${order.shop_id}`).emit(event, { orderId: payload.orderId, status: payload.status, merchantStatus: payload.merchantStatus });
  io.to(`customer:${order.customer_id}`).emit('order-status-changed', { ...payload, customerId: Number(order.customer_id) });
  io.to(`order:${order.id}`).emit('order-status-changed', payload);
  if (order.shopper_id) io.to(`shopper:${order.shopper_id}`).emit('order-status-changed', payload);
  broadcastOrderChange(io, order.id, { event, status: order.status });
};

// Called by the existing start-search once a merchant order is
// confirmed (and paid, for card): the store hears about it now
const onMerchantOrderConfirmed = ({ io, order }) => {
  if (!io || !order) return;
  io.to(`shop:${order.shop_id}`).emit('merchant-order-new', {
    orderId: Number(order.id),
    businessType: order.business_type,
    fulfilment: order.fulfilment_method,
  });
  emitMerchantChange(io, order);
};

// -----------------------------------------------------
// Shop portal: list / detail
// -----------------------------------------------------

const TAB_SQL = {
  new: `o.merchant_status = 'new'`,
  active: `o.merchant_status IN ('accepted', 'preparing')`,
  ready: `(o.merchant_status = 'ready' OR (o.merchant_status IN ('picked_up', 'shipped') AND o.status NOT IN ('delivered', 'cancelled')))`,
  completed: `o.merchant_status = 'completed'`,
  cancelled: `o.merchant_status IN ('rejected', 'cancelled')`,
};

// Orders a store can see: confirmed (not still waiting for the
// customer to book / pay)
const VISIBLE_SQL = `o.shop_id = $1 AND o.business_type <> 'grocery' AND o.status NOT IN ('pending_shopper_search', 'shopper_search_cancelled')`;

const shopCounts = async (shopId) => {
  const row = (
    await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE ${TAB_SQL.new})::int AS new,
         COUNT(*) FILTER (WHERE ${TAB_SQL.active})::int AS active,
         COUNT(*) FILTER (WHERE ${TAB_SQL.ready})::int AS ready,
         COUNT(*) FILTER (WHERE ${TAB_SQL.completed})::int AS completed,
         COUNT(*) FILTER (WHERE ${TAB_SQL.cancelled})::int AS cancelled
       FROM orders o WHERE ${VISIBLE_SQL}`,
      [shopId]
    )
  ).rows[0];
  const returns = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM merchant_return_requests WHERE shop_id = $1 AND status IN ('requested', 'approved')`,
      [shopId]
    )
  ).rows[0].n;
  return { ...row, returns: Number(returns) };
};

const listShopOrders = async (req, res) => {
  try {
    const shopId = Number(req.shop.shopId);
    const tab = TAB_SQL[req.query.tab] ? req.query.tab : 'new';
    const page = Math.max(1, Number(req.query.page) || 1);
    const search = text(req.query.search, 40);
    const params = [shopId];
    let searchSql = '';
    if (search) {
      params.push(search.replace(/^#/, ''));
      searchSql = ` AND o.id::text = $${params.length}`;
    }

    const where = `${VISIBLE_SQL} AND ${TAB_SQL[tab]}${searchSql}`;
    const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM orders o WHERE ${where}`, params)).rows[0].n);
    const rows = (
      await pool.query(
        `SELECT o.id, o.created_at, o.merchant_status, o.status, o.fulfilment_method, o.items_total,
                o.merchant_ready_by, o.merchant_prep_minutes, o.payment_method, o.shopper_id,
                split_part(btrim(COALESCE(c.full_name, '')), ' ', 1) AS customer_first_name,
                split_part(btrim(COALESCE(sh.full_name, '')), ' ', 1) AS shopper_name,
                (SELECT COALESCE(SUM(quantity), 0)::int FROM order_items WHERE order_id = o.id) AS item_count,
                (SELECT COUNT(*)::int FROM merchant_return_requests r WHERE r.order_id = o.id AND r.status IN ('requested', 'approved')) AS returns_open
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN shoppers sh ON sh.id = o.shopper_id
         WHERE ${where}
         ORDER BY ${tab === 'new' || tab === 'active' || tab === 'ready' ? 'o.created_at ASC' : 'o.created_at DESC'}
         LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
        params
      )
    ).rows;

    return res.json({
      success: true,
      orders: rows.map((o) => ({
        id: Number(o.id),
        createdAt: o.created_at,
        merchantStatus: o.merchant_status,
        status: o.status,
        fulfilment: o.fulfilment_method,
        itemCount: Number(o.item_count) || 0,
        itemsTotal: round2(o.items_total),
        customerFirstName: o.customer_first_name || 'Customer',
        readyBy: o.merchant_ready_by || null,
        prepMinutes: num(o.merchant_prep_minutes),
        paymentMethod: o.payment_method,
        shopperName: o.shopper_name || null,
        shopperAssigned: !!o.shopper_id,
        returnsOpen: Number(o.returns_open) || 0,
      })),
      counts: await shopCounts(shopId),
      page,
      pageSize: PAGE_SIZE,
      total,
    });
  } catch (error) {
    console.error('❌ SHOP MERCHANT ORDERS ERROR:', error.message);
    return fail(res, 500, "Couldn't load orders. Please try again.");
  }
};

const shopOrderDetail = async (shopId, orderId) => {
  const order = (
    await pool.query(
      `SELECT o.*, split_part(btrim(COALESCE(c.full_name, '')), ' ', 1) AS customer_first_name,
              c.full_name AS customer_full_name, c.mobile AS customer_mobile,
              sh.full_name AS shopper_name, sh.vehicle_type AS shopper_vehicle, sh.vehicle_number AS shopper_vehicle_number
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN shoppers sh ON sh.id = o.shopper_id
       WHERE o.id = $2 AND ${VISIBLE_SQL}`,
      [shopId, orderId]
    )
  ).rows[0];
  if (!order) return null;

  const [lines, returns, settlement] = await Promise.all([
    items(order.id),
    returnRows(order.id),
    pool.query('SELECT * FROM merchant_settlements WHERE order_id = $1', [order.id]),
  ]);
  const s = settlement.rows[0];
  const area = String(order.delivery_address || '').split(',').map((part) => part.trim()).filter(Boolean).slice(-2).join(', ');

  return {
    id: Number(order.id),
    businessType: order.business_type,
    fulfilment: order.fulfilment_method,
    // Phase 61
    allowedVehicles: order.fulfilment_method === 'delivery' ? allowedVehiclesFor(order.business_type) : null,
    ageCheck: order.min_customer_age ? { minAge: Number(order.min_customer_age), confirmedAt: order.age_confirmed_at || null } : null,
    status: order.status,
    merchantStatus: order.merchant_status,
    stage: stageOf(order),
    stageLabel: stageLabelOf(order),
    customerFirstName: order.customer_first_name || 'Customer',
    deliveryArea: order.fulfilment_method !== 'pickup' ? area || null : null,
    // Phase 60: a store that delivers itself needs the address and a
    // phone number - shared only once it has accepted the order
    shipTo:
      order.fulfilment_method === 'shop_delivery' && !['new', 'rejected', 'cancelled'].includes(order.merchant_status)
        ? {
            name: order.customer_full_name || order.customer_first_name || 'Customer',
            phone: order.contact_phone || order.customer_mobile || null,
            address: order.delivery_address || null,
            district: order.delivery_district || null,
            instructions: order.delivery_instructions || null,
          }
        : null,
    deliveryFee: round2(order.delivery_fee),
    shipMinDays: num(order.ship_min_days),
    shipMaxDays: num(order.ship_max_days),
    courierName: order.courier_name || null,
    trackingNumber: order.tracking_number || null,
    shippedAt: order.merchant_shipped_at || null,
    items: lines.map((row) => toItem(row)),
    itemsTotal: round2(order.items_total),
    paymentMethod: order.payment_method,
    prepMinutes: num(order.merchant_prep_minutes),
    readyBy: order.merchant_ready_by || null,
    createdAt: order.created_at,
    confirmedAt: order.shopper_search_started_at || order.created_at,
    merchantNote: order.merchant_note || null,
    cancelReason: order.cancel_reason || null,
    timeline: timelineOf(order),
    shopper: order.shopper_id
      ? { name: order.shopper_name, vehicleType: order.shopper_vehicle || null, vehicleNumber: order.shopper_vehicle_number || null }
      : null,
    returns: returns.map(toReturn),
    settlement: s
      ? {
          itemsTotal: round2(s.items_total),
          commissionPercent: Number(s.commission_percent),
          commissionAmount: round2(s.commission_amount),
          refundsAmount: round2(s.refunds_amount),
          deliveryFee: round2(s.delivery_fee),
          netAmount: round2(s.net_amount),
          status: s.status === 'pending' && new Date(s.payable_after) <= new Date() ? 'payable' : s.status,
          payableAfter: s.payable_after,
        }
      : {
          itemsTotal: round2(order.items_total),
          commissionPercent: Number(order.commission_percent) || 0,
          commissionAmount: round2(order.commission_amount),
          refundsAmount: 0,
          deliveryFee: order.fulfilment_method === 'shop_delivery' ? round2(order.delivery_fee) : 0,
          netAmount: round2(Number(order.items_total) - Number(order.commission_amount || 0) + (order.fulfilment_method === 'shop_delivery' ? Number(order.delivery_fee || 0) : 0)),
          status: 'not_due',
          payableAfter: null,
        },
  };
};

const getShopOrder = async (req, res) => {
  try {
    const id = toId(req.params.orderId);
    const order = id ? await shopOrderDetail(Number(req.shop.shopId), id) : null;
    if (!order) return fail(res, 404, 'Order not found', 'NOT_FOUND');
    return res.json({ success: true, order });
  } catch (error) {
    console.error('❌ SHOP MERCHANT ORDER ERROR:', error.message);
    return fail(res, 500, "Couldn't load this order. Please try again.");
  }
};

// -----------------------------------------------------
// Shop portal: actions
// -----------------------------------------------------

const stateError = (res, order, message) =>
  fail(res, 409, message, 'ORDER_STATE', { status: order?.status, merchantStatus: order?.merchant_status });

// Locks the store's own confirmed order; null when not found
const lockShopOrder = async (client, shopId, orderId) =>
  (
    await client.query(
      `SELECT o.* FROM orders o WHERE o.id = $2 AND ${VISIBLE_SQL} FOR UPDATE`,
      [shopId, orderId]
    )
  ).rows[0] || null;

const runAction = async (req, res, apply) => {
  const shopId = Number(req.shop.shopId);
  const orderId = toId(req.params.orderId);
  if (!orderId) return fail(res, 404, 'Order not found', 'NOT_FOUND');

  const client = await pool.connect();
  let result;
  try {
    await client.query('BEGIN');
    const order = await lockShopOrder(client, shopId, orderId);
    if (!order) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Order not found', 'NOT_FOUND');
    }
    result = await apply(client, order);
    await client.query(result.error && !result.commit ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ MERCHANT ORDER ACTION ERROR:', error.message);
    return fail(res, 500, "Couldn't update this order. Please try again.");
  } finally {
    client.release();
  }

  if (result.error) return result.error();

  const io = req.app.get('io');
  emitMerchantChange(io, result.order);
  if (result.after) await result.after(io);

  return res.json({ success: true, order: await shopOrderDetail(shopId, orderId) });
};

const acceptOrder = (req, res) =>
  runAction(req, res, async (client, order) => {
    if (order.merchant_status !== 'new' || order.status === 'cancelled') {
      return { error: () => stateError(res, order, 'This order has already been answered.') };
    }
    const shop = (await client.query('SELECT default_prep_minutes FROM shops WHERE id = $1', [order.shop_id])).rows[0];
    let prep = req.body?.prepMinutes == null || req.body.prepMinutes === '' ? Number(order.merchant_prep_minutes || shop.default_prep_minutes || 20) : Number(req.body.prepMinutes);
    if (!Number.isInteger(prep) || prep < 1 || prep > 240) {
      return { error: () => fail(res, 400, 'Choose a preparation time between 1 and 240 minutes', 'BAD_PREP_TIME') };
    }
    prep = Math.round(prep);
    const updated = (
      await client.query(
        `UPDATE orders SET merchant_status = 'accepted', merchant_accepted_at = NOW(), merchant_prep_minutes = $2,
                merchant_ready_by = NOW() + make_interval(mins => $2), updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [order.id, prep]
      )
    ).rows[0];

    return {
      order: updated,
      after: async (io) => {
        // Delivery orders: the rider search starts now (DoorDash-style:
        // a rider is found while the store prepares)
        if (updated.fulfilment_method === 'delivery' && updated.status === 'waiting_for_shopper') {
          await require('../controllers/shopperDispatch').dispatchOrder({ io, orderId: Number(updated.id) }).catch((error) =>
            console.error('❌ MERCHANT DISPATCH ERROR:', error.message)
          );
        }
      },
    };
  });

const rejectOrder = (req, res) =>
  runAction(req, res, async (client, order) => {
    const reason = text(req.body?.reason, 300);
    if (!reason) return { error: () => fail(res, 400, 'Tell the customer why you can\'t take this order', 'REASON_REQUIRED') };
    if (order.merchant_status !== 'new' || order.status === 'cancelled') {
      return { error: () => stateError(res, order, 'Only new orders can be rejected. Contact GetMe support to cancel an accepted order.') };
    }
    const updated = (
      await client.query(
        `UPDATE orders SET merchant_status = 'rejected', merchant_rejected_at = NOW(), merchant_note = $2,
                status = 'cancelled', cancelled_at = NOW(), cancelled_by = 'shop', cancel_reason = $3,
                cancel_reason_code = 'store_rejected', cancelled_from_status = status, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [order.id, reason, `Store could not take the order: ${reason}`]
      )
    ).rows[0];
    return {
      order: updated,
      after: async (io) => {
        // Card payment back to the customer (nothing is owed on a
        // cancelled order with nothing bought)
        // (no rider offers exist yet: dispatch waits for acceptance)
        reconcileInBackground(updated.id, { io, reason: 'Store could not take the order' });
      },
    };
  });

const markPreparing = (req, res) =>
  runAction(req, res, async (client, order) => {
    if (order.merchant_status !== 'accepted' || order.status === 'cancelled') {
      return { error: () => stateError(res, order, order.merchant_status === 'new' ? 'Accept the order first.' : 'This order is already past this step.') };
    }
    const updated = (
      await client.query(
        `UPDATE orders SET merchant_status = 'preparing', merchant_preparing_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
        [order.id]
      )
    ).rows[0];
    return { order: updated };
  });

const markReady = (req, res) =>
  runAction(req, res, async (client, order) => {
    if (!['accepted', 'preparing'].includes(order.merchant_status) || order.status === 'cancelled') {
      return { error: () => stateError(res, order, order.merchant_status === 'new' ? 'Accept the order first.' : 'This order is already marked ready.') };
    }
    const pickup = order.fulfilment_method === 'pickup';
    const updated = (
      await client.query(
        `UPDATE orders SET merchant_status = 'ready', merchant_ready_at = NOW(),
                merchant_preparing_at = COALESCE(merchant_preparing_at, NOW()),
                delivery_pin = CASE WHEN $2 THEN $3 ELSE delivery_pin END,
                delivery_pin_failed_attempts = CASE WHEN $2 THEN 0 ELSE delivery_pin_failed_attempts END,
                delivery_pin_locked_until = CASE WHEN $2 THEN NULL ELSE delivery_pin_locked_until END,
                updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [order.id, pickup, String(crypto.randomInt(100000, 1000000))]
      )
    ).rows[0];
    return {
      order: updated,
      after: async (io) => {
        if (updated.shopper_id) {
          const { createShopperNotification } = require('../controllers/shopperNotificationController');
          await createShopperNotification({
            io,
            shopperId: Number(updated.shopper_id),
            type: 'order_ready',
            title: 'Order ready for pickup',
            body: `Order #${updated.id} is ready. Collect it from the store.`,
            orderId: Number(updated.id),
          }).catch(() => {});
        }
      },
    };
  });

// Phase 60: store-managed delivery - handed to the store's courier
const markShipped = (req, res) =>
  runAction(req, res, async (client, order) => {
    if (order.fulfilment_method !== 'shop_delivery') {
      return { error: () => stateError(res, order, 'Only store-delivery orders are sent by the store.') };
    }
    if (!['accepted', 'preparing', 'ready'].includes(order.merchant_status) || order.status !== 'shop_shipping') {
      return { error: () => stateError(res, order, order.merchant_status === 'new' ? 'Accept the order first.' : 'This order was already sent.') };
    }
    const courier = text(req.body?.courier, 60);
    const tracking = text(req.body?.trackingNumber, 80);
    const updated = (
      await client.query(
        `UPDATE orders SET merchant_status = 'shipped', merchant_shipped_at = NOW(),
                merchant_ready_at = COALESCE(merchant_ready_at, NOW()), merchant_preparing_at = COALESCE(merchant_preparing_at, NOW()),
                courier_name = COALESCE($2, (SELECT shop_delivery_courier FROM shops WHERE id = orders.shop_id)), tracking_number = $3,
                updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [order.id, courier, tracking]
      )
    ).rows[0];
    return { order: updated };
  });

const finishShopDelivery = async (client, order) =>
  (
    await client.query(
      `UPDATE orders SET status = 'delivered', delivered_at = NOW(), merchant_status = 'completed', updated_at = NOW()
       WHERE id = $1 AND status = 'shop_shipping' AND merchant_status = 'shipped' RETURNING *`,
      [order.id]
    )
  ).rows[0];

// The store (or its courier) delivered it
const markShopDelivered = (req, res) =>
  runAction(req, res, async (client, order) => {
    if (order.fulfilment_method !== 'shop_delivery' || order.merchant_status !== 'shipped' || order.status !== 'shop_shipping') {
      return { error: () => stateError(res, order, 'Mark the order as sent before marking it delivered.') };
    }
    const updated = await finishShopDelivery(client, order);
    return { order: updated, after: async (io) => reconcileInBackground(updated.id, { io, reason: 'Order delivered' }) };
  });

// Customer: "I received it" (store-delivery orders)
const confirmReceived = async (req, res) => {
  const customerId = Number(req.customer.customerId);
  const orderId = toId(req.params.orderId);
  const client = await pool.connect();
  let updated;
  try {
    await client.query('BEGIN');
    const order = (await client.query(`SELECT * FROM orders WHERE id = $1 AND customer_id = $2 AND business_type <> 'grocery' FOR UPDATE`, [orderId, customerId])).rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Order not found', 'NOT_FOUND');
    }
    if (order.fulfilment_method !== 'shop_delivery' || order.merchant_status !== 'shipped' || order.status !== 'shop_shipping') {
      await client.query('ROLLBACK');
      return stateError(res, order, order.status === 'delivered' ? 'This order is already marked delivered.' : 'You can confirm once the store has sent the order.');
    }
    updated = await finishShopDelivery(client, order);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ CONFIRM RECEIVED ERROR:', error.message);
    return fail(res, 500, "Couldn't update the order. Please try again.");
  } finally {
    client.release();
  }
  const io = req.app.get('io');
  emitMerchantChange(io, updated);
  reconcileInBackground(updated.id, { io, reason: 'Order delivered' });
  return res.json({ success: true, order: await summarizeForCustomer(updated.id, customerId) });
};

const markCollected = (req, res) =>
  runAction(req, res, async (client, order) => {
    if (order.fulfilment_method !== 'pickup') {
      return { error: () => stateError(res, order, 'A GetMe rider collects delivery orders. Hand the order to the rider.') };
    }
    if (order.merchant_status !== 'ready' || order.status !== 'awaiting_pickup') {
      return { error: () => stateError(res, order, 'Mark the order ready before the customer collects it.') };
    }
    if (order.delivery_pin_locked_until && new Date(order.delivery_pin_locked_until) > new Date()) {
      return { error: () => fail(res, 429, 'Too many wrong codes. Try again later or contact GetMe support.', 'CODE_LOCKED') };
    }
    const code = String(req.body?.code ?? '').replace(/\D/g, '');
    const expected = String(order.delivery_pin || '');
    const ok = code.length === expected.length && expected.length > 0 &&
      crypto.timingSafeEqual(Buffer.from(code), Buffer.from(expected));

    if (!ok) {
      const attempts = Number(order.delivery_pin_failed_attempts || 0) + 1;
      const lock = attempts >= PIN_MAX_ATTEMPTS;
      await client.query(
        `UPDATE orders SET delivery_pin_failed_attempts = $2,
                delivery_pin_locked_until = CASE WHEN $3 THEN NOW() + make_interval(mins => ${PIN_LOCK_MINUTES}) ELSE delivery_pin_locked_until END
         WHERE id = $1`,
        [order.id, lock ? 0 : attempts, lock]
      );
      return { commit: true, error: () => fail(res, 400, lock ? 'Too many wrong codes. Collection is locked for 30 minutes.' : 'That code is not right. Ask the customer to check the GetMe app.', 'WRONG_CODE') };
    }

    const updated = (
      await client.query(
        `UPDATE orders SET status = 'delivered', delivered_at = NOW(), merchant_status = 'completed',
                delivery_pin = NULL, delivery_pin_failed_attempts = 0, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [order.id]
      )
    ).rows[0];
    return {
      order: updated,
      after: async (io) => {
        reconcileInBackground(updated.id, { io, reason: 'Order collected' });
      },
    };
  });

// -----------------------------------------------------
// Shopper: collect a ready order from the store
// -----------------------------------------------------

const shopperPickup = async (req, res) => {
  const shopperId = Number(req.shopper?.shopperId || req.shopper?.id || req.shopperId || req.user?.shopperId || req.user?.id);
  const orderId = toId(req.params.orderId);
  if (!shopperId) return fail(res, 401, 'Shopper authentication required');
  if (!orderId) return fail(res, 400, 'Invalid order ID');

  const client = await pool.connect();
  let updated;
  try {
    await client.query('BEGIN');
    const order = (
      await client.query('SELECT * FROM orders WHERE id = $1 AND shopper_id = $2 FOR UPDATE', [orderId, shopperId])
    ).rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Order not found for this shopper');
    }
    if (order.business_type === 'grocery') {
      await client.query('ROLLBACK');
      return fail(res, 409, 'This is a grocery order: shop it and then start delivery.', 'ORDER_STATE');
    }
    if (order.status !== 'shopper_accepted') {
      await client.query('ROLLBACK');
      return stateError(res, order, order.status === 'out_for_delivery' ? 'You already picked up this order.' : 'This order cannot be picked up now.');
    }
    if (order.merchant_status !== 'ready') {
      await client.query('ROLLBACK');
      return fail(res, 409, order.business_type === 'restaurant'
        ? 'The restaurant is still preparing this order. Wait for it to be marked ready.'
        : 'The store is still packing this order. Wait for it to be marked ready.', 'NOT_READY');
    }
    updated = (
      await client.query(
        `UPDATE orders SET status = 'out_for_delivery', out_for_delivery_at = NOW(), merchant_status = 'picked_up',
                merchant_picked_up_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND shopper_id = $2 AND status = 'shopper_accepted' RETURNING *`,
        [orderId, shopperId]
      )
    ).rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ MERCHANT PICKUP ERROR:', error.message);
    return fail(res, 500, 'Could not confirm the pickup. Please try again.');
  } finally {
    client.release();
  }

  emitMerchantChange(req.app.get('io'), updated);
  return res.json({ success: true, message: 'Picked up. Deliver it to the customer.', order: updated });
};

module.exports = {
  markShipped,
  markShopDelivered,
  confirmReceived,
  stageOf,
  stageLabelOf,
  timelineOf,
  summarizeForCustomer,
  listCustomerOrders,
  getCustomerOrder,
  listShopOrders,
  getShopOrder,
  shopOrderDetail,
  acceptOrder,
  rejectOrder,
  markPreparing,
  markReady,
  markCollected,
  shopperPickup,
  onMerchantOrderConfirmed,
  emitMerchantChange,
  toReturn,
  returnWindowDays,
  MERCHANT_ACTIVE,
};
