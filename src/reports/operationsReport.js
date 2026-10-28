const { EXPECTED_BY_SQL } = require('../controllers/admin/adminOpsController');
const { REASONS } = require('../orders/cancelPolicy');
const { ORDER_STATUS_GROUPS, statusLabel } = require('../utils/orderStatus');

// =====================================================
// GROCERY OPERATIONS REPORT (phase 47, 2026-10-29)
// buildOperationsReport(db, { from, to }) -> plain object. `db` is the
// pool or a client (the e2e test runs it inside a transaction it rolls
// back). Dates are Asia/Colombo days (the pool's session time zone);
// every figure is computed in SQL from recorded data only.
//
//   timing        delivered orders (by delivered_at):
//                 accept   = accepted_at - shopper_search_started_at
//                 shopping = out_for_delivery_at - shopping_started_at
//                 delivery = delivered_at - out_for_delivery_at
//                 total    = delivered_at - (search start or placed)
//                 average / median / p90 (percentile_cont, minutes);
//                 a missing or negative step is left out of that step.
//                 On time = delivered_at <= promised time
//                 (adminOpsController EXPECTED_BY_SQL: the slot end of
//                 a scheduled order, else search start + max ETA);
//                 orders without a promised time aren't "timed".
//   fill rate     order_items of delivered orders, per shop
//                 (order_items.shop_id), by shopping_status:
//                 found = found / done / completed, replaced,
//                 unavailable = not_found / refunded, anything else =
//                 not recorded; short = found with found_quantity
//                 below the quantity ordered. Fill rate = found /
//                 requested lines; with replacements = (found +
//                 replaced) / requested.
//   cancellations cancelled orders by the time they were cancelled
//                 (order_cancellations.created_at, else
//                 orders.cancelled_at / updated_at) with the reason
//                 code, who and status from order_cancellations, else
//                 the orders columns; failed deliveries =
//                 failed_delivery / failed_delivery_at.
//   refunds       orders placed in the range; refunded = card refunds
//                 (card_payment_refunds -> card_payments of purpose
//                 order / order_extra) on those orders. Per shop via
//                 order_shops (else orders.shop_id): an order from
//                 several shops counts for each of them. Per shopper
//                 via orders.shopper_id.
// =====================================================

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const round1 = (value) => (value == null ? null : Math.round(Number(value) * 10) / 10);
const rate = (part, whole) => (Number(whole) > 0 ? Number(part) / Number(whole) : null);

const CANCELLED = ORDER_STATUS_GROUPS.cancelled;
const FOUND = ['found', 'done', 'completed'];
const UNAVAILABLE = ['not_found', 'refunded'];

const REASON_LABELS = {
  ...Object.fromEntries(REASONS.map((reason) => [reason.code, reason.label])),
  admin: 'Cancelled by GetMe staff',
  failed_delivery: 'Failed delivery',
  not_recorded: 'Reason not recorded',
};

const WHO_LABELS = {
  customer: 'Customer',
  admin: 'GetMe staff',
  system: 'System',
  not_recorded: 'Not recorded',
};

// timestamp column within [from, to] (inclusive Colombo days)
const inRange = (column, a = 1, b = 2) => `${column} >= $${a}::date AND ${column} < $${b}::date + INTERVAL '1 day'`;

const STEPS = ['accept', 'shopping', 'delivery', 'total'];

const stepSql = (step) => `
  COUNT(${step}_min) FILTER (WHERE ${step}_min >= 0)::int AS ${step}_n,
  AVG(${step}_min) FILTER (WHERE ${step}_min >= 0)::float AS ${step}_avg,
  (percentile_cont(0.5) WITHIN GROUP (ORDER BY ${step}_min) FILTER (WHERE ${step}_min >= 0))::float AS ${step}_median,
  (percentile_cont(0.9) WITHIN GROUP (ORDER BY ${step}_min) FILTER (WHERE ${step}_min >= 0))::float AS ${step}_p90
`;

