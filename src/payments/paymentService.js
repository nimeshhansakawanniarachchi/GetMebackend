const crypto = require('crypto');

const pool = require('../config/db');
const { broadcastOrderChange } = require('../realtime');

const gateway = require('./payhere');
const { encryptToken, decryptToken } = require('./cardVault');
// Phase 44: GetMe credit pays part of an order (credit first)
const orderCredit = require('./orderCredit');

// =====================================================
// SAVED CARDS + CARD PAYMENTS
// Tables: saved_cards, card_setups, card_payments,
// card_payment_refunds (sql/platform_phase17_saved_cards.sql).
// owner = { type: 'customer' | 'shopper', id }
//
// Socket events (live updates):
//   saved-cards-updated -> {type}:{id}            { cards }
//   payment-updated     -> {type}:{id}, order:{id} { orderId, payment }
//                          + admin / shop websites (broadcastOrderChange)
// =====================================================

const OWNER_TYPES = ['customer', 'shopper'];

// Charges that pay for a customer's order (store_bill is the shopper's)
const ORDER_PURPOSES = ['order', 'order_extra'];

// Payment statuses that still hold money
const HELD_STATUSES = ['paid', 'partially_refunded'];

const round2 = (value) => Math.round(Number(value) * 100) / 100;

// =====================================================
// PHASE 65: ONE CHARGE FOR A PARENT ORDER (order_groups)
// A parent order's card is charged once (purpose 'order_group'); each
// child order owns a share of it (card_payment_allocations). Wherever an
// order's card payments are counted, its share counts like a charge of
// its own: held = share - refunds made for this child. Refunds for a
// child go back through the shared charge, never more than its share
// (the refund request and refund rows remember the child: order_id).
// =====================================================

// The charges that pay for an order: its own charges + its share of a
// parent charge. -> [{ row, amount, refunded, forOrderId }] newest first.
// lock: FOR UPDATE on the payment rows (inside a transaction).
const orderChargeSources = async (client, orderId, { lock = false, statuses = HELD_STATUSES } = {}) => {
  const own = (
    await client.query(
      `
      SELECT * FROM card_payments
      WHERE order_id = $1 AND purpose = ANY($2) AND status = ANY($3)
      ORDER BY id DESC
      ${lock ? 'FOR UPDATE' : ''}
      `,
      [orderId, ORDER_PURPOSES, statuses]
    )
  ).rows.map((row) => ({ row, amount: Number(row.amount), refunded: Number(row.refunded_amount || 0), forOrderId: null }));

  const shared = (
    await client.query(
      `
      SELECT cp.*, a.amount AS share_amount,
             COALESCE((SELECT SUM(r.amount) FROM card_payment_refunds r
                       WHERE r.card_payment_id = cp.id AND r.order_id = a.order_id), 0) AS share_refunded
      FROM card_payment_allocations a
      JOIN card_payments cp ON cp.id = a.card_payment_id
      WHERE a.order_id = $1 AND cp.status = ANY($2)
      ORDER BY cp.id DESC
      ${lock ? 'FOR UPDATE OF cp' : ''}
      `,
      [orderId, statuses]
    )
  ).rows.map(({ share_amount: share, share_refunded: shareRefunded, ...row }) => ({
    row,
    amount: Number(share),
    refunded: Number(shareRefunded || 0),
    forOrderId: Number(orderId),
  }));

  // Newest first: the order's own later charges (extras) go back before its share
  return [...own, ...shared].sort((a, b) => Number(b.row.id) - Number(a.row.id));
};

// Refund from one source: an order's own charge, or its share of a parent charge
const refundSource = async (client, source, amount, reason) => {
  const room = round2(source.amount - source.refunded);
  const value = round2(Math.min(amount, room));
  if (!(value > 0)) return 0;
  return refundPaymentRow(client, source.row, value, reason, source.forOrderId);
};

