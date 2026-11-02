// =====================================================
// PHASE 65: ONE CHECKOUT FOR EVERY CATEGORY (parent orders)
//
// POST /api/customer/order-groups/quote   prices everything
// POST /api/customer/order-groups         Place Order (once)
// GET  /api/customer/order-groups         the customer's parent orders
// GET  /api/customer/order-groups/:id     one parent order (tracking)
// GET  /api/admin/order-groups/:id        admin view (orders.view)
//
// One parent (order_groups, reference GM-1001) holds the customer's
// whole purchase; its children are ordinary orders:
//   grocery     ONE child for every supermarket in the purchase (the
//               existing multi-shop grocery order: one shopper buys at
//               each store separately, then delivers everything)
//   restaurant  one child per restaurant (Bike only - VEHICLE_RULES)
//   clothing    one child per store (GetMe rider, pickup, or the
//               store's own delivery)
// Every child is created by the SAME code as a single order
// (placeGroceryOrderTx / placeMerchantOrderTx) in ONE transaction, so
// either the whole purchase is placed or none of it.
//
// Vehicles: NOT chosen in checkout. The ORIGINAL vehicle step is used:
//   - with groceries: Place Order creates every child (nothing booked,
//     nothing charged; state 'awaiting_vehicle'), then the app opens the
//     existing "Order placed -> Choose a vehicle" screens for the grocery
//     child. Its start-search (customerOrderController) books the WHOLE
//     purchase: the grocery child with the chosen vehicle, the other
//     children the way their own checkout books them (restaurant Bike,
//     others the default) - bookGroupOnStartSearch below. Card: the same
//     402 approval, then ONE charge for everything.
//   - without groceries: there is no vehicle step in the original flow,
//     so Place Order books every child and charges once straight away.
//
// Payment:
//   card  ONE charge for the whole parent (card_payments purpose
//         'order_group'); each child's share is a card_payment_allocations
//         row. A declined / unanswered charge cancels every child (stock
//         and offers go back through the existing cancel rules) and
//         nothing stays charged. Later refunds for one child (rejected,
//         unavailable items, cancel) come only out of that child's share
//         (paymentService.orderChargeSources).
//   cash  each child is paid to its own rider / store on delivery (the
//         app shows each amount); no charge here.
// After payment every child is booked exactly like start-search
// (src/orders/booking.js) and then follows its own workflow. One child
// never changes another child's status.
// =====================================================

const pool = require('../config/db');
const { buildQuote, DROPOFF_OPTIONS, PAYMENT_METHODS } = require('../pricing/quote');
const { placeGroceryOrderTx, readQuoteInput } = require('../controllers/customerCreateOrderController');
const { buildMerchantQuote, placeMerchantOrderTx, readRequestId } = require('../marketplace/merchantCheckout');
const { allowedVehiclesFor } = require('../marketplace/common');
const payments = require('../payments/paymentService');
const accountControls = require('../customers/accountControls');
const { normalizeSriLankanMobile } = require('../utils/phone');
const { bookOrderRow, announceBooking } = require('../orders/booking');
const { broadcastOrderChange } = require('../realtime');

const MAX_STORES = 8;
const VEHICLE_LABELS = { motorbike: 'Bike', 'three-wheeler': 'Tuk', car: 'Car' };
const CATEGORY_LABELS = { grocery: 'Groceries', restaurant: 'Restaurant', clothing: 'Clothing', liquor: 'Liquor' };
const FINAL = ['delivered', 'completed', 'cancelled', 'shopper_search_cancelled'];
const round2 = (value) => Math.round(Number(value) * 100) / 100;

const fail = (res, status, message, code, extra = {}) =>
  res.status(status).json({ success: false, code, message, ...extra });

// ---------------------------------------------------------
// Input
// ---------------------------------------------------------

// { grocery: { items, deliveryOption, scheduled*, tipAmount, promoCode } | null,
//   stores: [{ shopId, items, fulfilment, tipAmount, ageConfirmed }] }
const readParts = (body) => {
  const grocery = body?.grocery && Array.isArray(body.grocery.items) && body.grocery.items.length ? body.grocery : null;
  const stores = (Array.isArray(body?.stores) ? body.stores : []).filter(
    (store) => store && Number(store.shopId) > 0 && Array.isArray(store.items) && store.items.length
  );
  const ids = stores.map((store) => Number(store.shopId));
  if (new Set(ids).size !== ids.length) return { error: [400, 'Each store can appear once in an order', 'DUPLICATE_STORE'] };
  if (stores.length > MAX_STORES) return { error: [400, `Up to ${MAX_STORES} stores in one order`, 'TOO_MANY_STORES'] };
  if (!grocery && stores.length === 0) return { error: [400, 'Your shopping list is empty', 'EMPTY'] };
  return { grocery, stores };
};

const where = (body) => ({
  deliveryLatitude: body?.deliveryLatitude,
  deliveryLongitude: body?.deliveryLongitude,
});

// The vehicle a non-grocery child is booked with, exactly like its own
// checkout's start-search (sent without a vehicle): restaurants Bike
// only (VEHICLE_RULES), any other store the default (no preference)
const defaultVehicleFor = (order) =>
  order.fulfilment_method === 'delivery' ? allowedVehiclesFor(order.business_type)?.[0] || null : null;

// ---------------------------------------------------------
// QUOTE: every child priced (default delivery fee, as each checkout shows)
// ---------------------------------------------------------

