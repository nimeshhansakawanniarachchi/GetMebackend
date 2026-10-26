const pool = require('../../config/db');

const { readPage, pageMeta } = require('../../utils/pagination');

const { statusLabel } = require('../../utils/orderStatus');

const { SHOPPER_PAY_SQL, COMMISSION_SQL, SERVICE_EARNED_SQL } = require('../shopperPay');

// What the customer really paid for an order: card charges less
// refunds, and the cash the shopper collected at the door (order
// total less refunded items, settlementController)
const NET_CARD_PAID_SQL = `(
  SELECT COALESCE(SUM(cp.amount - cp.refunded_amount), 0)
  FROM card_payments cp
  WHERE cp.order_id = o.id AND cp.purpose IN ('order', 'order_extra')
    AND cp.status IN ('paid', 'partially_refunded', 'refunded')
)`;

const CASH_COLLECTED_SQL = `(
  SELECT COALESCE(SUM(se.cash_collected), 0)
  FROM shopper_earnings se
  WHERE se.order_id = o.id
)`;


// =====================================================
// PAYMENTS
// GET /api/admin/payments?method=&paymentStatus=&page=
// =====================================================

const listPayments = async (req, res) => {
  try {
    const paging = readPage(req.query);
    const where = [`o.status NOT IN ('cancelled', 'shopper_search_cancelled')`];
    const params = [];

    if (req.query.method) {
      params.push(String(req.query.method));
      where.push(`o.payment_method = $${params.length}`);
    }

    if (req.query.paymentStatus) {
      params.push(String(req.query.paymentStatus));
      where.push(`COALESCE(o.payment_status, 'unpaid') = $${params.length}`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [countResult, summaryResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM orders o ${whereSql}`, params),
      pool.query(
        `
        SELECT
          -- Paid by customers on delivered orders (refunds taken off)
          COALESCE(SUM(${NET_CARD_PAID_SQL} + ${CASH_COLLECTED_SQL}) FILTER (WHERE o.status = 'delivered'), 0)::float AS collected,
          COALESCE(SUM(${CASH_COLLECTED_SQL}) FILTER (WHERE o.status = 'delivered'), 0)::float AS cash,
          COALESCE(SUM(${NET_CARD_PAID_SQL}) FILTER (WHERE o.status = 'delivered'), 0)::float AS non_cash,
          -- Shopper's pay (delivery + priority + service fee + tip)
          COALESCE(SUM(${SHOPPER_PAY_SQL}) FILTER (WHERE o.status = 'delivered'), 0)::float AS shopper_pay,
          -- Service fees earned (refunded units go back to the customer)
          COALESCE(SUM(${SERVICE_EARNED_SQL}) FILTER (WHERE o.status = 'delivered'), 0)::float AS service_fees,
          -- GetMe's income: the GetMe fee kept (delivered + cancelled)
          COALESCE(SUM(${COMMISSION_SQL}) FILTER (WHERE o.getme_fee_kept IS NOT NULL), 0)::float AS commission
        FROM orders o
        `
      ),
    ]);

    const listParams = [...params, paging.pageSize, paging.offset];

    const result = await pool.query(
      `
      SELECT
        o.id, o.status, o.payment_method, o.payment_status, o.payment_id, o.paid_at,
        o.items_total, o.actual_items_total, o.delivery_fee, o.fast_delivery_fee,
        o.service_fee, o.getme_fee, o.getme_fee_percent, o.getme_fee_kept,
        o.total_amount, o.reimbursement_status, o.reimbursement_amount,
        o.created_at,
        ${SHOPPER_PAY_SQL}::float AS shopper_pay,
        c.full_name AS customer_name,
        sh.full_name AS shopper_name,
        (
          SELECT COUNT(*)::int FROM order_shop_bills b
          WHERE b.order_id = o.id AND b.bill_url IS NOT NULL
        ) AS bill_count
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN shoppers sh ON sh.id = o.shopper_id
      ${whereSql}
      ORDER BY o.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    const summary = summaryResult.rows[0];

    return res.json({
      success: true,
      ...pageMeta(paging, countResult.rows[0].total),
      summary: {
        collected: summary.collected,
        cash: summary.cash,
        nonCash: summary.non_cash,
        shopperPay: summary.shopper_pay,
        serviceFees: summary.service_fees,
        commission: summary.commission,
      },
      payments: result.rows.map((row) => ({
        orderId: row.id,
        status: row.status,
        statusLabel: statusLabel(row.status),
        customerName: row.customer_name || 'Customer',
        shopperName: row.shopper_name || null,
        method: row.payment_method,
        paymentStatus: row.payment_status || 'unpaid',
        reference: row.payment_id,
        paidAt: row.paid_at,
        itemsTotal: Number(row.items_total || 0),
        actualItemsTotal: row.actual_items_total != null ? Number(row.actual_items_total) : null,
        deliveryFee: Number(row.delivery_fee || 0),
        fastDeliveryFee: Number(row.fast_delivery_fee || 0),
        serviceFee: Number(row.service_fee || 0),
        getmeFee: Number(row.getme_fee || 0),
        getmeFeePercent: Number(row.getme_fee_percent || 0),
        getmeFeeKept: row.getme_fee_kept != null ? Number(row.getme_fee_kept) : null,
        totalAmount: Number(row.total_amount || 0),
        shopperPay: row.shopper_pay,
        reimbursementStatus: row.reimbursement_status,
        reimbursementAmount: row.reimbursement_amount != null ? Number(row.reimbursement_amount) : null,
        billCount: row.bill_count,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin listPayments error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load payments' });
  }
};


// =====================================================
// REPORTS
// GET /api/admin/reports?days=7|30|90
// =====================================================

const getReports = async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days))
      ? Number(req.query.days)
      : 30;

    const since = `date_trunc('day', NOW()) - INTERVAL '${days - 1} days'`;

    const [dailyResult, totalsResult, shopsResult, productsResult, statusResult] =
      await Promise.all([
        pool.query(
          `
          SELECT
            to_char(day, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(o.total_amount) FILTER (WHERE o.status = 'delivered'), 0)::float AS sales,
            COUNT(o.id)::int AS orders
          FROM generate_series(${since}, date_trunc('day', NOW()), INTERVAL '1 day') AS day
          LEFT JOIN orders o
            ON o.created_at >= day AND o.created_at < day + INTERVAL '1 day'
          GROUP BY day
          ORDER BY day
          `
        ),
        pool.query(
          `
          SELECT
            COUNT(*)::int AS orders,
            COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
            COUNT(*) FILTER (WHERE status IN ('cancelled', 'shopper_search_cancelled'))::int AS cancelled,
            COALESCE(SUM(total_amount) FILTER (WHERE status = 'delivered'), 0)::float AS sales,
            COALESCE(AVG(total_amount) FILTER (WHERE status = 'delivered'), 0)::float AS average_order,
            COUNT(DISTINCT customer_id)::int AS customers
          FROM orders
          WHERE created_at >= ${since}
          `
        ),
        pool.query(
          `
          SELECT s.id, s.shop_name,
                 COUNT(DISTINCT o.id)::int AS orders,
                 COALESCE(SUM(oi.price * oi.quantity), 0)::float AS sales
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          JOIN shops s ON s.id = oi.shop_id
          WHERE o.status = 'delivered' AND o.created_at >= ${since}
          GROUP BY s.id
          ORDER BY sales DESC
          LIMIT 5
          `
        ),
        pool.query(
          `
          SELECT oi.item_name, COALESCE(SUM(oi.quantity), 0)::float AS quantity,
                 COALESCE(SUM(oi.price * oi.quantity), 0)::float AS sales
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE o.status = 'delivered' AND o.created_at >= ${since}
          GROUP BY oi.item_name
          ORDER BY quantity DESC
          LIMIT 5
          `
        ),
        pool.query(
          `
          SELECT status, COUNT(*)::int AS count
          FROM orders
          WHERE created_at >= ${since}
          GROUP BY status
          ORDER BY count DESC
          `
        ),
      ]);

    const totals = totalsResult.rows[0];

    return res.json({
      success: true,
      days,
      totals: {
        orders: totals.orders,
        delivered: totals.delivered,
        cancelled: totals.cancelled,
        sales: totals.sales,
        averageOrder: totals.average_order,
        customers: totals.customers,
        completionRate: totals.orders ? totals.delivered / totals.orders : 0,
      },
      daily: dailyResult.rows,
      topShops: shopsResult.rows.map((row) => ({
        id: row.id,
        shopName: row.shop_name,
        orders: row.orders,
        sales: row.sales,
      })),
      topProducts: productsResult.rows.map((row) => ({
        name: row.item_name,
        quantity: row.quantity,
        sales: row.sales,
      })),
      ordersByStatus: statusResult.rows.map((row) => ({
        status: row.status,
        label: statusLabel(row.status),
        count: row.count,
      })),
    });
  } catch (error) {
    console.error('❌ admin getReports error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load reports' });
  }
};

module.exports = {
  listPayments,
  getReports,
};
