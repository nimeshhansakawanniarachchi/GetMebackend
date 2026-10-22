const db = require('../config/db');

const { SHOPPER_PAY_SQL } = require('./shopperPay');

// =====================================================
// GET EARNINGS
// GET /api/shopper/earnings
// Pay per delivered order = delivery fee + fast delivery fee + tip
// =====================================================

const getEarnings = async (req, res) => {
  try {
    const shopperId =
      req.shopper?.shopperId ||
      req.shopper?.id;

    const [summaryResult, daysResult, recentResult, weeksResult] = await Promise.all([
      db.query(
        `
        SELECT
          COALESCE(SUM(${SHOPPER_PAY_SQL}) FILTER (
            WHERE o.delivered_at >= date_trunc('day', NOW())
          ), 0)::float AS today,

          COUNT(*) FILTER (
            WHERE o.delivered_at >= date_trunc('day', NOW())
          )::int AS deliveries_today,

          COALESCE(SUM(${SHOPPER_PAY_SQL}) FILTER (
            WHERE o.delivered_at >= date_trunc('week', NOW())
          ), 0)::float AS this_week,

          COUNT(*) FILTER (
            WHERE o.delivered_at >= date_trunc('week', NOW())
          )::int AS deliveries_this_week,

          -- This week's tips (the rest of the pay is batch pay)
          COALESCE(SUM(COALESCE(o.tip_amount, 0)) FILTER (
            WHERE o.delivered_at >= date_trunc('week', NOW())
          ), 0)::float AS tips_this_week,

          COALESCE(SUM(${SHOPPER_PAY_SQL}), 0)::float AS lifetime,
          COUNT(*)::int AS deliveries_lifetime

        FROM orders o
        WHERE o.shopper_id = $1
          AND o.status = 'delivered'
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
          AND o.status = 'delivered'
          AND o.delivered_at >= day
          AND o.delivered_at < day + INTERVAL '1 day'
        GROUP BY day
        ORDER BY day ASC
        `,
        [shopperId]
      ),

      db.query(
        `
        SELECT
          o.id,
          o.delivered_at,
          o.delivery_address,
          COALESCE(o.delivery_fee, 0)::float AS delivery_fee,
          COALESCE(o.fast_delivery_fee, 0)::float AS fast_delivery_fee,
          ${SHOPPER_PAY_SQL}::float AS pay,
          COALESCE(o.tip_amount, 0)::float AS tip,
          COALESCE(
            (
              SELECT STRING_AGG(os.shop_name, ' + ' ORDER BY os.id)
              FROM order_shops os
              WHERE os.order_id = o.id
            ),
            'Order'
          ) AS shop_names
        FROM orders o
        WHERE o.shopper_id = $1
          AND o.status = 'delivered'
        ORDER BY o.delivered_at DESC NULLS LAST
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
          COALESCE(SUM(COALESCE(o.tip_amount, 0)), 0)::float AS tips,
          COUNT(o.id)::int AS count
        FROM generate_series(
          date_trunc('week', NOW()) - INTERVAL '7 weeks',
          date_trunc('week', NOW()),
          INTERVAL '1 week'
        ) AS week
        LEFT JOIN orders o
          ON o.shopper_id = $1
          AND o.status = 'delivered'
          AND o.delivered_at >= week
          AND o.delivered_at < week + INTERVAL '1 week'
        GROUP BY week
        ORDER BY week DESC
        `,
        [shopperId]
      ),
    ]);

    const summary = summaryResult.rows[0];

    return res.json({
      success: true,
      today: summary.today,
      deliveriesToday: summary.deliveries_today,
      thisWeek: summary.this_week,
      deliveriesThisWeek: summary.deliveries_this_week,
      tipsThisWeek: summary.tips_this_week,
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
        tip: row.tip,
        pay: row.pay,
      })),
      // Newest first: [{ weekStart: 'YYYY-MM-DD', total, tips, count }]
      weeks: weeksResult.rows.map((row) => ({
        weekStart: row.week_start,
        total: row.total,
        tips: row.tips,
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