const newRef = (prefix) =>
  `${prefix}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

const isCardSetupRef = (ref) => /^GMC[0-9A-Z]+$/.test(String(ref || ''));
const isPaymentRef = (ref) => /^GMP[0-9A-Z]+$/.test(String(ref || ''));

const BRAND_LABELS = { VISA: 'Visa', MASTER: 'Mastercard', AMEX: 'Amex' };

const cardLabel = (brand, last4) =>
  `${BRAND_LABELS[String(brand || '').toUpperCase()] || 'Card'} •••• ${last4 || '----'}`;

// MMYY in the past (cards expire at the end of the month)
const isExpired = (expiry) => {
  const match = String(expiry || '').match(/^(\d{2})(\d{2})$/);

  if (!match) {
    return false;
  }

  return new Date(2000 + Number(match[2]), Number(match[1]), 1) <= new Date();
};

// What the apps see. The token never leaves the server.
const toPublicCard = (row) => ({
  id: Number(row.id),
  brand: row.card_brand,
  last4: row.card_last4,
  label: cardLabel(row.card_brand, row.card_last4),
  holderName: row.card_holder_name,
  expiry: row.card_expiry
    ? `${row.card_expiry.slice(0, 2)}/${row.card_expiry.slice(2)}`
    : null,
  expired: isExpired(row.card_expiry),
  isDefault: Boolean(row.is_default),
  createdAt: row.created_at,
});

const toPublicPayment = (row, refunds = []) => ({
  id: Number(row.id),
  ref: row.ref,
  purpose: row.purpose,
  orderId: row.order_id != null ? Number(row.order_id) : null,
  shopId: row.shop_id != null ? Number(row.shop_id) : null,
  amount: Number(row.amount),
  currency: row.currency,
  status: row.status,
  statusMessage: row.status_message,
  transactionId: row.gateway_payment_id,
  refundedAmount: Number(row.refunded_amount || 0),
  card: row.card_last4
    ? { brand: row.card_brand, last4: row.card_last4, label: cardLabel(row.card_brand, row.card_last4) }
    : null,
  testMode: row.gateway === 'test',
  createdAt: row.created_at,
  paidAt: row.paid_at,
  refunds: refunds.map((refund) => ({
    id: Number(refund.id),
    amount: Number(refund.amount),
    reason: refund.reason,
    refundId: refund.gateway_refund_id,
    createdAt: refund.created_at,
  })),
});

// =====================================================
// SOCKET HELPERS (never throw)
// =====================================================

const emitCards = async (io, owner) => {
  try {
    if (io) {
      io.to(`${owner.type}:${owner.id}`).emit('saved-cards-updated', {
        cards: await listCards(owner),
      });
    }
  } catch (error) {
    console.error('❌ emitCards error:', error.message);
  }
};

const emitPayment = (io, row, extra = {}) => {
  try {
    if (!io || !row) {
      return;
    }

    const payload = {
      orderId: row.order_id != null ? Number(row.order_id) : null,
      shopId: row.shop_id != null ? Number(row.shop_id) : null,
      payment: toPublicPayment(row),
      ...extra,
    };

    io.to(`${row.owner_type}:${row.owner_id}`).emit('payment-updated', payload);

    if (row.order_id) {
      io.to(`order:${row.order_id}`).emit('payment-updated', payload);

      // The order's shopper too (payment badge on their screens);
      // shoppers aren't in the order room
      pool
        .query('SELECT shopper_id FROM orders WHERE id = $1', [row.order_id])
        .then((result) => {
          const shopperId = result.rows[0]?.shopper_id;

          if (shopperId && !(row.owner_type === 'shopper' && Number(row.owner_id) === Number(shopperId))) {
            // Only which order changed (not the customer's card); the
            // app reloads the order's paymentState
            io.to(`shopper:${shopperId}`).emit('payment-updated', { orderId: payload.orderId });
          }
        })
        .catch(() => {});

      broadcastOrderChange(io, row.order_id, {
        event: 'payment-updated',
        paymentStatus: row.status,
      });
    }
  } catch (error) {
    console.error('❌ emitPayment error:', error.message);
  }
};

// =====================================================
// SAVED CARDS
// =====================================================

const listCards = async (owner) => {
  const result = await pool.query(
    `
    SELECT *
    FROM saved_cards
    WHERE owner_type = $1 AND owner_id = $2 AND deleted_at IS NULL
    ORDER BY is_default DESC, created_at DESC
    `,
    [owner.type, owner.id]
  );

  return result.rows.map(toPublicCard);
};

// Active card row with its token (server use only)
const getOwnerCard = async (owner, cardId, client = pool) => {
  const result = await client.query(
    `
    SELECT *
    FROM saved_cards
    WHERE id = $1 AND owner_type = $2 AND owner_id = $3 AND deleted_at IS NULL
    LIMIT 1
    `,
    [Number(cardId), owner.type, owner.id]
  );

  return result.rows[0] || null;
};

const removeCard = async (owner, cardId, io) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const removed = await client.query(
      `
      UPDATE saved_cards
      SET deleted_at = NOW(), is_default = FALSE, token_encrypted = '', updated_at = NOW()
      WHERE id = $1 AND owner_type = $2 AND owner_id = $3 AND deleted_at IS NULL
      RETURNING is_default
      `,
      [Number(cardId), owner.type, owner.id]
    );

    if (removed.rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    // The newest card left becomes the default
    await client.query(
      `
      UPDATE saved_cards
      SET is_default = TRUE, updated_at = NOW()
      WHERE id = (
        SELECT id FROM saved_cards
        WHERE owner_type = $1 AND owner_id = $2 AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM saved_cards
        WHERE owner_type = $1 AND owner_id = $2 AND deleted_at IS NULL AND is_default
      )
      `,
      [owner.type, owner.id]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await emitCards(io, owner);

  return true;
};

const setDefaultCard = async (owner, cardId, io) => {
  const card = await getOwnerCard(owner, cardId);

  if (!card) {
    return false;
  }

  await pool.query(
    `
    UPDATE saved_cards
    SET is_default = (id = $3), updated_at = NOW()
    WHERE owner_type = $1 AND owner_id = $2 AND deleted_at IS NULL
    `,
    [owner.type, owner.id, Number(cardId)]
  );

  await emitCards(io, owner);

  return true;
};

// =====================================================
// ADD A CARD (PayHere Preapproval)
// =====================================================

const createCardSetup = async (owner) => {
  const ref = newRef('GMC');

  await pool.query(
    `
    INSERT INTO card_setups (ref, owner_type, owner_id, gateway)
    VALUES ($1, $2, $3, $4)
    `,
    [ref, owner.type, owner.id, gateway.getMode()]
  );

  return ref;
};

const getCardSetup = async (ref) => {
  const result = await pool.query('SELECT * FROM card_setups WHERE ref = $1 LIMIT 1', [
    String(ref || ''),
  ]);

  return result.rows[0] || null;
};

// Name, email, phone + address PayHere's page asks for
const getPayer = async (owner) => {
  const table = owner.type === 'shopper' ? 'shoppers' : 'customers';

  const person = (
    await pool.query(`SELECT full_name, email, mobile FROM ${table} WHERE id = $1`, [owner.id])
  ).rows[0];

  const address =
    owner.type === 'customer'
      ? (
          await pool.query(
            `
            SELECT address FROM customer_addresses
            WHERE customer_id = $1
            ORDER BY last_used_at DESC NULLS LAST, id DESC
            LIMIT 1
            `,
            [owner.id]
          )
        ).rows[0]?.address
      : null;

  const [firstName, ...rest] = String(person?.full_name || 'GetMe User').trim().split(/\s+/);
  const addressText = String(address || 'Sri Lanka').slice(0, 100);
  const parts = addressText.split(',').map((part) => part.trim()).filter(Boolean);

  return {
    firstName: firstName || 'GetMe',
    lastName: rest.join(' ') || firstName || 'User',
    email: person?.email || 'payments@getme.lk',
    phone: person?.mobile || '',
    address: addressText,
    city: (parts.length > 1 ? parts[parts.length - 1] : parts[0]) || 'Colombo',
  };
};

const finishSetup = (ref, status, message) =>
  pool.query(
    `
    UPDATE card_setups
    SET status = $2, status_message = $3, completed_at = NOW()
    WHERE ref = $1 AND status = 'pending'
    `,
    [ref, status, message || null]
  );

// PayHere (or the test page) says the card was approved. The same
// card added again replaces its old token instead of a duplicate.
const completeCardSetup = async ({ ref, token, brand, last4, holderName, expiry }, io) => {
  const client = await pool.connect();
  let setup;

  try {
    await client.query('BEGIN');

    setup = (
      await client.query('SELECT * FROM card_setups WHERE ref = $1 FOR UPDATE', [ref])
    ).rows[0];

    if (!setup || setup.status !== 'pending') {
      await client.query('ROLLBACK');
      return setup || null;
    }

    const owner = { type: setup.owner_type, id: setup.owner_id };
    const cleanLast4 = String(last4 || '').replace(/\D/g, '').slice(-4) || null;
    const cleanExpiry = String(expiry || '').replace(/\D/g, '').slice(0, 4) || null;
    const cleanBrand = String(brand || '').toUpperCase().slice(0, 20) || null;

    const existing = (
      await client.query(
        `
        SELECT id FROM saved_cards
        WHERE owner_type = $1 AND owner_id = $2 AND deleted_at IS NULL
          AND card_brand IS NOT DISTINCT FROM $3
          AND card_last4 IS NOT DISTINCT FROM $4
          AND card_expiry IS NOT DISTINCT FROM $5
        LIMIT 1
        `,
        [owner.type, owner.id, cleanBrand, cleanLast4, cleanExpiry]
      )
    ).rows[0];

    const hasDefault = (
      await client.query(
        `
        SELECT 1 FROM saved_cards
        WHERE owner_type = $1 AND owner_id = $2 AND deleted_at IS NULL AND is_default
        LIMIT 1
        `,
        [owner.type, owner.id]
      )
    ).rows.length > 0;

    let cardId;

    if (existing) {
      cardId = existing.id;

      await client.query(
        `
        UPDATE saved_cards
        SET token_encrypted = $2, gateway = $3, card_holder_name = $4, updated_at = NOW()
        WHERE id = $1
        `,
        [cardId, encryptToken(token), setup.gateway, holderName || null]
      );
    } else {
      cardId = (
        await client.query(
          `
          INSERT INTO saved_cards (
            owner_type, owner_id, gateway, token_encrypted,
            card_brand, card_last4, card_holder_name, card_expiry, is_default
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id
          `,
          [
            owner.type,
            owner.id,
            setup.gateway,
            encryptToken(token),
            cleanBrand,
            cleanLast4,
            String(holderName || '').slice(0, 120) || null,
            cleanExpiry,
            !hasDefault,
          ]
        )
      ).rows[0].id;
    }

    setup = (
      await client.query(
        `
        UPDATE card_setups
        SET status = 'saved', saved_card_id = $2, status_message = NULL, completed_at = NOW()
        WHERE ref = $1
        RETURNING *
        `,
        [ref, cardId]
      )
    ).rows[0];

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  await emitCards(io, { type: setup.owner_type, id: setup.owner_id });

  return setup;
};

// =====================================================
// CHARGE A SAVED CARD
// Writes the card_payments row on its own connection (it must
// survive the caller's rollback), then asks the gateway.
// -> the card_payments row; status 'paid' means the money is taken.
// Anything else: the payment did not go through (a 'pending' row
// is marked abandoned so a late success is refunded, see
// handlePaymentNotify).
// =====================================================

const chargeSavedCard = async ({
  owner,
  cardId,
  amount,
  purpose,
  orderId = null,
  shopId = null,
  // Phase 65: the parent order this one charge pays for (purpose 'order_group')
  orderGroupId = null,
  items,
  baseUrl,
  io,
}) => {
  const problem = gateway.configProblem();

  if (problem) {
    const error = new Error(problem);
    error.status = 503;
    throw error;
  }

  const card = await getOwnerCard(owner, cardId);

  if (!card) {
    const error = new Error('Choose a saved card to pay with');
    error.status = 400;
    throw error;
  }

  if (isExpired(card.card_expiry)) {
    const error = new Error(`${cardLabel(card.card_brand, card.card_last4)} has expired. Add a new card.`);
    error.status = 400;
    throw error;
  }

  if (card.gateway !== gateway.getMode()) {
    const error = new Error('This card was saved in a different payment mode. Add it again.');
    error.status = 400;
    throw error;
  }

  const value = round2(amount);

  if (!(value > 0)) {
    const error = new Error('Nothing to pay');
    error.status = 400;
    throw error;
  }

  const ref = newRef('GMP');

  let row = (
    await pool.query(
      `
      INSERT INTO card_payments (
        ref, owner_type, owner_id, purpose, order_id, shop_id,
        saved_card_id, gateway, amount, currency, card_brand, card_last4, order_group_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING *
      `,
      [
        ref,
        owner.type,
        owner.id,
        purpose,
        orderId,
        shopId,
        card.id,
        card.gateway,
        value,
        gateway.CURRENCY,
        card.card_brand,
        card.card_last4,
        orderGroupId,
      ]
    )
  ).rows[0];

  let outcome;

  try {
    outcome = await gateway.chargeToken({
      ref,
      amount: value,
      items,
      token: decryptToken(card.token_encrypted),
      baseUrl,
      custom1: purpose,
      custom2: orderId != null ? String(orderId) : null,
    });
  } catch (error) {
    console.error('❌ CARD CHARGE ERROR:', ref, error.message);
    outcome = { status: 'pending', gatewayPaymentId: null, message: 'No answer from PayHere' };
  }

  // No clear answer: ask PayHere about this order_id before deciding.
  // Paid -> it counts; otherwise it stays pending + abandoned, and a
  // late success (notify) is refunded, so a retry can't double-charge
  if (outcome.status === 'pending') {
    const found = await gateway.findCharge({ ref, amount: value });

    if (found.status === 'paid') {
      outcome = {
        status: 'paid',
        gatewayPaymentId: found.gatewayPaymentId,
        message: 'Confirmed with PayHere',
      };
    }
  }

  // Only while still pending: PayHere's notify may have settled the
  // charge while we waited, and its answer must not be overwritten
  const settled = (
    await pool.query(
      `
      UPDATE card_payments
      SET
        status = $2::varchar,
        gateway_payment_id = $3,
        status_message = $4,
        paid_at = CASE WHEN $2::varchar = 'paid' THEN NOW() ELSE paid_at END,
        gateway_fee = CASE WHEN $2::varchar = 'paid' THEN $5::numeric ELSE gateway_fee END,
        abandoned_at = CASE WHEN $2::varchar = 'pending' THEN NOW() ELSE abandoned_at END,
        updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *
      `,
      [
        row.id,
        outcome.status,
        outcome.gatewayPaymentId,
        String(outcome.message || '').slice(0, 300),
        gateway.gatewayFeeFor(value),
      ]
    )
  ).rows[0];

  row = settled || (await pool.query('SELECT * FROM card_payments WHERE id = $1', [row.id])).rows[0];

  console.log('💳 CARD CHARGE:', {
    ref,
    purpose,
    orderId,
    amount: value,
    status: row.status,
    transactionId: row.gateway_payment_id,
  });

  emitPayment(io, row);

  return row;
};

// Message for a charge that didn't go through
const declineMessage = (row) => {
  if (row.status === 'pending') {
    return 'We could not confirm the payment with your bank. You were not charged; please try again.';
  }

  const detail = String(row.status_message || '').trim();

  return `Your card payment did not go through${detail ? ` (${detail})` : ''}. Try again or use another card.`;
};

// Link payments made before the order existed (Place order) to it
const attachPaymentToOrder = (paymentId, orderId, client = pool) =>
  client.query(
    'UPDATE card_payments SET order_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [paymentId, orderId]
  );

// =====================================================
// REFUND (part of) ONE PAYMENT
// Run with the payment row locked (client inside a transaction).
// -> refunded amount (0 when the gateway refused / didn't answer)
//
// Phase 55 (audit P-02): the refund request is written and committed
// on its own connection BEFORE PayHere is asked, and PayHere's answer
// is saved the same way. Writing the refund into card_payments happens
// in the caller's transaction; if that rolls back, the request stays
// 'succeeded' + not applied and is written later (next refund of the
// payment or the payment sweeper) - never refunded twice. A refund with
// no clear answer ('unknown') blocks more refunds of that payment until
// an admin checks the PayHere portal (resolveRefundRequest).
// =====================================================

// Writes one accepted refund into card_payments (once per request)
const applyRefundRequest = async (client, requestId) => {
  const request = (
    await client.query('SELECT * FROM card_payment_refund_requests WHERE id = $1 FOR UPDATE', [requestId])
  ).rows[0];

  if (!request || request.status !== 'succeeded' || request.applied_at) {
    return 0;
  }

  const inserted = (
    await client.query(
      `
      INSERT INTO card_payment_refunds (card_payment_id, amount, reason, gateway_refund_id, request_id, order_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
      RETURNING id
      `,
      [request.card_payment_id, request.amount, request.reason, request.gateway_refund_id, request.id, request.order_id ?? null]
    )
  ).rows[0];

  if (inserted) {
    await client.query(
      `
      UPDATE card_payments
      SET
        refunded_amount = LEAST(amount, refunded_amount + $2::numeric),
        status = CASE WHEN refunded_amount + $2::numeric >= amount - 0.005 THEN 'refunded' ELSE 'partially_refunded' END,
        updated_at = NOW()
      WHERE id = $1
      `,
      [request.card_payment_id, request.amount]
    );
  }

  await client.query(
    'UPDATE card_payment_refund_requests SET applied_at = NOW(), updated_at = NOW() WHERE id = $1',
    [request.id]
  );

  return inserted ? round2(request.amount) : 0;
};

const applyAcceptedRefunds = async (client, paymentId) => {
  const pending = (
    await client.query(
      `SELECT id FROM card_payment_refund_requests
       WHERE card_payment_id = $1 AND status = 'succeeded' AND applied_at IS NULL ORDER BY id`,
      [paymentId]
    )
  ).rows;

  for (const request of pending) {
    await applyRefundRequest(client, request.id);
  }
};

// forOrderId (phase 65): the child order a refund of a shared parent charge is for
const refundPaymentRow = async (client, row, amount, reason, forOrderId = null) => {
  await applyAcceptedRefunds(client, row.id);

  const open = (
    await client.query(
      `SELECT id FROM card_payment_refund_requests
       WHERE card_payment_id = $1 AND status IN ('requested', 'unknown') LIMIT 1`,
      [row.id]
    )
  ).rows[0];

  if (open) {
    console.error('❌ CARD REFUND BLOCKED: an earlier refund has no answer yet', row.ref, open.id);
    return 0;
  }

  const current = (await client.query('SELECT * FROM card_payments WHERE id = $1', [row.id])).rows[0] || row;
  const remaining = round2(Number(current.amount) - Number(current.refunded_amount || 0));
  const value = round2(Math.min(amount, remaining));

  if (!(value > 0) || !current.gateway_payment_id) {
    return 0;
  }

  const full = Math.abs(value - Number(current.amount)) < 0.005;
  const why = String(reason || '').slice(0, 300) || null;

  // Committed before PayHere is asked (own connection; the table has no
  // FK so this insert doesn't wait on the caller's row lock)
  const request = (
    await pool.query(
      `INSERT INTO card_payment_refund_requests (card_payment_id, amount, full_refund, reason, order_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [current.id, value, full, why, forOrderId]
    )
  ).rows[0];

  let result;

  try {
    result = await gateway.refundCharge({
      gatewayPaymentId: current.gateway_payment_id,
      amount: full ? undefined : value,
      reason,
    });
  } catch (error) {
    result = { ok: false, unknown: true, refundId: null, message: error.message };
  }

  const outcome = result.ok ? 'succeeded' : result.unknown ? 'unknown' : 'refused';

  await pool.query(
    `UPDATE card_payment_refund_requests
     SET status = $2, gateway_refund_id = $3, gateway_message = $4, updated_at = NOW()
     WHERE id = $1`,
    [request.id, outcome, result.refundId || null, String(result.message || '').slice(0, 300)]
  );

  if (!result.ok) {
    console.error(`❌ CARD REFUND ${outcome.toUpperCase()}:`, current.ref, result.message);
    if (result.unknown) {
      await alertFinance({
        event: 'payment.refund_unknown',
        severity: 'critical',
        title: `No answer from PayHere for a refund of ${current.ref}`,
        body: `Rs ${value.toFixed(2)}. Check the PayHere portal and record the outcome in Payments.`,
        orderId: current.order_id ?? forOrderId,
        dedupe: `payment.refund_unknown:${request.id}`,
      });
    }
    return 0;
  }

  const applied = await applyRefundRequest(client, request.id);

  console.log('💳 CARD REFUND:', { ref: current.ref, amount: value, refundId: result.refundId });

  return applied;
};

// Admin: the outcome of a refund PayHere didn't answer, as checked in the
// PayHere merchant portal. -> { request } or { error }
const resolveRefundRequest = async (requestId, { outcome, gatewayRefundId, note }, adminId, io) => {
  const id = Number(requestId);
  const text = String(note || '').trim().slice(0, 300);
  const refundRef = String(gatewayRefundId || '').trim().slice(0, 64);

  if (!['refunded', 'not_refunded'].includes(outcome)) {
    return { error: { status: 400, message: 'Choose refunded or not_refunded' } };
  }

  if (text.length < 3) {
    return { error: { status: 400, message: 'Say what you found in the PayHere portal' } };
  }

  if (outcome === 'refunded' && refundRef.length < 3) {
    return { error: { status: 400, message: 'Enter the refund reference shown in the PayHere portal' } };
  }

  const client = await pool.connect();
  let request;
  let payment;

  try {
    await client.query('BEGIN');
    await setActor(client, `admin:${adminId}`, text);

    const found = (
      await client.query('SELECT card_payment_id FROM card_payment_refund_requests WHERE id = $1', [id])
    ).rows[0];

    if (!found) {
      await client.query('ROLLBACK');
      return { error: { status: 404, message: 'Refund request not found' } };
    }

    // Same lock order as refunds: payment row first
    payment = (
      await client.query('SELECT * FROM card_payments WHERE id = $1 FOR UPDATE', [found.card_payment_id])
    ).rows[0];

    request = (
      await client.query('SELECT * FROM card_payment_refund_requests WHERE id = $1 FOR UPDATE', [id])
    ).rows[0];

    if (!['requested', 'unknown'].includes(request.status)) {
      await client.query('ROLLBACK');
      return { error: { status: 409, message: 'This refund already has an outcome' } };
    }

    request = (
      await client.query(
        `UPDATE card_payment_refund_requests
         SET status = $2, gateway_refund_id = COALESCE($3, gateway_refund_id),
             resolved_by = $4, resolved_at = NOW(), resolved_note = $5, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id, outcome === 'refunded' ? 'succeeded' : 'refused', outcome === 'refunded' ? refundRef : null, adminId, text]
      )
    ).rows[0];

    if (outcome === 'refunded') {
      await applyRefundRequest(client, id);
    }

    if (payment.order_id) {
      await syncOrderPaymentColumns(client, payment.order_id);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ RESOLVE REFUND ERROR:', id, error.message);
    return { error: { status: 500, message: 'The refund could not be updated' } };
  } finally {
    client.release();
  }

  const row = (await pool.query('SELECT * FROM card_payments WHERE id = $1', [payment.id])).rows[0];
  emitPayment(io, row, { reason: 'refund' });

  return { request };
};

// Who / why for payment_status_events (phase 55), this transaction only
const setActor = (client, actor, reason = null) =>
  client.query("SELECT set_config('getme.actor', $1, true), set_config('getme.reason', $2, true)", [
    String(actor || 'system').slice(0, 40),
    reason ? String(reason).slice(0, 300) : '',
  ]);

const alertFinance = async ({ event, severity = 'warning', title, body, orderId, dedupe }) => {
  try {
    await require('../admin/notifications').notify({
      category: 'payments',
      event,
      severity,
      title,
      body,
      entityType: orderId ? 'order' : null,
      entityId: orderId || null,
      permissions: ['finance.view'],
      dedupe,
    });
  } catch (error) {
    console.error('❌ PAYMENT ALERT ERROR:', event, error.message);
  }
};

// Gives a whole charge back (e.g. the order could not be saved
// after the card was charged)
const refundWholePayment = async (paymentId, reason, io) => {
  const client = await pool.connect();
  let row;

  try {
    await client.query('BEGIN');

    row = (
      await client.query('SELECT * FROM card_payments WHERE id = $1 FOR UPDATE', [paymentId])
    ).rows[0];

    if (row && HELD_STATUSES.includes(row.status)) {
      await refundPaymentRow(client, row, Number(row.amount), reason);
    }

    row = (await client.query('SELECT * FROM card_payments WHERE id = $1', [paymentId])).rows[0];

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ REFUND WHOLE PAYMENT ERROR:', paymentId, error.message);
  } finally {
    client.release();
  }

  emitPayment(io, row);

  return row;
};

// =====================================================
// ORDER CARD PAYMENTS
// What the customer owes for an order (p = order.getme_fee_percent):
//   cancelled         -> groceries already bought x (1 + p)
//                        (0 when nothing was bought yet)
//   failed delivery   -> (groceries bought + delivery fee) x (1 + p)
//   otherwise         -> total_amount - refunded (unavailable) items
// Groceries bought = price x quantity of found / replaced items (the
// prices the customer was charged). Fees, priority and the tip are
// refunded on a cancellation. Held = paid charges - refunds so far.
// =====================================================

// Price x quantity of the items the shopper bought
const boughtGroceries = async (client, orderId) =>
  Number(
    (
      await client.query(
        `
        SELECT COALESCE(SUM(COALESCE(price, 0) * COALESCE(quantity, 1)), 0)::float AS total
        FROM order_items
        WHERE order_id = $1
          AND shopping_status IN ('found', 'replaced', 'done', 'completed')
        `,
        [orderId]
      )
    ).rows[0].total
  ) || 0;

const owedForOrder = async (client, order) => {
  if (order.status === 'cancelled') {
    const groceries = await boughtGroceries(client, order.id);
    const delivery = order.failed_delivery_at ? Number(order.delivery_fee || 0) : 0;

    if (groceries <= 0 && delivery <= 0) {
      return 0;
    }

    const percent = Number(order.getme_fee_percent ?? 15);

    return round2(
      Math.min(
        Number(order.total_amount || 0),
        (groceries + delivery) * (1 + percent / 100)
      )
    );
  }

  const refunds = (
    await client.query(
      `
      SELECT COALESCE(SUM(refund_amount), 0)::float AS total
      FROM order_items
      WHERE order_id = $1 AND shopping_status = 'refunded'
      `,
      [order.id]
    )
  ).rows[0].total;

  return round2(Math.max(0, Number(order.total_amount || 0) - Number(refunds || 0)));
};

const heldForOrder = async (client, orderId) => {
  // Own charges + its share of a parent charge (phase 65)
  const sources = await orderChargeSources(client, orderId);
  const held = sources.reduce((sum, source) => sum + (source.amount - source.refunded), 0);

  return { held: round2(held), payments: sources.length };
};

// More the customer must approve before a change that raises the
// total (run inside the caller's transaction with the order row
// locked; newTotal = the order's total after the change).
// -> { cardPaid: false } for orders not paid by saved card
const extraChargeFor = async (client, order, newTotal) => {
  const { held, payments } = await heldForOrder(client, order.id);

  // Phase 44: a card order that GetMe credit covered in full was never
  // charged at booking; once booked, a later rise is charged to its card
  const creditOnlyBooked =
    payments === 0 && order.payment_method === 'card' && orderCredit.creditOf(order) > 0 &&
    !['pending_shopper_search', 'shopper_search_cancelled', 'cancelled'].includes(order.status);

  if (payments === 0 && !creditOnlyBooked) {
    return { cardPaid: false, extra: 0 };
  }

  const refunds = round2(
    Number(order.total_amount || 0) - (await owedForOrder(client, order))
  );

  // Credit pays its part first (phase 44)
  const extra = round2(Number(newTotal) - refunds - held - orderCredit.creditOf(order));

  if (creditOnlyBooked) {
    const saved = order.payment_card_id
      ? await getOwnerCard({ type: 'customer', id: Number(order.customer_id) }, Number(order.payment_card_id), client)
      : null;

    return {
      cardPaid: true,
      extra: extra > 0.009 ? extra : 0,
      cardId: saved ? Number(saved.id) : null,
      card: saved ? { brand: saved.card_brand, last4: saved.card_last4, label: cardLabel(saved.card_brand, saved.card_last4) } : null,
    };
  }

  // The card the order was paid with (latest charge, or its parent's charge)
  const card = (await orderChargeSources(client, order.id))[0]?.row || null;

  return {
    cardPaid: true,
    extra: extra > 0.009 ? extra : 0,
    cardId: card?.saved_card_id != null ? Number(card.saved_card_id) : null,
    card: card ? { brand: card.card_brand, last4: card.card_last4, label: cardLabel(card.card_brand, card.card_last4) } : null,
  };
};

// =====================================================
// BOOKING CHARGE
// Card orders aren't charged at Place order: the first charge is
// the whole order, when the customer books a vehicle (start-search).
// cardId: another saved card the customer picked after a decline.
// -> { needed: false } once the order is already paid (or not card),
//    { needed: true, extra, cardId, card } or { error }
// =====================================================

const bookingChargeFor = async (client, order, cardId = null) => {
  if (order.payment_method !== 'card') {
    return { needed: false };
  }

  const { payments } = await heldForOrder(client, order.id);

  if (payments > 0) {
    return { needed: false };
  }

  const owner = { type: 'customer', id: Number(order.customer_id) };
  const chosenId = Number(cardId) || Number(order.payment_card_id) || null;
  const card = chosenId ? await getOwnerCard(owner, chosenId, client) : null;

  if (!card) {
    return {
      error: {
        status: 400,
        code: 'CARD_REQUIRED',
        message: 'The card for this order is no longer saved. Choose another card to book.',
      },
    };
  }

  if (Number(card.id) !== Number(order.payment_card_id)) {
    await client.query('UPDATE orders SET payment_card_id = $2 WHERE id = $1', [order.id, card.id]);
  }

  // GetMe credit covers its part first (phase 44)
  const extra = orderCredit.moneyPart(await owedForOrder(client, order), order);

  return {
    needed: extra > 0.009,
    extra,
    cardId: Number(card.id),
    card: { brand: card.card_brand, last4: card.card_last4, label: cardLabel(card.card_brand, card.card_last4) },
  };
};

// The 402 answer asking the customer to approve a charge; the app
// asks, then repeats the request with authorizeCharge = amount.
const chargeApprovalNeeded = (res, charge, what, message) =>
  res.status(402).json({
    success: false,
    code: 'CARD_CHARGE_REQUIRED',
    message:
      message ||
      `${what} adds Rs ${charge.extra.toFixed(2)}. Approve charging ${charge.card?.label || 'your card'}?`,
    amount: charge.extra,
    card: charge.card,
  });

// The app approved exactly this amount
const chargeApproved = (body, charge) =>
  Math.abs(Number(body?.authorizeCharge) - charge.extra) < 0.009;

// Charges the approved extra for an order (inside the caller's
// transaction; nothing here touches the locked order row).
// -> { row } on success, { error } with the message to show
const chargeOrderExtra = async ({ order, charge, items, baseUrl, io, purpose = 'order_extra' }) => {
  if (!charge.cardId) {
    return { error: { status: 400, message: 'The card this order was paid with is no longer saved. Add it again.' } };
  }

  try {
    const row = await chargeSavedCard({
      owner: { type: 'customer', id: Number(order.customer_id) },
      cardId: charge.cardId,
      amount: charge.extra,
      purpose,
      orderId: Number(order.id),
      items,
      baseUrl,
      io,
    });

    if (row.status !== 'paid') {
      return { error: { status: 402, code: 'CARD_DECLINED', message: declineMessage(row) } };
    }

    return { row };
  } catch (error) {
    return { error: { status: error.status || 500, message: error.message } };
  }
};

// Keeps orders.payment_status / payment_id / paid_at in step with
// the card payments (admin finance reads these)
const syncOrderPaymentColumns = async (client, orderId) => {
  // Own charges + its share of a parent charge (phase 65), oldest first
  const sources = (
    await orderChargeSources(client, orderId, { statuses: ['paid', 'partially_refunded', 'refunded'] })
  ).reverse();
  const rows = sources.map((source) => source.row);

  if (rows.length === 0) {
    return;
  }

  const charged = round2(sources.reduce((sum, source) => sum + source.amount, 0));
  const refunded = round2(sources.reduce((sum, source) => sum + source.refunded, 0));

  const status =
    refunded <= 0.005 ? 'paid' : refunded >= charged - 0.005 ? 'refunded' : 'partially_refunded';

  await client.query(
    `
    UPDATE orders
    SET payment_status = $2, payment_id = $3, paid_at = COALESCE(paid_at, $4), updated_at = NOW()
    WHERE id = $1
    `,
    [orderId, status, rows[0].gateway_payment_id, rows[0].paid_at]
  );
};

// =====================================================
// RECONCILE AN ORDER'S CARD PAYMENTS
// Refunds whatever the card holds above what is owed: unavailable
// items, a cancelled order, a cheaper vehicle or delivery time.
// Call AFTER the change is committed (it locks the order row).
// Safe to call any number of times.
// =====================================================

const reconcileOrderPayments = async (orderId, { io, reason } = {}) => {
  const id = Number(orderId);

  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const client = await pool.connect();
  const changed = [];
  let creditReturnedTo = null;

  try {
    await client.query('BEGIN');

    const order = (
      await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])
    ).rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      return null;
    }

    // Phase 44: unused GetMe credit of a final order goes back (once)
    const credit = await orderCredit.settleOrderCredit(client, order);
    if (credit?.created) creditReturnedTo = Number(order.customer_id);

    const { held, payments } = await heldForOrder(client, id);

    if (payments === 0) {
      await client.query('COMMIT');
      if (creditReturnedTo) await orderCredit.emitCreditBalance(io, creditReturnedTo);
      return null;
    }

    // The card holds only its part: credit pays first (phase 44)
    let excess = round2(held - orderCredit.moneyPart(await owedForOrder(client, order), order));

    if (excess > 0.009) {
      // Newest charges are given back first (a share of a parent charge
      // gives back at most this order's share - phase 65)
      const sources = await orderChargeSources(client, id, { lock: true });

      const why =
        reason ||
        (order.status === 'cancelled' ? 'Order cancelled' : 'Order total went down');

      for (const source of sources) {
        if (excess <= 0.009) {
          break;
        }

        const refunded = await refundSource(client, source, excess, `GetMe order #${id}: ${why}`);

        if (refunded > 0) {
          excess = round2(excess - refunded);
          changed.push(source.row.id);
        }
      }

      await syncOrderPaymentColumns(client, id);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ RECONCILE ORDER PAYMENTS ERROR:', id, error.message);
    return null;
  } finally {
    client.release();
  }

  if (changed.length > 0) {
    const rows = (
      await pool.query('SELECT * FROM card_payments WHERE id = ANY($1)', [changed])
    ).rows;

    rows.forEach((row) => emitPayment(io, row, { reason: 'refund' }));
  }

  if (creditReturnedTo) await orderCredit.emitCreditBalance(io, creditReturnedTo);

  return { refundedPayments: changed.length };
};

// =====================================================
// ADMIN REFUND (disputed delivery, goodwill)
// Gives back up to what the card still holds for the order, newest
// charge first. -> { refunded } or { error }
// =====================================================

const refundOrderAmount = async (orderId, amount, reason, io) => {
  const id = Number(orderId);
  const wanted = round2(amount);

  if (!(wanted > 0)) {
    return { error: { status: 400, message: 'Enter an amount to refund' } };
  }

  const client = await pool.connect();
  const changed = [];
  let left = wanted;

  try {
    await client.query('BEGIN');

    // Same lock as reconcile, so the two can't refund the same money
    await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [id]);

    const { held } = await heldForOrder(client, id);

    if (wanted > held + 0.009) {
      await client.query('ROLLBACK');
      return {
        error: { status: 400, message: `Only Rs ${held.toFixed(2)} paid by card can still be refunded` },
      };
    }

    const sources = await orderChargeSources(client, id, { lock: true });

    for (const source of sources) {
      if (left <= 0.009) break;

      const refunded = await refundSource(client, source, left, reason);

      if (refunded > 0) {
        left = round2(left - refunded);
        changed.push(source.row.id);
      }
    }

    await syncOrderPaymentColumns(client, id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ ADMIN REFUND ERROR:', id, error.message);
    return { error: { status: 500, message: 'The refund could not be completed' } };
  } finally {
    client.release();
  }

  if (changed.length > 0) {
    const rows = (await pool.query('SELECT * FROM card_payments WHERE id = ANY($1)', [changed])).rows;
    rows.forEach((row) => emitPayment(io, row, { reason: 'refund' }));
  }

  const refunded = round2(wanted - left);

  return refunded > 0
    ? { refunded }
    : { error: { status: 502, message: 'PayHere did not accept the refund' } };
};

// Not awaited by request handlers: a slow gateway must not hold up
// the response; errors are logged inside
const reconcileInBackground = (orderId, options) => {
  reconcileOrderPayments(orderId, options).catch((error) =>
    console.error('❌ reconcileInBackground:', error.message)
  );
};

// =====================================================
// PAYMENT DETAILS FOR AN ORDER (customer's order page)
// =====================================================

const paymentsWithRefunds = async (rows) => {
  if (rows.length === 0) {
    return [];
  }

  const refunds = (
    await pool.query(
      'SELECT * FROM card_payment_refunds WHERE card_payment_id = ANY($1) ORDER BY id',
      [rows.map((row) => row.id)]
    )
  ).rows;

  return rows.map((row) =>
    toPublicPayment(
      row,
      refunds.filter((refund) => Number(refund.card_payment_id) === Number(row.id))
    )
  );
};

const orderPaymentSummary = async (order) => {
  const rows = (
    await pool.query(
      `
      SELECT * FROM card_payments
      WHERE order_id = $1 AND purpose = ANY($2) AND status <> 'pending'
      ORDER BY id
      `,
      [order.id, ORDER_PURPOSES]
    )
  ).rows;

  const transactions = await paymentsWithRefunds(rows);

  // Phase 65: this order's share of its parent order's one charge, shown
  // as the share (amount / refunds for this order only), marked shared
  const shares = (
    await pool.query(
      `
      SELECT cp.*, a.amount AS share_amount, og.reference AS group_reference
      FROM card_payment_allocations a
      JOIN card_payments cp ON cp.id = a.card_payment_id
      LEFT JOIN order_groups og ON og.id = cp.order_group_id
      WHERE a.order_id = $1 AND cp.status <> 'pending'
      ORDER BY cp.id
      `,
      [order.id]
    )
  ).rows;

  for (const share of shares) {
    const refunds = (
      await pool.query(
        'SELECT * FROM card_payment_refunds WHERE card_payment_id = $1 AND order_id = $2 ORDER BY id',
        [share.id, order.id]
      )
    ).rows;
    const refunded = round2(refunds.reduce((sum, refund) => sum + Number(refund.amount), 0));
    const amount = Number(share.share_amount);
    transactions.push({
      ...toPublicPayment({ ...share, amount, refunded_amount: refunded }, refunds),
      orderId: Number(order.id),
      // one card charge for the whole parent order; this is this order's part
      shared: true,
      groupReference: share.group_reference || null,
      chargeTotal: Number(share.amount),
      status: share.status === 'failed' ? 'failed' : refunded <= 0.005 ? 'paid' : refunded >= amount - 0.005 ? 'refunded' : 'partially_refunded',
    });
  }
  const settled = transactions.filter((payment) => payment.status !== 'failed');

  const charged = round2(settled.reduce((sum, payment) => sum + payment.amount, 0));
  const refunded = round2(settled.reduce((sum, payment) => sum + payment.refundedAmount, 0));
  const orderOwed = await owedForOrder(pool, order);
  // Phase 44: what the customer owes in money (GetMe credit pays first)
  const owed = orderCredit.moneyPart(orderOwed, order);
  const latestCard = [...settled].reverse().find((payment) => payment.card)?.card || null;

  return {
    orderId: Number(order.id),
    method: order.payment_method,
    status: order.payment_status || (settled.length > 0 ? 'paid' : 'unpaid'),
    paidByCard: settled.length > 0,
    amountCharged: charged,
    amountRefunded: refunded,
    netPaid: round2(charged - refunded),
    amountOwed: owed,
    // Phase 44: GetMe credit used on the order (owed before credit, credit
    // applied at checkout, credit given back once the order is final)
    orderOwed,
    creditApplied: orderCredit.creditOf(order),
    creditReturned: orderCredit.creditOf(order) > 0 ? await orderCredit.creditReturnedFor(pool, order.id) : 0,
    card: latestCard,
    transactions,
  };
};

// =====================================================
// PAYHERE NOTIFY FOR A CHARGE
// The Charging API answers at once; a notify only matters for a
// charge left pending. A success on an abandoned charge (the app
// was told it failed) is refunded straight away.
// =====================================================

// Phase 55 (audit P-01 / P-06): a verified notify for a row that is no
// longer pending - a success for a charge recorded as failed (PayHere
// took the money after we gave up), or a chargeback on a paid charge.
const handleSettledNotify = async (row, body, io) => {
  const code = String(body.status_code);

  if (code === '2' && row.status === 'failed') {
    const updated = (
      await pool.query(
        `
        UPDATE card_payments
        SET status = 'paid', gateway_payment_id = COALESCE($2, gateway_payment_id),
            status_message = $3, paid_at = NOW(), gateway_fee = $4::numeric,
            abandoned_at = COALESCE(abandoned_at, NOW()), late_success_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'failed'
        RETURNING *
        `,
        [
          row.id,
          body.payment_id || null,
          'PayHere confirmed this charge after it was recorded as failed',
          gateway.gatewayFeeFor(row.amount),
        ]
      )
    ).rows[0];

    if (updated) {
      console.error('⚠️ PAYHERE LATE SUCCESS on a failed charge, refunding:', row.ref);
      emitPayment(io, updated);
      await refundWholePayment(updated.id, 'Payment confirmed after it was recorded as failed', io);
      await alertFinance({
        event: 'payment.late_success',
        title: `Card charge ${row.ref} succeeded after it was recorded as failed`,
        body: 'It was refunded automatically. Check the refund in the PayHere portal.',
        orderId: row.order_id,
        dedupe: `payment.late_success:${row.id}`,
      });
    }
    return;
  }

  if (code === '-3' && ['paid', 'partially_refunded'].includes(row.status) && !row.chargeback_at) {
    await pool.query(
      `UPDATE card_payments SET chargeback_at = NOW(), chargeback_note = $2, updated_at = NOW()
       WHERE id = $1 AND chargeback_at IS NULL`,
      [row.id, String(body.status_message || 'Charged back by the card holder').slice(0, 300)]
    );
    console.error('⚠️ PAYHERE CHARGEBACK:', row.ref);
    await alertFinance({
      event: 'payment.chargeback',
      severity: 'critical',
      title: `Chargeback on card payment ${row.ref}`,
      body: `Rs ${Number(row.amount).toFixed(2)} was charged back by the card holder. Check the order and answer PayHere.`,
      orderId: row.order_id,
      dedupe: `payment.chargeback:${row.id}`,
    });
  }
};

const handlePaymentNotify = async (body, io) => {
  const row = (
    await pool.query('SELECT * FROM card_payments WHERE ref = $1 LIMIT 1', [body.order_id])
  ).rows[0];

  if (!row) {
    return;
  }

  if (Math.abs(Number(body.payhere_amount) - Number(row.amount)) > 0.009) {
    console.error('❌ PAYHERE NOTIFY AMOUNT MISMATCH:', row.ref, body.payhere_amount);
    return;
  }

  if (row.status !== 'pending') {
    await handleSettledNotify(row, body, io);
    return;
  }


  // 2 = success, 0 = still pending (PayHere notifies again when it
  // settles; marking it failed would ignore that later success),
  // anything else (-1 cancelled, -2 failed, -3 chargeback) = failed
  if (String(body.status_code) === '0') {
    return;
  }

  const status = String(body.status_code) === '2' ? 'paid' : 'failed';

  const updated = (
    await pool.query(
      `
      UPDATE card_payments
      SET
        status = $2::varchar,
        gateway_payment_id = COALESCE($3, gateway_payment_id),
        status_message = $4,
        paid_at = CASE WHEN $2::varchar = 'paid' THEN NOW() ELSE paid_at END,
        gateway_fee = CASE WHEN $2::varchar = 'paid' THEN $5::numeric ELSE gateway_fee END,
        updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING *
      `,
      [
        row.id,
        status,
        body.payment_id || null,
        String(body.status_message || '').slice(0, 300),
        gateway.gatewayFeeFor(row.amount),
      ]
    )
  ).rows[0];

  if (!updated) {
    return;
  }

  emitPayment(io, updated);

  if (status === 'paid' && updated.abandoned_at) {
    await refundWholePayment(updated.id, 'Payment confirmed late; order was not placed', io);
    return;
  }

  // Settled after its order was cancelled: give back what the
  // customer doesn't owe (the cancel's refund ran before this money
  // was in)
  if (status === 'paid' && updated.order_id) {
    const order = (
      await pool.query('SELECT status FROM orders WHERE id = $1', [updated.order_id])
    ).rows[0];

    if (order?.status === 'cancelled') {
      await reconcileOrderPayments(updated.order_id, {
        io,
        reason: 'Payment confirmed after the order was cancelled',
      });
    }
  }
};

// =====================================================
// SHOPPER: STORE BILL
// =====================================================

const storeBillPayment = async (orderId, shopId) => {
  const row = (
    await pool.query(
      `
      SELECT * FROM card_payments
      WHERE order_id = $1 AND shop_id = $2 AND purpose = 'store_bill'
        AND status IN ('paid', 'partially_refunded', 'refunded')
      ORDER BY id DESC
      LIMIT 1
      `,
      [orderId, shopId]
    )
  ).rows[0];

  return row ? (await paymentsWithRefunds([row]))[0] : null;
};

// =====================================================
// PAYMENT SWEEPER (phase 55, audit P-06 / P-17)
// Runs on the admin notification clock (every minute):
//  1. charges still 'pending' after 5 minutes (abandoned or not) are
//     looked up with PayHere's Retrieval API: paid -> recorded (and
//     refunded when the order never used it); no payment after 30
//     minutes -> failed (a later verified success is refunded by
//     handleSettledNotify)
//  2. refund requests PayHere never answered -> 'unknown' + alert
//  3. refunds PayHere accepted but not yet written -> written
//  4. card setups never finished after 30 minutes -> expired
// =====================================================

const sweepCardPayments = async (io) => {
  const mode = gateway.getMode();

  if (!mode) {
    return;
  }

  const stale = (
    await pool.query(
      `SELECT * FROM card_payments
       WHERE status = 'pending' AND gateway = $1
         AND created_at < NOW() - INTERVAL '5 minutes'
         AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '5 minutes')
       ORDER BY created_at
       LIMIT 20`,
      [mode]
    )
  ).rows;

  for (const row of stale) {
    const found = await gateway.findCharge({ ref: row.ref, amount: row.amount });

    if (found.status === 'paid') {
      const updated = (
        await pool.query(
          `UPDATE card_payments
           SET status = 'paid', gateway_payment_id = COALESCE($2, gateway_payment_id),
               status_message = 'Confirmed with PayHere (payment check)', paid_at = NOW(),
               gateway_fee = $3::numeric, last_checked_at = NOW(), status_checks = status_checks + 1,
               updated_at = NOW()
           WHERE id = $1 AND status = 'pending'
           RETURNING *`,
          [row.id, found.gatewayPaymentId, gateway.gatewayFeeFor(row.amount)]
        )
      ).rows[0];

      if (!updated) continue;
      emitPayment(io, updated);

      if (updated.abandoned_at || !updated.order_id) {
        await refundWholePayment(updated.id, 'Payment confirmed late; it was not used', io);
      } else {
        await syncOrderPaymentColumns(pool, updated.order_id);
        await reconcileOrderPayments(updated.order_id, { io, reason: 'Payment confirmed late' });
      }
      continue;
    }

    const oldEnough = Date.now() - new Date(row.created_at).getTime() > 30 * 60 * 1000;

    if (found.status === 'not_found' && oldEnough) {
      const failed = (
        await pool.query(
          `UPDATE card_payments
           SET status = 'failed', status_message = 'No payment found at PayHere',
               abandoned_at = COALESCE(abandoned_at, NOW()), last_checked_at = NOW(),
               status_checks = status_checks + 1, updated_at = NOW()
           WHERE id = $1 AND status = 'pending'
           RETURNING *`,
          [row.id]
        )
      ).rows[0];
      if (failed) emitPayment(io, failed);
      continue;
    }

    await pool.query(
      'UPDATE card_payments SET last_checked_at = NOW(), status_checks = status_checks + 1 WHERE id = $1',
      [row.id]
    );

    if (oldEnough) {
      await alertFinance({
        event: 'payment.unknown',
        severity: 'critical',
        title: `PayHere can't confirm card payment ${row.ref}`,
        body: `Rs ${Number(row.amount).toFixed(2)}, pending for over 30 minutes. Check it in the PayHere portal.`,
        orderId: row.order_id,
        dedupe: `payment.unknown:${row.id}`,
      });
    }
  }

  // 2. A refund call that never came back (server stopped mid-call)
  const silent = (
    await pool.query(
      `UPDATE card_payment_refund_requests
       SET status = 'unknown', gateway_message = 'No answer recorded from PayHere', updated_at = NOW()
       WHERE status = 'requested' AND created_at < NOW() - INTERVAL '3 minutes'
       RETURNING *`
    )
  ).rows;

  for (const request of silent) {
    await alertFinance({
      event: 'payment.refund_unknown',
      severity: 'critical',
      title: `No answer from PayHere for refund request #${request.id}`,
      body: `Rs ${Number(request.amount).toFixed(2)}. Check the PayHere portal and record the outcome in Payments.`,
      orderId: null,
      dedupe: `payment.refund_unknown:${request.id}`,
    });
  }

  // 3. Accepted refunds whose write was rolled back
  const unapplied = (
    await pool.query(
      `SELECT DISTINCT card_payment_id FROM card_payment_refund_requests
       WHERE status = 'succeeded' AND applied_at IS NULL LIMIT 20`
    )
  ).rows;

  for (const { card_payment_id: paymentId } of unapplied) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const payment = (
        await client.query('SELECT * FROM card_payments WHERE id = $1 FOR UPDATE', [paymentId])
      ).rows[0];
      await applyAcceptedRefunds(client, paymentId);
      if (payment?.order_id) await syncOrderPaymentColumns(client, payment.order_id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('❌ APPLY REFUND ERROR:', paymentId, error.message);
    } finally {
      client.release();
    }
  }

  // 4. Card setups nobody finished
  await pool.query(
    `UPDATE card_setups
     SET status = 'cancelled', expired_at = NOW(), status_message = 'Expired (not finished within 30 minutes)',
         completed_at = NOW()
     WHERE status = 'pending' AND created_at < NOW() - INTERVAL '30 minutes'`
  );
};

module.exports = {
  OWNER_TYPES,
  round2,
  cardLabel,
  isCardSetupRef,
  isPaymentRef,
  toPublicCard,
  toPublicPayment,
  emitPayment,
  listCards,
  getOwnerCard,
  removeCard,
  setDefaultCard,
  createCardSetup,
  getCardSetup,
  getPayer,
  finishSetup,
  completeCardSetup,
  chargeSavedCard,
  declineMessage,
  attachPaymentToOrder,
  refundWholePayment,
  owedForOrder,
  heldForOrder,
  orderChargeSources,
  extraChargeFor,
  bookingChargeFor,
  chargeApprovalNeeded,
  chargeApproved,
  chargeOrderExtra,
  syncOrderPaymentColumns,
  reconcileOrderPayments,
  reconcileInBackground,
  refundOrderAmount,
  orderPaymentSummary,
  handlePaymentNotify,
  storeBillPayment,
  // Phase 55
  setActor,
  resolveRefundRequest,
  sweepCardPayments,
  // tests only (e2e-payment-system-p55.js)
  __test_refundPaymentRow: refundPaymentRow,
};
