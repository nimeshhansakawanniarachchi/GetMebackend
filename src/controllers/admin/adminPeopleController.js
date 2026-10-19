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

    const [customerResult, ordersResult, addressesResult] = await Promise.all([
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
        LIMIT 50
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
    ]);

    const customer = customerResult.rows[0];

    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    const orders = ordersResult.rows;

    return res.json({
      success: true,
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        mobile: customer.mobile,
        email: customer.email,
        createdAt: customer.created_at,
        orderCount: orders.length,
        totalSpent: orders
          .filter((order) => order.status === 'delivered')
          .reduce((total, order) => total + Number(order.total_amount || 0), 0),
      },
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
