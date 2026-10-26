const pool = require('../config/db');

const { broadcastOrderChange, emitToAdmins } = require('../realtime');
const { readPage, pageMeta } = require('../utils/pagination');
const { createShopperNotification } = require('./shopperNotificationController');
const { pendingRequestsBlock } = require('./orderItemRequestsController');

// =====================================================
// STORE PAYMENTS: the shopper pays the supermarket, GetMe reimburses
// (sql/platform_phase20_store_payments.sql)
//
// Shopper (checkout, one record per order + shop):
//   GET /api/shopper/orders/:orderId/store-payment?shopId=
//       -> { payment, expectedAmount }
//   PUT /api/shopper/orders/:orderId/store-payment
//       { shopId, method: cash|card|lankaqr, amountPaid, reference?, note? }
//   Saving again updates the same record until the bill photo is
//   uploaded (lockStorePaymentForBill), then it is final.
// Admin:
//   GET   /api/admin/store-payments?status=review|owed|reimbursed
//   PATCH /api/admin/store-payments/:id/review    { action: approve|query, note }
//   PATCH /api/admin/store-payments/:id/reimburse { reference }
//
// Expected amount = the shop's bought items as priced for the
// customer (same rules as the Shopper App's checkout total). A
// difference over the tolerance waits for admin review. Nothing is
// reimbursed before the order is delivered: reimbursement_status is
// 'pending' until then and settlementController.refreshOrderSettlement
// moves it to owed (bill uploaded + approved) or held (review). Order columns actual_items_total and
// reimbursement_* follow these records (admin Payments page).
// =====================================================

const METHODS = ['cash', 'card', 'lankaqr'];

// settlementController requires this file; load it when first used
const settlement = () => require('./settlementController');

const METHOD_LABELS = {
  cash: 'Cash',
  card: 'Card / phone wallet',
  lankaqr: 'LANKAQR',
};

// Bought: found (and confirmed 'done') items and replacements
const BOUGHT_STATUSES = ['done', 'found', 'replaced', 'completed'];

// Not picked yet: an accepted extra item still on the list, or one
// marked not_found but not refunded / replaced (the customer would
// still pay for it: only 'refunded' items are taken off the total)
const UNPICKED_STATUSES = ['', 'pending', 'not_found'];

const WEIGHT_FACTORS = { g: 0.001, ml: 0.001, kg: 1, l: 1 };

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const toId = (value) => {
  const id = Number(value);

  return Number.isInteger(id) && id > 0 ? id : null;
};

// Admin review when |paid - expected| is over the larger of these
const reviewTolerance = (expected) => {
  const fixed = Number(process.env.STORE_PAYMENT_REVIEW_LKR ?? 200);
  const percent = Number(process.env.STORE_PAYMENT_REVIEW_PERCENT ?? 5);

  return round2(Math.max(fixed, (Math.abs(expected) * percent) / 100));
};

// More than this over the expected cost is refused as a typo
const hardLimit = (expected) => round2(expected + Math.max(5000, expected * 0.5));

// Line total for one bought item (ShopperApp utils/pricing getLineTotal)
const lineTotal = (item) => {
  const status = String(item.shopping_status || '').toLowerCase();
  const unitPrice = item.unit_price != null ? Number(item.unit_price) : null;
  const foundWeight = Number(item.found_weight);

  if (foundWeight > 0 && unitPrice !== null) {
    const factor = WEIGHT_FACTORS[String(item.found_weight_unit || 'kg').toLowerCase()] ?? 1;
    return round2(unitPrice * foundWeight * factor);
  }

  const pack =
    status === 'replaced' && item.replacement_product_price != null
      ? Number(item.replacement_product_price)
      : Number(item.price ?? item.unit_price ?? 0);

  const found = Number(item.found_quantity);
  const quantity = found > 0 ? found : Number(item.quantity) > 0 ? Number(item.quantity) : 1;

  return round2(pack * quantity);
};

const shopItems = async (client, orderId, shopId) =>
  (
    await client.query('SELECT * FROM order_items WHERE order_id = $1 AND shop_id = $2', [
      orderId,
      shopId,
    ])
  ).rows;

