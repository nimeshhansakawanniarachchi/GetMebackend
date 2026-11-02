// =====================================================
// PHASE 59: CLOTHING RETURNS + MERCHANT SETTLEMENTS
// Customer: POST /merchant-orders/:id/returns, .../cancel
// Shop:     GET /merchant-returns, PATCH /merchant-returns/:id
//           GET /merchant-settlements
// Flow: requested -> approved | rejected -> received (item back at
// the store) -> refund_pending -> refunded.
// Card orders are refunded on "received" through the existing card
// refund path (paymentService.refundOrderAmount: PayHere refund,
// recorded in card_payment_refunds) - marked refunded only when that
// succeeds. Cash orders wait for an admin to record the refund.
// =====================================================

const { pool, round2, toId, fail, text } = require('./common');
const { toReturn, returnWindowDays } = require('./merchantOrders');
const { refundOrderAmount } = require('../payments/paymentService');

const REASONS = ['wrong_size', 'wrong_item', 'damaged', 'not_as_described', 'changed_mind', 'other'];
const OPEN = ['requested', 'approved', 'received', 'refund_pending'];

const readPhotos = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 4) return undefined;
  const out = [];
  for (const url of value) {
    const match = String(url || '').match(/\/uploads\/(items|order-media)\/([A-Za-z0-9._-]{1,200})(?:\?|$)/);
    if (!match) return undefined;
    out.push(`/uploads/${match[1]}/${match[2]}`);
  }
  return out;
};

const emitReturn = (io, row) => {
  if (!io || !row) return;
  io.to(`shop:${row.shop_id}`).emit('merchant-return-updated', { returnId: Number(row.id), orderId: Number(row.order_id), status: row.status });
  io.to(`customer:${row.customer_id}`).emit('order-status-changed', { orderId: Number(row.order_id), order_id: Number(row.order_id), returnStatus: row.status });
  require('../realtime').emitToAdmins(io, 'admin:order-updated', { orderId: Number(row.order_id), event: 'merchant-return' });
};

const customerNotify = (row, event, title, body) =>
  pool
    .query(
      `SELECT customer_notify($1, $2, $3, 'refunds', $4, $5, $6, $7, FALSE, $8)`,
      [
        row.customer_id, row.order_id, row.order_item_id, event, title, body,
        JSON.stringify({ orderId: Number(row.order_id), returnId: Number(row.id), status: row.status, businessType: 'clothing' }),
        `return:${row.id}:${row.status}`,
      ]
    )
    .catch((error) => console.error('❌ RETURN NOTIFY:', error.message));

// -----------------------------------------------------
// Customer
// -----------------------------------------------------