const quoteParts = async (customerId, body, parts) => {
  const children = [];

  if (parts.grocery) {
    const quote = await buildQuote(readQuoteInput({ ...parts.grocery, ...where(body) }, customerId));
    children.push({
      key: 'grocery',
      category: 'grocery',
      categoryLabel: CATEGORY_LABELS.grocery,
      shops: quote.shops.map((shop) => ({ id: shop.id, name: shop.name, image: shop.image, itemsTotal: shop.itemsTotal })),
      deliveryMethod: 'delivery',
      deliveryMethodLabel: quote.shops.length > 1
        ? `One shopper buys at ${quote.shops.length} stores, then delivers together`
        : 'A GetMe shopper buys and delivers',
      itemsTotal: quote.itemsTotal,
      fees: round2(quote.serviceFee + quote.getmeFee + quote.fastDeliveryFee),
      discount: round2(quote.discount + quote.windowDiscount),
      tip: quote.tipAmount,
      deliveryFee: quote.deliveryFee,
      total: quote.totalAmount,
      // The delivery fee / total change with the vehicle chosen on the
      // original Choose a vehicle screen after Place Order
      vehicleChosenAfterOrder: true,
      etaMinutes: quote.estimatedMinutes?.min ?? null,
      cashAllowed: true,
      issues: quote.issues,
      priceChanges: quote.priceChanges,
      canOrder: quote.issues.length === 0,
      blockMessage: quote.issues[0]?.message || null,
      detail: { deliveryOption: quote.deliveryOption, getmeFee: quote.getmeFee, serviceFee: quote.serviceFee, fastDeliveryFee: quote.fastDeliveryFee, promo: quote.promo },
    });
  }

  for (const store of parts.stores) {
    const built = await buildMerchantQuote({ body: { ...store, ...where(body) } });
    if (built.error) {
      children.push({
        key: `shop:${Number(store.shopId)}`,
        category: null,
        shops: [{ id: Number(store.shopId) }],
        canOrder: false,
        blockMessage: built.error.message,
        issues: [],
        total: 0,
        itemsTotal: 0,
        deliveryFee: 0,
      });
      continue;
    }
    const { quote, shop } = built;
    children.push({
      key: `shop:${Number(shop.id)}`,
      category: shop.business_type,
      categoryLabel: CATEGORY_LABELS[shop.business_type] || shop.business_type,
      shops: [{ id: Number(shop.id), name: shop.shop_name, image: shop.image_url || null, itemsTotal: quote.itemsTotal }],
      deliveryMethod: quote.fulfilment,
      deliveryMethodLabel:
        quote.fulfilment === 'pickup'
          ? 'You collect it from the store'
          : quote.fulfilment === 'shop_delivery'
            ? `The store's own delivery${quote.shipMinDays ? ` (${quote.shipMinDays}-${quote.shipMaxDays || quote.shipMinDays} days)` : ''}`
            : shop.business_type === 'restaurant'
              ? 'A GetMe rider collects it when ready (Bike only)'
              : 'A GetMe rider collects and delivers it',
      itemsTotal: quote.itemsTotal,
      fees: 0,
      discount: 0,
      tip: quote.tipAmount,
      deliveryFee: quote.deliveryFee,
      total: quote.total,
      etaMinutes: quote.estimatedDeliveryMinutes ?? null,
      prepMinutes: quote.prepMinutes,
      shipMinDays: quote.shipMinDays,
      shipMaxDays: quote.shipMaxDays,
      cashAllowed: !!quote.cashAllowed,
      ageCheck: quote.ageCheck,
      issues: quote.issues,
      canOrder: quote.canOrder,
      blockReason: quote.blockReason,
      blockMessage: quote.blockMessage || quote.issues[0]?.message || null,
      lines: quote.lines,
    });
  }

  const total = round2(children.reduce((sum, child) => sum + (Number(child.total) || 0), 0));
  const controls = await accountControls.controlsFor(customerId);
  const options = accountControls.paymentOptionsFor(controls, total);
  const cashChildren = children.filter((child) => !child.cashAllowed);
  const cash = cashChildren.length
    ? { allowed: false, code: 'CASH_NOT_OFFERED', reason: `${cashChildren[0].shops[0]?.name || 'A store'} does not take cash on delivery. Pay by card.` }
    : options.cash;

  return {
    children,
    totals: {
      itemsTotal: round2(children.reduce((sum, child) => sum + (Number(child.itemsTotal) || 0), 0)),
      deliveryTotal: round2(children.reduce((sum, child) => sum + (Number(child.deliveryFee) || 0), 0)),
      feesTotal: round2(children.reduce((sum, child) => sum + (Number(child.fees) || 0), 0)),
      tipTotal: round2(children.reduce((sum, child) => sum + (Number(child.tip) || 0), 0)),
      discountTotal: round2(children.reduce((sum, child) => sum + (Number(child.discount) || 0), 0)),
      total,
    },
    paymentOptions: { cash, card: options.card || { allowed: true } },
    canOrder: children.every((child) => child.canOrder),
    blocked: controls?.status === 'blocked',
  };
};

const getGroupQuote = async (req, res) => {
  try {
    const parts = readParts(req.body);
    if (parts.error) return fail(res, ...parts.error);
    const quote = await quoteParts(Number(req.customer.customerId), req.body, parts);
    return res.json({ success: true, quote });
  } catch (error) {
    console.error('❌ ORDER GROUP QUOTE ERROR:', error.message);
    return fail(res, 500, "We couldn't price your order right now. Please try again.", 'QUOTE_FAILED');
  }
};

// ---------------------------------------------------------
// PLACE ORDER (once)
// ---------------------------------------------------------

