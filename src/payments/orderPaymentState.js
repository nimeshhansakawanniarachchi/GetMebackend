const pool = require('../config/db');

// =====================================================
// ORDER PAYMENT STATE (what the shopper is shown)
// The customer's payment for each order, from the real records -
// never from the payment method alone:
//   card  -> card_payments (order + order_extra charges, refunds)
//   cash  -> shopper_earnings.cash_collected (recorded once, when
//            the delivery PIN is confirmed - settlementController)
// amountOwed is what the customer owes for the order now, the same
// formula as paymentService.owedForOrder (total less refunded items;
// a cancelled order owes only bought groceries / a failed delivery).
// Shopper earnings and grocery reimbursement are not part of it.
//
// status          label (shown as is)      meaning
// paid_online     PAID ONLINE              card holds what is owed
// partially_refunded PAID ONLINE · PART REFUNDED  some given back
// payment_pending PAYMENT PENDING          not charged yet / charge
//                                          or extra charge waiting
// payment_failed  PAYMENT FAILED           last charge declined and
//                                          the order isn't paid
// refunding       REFUNDING                card holds more than owed
// refunded        REFUNDED                 everything given back
// not_charged     NOT CHARGED              cancelled before charging
// cash_on_delivery CASH ON DELIVERY        collect cashToCollect
// cash_collected  CASH COLLECTED           recorded at delivery
// no_payment      NO PAYMENT DUE           cancelled cash order
// =====================================================

const ORDER_PURPOSES = ['order', 'order_extra'];
const HELD_STATUSES = ['paid', 'partially_refunded'];
const BOUGHT = ['found', 'replaced', 'done', 'completed'];

const LABELS = {
  paid_online: 'PAID ONLINE',
  partially_refunded: 'PAID ONLINE · PART REFUNDED',
  payment_pending: 'PAYMENT PENDING',
  payment_failed: 'PAYMENT FAILED',
  refunding: 'REFUNDING',
  refunded: 'REFUNDED',
  not_charged: 'NOT CHARGED',
  cash_on_delivery: 'CASH ON DELIVERY',
  cash_collected: 'CASH COLLECTED',
  no_payment: 'NO PAYMENT DUE',
};

const TONES = {
  paid_online: 'paid',
  partially_refunded: 'paid',
  payment_pending: 'pending',
  payment_failed: 'failed',
  refunding: 'refund',
  refunded: 'refund',
  not_charged: 'muted',
  cash_on_delivery: 'cash',
  cash_collected: 'paid',
  no_payment: 'muted',
};

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

// orders.status values after which the amount can't change any more
const FINAL_STATUSES = ['delivered', 'completed', 'cancelled'];

// Same as paymentService.owedForOrder, for many orders at once
const owedFor = (order, sums) => {
  if (order.status === 'cancelled') {
    const groceries = sums?.bought || 0;
    const delivery = order.failed_delivery_at ? Number(order.delivery_fee || 0) : 0;

    if (groceries <= 0 && delivery <= 0) {
      return 0;
    }

    const percent = Number(order.getme_fee_percent ?? 15);

    return round2(Math.min(Number(order.total_amount || 0), (groceries + delivery) * (1 + percent / 100)));
  }

  return round2(Math.max(0, Number(order.total_amount || 0) - (sums?.refunds || 0)));
};

