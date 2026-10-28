const pool = require('../config/db');

const { buildQuote } = require('../pricing/quote');
const { serviceUnits, customerTotals } = require('../pricing/fees');
const { broadcastOrderChange } = require('../realtime');
const { postChatEvent } = require('../utils/chatEvents');
const { publicBaseUrl } = require('../payments/payhere');
const {
  extraChargeFor,
  chargeOrderExtra,
  chargeApprovalNeeded,
  chargeApproved,
  syncOrderPaymentColumns,
  refundWholePayment,
  reconcileInBackground,
} = require('../payments/paymentService');
const { createShopperNotification } = require('./shopperNotificationController');
const { insertOrderLine } = require('./customerOrderChangesController');

// =====================================================
// EXTRA ITEMS WHILE SHOPPING (order_item_requests)
// Before shopping starts the customer adds items straight to the
// order (customerOrderChangesController /add-items). Once the
// shopper is shopping (status 'shopping'), every extra item is a
// request the other side answers:
//
//   customer asks  -> POST /api/customer/orders/:id/item-requests
//                     (preview first; saved-card orders approve the
//                     extra charge up front: 402 CARD_CHARGE_REQUIRED
//                     until authorizeCharge matches)
//                  -> shopper accepts / rejects
//   shopper adds   -> POST /api/shopper/orders/:id/item-requests
//   (customer asked in chat for something not on the list)
//                  -> customer approves (sees the cost; card orders
//                     approve the charge) / declines
//
// Accepting inserts the line in that item's shop list (shopping
// progress of the other items is untouched), raises items total,
// service fee and order total, and charges a saved card the
// approved amount. A shop can't be checked out while one of its
// requests is pending (pendingRequestsFor).
//
// Socket events (customer:{id}, shopper:{id}, order:{id}):
//   order-item-request          { orderId, request }
//   order-item-request-updated  { orderId, request, totals? }
// plus 'order-items-added' and admin / shop broadcasts on accept.
// =====================================================

const MAX_ITEMS_PER_REQUEST = 20;

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const toId = (value) => {
  const id = Number(value);

  return Number.isInteger(id) && id > 0 ? id : null;
};

const toPublicRequest = (row) => ({
  id: Number(row.id),
  orderId: Number(row.order_id),
  shopId: Number(row.shop_id),
  requestedBy: row.requested_by,
  status: row.status,
  productId: row.product_id != null ? Number(row.product_id) : null,
  itemName: row.item_name,
  image: row.item_image,
  quantity: Number(row.quantity),
  unit: row.unit,
  unitPrice: row.line?.unitPrice != null ? Number(row.line.unitPrice) : null,
  packPrice: row.line?.packPrice != null ? Number(row.line.packPrice) : null,
  amount: row.line?.amount != null ? Number(row.line.amount) : null,
  lineTotal: Number(row.line_total),
  approvedCharge: row.approved_charge != null ? Number(row.approved_charge) : null,
  note: row.note,
  rejectReason: row.reject_reason,
  orderItemId: row.order_item_id != null ? Number(row.order_item_id) : null,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
});

const orderTotals = (order) => ({
  itemsTotal: Number(order.items_total),
  serviceFee: Number(order.service_fee),
  getmeFee: Number(order.getme_fee),
  totalAmount: Number(order.total_amount),
});

// Same event to everyone who shows the order
const emitRequest = (io, order, event, payload) => {
  try {
    if (!io) {
      return;
    }

    const data = { orderId: Number(order.id), order_id: Number(order.id), ...payload };

    io.to(`customer:${order.customer_id}`).emit(event, data);
    io.to(`order:${order.id}`).emit(event, data);

    if (order.shopper_id) {
      io.to(`shopper:${order.shopper_id}`).emit(event, data);
    }

    broadcastOrderChange(io, order.id, { event });
  } catch (error) {
    console.error('❌ ITEM REQUEST SOCKET ERROR:', error.message);
  }
};

// Requests that block checkout (one shop, or the whole order)
const pendingRequestsFor = async (orderId, shopId = null, client = pool) => {
  const result = await client.query(
    `
    SELECT COUNT(*)::int AS count
    FROM order_item_requests
    WHERE order_id = $1 AND status = 'pending'
      AND ($2::int IS NULL OR shop_id = $2::int)
    `,
    [orderId, shopId]
  );

  return result.rows[0].count;
};

