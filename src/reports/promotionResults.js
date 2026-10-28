const { ORDER_STATUS_GROUPS } = require('../utils/orderStatus');

// =====================================================
// PROMOTION RESULTS (phase 47, 2026-10-29)
// Promo codes (promo_redemptions -> orders) and shop offers
// (order_items.offer_id -> orders). `db` is the pool or a client.
// from / to (YYYY-MM-DD, Asia/Colombo) filter on when the order was
// placed; null = all time.
//
//   redemptions   promo: redemption rows; offer: order lines with it
//   orders        distinct orders: placed / delivered / cancelled
//   discount      promo: promo_redemptions.discount_amount (GetMe pays
//                 it) on orders that weren't cancelled; offer: what the
//                 offer saved on those lines (order_items.offer_discount,
//                 else (shelf - charged unit price) x packs; the shop
//                 funds its own offers)
//   revenue       order totals (orders.total_amount) of the delivered
//                 orders; offers also give the offer lines' own sales
//   customers     distinct customers with a non-cancelled order
//   newCustomers  ...whose first non-cancelled order on GetMe was one
//                 of these orders
//   repeat        ...who placed another order that was delivered within
//                 30 days after their first such order; repeatRate =
//                 repeat / customers. windowOpen = customers whose 30
//                 days haven't ended yet (they may still repeat).
// =====================================================

const CANCELLED = ORDER_STATUS_GROUPS.cancelled;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const rate = (part, whole) => (Number(whole) > 0 ? Number(part) / Number(whole) : null);

const readOptionalRange = (query = {}) => {
  let from = DATE.test(String(query.from || '')) ? query.from : null;
  let to = DATE.test(String(query.to || '')) ? query.to : null;
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
};

// attributed: SQL yielding (key, order_id, discount, line_revenue, lines)
// one row per key + order. $1 = key filter (null = all), $2 / $3 =
// from / to, $4 = cancelled statuses.
const resultsSql = (attributed) => `
  WITH att AS (${attributed}),
  ord AS (
    SELECT a.key, a.order_id, a.discount, a.line_revenue, a.lines, o.customer_id, o.created_at, o.status,
           COALESCE(o.total_amount, 0) AS total_amount, (o.status = ANY($4::text[])) AS cancelled
    FROM att a
    JOIN orders o ON o.id = a.order_id
    WHERE ($2::date IS NULL OR o.created_at >= $2::date)
      AND ($3::date IS NULL OR o.created_at < $3::date + INTERVAL '1 day')
  ),
  firsts AS (
    SELECT DISTINCT ON (key, customer_id) key, customer_id, order_id, created_at
    FROM ord
    WHERE NOT cancelled AND customer_id IS NOT NULL
    ORDER BY key, customer_id, created_at, order_id
  ),
  cust AS (
    SELECT f.key,
      COUNT(*)::int AS customers,
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM orders e
        WHERE e.customer_id = f.customer_id AND e.id <> f.order_id AND NOT (e.status = ANY($4::text[]))
          AND (e.created_at < f.created_at OR (e.created_at = f.created_at AND e.id < f.order_id))
      ))::int AS new_customers,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM orders n
        WHERE n.customer_id = f.customer_id AND n.id <> f.order_id AND n.status = 'delivered'
          AND n.created_at > f.created_at AND n.created_at <= f.created_at + INTERVAL '30 days'
      ))::int AS repeat_customers,
      COUNT(*) FILTER (WHERE f.created_at + INTERVAL '30 days' > NOW())::int AS window_open
    FROM firsts f
    GROUP BY f.key
  ),
  agg AS (
    SELECT key,
      COALESCE(SUM(lines), 0)::int AS redemptions,
      COUNT(DISTINCT order_id)::int AS orders,
      COUNT(DISTINCT order_id) FILTER (WHERE status = 'delivered')::int AS delivered,
      COUNT(DISTINCT order_id) FILTER (WHERE cancelled)::int AS cancelled,
      COALESCE(SUM(discount) FILTER (WHERE NOT cancelled), 0)::float AS discount,
      COALESCE(SUM(total_amount) FILTER (WHERE status = 'delivered'), 0)::float AS revenue,
      COALESCE(SUM(line_revenue) FILTER (WHERE status = 'delivered'), 0)::float AS line_revenue,
      MIN(created_at) AS first_order_at,
      MAX(created_at) AS last_order_at
    FROM ord
    GROUP BY key
  )
  SELECT agg.*, COALESCE(cust.customers, 0) AS customers, COALESCE(cust.new_customers, 0) AS new_customers,
         COALESCE(cust.repeat_customers, 0) AS repeat_customers, COALESCE(cust.window_open, 0) AS window_open
  FROM agg LEFT JOIN cust ON cust.key = agg.key
`;

