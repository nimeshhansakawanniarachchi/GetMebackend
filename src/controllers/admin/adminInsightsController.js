const pool = require('../../config/db');

const { statusLabel } = require('../../utils/orderStatus');
const { readPage, pageMeta } = require('../../utils/pagination');
const { EXPECTED_BY_SQL } = require('./adminOpsController');

// =====================================================
// FINANCE + REPORTS (all figures computed here, never in the browser)
//   GET /api/admin/finance/overview?from=&to=
//   GET /api/admin/finance/reconciliation?from=&to=&flag=all|mismatch|loss|unverified&page=
//   GET /api/admin/analytics?from=&to=&groupBy=day|week|month
//   GET /api/admin/export/:dataset?from=&to=   (text/csv)
//
// GetMe fee model (settlementController, finance_ledger):
//   customer pays  groceries + delivery + priority + service - discounts
//                  + GetMe fee (15% of that) + tip
//   shopper earns  delivery + priority + service (bought units) + 100% tip
//   GetMe keeps    the GetMe fee; it absorbs gateway fees, discounts
//                  and bills above the customer's prices
//   groceries      reimbursed to the shopper separately (store_payments)
// =====================================================

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isoDay = (date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

// from / to (inclusive days); defaults to the last 30 days, max 366
const readRange = (query, defaultDays = 30) => {
  const today = new Date();
  let to = DATE.test(query.to || '') ? query.to : isoDay(today);
  let from = DATE.test(query.from || '') ? query.from : isoDay(new Date(today.getTime() - (defaultDays - 1) * 86400000));

  if (from > to) [from, to] = [to, from];

  const spanDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;

  if (spanDays > 366) {
    from = isoDay(new Date(new Date(to).getTime() - 365 * 86400000));
  }

  return { from, to };
};

// SQL for "timestamp column within the range" with $a / $b params
const inRange = (column, a, b) => `${column} >= $${a}::date AND ${column} < $${b}::date + INTERVAL '1 day'`;

// =====================================================
// FINANCE OVERVIEW
// =====================================================

const LEDGER_ORDER = [
  ['customer_payment', 'Card payments received', 'in'],
  ['cash_collected', 'Cash collected by shoppers', 'in'],
  ['customer_refund', 'Refunds to customers', 'out'],
  ['gateway_fee', 'Payment gateway fees (PayHere)', 'out'],
  ['grocery_expense', 'Grocery cost paid at stores', 'accrual'],
  ['grocery_reimbursement', 'Verified grocery reimbursements', 'accrual'],
  ['delivery_fee', 'Delivery fees (shopper)', 'accrual'],
  ['priority_fee', 'Priority fees (shopper)', 'accrual'],
  ['service_fee', 'Service fees (shopper)', 'accrual'],
  ['tip', 'Tips (100% shopper)', 'accrual'],
  ['adjustment', 'Shopper adjustments', 'accrual'],
  ['commission', 'GetMe fee kept (commission)', 'accrual'],
  ['shopper_payout', 'Earnings paid to shoppers', 'out'],
  ['reimbursement_payout', 'Reimbursements paid to shoppers', 'out'],
  ['cash_deposit', 'Cash deposited by shoppers', 'in'],
  ['getme_net_revenue', 'GetMe net revenue', 'accrual'],
  // Phase 44: GetMe credit customers used on settled orders (GetMe pays
  // it, like a promo discount; already inside net revenue)
  ['credit_used', 'GetMe credit used by customers (GetMe cost)', 'accrual'],
];

const getFinanceOverview = async (req, res) => {
  try {
    const { from, to } = readRange(req.query);

    const [ledger, daily, liabilities, orders, check] = await Promise.all([
      pool.query(
        `
        SELECT entry_type, COALESCE(SUM(amount), 0)::float AS total, COUNT(*)::int AS entries
        FROM finance_ledger WHERE ${inRange('entry_at', 1, 2)}
        GROUP BY entry_type
        `,
        [from, to]
      ),
      pool.query(
        `
        SELECT to_char(day, 'YYYY-MM-DD') AS date,
          COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'customer_payment'), 0)::float AS card,
          COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'cash_collected'), 0)::float AS cash,
          COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'customer_refund'), 0)::float AS refunds,
          COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'commission'), 0)::float AS commission,
          COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'getme_net_revenue'), 0)::float AS net_revenue,
          COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type IN ('delivery_fee', 'priority_fee', 'service_fee', 'tip', 'adjustment')), 0)::float AS shopper_earnings,
          COALESCE(SUM(l.amount) FILTER (WHERE l.entry_type = 'grocery_expense'), 0)::float AS groceries
        FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS day
        LEFT JOIN finance_ledger l ON l.entry_at >= day AND l.entry_at < day + INTERVAL '1 day'
        GROUP BY day ORDER BY day
        `,
        [from, to]
      ),
      pool.query(
        `
        SELECT
          (SELECT COALESCE(SUM(net_amount), 0)::float FROM shopper_earnings WHERE status = 'awaiting_bills') AS earnings_awaiting,
          (SELECT COALESCE(SUM(net_amount), 0)::float FROM shopper_earnings WHERE status = 'payable') AS earnings_payable,
          (SELECT COALESCE(SUM(net_amount), 0)::float FROM shopper_earnings WHERE status = 'held') AS earnings_held,
          (SELECT COALESCE(SUM(amount_paid), 0)::float FROM store_payments WHERE reimbursement_status = 'pending') AS reimbursement_pending,
          (SELECT COALESCE(SUM(amount_paid), 0)::float FROM store_payments WHERE reimbursement_status = 'owed') AS reimbursement_owed,
          (SELECT COALESCE(SUM(amount_paid), 0)::float FROM store_payments WHERE reimbursement_status = 'held') AS reimbursement_held,
          (SELECT COALESCE(SUM(cash_collected), 0)::float FROM shopper_earnings WHERE cash_status = 'due') AS cash_due,
          (
            SELECT COALESCE(SUM(amount - refunded_amount), 0)::float FROM card_payments
            WHERE purpose IN ('order', 'order_extra') AND status = 'paid' AND abandoned_at IS NOT NULL
          ) AS refunds_to_make,
          -- Phase 43: unspent GetMe credit customers hold (shown on its own,
          -- not part of totalOwedByGetMe)
          (SELECT COALESCE(SUM(amount), 0)::float FROM customer_credit_entries) AS credit_outstanding
        `
      ),
      pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'delivered' AND ${inRange('delivered_at', 1, 2)})::int AS delivered,
          COALESCE(SUM(total_amount) FILTER (WHERE status = 'delivered' AND ${inRange('delivered_at', 1, 2)}), 0)::float AS order_value,
          COALESCE(SUM(items_total) FILTER (WHERE status = 'delivered' AND ${inRange('delivered_at', 1, 2)}), 0)::float AS items_value,
          COALESCE(SUM(discount_amount + COALESCE(window_discount, 0)) FILTER (WHERE status = 'delivered' AND ${inRange('delivered_at', 1, 2)}), 0)::float AS discounts,
          COALESCE(SUM(getme_fee) FILTER (WHERE status = 'delivered' AND ${inRange('delivered_at', 1, 2)}), 0)::float AS getme_fee_charged
        FROM orders
        `,
        [from, to]
      ),
      // Settled orders in the range: money in vs what it had to cover
      pool.query(
        `
        SELECT COUNT(*)::int AS orders,
               COUNT(*) FILTER (WHERE amount < 0)::int AS loss_orders,
               COALESCE(SUM(amount) FILTER (WHERE amount < 0), 0)::float AS loss_amount
        FROM finance_ledger
        WHERE entry_type = 'getme_net_revenue' AND ${inRange('entry_at', 1, 2)}
        `,
        [from, to]
      ),
    ]);

    const byType = Object.fromEntries(ledger.rows.map((row) => [row.entry_type, row]));
    const amount = (type) => round2(byType[type]?.total || 0);
    const l = liabilities.rows[0];
    const o = orders.rows[0];
    const c = check.rows[0];

    const shopperEarnings = round2(
      amount('delivery_fee') + amount('priority_fee') + amount('service_fee') + amount('tip') + amount('adjustment')
    );
    const moneyIn = round2(amount('customer_payment') + amount('cash_collected') - amount('customer_refund'));
    const obligations = round2(amount('grocery_reimbursement') + shopperEarnings + amount('gateway_fee'));

    return res.json({
      success: true,
      range: { from, to },
      categories: LEDGER_ORDER.map(([type, label, flow]) => ({
        type, label, flow, amount: amount(type), entries: byType[type]?.entries || 0,
      })),
      summary: {
        customerPaymentsNet: moneyIn,
        cardPayments: amount('customer_payment'),
        cashCollected: amount('cash_collected'),
        refunds: amount('customer_refund'),
        groceryCost: amount('grocery_expense'),
        groceryReimbursable: amount('grocery_reimbursement'),
        deliveryFees: amount('delivery_fee'),
        priorityFees: amount('priority_fee'),
        serviceFees: amount('service_fee'),
        tips: amount('tip'),
        adjustments: amount('adjustment'),
        shopperEarnings,
        commission: amount('commission'),
        gatewayFees: amount('gateway_fee'),
        netRevenue: amount('getme_net_revenue'),
        creditUsed: amount('credit_used'),
        shopperPayouts: amount('shopper_payout'),
        reimbursementPayouts: amount('reimbursement_payout'),
        cashDeposits: amount('cash_deposit'),
        delivered: o.delivered,
        orderValue: round2(o.order_value),
        itemsValue: round2(o.items_value),
        discounts: round2(o.discounts),
        getmeFeeCharged: round2(o.getme_fee_charged),
      },
      // Funds check: money collected vs what it must pay for
      sufficiency: {
        moneyIn,
        obligations,
        surplus: round2(moneyIn - obligations),
        sufficient: moneyIn - obligations >= -0.005,
        settledOrders: c.orders,
        lossOrders: c.loss_orders,
        lossAmount: round2(c.loss_amount),
      },
      liabilities: {
        earningsAwaitingBills: round2(l.earnings_awaiting),
        earningsPayable: round2(l.earnings_payable),
        earningsHeld: round2(l.earnings_held),
        reimbursementPending: round2(l.reimbursement_pending),
        reimbursementOwed: round2(l.reimbursement_owed),
        reimbursementHeld: round2(l.reimbursement_held),
        cashDueFromShoppers: round2(l.cash_due),
        refundsToMake: round2(l.refunds_to_make),
        creditOutstanding: round2(l.credit_outstanding),
        totalOwedByGetMe: round2(l.earnings_awaiting + l.earnings_payable + l.earnings_held + l.reimbursement_pending + l.reimbursement_owed + l.reimbursement_held + l.refunds_to_make),
      },
      daily: daily.rows.map((row) => ({
        date: row.date,
        card: round2(row.card),
        cash: round2(row.cash),
        refunds: round2(row.refunds),
        commission: round2(row.commission),
        netRevenue: round2(row.net_revenue),
        shopperEarnings: round2(row.shopper_earnings),
        groceries: round2(row.groceries),
      })),
    });
  } catch (error) {
    console.error('❌ admin getFinanceOverview error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load finance' });
  }
};

// =====================================================
// RECONCILIATION (one row per settled order)
// expected = what the customer owes (paymentService.owedForOrder):
//   delivered          total - refunded items
//   cancelled          min(total, (groceries bought [+ delivery if the
//                      delivery failed]) x (1 + p))
// collected = card charges - refunds + cash collected at the door
// goodwill  = refunds an admin gave (disputes); approved, so the
//             difference is collected - (expected - goodwill)
// goodwill  = refunds an admin gave (disputes); approved, so the
//             difference is collected - (expected - goodwill)
// =====================================================

const RECON_SQL = `
  WITH base AS (
    SELECT
      o.id, o.status, o.payment_method, o.payment_status, o.customer_id, o.shopper_id,
      COALESCE(o.delivered_at, o.updated_at) AS settled_at,
      o.total_amount::float AS total, o.tip_amount::float AS tip, o.getme_fee::float AS getme_fee,
      o.getme_fee_kept::float AS getme_fee_kept, o.failed_delivery_at,
      c.full_name AS customer_name, sh.full_name AS shopper_name,
      COALESCE(ri.refunds, 0)::float AS item_refunds,
      COALESCE(bg.groceries, 0)::float AS groceries_bought,
      COALESCE(cp.charged, 0)::float AS card_charged,
      COALESCE(cp.refunded, 0)::float AS card_refunded,
      COALESCE(cp.gateway, 0)::float AS gateway_fee,
      COALESCE(se.cash_collected, 0)::float AS cash_collected,
      -- Phase 44: GetMe credit that paid part of the order (applied - returned)
      GREATEST(0, o.credit_applied - COALESCE((
        SELECT SUM(ce.amount) FROM customer_credit_entries ce
        WHERE ce.order_id = o.id AND ce.kind = 'reversed' AND ce.client_request_id = 'order:' || o.id || ':credit-return'
      ), 0))::float AS credit_used,
      COALESCE(se.net_amount, 0)::float AS shopper_earnings,
      se.status AS earnings_status,
      COALESCE(sp.reimbursable, 0)::float AS groceries_reimbursable,
      COALESCE(sp.unverified, 0)::int AS bills_unverified,
      (
        SELECT COALESCE(SUM((a.details->>'amount')::numeric), 0) FROM admin_audit_log a
        WHERE a.action = 'order.refund' AND a.entity_type = 'order' AND a.entity_id = (o.id)::text
          AND (a.details->>'amount') ~ '^[0-9]+(\.[0-9]+)?$'
      )::float AS goodwill_refunds,
      CASE
        WHEN o.status = 'cancelled' THEN
          CASE WHEN COALESCE(bg.groceries, 0) + CASE WHEN o.failed_delivery_at IS NOT NULL THEN o.delivery_fee ELSE 0 END <= 0 THEN 0
               ELSE LEAST(o.total_amount,
                 (COALESCE(bg.groceries, 0) + CASE WHEN o.failed_delivery_at IS NOT NULL THEN o.delivery_fee ELSE 0 END)
                 * (1 + COALESCE(o.getme_fee_percent, 15) / 100.0))
          END
        ELSE GREATEST(0, o.total_amount - COALESCE(ri.refunds, 0))
      END::float AS expected
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN shoppers sh ON sh.id = o.shopper_id
    LEFT JOIN LATERAL (
      SELECT SUM(refund_amount) AS refunds FROM order_items
      WHERE order_id = o.id AND shopping_status = 'refunded'
    ) ri ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(COALESCE(price, 0) * COALESCE(quantity, 1)) AS groceries FROM order_items
      WHERE order_id = o.id AND shopping_status IN ('found', 'replaced', 'done', 'completed')
    ) bg ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(amount) AS charged, SUM(refunded_amount) AS refunded, SUM(gateway_fee) AS gateway
      FROM card_payments
      WHERE order_id = o.id AND purpose IN ('order', 'order_extra')
        AND paid_at IS NOT NULL AND status IN ('paid', 'partially_refunded', 'refunded')
    ) cp ON TRUE
    LEFT JOIN shopper_earnings se ON se.order_id = o.id AND se.status <> 'void'
    LEFT JOIN LATERAL (
      SELECT SUM(amount_paid) FILTER (WHERE reimbursement_status IN ('owed', 'held', 'reimbursed')) AS reimbursable,
             COUNT(*) FILTER (WHERE review_status IN ('needs_review', 'queried') OR locked_at IS NULL) AS unverified
      FROM store_payments WHERE order_id = o.id
    ) sp ON TRUE
    WHERE o.getme_fee_kept IS NOT NULL
      AND COALESCE(o.delivered_at, o.updated_at) >= $1::date
      AND COALESCE(o.delivered_at, o.updated_at) < $2::date + INTERVAL '1 day'
  )
  SELECT *,
    ROUND((card_charged - card_refunded + cash_collected)::numeric, 2)::float AS collected,
    ROUND((card_charged - card_refunded + cash_collected + credit_used - GREATEST(0, expected - goodwill_refunds))::numeric, 2)::float AS difference,
    ROUND((card_charged - card_refunded + cash_collected - shopper_earnings - groceries_reimbursable - gateway_fee)::numeric, 2)::float AS net_revenue
  FROM base
`;

const RECON_FLAGS = {
  mismatch: 'ABS(difference) > 0.01',
  loss: 'net_revenue < 0',
  unverified: "(bills_unverified > 0 OR earnings_status IN ('awaiting_bills', 'held'))",
};

const toReconRow = (row) => {
  const flags = [];
  if (Math.abs(row.difference) > 0.01) flags.push(row.difference < 0 ? 'under_collected' : 'over_collected');
  if (row.net_revenue < 0) flags.push('loss');
  if (row.bills_unverified > 0 || ['awaiting_bills', 'held'].includes(row.earnings_status)) flags.push('bills_unverified');

  return {
    orderId: row.id,
    status: row.status,
    statusLabel: statusLabel(row.status),
    failedDelivery: Boolean(row.failed_delivery_at),
    paymentMethod: row.payment_method,
    settledAt: row.settled_at,
    customerName: row.customer_name,
    shopperName: row.shopper_name,
    total: round2(row.total),
    tip: round2(row.tip),
    itemRefunds: round2(row.item_refunds),
    expected: round2(row.expected),
    goodwillRefunds: round2(row.goodwill_refunds),
    cardCharged: round2(row.card_charged),
    cardRefunded: round2(row.card_refunded),
    cashCollected: round2(row.cash_collected),
    creditUsed: round2(row.credit_used),
    collected: row.collected,
    difference: row.difference,
    shopperEarnings: round2(row.shopper_earnings),
    groceriesReimbursable: round2(row.groceries_reimbursable),
    gatewayFee: round2(row.gateway_fee),
    getmeFeeKept: round2(row.getme_fee_kept),
    netRevenue: row.net_revenue,
    earningsStatus: row.earnings_status,
    flags,
  };
};

const getReconciliation = async (req, res) => {
  try {
    const { from, to } = readRange(req.query);
    const paging = readPage(req.query, 50);
    const filter = RECON_FLAGS[req.query.flag] || 'TRUE';

    const [count, rows, totals] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM (${RECON_SQL}) r WHERE ${filter}`, [from, to]),
      pool.query(
        `SELECT * FROM (${RECON_SQL}) r WHERE ${filter} ORDER BY settled_at DESC LIMIT $3 OFFSET $4`,
        [from, to, paging.pageSize, paging.offset]
      ),
      pool.query(
        `
        SELECT
          COUNT(*)::int AS orders,
          COALESCE(SUM(expected), 0)::float AS expected,
          COALESCE(SUM(collected), 0)::float AS collected,
          COALESCE(SUM(difference), 0)::float AS difference,
          COALESCE(SUM(shopper_earnings), 0)::float AS shopper_earnings,
          COALESCE(SUM(groceries_reimbursable), 0)::float AS groceries,
          COALESCE(SUM(gateway_fee), 0)::float AS gateway,
          COALESCE(SUM(getme_fee_kept), 0)::float AS getme_fee_kept,
          COALESCE(SUM(net_revenue), 0)::float AS net_revenue,
          COUNT(*) FILTER (WHERE ${RECON_FLAGS.mismatch})::int AS mismatched,
          COUNT(*) FILTER (WHERE ${RECON_FLAGS.loss})::int AS loss_orders,
          COUNT(*) FILTER (WHERE ${RECON_FLAGS.unverified})::int AS unverified
        FROM (${RECON_SQL}) r
        `,
        [from, to]
      ),
    ]);

    const t = totals.rows[0];

    return res.json({
      success: true,
      range: { from, to },
      ...pageMeta(paging, count.rows[0].total),
      totals: {
        orders: t.orders,
        expected: round2(t.expected),
        collected: round2(t.collected),
        difference: round2(t.difference),
        shopperEarnings: round2(t.shopper_earnings),
        groceriesReimbursable: round2(t.groceries),
        gatewayFees: round2(t.gateway),
        getmeFeeKept: round2(t.getme_fee_kept),
        netRevenue: round2(t.net_revenue),
        mismatched: t.mismatched,
        lossOrders: t.loss_orders,
        unverified: t.unverified,
      },
      rows: rows.rows.map(toReconRow),
    });
  } catch (error) {
    console.error('❌ admin getReconciliation error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the reconciliation' });
  }
};

