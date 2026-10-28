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
        saved_card_id, gateway, amount, currency, card_brand, card_last4
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
// -> refunded amount (0 when the gateway refused)
// =====================================================

const refundPaymentRow = async (client, row, amount, reason) => {
  const remaining = round2(Number(row.amount) - Number(row.refunded_amount || 0));
  const value = round2(Math.min(amount, remaining));

  if (!(value > 0) || !row.gateway_payment_id) {
    return 0;
  }

  const full = Math.abs(value - Number(row.amount)) < 0.005;

  const result = await gateway.refundCharge({
    gatewayPaymentId: row.gateway_payment_id,
    amount: full ? undefined : value,
    reason,
  });

  if (!result.ok) {
    console.error('❌ CARD REFUND REFUSED:', row.ref, result.message);
    return 0;
  }

  await client.query(
    `
    INSERT INTO card_payment_refunds (card_payment_id, amount, reason, gateway_refund_id)
    VALUES ($1, $2, $3, $4)
    `,
    [row.id, value, String(reason || '').slice(0, 300) || null, result.refundId]
  );

  const refunded = round2(Number(row.refunded_amount || 0) + value);

  await client.query(
    `
    UPDATE card_payments
    SET
      refunded_amount = $2::numeric,
      status = CASE WHEN $2::numeric >= amount - 0.005 THEN 'refunded' ELSE 'partially_refunded' END,
      updated_at = NOW()
    WHERE id = $1
    `,
    [row.id, refunded]
  );

  console.log('💳 CARD REFUND:', { ref: row.ref, amount: value, refundId: result.refundId });

  return value;
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
  const result = await client.query(
    `
    SELECT COALESCE(SUM(amount - refunded_amount), 0)::float AS held,
           COUNT(*)::int AS payments
    FROM card_payments
    WHERE order_id = $1 AND purpose = ANY($2) AND status = ANY($3)
    `,
    [orderId, ORDER_PURPOSES, HELD_STATUSES]
  );

  return { held: round2(result.rows[0].held), payments: result.rows[0].payments };
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

  // The card the order was paid with (latest charge)
  const card = (
    await client.query(
      `
      SELECT saved_card_id, card_brand, card_last4
      FROM card_payments
      WHERE order_id = $1 AND purpose = ANY($2) AND status = ANY($3)
      ORDER BY id DESC
      LIMIT 1
      `,
      [order.id, ORDER_PURPOSES, HELD_STATUSES]
    )
  ).rows[0];

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
  const rows = (
    await client.query(
      `
      SELECT * FROM card_payments
      WHERE order_id = $1 AND purpose = ANY($2) AND status IN ('paid', 'partially_refunded', 'refunded')
      ORDER BY id
      `,
      [orderId, ORDER_PURPOSES]
    )
  ).rows;

  if (rows.length === 0) {
    return;
  }

  const charged = round2(rows.reduce((sum, row) => sum + Number(row.amount), 0));
  const refunded = round2(rows.reduce((sum, row) => sum + Number(row.refunded_amount || 0), 0));

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
      // Newest charges are given back first
      const rows = (
        await client.query(
          `
          SELECT * FROM card_payments
          WHERE order_id = $1 AND purpose = ANY($2) AND status = ANY($3)
          ORDER BY id DESC
          FOR UPDATE
          `,
          [id, ORDER_PURPOSES, HELD_STATUSES]
        )
      ).rows;

      const why =
        reason ||
        (order.status === 'cancelled' ? 'Order cancelled' : 'Order total went down');

      for (const row of rows) {
        if (excess <= 0.009) {
          break;
        }

        const refunded = await refundPaymentRow(client, row, excess, `GetMe order #${id}: ${why}`);

        if (refunded > 0) {
          excess = round2(excess - refunded);
          changed.push(row.id);
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

    const rows = (
      await client.query(
        `
        SELECT * FROM card_payments
        WHERE order_id = $1 AND purpose = ANY($2) AND status = ANY($3)
        ORDER BY id DESC
        FOR UPDATE
        `,
        [id, ORDER_PURPOSES, HELD_STATUSES]
      )
    ).rows;

    for (const row of rows) {
      if (left <= 0.009) break;

      const refunded = await refundPaymentRow(client, row, left, reason);

      if (refunded > 0) {
        left = round2(left - refunded);
        changed.push(row.id);
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

const handlePaymentNotify = async (body, io) => {
  const row = (
    await pool.query('SELECT * FROM card_payments WHERE ref = $1 LIMIT 1', [body.order_id])
  ).rows[0];

  if (!row || row.status !== 'pending') {
    return;
  }

  if (Math.abs(Number(body.payhere_amount) - Number(row.amount)) > 0.009) {
    console.error('❌ PAYHERE NOTIFY AMOUNT MISMATCH:', row.ref, body.payhere_amount);
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
};