// Shelf price changes the customer hasn't answered (orderPriceReportsController)
const pendingPriceReportsFor = async (orderId, shopId = null, client = pool) =>
  (
    await client.query(
      `
      SELECT COUNT(*)::int AS count
      FROM order_item_price_reports
      WHERE order_id = $1 AND status = 'pending'
        AND ($2::int IS NULL OR shop_id = $2::int)
      `,
      [orderId, shopId]
    )
  ).rows[0].count;

// 409 reply for checkout / delivery while requests wait (null = go on)
const pendingRequestsBlock = async (orderId, shopId = null) => {
  const count = await pendingRequestsFor(orderId, shopId);
  const priceCount = await pendingPriceReportsFor(orderId, shopId);

  if (count === 0 && priceCount === 0) {
    return null;
  }

  if (count === 0) {
    return {
      success: false,
      code: 'PRICE_REPORTS_PENDING',
      pendingCount: priceCount,
      message:
        priceCount === 1
          ? 'The customer is still answering a price change. Wait for their answer before checking out.'
          : `The customer is still answering ${priceCount} price changes. Wait for their answers before checking out.`,
    };
  }

  return {
    success: false,
    code: 'ITEM_REQUESTS_PENDING',
    pendingCount: count,
    message:
      count === 1
        ? 'An extra item request is still waiting. Accept or reject it before checking out.'
        : `${count} extra item requests are still waiting. Answer them before checking out.`,
  };
};

// Shops already checked out (bill uploaded or paid by card) take no
// more items
const closedShopIds = async (client, orderId) => {
  const result = await client.query(
    `
    SELECT shop_id FROM order_shop_bills
    WHERE order_id = $1 AND (bill_url IS NOT NULL OR bill_uploaded_at IS NOT NULL)
    UNION
    SELECT shop_id FROM card_payments
    WHERE order_id = $1 AND purpose = 'store_bill' AND status = 'paid'
    `,
    [orderId]
  );

  return result.rows.map((row) => Number(row.shop_id));
};

// The order row locked, with a reason it can't take extra items
const lockShoppingOrder = async (client, where, values) => {
  const order = (
    await client.query(`SELECT * FROM orders WHERE ${where} FOR UPDATE`, values)
  ).rows[0];

  if (!order) {
    return { error: { status: 404, message: 'Order not found' } };
  }

  if (order.status !== 'shopping' || !order.shopper_id) {
    return {
      error: {
        status: 409,
        message:
          order.status === 'shopper_accepted' || order.status === 'waiting_for_shopper'
            ? 'Your shopper hasn\'t started yet - use Add items on the order page'
            : 'Items can only be added while your shopper is shopping',
      },
    };
  }

  return { order };
};

// Prices new items exactly like checkout; only lines from the order's
// own, not-yet-checked-out shops
const priceNewItems = async (client, order, items) => {
  const quote = await buildQuote({
    // Only the item lines are used: keep the order's delivery fee
    // (no route lookup)
    savedDelivery: order.vehicle_fees
      ? { vehicleFees: order.vehicle_fees, pricing: order.delivery_pricing }
      : null,
    customerId: order.customer_id,
    deliveryLatitude: Number(order.delivery_latitude),
    deliveryLongitude: Number(order.delivery_longitude),
    deliveryOption: order.delivery_option,
    scheduledDate: null,
    scheduledStartTime: null,
    scheduledEndTime: null,
    items,
    tipAmount: 0,
    promoCode: null,
  });

  // Slot / distance rules were checked when the order was placed
  const issues = quote.issues.filter(
    (issue) => !['invalid_slot', 'too_far', 'slot_required'].includes(issue.code)
  );

  if (issues.length > 0) {
    return { error: { status: 400, code: 'ORDER_ISSUES', message: issues[0].message, issues } };
  }

  const shops = (
    await client.query('SELECT shop_id, shop_name FROM order_shops WHERE order_id = $1', [order.id])
  ).rows;

  const orderShopIds = shops.map((row) => Number(row.shop_id));
  const closed = await closedShopIds(client, order.id);

  for (const line of quote.lines) {
    if (!orderShopIds.includes(Number(line.shopId))) {
      const names = shops.map((row) => row.shop_name).filter(Boolean);

      return {
        error: {
          status: 400,
          message: `You can only add items from ${names.join(' or ') || 'the stores in this order'}`,
        },
      };
    }

    if (closed.includes(Number(line.shopId))) {
      const name = shops.find((row) => Number(row.shop_id) === Number(line.shopId))?.shop_name;

      return {
        error: {
          status: 409,
          message: `Your shopper has already checked out at ${name || 'this store'}`,
        },
      };
    }
  }

  return { lines: quote.lines };
};