const expectedFor = (items) =>
  round2(
    items
      .filter((item) => BOUGHT_STATUSES.includes(String(item.shopping_status || '').toLowerCase()))
      .reduce((sum, item) => sum + lineTotal(item), 0)
  );

const toPublic = (row) =>
  row
    ? {
        id: Number(row.id),
        orderId: Number(row.order_id),
        shopId: Number(row.shop_id),
        shopperId: Number(row.shopper_id),
        method: row.method,
        methodLabel: METHOD_LABELS[row.method] || row.method,
        amountPaid: Number(row.amount_paid),
        expectedAmount: Number(row.expected_amount),
        variance: Number(row.variance),
        reference: row.reference,
        note: row.note,
        reviewStatus: row.review_status,
        reviewNote: row.review_note,
        reimbursementStatus: row.reimbursement_status,
        reimbursementReference: row.reimbursement_reference,
        reimbursedAt: row.reimbursed_at,
        locked: Boolean(row.locked_at),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // admin list joins
        shopName: row.shop_name ?? undefined,
        shopperName: row.shopper_name ?? undefined,
        billCount: row.bill_count != null ? Number(row.bill_count) : undefined,
      }
    : null;

// Order-level totals the admin Payments page already shows
const syncOrderReimbursement = async (client, orderId) => {
  const rows = (
    await client.query('SELECT * FROM store_payments WHERE order_id = $1', [orderId])
  ).rows;

  if (rows.length === 0) {
    return;
  }

  const paid = round2(rows.reduce((sum, row) => sum + Number(row.amount_paid), 0));
  const allReimbursed = rows.every((row) => row.reimbursement_status === 'reimbursed');
  const lastReimbursed = rows
    .map((row) => row.reimbursed_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0];

  await client.query(
    `
    UPDATE orders
    SET
      actual_items_total = $2,
      reimbursement_amount = $2,
      reimbursement_status = $3,
      reimbursed_at = $4,
      updated_at = NOW()
    WHERE id = $1
    `,
    [orderId, paid, allReimbursed ? 'reimbursed' : 'due', allReimbursed ? lastReimbursed : null]
  );
};

const announce = (io, row, event = 'store-payment-updated') => {
  try {
    if (!io || !row) return;

    const payload = { orderId: Number(row.order_id), shopId: Number(row.shop_id), payment: toPublic(row) };

    io.to(`shopper:${row.shopper_id}`).emit(event, payload);
    broadcastOrderChange(io, row.order_id, { event });
    emitToAdmins(io, 'admin:store-payment-updated', payload);
  } catch (error) {
    console.error('❌ STORE PAYMENT SOCKET ERROR:', error.message);
  }
};

const shopperIdOf = (req) => Number(req.shopper?.shopperId ?? req.shopper?.id);

const findShopperOrderShop = async (client, orderId, shopperId, shopId) =>
  (
    await client.query(
      `
      SELECT o.id, o.status, o.customer_id, os.shop_id
      FROM orders o
      INNER JOIN order_shops os ON os.order_id = o.id AND os.shop_id = $3
      WHERE o.id = $1 AND o.shopper_id = $2
      LIMIT 1
      `,
      [orderId, shopperId, shopId]
    )
  ).rows[0] || null;

// =====================================================
// SHOPPER
// =====================================================

const getStorePayment = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const shopId = toId(req.query.shopId);

  if (!orderId || !shopId) {
    return res.status(400).json({ success: false, message: 'Order and shop are required' });
  }

  try {
    if (!(await findShopperOrderShop(pool, orderId, shopperIdOf(req), shopId))) {
      return res.status(404).json({ success: false, message: 'Order not found for this shopper' });
    }

    const row = (
      await pool.query('SELECT * FROM store_payments WHERE order_id = $1 AND shop_id = $2', [orderId, shopId])
    ).rows[0];

    return res.json({
      success: true,
      payment: toPublic(row),
      expectedAmount: expectedFor(await shopItems(pool, orderId, shopId)),
    });
  } catch (error) {
    console.error('❌ GET STORE PAYMENT ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the store payment' });
  }
};