// =====================================================
// ANALYTICS (Reports page)
// =====================================================

const GROUPS = { day: 'day', week: 'week', month: 'month' };

const getAnalytics = async (req, res) => {
  try {
    const { from, to } = readRange(req.query);
    const unit = GROUPS[req.query.groupBy] || 'day';
    const step = `INTERVAL '1 ${unit}'`;

    const [periods, totals, ledgerCheck, shoppers, shops, cancellations] = await Promise.all([
      pool.query(
        `
        WITH buckets AS (
          SELECT generate_series(date_trunc('${unit}', $1::date), date_trunc('${unit}', $2::date), ${step}) AS start
        )
        SELECT to_char(b.start, 'YYYY-MM-DD') AS start,
          (SELECT COUNT(*)::int FROM orders o WHERE o.created_at >= GREATEST(b.start, $1::date) AND o.created_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS placed,
          (SELECT COUNT(*)::int FROM orders o WHERE o.status = 'delivered' AND o.delivered_at >= GREATEST(b.start, $1::date) AND o.delivered_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS delivered,
          (SELECT COUNT(*)::int FROM orders o WHERE o.status IN ('cancelled', 'shopper_search_cancelled') AND o.created_at >= GREATEST(b.start, $1::date) AND o.created_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS cancelled,
          (SELECT COALESCE(SUM(o.total_amount), 0)::float FROM orders o WHERE o.status = 'delivered' AND o.delivered_at >= GREATEST(b.start, $1::date) AND o.delivered_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS order_value,
          (SELECT COALESCE(SUM(o.tip_amount), 0)::float FROM orders o WHERE o.status = 'delivered' AND o.delivered_at >= GREATEST(b.start, $1::date) AND o.delivered_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS tips,
          (SELECT COALESCE(SUM(l.amount), 0)::float FROM finance_ledger l WHERE l.entry_type = 'commission' AND l.entry_at >= GREATEST(b.start, $1::date) AND l.entry_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS commission,
          (SELECT COALESCE(SUM(l.amount), 0)::float FROM finance_ledger l WHERE l.entry_type = 'getme_net_revenue' AND l.entry_at >= GREATEST(b.start, $1::date) AND l.entry_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS net_revenue,
          (SELECT COALESCE(SUM(r.amount), 0)::float FROM card_payment_refunds r JOIN card_payments cp ON cp.id = r.card_payment_id WHERE cp.purpose IN ('order', 'order_extra') AND r.created_at >= GREATEST(b.start, $1::date) AND r.created_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS refunds,
          (SELECT COALESCE(SUM(sp.amount_paid), 0)::float FROM store_payments sp WHERE sp.created_at >= GREATEST(b.start, $1::date) AND sp.created_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS groceries,
          (SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.kind = 'earnings'), 0)::float FROM shopper_payouts p WHERE p.created_at >= GREATEST(b.start, $1::date) AND p.created_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS earnings_paid,
          (SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.kind = 'reimbursement'), 0)::float FROM shopper_payouts p WHERE p.created_at >= GREATEST(b.start, $1::date) AND p.created_at < LEAST(b.start + ${step}, $2::date + INTERVAL '1 day')) AS reimbursements_paid
        FROM buckets b ORDER BY b.start
        `,
        [from, to]
      ),
      // Range totals straight from the base tables
      pool.query(
        `
        SELECT
          (SELECT COUNT(*)::int FROM orders WHERE ${inRange('created_at', 1, 2)}) AS placed,
          (SELECT COUNT(*)::int FROM orders WHERE status = 'delivered' AND ${inRange('delivered_at', 1, 2)}) AS delivered,
          (SELECT COUNT(*)::int FROM orders WHERE status IN ('cancelled', 'shopper_search_cancelled') AND ${inRange('created_at', 1, 2)}) AS cancelled,
          (SELECT COALESCE(SUM(total_amount), 0)::float FROM orders WHERE status = 'delivered' AND ${inRange('delivered_at', 1, 2)}) AS order_value,
          (SELECT COALESCE(SUM(tip_amount), 0)::float FROM orders WHERE status = 'delivered' AND ${inRange('delivered_at', 1, 2)}) AS tips,
          (SELECT COALESCE(SUM(r.amount), 0)::float FROM card_payment_refunds r JOIN card_payments cp ON cp.id = r.card_payment_id WHERE cp.purpose IN ('order', 'order_extra') AND ${inRange('r.created_at', 1, 2)}) AS refunds,
          (SELECT COALESCE(SUM(amount_paid), 0)::float FROM store_payments WHERE ${inRange('created_at', 1, 2)}) AS groceries,
          (SELECT COALESCE(SUM(amount), 0)::float FROM shopper_payouts WHERE kind = 'earnings' AND ${inRange('created_at', 1, 2)}) AS earnings_paid,
          (SELECT COALESCE(SUM(amount), 0)::float FROM shopper_payouts WHERE kind = 'reimbursement' AND ${inRange('created_at', 1, 2)}) AS reimbursements_paid,
          (SELECT COALESCE(SUM(getme_fee_kept), 0)::float FROM orders WHERE getme_fee_kept IS NOT NULL AND ${inRange('COALESCE(delivered_at, updated_at)', 1, 2)}) AS commission
        `,
        [from, to]
      ),
      // The same totals from the ledger, to prove they reconcile
      pool.query(
        `
        SELECT entry_type, COALESCE(SUM(amount), 0)::float AS total
        FROM finance_ledger WHERE ${inRange('entry_at', 1, 2)}
          AND entry_type IN ('customer_refund', 'grocery_expense', 'shopper_payout', 'reimbursement_payout', 'commission')
        GROUP BY entry_type
        `,
        [from, to]
      ),
      pool.query(
        `
        SELECT sh.id, sh.full_name,
          COUNT(o.id)::int AS orders,
          COUNT(o.id) FILTER (WHERE o.status = 'delivered')::int AS delivered,
          COUNT(o.id) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
          COUNT(o.id) FILTER (WHERE o.failed_delivery_at IS NOT NULL)::int AS failed,
          AVG(EXTRACT(EPOCH FROM (o.delivered_at - COALESCE(o.accepted_at, o.shopper_search_started_at, o.created_at))) / 60)
            FILTER (WHERE o.status = 'delivered')::float AS avg_minutes,
          COUNT(o.id) FILTER (WHERE o.status = 'delivered' AND ${EXPECTED_BY_SQL} IS NOT NULL)::int AS timed,
          COUNT(o.id) FILTER (WHERE o.status = 'delivered' AND o.delivered_at <= ${EXPECTED_BY_SQL})::int AS on_time,
          COALESCE(SUM(se.net_amount), 0)::float AS earnings,
          COALESCE(SUM(se.tip), 0)::float AS tips,
          (SELECT AVG(rating)::float FROM order_ratings r WHERE r.shopper_id = sh.id AND ${inRange('r.created_at', 1, 2)}) AS rating
        FROM shoppers sh
        JOIN orders o ON o.shopper_id = sh.id AND ${inRange('o.created_at', 1, 2)}
        LEFT JOIN shopper_earnings se ON se.order_id = o.id AND se.status <> 'void'
        GROUP BY sh.id
        ORDER BY delivered DESC, orders DESC
        LIMIT 50
        `,
        [from, to]
      ),
      pool.query(
        `
        SELECT s.id, s.shop_name,
          COUNT(DISTINCT o.id)::int AS orders,
          COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered')::int AS delivered,
          COUNT(oi.id)::int AS items,
          COUNT(oi.id) FILTER (WHERE oi.shopping_status = 'refunded')::int AS unavailable,
          COALESCE(SUM(oi.price * oi.quantity) FILTER (WHERE o.status = 'delivered' AND oi.shopping_status <> 'refunded'), 0)::float AS item_sales,
          (SELECT COALESCE(SUM(sp.amount_paid), 0)::float FROM store_payments sp WHERE sp.shop_id = s.id AND ${inRange('sp.created_at', 1, 2)}) AS till_spend,
          (SELECT COALESCE(SUM(sp.variance), 0)::float FROM store_payments sp WHERE sp.shop_id = s.id AND ${inRange('sp.created_at', 1, 2)}) AS till_variance,
          (SELECT COUNT(*)::int FROM store_payments sp WHERE sp.shop_id = s.id AND sp.review_status IN ('needs_review', 'queried') AND ${inRange('sp.created_at', 1, 2)}) AS bills_flagged
        FROM shops s
        JOIN order_items oi ON oi.shop_id = s.id
        JOIN orders o ON o.id = oi.order_id AND ${inRange('o.created_at', 1, 2)}
        GROUP BY s.id
        ORDER BY item_sales DESC
        LIMIT 50
        `,
        [from, to]
      ),
      pool.query(
        `
        SELECT
          COALESCE(cancelled_by, CASE WHEN status = 'shopper_search_cancelled' THEN 'customer' ELSE 'unknown' END) AS cancelled_by,
          CASE WHEN failed_delivery_at IS NOT NULL THEN 'Failed delivery' ELSE COALESCE(NULLIF(TRIM(cancel_reason), ''), 'No reason given') END AS reason,
          COUNT(*)::int AS count
        FROM orders
        WHERE status IN ('cancelled', 'shopper_search_cancelled') AND ${inRange('created_at', 1, 2)}
        GROUP BY 1, 2 ORDER BY count DESC LIMIT 20
        `,
        [from, to]
      ),
    ]);

    const t = totals.rows[0];
    const ledgerByType = Object.fromEntries(ledgerCheck.rows.map((row) => [row.entry_type, round2(row.total)]));
    const sumPeriods = (key) => round2(periods.rows.reduce((total, row) => total + Number(row[key] || 0), 0));

    const checks = [
      ['Refunds to customers', round2(t.refunds), ledgerByType.customer_refund || 0, sumPeriods('refunds')],
      ['Grocery cost at stores', round2(t.groceries), ledgerByType.grocery_expense || 0, sumPeriods('groceries')],
      ['Earnings paid out', round2(t.earnings_paid), ledgerByType.shopper_payout || 0, sumPeriods('earnings_paid')],
      ['Reimbursements paid out', round2(t.reimbursements_paid), ledgerByType.reimbursement_payout || 0, sumPeriods('reimbursements_paid')],
      ['GetMe fee kept', round2(t.commission), ledgerByType.commission || 0, sumPeriods('commission')],
    ].map(([label, records, ledger, periodsTotal]) => ({
      label, records, ledger, periods: periodsTotal,
      reconciled: Math.abs(records - ledger) < 0.01 && Math.abs(records - periodsTotal) < 0.01,
    }));

    return res.json({
      success: true,
      range: { from, to },
      groupBy: unit,
      totals: {
        placed: t.placed,
        delivered: t.delivered,
        cancelled: t.cancelled,
        completionRate: t.placed ? t.delivered / t.placed : null,
        cancellationRate: t.placed ? t.cancelled / t.placed : null,
        orderValue: round2(t.order_value),
        averageOrder: t.delivered ? round2(t.order_value / t.delivered) : 0,
        tips: round2(t.tips),
        refunds: round2(t.refunds),
        groceries: round2(t.groceries),
        earningsPaid: round2(t.earnings_paid),
        reimbursementsPaid: round2(t.reimbursements_paid),
        commission: round2(t.commission),
      },
      checks,
      periods: periods.rows.map((row) => ({
        start: row.start,
        placed: row.placed,
        delivered: row.delivered,
        cancelled: row.cancelled,
        orderValue: round2(row.order_value),
        tips: round2(row.tips),
        commission: round2(row.commission),
        netRevenue: round2(row.net_revenue),
        refunds: round2(row.refunds),
        groceries: round2(row.groceries),
        earningsPaid: round2(row.earnings_paid),
        reimbursementsPaid: round2(row.reimbursements_paid),
      })),
      shoppers: shoppers.rows.map((row) => ({
        id: row.id, name: row.full_name, orders: row.orders, delivered: row.delivered, cancelled: row.cancelled,
        failed: row.failed, avgMinutes: row.avg_minutes != null ? Math.round(row.avg_minutes) : null,
        onTimeRate: row.timed ? row.on_time / row.timed : null, earnings: round2(row.earnings), tips: round2(row.tips),
        rating: row.rating != null ? round2(row.rating) : null,
      })),
      shops: shops.rows.map((row) => ({
        id: row.id, name: row.shop_name, orders: row.orders, delivered: row.delivered, items: row.items,
        unavailable: row.unavailable, unavailableRate: row.items ? row.unavailable / row.items : null,
        itemSales: round2(row.item_sales), tillSpend: round2(row.till_spend), tillVariance: round2(row.till_variance),
        billsFlagged: row.bills_flagged,
      })),
      cancellations: cancellations.rows.map((row) => ({ cancelledBy: row.cancelled_by, reason: row.reason, count: row.count })),
    });
  } catch (error) {
    console.error('❌ admin getAnalytics error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load reports' });
  }
};

