const pool = require('../../config/db');

const { readPage, pageMeta } = require('../../utils/pagination');

const { statusLabel } = require('../../utils/orderStatus');

const { SHOPPER_PAY_SQL } = require('../shopperPay');

const { emitToAdmins } = require('../../realtime');

const {
  createShopperNotification,
} = require('../shopperNotificationController');

const searchParam = (query) => {
  const search = String(query?.search || '').trim().toLowerCase();

  return search ? `%${search}%` : null;
};


// =====================================================
// CUSTOMERS
// GET /api/admin/customers?search=&page=
// =====================================================

const listCustomers = async (req, res) => {
  try {
    const paging = readPage(req.query);
    const like = searchParam(req.query);

    const params = [];
    let whereSql = '';

    if (like) {
      params.push(like);
      whereSql = `WHERE LOWER(c.full_name) LIKE $1 OR LOWER(c.email) LIKE $1 OR c.mobile LIKE $1`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM customers c ${whereSql}`,
      params
    );

    const listParams = [...params, paging.pageSize, paging.offset];

    const result = await pool.query(
      `
      SELECT
        c.id, c.full_name, c.mobile, c.email, c.created_at,
        COUNT(o.id)::int AS order_count,
        COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = 'delivered'), 0)::float AS total_spent,
        MAX(o.created_at) AS last_order_at
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      ${whereSql}
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.json({
      success: true,
      ...pageMeta(paging, countResult.rows[0].total),
      customers: result.rows.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        mobile: row.mobile,
        email: row.email,
        orderCount: row.order_count,
        totalSpent: row.total_spent,
        lastOrderAt: row.last_order_at,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin listCustomers error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load customers' });
  }
};


// =====================================================
// CUSTOMER DETAIL
// GET /api/admin/customers/:id
// =====================================================

const getCustomer = async (req, res) => {
  try {
    const customerId = Number(req.params.id);

    if (!Number.isInteger(customerId)) {
      return res.status(400).json({ success: false, message: 'Invalid customer ID' });
    }

    const [customerResult, ordersResult, addressesResult, statsResult, paymentsResult, ratingsResult, auditResult] = await Promise.all([
      pool.query(
        'SELECT id, full_name, mobile, email, created_at FROM customers WHERE id = $1',
        [customerId]
      ),
      pool.query(
        `
        SELECT
          o.id, o.status, o.total_amount, o.created_at,
          (
            SELECT STRING_AGG(os.shop_name, ' + ' ORDER BY os.id)
            FROM order_shops os WHERE os.order_id = o.id
          ) AS shop_names
        FROM orders o
        WHERE o.customer_id = $1
        ORDER BY o.created_at DESC
        LIMIT 100
        `,
        [customerId]
      ),
      pool.query(
        `
        SELECT id, label, address, unit, building
        FROM customer_addresses
        WHERE customer_id = $1
        ORDER BY last_used_at DESC
        `,
        [customerId]
      ),
      // Totals over every order (not just the 100 listed). Spent =
      // what was actually collected: card charges less refunds + cash
      pool.query(
        `
        SELECT
          COUNT(*)::int AS orders,
          COUNT(*) FILTER (WHERE o.status = 'delivered')::int AS delivered,
          COUNT(*) FILTER (WHERE o.status IN ('cancelled', 'shopper_search_cancelled'))::int AS cancelled,
          COUNT(*) FILTER (WHERE o.status NOT IN ('delivered', 'cancelled', 'shopper_search_cancelled'))::int AS active,
          COALESCE(SUM(o.tip_amount) FILTER (WHERE o.status = 'delivered'), 0)::float AS tips,
          MIN(o.created_at) AS first_order_at,
          MAX(o.created_at) AS last_order_at,
          (
            SELECT COALESCE(SUM(cp.amount - cp.refunded_amount), 0)::float FROM card_payments cp
            WHERE cp.owner_type = 'customer' AND cp.owner_id = $1 AND cp.purpose IN ('order', 'order_extra')
              AND cp.status IN ('paid', 'partially_refunded', 'refunded')
          ) AS card_net,
          (
            SELECT COALESCE(SUM(r.amount), 0)::float FROM card_payment_refunds r
            JOIN card_payments cp ON cp.id = r.card_payment_id
            WHERE cp.owner_type = 'customer' AND cp.owner_id = $1 AND cp.purpose IN ('order', 'order_extra')
          ) AS refunded,
          (
            SELECT COALESCE(SUM(se.cash_collected), 0)::float FROM shopper_earnings se
            JOIN orders o2 ON o2.id = se.order_id WHERE o2.customer_id = $1
          ) AS cash
        FROM orders o WHERE o.customer_id = $1
        `,
        [customerId]
      ),
      pool.query(
        `
        SELECT cp.id, cp.order_id, cp.purpose, cp.amount::float AS amount, cp.status, cp.status_message,
               cp.card_brand, cp.card_last4, cp.refunded_amount::float AS refunded_amount, cp.gateway,
               cp.created_at, cp.paid_at
        FROM card_payments cp
        WHERE cp.owner_type = 'customer' AND cp.owner_id = $1 AND cp.purpose IN ('order', 'order_extra')
        ORDER BY cp.created_at DESC LIMIT 100
        `,
        [customerId]
      ),
      pool.query(
        'SELECT order_id, shopper_id, rating, comment, created_at FROM order_ratings WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20',
        [customerId]
      ),
      pool.query(
        "SELECT created_at, admin_name, action, summary FROM admin_audit_log WHERE entity_type = 'customer' AND entity_id = $1 ORDER BY created_at DESC LIMIT 50",
        [String(customerId)]
      ),
    ]);

    const customer = customerResult.rows[0];

    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const orders = ordersResult.rows;
    const stats = statsResult.rows[0];
    const spent = Math.round((Number(stats.card_net) + Number(stats.cash)) * 100) / 100;

    return res.json({
      success: true,
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        mobile: customer.mobile,
        email: customer.email,
        createdAt: customer.created_at,
        orderCount: stats.orders,
        // Collected from the customer (card net of refunds + cash)
        totalSpent: spent,
      },
      stats: {
        orders: stats.orders,
        delivered: stats.delivered,
        cancelled: stats.cancelled,
        active: stats.active,
        tips: Number(stats.tips),
        cardPaidNet: Number(stats.card_net),
        cashPaid: Number(stats.cash),
        refunded: Number(stats.refunded),
        totalPaid: spent,
        firstOrderAt: stats.first_order_at,
        lastOrderAt: stats.last_order_at,
      },
      payments: paymentsResult.rows.map((row) => ({
        id: row.id,
        orderId: row.order_id,
        purpose: row.purpose,
        amount: row.amount,
        status: row.status,
        statusMessage: row.status_message,
        card: row.card_last4 ? `${row.card_brand || 'Card'} •••• ${row.card_last4}` : null,
        refundedAmount: row.refunded_amount,
        testMode: row.gateway === 'test',
        createdAt: row.created_at,
        paidAt: row.paid_at,
      })),
      ratings: ratingsResult.rows.map((row) => ({
        orderId: row.order_id,
        shopperId: row.shopper_id,
        rating: Number(row.rating),
        comment: row.comment,
        createdAt: row.created_at,
      })),
      audit: auditResult.rows.map((row) => ({
        at: row.created_at,
        adminName: row.admin_name,
        action: row.action,
        summary: row.summary,
      })),
      addresses: addressesResult.rows.map((row) => ({
        id: row.id,
        label: row.label,
        address: [row.unit, row.building, row.address].filter(Boolean).join(', '),
      })),
      orders: orders.map((row) => ({
        id: row.id,
        status: row.status,
        statusLabel: statusLabel(row.status),
        shopNames: row.shop_names || '—',
        totalAmount: Number(row.total_amount || 0),
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin getCustomer error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load customer' });
  }
};


// =====================================================
// SHOPPERS
// GET /api/admin/shoppers?approval=pending|approved|rejected|suspended
//   &online=true&search=&page=
// =====================================================

const listShoppers = async (req, res) => {
  try {
    const paging = readPage(req.query);
    const where = [];
    const params = [];

    if (['pending', 'approved', 'rejected', 'suspended'].includes(req.query.approval)) {
      params.push(req.query.approval);
      where.push(`s.approval_status = $${params.length}`);
    }

    if (req.query.online === 'true') {
      where.push(`s.status = 'online'`);
    }

    const like = searchParam(req.query);

    if (like) {
      params.push(like);
      where.push(`(LOWER(s.full_name) LIKE $${params.length} OR LOWER(s.email) LIKE $${params.length} OR s.mobile LIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM shoppers s ${whereSql}`,
      params
    );

    const listParams = [...params, paging.pageSize, paging.offset];

    const result = await pool.query(
      `
      SELECT
        s.id, s.full_name, s.mobile, s.email, s.status, s.approval_status,
        s.vehicle_type, s.vehicle_number, s.latitude, s.longitude,
        s.created_at, s.updated_at,
        COUNT(o.id) FILTER (WHERE o.status = 'delivered')::int AS deliveries,
        COALESCE(SUM(${SHOPPER_PAY_SQL}) FILTER (WHERE o.status = 'delivered'), 0)::float AS earnings,
        COUNT(o.id) FILTER (
          WHERE o.status IN ('shopper_accepted', 'shopping', 'out_for_delivery', 'arrived')
        )::int AS active_jobs
      FROM shoppers s
      LEFT JOIN orders o ON o.shopper_id = s.id
      ${whereSql}
      GROUP BY s.id
      ORDER BY
        CASE s.approval_status WHEN 'pending' THEN 0 ELSE 1 END,
        s.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.json({
      success: true,
      ...pageMeta(paging, countResult.rows[0].total),
      shoppers: result.rows.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        mobile: row.mobile,
        email: row.email,
        online: row.status === 'online',
        approvalStatus: row.approval_status,
        vehicleType: row.vehicle_type,
        vehicleNumber: row.vehicle_number,
        latitude: row.latitude,
        longitude: row.longitude,
        deliveries: row.deliveries,
        earnings: row.earnings,
        activeJobs: row.active_jobs,
        createdAt: row.created_at,
        lastSeenAt: row.updated_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin listShoppers error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load shoppers' });
  }
};


// =====================================================
// APPROVE / REJECT / SUSPEND SHOPPER
// PATCH /api/admin/shoppers/:id/approval { approvalStatus }
// =====================================================

const APPROVAL_MESSAGES = {
  approved: ['Account approved', 'You can now go online and start accepting batches.'],
  rejected: ['Application not approved', 'Your shopper application was not approved.'],
  suspended: ['Account suspended', 'Your shopper account is suspended. Please contact GetMe support.'],
  pending: ['Account under review', 'GetMe is reviewing your shopper account.'],
};

const setShopperApproval = async (req, res) => {
  try {
    const shopperId = Number(req.params.id);
    const approvalStatus = String(req.body?.approvalStatus || '');

    if (!Number.isInteger(shopperId) || !APPROVAL_MESSAGES[approvalStatus]) {
      return res.status(400).json({ success: false, message: 'Invalid request' });
    }

    // Anyone not approved is taken offline immediately
    const result = await pool.query(
      `
      UPDATE shoppers
      SET
        approval_status = $1::varchar,
        status = CASE WHEN $1::varchar = 'approved' THEN status ELSE 'offline' END,
        updated_at = NOW()
      WHERE id = $2
      RETURNING id, approval_status, status
      `,
      [approvalStatus, shopperId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shopper not found' });
    }

    const io = req.app.get('io');
    const [title, body] = APPROVAL_MESSAGES[approvalStatus];

    io?.to(`shopper:${shopperId}`).emit('shopper-approval-changed', {
      approvalStatus,
    });

    createShopperNotification({ io, shopperId, type: `account_${approvalStatus}`, title, body });

    emitToAdmins(io, 'admin:shoppers-updated', { shopperId, reason: 'approval' });

    return res.json({
      success: true,
      shopper: {
        id: result.rows[0].id,
        approvalStatus: result.rows[0].approval_status,
        online: result.rows[0].status === 'online',
      },
    });
  } catch (error) {
    console.error('❌ admin setShopperApproval error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update shopper' });
  }
};

module.exports = {
  listCustomers,
  getCustomer,
  listShoppers,
  setShopperApproval,
};