const saveStorePayment = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const shopId = toId(req.body?.shopId);
  const method = String(req.body?.method || '').toLowerCase();
  const amountPaid = round2(req.body?.amountPaid);
  const reference = String(req.body?.reference || '').trim().slice(0, 40) || null;
  const note = String(req.body?.note || '').trim().slice(0, 300) || null;

  if (!orderId || !shopId) {
    return res.status(400).json({ success: false, message: 'Order and shop are required' });
  }

  if (!METHODS.includes(method)) {
    return res.status(400).json({ success: false, message: 'Choose how you paid' });
  }

  if (!(amountPaid > 0)) {
    return res.status(400).json({ success: false, message: 'Enter the amount the till charged' });
  }

  // Never a card number: at most a short reference (last 4 / QR ref)
  if (reference && /\d{12,}/.test(reference.replace(/[\s-]/g, ''))) {
    return res.status(400).json({
      success: false,
      message: 'Enter only the last 4 digits of the card, never the full number',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const order = await findShopperOrderShop(client, orderId, shopperIdOf(req), shopId);

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Order not found for this shopper' });
    }

    if (order.status !== 'shopping') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Shopping has finished for this order' });
    }

    const pendingBlock = await pendingRequestsBlock(orderId, shopId);

    if (pendingBlock) {
      await client.query('ROLLBACK');
      return res.status(409).json(pendingBlock);
    }

    const items = await shopItems(client, orderId, shopId);
    const unpicked = items.filter((item) =>
      UNPICKED_STATUSES.includes(String(item.shopping_status || '').toLowerCase())
    ).length;

    if (unpicked > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        code: 'ITEMS_TO_PICK',
        message:
          unpicked === 1
            ? 'One item is still to pick (or refund). Finish it before paying.'
            : `${unpicked} items are still to pick (or refund). Finish them before paying.`,
      });
    }

    const expected = expectedFor(items);

    if (amountPaid > hardLimit(expected)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        code: 'AMOUNT_TOO_HIGH',
        message: `Rs ${amountPaid.toFixed(2)} is far above the expected Rs ${expected.toFixed(2)}. Check the amount on the bill.`,
      });
    }

    // One record per order + shop; locked once the bill is uploaded
    const existing = (
      await client.query(
        'SELECT * FROM store_payments WHERE order_id = $1 AND shop_id = $2 FOR UPDATE',
        [orderId, shopId]
      )
    ).rows[0];

    if (existing?.locked_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        code: 'ALREADY_RECORDED',
        message: 'This store payment is already final (the bill was uploaded)',
        payment: toPublic(existing),
      });
    }

    const variance = round2(amountPaid - expected);
    const needsReview = Math.abs(variance) > reviewTolerance(expected);

    const row = (
      await client.query(
        `
        INSERT INTO store_payments (
          order_id, shop_id, shopper_id, method, amount_paid, expected_amount,
          variance, reference, note, review_status, reimbursement_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (order_id, shop_id) DO UPDATE SET
          method = EXCLUDED.method,
          amount_paid = EXCLUDED.amount_paid,
          expected_amount = EXCLUDED.expected_amount,
          variance = EXCLUDED.variance,
          reference = EXCLUDED.reference,
          note = EXCLUDED.note,
          review_status = EXCLUDED.review_status,
          reimbursement_status = EXCLUDED.reimbursement_status,
          review_note = NULL,
          reviewed_by = NULL,
          reviewed_at = NULL,
          updated_at = NOW()
        RETURNING *
        `,
        [
          orderId,
          shopId,
          shopperIdOf(req),
          method,
          amountPaid,
          expected,
          variance,
          reference,
          note,
          needsReview ? 'needs_review' : 'ok',
          'pending',
        ]
      )
    ).rows[0];

    await syncOrderReimbursement(client, orderId);
    await client.query('COMMIT');

    announce(req.app.get('io'), row);
    await settlement().refreshOrderSettlement(orderId, req.app.get('io'));

    return res.status(existing ? 200 : 201).json({
      success: true,
      message: needsReview
        ? 'Payment recorded. The amount differs from the expected cost, so GetMe will check the bill before reimbursing you after delivery.'
        : 'Payment recorded. GetMe will reimburse you once the order is delivered.',
      payment: toPublic(row),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ SAVE STORE PAYMENT ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to record the payment' });
  } finally {
    client.release();
  }
};