const DELIVERED_CTE = `
  delivered AS (
    SELECT o.id, o.delivered_at,
      EXTRACT(EPOCH FROM (o.accepted_at - o.shopper_search_started_at)) / 60 AS accept_min,
      EXTRACT(EPOCH FROM (o.out_for_delivery_at - o.shopping_started_at)) / 60 AS shopping_min,
      EXTRACT(EPOCH FROM (o.delivered_at - o.out_for_delivery_at)) / 60 AS delivery_min,
      EXTRACT(EPOCH FROM (o.delivered_at - COALESCE(o.shopper_search_started_at, o.created_at))) / 60 AS total_min,
      ${EXPECTED_BY_SQL} AS expected_by
    FROM orders o
    WHERE o.status = 'delivered' AND o.delivered_at IS NOT NULL AND ${inRange('o.delivered_at')}
  )
`;

const timingOf = (row) =>
  Object.fromEntries(STEPS.map((step) => [step, {
    orders: row[`${step}_n`] || 0,
    averageMinutes: round1(row[`${step}_avg`]),
    medianMinutes: round1(row[`${step}_median`]),
    p90Minutes: round1(row[`${step}_p90`]),
  }]));

const CANCEL_CTE = `
  cancels AS (
    SELECT o.id,
      COALESCE(NULLIF(oc.reason_code, ''), NULLIF(o.cancel_reason_code, ''),
               CASE WHEN o.failed_delivery_at IS NOT NULL THEN 'failed_delivery' END, 'not_recorded') AS reason_code,
      COALESCE(NULLIF(oc.cancelled_by, ''), NULLIF(o.cancelled_by, ''), 'not_recorded') AS cancelled_by,
      COALESCE(NULLIF(oc.from_status, ''), NULLIF(o.cancelled_from_status, ''), 'not_recorded') AS from_status,
      (COALESCE(oc.failed_delivery, FALSE) OR o.failed_delivery_at IS NOT NULL) AS failed
    FROM orders o
    LEFT JOIN order_cancellations oc ON oc.order_id = o.id
    WHERE o.status = ANY($3::text[])
      AND ${inRange('COALESCE(oc.created_at, o.cancelled_at, o.updated_at, o.created_at)')}
  )
`;

const REFUND_CTE = `
  base AS (
    SELECT o.id, o.shop_id, o.shopper_id, COALESCE(o.total_amount, 0) AS total_amount,
           COALESCE(r.amount, 0) AS refunded, COALESCE(r.refunds, 0) AS refunds
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT SUM(cr.amount) AS amount, COUNT(*) AS refunds
      FROM card_payment_refunds cr
      JOIN card_payments cp ON cp.id = cr.card_payment_id
      WHERE cp.order_id = o.id AND cp.purpose IN ('order', 'order_extra')
    ) r ON TRUE
    WHERE ${inRange('o.created_at')}
  )
`;

const refundRow = (row, extra = {}) => ({
  ...extra,
  orders: row.orders,
  orderValue: round2(row.order_value),
  refunded: round2(row.refunded),
  refunds: row.refunds,
  ordersRefunded: row.orders_refunded,
  refundRate: rate(row.refunded, row.order_value),
  orderRefundRate: rate(row.orders_refunded, row.orders),
});

// A pool runs the queries in parallel; a single client (the test's
// transaction) runs them one after another
const runAll = async (db, queries) => {
  if (typeof db.totalCount === 'number') return Promise.all(queries.map(([sql, params]) => db.query(sql, params)));
  const results = [];
  for (const [sql, params] of queries) results.push(await db.query(sql, params));
  return results;
};

