const pool = require('../config/db');

// =====================================================
// SUPERMARKET PAYMENT + GROCERY REIMBURSEMENT (shopper's view)
// GetMe's rules as built (storePaymentController / settlement):
//  - the shopper pays each supermarket's till upfront, with their
//    own cash, own card / phone wallet or LANKAQR, and records it
//    at checkout (store_payments.method). No shop has a set method
//    and GetMe issues no payment card.
//  - GetMe reimburses what was paid (not earnings): after the order
//    is delivered, once every store's bill is uploaded and its
//    amount approved (owed); a bill missing or under review is held.
//    The transfer is made by an admin by bank transfer - there is
//    no fixed payout date.
// Each order only ever shows the requesting shopper's own records.
//
// reimbursement.status  label
//   not_started    Pay the store at checkout      (before checkout)
//   not_recorded   Record what you paid           (shopping, none saved)
//   after_delivery GetMe repays you after delivery (recorded, not delivered)
//   awaiting_bill  Upload the store bill          (delivered, bill missing)
//   in_review      Bill amount under review       (admin review)
//   owed           Approved - GetMe will transfer (payable)
//   reimbursed     Reimbursed                     (bank transfer done)
//   none           Nothing to reimburse           (cancelled, nothing bought)
// =====================================================

// cash / card / lankaqr, as the Shopper App's checkout offers them
const { METHODS, METHOD_LABELS } = require('../controllers/storePaymentController');

const REIMBURSEMENT_LABELS = {
  not_started: 'Pay the store at checkout',
  not_recorded: 'Record what you paid at checkout',
  after_delivery: 'GetMe repays you after delivery',
  awaiting_bill: 'Upload the store bill',
  in_review: 'Bill amount under review',
  owed: 'Approved - GetMe will transfer',
  reimbursed: 'Reimbursed',
  none: 'Nothing to reimburse',
};

// Order statuses before the shopper reaches the till
const BEFORE_SHOPPING = ['pending_shopper_search', 'waiting_for_shopper', 'shopper_search_cancelled', 'shopper_accepted'];

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

const reimbursementFor = (order, allRows) => {
  const status = String(order.status || '');
  // Only the shopper's own money is reimbursed (GetMe card: phase 38)
  const rows = allRows.filter((row) => row.funded_by !== 'getme');

  if (allRows.length > 0 && rows.length === 0) return 'none';

  if (rows.length === 0) {
    if (status === 'cancelled') return 'none';
    return BEFORE_SHOPPING.includes(status) ? 'not_started' : 'not_recorded';
  }

  if (rows.every((row) => row.reimbursement_status === 'reimbursed')) return 'reimbursed';
  if (rows.some((row) => row.reimbursement_status === 'pending')) return 'after_delivery';
  if (rows.some((row) => row.reimbursement_status === 'held')) {
    return rows.some((row) => !row.locked_at) ? 'awaiting_bill' : 'in_review';
  }

  return 'owed';
};

// orders: rows with id, status, items_total; shopperId: the caller
// -> Map(orderId -> { supermarket, reimbursement })
const moneyFlowsFor = async (orders, shopperId, client = pool) => {
  const list = (orders || []).filter((order) => order && order.id != null);
  const ids = [...new Set(list.map((order) => Number(order.id)))];
  const flows = new Map();

  if (ids.length === 0) {
    return flows;
  }

  const rows = (
    await client.query(
      `
      SELECT sp.order_id, sp.shop_id, s.shop_name, sp.method, sp.amount_paid, sp.expected_amount,
             sp.locked_at, sp.review_status, sp.reimbursement_status, sp.reimbursed_at, sp.funded_by
      FROM store_payments sp
      LEFT JOIN shops s ON s.id = sp.shop_id
      WHERE sp.order_id = ANY($1) AND sp.shopper_id = $2
      ORDER BY sp.id
      `,
      [ids, Number(shopperId)]
    )
  ).rows;

  list.forEach((order) => {
    const id = Number(order.id);
    const mine = rows.filter((row) => Number(row.order_id) === id);
    const status = reimbursementFor(order, mine);
    const paid = round2(mine.reduce((sum, row) => sum + Number(row.amount_paid || 0), 0));
    const reimbursed = round2(
      mine.filter((row) => row.reimbursement_status === 'reimbursed').reduce((sum, row) => sum + Number(row.amount_paid || 0), 0)
    );

    flows.set(id, {
      supermarket: {
        // GetMe's rule: the shopper pays every store upfront
        payer: 'shopper',
        upfront: true,
        // The shopper's own-money methods; the GetMe card (phase 38) is
        // per shopper and shop (GET .../grocery-payment)
        methods: METHODS.map((key) => ({ key, label: METHOD_LABELS[key] })),
        // Groceries at the customer's prices when placed (an estimate
        // of the till total; the bill decides)
        groceryEstimate: round2(order.items_total),
        // What the shopper recorded at each store's checkout
        stores: mine.map((row) => ({
          shopId: Number(row.shop_id),
          shopName: row.shop_name || null,
          method: row.method,
          methodLabel: METHOD_LABELS[row.method] || row.method,
          amountPaid: round2(row.amount_paid),
          billUploaded: !!row.locked_at,
          reviewStatus: row.review_status,
          reimbursementStatus: row.reimbursement_status,
        })),
      },
      reimbursement: {
        status,
        label: REIMBURSEMENT_LABELS[status],
        // Paid at the stores so far (what GetMe reimburses)
        amount: paid,
        reimbursedAmount: reimbursed,
        reimbursedAt: status === 'reimbursed' ? mine.map((row) => row.reimbursed_at).filter(Boolean).sort().pop() || null : null,
        rule: 'GetMe reimburses what you paid at the stores after delivery, once every store bill is uploaded and approved. Paid by bank transfer. Not part of your earnings.',
      },
    });
  });

  return flows;
};

module.exports = {
  REIMBURSEMENT_LABELS,
  moneyFlowsFor,
};