// Order totals with these lines added (delivery, tip and the
// redeemed discount stay; the service fee adds the order's per-unit
// rate for each new unit and the GetMe fee follows - fees.customerTotals)
const totalsWith = async (order, lines) => {
  const added = round2(lines.reduce((sum, line) => sum + (Number(line.lineTotal) || 0), 0));
  const itemsTotal = round2(Number(order.items_total || 0) + added);
  const perUnit = Number(order.service_fee_per_unit ?? 50);
  const fee = round2(Number(order.service_fee || 0) + perUnit * serviceUnits(lines));

  const totals = customerTotals({
    itemsTotal,
    deliveryFee: order.delivery_fee,
    fastFee: order.fast_delivery_fee,
    serviceFee: fee,
    discount: order.discount_amount,
    windowDiscount: order.window_discount,
    tip: order.tip_amount,
    percent: order.getme_fee_percent ?? 15,
  });

  return {
    added,
    itemsTotal,
    serviceFee: fee,
    getmeFee: totals.getmeFee,
    offerSavings: round2(
      Number(order.offer_savings || 0) +
        lines.reduce((sum, line) => sum + (Number(line.savings) || 0), 0)
    ),
    totalAmount: totals.totalAmount,
  };
};

// What each line adds to the total, in order (sums to the whole
// extra); a line's share of the service fee change goes with it
const stepTotals = async (order, lines) => {
  const steps = [];
  let running = order;

  for (const line of lines) {
    const next = await totalsWith(running, [line]);

    steps.push(round2(next.totalAmount - Number(running.total_amount)));
    running = {
      ...running,
      items_total: next.itemsTotal,
      service_fee: next.serviceFee,
      getme_fee: next.getmeFee,
      total_amount: next.totalAmount,
    };
  }

  return steps;
};

const insertRequest = (client, order, line, requestedBy, { approvedCharge = null, note = null }) =>
  client.query(
    `
    INSERT INTO order_item_requests (
      order_id, shop_id, requested_by, product_id, item_name, item_image,
      quantity, unit, line, line_total, approved_charge, note
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
    `,
    [
      order.id,
      line.shopId,
      requestedBy,
      line.custom ? null : line.productId,
      String(line.name || 'Item').slice(0, 255),
      line.image || null,
      line.quantity,
      line.unit || null,
      JSON.stringify(line),
      round2(line.lineTotal || 0),
      approvedCharge,
      note ? String(note).trim().slice(0, 300) || null : null,
    ]
  );

// =====================================================
// ACCEPT (inside a transaction, order row locked)
// Inserts the line, raises the totals and, for saved-card orders,
// charges the extra (never more than maxCharge when given).
// -> { request, order } or { error } (the caller rolls back)
// =====================================================

const acceptRequest = async ({ client, order, request, maxCharge = null, req }) => {
  const line = request.line;
  const totals = await totalsWith(order, [line]);
  const charge = await extraChargeFor(client, order, totals.totalAmount);

  let payment = null;

  if (charge.cardPaid && charge.extra > 0) {
    const amount = maxCharge != null ? Math.min(charge.extra, Number(maxCharge)) : charge.extra;

    if (amount > 0.009) {
      const outcome = await chargeOrderExtra({
        order,
        charge: { ...charge, extra: round2(amount) },
        items: `GetMe order #${order.id} - ${request.item_name}`,
        baseUrl: publicBaseUrl(req),
        io: req.app.get('io'),
      });

      if (outcome.error) {
        return { error: outcome.error };
      }

      payment = outcome.row;
    }
  }

  const inserted = await insertOrderLine(client, order.id, line);
  const orderItemId = inserted.rows[0]?.id ?? null;

  await client.query('UPDATE order_items SET added_by = $2 WHERE id = $1', [
    orderItemId,
    request.requested_by,
  ]);

  const updatedOrder = (
    await client.query(
      `
      UPDATE orders
      SET items_total = $2, service_fee = $3, total_amount = $4, offer_savings = $5,
        getme_fee = $6, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        order.id,
        totals.itemsTotal,
        totals.serviceFee,
        totals.totalAmount,
        totals.offerSavings,
        totals.getmeFee,
      ]
    )
  ).rows[0];

  if (charge.cardPaid) {
    await syncOrderPaymentColumns(client, order.id);
  }

  const updatedRequest = (
    await client.query(
      `
      UPDATE order_item_requests
      SET status = 'accepted', order_item_id = $2, resolved_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [request.id, orderItemId]
    )
  ).rows[0];

  return { request: updatedRequest, order: updatedOrder, payment };
};