// Every child cancelled (declined card / could not complete): stock,
// offers and credit go back through the existing cancel rules (triggers)
const cancelChildren = async (groupId, state, message) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cancelled = (
      await client.query(
        `UPDATE orders
         SET status = 'cancelled',
             merchant_status = CASE WHEN merchant_status IS NULL THEN NULL ELSE 'cancelled' END,
             cancelled_by = 'system', cancel_reason = $2, cancel_reason_code = 'payment_not_completed',
             cancelled_at = NOW(), cancelled_from_status = status, delivery_pin = NULL, updated_at = NOW()
         WHERE order_group_id = $1 AND status IN ('pending_shopper_search', 'waiting_for_shopper', 'awaiting_pickup', 'shop_shipping')
           AND shopper_id IS NULL
         RETURNING id, status, payment_method`,
        [groupId, message]
      )
    ).rows;
    for (const order of cancelled) {
      await client.query(
        `INSERT INTO order_cancellations (order_id, cancelled_by, actor_id, reason_code, reason_text, from_status, payment_method)
         VALUES ($1, 'system', NULL, 'payment_not_completed', $2, 'pending_shopper_search', $3)
         ON CONFLICT (order_id) DO NOTHING`,
        [order.id, message, order.payment_method]
      );
    }
    await client.query(
      'UPDATE order_groups SET state = $2, state_message = $3, updated_at = NOW() WHERE id = $1',
      [groupId, state, String(message || '').slice(0, 300)]
    );
    await client.query('COMMIT');
    return cancelled.map((order) => Number(order.id));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ ORDER GROUP CANCEL CHILDREN ERROR:', groupId, error.message);
    return [];
  } finally {
    client.release();
  }
};

const publicBaseUrl = (req) => {
  const configured = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
};