const buildOperationsReport = async (db, { from, to }) => {
  const range = [from, to];

  const [timing, daily, fill, cancelTotals, byReason, byWho, byStatus, refundTotals, refundShops, refundShoppers] = await runAll(db, [
    [
      `
      WITH ${DELIVERED_CTE}
      SELECT COUNT(*)::int AS delivered,
        ${STEPS.map(stepSql).join(',')},
        COUNT(*) FILTER (WHERE expected_by IS NOT NULL)::int AS timed,
        COUNT(*) FILTER (WHERE expected_by IS NOT NULL AND delivered_at <= expected_by)::int AS on_time
      FROM delivered
      `,
      range
    ],
    [
      `
      WITH ${DELIVERED_CTE}
      SELECT to_char(day, 'YYYY-MM-DD') AS date,
        COUNT(d.id)::int AS delivered,
        COUNT(d.id) FILTER (WHERE d.expected_by IS NOT NULL)::int AS timed,
        COUNT(d.id) FILTER (WHERE d.expected_by IS NOT NULL AND d.delivered_at <= d.expected_by)::int AS on_time,
        AVG(d.total_min) FILTER (WHERE d.total_min >= 0)::float AS total_avg
      FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS day
      LEFT JOIN delivered d ON d.delivered_at >= day AND d.delivered_at < day + INTERVAL '1 day'
      GROUP BY day ORDER BY day
      `,
      range
    ],
    [
      `
      SELECT s.id, s.shop_name,
        COUNT(DISTINCT o.id)::int AS orders,
        COUNT(oi.id)::int AS requested,
        COUNT(oi.id) FILTER (WHERE oi.shopping_status = ANY($3::text[]))::int AS found,
        COUNT(oi.id) FILTER (WHERE oi.shopping_status = 'replaced')::int AS replaced,
        COUNT(oi.id) FILTER (WHERE oi.shopping_status = ANY($4::text[]))::int AS unavailable,
        COUNT(oi.id) FILTER (WHERE oi.shopping_status = ANY($3::text[]) AND oi.found_quantity IS NOT NULL
                               AND oi.found_quantity < oi.quantity)::int AS short,
        COUNT(oi.id) FILTER (WHERE COALESCE(oi.shopping_status, '') <> ALL($3::text[] || $4::text[] || ARRAY['replaced']))::int AS not_recorded,
        COALESCE(SUM(oi.refund_amount) FILTER (WHERE oi.shopping_status = 'refunded'), 0)::float AS item_refunds
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN shops s ON s.id = oi.shop_id
      WHERE o.status = 'delivered' AND o.delivered_at IS NOT NULL AND ${inRange('o.delivered_at')}
      GROUP BY s.id
      ORDER BY requested DESC, s.shop_name
      LIMIT 100
      `,
      [...range, FOUND, UNAVAILABLE]
    ],
    [
      `
      WITH ${CANCEL_CTE}
      SELECT COUNT(*)::int AS cancelled,
        COUNT(*) FILTER (WHERE failed)::int AS failed,
        (SELECT COUNT(*)::int FROM orders o WHERE ${inRange('o.created_at')}) AS placed
      FROM cancels
      `,
      [...range, CANCELLED]
    ],
    [
      `WITH ${CANCEL_CTE} SELECT reason_code, COUNT(*)::int AS count FROM cancels GROUP BY 1 ORDER BY count DESC, 1`,
      [...range, CANCELLED]
    ],
    [
      `WITH ${CANCEL_CTE} SELECT cancelled_by, COUNT(*)::int AS count FROM cancels GROUP BY 1 ORDER BY count DESC, 1`,
      [...range, CANCELLED]
    ],
    [
      `WITH ${CANCEL_CTE} SELECT from_status, COUNT(*)::int AS count FROM cancels GROUP BY 1 ORDER BY count DESC, 1`,
      [...range, CANCELLED]
    ],
    [
      `
      WITH ${REFUND_CTE}
      SELECT COUNT(*)::int AS orders, COALESCE(SUM(total_amount), 0)::float AS order_value,
        COALESCE(SUM(refunded), 0)::float AS refunded, COALESCE(SUM(refunds), 0)::int AS refunds,
        COUNT(*) FILTER (WHERE refunded > 0)::int AS orders_refunded
      FROM base
      `,
      range
    ],
    [
      `
      WITH ${REFUND_CTE},
      links AS (
        SELECT DISTINCT os.order_id, os.shop_id FROM order_shops os JOIN base b ON b.id = os.order_id
        UNION
        SELECT b.id, b.shop_id FROM base b
        WHERE b.shop_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM order_shops os WHERE os.order_id = b.id)
      )
      SELECT s.id, s.shop_name,
        COUNT(*)::int AS orders, COALESCE(SUM(b.total_amount), 0)::float AS order_value,
        COALESCE(SUM(b.refunded), 0)::float AS refunded, COALESCE(SUM(b.refunds), 0)::int AS refunds,
        COUNT(*) FILTER (WHERE b.refunded > 0)::int AS orders_refunded
      FROM links l
      JOIN base b ON b.id = l.order_id
      JOIN shops s ON s.id = l.shop_id
      GROUP BY s.id
      ORDER BY refunded DESC, orders DESC, s.shop_name
      LIMIT 100
      `,
      range
    ],
    [
      `
      WITH ${REFUND_CTE}
      SELECT sh.id, sh.full_name,
        COUNT(*)::int AS orders, COALESCE(SUM(b.total_amount), 0)::float AS order_value,
        COALESCE(SUM(b.refunded), 0)::float AS refunded, COALESCE(SUM(b.refunds), 0)::int AS refunds,
        COUNT(*) FILTER (WHERE b.refunded > 0)::int AS orders_refunded
      FROM base b
      JOIN shoppers sh ON sh.id = b.shopper_id
      GROUP BY sh.id
      ORDER BY refunded DESC, orders DESC, sh.full_name
      LIMIT 100
      `,
      range
    ],
  ]);

  const t = timing.rows[0];
  const c = cancelTotals.rows[0];
  const fillTotals = fill.rows.reduce(
    (sum, row) => {
      ['requested', 'found', 'replaced', 'unavailable', 'short', 'not_recorded'].forEach((key) => { sum[key] += row[key]; });
      sum.item_refunds += Number(row.item_refunds || 0);
      return sum;
    },
    { requested: 0, found: 0, replaced: 0, unavailable: 0, short: 0, not_recorded: 0, item_refunds: 0 }
  );

  const fillRow = (row) => ({
    requested: row.requested,
    found: row.found,
    replaced: row.replaced,
    unavailable: row.unavailable,
    short: row.short,
    notRecorded: row.not_recorded,
    itemRefunds: round2(row.item_refunds),
    fillRate: rate(row.found, row.requested),
    fillRateWithReplacements: rate(row.found + row.replaced, row.requested),
    unavailableRate: rate(row.unavailable, row.requested),
  });

  return {
    range: { from, to },
    timing: {
      delivered: t.delivered,
      ...timingOf(t),
      timed: t.timed,
      onTime: t.on_time,
      late: t.timed - t.on_time,
      onTimeRate: rate(t.on_time, t.timed),
    },
    daily: daily.rows.map((row) => ({
      date: row.date,
      delivered: row.delivered,
      timed: row.timed,
      onTime: row.on_time,
      late: row.timed - row.on_time,
      onTimeRate: rate(row.on_time, row.timed),
      averageTotalMinutes: round1(row.total_avg),
    })),
    fill: {
      ...fillRow(fillTotals),
      shops: fill.rows.map((row) => ({ id: row.id, name: row.shop_name, orders: row.orders, ...fillRow(row) })),
    },
    cancellations: {
      placed: c.placed,
      cancelled: c.cancelled,
      failedDeliveries: c.failed,
      cancellationRate: rate(c.cancelled, c.placed),
      byReason: byReason.rows.map((row) => ({ code: row.reason_code, label: REASON_LABELS[row.reason_code] || row.reason_code, count: row.count })),
      byWho: byWho.rows.map((row) => ({ cancelledBy: row.cancelled_by, label: WHO_LABELS[row.cancelled_by] || row.cancelled_by, count: row.count })),
      byStatus: byStatus.rows.map((row) => ({
        status: row.from_status,
        label: row.from_status === 'not_recorded' ? 'Not recorded' : statusLabel(row.from_status),
        count: row.count,
      })),
    },
    refunds: {
      ...refundRow(refundTotals.rows[0]),
      shops: refundShops.rows.map((row) => refundRow(row, { id: row.id, name: row.shop_name })),
      shoppers: refundShoppers.rows.map((row) => refundRow(row, { id: row.id, name: row.full_name })),
    },
    notes: [
      'Timing uses delivered orders by the day they were delivered; a step with a missing or out-of-order time is left out of that step only.',
      'On time compares the delivery time with the promised time (scheduled slot end, else search start + the longest ETA quoted). Orders without a promised time are not counted.',
      'Fill rate uses item lines of delivered orders. Items still pending or with no recorded result are shown as "not recorded". Weighed items are counted by line, not weight.',
      'Refunds are card refunds on orders placed in the range. An order from several shops counts for each shop. Cash orders have no card refunds.',
    ],
  };
};

module.exports = {
  buildOperationsReport,
  REASON_LABELS,
};