// Runs work in a transaction; a card charge taken inside it is
// refunded if the transaction doesn't commit
const inTransaction = async (req, work) => {
  const client = await pool.connect();
  const state = { payment: null };

  try {
    await client.query('BEGIN');

    const result = await work(client, state);

    await client.query(result?.commit ? 'COMMIT' : 'ROLLBACK');

    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (state.payment) {
      await refundWholePayment(state.payment.id, 'Extra item was not added', req.app.get('io'));
    }

    throw error;
  } finally {
    client.release();
  }
};

// After an accepted item: both apps reload the order
const announceAccepted = async (req, order, request) => {
  const io = req.app.get('io');

  emitRequest(io, order, 'order-item-request-updated', {
    request: toPublicRequest(request),
    totals: orderTotals(order),
  });

  // Existing listeners: the customer's order page and the shopper's
  // batch reload on these
  io?.to(`customer:${order.customer_id}`).emit('order-items-added', {
    orderId: Number(order.id),
    addedCount: 1,
    totalAmount: Number(order.total_amount),
  });

  io?.to(`shopper:${order.shopper_id}`).emit('order-status-changed', {
    orderId: Number(order.id),
    order_id: Number(order.id),
    status: order.status,
    reason: 'items_added',
  });

  await postChatEvent({
    io,
    orderId: order.id,
    eventType: 'item_request_accepted',
    data: { itemName: request.item_name, requestedBy: request.requested_by },
    onceKey: `item-request:${request.id}`,
  });

  // Card charged less than the new total (rare): nothing to refund,
  // but a lower total after refunds is settled here
  reconcileInBackground(order.id, { io });
};

const listFor = async (orderId) =>
  (
    await pool.query(
      'SELECT * FROM order_item_requests WHERE order_id = $1 ORDER BY id',
      [orderId]
    )
  ).rows.map(toPublicRequest);

const sendError = (res, error, fallback) => {
  console.error(`❌ ${fallback}:`, error?.message || error);

  return res.status(500).json({ success: false, message: fallback });
};

// =====================================================
// CUSTOMER
// =====================================================