// =====================================================
// CSV EXPORT
// =====================================================

const csvCell = (value) => {
  if (value == null) return '';
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Spreadsheet formula injection guard
  const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const DATASETS = {
  orders: {
    roles: ['operations', 'finance'],
    sql: `
      SELECT o.id AS order_id, o.created_at, o.status, o.payment_method, COALESCE(o.payment_status, 'unpaid') AS payment_status,
             c.full_name AS customer, sh.full_name AS shopper,
             (SELECT STRING_AGG(os.shop_name, ' + ' ORDER BY os.id) FROM order_shops os WHERE os.order_id = o.id) AS shops,
             o.items_total, o.delivery_fee, o.fast_delivery_fee AS priority_fee, o.service_fee,
             o.discount_amount, o.window_discount, o.getme_fee, o.tip_amount, o.total_amount,
             o.getme_fee_kept, o.delivered_at, o.cancelled_by, o.cancel_reason
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN shoppers sh ON sh.id = o.shopper_id
      WHERE ${inRange('o.created_at', 1, 2)}
      ORDER BY o.id`,
  },
  reconciliation: {
    roles: ['finance'],
    sql: `SELECT id AS order_id, settled_at, status, payment_method, customer_name, shopper_name, total, tip,
                 item_refunds, expected, goodwill_refunds, card_charged, card_refunded, cash_collected, collected, difference,
                 shopper_earnings, groceries_reimbursable, gateway_fee, getme_fee_kept, net_revenue, earnings_status
          FROM (${RECON_SQL}) r ORDER BY settled_at`,
  },
  ledger: {
    roles: ['finance'],
    sql: `SELECT entry_at, entry_type, flow, order_id, shopper_id, customer_id, amount, reference, description
          FROM finance_ledger WHERE ${inRange('entry_at', 1, 2)} ORDER BY entry_at`,
  },
  payouts: {
    roles: ['finance'],
    sql: `SELECT p.id, p.created_at, p.kind, p.shopper_id, sh.full_name AS shopper, p.amount, p.reference, p.note,
                 a.full_name AS recorded_by
          FROM shopper_payouts p LEFT JOIN shoppers sh ON sh.id = p.shopper_id LEFT JOIN admins a ON a.id = p.created_by
          WHERE ${inRange('p.created_at', 1, 2)} ORDER BY p.created_at`,
  },
  'store-payments': {
    roles: ['finance'],
    sql: `SELECT sp.id, sp.created_at, sp.order_id, s.shop_name AS shop, sh.full_name AS shopper, sp.method,
                 sp.amount_paid, sp.expected_amount, sp.variance, sp.review_status, sp.reimbursement_status,
                 sp.reimbursement_reference, sp.reimbursed_at
          FROM store_payments sp LEFT JOIN shops s ON s.id = sp.shop_id LEFT JOIN shoppers sh ON sh.id = sp.shopper_id
          WHERE ${inRange('sp.created_at', 1, 2)} ORDER BY sp.created_at`,
  },
  earnings: {
    roles: ['finance'],
    sql: `SELECT se.order_id, se.created_at, se.shopper_id, sh.full_name AS shopper, se.status, se.delivery_fee,
                 se.priority_fee, se.service_fee, se.tip, se.adjustment, se.net_amount, se.cash_collected,
                 se.cash_status, se.paid_at
          FROM shopper_earnings se LEFT JOIN shoppers sh ON sh.id = se.shopper_id
          WHERE ${inRange('se.created_at', 1, 2)} ORDER BY se.created_at`,
  },
};

const exportDataset = async (req, res) => {
  const spec = DATASETS[req.params.dataset];

  if (!spec) {
    return res.status(404).json({ success: false, message: 'Unknown export' });
  }

  // Phase 40: datasets operations could export need exports.orders,
  // the finance ones exports.finance
  const needed = spec.roles.includes('operations') ? 'exports.orders' : 'exports.finance';

  if (!req.admin?.permissions?.has(needed)) {
    return res.status(403).json({ success: false, code: 'PERMISSION_DENIED', permission: needed, message: "You don't have permission to export this data" });
  }

  try {
    const { from, to } = readRange(req.query);
    const result = await pool.query(spec.sql, [from, to]);
    const columns = result.fields.map((field) => field.name);
    const lines = [
      columns.join(','),
      ...result.rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
    ];

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="getme-${req.params.dataset}-${from}-to-${to}.csv"`);
    return res.send(`﻿${lines.join('\r\n')}\r\n`);
  } catch (error) {
    console.error('❌ admin export error:', req.params.dataset, error.message);
    return res.status(500).json({ success: false, message: 'Unable to export' });
  }
};

module.exports = {
  readRange,
  getFinanceOverview,
  getReconciliation,
  getAnalytics,
  exportDataset,
};