// Bill upload (shopperPaymentController.uploadBill): the payment must
// be recorded first; the bill makes it final.
// -> { error } (409 reply body) or { row }
const lockStorePaymentForBill = async (orderId, shopId, io) => {
  const row = (
    await pool.query(
      `
      UPDATE store_payments
      SET locked_at = COALESCE(locked_at, NOW()), updated_at = NOW()
      WHERE order_id = $1 AND shop_id = $2
      RETURNING *
      `,
      [orderId, shopId]
    )
  ).rows[0];

  if (!row) {
    return {
      error: {
        success: false,
        code: 'PAYMENT_NOT_RECORDED',
        message: 'Record how much you paid at checkout before uploading the bill',
      },
    };
  }

  announce(io, row);
  await settlement().refreshOrderSettlement(orderId, io);

  return { row };
};

const hasStorePayment = async (orderId, shopId) =>
  (
    await pool.query('SELECT 1 FROM store_payments WHERE order_id = $1 AND shop_id = $2', [orderId, shopId])
  ).rows.length > 0;

// =====================================================
// ADMIN
// =====================================================

const STATUS_FILTERS = {
  review: "sp.review_status IN ('needs_review', 'queried')",
  owed: "sp.reimbursement_status = 'owed'",
  reimbursed: "sp.reimbursement_status = 'reimbursed'",
};

const listStorePayments = async (req, res) => {
  try {
    const paging = readPage(req.query);
    const filter = STATUS_FILTERS[req.query.status] || 'TRUE';

    const [countResult, rowsResult, summaryResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM store_payments sp WHERE ${filter}`),
      pool.query(
        `
        SELECT
          sp.*,
          s.shop_name,
          sh.full_name AS shopper_name,
          (
            SELECT COALESCE(SUM(GREATEST(1, COALESCE(jsonb_array_length(b.bill_urls), 0))), 0)
            FROM order_shop_bills b
            WHERE b.order_id = sp.order_id AND b.shop_id = sp.shop_id
          ) AS bill_count
        FROM store_payments sp
        LEFT JOIN shops s ON s.id = sp.shop_id
        LEFT JOIN shoppers sh ON sh.id = sp.shopper_id
        WHERE ${filter}
        ORDER BY (sp.review_status = 'needs_review') DESC, sp.created_at DESC
        LIMIT $1 OFFSET $2
        `,
        [paging.pageSize, paging.offset]
      ),
      pool.query(
        `
        SELECT
          COALESCE(SUM(amount_paid) FILTER (WHERE reimbursement_status = 'owed'), 0)::float AS owed,
          COALESCE(SUM(amount_paid) FILTER (WHERE reimbursement_status = 'held'), 0)::float AS held,
          COUNT(*) FILTER (WHERE review_status IN ('needs_review', 'queried'))::int AS to_review,
          COALESCE(SUM(amount_paid) FILTER (
            WHERE reimbursement_status = 'reimbursed' AND reimbursed_at >= date_trunc('month', NOW())
          ), 0)::float AS reimbursed_this_month
        FROM store_payments
        `
      ),
    ]);

    return res.json({
      success: true,
      summary: summaryResult.rows[0],
      storePayments: rowsResult.rows.map(toPublic),
      ...pageMeta(paging, countResult.rows[0].total),
    });
  } catch (error) {
    console.error('❌ LIST STORE PAYMENTS ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load store payments' });
  }
};

// approve: the amount is accepted and can be reimbursed
// query: held until the shopper sorts it out (note says why)
const reviewStorePayment = async (req, res) => {
  const id = toId(req.params.id);
  const action = req.body?.action;
  const note = String(req.body?.note || '').trim().slice(0, 300) || null;

  if (!id || !['approve', 'query'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Choose approve or query' });
  }

  if (action === 'query' && !note) {
    return res.status(400).json({ success: false, message: 'Say what needs checking' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const row = (
      await client.query(
        `
        UPDATE store_payments
        SET
          review_status = $2::varchar,
          review_note = $3,
          reviewed_by = $4,
          reviewed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1 AND reimbursement_status <> 'reimbursed'
        RETURNING *
        `,
        [id, action === 'approve' ? 'approved' : 'queried', note, req.admin.adminId]
      )
    ).rows[0];

    if (!row) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Already reimbursed or not found' });
    }

    await syncOrderReimbursement(client, row.order_id);
    await client.query('COMMIT');

    const io = req.app.get('io');
    announce(io, row);

    // Approved: owed / payable once delivered; queried: held
    await settlement().refreshOrderSettlement(row.order_id, io);

    if (action === 'query') {
      createShopperNotification({
        io,
        shopperId: row.shopper_id,
        type: 'store_payment_query',
        title: `Check your bill for order #${row.order_id}`,
        body: note,
        orderId: row.order_id,
      });
    }

    return res.json({
      success: true,
      message:
        action === 'approve'
          ? 'Bill approved. It is reimbursed once the order is delivered.'
          : 'Sent back to the shopper',
      storePayment: toPublic(row),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ REVIEW STORE PAYMENT ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update the payment' });
  } finally {
    client.release();
  }
};

