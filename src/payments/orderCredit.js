const pool = require('../config/db');

const { round2, balanceOf, returnCredit } = require('../support/credit');

// =====================================================
// GETME CREDIT ON AN ORDER (phase 44)
//
// orders.credit_applied = credit spent at Place order (a 'spent' entry,
// client_request_id 'order:<id>:credit-spent', written in the order's
// own transaction). GetMe funds it, like a promo discount: the order
// total, the GetMe fee and the shopper's earnings are the same as
// without credit; only what the customer pays in money is lower.
//
// Credit is used first: of what the customer owes for the order
// (paymentService.owedForOrder), credit covers up to credit_applied and
// the card / cash pays the rest:
//   card or cash part = max(0, owed - credit_applied)
//   credit returned   = max(0, credit_applied - owed)   (final orders)
// The card part follows the existing refund rules (reconcile refunds
// what the card holds above its part). Credit goes back once, when the
// order is final (cancelled by anyone, failed delivery, or delivered
// with a final bill below the credit): a 'reversed' entry with
// client_request_id 'order:<id>:credit-return'.
// =====================================================

const FINAL_STATUSES = ['cancelled', 'delivered'];

const spentRequestId = (orderId) => `order:${orderId}:credit-spent`;
const returnRequestId = (orderId) => `order:${orderId}:credit-return`;

const creditOf = (order) => round2(Math.max(0, Number(order?.credit_applied) || 0));

// What the customer pays in money (card / cash) when `owed` is owed
const moneyPart = (owed, order) => round2(Math.max(0, Number(owed || 0) - creditOf(order)));

// Credit the order doesn't need when `owed` is owed
const creditBackFor = (owed, order) => round2(Math.max(0, creditOf(order) - Math.max(0, Number(owed || 0))));

// Credit already returned to the customer for this order
const creditReturnedFor = async (client, orderId) =>
  round2(
    (
      await client.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM customer_credit_entries WHERE order_id = $1 AND kind = 'reversed' AND client_request_id = $2",
        [orderId, returnRequestId(orderId)]
      )
    ).rows[0].total
  );

// Inside the caller's transaction, with the order row locked (or just
// changed by it). Returns the unused credit once a final order no
// longer needs it. -> { returned, created, balance } | null
const settleOrderCredit = async (client, order) => {
  if (!order || creditOf(order) <= 0 || !FINAL_STATUSES.includes(order.status)) return null;

  // Lazy: paymentService requires this module
  const { owedForOrder } = require('./paymentService');
  const owed = await owedForOrder(client, order);
  const due = creditBackFor(owed, order);

  if (due <= 0.009) return { returned: 0, created: false, balance: null };

  const result = await returnCredit(client, {
    customerId: Number(order.customer_id),
    amount: due,
    orderId: Number(order.id),
    reason: order.status === 'cancelled' ? `Order #${order.id} cancelled` : `Order #${order.id} final bill lower than the credit used`,
    clientRequestId: returnRequestId(order.id),
  });

  return { returned: result.entry ? round2(result.entry.amount) : 0, created: result.created, balance: result.balance };
};

// Customer app: the new balance (room customer:{id})
const emitCreditBalance = async (io, customerId) => {
  try {
    if (!io || !customerId) return;
    io.to(`customer:${customerId}`).emit('credit-updated', { balance: await balanceOf(customerId) });
  } catch (error) {
    console.error('❌ credit-updated emit error:', error.message);
  }
};

// Own transaction (callers that already committed their change)
const settleOrderCreditById = async (orderId, io = null) => {
  const client = await pool.connect();
  let order = null;
  let result = null;

  try {
    await client.query('BEGIN');
    order = (await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [Number(orderId)])).rows[0];
    result = order ? await settleOrderCredit(client, order) : null;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ SETTLE ORDER CREDIT ERROR:', orderId, error.message);
    return null;
  } finally {
    client.release();
  }

  if (result?.created) await emitCreditBalance(io, order.customer_id);
  return result;
};

module.exports = {
  spentRequestId,
  returnRequestId,
  creditOf,
  moneyPart,
  creditBackFor,
  creditReturnedFor,
  settleOrderCredit,
  settleOrderCreditById,
  emitCreditBalance,
};
