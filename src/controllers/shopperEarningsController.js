const db = require('../config/db');

const { SHOPPER_PAY_SQL, SERVICE_EARNED_SQL } = require('./shopperPay');
const { shopperBalances } = require('./settlementController');

// =====================================================
// GET EARNINGS
// GET /api/shopper/earnings
// Pay per finished order (shopperPay.js) = delivery fee + priority
// fee + service fee + 100% tip + adjustments, nothing deducted.
// Earned orders: delivered, or a failed delivery (delivery fee only)
// =====================================================

const EARNED = "(o.status = 'delivered' OR o.failed_delivery_at IS NOT NULL)";
const DONE_AT = 'COALESCE(o.delivered_at, o.failed_delivery_at)';

// One category of an order's pay: the settled amount, else the order
const PART = {
  delivery: 'COALESCE(se.delivery_fee, o.delivery_fee, 0)',
  priority: 'COALESCE(se.priority_fee, o.fast_delivery_fee, 0)',
  service: `COALESCE(se.service_fee, ${SERVICE_EARNED_SQL})`,
  tips: 'COALESCE(se.tip, o.tip_amount, 0)',
  adjustments: 'COALESCE(se.adjustment, 0)',
};

const EARNINGS_JOIN =
  "LEFT JOIN shopper_earnings se ON se.order_id = o.id AND se.status <> 'void'";

// SUM of each category (with FILTER when given), as columns <prefix>_<name>
const categorySums = (prefix, filter = '') =>
  Object.entries(PART)
    .map(
      ([name, sql]) =>
        `COALESCE(SUM(${sql})${filter ? ` FILTER (WHERE ${filter})` : ''}, 0)::float AS ${prefix}_${name}`
    )
    .join(',\n');

const categoriesOf = (row, prefix) =>
  Object.fromEntries(Object.keys(PART).map((name) => [name, Number(row[`${prefix}_${name}`]) || 0]));

