const pool = require('../config/db');

const { broadcastOrderChange, emitToAdmins } = require('../realtime');
const { readPage, pageMeta } = require('../utils/pagination');
const { createShopperNotification } = require('./shopperNotificationController');

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
//   PATCH /api/admin/store-payments/:id/review    { action: approve|query|release, note }
//   PATCH /api/admin/store-payments/:id/reimburse -> 409 USE_WITHDRAWALS
//         (phase 32: reimbursements are paid only through shopper
//         withdrawals, shopperWallet.changeWithdrawal 'pay')
// Phase 32 checks before a reimbursement is released
// (settlementController.refreshOrderSettlement): the customer's payment
// is confirmed by the backend (customer_payment_check), and a receipt
// photo (SHA-256) or till reference already used on another order
// sends the store payment to admin review (duplicate_flags).
//
// Expected amount = the shop's bought items as priced for the
// customer (same rules as the Shopper App's checkout total). A
// difference over the tolerance waits for admin review. Nothing is
// reimbursed before the order is delivered: reimbursement_status is
// 'pending' until then and settlementController.refreshOrderSettlement
// moves it to owed (bill uploaded + approved) or held (review). Order columns actual_items_total and
// reimbursement_* follow these records (admin Payments page).
// =====================================================

const METHODS = ['cash', 'card', 'phone_wallet', 'lankaqr'];

// settlementController requires this file; load it when first used
const settlement = () => require('./settlementController');
const wallet = () => require('../wallet/shopperWallet');

// Reviews a bill can have and still be reimbursed (settlementController)
const APPROVED_REVIEWS = ['ok', 'approved'];

const METHOD_LABELS = {
  cash: 'Cash',
  card: 'Own bank card',
  phone_wallet: 'Phone tap (Google Wallet)',
  lankaqr: 'LANKAQR',
  getme_card: 'GetMe company card',
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

// Line total for one bought item (ShopperApp utils/pricing getLineTotal).
// A shelf price the shopper reported (order_item_price_reports) is
// what the till charges, even when GetMe absorbed the difference.
const lineTotal = (item) => {
  const status = String(item.shopping_status || '').toLowerCase();
  const orderUnit = item.unit_price != null ? Number(item.unit_price) : null;
  const shelfUnit = item.shelf_unit_price != null && status !== 'replaced' ? Number(item.shelf_unit_price) : null;
  const unitPrice = shelfUnit ?? orderUnit;
  const foundWeight = Number(item.found_weight);

  if (foundWeight > 0 && unitPrice !== null) {
    const factor = WEIGHT_FACTORS[String(item.found_weight_unit || 'kg').toLowerCase()] ?? 1;
    return round2(unitPrice * foundWeight * factor);
  }

  const orderPack = Number(item.price ?? item.unit_price ?? 0);
  const pack =
    status === 'replaced' && item.replacement_product_price != null
      ? Number(item.replacement_product_price)
      : shelfUnit != null && orderUnit > 0
      ? round2((orderPack / orderUnit) * shelfUnit)
      : orderPack;

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
        // shopper: own money, reimbursed; getme: GetMe card, never owed (phase 38)
        fundedBy: row.funded_by || 'shopper',
        attemptId: row.attempt_id != null ? Number(row.attempt_id) : null,
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
        customerPaymentCheck: row.customer_payment_check,
        customerPaymentNote: row.customer_payment_note || null,
        duplicateFlags: Array.isArray(row.duplicate_flags) ? row.duplicate_flags : [],
        reimbursementWithdrawalId: row.reimbursement_withdrawal_id != null ? Number(row.reimbursement_withdrawal_id) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // admin list joins
        shopName: row.shop_name ?? undefined,
        shopperName: row.shopper_name ?? undefined,
        billCount: row.bill_count != null ? Number(row.bill_count) : undefined,
        // Order + customer payment, to compare with the receipt
        orderStatus: row.order_status ?? undefined,
        orderPaymentMethod: row.order_payment_method ?? undefined,
        orderTotal: row.order_total != null ? Number(row.order_total) : undefined,
        orderItemsTotal: row.order_items_total != null ? Number(row.order_items_total) : undefined,
        customerPaid: row.customer_paid != null ? Number(row.customer_paid) : undefined,
      }
    : null;

// Order-level totals the admin Payments page already shows. Only the
// shopper's own money is reimbursed: GetMe-funded payments (company
// card, phase 38) are left out.
const syncOrderReimbursement = async (client, orderId) => {
  const rows = (
    await client.query("SELECT * FROM store_payments WHERE order_id = $1 AND funded_by = 'shopper'", [orderId])
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

  // Phase 38: recorded through a payment attempt (spending limit,
  // ledger, one live payment per shop) - groceryPayments.legacyRecord
  try {
    const result = await require('../groceryPayments/groceryPayments').legacyRecord({
      shopperId: shopperIdOf(req),
      orderId,
      shopId,
      method,
      amountPaid,
      reference,
      note,
      io: req.app.get('io'),
    });

    return res.status(result.created ? 201 : 200).json({
      success: true,
      message: result.message,
      payment: toPublic(result.payment),
    });
  } catch (error) {
    if (error?.body) return res.status(error.status).json(error.body);
    if (error?.status) {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message, payment: error.payment });
    }
    console.error('❌ SAVE STORE PAYMENT ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to record the payment' });
  }
};