const createReturn = async (req, res) => {
  const customerId = Number(req.customer.customerId);
  const orderId = toId(req.params.orderId);
  const itemId = toId(req.body?.orderItemId);
  const quantity = Number(req.body?.quantity);
  const reasonCode = REASONS.includes(req.body?.reasonCode) ? req.body.reasonCode : null;
  const reasonText = text(req.body?.reasonText, 500);
  const photos = readPhotos(req.body?.photoUrls);
  const requestId = /^[A-Za-z0-9_-]{8,64}$/.test(String(req.body?.requestId || '')) ? String(req.body.requestId) : null;

  if (!reasonCode) return fail(res, 400, 'Choose why you are returning this item', 'REASON_REQUIRED');
  if (reasonCode === 'other' && !reasonText) return fail(res, 400, 'Tell the store what is wrong', 'REASON_REQUIRED');
  if (photos === undefined) return fail(res, 400, 'Upload up to 4 photos through the app', 'BAD_PHOTO');
  if (!Number.isInteger(quantity) || quantity < 1) return fail(res, 400, 'Choose how many to return', 'BAD_QUANTITY');

  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN');
    if (requestId) {
      const earlier = (await client.query('SELECT * FROM merchant_return_requests WHERE customer_id = $1 AND client_request_id = $2', [customerId, requestId])).rows[0];
      if (earlier) {
        await client.query('ROLLBACK');
        return res.status(200).json({ success: true, duplicate: true, returnRequest: toReturn(earlier) });
      }
    }
    const order = (
      await client.query(`SELECT * FROM orders WHERE id = $1 AND customer_id = $2 AND business_type <> 'grocery' FOR UPDATE`, [orderId, customerId])
    ).rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Order not found', 'NOT_FOUND');
    }
    if (order.business_type !== 'clothing') {
      await client.query('ROLLBACK');
      return fail(res, 400, 'Returns are for clothing orders. For a food problem, contact GetMe support.', 'NOT_RETURNABLE');
    }
    if (order.status !== 'delivered') {
      await client.query('ROLLBACK');
      return fail(res, 409, 'You can ask for a return after the order is delivered.', 'ORDER_STATE');
    }
    const days = await returnWindowDays('clothing', client);
    if (!order.delivered_at || new Date(order.delivered_at).getTime() + days * 86400000 < Date.now()) {
      await client.query('ROLLBACK');
      return fail(res, 409, `Returns can be requested within ${days} days of delivery.`, 'RETURN_WINDOW_CLOSED');
    }
    const item = (await client.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [itemId, orderId])).rows[0];
    if (!item) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Item not found on this order', 'NOT_FOUND');
    }
    const left = Number(item.quantity) - Number(item.returned_quantity || 0);
    if (quantity > left) {
      await client.query('ROLLBACK');
      return fail(res, 400, left > 0 ? `You can return up to ${left}` : 'This item was already returned', 'BAD_QUANTITY');
    }
    row = (
      await client.query(
        `INSERT INTO merchant_return_requests (order_id, order_item_id, customer_id, shop_id, quantity, reason_code, reason_text, photo_urls, client_request_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [orderId, itemId, customerId, order.shop_id, quantity, reasonCode, reasonText, JSON.stringify(photos), requestId]
      )
    ).rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return fail(res, 409, 'There is already an open return for this item.', 'RETURN_OPEN');
    console.error('❌ CREATE RETURN ERROR:', error.message);
    return fail(res, 500, "Couldn't send the return request. Please try again.");
  } finally {
    client.release();
  }

  const full = (await pool.query(
    'SELECT r.*, oi.item_name, oi.variant_label FROM merchant_return_requests r JOIN order_items oi ON oi.id = r.order_item_id WHERE r.id = $1', [row.id]
  )).rows[0];
  emitReturn(req.app.get('io'), full);
  require('../admin/notifications').notify({
    category: 'support',
    event: 'return.requested',
    severity: 'info',
    title: `Return requested · order #${orderId}`,
    body: `${full.item_name}${full.variant_label ? ` (${full.variant_label})` : ''} x${quantity}: ${reasonCode.replace(/_/g, ' ')}`,
    entityType: 'order',
    entityId: orderId,
    permissions: ['orders.view'],
    dedupe: `return.requested:${row.id}`,
  });
  return res.status(201).json({ success: true, returnRequest: toReturn(full) });
};

const cancelReturn = async (req, res) => {
  try {
    const row = (
      await pool.query(
        `UPDATE merchant_return_requests SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1 AND order_id = $2 AND customer_id = $3 AND status = 'requested' RETURNING *`,
        [toId(req.params.returnId), toId(req.params.orderId), Number(req.customer.customerId)]
      )
    ).rows[0];
    if (!row) return fail(res, 409, 'This return can no longer be cancelled.', 'ORDER_STATE');
    emitReturn(req.app.get('io'), row);
    return res.json({ success: true, returnRequest: toReturn(row) });
  } catch (error) {
    console.error('❌ CANCEL RETURN ERROR:', error.message);
    return fail(res, 500, "Couldn't cancel the return.");
  }
};

// -----------------------------------------------------
// Refund once the item is back
// -----------------------------------------------------

// Adds a completed refund to the order line + merchant settlement
const applyRefundToBooks = async (client, ret, amount) => {
  await client.query(
    'UPDATE order_items SET returned_quantity = returned_quantity + $2, refund_amount = COALESCE(refund_amount, 0) + $3, refunded_at = NOW() WHERE id = $1',
    [ret.order_item_id, ret.quantity, amount]
  );
  await client.query(
    // Recomputed from the parts (right-hand side = values before the update):
    // commission on what the customer kept, net = items - refunds - commission
    `UPDATE merchant_settlements SET
            refunds_amount = refunds_amount + $2,
            commission_amount = GREATEST(0, ROUND((items_total - refunds_amount - $2) * commission_percent / 100, 2)),
            net_amount = items_total - refunds_amount - $2 - GREATEST(0, ROUND((items_total - refunds_amount - $2) * commission_percent / 100, 2)),
            updated_at = NOW()
     WHERE order_id = $1`,
    [ret.order_id, amount]
  );
};

const refundAmountFor = async (client, ret) => {
  const item = (await client.query('SELECT unit_price, price, quantity, line_total FROM order_items WHERE id = $1', [ret.order_item_id])).rows[0];
  const unit = Number(item.unit_price ?? item.price);
  return round2(unit * Number(ret.quantity));
};

// -----------------------------------------------------
// Shop
// -----------------------------------------------------