const createGroup = async (req, res) => {
  const customerId = Number(req.customer.customerId);
  const io = req.app.get('io');
  const body = req.body || {};

  const parts = readParts(body);
  if (parts.error) return fail(res, ...parts.error);

  const paymentMethod = String(body.paymentMethod || 'cash').trim().toLowerCase();
  if (!['cash', 'card'].includes(paymentMethod) || !PAYMENT_METHODS.includes(paymentMethod)) {
    return fail(res, 400, 'Choose cash or card', 'BAD_PAYMENT_METHOD');
  }
  const deliveryAddress = String(body.deliveryAddress || '').trim().slice(0, 500);
  if (!deliveryAddress) return fail(res, 400, 'Choose a delivery address first', 'ADDRESS_REQUIRED');
  const lat = Number(body.deliveryLatitude);
  const lng = Number(body.deliveryLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail(res, 400, 'Choose a delivery address first', 'ADDRESS_REQUIRED');

  const groceryDropoff = DROPOFF_OPTIONS.includes(body.deliveryDropoff) ? body.deliveryDropoff : 'leave_at_door';
  const merchantDropoff = ['leave_at_door', 'meet_at_door'].includes(body.deliveryDropoff) ? body.deliveryDropoff : 'meet_at_door';
  const instructions = String(body.deliveryInstructions || '').trim().slice(0, 500) || null;
  let contactPhone = null;
  if (body.contactPhone) {
    contactPhone = normalizeSriLankanMobile(body.contactPhone);
    if (!contactPhone) return fail(res, 400, 'Enter a valid Sri Lankan mobile number', 'BAD_PHONE');
  }

  const requestId = readRequestId(body.requestId);
  if (body.requestId != null && !requestId) return fail(res, 400, 'Invalid request id', 'BAD_REQUEST_ID');

  // Same Place Order twice (double tap / retry after a timeout) = the
  // same parent order, never a second one and never a second charge
  if (requestId) {
    const earlier = (
      await pool.query('SELECT id FROM order_groups WHERE customer_id = $1 AND client_request_id = $2', [customerId, requestId])
    ).rows[0];
    if (earlier) {
      return res.status(200).json({ success: true, duplicate: true, group: await groupDetail(earlier.id, customerId) });
    }
  }

  // Routes / quotes looked up before the transaction (cached for the
  // re-pricing inside it); also validates vehicles before locking anything
  let preview;
  try {
    preview = await quoteParts(customerId, body, parts);
  } catch (error) {
    console.error('❌ ORDER GROUP PREVIEW ERROR:', error.message);
    return fail(res, 500, "We couldn't price your order right now. Please try again.", 'QUOTE_FAILED');
  }
  if (preview.blocked) return res.status(403).json({ success: false, ...accountControls.blockedBody() });

  // The customer agreed to a total; if it moved, ask again
  const expected = Number(body.expectedTotal);
  if (body.expectedTotal != null && body.expectedTotal !== '' && Number.isFinite(expected)) {
    const previewTotal = round2(preview.children.reduce((sum, child) => sum + (Number(child.total) || 0), 0));
    if (Math.abs(previewTotal - expected) > 0.009) {
      return fail(res, 409, `Your total changed to Rs ${previewTotal.toFixed(2)}. Please review and confirm.`, 'PRICE_CHANGED', { quote: preview });
    }
  }
  if (paymentMethod === 'cash' && !preview.paymentOptions.cash.allowed) {
    return fail(res, accountControls.cashRefusalStatus(preview.paymentOptions.cash.code) || 400, preview.paymentOptions.cash.reason, preview.paymentOptions.cash.code || 'CASH_NOT_OFFERED');
  }

  // ---------- 1. parent + every child, in ONE transaction ----------
  const client = await pool.connect();
  let group;
  const children = [];
  let refusal = null;

  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId]);

    group = (
      await client.query(
        `INSERT INTO order_groups (customer_id, payment_method, payment_card_id, delivery_address,
           delivery_latitude, delivery_longitude, client_request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [customerId, paymentMethod, paymentMethod === 'card' ? Number(body.cardId) || null : null, deliveryAddress, lat, lng, requestId]
      )
    ).rows[0];
    group = (
      await client.query("UPDATE order_groups SET reference = 'GM-' || (1000 + id) WHERE id = $1 RETURNING *", [group.id])
    ).rows[0];

    if (parts.grocery) {
      const placed = await placeGroceryOrderTx(client, {
        customerId,
        body: { ...parts.grocery, ...where(body), deliveryAddress, cardId: body.cardId, useCredit: false, expectedTotal: undefined },
        paymentMethod,
        deliveryAddress,
        deliveryDropoff: groceryDropoff,
        deliveryInstructions: instructions,
        contactPhone,
        requestId: null,
        orderGroupId: group.id,
      });
      if (placed.refusal) refusal = { child: 'grocery', status: placed.refusal[0], body: placed.refusal[1] };
      else children.push({ key: 'grocery', order: placed.order });
    }

    for (const store of parts.stores) {
      if (refusal) break;
      const key = `shop:${Number(store.shopId)}`;
      const placed = await placeMerchantOrderTx(client, {
        customerId,
        body: { ...store, ...where(body), cardId: body.cardId, expectedTotal: undefined },
        paymentMethod,
        deliveryAddress,
        dropoff: merchantDropoff,
        instructions,
        contactPhone,
        requestId: null,
        orderGroupId: group.id,
      });
      if (placed.refusal) refusal = { child: key, status: placed.refusal[0], body: placed.refusal[1] };
      else children.push({ key, order: placed.order });
    }

    if (!refusal) {
      const total = round2(children.reduce((sum, child) => sum + Number(child.order.total_amount), 0));
      const itemsTotal = round2(children.reduce((sum, child) => sum + Number(child.order.items_total), 0));
      const deliveryTotal = round2(children.reduce((sum, child) => sum + Number(child.order.delivery_fee), 0));
      group = (
        await client.query(
          `UPDATE order_groups SET items_total = $2, delivery_total = $3, fees_total = $4, total_amount = $5,
             payment_card_id = COALESCE((SELECT payment_card_id FROM orders WHERE order_group_id = $1 AND payment_card_id IS NOT NULL LIMIT 1), payment_card_id),
             updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [group.id, itemsTotal, deliveryTotal, round2(total - itemsTotal - deliveryTotal), total]
        )
      ).rows[0];
    }

    await client.query(refusal ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (error.stockRace) return fail(res, 409, 'Someone just bought the last one. Please check your shopping list again.', 'ORDER_ISSUES');
    if (error.code === '23505' && requestId) {
      const again = (await pool.query('SELECT id FROM order_groups WHERE customer_id = $1 AND client_request_id = $2', [customerId, requestId])).rows[0];
      if (again) return res.status(200).json({ success: true, duplicate: true, group: await groupDetail(again.id, customerId) });
    }
    console.error('❌ ORDER GROUP CREATE ERROR:', error.message);
    return fail(res, 500, "We couldn't place your order. Please try again.", 'ORDER_FAILED');
  }
  client.release();

  if (refusal) {
    const child = preview.children.find((item) => item.key === refusal.child);
    return res.status(refusal.status).json({
      success: false,
      ...refusal.body,
      child: refusal.child,
      shopName: child?.shops?.[0]?.name || null,
      message: child?.shops?.[0]?.name && refusal.child !== 'grocery'
        ? `${child.shops[0].name}: ${refusal.body.message}`
        : refusal.body.message,
    });
  }

  // ---------- 2a. groceries: the ORIGINAL vehicle step books + charges ----------
  // Nothing is booked or charged yet; the app opens the existing "Order
  // placed -> Choose a vehicle" screens for the grocery child, and its
  // start-search books every child with one charge (bookGroupOnStartSearch)
  const groceryChild = children.find((child) => child.key === 'grocery');
  if (groceryChild) {
    await pool.query(
      "UPDATE order_groups SET state = 'awaiting_vehicle', state_message = NULL, updated_at = NOW() WHERE id = $1",
      [group.id]
    );
    for (const child of children) {
      broadcastOrderChange(io, child.order.id, { event: 'order-created', status: child.order.status });
    }
    return res.status(201).json({
      success: true,
      next: { step: 'choose_vehicle', orderId: Number(groceryChild.order.id) },
      group: await groupDetail(group.id, customerId),
    });
  }

  // ---------- 2. no groceries: ONE card charge now (no vehicle step) ----------
  let charge = null;
  if (paymentMethod === 'card' && Number(group.total_amount) > 0.009) {
    try {
      charge = await payments.chargeSavedCard({
        owner: { type: 'customer', id: customerId },
        cardId: Number(group.payment_card_id) || Number(body.cardId),
        amount: Number(group.total_amount),
        purpose: 'order_group',
        orderGroupId: group.id,
        items: `GetMe order ${group.reference}`,
        baseUrl: publicBaseUrl(req),
        io,
      });
    } catch (error) {
      await cancelChildren(group.id, 'payment_failed', error.message);
      return fail(res, error.status || 502, error.message || 'The card payment did not go through', 'CARD_PAYMENT_FAILED', { reference: group.reference });
    }

    if (charge.status !== 'paid') {
      const message = payments.declineMessage(charge);
      await cancelChildren(group.id, 'payment_failed', message);
      return res.status(402).json({
        success: false,
        code: 'CARD_DECLINED',
        message,
        reference: group.reference,
        groupId: Number(group.id),
      });
    }
  }

  // ---------- 3. shares + book every child (one transaction) ----------
  const booked = [];
  const bookClient = await pool.connect();
  try {
    await bookClient.query('BEGIN');

    if (charge) {
      await bookClient.query('UPDATE order_groups SET card_payment_id = $2 WHERE id = $1', [group.id, charge.id]);
      // Shares add up to the one charge exactly
      let left = round2(Number(charge.amount));
      children.forEach((child, index) => {
        child.share = index === children.length - 1 ? left : round2(Number(child.order.total_amount));
        left = round2(left - child.share);
      });
      for (const child of children) {
        if (child.share > 0.009) {
          await bookClient.query(
            'INSERT INTO card_payment_allocations (card_payment_id, order_id, amount) VALUES ($1, $2, $3)',
            [charge.id, child.order.id, child.share]
          );
          await payments.syncOrderPaymentColumns(bookClient, child.order.id);
        }
      }
    }

    for (const child of children) {
      const row = await bookOrderRow(bookClient, {
        orderId: Number(child.order.id),
        customerId,
        preferredVehicle: defaultVehicleFor(child.order),
      });
      if (!row) throw new Error(`child order #${child.order.id} could not be booked`);
      booked.push(row);
    }

    await bookClient.query(
      "UPDATE order_groups SET state = 'placed', state_message = NULL, updated_at = NOW() WHERE id = $1",
      [group.id]
    );
    await bookClient.query('COMMIT');
  } catch (error) {
    await bookClient.query('ROLLBACK').catch(() => {});
    bookClient.release();
    console.error('❌ ORDER GROUP BOOKING ERROR:', group.id, error.message);
    await cancelChildren(group.id, 'failed', 'Your order could not be completed');
    if (charge) await payments.refundWholePayment(charge.id, `GetMe order ${group.reference} could not be completed`, io);
    return fail(res, 500, "We couldn't complete your order. Nothing has been charged.", 'ORDER_FAILED', { reference: group.reference });
  }
  bookClient.release();

  // Same notices as a single order: the app, shoppers nearby (groceries),
  // each store (clothing / restaurant)
  for (const order of booked) {
    broadcastOrderChange(io, order.id, { event: 'order-created', status: order.status });
    announceBooking({ io, order });
  }
  try {
    io?.to(`customer:${customerId}`).emit('order-group-update', { groupId: Number(group.id), reference: group.reference });
  } catch {
    // socket problems never fail the order
  }

  return res.status(201).json({ success: true, group: await groupDetail(group.id, customerId) });
};