// The bank transfer to the shopper is done (reference from the bank)
const reimburseStorePayment = async (req, res) => {
  const id = toId(req.params.id);
  const reference = String(req.body?.reference || '').trim().slice(0, 60);

  if (!id) {
    return res.status(400).json({ success: false, message: 'Invalid payment' });
  }

  if (reference.length < 3) {
    return res.status(400).json({ success: false, message: 'Enter the bank transfer reference' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const owed = (
      await client.query(
        "SELECT * FROM store_payments WHERE id = $1 AND reimbursement_status = 'owed' FOR UPDATE",
        [id]
      )
    ).rows[0];

    if (!owed) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: 'Only approved payments that are still owed can be marked reimbursed',
      });
    }

    // Every transfer to a shopper is one shopper_payouts row (the
    // ledger's money-out); the same bank reference can't be reused
    let payout;

    try {
      payout = (
        await client.query(
          `
          INSERT INTO shopper_payouts (shopper_id, kind, amount, reference, note, created_by)
          VALUES ($1, 'reimbursement', $2, $3, $4, $5)
          RETURNING id
          `,
          [owed.shopper_id, owed.amount_paid, reference, `Order #${owed.order_id}`, req.admin.adminId]
        )
      ).rows[0];
    } catch (error) {
      if (error.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'This bank reference is already recorded' });
      }

      throw error;
    }

    const row = (
      await client.query(
        `
        UPDATE store_payments
        SET
          reimbursement_status = 'reimbursed',
          reimbursement_reference = $2,
          reimbursed_at = NOW(),
          reimbursed_by = $3,
          payout_id = $4,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [id, reference, req.admin.adminId, payout.id]
      )
    ).rows[0];

    await syncOrderReimbursement(client, row.order_id);
    await client.query('COMMIT');

    const io = req.app.get('io');
    announce(io, row);

    createShopperNotification({
      io,
      shopperId: row.shopper_id,
      type: 'reimbursed',
      title: `Reimbursed Rs ${Number(row.amount_paid).toFixed(2)}`,
      body: `For order #${row.order_id} · transfer ${reference}`,
      orderId: row.order_id,
    });

    return res.json({ success: true, message: 'Marked as reimbursed', storePayment: toPublic(row) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ REIMBURSE STORE PAYMENT ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update the payment' });
  } finally {
    client.release();
  }
};

module.exports = {
  METHODS,
  syncOrderReimbursement,
  getStorePayment,
  saveStorePayment,
  lockStorePaymentForBill,
  hasStorePayment,
  listStorePayments,
  reviewStorePayment,
  reimburseStorePayment,
};