const listShopReturns = async (req, res) => {
  try {
    const shopId = Number(req.shop.shopId);
    const status = OPEN.concat(['rejected', 'refunded', 'cancelled']).includes(req.query.status) ? req.query.status : null;
    const rows = (
      await pool.query(
        `SELECT r.*, oi.item_name, oi.variant_label, split_part(btrim(COALESCE(c.full_name, '')), ' ', 1) AS customer_first_name
         FROM merchant_return_requests r
         JOIN order_items oi ON oi.id = r.order_item_id
         LEFT JOIN customers c ON c.id = r.customer_id
         WHERE r.shop_id = $1 AND ($2::text IS NULL OR r.status = $2)
         ORDER BY (r.status IN ('requested', 'approved')) DESC, r.id DESC LIMIT 200`,
        [shopId, status]
      )
    ).rows;
    const counts = Object.fromEntries(
      (await pool.query('SELECT status, COUNT(*)::int AS n FROM merchant_return_requests WHERE shop_id = $1 GROUP BY status', [shopId])).rows.map((r) => [r.status, Number(r.n)])
    );
    return res.json({ success: true, returns: rows.map(toReturn), counts });
  } catch (error) {
    console.error('❌ SHOP RETURNS ERROR:', error.message);
    return fail(res, 500, "Couldn't load returns.");
  }
};