const stateFor = (order, { sums, cards = [], earning }) => {
  const method = String(order.payment_method || '').toLowerCase() === 'cash' ? 'cash' : 'card';
  const owed = owedFor(order, sums);
  const cancelled = order.status === 'cancelled';
  const finalAmount = FINAL_STATUSES.includes(order.status);
  let status;
  let amountPaid = 0;
  let refunded = 0;
  let cashCollected = null;

  if (method === 'cash') {
    const collected = earning && ['due', 'deposited'].includes(earning.cash_status) ? round2(earning.cash_collected) : 0;

    if (collected > 0) {
      status = 'cash_collected';
      cashCollected = { amount: collected, at: earning.created_at || null, deposited: earning.cash_status === 'deposited' };
      amountPaid = collected;
    } else {
      status = cancelled ? 'no_payment' : 'cash_on_delivery';
    }
  } else {
    const held = cards.filter((row) => HELD_STATUSES.includes(row.status));
    const charged = round2(cards.filter((row) => [...HELD_STATUSES, 'refunded'].includes(row.status)).reduce((sum, row) => sum + Number(row.amount), 0));
    refunded = round2(cards.reduce((sum, row) => sum + Number(row.refunded_amount || 0), 0));
    amountPaid = round2(held.reduce((sum, row) => sum + Number(row.amount) - Number(row.refunded_amount || 0), 0));

    // A charge still waiting for PayHere (not one the app gave up on)
    const waiting = cards.some((row) => row.status === 'pending' && !row.abandoned_at);
    const latest = cards[cards.length - 1];

    if (charged <= 0) {
      status = waiting
        ? 'payment_pending'
        : latest?.status === 'failed' && !cancelled
          ? 'payment_failed'
          : cancelled
            ? 'not_charged'
            : 'payment_pending';
    } else if (amountPaid > owed + 0.009) {
      status = 'refunding';
    } else if (owed > amountPaid + 0.009) {
      // More is owed than the card holds (an extra not charged yet)
      status = waiting ? 'payment_pending' : latest?.status === 'failed' ? 'payment_failed' : 'payment_pending';
    } else if (refunded > 0 && amountPaid <= 0.009) {
      status = 'refunded';
    } else if (refunded > 0) {
      status = 'partially_refunded';
    } else {
      status = 'paid_online';
    }
  }

  const outstanding =
    method === 'cash'
      ? status === 'cash_on_delivery' ? owed : 0
      : round2(Math.max(0, owed - amountPaid));

  return {
    method,
    methodLabel: method === 'cash' ? 'Cash on delivery' : 'Card (online)',
    status,
    label: LABELS[status],
    tone: TONES[status],
    // What the customer owes for the order now
    amountOwed: owed,
    // Money GetMe holds from the customer (card net of refunds, or
    // cash recorded as collected)
    amountPaid,
    // Still to be paid by the customer: cash at the door, or an
    // online charge not taken yet. Never collect a card order in cash.
    outstanding,
    cashToCollect: status === 'cash_on_delivery' ? owed : null,
    cashCollected,
    refundedAmount: refunded,
    refundPending: method === 'card' ? round2(Math.max(0, amountPaid - owed)) : 0,
    // false while shopping can still change the amount
    final: finalAmount,
  };
};

// orders: rows with id, status, payment_method, total_amount,
// delivery_fee, getme_fee_percent, failed_delivery_at
// -> Map(orderId -> payment state)
const paymentStatesFor = async (orders, client = pool) => {
  const list = (orders || []).filter((order) => order && order.id != null);
  const ids = [...new Set(list.map((order) => Number(order.id)))];
  const states = new Map();

  if (ids.length === 0) {
    return states;
  }

  const [sumRows, cardRows, earningRows] = await Promise.all([
    client.query(
      `
      SELECT
        order_id,
        COALESCE(SUM(refund_amount) FILTER (WHERE shopping_status = 'refunded'), 0)::float AS refunds,
        COALESCE(SUM(COALESCE(price, 0) * COALESCE(quantity, 1)) FILTER (WHERE shopping_status = ANY($2)), 0)::float AS bought
      FROM order_items
      WHERE order_id = ANY($1)
      GROUP BY order_id
      `,
      [ids, BOUGHT]
    ),
    client.query(
      `
      SELECT order_id, status, amount, refunded_amount, abandoned_at, created_at
      FROM card_payments
      WHERE order_id = ANY($1) AND purpose = ANY($2) AND owner_type = 'customer'
      ORDER BY id
      `,
      [ids, ORDER_PURPOSES]
    ),
    client.query(
      'SELECT order_id, cash_collected, cash_status, created_at FROM shopper_earnings WHERE order_id = ANY($1)',
      [ids]
    ),
  ]);

  const sums = new Map(sumRows.rows.map((row) => [Number(row.order_id), row]));
  const earnings = new Map(earningRows.rows.map((row) => [Number(row.order_id), row]));
  const cards = new Map();

  cardRows.rows.forEach((row) => {
    const id = Number(row.order_id);
    if (!cards.has(id)) cards.set(id, []);
    cards.get(id).push(row);
  });

  list.forEach((order) => {
    const id = Number(order.id);
    states.set(id, stateFor(order, { sums: sums.get(id), cards: cards.get(id) || [], earning: earnings.get(id) }));
  });

  return states;
};

const paymentStateFor = async (order, client = pool) =>
  (await paymentStatesFor([order], client)).get(Number(order.id)) || null;

module.exports = {
  LABELS,
  paymentStatesFor,
  paymentStateFor,
};
