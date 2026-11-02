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
// Phase 49: LANKAQR scan-to-pay from GetMe's account (provider state)
const qrProviders = require('./providers');
// Phase 50: the company bank account GetMe pays LankaQR from
const companyFunding = require('../companyAccounts/integration');
const settlement = () => require('../controllers/settlementController');

const ACTIVE_ORDER = (status) => !['cancelled', 'delivered', 'pending', 'pending_shopper_search'].includes(status);
// Phase 49: 'unknown' (the bank did not answer) is live too: no second
// payment for the shop until the provider says succeeded / failed
const LIVE = ['pending', 'succeeded', 'disputed', 'unknown'];
// Payment sent to a provider (LANKAQR): only the provider (or an admin
// with the bank statement) can close it
const SENT_TO_PROVIDER = (attempt) => Boolean(attempt?.provider && attempt?.initiated_at);
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
  // (Phase 49: not a payment already sent to the bank - money may have
  // moved; the provider status check closes it)
  if (finished && attempt?.status === 'pending' && !SENT_TO_PROVIDER(attempt)) {
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
  if (!finished && reservation.status === 'active' && !['pending', 'unknown'].includes(attempt?.status)) {
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
    // Phase 49: a provider / simulator confirmation is kept as it is
    const verification = ['statement', 'provider', 'simulator'].includes(attempt.verification)
      ? attempt.verification
      : attempt.locked_at
      ? 'receipt'
      : 'none';
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
    const order = (await client.query('SELECT id, status, shopper_id, business_type FROM orders WHERE id = $1 FOR UPDATE', [id])).rows[0];

    // Phase 59: clothing / restaurant orders: nothing is bought at a till
    if (order && order.business_type === 'grocery') {
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
  // Phase 56
  lankaqr_bank: 'Not available yet: no bank lets GetMe start LankaQR payments from your own account',
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

    // Phase 49: LANKAQR scan-to-pay from GetMe's company account. Needs
    // a usable provider (none in production today: DFCC has no API) +
    // the Super Admin switching it on; paid only through the scan flow
    if (row.key === 'getme_lankaqr') {
      const qr = qrProviders.current();
      if (!qr.usable) {
        entry('unavailable', NOT_INTEGRATED.getme_lankaqr);
        continue;
      }
      if (!on) {
        entry('unavailable', row.shop_enabled === false ? 'Not accepted at this store' : 'Not offered by GetMe right now');
        continue;
      }
      // Phase 50: needs an eligible company funding account
      const funding = await companyFunding.fundingFor('getme_lankaqr', client);
      if (!funding.eligible) {
        entry('unavailable', "Not available: GetMe's company account for LankaQR isn't ready");
        continue;
      }
      entry('available', null, {
        flow: 'lankaqr_scan',
        paymentSource: funding.label,
        simulator: qr.simulator,
        ...(qr.simulator ? { testNotice: 'TEST SIMULATOR — no money moves' } : {}),
      });
      continue;
    }

    // Phase 56: scan-to-pay from the shopper's own bank account through a
    // certified provider (none in production today; TEST SIMULATOR only)
    if (row.key === 'lankaqr_bank') {
      const qr = qrProviders.current();
      if (!qr.usable || !qr.provider.describe().capabilities?.payerFunded) {
        entry('unavailable', NOT_INTEGRATED.lankaqr_bank);
        continue;
      }
      if (!on) {
        entry('unavailable', row.shop_enabled === false ? 'Not accepted at this store' : 'Not offered by GetMe right now');
        continue;
      }
      entry('available', null, {
        flow: 'lankaqr_bank_scan',
        paymentSource: 'Your own bank account',
        simulator: qr.simulator,
        ...(qr.simulator ? { testNotice: 'TEST SIMULATOR — no money moves' } : {}),
      });
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
  unknown: 'Checking with the bank',
  rejected: 'Rejected by the bank',
};

// Phase 49: LANKAQR (GetMe pays) labels - only the provider confirms
const lankaqrLabel = (row) => {
  const sim = row.provider === 'simulator' ? 'TEST SIMULATOR · ' : '';
  const payer = row.method === 'lankaqr_bank';
  if (row.status === 'pending' && row.provider_status === 'action_required') return `${sim}Approve the payment at your bank`;
  if (row.status === 'pending') return `${sim}${row.initiated_at ? 'Sent to the bank · waiting' : 'Starting'}`;
  if (row.status === 'unknown') return `${sim}Checking with the bank…`;
  if (row.status === 'succeeded') {
    return row.provider === 'simulator'
      ? 'TEST SIMULATOR · paid · no money moved'
      : row.verification === 'statement'
      ? `Paid ${payer ? 'from your bank account' : 'by GetMe'} · verified with the bank`
      : `Paid ${payer ? 'from your bank account' : 'by GetMe'} · bank confirmed`;
  }
  return `${sim}${ATTEMPT_LABELS[row.status] || row.status}`;
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
        statusLabel: ['getme_lankaqr', 'lankaqr_bank'].includes(row.method) ? lankaqrLabel(row) :
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
        // Phase 54: the scanned till QR + the app the shopper paid with
        payerApp: row.payer_app || null,
        qrCheck: row.qr_check || null,
        paidAt: row.paid_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // Phase 49: provider (LANKAQR scan-to-pay). 'simulator' = TEST
        // SIMULATOR, no money moved, never bank-verified
        provider: row.provider || null,
        providerRef: row.provider_ref || null,
        providerStatus: row.provider_status || null,
        providerMessage: row.provider_message || null,
        simulator: row.provider === 'simulator',
        requestedAmount: row.requested_amount != null ? round2(row.requested_amount) : null,
        merchantId: row.merchant_id != null ? Number(row.merchant_id) : null,
        merchantName: row.lankaqr_merchant_name ?? null,
        merchantCity: row.lankaqr_merchant_city ?? null,
        qrKind: row.qr_kind || null,
        qrReference: row.qr_reference || null,
        // Phase 56: bill total typed before scanning; the bank's approval
        // page while the payer still has to approve
        billTotal: row.bill_total != null ? round2(row.bill_total) : null,
        payerAuth:
          row.status === 'pending' && row.provider_status === 'action_required' && row.payer_auth_url
            ? { url: row.payer_auth_url, expiresAt: row.payer_auth_expires_at || null }
            : null,
        // Phase 50: company account it paid from (snapshot; null before phase 50)
        fundingAccountId: row.funding_account_id != null ? Number(row.funding_account_id) : null,
        fundingAccountLabel: row.funding_account_label || null,
        sentToBank: Boolean(row.initiated_at),
        initiatedAt: row.initiated_at || null,
        lastCheckedAt: row.last_checked_at || null,
        statusChecks: row.status_checks != null ? Number(row.status_checks) : 0,
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
      : live.status === 'pending' || live.status === 'unknown'
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
      `SELECT a.*, m.label AS method_label, c.last4 AS card_last4,
              lm.merchant_name AS lankaqr_merchant_name, lm.merchant_city AS lankaqr_merchant_city
       FROM grocery_payment_attempts a
       JOIN grocery_payment_methods m ON m.key = a.method
       LEFT JOIN getme_cards c ON c.id = a.card_id
       LEFT JOIN shop_lankaqr_merchants lm ON lm.id = a.merchant_id
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
  // Phase 50: label of the company account GetMe pays LankaQR from
  const lankaqrSource = (await companyFunding.fundingFor('getme_lankaqr')).label;

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
    // Phase 49: LANKAQR scan-to-pay (GetMe pays) - no secrets
    lankaqr: (() => {
      const qr = qrProviders.current();
      const method = methods.catalogue.find((m) => m.key === 'getme_lankaqr');
      return {
        available: method?.availability === 'available',
        simulator: qr.usable && qr.simulator,
        notice: qr.usable && qr.simulator ? 'TEST SIMULATOR — no money moves' : null,
        paymentSource: lankaqrSource,
      };
    })(),
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
        `SELECT a.*, m.label AS method_label, c.last4 AS card_last4,
                lm.merchant_name AS lankaqr_merchant_name, lm.merchant_city AS lankaqr_merchant_city
         FROM grocery_payment_attempts a
         JOIN grocery_payment_methods m ON m.key = a.method LEFT JOIN getme_cards c ON c.id = a.card_id
         LEFT JOIN shop_lankaqr_merchants lm ON lm.id = a.merchant_id WHERE a.id = $1`,
        [id]
      )
    ).rows[0]
  );

// Inside a transaction with the order row locked
// Phase 55: company card spending controls GetMe sets per card (the
// bank's own card limits still apply on top). Amounts held by pending
// payments count, so two orders can't pass the same limit.
const COLOMBO_DAY = "date_trunc('day', NOW() AT TIME ZONE 'Asia/Colombo') AT TIME ZONE 'Asia/Colombo'";
const COLOMBO_MONTH = "date_trunc('month', NOW() AT TIME ZONE 'Asia/Colombo') AT TIME ZONE 'Asia/Colombo'";

const checkCardControls = async (client, card, holdAmount) => {
  if (card.expires_on && new Date(card.expires_on).getTime() < Date.now() - 24 * 60 * 60 * 1000) {
    throw error(409, 'Your GetMe card has expired. Ask GetMe for a new one.', 'CARD_EXPIRED');
  }
  const categories = Array.isArray(card.allowed_categories) ? card.allowed_categories : ['grocery'];
  if (!categories.includes('grocery')) {
    throw error(409, "Your GetMe card isn't allowed for supermarket payments", 'CARD_CATEGORY');
  }
  if (card.per_payment_limit != null && holdAmount > Number(card.per_payment_limit) + 0.005) {
    throw error(409, `This payment (up to Rs ${holdAmount.toFixed(2)}) is above your GetMe card's limit of Rs ${Number(card.per_payment_limit).toFixed(2)} per payment. Ask GetMe support.`, 'CARD_PAYMENT_LIMIT');
  }
  const spent = async (since) =>
    round2(
      (
        await client.query(
          `SELECT COALESCE(SUM(CASE WHEN status IN ('succeeded', 'disputed', 'unknown') THEN COALESCE(amount, limit_amount)
                                    WHEN status = 'pending' THEN limit_amount ELSE 0 END), 0) AS total
           FROM grocery_payment_attempts WHERE card_id = $1 AND created_at >= ${since}`,
          [card.id]
        )
      ).rows[0].total
    );
  if (card.daily_limit != null && (await spent(COLOMBO_DAY)) + holdAmount > Number(card.daily_limit) + 0.005) {
    throw error(409, `This payment would pass your GetMe card's daily limit of Rs ${Number(card.daily_limit).toFixed(2)}. Ask GetMe support.`, 'CARD_DAILY_LIMIT');
  }
  if (card.monthly_limit != null && (await spent(COLOMBO_MONTH)) + holdAmount > Number(card.monthly_limit) + 0.005) {
    throw error(409, `This payment would pass your GetMe card's monthly limit of Rs ${Number(card.monthly_limit).toFixed(2)}. Ask GetMe support.`, 'CARD_MONTHLY_LIMIT');
  }
};

const createAttempt = async (client, { order, shopId, shopperId, method, requestId, platform, actor = 'shopper' }) => {
  const settings = await loadSettings(client);
  const reservation = await syncReservation(client, order, shopId, settings);
  if (!reservation) throw error(409, 'This order has no spending limit yet', 'NO_RESERVATION');

  const live = await liveAttempt(client, order.id, shopId, { lock: true });
  if (live) {
    // (phase 49: 'unknown' = a LankaQR payment the bank hasn't settled yet)
    const open = ['pending', 'unknown'].includes(live.status);
    throw error(
      409,
      open
        ? 'A payment is already in progress for this shop. Finish it first (report its result, cancel it, or wait for the bank).'
        : 'This shop is already paid for this order',
      open ? 'PAYMENT_IN_PROGRESS' : 'ALREADY_PAID',
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
    await checkCardControls(client, card, round2(reservation.limit_amount));
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
// =====================================================
// PHASE 54: "Pay by QR" with the shopper's own app (record-and-verify)
// The shopper scans the till's LankaQR in GetMe before paying with their
// own wallet / bank app (e.g. HelaPay in Helakuru). GetMe reads the QR,
// checks it belongs to this store and compares its amount with the
// expected bill. A QR approved for another store, or one that doesn't
// match the approved details, is refused; a store QR GetMe hasn't
// approved yet is allowed but flagged for review. Nothing here marks
// anything paid: the shopper reports the payment, the receipt and
// GetMe's reconciliation decide.
// =====================================================

const PAYER_APPS = ['helapay', 'bank_app', 'card', 'other'];

const tillQrCheck = async (client, shopId, qrPayload) => {
  const qr = require('./lankaqr');
  const lankaqrPayments = require('./lankaqrPayments');
  let parsed;
  try {
    parsed = qr.parse(String(qrPayload));
  } catch (caught) {
    throw error(400, "This isn't a valid LankaQR code. Scan the QR at the till again.", 'QR_INVALID', { reason: caught.code || null });
  }
  // Phase 56: CBSL's per-transaction LankaQR limit
  if (parsed.amount != null && parsed.amount > qr.MAX_AMOUNT) {
    throw error(400, `One LankaQR payment can be at most Rs ${qr.MAX_AMOUNT.toLocaleString('en-LK')} (CBSL limit)`, 'AMOUNT_OVER_CBSL_LIMIT');
  }
  const check = await lankaqrPayments.merchantCheck(client, shopId, parsed);
  if (!['APPROVED', 'MERCHANT_UNKNOWN', 'MERCHANT_PENDING'].includes(check.code)) {
    lankaqrPayments.refuseMerchant(check, parsed);
  }
  return { parsed, check };
};

const startAttempt = async ({ shopperId, orderId, shopId, method, requestId, platform, qrPayload, payerApp, billTotal }) => {
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

    // Phase 49: GetMe's LANKAQR is paid only through scan -> preview -> pay
    if (['getme_lankaqr', 'lankaqr_bank'].includes(String(method || ''))) {
      throw error(409, "Scan the store's LankaQR code in the app to pay with GetMe's account.", 'USE_LANKAQR_SCAN');
    }

    const order = await orderForShopper(client, orderId, shopperId, shopId, { lock: true });
    await checkReadyToPay(client, order, Number(shopId));

    if (payerApp != null && payerApp !== '' && !PAYER_APPS.includes(String(payerApp))) {
      throw error(400, 'Unknown payment app', 'BAD_PAYER_APP');
    }
    // Phase 56: bill total typed before scanning (optional)
    let bill = null;
    if (billTotal != null && billTotal !== '') {
      const text = String(billTotal).replace(/,/g, '').trim();
      if (!/^\d{1,9}(\.\d{1,2})?$/.test(text) || !(Number(text) > 0)) throw error(400, 'Enter the bill total in rupees (e.g. 4520.50)', 'INVALID_AMOUNT', { field: 'billTotal' });
      bill = round2(Number(text));
    }
    let till = null;
    if (qrPayload != null && qrPayload !== '') {
      if (String(method || '') !== 'lankaqr') throw error(400, 'A scanned QR goes with the LankaQR method', 'QR_NOT_FOR_METHOD');
      till = await tillQrCheck(client, Number(shopId), qrPayload);
    }

    const attempt = await createAttempt(client, { order, shopId: Number(shopId), shopperId, method: String(method || ''), requestId: key, platform });

    if (till || payerApp || bill) {
      // Phase 56: the QR amount is checked against the bill total when the
      // shopper typed it, else against the expected amount
      const expected = bill ?? round2(attempt.expected_amount);
      const qrAmount = till?.parsed.amount != null ? round2(till.parsed.amount) : null;
      const qrCheck = till
        ? {
            merchant: till.check.code,
            merchantName: till.parsed.merchantName,
            merchantCity: till.parsed.merchantCity,
            kind: till.parsed.kind,
            qrAmount,
            expectedAmount: expected,
            amountMatches: qrAmount == null ? null : Math.abs(qrAmount - expected) <= 0.01,
            billTotal: bill,
            // LankaQR v1.3: the reference label (62-05) is mandatory
            referenceLabelMissing: !till.parsed.referenceLabel,
            scannedAt: new Date().toISOString(),
          }
        : null;
      await client.query(
        `UPDATE grocery_payment_attempts
            SET qr_check = COALESCE($2, qr_check), payer_app = COALESCE($3, payer_app),
                qr_kind = COALESCE($4, qr_kind), qr_reference = COALESCE($5, qr_reference),
                requested_amount = COALESCE($6, requested_amount),
                merchant_id = COALESCE($7, merchant_id), bill_total = COALESCE($8, bill_total), updated_at = NOW()
          WHERE id = $1`,
        [
          attempt.id,
          qrCheck ? JSON.stringify(qrCheck) : null,
          payerApp || null,
          till?.parsed.kind || null,
          till ? clean(till.parsed.billNumber || till.parsed.referenceLabel || '', 60) || null : null,
          qrAmount,
          till?.check.code === 'APPROVED' ? till.check.merchant.id : null,
          bill,
        ]
      );
    }
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

// Phase 55: why a shopper-reported payment needs a person to check it
const SELF_REPORT_REVIEW_ABOVE = () => Number(process.env.GROCERY_SELF_REPORT_REVIEW_ABOVE) || 25000;
const NEW_SHOPPER_ORDERS = () => {
  const value = Number(process.env.GROCERY_REVIEW_NEW_SHOPPER_ORDERS);
  return Number.isFinite(value) && value >= 0 ? value : 3;
};

const selfReportRisks = async (client, attempt, amount) => {
  const reasons = [];

  if (attempt.method === 'lankaqr') {
    const check = attempt.qr_check || null;
    if (!check) reasons.push('LankaQR payment without a scanned till QR');
    else {
      if (check.merchant !== 'APPROVED') reasons.push(`Till QR is not an approved QR of this shop (${check.merchant})`);
      if (check.amountMatches === false) reasons.push('The amount in the till QR differs from the expected bill');
    }
  }
  // Phase 56: paid amount vs the bill total typed before scanning
  const bill = attempt.bill_total != null ? round2(attempt.bill_total) : attempt.qr_check?.billTotal ?? null;
  if (bill != null && Math.abs(bill - amount) > 0.01) reasons.push(`Paid Rs ${amount.toFixed(2)} but the bill total typed before paying was Rs ${bill.toFixed(2)}`);

  if (amount >= SELF_REPORT_REVIEW_ABOVE()) {
    reasons.push(`Rs ${amount.toFixed(2)} is above the self-reported limit of Rs ${SELF_REPORT_REVIEW_ABOVE().toFixed(2)}`);
  }

  const delivered = Number(
    (
      await client.query("SELECT COUNT(*)::int AS n FROM orders WHERE shopper_id = $1 AND status = 'delivered'", [
        attempt.shopper_id,
      ])
    ).rows[0]?.n || 0
  );
  if (delivered < NEW_SHOPPER_ORDERS()) reasons.push(`New shopper (${delivered} delivered orders): first payments are checked by GetMe`);

  return reasons;
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
  const funding = attempt.funding;
  // Phase 55 (payment audit P-07 / P-08): a payment the shopper reports
  // is auto-accepted (bill photo, amount within tolerance) only when
  // nothing about it is unusual; otherwise GetMe checks it before the
  // reimbursement can be withdrawn
  const reasons = [];
  if (overLimit) reasons.push(`Rs ${amount.toFixed(2)} is over the spending limit of Rs ${limit.toFixed(2)}`);
  if (funding === 'shopper') reasons.push(...(await selfReportRisks(client, attempt, amount)));
  const needsReview = reasons.length > 0 || Math.abs(variance) > store().reviewTolerance(expected);
  const reviewNote = reasons.length > 0 ? reasons.join('; ').slice(0, 300) : null;

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
const reportResult = async ({ shopperId, attemptId, outcome, amountPaid, reference, note, reason, io, payerApp }) => {
  const client = await pool.connect();
  let result = {};

  try {
    const peek = (await client.query('SELECT order_id, shop_id FROM grocery_payment_attempts WHERE id = $1 AND shopper_id = $2', [Number(attemptId), Number(shopperId)])).rows[0];
    if (!peek) throw error(404, 'Payment not found', 'NOT_FOUND');

    // Order row first, then the attempt (same lock order as every path)
    await client.query('BEGIN');
    const order = await orderForShopper(client, peek.order_id, shopperId, peek.shop_id, { lock: true });
    const attempt = await lockAttempt(client, attemptId, shopperId);

    // Phase 49: a LANKAQR payment from GetMe's account is confirmed only
    // by the provider (or an admin with the bank statement)
    if (attempt.provider) {
      throw error(409, 'Only the bank confirms this payment. Its status updates by itself.', 'PROVIDER_CONFIRMS', { attemptId: Number(attempt.id) });
    }

    if (outcome === 'paid' && payerApp != null && payerApp !== '') {
      if (!PAYER_APPS.includes(String(payerApp))) throw error(400, 'Unknown payment app', 'BAD_PAYER_APP');
      await client.query('UPDATE grocery_payment_attempts SET payer_app = $2 WHERE id = $1', [attempt.id, String(payerApp)]);
    }

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

    // Phase 49: sent to the bank -> can't be cancelled from the app
    if (SENT_TO_PROVIDER(attempt) && ['pending', 'unknown'].includes(attempt.status)) {
      throw error(409, "This payment was sent to the bank and can't be cancelled. Wait for its result.", 'PROVIDER_PAYMENT_OPEN');
    }

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

// GET /api/shopper/grocery-payments/history?page= (phase 54)
// The shopper's own supermarket payment attempts, newest first
const historyForShopper = async ({ shopperId, query }) => {
  const { readPage, pageMeta } = require('../utils/pagination');
  const paging = readPage(query);
  const total = (await pool.query('SELECT COUNT(*)::int AS n FROM grocery_payment_attempts WHERE shopper_id = $1', [shopperId])).rows[0].n;
  const rows = (
    await pool.query(
      `SELECT a.*, m.label AS method_label, c.last4 AS card_last4,
              lm.merchant_name AS lankaqr_merchant_name, lm.merchant_city AS lankaqr_merchant_city,
              s.shop_name
         FROM grocery_payment_attempts a
         JOIN grocery_payment_methods m ON m.key = a.method
         LEFT JOIN getme_cards c ON c.id = a.card_id
         LEFT JOIN shop_lankaqr_merchants lm ON lm.id = a.merchant_id
         LEFT JOIN shops s ON s.id = a.shop_id
        WHERE a.shopper_id = $1
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $2 OFFSET $3`,
      [shopperId, paging.pageSize, paging.offset]
    )
  ).rows;
  return {
    ...pageMeta(paging, total),
    attempts: rows.map((row) => ({ ...publicAttempt(row), shopName: row.shop_name || null, orderCode: `GETME-${row.order_id}` })),
  };
};

module.exports = {
  // phase 55 (tests + reuse)
  selfReportRisks,
  checkCardControls,
  // phase 54
  tillQrCheck,
  historyForShopper,
  LIVE,
  SENT_TO_PROVIDER,
  ATTEMPT_LABELS,
  // Phase 49 (lankaqrPayments.js)
  orderForShopper,
  checkReadyToPay,
  syncReservation,
  liveAttempt,
  shopStatesFor,
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