// ---------------------------------------------------------
// THE ORIGINAL VEHICLE STEP BOOKS THE WHOLE PURCHASE
// Called by start-search (PATCH /api/customer/orders/:id/start-search)
// when the order belongs to a parent still waiting for its vehicle. Same
// request + answers as start-search: vehicleType for the order being
// booked (already checked there: restaurant Bike only), card approval
// (402 CARD_CHARGE_REQUIRED, then again with authorizeCharge = amount),
// cardId to retry with another card. A decline rolls everything back
// (nothing booked, nothing held) so the customer can try again.
// -> true when it answered, false when start-search should carry on
// ---------------------------------------------------------

const bookGroupOnStartSearch = async (req, res, { orderId, customerId, preferredVehicle }) => {
  const io = req.app.get('io');
  const found = (
    await pool.query(
      `SELECT og.* FROM orders o JOIN order_groups og ON og.id = o.order_group_id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [orderId, customerId]
    )
  ).rows[0];
  if (!found || found.state !== 'awaiting_vehicle') return false;

  const client = await pool.connect();
  let charge = null;
  let booked = [];
  let answer = null;

  try {
    await client.query('BEGIN');
    const group = (await client.query('SELECT * FROM order_groups WHERE id = $1 FOR UPDATE', [found.id])).rows[0];
    if (group.state !== 'awaiting_vehicle') {
      await client.query('ROLLBACK');
      client.release();
      return false;
    }

    const pending = (
      await client.query(
        `SELECT * FROM orders WHERE order_group_id = $1
           AND status IN ('pending_shopper_search', 'shopper_search_cancelled') AND shopper_id IS NULL
         ORDER BY id FOR UPDATE`,
        [group.id]
      )
    ).rows;

    // The order on the vehicle screen gets the chosen vehicle; every other
    // child is booked like its own checkout books it
    for (const order of pending) {
      const vehicle = Number(order.id) === Number(orderId) ? preferredVehicle : defaultVehicleFor(order);
      const row = await bookOrderRow(client, { orderId: Number(order.id), customerId, preferredVehicle: vehicle });
      if (row) booked.push(row);
    }
    if (!booked.some((row) => Number(row.id) === Number(orderId))) {
      await client.query('ROLLBACK');
      client.release();
      return false;
    }

    const total = round2(booked.reduce((sum, row) => sum + Number(row.total_amount), 0));

    if (group.payment_method === 'card' && total > 0.009) {
      const owner = { type: 'customer', id: customerId };
      const cardId = Number(req.body?.cardId) || Number(group.payment_card_id) || Number(booked.find((row) => row.payment_card_id)?.payment_card_id);
      const card = cardId ? await payments.getOwnerCard(owner, cardId, client) : null;
      if (!card) {
        answer = [400, { success: false, code: 'CARD_REQUIRED', message: 'The card for this order is no longer saved. Choose another card to book.' }];
      } else {
        const label = payments.toPublicCard(card).label;
        const approval = { extra: total, cardId: Number(card.id), card: { brand: card.card_brand, last4: card.card_last4, label } };
        if (!payments.chargeApproved(req.body, approval)) {
          // Same 402 the original screen already handles, for the whole purchase
          payments.chargeApprovalNeeded(
            res,
            approval,
            'This booking',
            `Booking charges Rs ${total.toFixed(2)} to ${label || 'your card'} for your whole order ${group.reference} (${booked.length} ${booked.length === 1 ? 'part' : 'parts'}). Approve the payment?`
          );
          await client.query('ROLLBACK');
          client.release();
          return true;
        }
        charge = await payments.chargeSavedCard({
          owner,
          cardId: Number(card.id),
          amount: total,
          purpose: 'order_group',
          orderGroupId: group.id,
          items: `GetMe order ${group.reference}`,
          baseUrl: publicBaseUrl(req),
          io,
        });
        if (charge.status !== 'paid') {
          answer = [402, { success: false, code: 'CARD_DECLINED', message: payments.declineMessage(charge) }];
          charge = null;
        } else {
          // Shares add up to the one charge exactly
          let left = round2(Number(charge.amount));
          for (const [index, row] of booked.entries()) {
            const share = index === booked.length - 1 ? left : round2(Number(row.total_amount));
            left = round2(left - share);
            if (share > 0.009) {
              await client.query(
                'INSERT INTO card_payment_allocations (card_payment_id, order_id, amount) VALUES ($1, $2, $3)',
                [charge.id, row.id, share]
              );
              await payments.syncOrderPaymentColumns(client, row.id);
            }
          }
          await client.query('UPDATE orders SET payment_card_id = $2 WHERE order_group_id = $1', [group.id, card.id]);
          await client.query('UPDATE order_groups SET card_payment_id = $2, payment_card_id = $3 WHERE id = $1', [group.id, charge.id, card.id]);
        }
      }
    }

    if (answer) {
      // Declined / no card: nothing booked, nothing held (retry like before)
      await client.query('ROLLBACK');
    } else {
      await client.query(
        `UPDATE order_groups SET state = 'placed', state_message = NULL, updated_at = NOW(),
           items_total = $2, delivery_total = $3, fees_total = $4, total_amount = $5 WHERE id = $1`,
        [
          group.id,
          round2(booked.reduce((sum, row) => sum + Number(row.items_total), 0)),
          round2(booked.reduce((sum, row) => sum + Number(row.delivery_fee), 0)),
          round2(total - booked.reduce((sum, row) => sum + Number(row.items_total) + Number(row.delivery_fee), 0)),
          total,
        ]
      );
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (charge) await payments.refundWholePayment(charge.id, 'Booking did not complete', io);
    throw error;
  }
  client.release();

  if (answer) {
    res.status(answer[0]).json(answer[1]);
    return true;
  }

  for (const row of booked) announceBooking({ io, order: row });
  try {
    io?.to(`customer:${customerId}`).emit('order-group-update', { groupId: Number(found.id), reference: found.reference });
  } catch {
    // socket problems never fail the booking
  }

  const order = booked.find((row) => Number(row.id) === Number(orderId));
  res.status(200).json({
    success: true,
    message: 'Shopper search started',
    order,
    group: { id: Number(found.id), reference: found.reference, booked: booked.length },
  });
  return true;
};

// ---------------------------------------------------------
// TRACKING: one parent order, every child
// ---------------------------------------------------------

const STATUS_LABELS = {
  pending_shopper_search: 'Placed',
  waiting_for_shopper: 'Finding a shopper',
  shopper_accepted: 'Shopper assigned',
  shopping: 'Shopping',
  out_for_delivery: 'On the way',
  arrived: 'Arrived',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  shopper_search_cancelled: 'Cancelled',
  awaiting_pickup: 'Ready for you to collect',
  shop_shipping: 'Store delivery',
};

const MERCHANT_LABELS = {
  new: 'Waiting for the store',
  accepted: 'Accepted by the store',
  preparing: 'Being prepared',
  ready: 'Ready for pickup',
  shipped: 'Shipped by the store',
  picked_up: 'Picked up',
  completed: 'Completed',
  rejected: 'Store declined',
  cancelled: 'Cancelled',
};

// One child's progress (0-100) for the parent's overall bar
const childProgress = (order) => {
  if (['delivered', 'completed'].includes(order.status)) return 100;
  if (FINAL.includes(order.status)) return 100;
  const steps = order.business_type === 'grocery'
    ? ['pending_shopper_search', 'waiting_for_shopper', 'shopper_accepted', 'shopping', 'out_for_delivery', 'arrived']
    : null;
  if (steps) {
    const at = steps.indexOf(order.status);
    return at < 0 ? 10 : Math.round(((at + 1) / (steps.length + 1)) * 100);
  }
  const merchantSteps = ['new', 'accepted', 'preparing', 'ready', 'picked_up', 'shipped'];
  const m = merchantSteps.indexOf(order.merchant_status);
  const delivering = ['out_for_delivery', 'arrived'].includes(order.status);
  return delivering ? 85 : m < 0 ? 10 : Math.round(((m + 1) / (merchantSteps.length + 1)) * 80);
};

const childStatusLabel = (order) => {
  if (order.status === 'cancelled' && order.merchant_status === 'rejected') return 'Store declined';
  if (order.business_type !== 'grocery' && !['out_for_delivery', 'arrived', 'delivered', 'completed', 'cancelled'].includes(order.status)) {
    return MERCHANT_LABELS[order.merchant_status] || STATUS_LABELS[order.status] || order.status;
  }
  return STATUS_LABELS[order.status] || order.status;
};

const parentStatus = (group, orders) => {
  if (group.state === 'payment_failed') return { key: 'payment_failed', label: 'Payment not completed' };
  if (group.state === 'failed') return { key: 'failed', label: 'Could not be completed' };
  if (group.state === 'placing') return { key: 'placing', label: 'Placing your order' };
  if (group.state === 'awaiting_vehicle') return { key: 'awaiting_vehicle', label: 'Choose a vehicle to book your order' };
  const finals = orders.filter((order) => FINAL.includes(order.status));
  const cancelled = orders.filter((order) => ['cancelled', 'shopper_search_cancelled'].includes(order.status));
  if (orders.length && finals.length === orders.length) {
    if (cancelled.length === orders.length) return { key: 'cancelled', label: 'Cancelled' };
    return cancelled.length
      ? { key: 'completed_partly', label: `Completed (${cancelled.length} of ${orders.length} cancelled)` }
      : { key: 'completed', label: 'Completed' };
  }
  const moving = orders.some((order) => ['out_for_delivery', 'arrived'].includes(order.status));
  const done = orders.filter((order) => ['delivered', 'completed'].includes(order.status)).length;
  if (done) return { key: 'in_progress', label: `${done} of ${orders.length} delivered` };
  if (moving) return { key: 'in_progress', label: 'On the way' };
  return { key: 'in_progress', label: 'In progress' };
};

const childSummary = async (order, { forAdmin = false } = {}) => {
  const [items, shops, shopper, payment] = await Promise.all([
    pool.query(
      `SELECT oi.id, oi.shop_id, oi.item_name, oi.quantity, oi.unit, oi.price, oi.line_total, oi.image,
              oi.variant_label, oi.options, oi.shopping_status, oi.refund_amount, oi.custom
       FROM order_items oi WHERE oi.order_id = $1 ORDER BY oi.id`,
      [order.id]
    ),
    pool.query(
      `SELECT os.shop_id, os.shop_name, os.shop_image, s.business_type, s.city, s.area
       FROM order_shops os LEFT JOIN shops s ON s.id = os.shop_id WHERE os.order_id = $1 ORDER BY os.id`,
      [order.id]
    ),
    order.shopper_id
      ? pool.query('SELECT id, full_name, vehicle_type, vehicle_number, profile_image_url, latitude, longitude FROM shoppers WHERE id = $1', [order.shopper_id])
      : Promise.resolve({ rows: [] }),
    payments.orderPaymentSummary(order).catch(() => null),
  ]);
  const rider = shopper.rows[0];
  const live = ['shopper_accepted', 'shopping', 'out_for_delivery', 'arrived'].includes(order.status);
  const etaAt =
    !FINAL.includes(order.status) && Number(order.estimated_delivery_minutes) > 0
      ? new Date(new Date(order.created_at).getTime() + Number(order.estimated_delivery_minutes) * 60000).toISOString()
      : null;

  return {
    orderId: Number(order.id),
    category: order.business_type || 'grocery',
    categoryLabel: CATEGORY_LABELS[order.business_type || 'grocery'] || order.business_type,
    status: order.status,
    merchantStatus: order.merchant_status || null,
    statusLabel: childStatusLabel(order),
    progress: childProgress(order),
    final: FINAL.includes(order.status),
    fulfilment: order.fulfilment_method || 'delivery',
    vehicle: order.preferred_vehicle_type || null,
    vehicleLabel: VEHICLE_LABELS[order.preferred_vehicle_type] || null,
    shops: shops.rows.map((shop) => ({
      id: Number(shop.shop_id),
      name: shop.shop_name,
      image: shop.shop_image,
      businessType: shop.business_type,
      area: [shop.area, shop.city].filter(Boolean).join(', ') || null,
    })),
    items: items.rows.map((item) => ({
      id: Number(item.id),
      shopId: item.shop_id != null ? Number(item.shop_id) : null,
      name: item.item_name,
      quantity: Number(item.quantity),
      unit: item.unit,
      price: Number(item.price),
      lineTotal: item.line_total != null ? Number(item.line_total) : null,
      image: item.image,
      variantLabel: item.variant_label,
      options: item.options || null,
      shoppingStatus: item.shopping_status,
      refundAmount: Number(item.refund_amount || 0),
      custom: !!item.custom,
    })),
    itemsTotal: Number(order.items_total),
    deliveryFee: Number(order.delivery_fee),
    total: Number(order.total_amount),
    paymentMethod: order.payment_method,
    paymentStatus: order.payment_status || null,
    payment: payment
      ? { charged: payment.amountCharged, refunded: payment.amountRefunded, netPaid: payment.netPaid, owed: payment.amountOwed }
      : null,
    cashToPay: order.payment_method === 'cash' && !FINAL.includes(order.status) ? Number(order.total_amount) : null,
    rider: rider
      ? {
          id: Number(rider.id),
          name: rider.full_name,
          vehicleType: rider.vehicle_type,
          vehicleNumber: rider.vehicle_number,
          photo: rider.profile_image_url,
          location: live && rider.latitude != null ? { latitude: Number(rider.latitude), longitude: Number(rider.longitude) } : null,
        }
      : null,
    etaAt,
    prepMinutes: order.merchant_prep_minutes != null ? Number(order.merchant_prep_minutes) : null,
    deliveryPin: order.status === 'arrived' && (order.fulfilment_method || 'delivery') === 'delivery' ? order.delivery_pin || null : null,
    cancelReason: order.status === 'cancelled' ? order.cancel_reason || null : null,
    cancelledBy: order.status === 'cancelled' ? order.cancelled_by || null : null,
    createdAt: order.created_at,
    deliveredAt: order.delivered_at || null,
    ...(forAdmin ? { customerId: Number(order.customer_id), shopperId: order.shopper_id != null ? Number(order.shopper_id) : null } : {}),
  };
};

const groupDetail = async (groupId, customerId, { forAdmin = false } = {}) => {
  const group = (
    await pool.query(
      forAdmin ? 'SELECT * FROM order_groups WHERE id = $1' : 'SELECT * FROM order_groups WHERE id = $1 AND customer_id = $2',
      forAdmin ? [groupId] : [groupId, customerId]
    )
  ).rows[0];
  if (!group) return null;

  const orders = (
    await pool.query('SELECT * FROM orders WHERE order_group_id = $1 ORDER BY id', [group.id])
  ).rows;
  const children = await Promise.all(orders.map((order) => childSummary(order, { forAdmin })));
  const charge = group.card_payment_id
    ? (await pool.query('SELECT * FROM card_payments WHERE id = $1', [group.card_payment_id])).rows[0]
    : null;
  const status = parentStatus(group, orders);
  const progress = children.length
    ? Math.round(children.reduce((sum, child) => sum + child.progress, 0) / children.length)
    : 0;

  return {
    id: Number(group.id),
    reference: group.reference,
    state: group.state,
    stateMessage: group.state_message,
    // Set while the parent waits for the original Choose a vehicle step
    chooseVehicleOrderId: group.state === 'awaiting_vehicle'
      ? (orders.find((order) => (order.business_type || 'grocery') === 'grocery' && ['pending_shopper_search', 'shopper_search_cancelled'].includes(order.status))?.id ?? null)
      : null,
    // Any part still waiting to be booked (e.g. the grocery part was cancelled
    // before its vehicle was chosen): booking it books the rest, one charge
    bookOrderId: group.state === 'awaiting_vehicle'
      ? (orders.find((order) => ['pending_shopper_search', 'shopper_search_cancelled'].includes(order.status))?.id ?? null)
      : null,
    status: status.key,
    statusLabel: status.label,
    progress,
    paymentMethod: group.payment_method,
    payment: charge
      ? {
          // ONE card charge for the whole parent order
          chargeRef: charge.ref,
          amount: Number(charge.amount),
          refunded: Number(charge.refunded_amount || 0),
          status: charge.status,
          card: charge.card_last4 ? { brand: charge.card_brand, last4: charge.card_last4 } : null,
          testMode: charge.gateway === 'test',
          paidAt: charge.paid_at,
        }
      : null,
    // Cash: each delivery is paid when it arrives
    cashDue: group.payment_method === 'cash'
      ? children.filter((child) => child.cashToPay).map((child) => ({ orderId: child.orderId, shops: child.shops.map((shop) => shop.name), amount: child.cashToPay }))
      : [],
    itemsTotal: Number(group.items_total),
    deliveryTotal: Number(group.delivery_total),
    feesTotal: Number(group.fees_total),
    total: Number(group.total_amount),
    deliveryAddress: group.delivery_address,
    createdAt: group.created_at,
    counts: {
      children: children.length,
      delivered: children.filter((child) => ['delivered', 'completed'].includes(child.status)).length,
      cancelled: children.filter((child) => ['cancelled', 'shopper_search_cancelled'].includes(child.status)).length,
      active: children.filter((child) => !child.final).length,
    },
    children,
    ...(forAdmin ? { customerId: Number(group.customer_id) } : {}),
  };
};

const listGroups = async (req, res) => {
  try {
    const customerId = Number(req.customer.customerId);
    const rows = (
      await pool.query(
        `SELECT og.*,
                (SELECT json_agg(json_build_object('orderId', o.id, 'status', o.status, 'merchantStatus', o.merchant_status,
                         'category', COALESCE(o.business_type, 'grocery'), 'total', o.total_amount,
                         'shops', (SELECT json_agg(os.shop_name ORDER BY os.id) FROM order_shops os WHERE os.order_id = o.id))
                         ORDER BY o.id)
                 FROM orders o WHERE o.order_group_id = og.id) AS children
         FROM order_groups og
         WHERE og.customer_id = $1 AND og.state <> 'placing'
         ORDER BY og.id DESC
         LIMIT 50`,
        [customerId]
      )
    ).rows;
    return res.json({
      success: true,
      groups: rows.map((row) => {
        const orders = row.children || [];
        const status = parentStatus(row, orders.map((order) => ({ status: order.status })));
        return {
          id: Number(row.id),
          reference: row.reference,
          state: row.state,
          status: status.key,
          statusLabel: status.label,
          total: Number(row.total_amount),
          paymentMethod: row.payment_method,
          createdAt: row.created_at,
          children: orders.map((order) => ({
            orderId: Number(order.orderId),
            category: order.category,
            categoryLabel: CATEGORY_LABELS[order.category] || order.category,
            status: order.status,
            statusLabel: childStatusLabel({ status: order.status, merchant_status: order.merchantStatus, business_type: order.category }),
            total: Number(order.total),
            shops: order.shops || [],
          })),
        };
      }),
    });
  } catch (error) {
    console.error('❌ ORDER GROUP LIST ERROR:', error.message);
    return fail(res, 500, "We couldn't load your orders", 'LIST_FAILED');
  }
};

const getGroup = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid order', 'BAD_ID');
    const group = await groupDetail(id, Number(req.customer.customerId));
    if (!group) return fail(res, 404, 'Order not found', 'NOT_FOUND');
    return res.json({ success: true, group });
  } catch (error) {
    console.error('❌ ORDER GROUP DETAIL ERROR:', error.message);
    return fail(res, 500, "We couldn't load this order", 'DETAIL_FAILED');
  }
};

const adminGetGroup = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid order group', 'BAD_ID');
    const group = await groupDetail(id, null, { forAdmin: true });
    if (!group) return fail(res, 404, 'Order group not found', 'NOT_FOUND');
    return res.json({ success: true, group });
  } catch (error) {
    console.error('❌ ADMIN ORDER GROUP ERROR:', error.message);
    return fail(res, 500, "Couldn't load the order group", 'DETAIL_FAILED');
  }
};

module.exports = {
  getGroupQuote,
  createGroup,
  listGroups,
  getGroup,
  adminGetGroup,
  groupDetail,
  bookGroupOnStartSearch,
  quoteParts,
  readParts,
};
