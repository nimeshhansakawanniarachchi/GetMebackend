const pool = require('../config/db');

// =====================================================
// SUPERMARKET PAYMENTS (phase 38, 2026-10-28)
// sql/platform_phase38_grocery_payments.sql
//
// How a shopper pays a supermarket for one order + shop:
//   1. Before shopping a spending limit is reserved for the order +
//      shop (grocery_reservations): estimate of the shop's items +
//      max(min buffer, buffer %) (owner's choice: 10%, at least
//      Rs 500; Admin > Supermarket payments). Shoppers can't change it;
//      an admin can, with a reason.
//   2. The shopper picks one of the methods AVAILABLE for them, the
//      shop and their account (availableMethods). Choosing starts a
//      pending attempt; it marks nothing paid.
//   3. They pay at the till and report the result: paid (amount +
//      reference) -> the existing store payment record (store_payments,
//      the bill photo makes it final), or failed -> pick another
//      method. Cancel a pending attempt any time.
//   4. Verification never trusts the app alone: shopper-funded
//      payments are backed by the bill photo + the existing admin
//      review; GetMe card payments are matched by an admin against
//      the bank statement. No provider API exists for any method yet
//      (see the provider notes in the migration), so 'provider'
//      verification is not used.
// Money is never mixed: shopper-funded payments are reimbursed through
// withdrawals (phase 32); GetMe-funded ones (company card) are
// store_payments.funded_by 'getme' with reimbursement_status
// 'company_paid', so they are never owed to the shopper and never
// count as earnings.
// =====================================================

const store = () => require('../controllers/storePaymentController');
const settlement = () => require('../controllers/settlementController');

const ACTIVE_ORDER = (status) => !['cancelled', 'delivered', 'pending', 'pending_shopper_search'].includes(status);
const LIVE = ['pending', 'succeeded', 'disputed'];
const APPROVED_REVIEWS = ['ok', 'approved'];

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const error = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Never a card number: at most a short reference (last 4 / QR ref)
const checkReference = (reference) => {
  if (reference && /\d{12,}/.test(reference.replace(/[\s-]/g, ''))) {
    throw error(400, 'Enter only the last 4 digits of the card or the receipt reference, never a full card number', 'FULL_CARD_NUMBER');
  }
};

// ---------------------------------------------------
// Settings + spending limit
// ---------------------------------------------------

const loadSettings = async (client = pool) => {
  const row = (await client.query('SELECT * FROM grocery_payment_settings WHERE id = 1')).rows[0];
  return {
    limitBufferPercent: Number(row?.limit_buffer_percent ?? 10),
    limitBufferMin: Number(row?.limit_buffer_min ?? 500),
  };
};

// Everything on the shop's list the customer still pays for (not
// refunded), at the till's expected price
const estimateFor = (items) =>
  round2(
    items
      .filter((item) => String(item.shopping_status || '').toLowerCase() !== 'refunded')
      .reduce((sum, item) => sum + store().lineTotal(item), 0)
  );

const limitFor = (estimate, settings) =>
  round2(estimate + Math.max(settings.limitBufferMin, (estimate * settings.limitBufferPercent) / 100));

const addEntry = (client, entry) =>
  client.query(
    `
    INSERT INTO grocery_ledger_entries (
      entry_type, order_id, shop_id, shopper_id, reservation_id, attempt_id, card_id,
      amount, actor_type, actor_id, note
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT DO NOTHING
    `,
    [
      entry.type,
      entry.orderId ?? null,
      entry.shopId ?? null,
      entry.shopperId ?? null,
      entry.reservationId ?? null,
      entry.attemptId ?? null,
      entry.cardId ?? null,
      round2(entry.amount ?? 0),
      entry.actorType || 'system',
      entry.actorId ?? null,
      entry.note ? String(entry.note).slice(0, 300) : null,
    ]
  );

// ---------------------------------------------------
// Company cards: money GetMe made available, minus what was spent or
// is held by a pending payment
// ---------------------------------------------------

const cardBalance = async (client, cardId) => {
  const row = (
    await client.query(
      `
      SELECT
        COALESCE((SELECT SUM(CASE WHEN kind = 'load' THEN amount ELSE -amount END) FROM getme_card_loads WHERE card_id = $1), 0)::float AS funded,
        COALESCE((SELECT SUM(amount) FROM grocery_payment_attempts WHERE card_id = $1 AND status IN ('succeeded', 'disputed')), 0)::float AS spent,
        COALESCE((SELECT SUM(limit_amount) FROM grocery_payment_attempts WHERE card_id = $1 AND status = 'pending'), 0)::float AS held
      `,
      [Number(cardId)]
    )
  ).rows[0];

  return { funded: round2(row.funded), spent: round2(row.spent), held: round2(row.held), available: round2(row.funded - row.spent - row.held) };
};

const activeCardOf = async (client, shopperId) =>
  (await client.query("SELECT * FROM getme_cards WHERE shopper_id = $1 AND status = 'active'", [Number(shopperId)])).rows[0] || null;

// ---------------------------------------------------
// Reservations (one per order + shop)
// ---------------------------------------------------

const orderShopIds = async (client, orderId) => {
  const rows = (
    await client.query(
      `
      SELECT shop_id FROM order_shops WHERE order_id = $1
      UNION
      SELECT DISTINCT shop_id FROM order_items WHERE order_id = $1 AND shop_id IS NOT NULL
      `,
      [orderId]
    )
  ).rows;
  return rows.map((row) => Number(row.shop_id)).filter(Boolean);
};