// GET /api/customer/orders/:orderId/item-requests
const customerListRequests = async (req, res) => {
  const orderId = toId(req.params.orderId);

  try {
    const owns = await pool.query('SELECT 1 FROM orders WHERE id = $1 AND customer_id = $2', [
      orderId,
      req.customer.customerId,
    ]);

    if (owns.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    return res.json({ success: true, requests: await listFor(orderId) });
  } catch (error) {
    return sendError(res, error, 'Unable to load item requests');
  }
};

// POST /api/customer/orders/:orderId/item-requests
// body: { items: [same shape as createOrder items], note?,
//         confirm: false -> preview { addedTotal, newTotal, cardCharge, card }
//         confirm: true  -> send to the shopper; expectedTotal (the
//                           preview's newTotal) must still match;
//         authorizeCharge -> saved-card orders: preview.cardCharge }
const customerRequestItems = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const confirm = req.body?.confirm === true;

  if (!orderId) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  if (items.length === 0 || items.length > MAX_ITEMS_PER_REQUEST) {
    return res.status(400).json({
      success: false,
      message: `Choose between 1 and ${MAX_ITEMS_PER_REQUEST} items to add`,
    });
  }

  try {
    const outcome = await inTransaction(req, async (client) => {
      const { order, error } = await lockShoppingOrder(client, 'id = $1 AND customer_id = $2', [
        orderId,
        req.customer.customerId,
      ]);

      if (error) {
        return { status: error.status, body: { success: false, message: error.message } };
      }

      const priced = await priceNewItems(client, order, items);

      if (priced.error) {
        return {
          status: priced.error.status,
          body: { success: false, code: priced.error.code, message: priced.error.message, issues: priced.error.issues },
        };
      }

      const totals = await totalsWith(order, priced.lines);
      const charge = await extraChargeFor(client, order, totals.totalAmount);

      const preview = {
        currentTotal: round2(order.total_amount),
        addedTotal: totals.added,
        newTotal: totals.totalAmount,
        addedCount: priced.lines.length,
        hasCustomItems: priced.lines.some((line) => line.custom),
        cardCharge: charge.extra,
        card: charge.cardPaid ? charge.card : null,
      };

      if (!confirm) {
        return { status: 200, body: { success: true, preview } };
      }

      const expectedTotal = Number(req.body?.expectedTotal);

      if (Number.isFinite(expectedTotal) && Math.abs(expectedTotal - totals.totalAmount) > 0.009) {
        return {
          status: 409,
          body: {
            success: false,
            code: 'PRICE_CHANGED',
            message: `The new total would be Rs ${totals.totalAmount.toFixed(2)}. Please review and confirm.`,
            preview,
          },
        };
      }

      if (charge.extra > 0 && !chargeApproved(req.body, charge)) {
        return { reply: () => chargeApprovalNeeded(res, charge, 'Adding these items') };
      }

      // Each line carries its own share of the approved charge
      const steps = charge.cardPaid ? await stepTotals(order, priced.lines) : [];
      const rows = [];

      for (const [index, line] of priced.lines.entries()) {
        rows.push(
          (
            await insertRequest(client, order, line, 'customer', {
              approvedCharge: charge.cardPaid ? Math.max(0, steps[index]) : null,
              note: req.body?.note,
            })
          ).rows[0]
        );
      }

      return { commit: true, order, rows, status: 201, body: { success: true, preview } };
    });

    if (outcome.reply) {
      return outcome.reply();
    }

    if (outcome.commit) {
      const io = req.app.get('io');
      const { order, rows } = outcome;

      rows.forEach((row) =>
        emitRequest(io, order, 'order-item-request', { request: toPublicRequest(row) })
      );

      createShopperNotification({
        io,
        shopperId: order.shopper_id,
        type: 'item_request',
        title: rows.length === 1 ? 'Customer wants 1 more item' : `Customer wants ${rows.length} more items`,
        body: rows.map((row) => `${row.item_name} × ${Number(row.quantity)}`).join(', '),
        orderId: order.id,
      });

      await postChatEvent({
        io,
        orderId: order.id,
        eventType: 'item_requested',
        data: { count: rows.length, itemName: rows[0]?.item_name },
      });

      outcome.body.requests = rows.map(toPublicRequest);
      outcome.body.message =
        rows.length === 1 ? 'Sent to your shopper' : `${rows.length} items sent to your shopper`;
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return sendError(res, error, 'Could not send the items to your shopper');
  }
};

// Customer answers an item the shopper added
// POST /api/customer/orders/:orderId/item-requests/:requestId/approve
//      { authorizeCharge } (saved-card orders: 402 until it matches)
// POST /api/customer/orders/:orderId/item-requests/:requestId/decline
// POST /api/customer/orders/:orderId/item-requests/:requestId/cancel
//      (withdraw the customer's own request before the shopper answers)
const customerAnswer = (action) => async (req, res) => {
  const orderId = toId(req.params.orderId);
  const requestId = toId(req.params.requestId);

  if (!orderId || !requestId) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }

  try {
    const outcome = await inTransaction(req, async (client, state) => {
      const order = (
        await client.query('SELECT * FROM orders WHERE id = $1 AND customer_id = $2 FOR UPDATE', [
          orderId,
          req.customer.customerId,
        ])
      ).rows[0];

      if (!order) {
        return { status: 404, body: { success: false, message: 'Order not found' } };
      }

      const request = (
        await client.query(
          'SELECT * FROM order_item_requests WHERE id = $1 AND order_id = $2 FOR UPDATE',
          [requestId, orderId]
        )
      ).rows[0];

      const ownSide = action === 'cancel' ? 'customer' : 'shopper';

      if (!request || request.requested_by !== ownSide) {
        return { status: 404, body: { success: false, message: 'Request not found' } };
      }

      if (request.status !== 'pending') {
        return {
          status: 409,
          body: { success: false, message: 'This item has already been answered', request: toPublicRequest(request) },
        };
      }

      if (action !== 'approve') {
        const updated = (
          await client.query(
            `
            UPDATE order_item_requests
            SET status = $2, reject_reason = $3, resolved_at = NOW()
            WHERE id = $1
            RETURNING *
            `,
            [requestId, action === 'cancel' ? 'cancelled' : 'rejected', action === 'cancel' ? 'Cancelled by customer' : 'Declined by customer']
          )
        ).rows[0];

        return { commit: true, order, request: updated, status: 200, body: { success: true } };
      }

      if (order.status !== 'shopping') {
        return { status: 409, body: { success: false, message: 'Shopping has finished, so this item can no longer be added' } };
      }

      // The customer sees the cost; a saved card needs the approval
      const totals = await totalsWith(order, [request.line]);
      const charge = await extraChargeFor(client, order, totals.totalAmount);

      if (charge.extra > 0 && !chargeApproved(req.body, charge)) {
        return { reply: () => chargeApprovalNeeded(res, charge, `Adding ${request.item_name}`) };
      }

      const accepted = await acceptRequest({ client, order, request, req });

      if (accepted.error) {
        return {
          status: accepted.error.status,
          body: { success: false, code: accepted.error.code, message: accepted.error.message },
        };
      }

      state.payment = accepted.payment;

      return {
        commit: true,
        accepted: true,
        order: accepted.order,
        request: accepted.request,
        status: 200,
        body: { success: true, message: `${request.item_name} added`, totals: orderTotals(accepted.order) },
      };
    });

    if (outcome.reply) {
      return outcome.reply();
    }

    if (outcome.commit) {
      if (outcome.accepted) {
        await announceAccepted(req, outcome.order, outcome.request);
      } else {
        const io = req.app.get('io');

        emitRequest(io, outcome.order, 'order-item-request-updated', {
          request: toPublicRequest(outcome.request),
        });

        if (action === 'decline') {
          createShopperNotification({
            io,
            shopperId: outcome.order.shopper_id,
            type: 'item_request',
            title: 'Customer declined an item',
            body: `${outcome.request.item_name} won't be added`,
            orderId: outcome.order.id,
          });
        }
      }

      outcome.body.request = toPublicRequest(outcome.request);
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return sendError(res, error, 'Could not update the item');
  }
};

// =====================================================
// SHOPPER
// =====================================================

const shopperIdOf = (req) => Number(req.shopper?.shopperId ?? req.shopper?.id);

// GET /api/shopper/orders/:orderId/item-requests
const shopperListRequests = async (req, res) => {
  const orderId = toId(req.params.orderId);

  try {
    const owns = await pool.query('SELECT 1 FROM orders WHERE id = $1 AND shopper_id = $2', [
      orderId,
      shopperIdOf(req),
    ]);

    if (owns.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found for this shopper' });
    }

    return res.json({ success: true, requests: await listFor(orderId) });
  } catch (error) {
    return sendError(res, error, 'Unable to load item requests');
  }
};

// POST /api/shopper/orders/:orderId/item-requests
// body: { productId, shopId, quantity, amount?, selectedUnit?, note? }
// The customer asked for something not on the list (chat): the
// shopper adds it; the customer approves the cost.
const shopperProposeItem = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const item = {
    productId: toId(req.body?.productId),
    shopId: toId(req.body?.shopId),
    quantity: Number(req.body?.quantity) || 1,
    amount: req.body?.amount,
    selectedUnit: req.body?.selectedUnit,
  };

  if (!orderId || !item.productId || !item.shopId) {
    return res.status(400).json({ success: false, message: 'Choose a product from this store' });
  }

  try {
    const outcome = await inTransaction(req, async (client) => {
      const { order, error } = await lockShoppingOrder(client, 'id = $1 AND shopper_id = $2', [
        orderId,
        shopperIdOf(req),
      ]);

      if (error) {
        return { status: error.status, body: { success: false, message: error.message } };
      }

      const priced = await priceNewItems(client, order, [item]);

      if (priced.error) {
        return { status: priced.error.status, body: { success: false, message: priced.error.message } };
      }

      const row = (
        await insertRequest(client, order, priced.lines[0], 'shopper', { note: req.body?.note })
      ).rows[0];

      return { commit: true, order, row, status: 201, body: { success: true } };
    });

    if (outcome.commit) {
      emitRequest(req.app.get('io'), outcome.order, 'order-item-request', {
        request: toPublicRequest(outcome.row),
      });

      await postChatEvent({
        io: req.app.get('io'),
        orderId,
        eventType: 'item_proposed',
        data: { itemName: outcome.row.item_name },
      });

      outcome.body.request = toPublicRequest(outcome.row);
      outcome.body.message = 'Sent to the customer to approve';
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return sendError(res, error, 'Could not add the item');
  }
};

// POST /api/shopper/orders/:orderId/item-requests/:requestId/accept
// POST /api/shopper/orders/:orderId/item-requests/:requestId/reject { reason? }
// POST /api/shopper/orders/:orderId/item-requests/:requestId/cancel
//      (withdraw the shopper's own suggestion)
const shopperAnswer = (action) => async (req, res) => {
  const orderId = toId(req.params.orderId);
  const requestId = toId(req.params.requestId);

  if (!orderId || !requestId) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }

  try {
    const outcome = await inTransaction(req, async (client, state) => {
      const order = (
        await client.query('SELECT * FROM orders WHERE id = $1 AND shopper_id = $2 FOR UPDATE', [
          orderId,
          shopperIdOf(req),
        ])
      ).rows[0];

      if (!order) {
        return { status: 404, body: { success: false, message: 'Order not found for this shopper' } };
      }

      const request = (
        await client.query(
          'SELECT * FROM order_item_requests WHERE id = $1 AND order_id = $2 FOR UPDATE',
          [requestId, orderId]
        )
      ).rows[0];

      const ownSide = action === 'cancel' ? 'shopper' : 'customer';

      if (!request || request.requested_by !== ownSide) {
        return { status: 404, body: { success: false, message: 'Request not found' } };
      }

      if (request.status !== 'pending') {
        return {
          status: 409,
          body: { success: false, message: 'This request has already been answered', request: toPublicRequest(request) },
        };
      }

      if (action === 'accept') {
        if (order.status !== 'shopping') {
          return { status: 409, body: { success: false, message: 'Shopping has finished for this order' } };
        }

        const accepted = await acceptRequest({
          client,
          order,
          request,
          maxCharge: request.approved_charge,
          req,
        });

        // Customer's card declined: the request is closed, not added
        if (accepted.error) {
          const rejected = (
            await client.query(
              `
              UPDATE order_item_requests
              SET status = 'rejected', reject_reason = $2, resolved_at = NOW()
              WHERE id = $1
              RETURNING *
              `,
              [requestId, 'Customer payment declined']
            )
          ).rows[0];

          return {
            commit: true,
            order,
            request: rejected,
            declined: true,
            status: 402,
            body: {
              success: false,
              code: 'CARD_DECLINED',
              message: "The customer's card was declined, so the item wasn't added. The customer has been told.",
            },
          };
        }

        state.payment = accepted.payment;

        return {
          commit: true,
          accepted: true,
          order: accepted.order,
          request: accepted.request,
          status: 200,
          body: { success: true, message: `${request.item_name} added to the list`, totals: orderTotals(accepted.order) },
        };
      }

      const reason =
        action === 'cancel'
          ? 'Withdrawn by shopper'
          : String(req.body?.reason || '').trim().slice(0, 200) || 'Not available in store';

      const updated = (
        await client.query(
          `
          UPDATE order_item_requests
          SET status = $2, reject_reason = $3, resolved_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [requestId, action === 'cancel' ? 'cancelled' : 'rejected', reason]
        )
      ).rows[0];

      return { commit: true, order, request: updated, status: 200, body: { success: true } };
    });

    if (outcome.commit) {
      const io = req.app.get('io');

      if (outcome.accepted) {
        await announceAccepted(req, outcome.order, outcome.request);
      } else {
        emitRequest(io, outcome.order, 'order-item-request-updated', {
          request: toPublicRequest(outcome.request),
        });

        if (action === 'reject' || outcome.declined) {
          await postChatEvent({
            io,
            orderId,
            eventType: 'item_request_rejected',
            data: { itemName: outcome.request.item_name, reason: outcome.request.reject_reason },
            onceKey: `item-request:${outcome.request.id}`,
          });
        }
      }

      outcome.body.request = toPublicRequest(outcome.request);
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return sendError(res, error, 'Could not update the request');
  }
};

module.exports = {
  pendingRequestsFor,
  pendingRequestsBlock,
  customerListRequests,
  customerRequestItems,
  customerApproveItem: customerAnswer('approve'),
  customerDeclineItem: customerAnswer('decline'),
  customerCancelRequest: customerAnswer('cancel'),
  shopperListRequests,
  shopperProposeItem,
  shopperAcceptRequest: shopperAnswer('accept'),
  shopperRejectRequest: shopperAnswer('reject'),
  shopperCancelRequest: shopperAnswer('cancel'),
};