const getEarnings = async (req, res) => {
  try {
    const shopperId =
      req.shopper?.shopperId ||
      req.shopper?.id;

    const [
      summaryResult,
      daysResult,
      recentResult,
      weeksResult,
      storeBillsResult,
      pendingResult,
      balances,
    ] = await Promise.all([
      db.query(
        `
        SELECT
          COALESCE(SUM(${SHOPPER_PAY_SQL}) FILTER (
            WHERE ${DONE_AT} >= date_trunc('day', NOW())
          ), 0)::float AS today,

          COUNT(*) FILTER (
            WHERE ${DONE_AT} >= date_trunc('day', NOW())
          )::int AS deliveries_today,

          COALESCE(SUM(${SHOPPER_PAY_SQL}) FILTER (
            WHERE ${DONE_AT} >= date_trunc('week', NOW())
          ), 0)::float AS this_week,

          COUNT(*) FILTER (
            WHERE ${DONE_AT} >= date_trunc('week', NOW())
          )::int AS deliveries_this_week,

          -- This week's pay by category (tips are 100% the shopper's)
          ${categorySums('week', `${DONE_AT} >= date_trunc('week', NOW())`)},

          COALESCE(SUM(${SHOPPER_PAY_SQL}), 0)::float AS lifetime,
          COUNT(*)::int AS deliveries_lifetime

        FROM orders o
        ${EARNINGS_JOIN}
        WHERE o.shopper_id = $1
          AND ${EARNED}
        `,
        [shopperId]
      ),

      // Last 7 days, including days with no deliveries
      db.query(
        `
        SELECT
          to_char(day, 'YYYY-MM-DD') AS date,
          COALESCE(SUM(${SHOPPER_PAY_SQL}), 0)::float AS total,
          COUNT(o.id)::int AS count
        FROM generate_series(
          date_trunc('day', NOW()) - INTERVAL '6 days',
          date_trunc('day', NOW()),
          INTERVAL '1 day'
        ) AS day
        LEFT JOIN orders o
          ON o.shopper_id = $1
          AND ${EARNED}
          AND ${DONE_AT} >= day
          AND ${DONE_AT} < day + INTERVAL '1 day'
        GROUP BY day
        ORDER BY day ASC
        `,
        [shopperId]
      ),

      db.query(
        `
        SELECT
          o.id,
          ${DONE_AT} AS delivered_at,
          o.failed_delivery_at IS NOT NULL AS failed_delivery,
          o.delivery_address,
          ${PART.delivery}::float AS delivery_fee,
          ${PART.priority}::float AS fast_delivery_fee,
          ${PART.service}::float AS service_fee,
          ${PART.adjustments}::float AS adjustment,
          ${SHOPPER_PAY_SQL}::float AS pay,
          ${PART.tips}::float AS tip,
          COALESCE(
            (
              SELECT STRING_AGG(os.shop_name, ' + ' ORDER BY os.id)
              FROM order_shops os
              WHERE os.order_id = o.id
            ),
            'Order'
          ) AS shop_names
        FROM orders o
        ${EARNINGS_JOIN}
        WHERE o.shopper_id = $1
          AND ${EARNED}
        ORDER BY ${DONE_AT} DESC NULLS LAST
        LIMIT 100
        `,
        [shopperId]
      ),

      // Weekly earnings: this week and the 7 before it (Mon-Sun),
      // including weeks with no deliveries
      db.query(
        `
        SELECT
          to_char(week, 'YYYY-MM-DD') AS week_start,
          COALESCE(SUM(${SHOPPER_PAY_SQL}), 0)::float AS total,
          ${categorySums('week')},
          COUNT(o.id)::int AS count
        FROM generate_series(
          date_trunc('week', NOW()) - INTERVAL '7 weeks',
          date_trunc('week', NOW()),
          INTERVAL '1 week'
        ) AS week
        LEFT JOIN orders o
          ON o.shopper_id = $1
          AND ${EARNED}
          AND ${DONE_AT} >= week
          AND ${DONE_AT} < week + INTERVAL '1 week'
        ${EARNINGS_JOIN}
        GROUP BY week
        ORDER BY week DESC
        `,
        [shopperId]
      ),
      // Store bills the shopper paid that GetMe hasn't paid back yet
      // (store_payments), plus this month's reimbursements
      db.query(
        `
        SELECT
          sp.id, sp.order_id, sp.amount_paid, sp.review_status, sp.review_note,
          sp.reimbursement_status, sp.reimbursed_at, sp.created_at,
          s.shop_name
        FROM store_payments sp
        LEFT JOIN shops s ON s.id = sp.shop_id
        WHERE sp.shopper_id = $1
          AND (
            sp.reimbursement_status <> 'reimbursed'
            OR sp.reimbursed_at >= date_trunc('month', NOW())
          )
        ORDER BY sp.created_at DESC
        `,
        [shopperId]
      ),

      // Earnings still pending: accepted orders not delivered yet
      db.query(
        `
        SELECT
          COALESCE(SUM(${SHOPPER_PAY_SQL}), 0)::float AS total,
          COUNT(*)::int AS count
        FROM orders o
        WHERE o.shopper_id = $1
          AND o.status IN ('shopper_accepted', 'shopping', 'out_for_delivery', 'arrived')
        `,
        [shopperId]
      ),

      // Settlement: payable / on hold / paid out, cash to deposit
      shopperBalances(shopperId),
    ]);

    const summary = summaryResult.rows[0];

    const storeBills = storeBillsResult.rows;
    const sumWhere = (test) =>
      Math.round(
        storeBills.filter(test).reduce((sum, row) => sum + Number(row.amount_paid), 0) * 100
      ) / 100;

    return res.json({
      success: true,
      today: summary.today,
      deliveriesToday: summary.deliveries_today,
      thisWeek: summary.this_week,
      deliveriesThisWeek: summary.deliveries_this_week,
      tipsThisWeek: summary.week_tips,
      // { delivery, priority, service, tips, adjustments }
      categoriesThisWeek: categoriesOf(summary, 'week'),
      // Delivery earnings by settlement state (groceries excluded)
      payout: {
        pending: pendingResult.rows[0].total,
        pendingCount: pendingResult.rows[0].count,
        // Delivered, waiting for the store bills to be approved
        awaitingBills: balances?.earningsAwaiting ?? 0,
        payable: balances?.earningsPayable ?? 0,
        held: balances?.earningsHeld ?? 0,
        paid: balances?.earningsPaid ?? 0,
        cashDue: balances?.cashDue ?? 0,
      },
      lifetime: summary.lifetime,
      deliveriesLifetime: summary.deliveries_lifetime,
      days: daysResult.rows,
      recent: recentResult.rows.map((row) => ({
        orderId: row.id,
        shopNames: row.shop_names,
        deliveryAddress: row.delivery_address,
        deliveredAt: row.delivered_at,
        deliveryFee: row.delivery_fee,
        fastDeliveryFee: row.fast_delivery_fee,
        serviceFee: row.service_fee,
        adjustment: row.adjustment,
        failedDelivery: row.failed_delivery,
        tip: row.tip,
        pay: row.pay,
      })),
      // Store bills to be paid back (not earnings):
      // owed = delivered + bill approved, onHold = bill being checked,
      // afterDelivery = order not delivered yet
      reimbursements: {
        owed: sumWhere((row) => row.reimbursement_status === 'owed'),
        onHold: sumWhere((row) => row.reimbursement_status === 'held'),
        afterDelivery: sumWhere((row) => row.reimbursement_status === 'pending'),
        reimbursedThisMonth: sumWhere((row) => row.reimbursement_status === 'reimbursed'),
        open: storeBills
          .filter((row) => row.reimbursement_status !== 'reimbursed')
          .map((row) => ({
            id: row.id,
            orderId: row.order_id,
            shopName: row.shop_name,
            amount: Number(row.amount_paid),
            status: row.reimbursement_status,
            reviewStatus: row.review_status,
            reviewNote: row.review_note,
            createdAt: row.created_at,
          })),
      },
      // Newest first: [{ weekStart: 'YYYY-MM-DD', total, tips,
      //   categories: { delivery, priority, service, tips, adjustments }, count }]
      weeks: weeksResult.rows.map((row) => ({
        weekStart: row.week_start,
        total: row.total,
        tips: row.week_tips,
        categories: categoriesOf(row, 'week'),
        count: row.count,
      })),
    });
  } catch (error) {
    console.error('❌ getEarnings error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to load earnings',
    });
  }
};

module.exports = {
  getEarnings,
};