const liveAttempt = async (client, orderId, shopId, { lock = false } = {}) =>
  (
    await client.query(
      `SELECT * FROM grocery_payment_attempts WHERE order_id = $1 AND shop_id = $2 AND status = ANY($3) ORDER BY id DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
      [orderId, shopId, LIVE]
    )
  ).rows[0] || null;

// Creates / refreshes the reservation of one order + shop (order row
// locked by the caller). Returns the reservation row (or null when the
// order has no shopper / never needs one).
const syncReservation = async (client, order, shopId, settings) => {
  const orderId = Number(order.id);
  let reservation = (
    await client.query('SELECT * FROM grocery_reservations WHERE order_id = $1 AND shop_id = $2 FOR UPDATE', [orderId, shopId])
  ).rows[0];
  const finished = ['cancelled', 'delivered'].includes(order.status);
  let attempt = await liveAttempt(client, orderId, shopId, { lock: true });

  // The order ended while a payment was still being chosen: nothing was
  // reported as paid, so the attempt is cancelled (card funds freed)
  if (finished && attempt?.status === 'pending') {
    await client.query("UPDATE grocery_payment_attempts SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [attempt.id]);
    await addEntry(client, {
      type: 'attempt_cancelled',
      orderId,
      shopId,
      shopperId: attempt.shopper_id,
      reservationId: attempt.reservation_id,
      attemptId: attempt.id,
      cardId: attempt.card_id,
      note: `Order ${order.status} before the payment was reported`,
    });
    attempt = null;
  }

  const paid = attempt && ['succeeded', 'disputed'].includes(attempt.status) ? round2(attempt.amount) : 0;

  if (!reservation) {
    if (!order.shopper_id || !(ACTIVE_ORDER(order.status) || paid > 0)) return null;

    const estimate = estimateFor(await store().shopItems(client, orderId, shopId));
    const limit = limitFor(estimate, settings);
    reservation = (
      await client.query(
        `INSERT INTO grocery_reservations (order_id, shop_id, shopper_id, estimate_amount, limit_amount)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (order_id, shop_id) DO UPDATE SET updated_at = grocery_reservations.updated_at
         RETURNING *`,
        [orderId, shopId, Number(order.shopper_id), estimate, limit]
      )
    ).rows[0];
    await addEntry(client, {
      type: 'reserve',
      orderId,
      shopId,
      shopperId: order.shopper_id,
      reservationId: reservation.id,
      amount: limit,
      note: `Spending limit for this shop (estimate Rs ${estimate.toFixed(2)})`,
    });
  }

  if (['settled', 'released'].includes(reservation.status)) return reservation;

  const updates = {};

  // Reassigned before anything was paid
  if (order.shopper_id && Number(order.shopper_id) !== Number(reservation.shopper_id) && !attempt) {
    updates.shopper_id = Number(order.shopper_id);
  }

  // The basket changed (extra items, refunds): the computed limit
  // follows it while nothing is pending and no admin set the limit
  if (!finished && reservation.status === 'active' && attempt?.status !== 'pending') {
    const estimate = estimateFor(await store().shopItems(client, orderId, shopId));
    const limit = reservation.limit_override != null ? round2(reservation.limit_override) : limitFor(estimate, settings);

    if (estimate !== round2(reservation.estimate_amount)) updates.estimate_amount = estimate;
    if (limit !== round2(reservation.limit_amount)) {
      updates.limit_amount = limit;
      await addEntry(client, {
        type: 'limit_change',
        orderId,
        shopId,
        shopperId: reservation.shopper_id,
        reservationId: reservation.id,
        amount: limit,
        note: `Limit Rs ${round2(reservation.limit_amount).toFixed(2)} -> Rs ${limit.toFixed(2)} (basket changed)`,
      });
    }
  }

  // Captured = what the live payment paid (0 after a reversal)
  if (paid !== round2(reservation.captured_amount)) updates.captured_amount = paid;
  const nextStatus = paid > 0 ? 'captured' : 'active';
  if (!finished && nextStatus !== reservation.status) updates.status = nextStatus;

  // Order finished: release whatever was not spent, once
  if (finished) {
    const limit = round2(updates.limit_amount ?? reservation.limit_amount);
    const released = round2(Math.max(0, limit - paid));
    updates.status = paid > 0 ? 'settled' : 'released';
    updates.released_amount = released;
    await addEntry(client, {
      type: 'release',
      orderId,
      shopId,
      shopperId: reservation.shopper_id,
      reservationId: reservation.id,
      amount: released,
      note: paid > 0 ? `Order ${order.status}: unused limit released (paid Rs ${paid.toFixed(2)})` : `Order ${order.status}: nothing paid, limit released`,
    });
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) return reservation;

  const sets = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  return (
    await client.query(`UPDATE grocery_reservations SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`, [
      reservation.id,
      ...keys.map((key) => updates[key]),
    ])
  ).rows[0];
};

// Verification / reconciliation that follows the store payment record
// (bill uploaded, admin review). An admin's own reconciliation of a
// GetMe card payment (statement) or a 'resolved' decision is kept.
const syncAttemptChecks = async (client, orderId) => {
  const attempts = (
    await client.query(
      `SELECT a.*, sp.locked_at, sp.review_status
       FROM grocery_payment_attempts a JOIN store_payments sp ON sp.id = a.store_payment_id
       WHERE a.order_id = $1 AND a.status IN ('succeeded', 'disputed')`,
      [orderId]
    )
  ).rows;

  for (const attempt of attempts) {
    const verification = attempt.verification === 'statement' ? 'statement' : attempt.locked_at ? 'receipt' : 'none';
    let reconciliation = attempt.reconciliation_status;
    const flagged = ['needs_review', 'queried'].includes(attempt.review_status);
    const adminDecided = attempt.reconciled_by != null;

    if (!adminDecided) {
      if (attempt.funding === 'shopper') {
        reconciliation = attempt.locked_at && APPROVED_REVIEWS.includes(attempt.review_status) ? 'matched' : flagged ? 'mismatch' : 'unreconciled';
      } else {
        // GetMe card: matched only against the bank statement by an admin
        reconciliation = flagged ? 'mismatch' : 'unreconciled';
      }
    }

    if (verification !== attempt.verification || reconciliation !== attempt.reconciliation_status) {
      await client.query(
        'UPDATE grocery_payment_attempts SET verification = $2, reconciliation_status = $3, updated_at = NOW() WHERE id = $1',
        [attempt.id, verification, reconciliation]
      );
    }
  }
};

// Idempotent: call after any order change (start shopping, items,
// payment, bill, review, delivery, cancellation). settlementController
// .refreshOrderSettlement calls it at the end.
const syncOrder = async (orderId) => {
  const id = Number(orderId);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const order = (await client.query('SELECT id, status, shopper_id FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];

    if (order) {
      const settings = await loadSettings(client);
      for (const shopId of await orderShopIds(client, id)) await syncReservation(client, order, shopId, settings);
      await syncAttemptChecks(client, id);
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ GROCERY RESERVATION SYNC ERROR:', id, caught.message);
  } finally {
    client.release();
  }
};

// ---------------------------------------------------
// Which methods a shopper can use at a shop
// ---------------------------------------------------

const methodRows = async (client, shopId) =>
  (
    await client.query(
      `
      SELECT m.*, o.enabled AS shop_enabled, o.note AS shop_note
      FROM grocery_payment_methods m
      LEFT JOIN grocery_shop_payment_methods o ON o.method_key = m.key AND o.shop_id = $1
      ORDER BY m.sort_order, m.key
      `,
      [shopId]
    )
  ).rows;

const publicMethod = (row, extra = {}) => ({
  key: row.key,
  label: row.label,
  funding: row.funding,
  fundingLabel: row.funding === 'getme' ? "GetMe's money" : 'Your money, paid back by GetMe',
  icon: row.icon,
  instructions: row.instructions,
  ...extra,
});

// Short reasons the shopper sees (the admin sees the full requirement)
const NOT_INTEGRATED = {
  getme_wallet_card: 'Not available yet: no Sri Lankan provider offers GetMe virtual cards for phone wallets',
  getme_lankaqr: 'Not available yet: GetMe cannot pay LANKAQR from its business account',
  store_direct: 'Not available yet: supermarkets have no direct payment arrangement with GetMe',
};

// Every method with its availability for this shopper, shop and device:
//   available       usable now
//   requires_setup  GetMe / the shopper must set something up first
//   unavailable     not offered here (provider, store, device)
// Nothing is 'available' unless it really works end to end.
const methodCatalogue = async (client, { shopperId, shopId, reservation, platform }) => {
  const rows = await methodRows(client, shopId);
  const list = [];

  for (const row of rows) {
    const on = row.shop_enabled != null ? row.shop_enabled : row.enabled;
    const entry = (availability, reason = null, extra = {}) => list.push(publicMethod(row, { availability, reason, ...extra }));

    if (row.integration === 'not_available') {
      entry('unavailable', NOT_INTEGRATED[row.key] || 'Not available yet');
      continue;
    }

    if (row.key === 'getme_card') {
      // Program not switched on: not part of this shopper's world yet
      if (!row.enabled && row.shop_enabled == null) continue;
      if (!on) {
        entry('unavailable', 'The GetMe card is not used at this store');
        continue;
      }
      const card = await activeCardOf(client, shopperId);
      if (!card) {
        const frozen = (await client.query("SELECT 1 FROM getme_cards WHERE shopper_id = $1 AND status = 'frozen'", [Number(shopperId)])).rows.length > 0;
        entry('requires_setup', frozen ? 'Your GetMe card is frozen. Contact GetMe.' : 'You have no GetMe card yet. Ask GetMe for one.');
        continue;
      }
      const balance = await cardBalance(client, card.id);
      const need = round2(reservation?.limit_amount ?? 0);
      const cardInfo = { id: Number(card.id), label: card.label, issuer: card.issuer, last4: card.last4 };

      if (balance.available + 0.005 < need) {
        entry('requires_setup', 'Not enough GetMe funds on your card for this order. Use another method or ask GetMe to add funds.', { card: cardInfo });
      } else {
        entry('available', null, { card: cardInfo });
      }
      continue;
    }

    if (!on) {
      entry('unavailable', row.shop_enabled === false ? 'Not accepted at this store' : 'Not offered by GetMe right now');
      continue;
    }

    // Google Wallet needs an NFC Android phone; Apple Pay / Samsung Pay
    // are not available for Sri Lankan cards
    if (row.key === 'phone_wallet' && platform === 'ios') {
      entry('unavailable', 'Google Wallet works only on Android phones, and Apple Pay is not available for Sri Lankan cards. Use your card instead.');
      continue;
    }

    entry('available', null, row.key === 'phone_wallet' ? { deviceNote: 'Needs NFC switched on and your card added to Google Wallet.' } : {});
  }

  return list;
};

// Backward compatible view (phase 38 app): usable methods, plus the
// ones this shopper would otherwise have (e.g. GetMe card short of funds)
const availableMethods = async (client, args) => {
  const list = await methodCatalogue(client, args);
  return {
    available: list.filter((m) => m.availability === 'available'),
    unavailable: list.filter((m) => m.key === 'getme_card' && m.availability !== 'available'),
    catalogue: list,
  };
};

// ---------------------------------------------------
// Views
// ---------------------------------------------------

const publicReservation = (row) =>
  row
    ? {
        id: Number(row.id),
        orderId: Number(row.order_id),
        shopId: Number(row.shop_id),
        shopperId: Number(row.shopper_id),
        estimateAmount: round2(row.estimate_amount),
        limitAmount: round2(row.limit_amount),
        limitSetByAdmin: row.limit_override != null,
        limitNote: row.limit_note || null,
        status: row.status,
        capturedAmount: round2(row.captured_amount),
        releasedAmount: round2(row.released_amount),
        remainingAmount: round2(Math.max(0, Number(row.limit_amount) - Number(row.captured_amount))),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const ATTEMPT_LABELS = {
  pending: 'Waiting for the payment',
  succeeded: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled',
  reversed: 'Reversed',
  disputed: 'Disputed',
};

const publicAttempt = (row) =>
  row
    ? {
        id: Number(row.id),
        orderId: Number(row.order_id),
        shopId: Number(row.shop_id),
        shopperId: Number(row.shopper_id),
        method: row.method,
        methodLabel: row.method_label || store().METHOD_LABELS[row.method] || row.method,
        funding: row.funding,
        cardId: row.card_id != null ? Number(row.card_id) : null,
        cardLast4: row.card_last4 || null,
        status: row.status,
        // Reported paid is not 'paid': the receipt + checks come first
        statusLabel:
          row.status === 'succeeded' && row.verification === 'none'
            ? 'Payment reported · receipt needed'
            : row.status === 'succeeded' && row.reconciliation_status !== 'matched' && row.reconciliation_status !== 'resolved'
            ? 'Paid · GetMe is checking'
            : row.status === 'succeeded' && row.verification === 'statement'
            ? 'Paid · verified with the bank'
            : row.status === 'succeeded'
            ? 'Paid · receipt checked'
            : ATTEMPT_LABELS[row.status] || row.status,
        currency: row.currency,
        expectedAmount: round2(row.expected_amount),
        limitAmount: round2(row.limit_amount),
        amount: row.amount != null ? round2(row.amount) : null,
        overLimit: Boolean(row.over_limit),
        reference: row.reference,
        failureReason: row.failure_reason,
        storePaymentId: row.store_payment_id != null ? Number(row.store_payment_id) : null,
        verification: row.verification,
        reconciliationStatus: row.reconciliation_status,
        reconciliationNote: row.reconciliation_note,
        statementReference: row.statement_reference,
        reconciledAt: row.reconciled_at,
        paidAt: row.paid_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // admin joins
        shopName: row.shop_name ?? undefined,
        shopperName: row.shopper_name ?? undefined,
        shopperCode: row.shopper_code ?? undefined,
        orderStatus: row.order_status ?? undefined,
        billLocked: row.bill_locked != null ? Boolean(row.bill_locked) : undefined,
        reviewStatus: row.review_status ?? undefined,
        reimbursementStatus: row.reimbursement_status ?? undefined,
        possibleDuplicate: row.duplicate_count != null ? Number(row.duplicate_count) > 0 : undefined,
      }
    : null;

// ---------------------------------------------------
// Shopper: payment screen data
// ---------------------------------------------------

const orderForShopper = async (client, orderId, shopperId, shopId, { lock = false } = {}) => {
  const order = (
    await client.query(
      `SELECT o.id, o.status, o.shopper_id, o.customer_id FROM orders o
       JOIN order_shops os ON os.order_id = o.id AND os.shop_id = $3
       WHERE o.id = $1 AND o.shopper_id = $2 ${lock ? 'FOR UPDATE OF o' : ''}`,
      [Number(orderId), Number(shopperId), Number(shopId)]
    )
  ).rows[0];

  if (!order) throw error(404, 'Order not found for this shopper', 'NOT_FOUND');
  return order;
};

// Where each shop of an order is in paying (one shop at a time):
//   not_started       nothing tried yet
//   failed            last try failed / cancelled / reversed: pick a method
//   awaiting_payment  a method was chosen, the till result isn't reported
//   awaiting_receipt  payment reported; the receipt photo finishes it
//   checking          receipt in, but the amount / receipt is flagged for GetMe
//   paid              receipt in and the server's checks passed
const SHOP_STATE_LABELS = {
  not_started: 'Not paid yet',
  failed: 'Not paid · choose a payment method',
  awaiting_payment: 'Waiting for the payment',
  awaiting_receipt: 'Payment reported · receipt needed',
  checking: 'Paid · GetMe is checking the bill',
  paid: 'Paid · receipt checked',
};

const REIMBURSEMENT_LABELS = {
  pending: 'GetMe pays you back after delivery',
  owed: 'Ready to withdraw',
  held: 'On hold while GetMe checks',
  reimbursed: 'Paid back to you',
};

const shopStatesFor = async (client, orderId) => {
  const id = Number(orderId);
  const [shops, attempts, payments] = await Promise.all([
    client.query(
      'SELECT os.shop_id, COALESCE(s.shop_name, os.shop_name) AS shop_name, s.image_url FROM order_shops os LEFT JOIN shops s ON s.id = os.shop_id WHERE os.order_id = $1 ORDER BY os.id',
      [id]
    ),
    client.query('SELECT shop_id, status FROM grocery_payment_attempts WHERE order_id = $1 ORDER BY id DESC', [id]),
    client.query('SELECT shop_id, locked_at, review_status, duplicate_flags FROM store_payments WHERE order_id = $1', [id]),
  ]);

  return shops.rows.map((shop, index) => {
    const shopId = Number(shop.shop_id);
    const mine = attempts.rows.filter((a) => Number(a.shop_id) === shopId);
    const live = mine.find((a) => LIVE.includes(a.status));
    const payment = payments.rows.find((p) => Number(p.shop_id) === shopId);
    const duplicate = Array.isArray(payment?.duplicate_flags) && payment.duplicate_flags.length > 0 && payment.review_status !== 'approved';
    const flagged = payment && (!APPROVED_REVIEWS.includes(payment.review_status) || duplicate);
    const state = !live
      ? mine.length > 0
        ? 'failed'
        : 'not_started'
      : live.status === 'pending'
      ? 'awaiting_payment'
      : !payment?.locked_at
      ? 'awaiting_receipt'
      : live.status === 'disputed' || flagged
      ? 'checking'
      : 'paid';

    return { shopId, shopName: shop.shop_name, imageUrl: shop.image_url || null, position: index + 1, state, stateLabel: SHOP_STATE_LABELS[state] };
  });
};

// GET /api/shopper/orders/:orderId/grocery-payment?shopId=&platform=
const paymentScreen = async ({ shopperId, orderId, shopId, platform }) => {
  await orderForShopper(pool, orderId, shopperId, shopId);
  await syncOrder(orderId);

  const reservation = (await pool.query('SELECT * FROM grocery_reservations WHERE order_id = $1 AND shop_id = $2', [Number(orderId), Number(shopId)])).rows[0];
  const items = await store().shopItems(pool, Number(orderId), Number(shopId));
  const methods = await availableMethods(pool, { shopperId, shopId, reservation, platform });
  const attempts = (
    await pool.query(
      `SELECT a.*, m.label AS method_label, c.last4 AS card_last4
       FROM grocery_payment_attempts a
       JOIN grocery_payment_methods m ON m.key = a.method
       LEFT JOIN getme_cards c ON c.id = a.card_id
       WHERE a.order_id = $1 AND a.shop_id = $2 ORDER BY a.id DESC`,
      [Number(orderId), Number(shopId)]
    )
  ).rows.map(publicAttempt);
  const payment = (await pool.query('SELECT * FROM store_payments WHERE order_id = $1 AND shop_id = $2', [Number(orderId), Number(shopId)])).rows[0];
  const order = (
    await pool.query(
      `SELECT o.id, o.status, split_part(COALESCE(c.full_name, ''), ' ', 1) AS customer_first_name
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`,
      [Number(orderId)]
    )
  ).rows[0];
  const shops = await shopStatesFor(pool, orderId);
  const thisShop = shops.find((shop) => shop.shopId === Number(shopId)) || null;
  const current = attempts.find((a) => LIVE.includes(a.status)) || null;
  const expected = store().expectedFor(items);
  const bought = items.filter((item) => ['done', 'found', 'replaced', 'completed'].includes(String(item.shopping_status || '').toLowerCase()));
  const limit = reservation ? round2(reservation.limit_amount) : null;
  const paid = current?.amount != null ? round2(current.amount) : null;
  // Another shop of this order still being paid (one shop at a time)
  const blockingShop = shops.find((shop) => shop.shopId !== Number(shopId) && ['awaiting_payment', 'awaiting_receipt'].includes(shop.state)) || null;

  return {
    currency: 'LKR',
    shop: thisShop,
    order: {
      id: Number(order.id),
      code: `GETME-${order.id}`,
      status: order.status,
      customerFirstName: order.customer_first_name || null,
      shopCount: shops.length,
      itemCount: bought.reduce((sum, item) => sum + (Number(item.found_quantity) > 0 ? Number(item.found_quantity) : Number(item.quantity) || 1), 0),
      lineCount: bought.length,
    },
    shops,
    blockingShop,
    shopState: thisShop?.state || 'not_started',
    shopStateLabel: thisShop?.stateLabel || SHOP_STATE_LABELS.not_started,
    expectedAmount: expected,
    reservation: publicReservation(reservation),
    // Amounts in LKR for the summary
    breakdown: {
      estimate: reservation ? round2(reservation.estimate_amount) : null,
      expected,
      limit,
      paid,
      difference: paid != null ? round2(paid - expected) : null,
      remainingLimit: limit != null ? round2(Math.max(0, limit - (paid ?? 0))) : null,
      overLimit: Boolean(current?.overLimit),
    },
    // Every method with availability (available / requires_setup / unavailable)
    catalogue: methods.catalogue,
    methods: methods.available,
    unavailableMethods: methods.unavailable,
    current,
    attempts,
    storePayment: store().toPublic(payment),
    reconciliation: payment
      ? {
          funding: payment.funded_by,
          receiptUploaded: Boolean(payment.locked_at),
          receiptCheck: !payment.locked_at ? 'waiting' : APPROVED_REVIEWS.includes(payment.review_status) ? 'ok' : 'flagged',
          reviewNote: payment.review_note || null,
          possibleDuplicate: Array.isArray(payment.duplicate_flags) && payment.duplicate_flags.length > 0,
          expected: round2(payment.expected_amount),
          paid: round2(payment.amount_paid),
          difference: round2(payment.variance),
          limit,
          withinLimit: limit == null || Number(payment.amount_paid) <= limit + 0.005,
          bankStatement: payment.funded_by === 'getme' ? (current?.verification === 'statement' ? 'matched' : 'not_yet') : null,
          reimbursement:
            payment.funded_by === 'getme'
              ? { status: 'company_paid', label: "GetMe's money · nothing is owed to you" }
              : { status: payment.reimbursement_status, label: REIMBURSEMENT_LABELS[payment.reimbursement_status] || payment.reimbursement_status },
        }
      : null,
  };
};

// Same checks as the store payment record (storePaymentController)
const checkReadyToPay = async (client, order, shopId) => {
  if (order.status !== 'shopping') throw error(409, 'Shopping has finished for this order', 'NOT_SHOPPING');

  const pendingBlock = await require('../controllers/orderItemRequestsController').pendingRequestsBlock(order.id, shopId);
  if (pendingBlock) throw error(409, pendingBlock.message, pendingBlock.code, { body: pendingBlock });

  const items = await store().shopItems(client, order.id, shopId);
  const unpicked = items.filter((item) => store().UNPICKED_STATUSES.includes(String(item.shopping_status || '').toLowerCase())).length;

  if (unpicked > 0) {
    throw error(
      409,
      unpicked === 1 ? 'One item is still to pick (or refund). Finish it before paying.' : `${unpicked} items are still to pick (or refund). Finish them before paying.`,
      'ITEMS_TO_PICK'
    );
  }

  return items;
};

// ---------------------------------------------------
// Shopper: start / report / cancel an attempt
// ---------------------------------------------------

const lockAttempt = async (client, attemptId, shopperId) => {
  const attempt = (
    await client.query('SELECT * FROM grocery_payment_attempts WHERE id = $1 AND shopper_id = $2 FOR UPDATE', [Number(attemptId), Number(shopperId)])
  ).rows[0];
  if (!attempt) throw error(404, 'Payment not found', 'NOT_FOUND');
  return attempt;
};

const attemptView = async (client, id) =>
  publicAttempt(
    (
      await client.query(
        `SELECT a.*, m.label AS method_label, c.last4 AS card_last4 FROM grocery_payment_attempts a
         JOIN grocery_payment_methods m ON m.key = a.method LEFT JOIN getme_cards c ON c.id = a.card_id WHERE a.id = $1`,
        [id]
      )
    ).rows[0]
  );

// Inside a transaction with the order row locked
const createAttempt = async (client, { order, shopId, shopperId, method, requestId, platform, actor = 'shopper' }) => {
  const settings = await loadSettings(client);
  const reservation = await syncReservation(client, order, shopId, settings);
  if (!reservation) throw error(409, 'This order has no spending limit yet', 'NO_RESERVATION');

  const live = await liveAttempt(client, order.id, shopId, { lock: true });
  if (live) {
    throw error(
      409,
      live.status === 'pending'
        ? 'A payment is already in progress for this shop. Report its result or cancel it first.'
        : 'This shop is already paid for this order',
      live.status === 'pending' ? 'PAYMENT_IN_PROGRESS' : 'ALREADY_PAID',
      { attemptId: Number(live.id) }
    );
  }

  // One shop at a time: finish the other shop's payment + receipt first
  const blockingShop = (await shopStatesFor(client, order.id)).find(
    (shop) => shop.shopId !== Number(shopId) && ['awaiting_payment', 'awaiting_receipt'].includes(shop.state)
  );
  if (blockingShop) {
    throw error(
      409,
      blockingShop.state === 'awaiting_payment'
        ? `Finish paying ${blockingShop.shopName} first (report the result or cancel it).`
        : `Upload the receipt for ${blockingShop.shopName} before paying the next shop.`,
      'PREVIOUS_SHOP_OPEN',
      { blockingShopId: blockingShop.shopId }
    );
  }

  const methods = await availableMethods(client, { shopperId, shopId, reservation, platform });
  const chosen = methods.available.find((m) => m.key === method);

  if (!chosen) {
    const listed = methods.catalogue.find((m) => m.key === method);
    throw error(
      409,
      listed?.reason || "This payment method isn't available for you at this shop",
      listed?.key === 'getme_card' && listed.card ? 'CARD_FUNDS_LOW' : 'METHOD_NOT_AVAILABLE'
    );
  }

  let cardId = null;
  if (chosen.funding === 'getme') {
    // Lock the card, then re-check: two orders can't hold the same money
    const card = (await client.query("SELECT * FROM getme_cards WHERE id = $1 AND status = 'active' FOR UPDATE", [chosen.card.id])).rows[0];
    if (!card) throw error(409, 'Your GetMe card is not active', 'METHOD_NOT_AVAILABLE');
    const balance = await cardBalance(client, card.id);
    if (balance.available + 0.005 < round2(reservation.limit_amount)) {
      throw error(409, 'Not enough GetMe funds on your card for this order. Use another method or ask GetMe to add funds.', 'CARD_FUNDS_LOW');
    }
    cardId = Number(card.id);
  }

  const items = await store().shopItems(client, order.id, shopId);
  const attempt = (
    await client.query(
      `INSERT INTO grocery_payment_attempts (
         order_id, shop_id, shopper_id, reservation_id, method, funding, card_id, status,
         expected_amount, limit_amount, request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10)
       RETURNING *`,
      [order.id, shopId, shopperId, reservation.id, method, chosen.funding, cardId, store().expectedFor(items), round2(reservation.limit_amount), requestId || null]
    )
  ).rows[0];

  await addEntry(client, {
    type: 'attempt_start',
    orderId: order.id,
    shopId,
    shopperId,
    reservationId: reservation.id,
    attemptId: attempt.id,
    cardId,
    amount: chosen.funding === 'getme' ? reservation.limit_amount : 0,
    actorType: actor,
    actorId: shopperId,
    note: chosen.funding === 'getme' ? `${chosen.label}: card funds held up to the limit` : `${chosen.label} chosen`,
  });

  return attempt;
};

// POST /api/shopper/orders/:orderId/grocery-payment/attempts { shopId, method, requestId, platform }
const startAttempt = async ({ shopperId, orderId, shopId, method, requestId, platform }) => {
  const key = clean(requestId, 80) || null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Same request again (double tap / lost reply): the same attempt
    if (key) {
      const again = (await client.query('SELECT id FROM grocery_payment_attempts WHERE shopper_id = $1 AND request_id = $2', [shopperId, key])).rows[0];
      if (again) {
        await client.query('COMMIT');
        return { attempt: await attemptView(pool, again.id), duplicate: true };
      }
    }

    const order = await orderForShopper(client, orderId, shopperId, shopId, { lock: true });
    await checkReadyToPay(client, order, Number(shopId));
    const attempt = await createAttempt(client, { order, shopId: Number(shopId), shopperId, method: String(method || ''), requestId: key, platform });
    await client.query('COMMIT');
    return { attempt: await attemptView(pool, attempt.id), duplicate: false };
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') throw error(409, 'A payment is already in progress for this shop', 'PAYMENT_IN_PROGRESS');
    throw caught;
  } finally {
    client.release();
  }
};

// The till charged the shopper / card: write the store payment record
// (same rules as phase 20) and capture the reservation. Inside a
// transaction with the order row locked.
const recordPaid = async (client, { order, attempt, amountPaid, reference, note, actorId }) => {
  const shopId = Number(attempt.shop_id);
  const items = await checkReadyToPay(client, order, shopId);
  const expected = store().expectedFor(items);
  const amount = round2(amountPaid);

  if (!(amount > 0)) throw error(400, 'Enter the amount the till charged', 'INVALID_AMOUNT', { field: 'amountPaid' });
  if (amount > store().hardLimit(expected)) {
    throw error(400, `Rs ${amount.toFixed(2)} is far above the expected Rs ${expected.toFixed(2)}. Check the amount on the bill.`, 'AMOUNT_TOO_HIGH', { field: 'amountPaid' });
  }

  let ref = clean(reference, 40) || null;
  checkReference(ref);

  let card = null;
  if (attempt.funding === 'getme') {
    card = (await client.query('SELECT * FROM getme_cards WHERE id = $1', [attempt.card_id])).rows[0];
    ref = ref || `card ••${card?.last4 || ''}`;
  }

  const existing = (await client.query('SELECT * FROM store_payments WHERE order_id = $1 AND shop_id = $2 FOR UPDATE', [order.id, shopId])).rows[0];

  if (existing?.locked_at) {
    throw error(409, 'This store payment is already final (the bill was uploaded)', 'ALREADY_RECORDED', { payment: store().toPublic(existing) });
  }

  // A shopper-funded record can't silently become GetMe-funded (or back)
  if (existing && existing.funded_by !== attempt.funding) {
    throw error(409, 'This shop already has a payment recorded with another kind of funds. Ask GetMe support.', 'FUNDING_MISMATCH');
  }

  const reservation = (await client.query('SELECT * FROM grocery_reservations WHERE id = $1 FOR UPDATE', [attempt.reservation_id])).rows[0];
  const limit = round2(reservation?.limit_amount ?? attempt.limit_amount);
  const overLimit = amount > limit + 0.005;
  const variance = round2(amount - expected);
  const needsReview = overLimit || Math.abs(variance) > store().reviewTolerance(expected);
  const reviewNote = overLimit ? `Rs ${amount.toFixed(2)} is over the spending limit of Rs ${limit.toFixed(2)}` : null;
  const funding = attempt.funding;

  const row = (
    await client.query(
      `
      INSERT INTO store_payments (
        order_id, shop_id, shopper_id, method, amount_paid, expected_amount,
        variance, reference, note, review_status, review_note, reimbursement_status,
        funded_by, attempt_id, card_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (order_id, shop_id) DO UPDATE SET
        method = EXCLUDED.method,
        amount_paid = EXCLUDED.amount_paid,
        expected_amount = EXCLUDED.expected_amount,
        variance = EXCLUDED.variance,
        reference = EXCLUDED.reference,
        note = EXCLUDED.note,
        review_status = EXCLUDED.review_status,
        review_note = EXCLUDED.review_note,
        reimbursement_status = EXCLUDED.reimbursement_status,
        attempt_id = EXCLUDED.attempt_id,
        card_id = EXCLUDED.card_id,
        reviewed_by = NULL,
        reviewed_at = NULL,
        updated_at = NOW()
      RETURNING *
      `,
      [
        order.id,
        shopId,
        Number(attempt.shopper_id),
        attempt.method,
        amount,
        expected,
        variance,
        ref,
        clean(note, 300) || null,
        needsReview ? 'needs_review' : 'ok',
        reviewNote,
        funding === 'getme' ? 'company_paid' : 'pending',
        funding,
        Number(attempt.id),
        attempt.card_id,
      ]
    )
  ).rows[0];

  const wasPaid = attempt.status === 'succeeded';
  const before = attempt.amount != null ? round2(attempt.amount) : null;

  await client.query(
    `UPDATE grocery_payment_attempts
     SET status = 'succeeded', amount = $2, reference = $3, store_payment_id = $4, over_limit = $5,
         expected_amount = $6, limit_amount = $7, paid_at = COALESCE(paid_at, NOW()), updated_at = NOW()
     WHERE id = $1`,
    [attempt.id, amount, ref, row.id, overLimit, expected, limit]
  );

  if (reservation) {
    await client.query("UPDATE grocery_reservations SET captured_amount = $2, status = 'captured', updated_at = NOW() WHERE id = $1", [reservation.id, amount]);
  }

  if (!wasPaid) {
    await addEntry(client, {
      type: 'capture',
      orderId: order.id,
      shopId,
      shopperId: attempt.shopper_id,
      reservationId: attempt.reservation_id,
      attemptId: attempt.id,
      cardId: attempt.card_id,
      amount,
      actorType: 'shopper',
      actorId,
      note: `${store().METHOD_LABELS[attempt.method] || attempt.method}: paid Rs ${amount.toFixed(2)} (reported${overLimit ? ', over the limit' : ''})`,
    });
  } else if (before !== amount || (attempt.reference || null) !== ref) {
    await addEntry(client, {
      type: 'reconcile',
      orderId: order.id,
      shopId,
      shopperId: attempt.shopper_id,
      reservationId: attempt.reservation_id,
      attemptId: attempt.id,
      cardId: attempt.card_id,
      amount,
      actorType: 'shopper',
      actorId,
      note: `Corrected before the bill photo: Rs ${before?.toFixed(2)} -> Rs ${amount.toFixed(2)}`,
    });
  }

  await store().syncOrderReimbursement(client, order.id);

  return { row, needsReview, overLimit, created: !existing };
};

const finishAfterCommit = async (orderId, row, io) => {
  if (row) store().announce(io, row);
  await settlement().refreshOrderSettlement(orderId, io);
};

const paidMessage = (funding, needsReview, overLimit) =>
  funding === 'getme'
    ? overLimit
      ? 'Payment recorded. It is over the spending limit, so GetMe will check it. Upload the bill photo next.'
      : 'Payment recorded with the GetMe card. Upload the bill photo next.'
    : needsReview
    ? overLimit
      ? 'Payment recorded. It is over the spending limit, so GetMe will check the bill before paying you back after delivery.'
      : 'Payment recorded. The amount differs from the expected cost, so GetMe will check the bill before reimbursing you after delivery.'
    : 'Payment recorded. GetMe will reimburse you once the order is delivered.';

// POST /api/shopper/grocery-payment-attempts/:id/result
//   { outcome: 'paid', amountPaid, reference?, note? }
//   { outcome: 'failed', reason }
//   { outcome: 'reversed', reason }  (the till voided / refunded it before the bill was final)
const reportResult = async ({ shopperId, attemptId, outcome, amountPaid, reference, note, reason, io }) => {
  const client = await pool.connect();
  let result = {};

  try {
    const peek = (await client.query('SELECT order_id, shop_id FROM grocery_payment_attempts WHERE id = $1 AND shopper_id = $2', [Number(attemptId), Number(shopperId)])).rows[0];
    if (!peek) throw error(404, 'Payment not found', 'NOT_FOUND');

    // Order row first, then the attempt (same lock order as every path)
    await client.query('BEGIN');
    const order = await orderForShopper(client, peek.order_id, shopperId, peek.shop_id, { lock: true });
    const attempt = await lockAttempt(client, attemptId, shopperId);

    if (outcome === 'paid') {
      if (!['pending', 'succeeded'].includes(attempt.status)) {
        throw error(409, `This payment is ${ATTEMPT_LABELS[attempt.status].toLowerCase()}. Choose a payment method again.`, 'ATTEMPT_CLOSED');
      }
      const paid = await recordPaid(client, { order, attempt, amountPaid, reference, note, actorId: shopperId });
      result = { row: paid.row, message: paidMessage(attempt.funding, paid.needsReview, paid.overLimit), created: paid.created };
    } else if (outcome === 'failed') {
      const why = clean(reason, 300);
      if (attempt.status === 'failed') {
        result = { message: 'Already recorded as failed' };
      } else {
        if (attempt.status !== 'pending') throw error(409, 'Only a payment in progress can fail', 'ATTEMPT_CLOSED');
        if (why.length < 3) throw error(400, 'Say what happened (e.g. card declined, QR not working)', 'REASON_REQUIRED', { field: 'reason' });
        await client.query("UPDATE grocery_payment_attempts SET status = 'failed', failure_reason = $2, updated_at = NOW() WHERE id = $1", [attempt.id, why]);
        await addEntry(client, { type: 'attempt_failed', orderId: order.id, shopId: attempt.shop_id, shopperId, reservationId: attempt.reservation_id, attemptId: attempt.id, cardId: attempt.card_id, actorType: 'shopper', actorId: shopperId, note: why });
        result = { message: 'Marked as failed. Choose another payment method.' };
      }
    } else if (outcome === 'reversed') {
      const why = clean(reason, 300);
      if (why.length < 3) throw error(400, 'Say why the payment was reversed', 'REASON_REQUIRED', { field: 'reason' });
      result = await reverseAttempt(client, { order, attempt, why, actorType: 'shopper', actorId: shopperId });
    } else {
      throw error(400, 'Choose paid, failed or reversed', 'INVALID_OUTCOME');
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') throw error(409, 'This shop already has a payment', 'ALREADY_PAID');
    throw caught;
  } finally {
    client.release();
  }

  const attempt = await attemptView(pool, Number(attemptId));
  await finishAfterCommit(attempt.orderId, result.row, io);
  return { attempt: await attemptView(pool, Number(attemptId)), message: result.message, payment: store().toPublic(result.row), created: result.created };
};

// Money given back at the till before the bill photo made the record
// final: the store payment is removed, the reservation opens again.
const reverseAttempt = async (client, { order, attempt, why, actorType, actorId }) => {
  if (!['succeeded', 'disputed'].includes(attempt.status)) throw error(409, 'Only a completed payment can be reversed', 'ATTEMPT_CLOSED');

  const payment = attempt.store_payment_id
    ? (await client.query('SELECT * FROM store_payments WHERE id = $1 FOR UPDATE', [attempt.store_payment_id])).rows[0]
    : null;

  if (payment?.locked_at) {
    throw error(409, 'The bill photo is already uploaded, so this payment is final. GetMe support handles it as a dispute.', 'ALREADY_FINAL');
  }

  if (payment) {
    await client.query('UPDATE grocery_payment_attempts SET store_payment_id = NULL WHERE id = $1', [attempt.id]);
    await client.query('DELETE FROM store_payments WHERE id = $1', [payment.id]);
  }

  await client.query("UPDATE grocery_payment_attempts SET status = 'reversed', failure_reason = $2, updated_at = NOW() WHERE id = $1", [attempt.id, why]);
  await client.query("UPDATE grocery_reservations SET captured_amount = 0, status = 'active', updated_at = NOW() WHERE id = $1 AND status = 'captured'", [attempt.reservation_id]);
  await addEntry(client, {
    type: 'reverse',
    orderId: order.id,
    shopId: attempt.shop_id,
    shopperId: attempt.shopper_id,
    reservationId: attempt.reservation_id,
    attemptId: attempt.id,
    cardId: attempt.card_id,
    amount: attempt.amount,
    actorType,
    actorId,
    note: why,
  });
  await store().syncOrderReimbursement(client, order.id);

  return { message: 'Payment reversed. The shop can be paid again.' };
};

// POST /api/shopper/grocery-payment-attempts/:id/cancel
const cancelAttempt = async ({ shopperId, attemptId }) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const attempt = await lockAttempt(client, attemptId, shopperId);

    if (attempt.status === 'cancelled') {
      await client.query('COMMIT');
      return { attempt: await attemptView(pool, attempt.id), message: 'Already cancelled' };
    }
    if (attempt.status !== 'pending') {
      throw error(409, 'Only a payment in progress can be cancelled. A completed payment can be reversed if the till refunded it.', 'ATTEMPT_CLOSED');
    }

    await client.query("UPDATE grocery_payment_attempts SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [attempt.id]);
    await addEntry(client, { type: 'attempt_cancelled', orderId: attempt.order_id, shopId: attempt.shop_id, shopperId, reservationId: attempt.reservation_id, attemptId: attempt.id, cardId: attempt.card_id, actorType: 'shopper', actorId: shopperId, note: 'Cancelled before paying' });
    await client.query('COMMIT');
    return { attempt: await attemptView(pool, attempt.id), message: 'Cancelled. Choose a payment method again.' };
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }
};

// PUT /api/shopper/orders/:orderId/store-payment (phase 20 app
// versions): records the payment through an attempt so the ledger
// stays complete. Only the shopper-funded methods.
const legacyRecord = async ({ shopperId, orderId, shopId, method, amountPaid, reference, note, io }) => {
  if (!['cash', 'card', 'phone_wallet', 'lankaqr'].includes(method)) throw error(400, 'Choose how you paid', 'INVALID_METHOD');

  const client = await pool.connect();
  let paid;

  try {
    await client.query('BEGIN');
    const order = await orderForShopper(client, orderId, shopperId, shopId, { lock: true });
    await checkReadyToPay(client, order, Number(shopId));
    let attempt = await liveAttempt(client, order.id, Number(shopId), { lock: true });

    if (attempt && attempt.funding === 'getme') {
      throw error(409, 'This shop is being paid with the GetMe card. Report that payment instead.', 'FUNDING_MISMATCH');
    }

    if (attempt && attempt.method !== method) {
      if (attempt.status === 'pending') {
        await client.query("UPDATE grocery_payment_attempts SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [attempt.id]);
        await addEntry(client, { type: 'attempt_cancelled', orderId: order.id, shopId, shopperId, reservationId: attempt.reservation_id, attemptId: attempt.id, actorType: 'shopper', actorId: shopperId, note: `Changed to ${method}` });
        attempt = null;
      } else {
        // Corrected how they paid before the bill photo (own money)
        await client.query('UPDATE grocery_payment_attempts SET method = $2, updated_at = NOW() WHERE id = $1', [attempt.id, method]);
        await addEntry(client, { type: 'reconcile', orderId: order.id, shopId, shopperId, reservationId: attempt.reservation_id, attemptId: attempt.id, actorType: 'shopper', actorId: shopperId, note: `Method corrected: ${attempt.method} -> ${method}` });
        attempt.method = method;
      }
    }

    if (!attempt) attempt = await createAttempt(client, { order, shopId: Number(shopId), shopperId, method, requestId: null });

    paid = await recordPaid(client, { order, attempt, amountPaid, reference, note, actorId: shopperId });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  await finishAfterCommit(Number(orderId), paid.row, io);
  return { payment: paid.row, created: paid.created, message: paidMessage('shopper', paid.needsReview, paid.overLimit) };
};

module.exports = {
  LIVE,
  round2,
  error,
  clean,
  checkReference,
  loadSettings,
  limitFor,
  estimateFor,
  addEntry,
  cardBalance,
  syncOrder,
  availableMethods,
  publicReservation,
  publicAttempt,
  attemptView,
  paymentScreen,
  startAttempt,
  reportResult,
  reverseAttempt,
  cancelAttempt,
  legacyRecord,
  finishAfterCommit,
};