const decideReturn = async (req, res) => {
  const shopId = Number(req.shop.shopId);
  const action = req.body?.action;
  const note = text(req.body?.note, 500);
  if (!['approve', 'reject', 'received'].includes(action)) return fail(res, 400, 'Choose approve, reject or received', 'VALIDATION');
  if (action === 'reject' && !note) return fail(res, 400, 'Tell the customer why the return is rejected', 'REASON_REQUIRED');

  const client = await pool.connect();
  let ret;
  let order;
  let refund = null;
  try {
    await client.query('BEGIN');
    ret = (await client.query('SELECT * FROM merchant_return_requests WHERE id = $1 AND shop_id = $2 FOR UPDATE', [toId(req.params.id), shopId])).rows[0];
    if (!ret) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Return not found', 'NOT_FOUND');
    }
    const from = { approve: ['requested'], reject: ['requested'], received: ['approved'] }[action];
    if (!from.includes(ret.status)) {
      await client.query('ROLLBACK');
      return fail(res, 409, action === 'received' ? 'Approve the return before marking the item received.' : 'This return was already answered.', 'ORDER_STATE');
    }
    order = (await client.query('SELECT * FROM orders WHERE id = $1', [ret.order_id])).rows[0];

    if (action === 'approve' || action === 'reject') {
      ret = (
        await client.query(
          `UPDATE merchant_return_requests SET status = $2, merchant_note = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
          [ret.id, action === 'approve' ? 'approved' : 'rejected', note]
        )
      ).rows[0];
    } else {
      const amount = await refundAmountFor(client, ret);
      ret = (
        await client.query(
          `UPDATE merchant_return_requests SET status = 'refund_pending', received_at = NOW(), refund_amount = $2,
                  refund_method = $3, merchant_note = COALESCE($4, merchant_note), updated_at = NOW() WHERE id = $1 RETURNING *`,
          [ret.id, amount, order.payment_method === 'card' ? 'card' : null, note]
        )
      ).rows[0];
      if (order.payment_method === 'card') refund = amount;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ RETURN DECISION ERROR:', error.message);
    return fail(res, 500, "Couldn't update the return.");
  } finally {
    client.release();
  }

  const io = req.app.get('io');

  // Card refund through the existing order refund path; recorded as
  // refunded only once the provider refund succeeded
  if (refund != null && refund > 0) {
    const outcome = await refundOrderAmount(ret.order_id, refund, `GetMe order #${ret.order_id}: item returned`, io);
    if (!outcome?.error) {
      const c2 = await pool.connect();
      try {
        await c2.query('BEGIN');
        ret = (await c2.query(
          `UPDATE merchant_return_requests SET status = 'refunded', refunded_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'refund_pending' RETURNING *`,
          [ret.id]
        )).rows[0] || ret;
        if (ret.status === 'refunded') await applyRefundToBooks(c2, ret, refund);
        await c2.query('COMMIT');
      } catch (error) {
        await c2.query('ROLLBACK').catch(() => {});
        console.error('❌ RETURN BOOKS ERROR:', error.message);
      } finally {
        c2.release();
      }
    } else {
      console.error('❌ RETURN CARD REFUND:', ret.order_id, outcome.error.message);
    }
  }

  const full = (await pool.query(
    'SELECT r.*, oi.item_name, oi.variant_label FROM merchant_return_requests r JOIN order_items oi ON oi.id = r.order_item_id WHERE r.id = $1', [ret.id]
  )).rows[0];

  const titles = {
    approved: ['Return approved', `The store approved returning ${full.item_name}. Hand it back as arranged.`],
    rejected: ['Return not approved', `The store did not approve returning ${full.item_name}${full.merchant_note ? `: ${full.merchant_note}` : '.'}`],
    refund_pending: ['Item received', `The store received ${full.item_name}. Your refund of Rs ${Number(full.refund_amount).toFixed(2)} is being processed.`],
    refunded: ['Refund sent', `Rs ${Number(full.refund_amount).toFixed(2)} for ${full.item_name} was refunded to your card.`],
  };
  if (titles[full.status]) await customerNotify(full, `return.${full.status}`, titles[full.status][0], titles[full.status][1]);
  emitReturn(io, full);
  return res.json({ success: true, returnRequest: toReturn(full) });
};

// Admin: record a manual refund (cash / bank, or a card refund that
// needed a retry) for a return waiting in refund_pending
const recordManualRefund = async ({ returnId, method, reference, adminId, io }) => {
  if (!['cash', 'bank', 'card'].includes(method)) return { error: [400, 'Choose cash, bank or card'] };
  const ref = text(reference, 120);
  if (!ref) return { error: [400, 'Enter the refund reference (receipt or transfer number)'] };
  const client = await pool.connect();
  let ret;
  try {
    await client.query('BEGIN');
    ret = (await client.query('SELECT * FROM merchant_return_requests WHERE id = $1 FOR UPDATE', [returnId])).rows[0];
    if (!ret) {
      await client.query('ROLLBACK');
      return { error: [404, 'Return not found'] };
    }
    if (ret.status !== 'refund_pending') {
      await client.query('ROLLBACK');
      return { error: [409, 'Only returns waiting for a refund can be marked refunded'] };
    }
    const amount = Number(ret.refund_amount) || (await refundAmountFor(client, ret));
    ret = (
      await client.query(
        `UPDATE merchant_return_requests SET status = 'refunded', refund_method = $2, refund_reference = $3, refunded_by_admin_id = $4,
                refunded_at = NOW(), refund_amount = $5, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [ret.id, method, ref, adminId || null, amount]
      )
    ).rows[0];
    await applyRefundToBooks(client, ret, amount);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ MANUAL REFUND ERROR:', error.message);
    return { error: [500, "Couldn't record the refund"] };
  } finally {
    client.release();
  }
  const full = (await pool.query(
    'SELECT r.*, oi.item_name, oi.variant_label FROM merchant_return_requests r JOIN order_items oi ON oi.id = r.order_item_id WHERE r.id = $1', [ret.id]
  )).rows[0];
  await customerNotify(full, 'return.refunded', 'Refund recorded', `Rs ${Number(full.refund_amount).toFixed(2)} for ${full.item_name} was refunded (${method}).`);
  emitReturn(io, full);
  return { returnRequest: toReturn(full) };
};

// -----------------------------------------------------
// Settlements (shop view)
// -----------------------------------------------------

const settlementStatus = (row) => (row.status === 'pending' && new Date(row.payable_after) <= new Date() ? 'payable' : row.status);

const toSettlement = (row) => ({
  id: Number(row.id),
  orderId: Number(row.order_id),
  shopId: Number(row.shop_id),
  shopName: row.shop_name || undefined,
  businessType: row.business_type,
  itemsTotal: round2(row.items_total),
  commissionPercent: Number(row.commission_percent),
  commissionAmount: round2(row.commission_amount),
  refundsAmount: round2(row.refunds_amount),
  // Phase 60: store-delivery fee paid to the store
  deliveryFee: round2(row.delivery_fee),
  netAmount: round2(row.net_amount),
  status: settlementStatus(row),
  payableAfter: row.payable_after,
  paidAt: row.paid_at || null,
  paidReference: row.paid_reference || null,
  holdReason: row.hold_reason || null,
  cashCollectedBy: row.cash_collected_by || null,
  createdAt: row.created_at,
});

const totalsOf = (rows) => {
  const totals = { pending: 0, payable: 0, paid: 0, held: 0, merchantOwes: 0 };
  for (const row of rows) {
    const s = toSettlement(row);
    // Cash collected by the store at pickup: the store owes GetMe the commission
    if (s.cashCollectedBy === 'merchant' && s.status !== 'paid') {
      totals.merchantOwes = round2(totals.merchantOwes + s.commissionAmount);
      continue;
    }
    totals[s.status] = round2((totals[s.status] || 0) + s.netAmount);
  }
  return totals;
};

const listShopSettlements = async (req, res) => {
  try {
    const rows = (await pool.query('SELECT * FROM merchant_settlements WHERE shop_id = $1 ORDER BY id DESC LIMIT 500', [req.shop.shopId])).rows;
    return res.json({ success: true, settlements: rows.map(toSettlement), totals: totalsOf(rows) });
  } catch (error) {
    console.error('❌ SHOP SETTLEMENTS ERROR:', error.message);
    return fail(res, 500, "Couldn't load payments.");
  }
};

module.exports = {
  createReturn,
  cancelReturn,
  listShopReturns,
  decideReturn,
  recordManualRefund,
  listShopSettlements,
  toSettlement,
  totalsOf,
  settlementStatus,
};