// Same receipt photo (SHA-256 of the file) or same till reference at
// the same shop already used on another order. Not refused (one till
// receipt can honestly cover two orders of a batch): an admin checks.
const findDuplicates = async (client, payment, hashes = []) => {
  const flags = [];

  if (hashes.length > 0) {
    const photos = (
      await client.query(
        `
        SELECT DISTINCT order_id, shop_id FROM order_shop_bills
        WHERE bill_hashes && $1::text[] AND NOT (order_id = $2 AND shop_id = $3)
        ORDER BY order_id
        LIMIT 5
        `,
        [hashes, payment.order_id, payment.shop_id]
      )
    ).rows;

    photos.forEach((other) => flags.push({ type: 'receipt_photo', orderId: Number(other.order_id), shopId: Number(other.shop_id) }));
  }

  if (payment.reference && payment.reference.trim().length >= 4) {
    const references = (
      await client.query(
        `
        SELECT order_id, shop_id FROM store_payments
        WHERE shop_id = $1 AND LOWER(reference) = LOWER($2) AND order_id <> $3
        ORDER BY order_id
        LIMIT 5
        `,
        [payment.shop_id, payment.reference.trim(), payment.order_id]
      )
    ).rows;

    references.forEach((other) => flags.push({ type: 'reference', orderId: Number(other.order_id), shopId: Number(other.shop_id) }));
  }

  return flags;
};

