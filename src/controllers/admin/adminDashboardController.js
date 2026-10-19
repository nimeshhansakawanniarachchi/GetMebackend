const pool = require('../../config/db');

const {
  ORDER_STATUS_GROUPS,
  statusLabel,
} = require('../../utils/orderStatus');


// =====================================================
// DASHBOARD
// GET /api/admin/dashboard
// =====================================================

const getDashboard = async (req, res) => {
  try {
    const [
      statsResult,
      approvalsResult,
      salesResult,
      statusResult,
      recentResult,
    ] = await Promise.all([
      pool.query(
        `
        SELECT
          COALESCE(SUM(total_amount) FILTER (
            WHERE status = 'delivered'
              AND COALESCE(delivered_at, updated_at) >= date_trunc('day', NOW())
          ), 0)::float AS sales_today,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int AS orders_today,
          COUNT(*) FILTER (WHERE status = ANY($1))::int AS active_orders,
          (SELECT COUNT(*)::int FROM customers) AS total_customers,
          (SELECT COUNT(*)::int FROM shoppers WHERE status = 'online') AS online_shoppers,
          (SELECT COUNT(*)::int FROM shops WHERE status = 'approved') AS live_shops
        FROM orders
        `,
        [[...ORDER_STATUS_GROUPS.active, ...ORDER_STATUS_GROUPS.delivery]]
      ),

      pool.query(
        `
        SELECT
          (SELECT COUNT(*)::int FROM shops WHERE status = 'pending') AS shops,
          (SELECT COUNT(*)::int FROM shoppers WHERE approval_status = 'pending') AS shoppers
        `
      ),

      pool.query(
        `
        SELECT
          to_char(day, 'YYYY-MM-DD') AS date,
          COALESCE(SUM(o.total_amount), 0)::float AS sales,
          COUNT(o.id)::int AS orders
        FROM generate_series(
          date_trunc('day', NOW()) - INTERVAL '6 days',
          date_trunc('day', NOW()),
          INTERVAL '1 day'
        ) AS day
        LEFT JOIN orders o
          ON o.status = 'delivered'
          AND COALESCE(o.delivered_at, o.updated_at) >= day
          AND COALESCE(o.delivered_at, o.updated_at) < day + INTERVAL '1 day'
        GROUP BY day
        ORDER BY day
        `
      ),

      pool.query(
        'SELECT status, COUNT(*)::int AS count FROM orders GROUP BY status'
      ),

      pool.query(
        `
        SELECT
          o.id, o.status, o.total_amount, o.created_at,
          c.full_name AS customer_name,
          (
            SELECT STRING_AGG(os.shop_name, ' + ' ORDER BY os.id)
            FROM order_shops os WHERE os.order_id = o.id
          ) AS shop_names
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        ORDER BY o.created_at DESC
        LIMIT 6
        `
      ),
    ]);

    const stats = statsResult.rows[0];
    const approvals = approvalsResult.rows[0];

    return res.json({
      success: true,
      stats: {
        salesToday: stats.sales_today,
        ordersToday: stats.orders_today,
        activeOrders: stats.active_orders,
        totalCustomers: stats.total_customers,
        onlineShoppers: stats.online_shoppers,
        liveShops: stats.live_shops,
      },
      pendingApprovals: {
        shops: approvals.shops,
        shoppers: approvals.shoppers,
        total: approvals.shops + approvals.shoppers,
      },
      salesLast7Days: salesResult.rows,
      ordersByStatus: statusResult.rows.map((row) => ({
        status: row.status,
        label: statusLabel(row.status),
        count: row.count,
      })),
      recentOrders: recentResult.rows.map((row) => ({
        id: row.id,
        status: row.status,
        statusLabel: statusLabel(row.status),
        customerName: row.customer_name || 'Customer',
        shopNames: row.shop_names || '—',
        totalAmount: Number(row.total_amount || 0),
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin getDashboard error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load dashboard' });
  }
};

module.exports = {
  getDashboard,
};