const PROMO_ATTRIBUTION = `
  SELECT r.promo_id AS key, r.order_id, SUM(COALESCE(r.discount_amount, 0)) AS discount,
         NULL::numeric AS line_revenue, COUNT(*) AS lines
  FROM promo_redemptions r
  WHERE ($1::int IS NULL OR r.promo_id = $1)
  GROUP BY r.promo_id, r.order_id
`;

// What an offer saved on a line: the phase 29 snapshot, else shelf
// price minus the charged unit price, times the packs (older lines)
const OFFER_SAVING_SQL = `
  CASE WHEN COALESCE(oi.offer_discount, 0) > 0 THEN oi.offer_discount
       ELSE COALESCE((oi.original_unit_price - oi.unit_price) * (oi.price / NULLIF(oi.unit_price, 0)) * oi.quantity, 0)
  END
`;

const OFFER_ATTRIBUTION = `
  SELECT oi.offer_id AS key, oi.order_id, SUM(${OFFER_SAVING_SQL}) AS discount,
         SUM(CASE WHEN COALESCE(oi.shopping_status, '') = 'refunded' THEN 0
                  ELSE COALESCE(oi.line_total, oi.price * oi.quantity, 0) END) AS line_revenue,
         COUNT(*) AS lines
  FROM order_items oi
  WHERE oi.offer_id IS NOT NULL AND ($1::int IS NULL OR oi.offer_id = $1)
  GROUP BY oi.offer_id, oi.order_id
`;

const toResult = (row, { withLines = false } = {}) => {
  const r = row || {};
  const customers = Number(r.customers || 0);
  return {
    redemptions: Number(r.redemptions || 0),
    orders: {
      placed: Number(r.orders || 0),
      delivered: Number(r.delivered || 0),
      cancelled: Number(r.cancelled || 0),
    },
    discountCost: round2(r.discount),
    revenue: round2(r.revenue),
    ...(withLines ? { offerLineSales: round2(r.line_revenue) } : {}),
    customers,
    newCustomers: Number(r.new_customers || 0),
    newCustomerRate: rate(r.new_customers, customers),
    repeatCustomers: Number(r.repeat_customers || 0),
    repeatRate: rate(r.repeat_customers, customers),
    repeatWindowOpen: Number(r.window_open || 0),
    firstOrderAt: r.first_order_at || null,
    lastOrderAt: r.last_order_at || null,
  };
};

const run = async (db, attribution, { key = null, from = null, to = null } = {}) => {
  const result = await db.query(resultsSql(attribution), [key, from, to, CANCELLED]);
  return new Map(result.rows.map((row) => [Number(row.key), row]));
};

// Map promo id -> result (all promos when promoId is null)
const promoResults = async (db, options = {}) => {
  const rows = await run(db, PROMO_ATTRIBUTION, { ...options, key: options.promoId ?? null });
  return new Map([...rows].map(([id, row]) => [id, toResult(row)]));
};

const offerResults = async (db, options = {}) => {
  const rows = await run(db, OFFER_ATTRIBUTION, { ...options, key: options.offerId ?? null });
  return new Map([...rows].map(([id, row]) => [id, toResult(row, { withLines: true })]));
};

const emptyResult = (options = {}) => toResult(null, options);

const DEFINITIONS = {
  redemptions: 'Times the code was applied (one per order).',
  orders: 'Orders placed with it: delivered and cancelled shown separately.',
  discountCost: 'Discount on orders that were not cancelled.',
  revenue: 'Order totals of the delivered orders.',
  newCustomers: "Customers whose first order on GetMe (not counting cancelled ones) used it.",
  repeatRate: 'Customers who had another order delivered within 30 days after their first order with it.',
};

module.exports = {
  readOptionalRange,
  promoResults,
  offerResults,
  emptyResult,
  DEFINITIONS,
};