const duplicateNote = (flags) =>
  `Possible duplicate: ${flags
    .map((flag) => `${flag.type === 'receipt_photo' ? 'same receipt photo as' : 'same till reference as'} order #${flag.orderId}`)
    .join('; ')}`.slice(0, 300);

// Bill upload (shopperPaymentController.uploadBill): the payment must
// be recorded first; the bill makes it final. hashes = SHA-256 of the
// receipt photos (duplicate check).
// -> { error } (409 reply body) or { row }
const lockStorePaymentForBill = async (orderId, shopId, io, { hashes = [] } = {}) => {
  const client = await pool.connect();
  let row;

  try {
    await client.query('BEGIN');

    const current = (
      await client.query('SELECT * FROM store_payments WHERE order_id = $1 AND shop_id = $2 FOR UPDATE', [orderId, shopId])
    ).rows[0];

    if (current) {
      const flags = await findDuplicates(client, current, hashes);
      // A duplicate goes to review unless an admin already approved it
      const review = flags.length > 0 && current.review_status !== 'approved';

      row = (
        await client.query(
          `
          UPDATE store_payments
          SET locked_at = COALESCE(locked_at, NOW()),
              duplicate_flags = $3::jsonb,
              review_status = CASE WHEN $4::boolean THEN 'needs_review' ELSE review_status END,
              review_note = CASE WHEN $4::boolean THEN $5::varchar ELSE review_note END,
              updated_at = NOW()
          WHERE id = $1 AND shop_id = $2
          RETURNING *
          `,
          [current.id, shopId, JSON.stringify(flags), review, review ? duplicateNote(flags) : null]
        )
      ).rows[0];
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

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
  // Needs an admin: bill difference / query / duplicate / customer
  // payment not confirmed
  review: "(sp.review_status IN ('needs_review', 'queried') OR (sp.customer_payment_check = 'unconfirmed' AND sp.reimbursement_status = 'held'))",
  duplicates: "jsonb_array_length(sp.duplicate_flags) > 0",
  unpaid: "sp.customer_payment_check = 'unconfirmed' AND sp.reimbursement_status = 'held'",
  pending: "sp.reimbursement_status = 'pending'",
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
          o.status AS order_status,
          o.payment_method AS order_payment_method,
          o.total_amount AS order_total,
          o.items_total AS order_items_total,
          (
            SELECT COALESCE(SUM(cp.amount - cp.refunded_amount), 0)
            FROM card_payments cp
            WHERE cp.order_id = sp.order_id AND cp.purpose IN ('order', 'order_extra')
              AND cp.status IN ('paid', 'partially_refunded')
          ) AS customer_paid,
          (
            SELECT COALESCE(SUM(GREATEST(1, COALESCE(jsonb_array_length(b.bill_urls), 0))), 0)
            FROM order_shop_bills b
            WHERE b.order_id = sp.order_id AND b.shop_id = sp.shop_id
          ) AS bill_count
        FROM store_payments sp
        LEFT JOIN shops s ON s.id = sp.shop_id
        LEFT JOIN shoppers sh ON sh.id = sp.shopper_id
        LEFT JOIN orders o ON o.id = sp.order_id
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
          COUNT(*) FILTER (WHERE review_status IN ('needs_review', 'queried')
            OR (customer_payment_check = 'unconfirmed' AND reimbursement_status = 'held'))::int AS to_review,
          COUNT(*) FILTER (WHERE jsonb_array_length(duplicate_flags) > 0)::int AS duplicates,
          COUNT(*) FILTER (WHERE customer_payment_check = 'unconfirmed' AND reimbursement_status = 'held')::int AS unpaid,
          COALESCE(SUM(amount_paid) FILTER (WHERE reimbursement_status = 'pending'), 0)::float AS pending,
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
// release: the customer's payment isn't confirmed (e.g. a cash order
//          cancelled after purchase) but GetMe reimburses the shopper
//          anyway; who and why are recorded
const reviewStorePayment = async (req, res) => {
  const id = toId(req.params.id);
  const action = req.body?.action;
  const note = String(req.body?.note || '').trim().slice(0, 300) || null;

  if (!id || !['approve', 'query', 'release'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Choose approve, query or release' });
  }

  if (action === 'query' && !note) {
    return res.status(400).json({ success: false, message: 'Say what needs checking' });
  }

  if (action === 'release' && (!note || note.length < 3)) {
    return res.status(400).json({ success: false, message: 'Say why GetMe reimburses it without the customer payment' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const before = (await client.query('SELECT * FROM store_payments WHERE id = $1', [id])).rows[0];

    if (!before) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Store payment not found' });
    }

    // Same lock as withdrawals: a query can't take back grocery money
    // the shopper already withdrew or requested
    await client.query('SELECT id FROM shoppers WHERE id = $1 FOR UPDATE', [before.shopper_id]);

    if (action === 'query' && before.reimbursement_status === 'owed') {
      const room = await wallet().reimbursementRoom(before.shopper_id, client);

      if (room < Number(before.amount_paid) - 0.005) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          code: 'ALREADY_WITHDRAWN',
          message: `The shopper has already withdrawn or requested this reimbursement. Only LKR ${Math.max(0, room).toFixed(2)} of their grocery reimbursement can still be held.`,
        });
      }
    }

    if (action === 'release') {
      const released = (
        await client.query(
          `
          UPDATE store_payments
          SET customer_payment_check = 'overridden', customer_payment_note = $2,
              customer_payment_override_by = $3, customer_payment_override_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND customer_payment_check = 'unconfirmed' AND reimbursement_status <> 'reimbursed'
          RETURNING *
          `,
          [id, note, req.admin.adminId]
        )
      ).rows[0];

      if (!released) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Only a reimbursement waiting for the customer payment can be released' });
      }

      await client.query('COMMIT');

      const io = req.app.get('io');
      announce(io, released);
      await settlement().refreshOrderSettlement(released.order_id, io);

      return res.json({
        success: true,
        message: released.locked_at && APPROVED_REVIEWS.includes(released.review_status)
          ? 'Released. The shopper can withdraw it.'
          : 'Released. It is paid once the bill is approved.',
        storePayment: toPublic(released),
      });
    }

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

// Phase 32: reimbursements are paid only through the shopper's
// withdrawal requests (owner's rule 2026-10-28), so the same money
// can't go out twice. The old direct transfer is kept below, unused.
const reimburseStorePayment = async (req, res) =>
  res.status(409).json({
    success: false,
    code: 'USE_WITHDRAWALS',
    message: 'Grocery reimbursements are paid through shopper withdrawal requests (Withdrawals page)',
  });

// The bank transfer to the shopper is done (reference from the bank)
// eslint-disable-next-line no-unused-vars
const reimburseStorePaymentDirect = async (req, res) => {
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
  METHOD_LABELS,
  // Shared with src/groceryPayments (phase 38)
  UNPICKED_STATUSES,
  lineTotal,
  shopItems,
  expectedFor,
  reviewTolerance,
  hardLimit,
  toPublic,
  announce,
  findShopperOrderShop,
  syncOrderReimbursement,
  getStorePayment,
  saveStorePayment,
  lockStorePaymentForBill,
  hasStorePayment,
  listStorePayments,
  reviewStorePayment,
  reimburseStorePayment,
};
