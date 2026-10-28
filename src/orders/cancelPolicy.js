const { owedForOrder, round2 } = require('../payments/paymentService');
const orderCredit = require('../payments/orderCredit');

// =====================================================
// CUSTOMER CANCELLATION POLICY
// The one place that decides whether a customer may cancel an order
// and what it costs. The server always re-checks it (the app only
// uses it to show / hide the button and explain the outcome).
//
// Stages (from the order's status + data):
//   not_accepted  placed / finding a shopper     -> free
//   accepted      shopper accepted, not shopping -> free if
//                 settings.cancellation.afterAccept
//   shopping      shopping started               -> only if
//                 settings.cancellation.whileShopping AND paid by
//                 card (pays for items bought + GetMe fee, the rest
//                 refunded); otherwise "contact support"
//   delivery      out for delivery / at the door -> never
//   finished      delivered / cancelled          -> never
// Money after a cancel = paymentService.owedForOrder for a cancelled
// order (bought groceries x (1 + GetMe fee %), 0 if nothing bought).
// =====================================================

const REASONS = [
  { code: 'changed_mind', label: 'I changed my mind' },
  { code: 'ordered_by_mistake', label: 'I ordered by mistake' },
  { code: 'change_items', label: 'I want to change items or the address' },
  { code: 'taking_too_long', label: 'It is taking too long' },
  { code: 'found_elsewhere', label: 'I got the items elsewhere' },
  { code: 'other', label: 'Other reason', needsText: true },
];

const REASON_CODES = new Set(REASONS.map((reason) => reason.code));

const BOUGHT_STATUSES = ['found', 'replaced', 'done', 'completed'];

const stageOf = (order) => {
  const status = String(order?.status || '');

  if (['delivered', 'cancelled', 'shopper_search_cancelled'].includes(status)) return 'finished';
  if (['out_for_delivery', 'arrived'].includes(status)) return 'delivery';
  if (status === 'shopping' || (status === 'shopper_accepted' && order.shopping_started_at)) return 'shopping';
  if (status === 'shopper_accepted') return 'accepted';
  if (['pending_shopper_search', 'waiting_for_shopper'].includes(status) && !order.shopper_id) return 'not_accepted';

  return 'unknown';
};

const SUPPORT_MESSAGE =
  'Your shopper has started shopping, so this order can no longer be cancelled in the app. Message GetMe support and we will help.';

// -> { allowed, stage, code, message }
const customerCancelDecision = (order, settings) => {
  const stage = stageOf(order);
  const rules = settings?.cancellation || {};

  if (stage === 'finished') {
    return {
      allowed: false,
      stage,
      code: order.status === 'delivered' ? 'ALREADY_DELIVERED' : 'ALREADY_CANCELLED',
      message: order.status === 'delivered' ? 'This order was already delivered.' : 'This order is already cancelled.',
    };
  }

  if (stage === 'delivery') {
    return {
      allowed: false,
      stage,
      code: 'OUT_FOR_DELIVERY',
      message: 'Your order is on its way, so it can no longer be cancelled. Message GetMe support if there is a problem.',
    };
  }

  if (stage === 'not_accepted') {
    return { allowed: true, stage, code: 'FREE', message: 'No shopper has accepted yet, so cancelling is free.' };
  }

  if (stage === 'accepted') {
    return rules.afterAccept
      ? { allowed: true, stage, code: 'FREE', message: 'Your shopper has not started shopping yet, so cancelling is free.' }
      : { allowed: false, stage, code: 'CONTACT_SUPPORT', message: 'A shopper has accepted this order. Message GetMe support to cancel it.' };
  }

  if (stage === 'shopping') {
    if (!rules.whileShopping) {
      return { allowed: false, stage, code: 'CONTACT_SUPPORT', message: SUPPORT_MESSAGE };
    }

    // Items already bought must be paid for; a cash order has no way
    // to collect that, so support handles it
    if (order.payment_method !== 'card') {
      return { allowed: false, stage, code: 'CONTACT_SUPPORT', message: SUPPORT_MESSAGE };
    }

    return {
      allowed: true,
      stage,
      code: 'PAY_FOR_BOUGHT',
      message: 'Shopping has started. You pay for the items already bought (plus the GetMe fee); the rest is refunded.',
    };
  }

  return { allowed: false, stage, code: 'NOT_CANCELLABLE', message: 'This order cannot be cancelled now.' };
};

// Money position if this order were cancelled now (client = pool or
// a transaction client; nothing is written)
// -> { method, held, owedAfterCancel, refundDue, pendingCharges, itemsBought }
const cancelMoney = async (client, order) => {
  const [payments, bought] = await Promise.all([
    client.query(
      `
      SELECT
        COALESCE(SUM(amount - refunded_amount) FILTER (WHERE status IN ('paid', 'partially_refunded')), 0)::float AS held,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
      FROM card_payments
      WHERE order_id = $1 AND purpose IN ('order', 'order_extra')
      `,
      [order.id]
    ),
    client.query(
      'SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1 AND shopping_status = ANY($2)',
      [order.id, BOUGHT_STATUSES]
    ),
  ]);

  const held = round2(payments.rows[0].held);
  const owedAfterCancel = await owedForOrder(client, { ...order, status: 'cancelled', failed_delivery_at: null });
  // Phase 44: GetMe credit pays first; the card / cash only its part
  const moneyOwed = orderCredit.moneyPart(owedAfterCancel, order);

  return {
    method: order.payment_method,
    held,
    // In money (card / cash), after GetMe credit
    owedAfterCancel: moneyOwed,
    // Card money that goes back (PayHere confirms each refund)
    refundDue: round2(Math.max(0, held - moneyOwed)),
    // Phase 44: GetMe credit used on the order, and what goes back
    creditApplied: orderCredit.creditOf(order),
    creditBack: orderCredit.creditBackFor(owedAfterCancel, order),
    pendingCharges: payments.rows[0].pending,
    itemsBought: bought.rows[0].n,
  };
};

// Validated reason from the request body -> { code, text } | { error }
const readReason = (body) => {
  const code = String(body?.reasonCode || '').trim();
  const text = String(body?.reasonText || body?.reason || '').trim().slice(0, 500);

  // A written reason alone (older app builds send only that)
  // counts as "Other"
  if (!code && text.length >= 3) {
    return { code: 'other', text };
  }

  if (!REASON_CODES.has(code)) {
    return { error: 'Choose why you are cancelling' };
  }

  if (code === 'other' && text.length < 3) {
    return { error: 'Tell us briefly why you are cancelling' };
  }

  const label = REASONS.find((reason) => reason.code === code).label;

  return { code, text: code === 'other' ? text : text || label };
};

module.exports = {
  REASONS,
  stageOf,
  customerCancelDecision,
  cancelMoney,
  readReason,
};
