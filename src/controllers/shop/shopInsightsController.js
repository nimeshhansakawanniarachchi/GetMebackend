const ExcelJS = require('exceljs');

const pool = require('../../config/db');
const { toProduct, statusLabel, firstName } = require('./shopFormat');
const { ORDER_STATUS_GROUPS } = require('../../utils/orderStatus');
const { readPage } = require('../../utils/pagination');
const { adjustStock, REASON_LABELS, MANUAL_REASONS } = require('../../inventory/stockService');
const { actorOf, shopCan } = require('../../middleware/shopAccess');

// =====================================================
// SHOP PORTAL INSIGHTS (phase 27)
//   GET  /api/shop/dashboard                 (superset of the old shape)
//   GET  /api/shop/bills?page&from&to&status
//   GET  /api/shop/notifications
//   GET  /api/shop/stock/movements?page&productId&reason&from&to
//   GET  /api/shop/products/:id/stock-history
//   POST /api/shop/products/:id/stock        { mode, quantity, reason, note }
//   GET  /api/shop/products/export?format=xlsx|csv
// A shop only ever sees its own rows (shop_id = the signed-in shop).
// "Till takings" = what GetMe shoppers recorded paying at this shop
// (store_payments), the money the shop actually received.
// =====================================================

const ACTIVE = ORDER_STATUS_GROUPS.active;
const CANCELLED = ORDER_STATUS_GROUPS.cancelled;
const BOUGHT = ['found', 'replaced', 'done', 'completed'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (v) => Math.round(Number(v || 0) * 100) / 100;

const billState = (row) => {
  if (!row.locked_at) return 'awaiting_bill';
  if (['ok', 'approved'].includes(row.review_status)) return 'verified';
  return 'under_review';
};

// =====================================================
// DASHBOARD
// =====================================================

const getDashboard = async (req, res) => {
  try {
    const shopId = req.shop.shopId;
    const seeSales = shopCan(req.shop.role, 'viewSales');
    const shop = (await pool.query('SELECT low_stock_threshold FROM shops WHERE id = $1', [shopId])).rows[0];
    const threshold = shop?.low_stock_threshold ?? 5;

    const [orders, products, lowList, offers, till, trend, top, recent] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE o.created_at >= date_trunc('day', NOW()) AND o.status <> ALL($2))::int AS orders_today,
          COUNT(*) FILTER (WHERE o.status = ANY($3))::int AS active_orders,
          COUNT(*) FILTER (WHERE o.status IN ('pending_shopper_search', 'waiting_for_shopper'))::int AS awaiting_shopper,
          COUNT(*) FILTER (WHERE o.status = 'shopper_accepted')::int AS assigned,
          COUNT(*) FILTER (WHERE o.status = 'shopping')::int AS shopping,
          COUNT(*) FILTER (WHERE o.status IN ('out_for_delivery', 'arrived'))::int AS out_for_delivery,
          COUNT(*) FILTER (WHERE o.status = 'delivered' AND o.delivered_at >= date_trunc('day', NOW()))::int AS completed_today,
          COUNT(*) FILTER (WHERE o.status = 'delivered' AND o.delivered_at >= date_trunc('week', NOW()))::int AS completed_week,
          COUNT(*) FILTER (WHERE o.status = ANY($2) AND o.created_at >= date_trunc('day', NOW()))::int AS cancelled_today,
          COUNT(*) FILTER (WHERE o.status = ANY($2) AND o.created_at >= date_trunc('week', NOW()))::int AS cancelled_week
        FROM order_shops os JOIN orders o ON o.id = os.order_id
        WHERE os.shop_id = $1
        `,
        [shopId, CANCELLED, ACTIVE]
      ),
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_available AND stock_quantity > 0)::int AS live,
          COUNT(*) FILTER (WHERE stock_quantity <= 0 OR is_available = false)::int AS unavailable,
          COUNT(*) FILTER (WHERE NOT is_available)::int AS hidden,
          COUNT(*) FILTER (WHERE stock_quantity <= 0)::int AS out_of_stock,
          COUNT(*) FILTER (WHERE stock_quantity BETWEEN 1 AND $2)::int AS low_stock
        FROM products WHERE shop_id = $1
        `,
        [shopId, threshold]
      ),
      pool.query(
        `
        SELECT id, product_name, stock_quantity, image_url, unit, is_available
        FROM products WHERE shop_id = $1 AND stock_quantity <= $2
        ORDER BY stock_quantity ASC, product_name LIMIT 6
        `,
        [shopId, threshold]
      ),
      pool.query(
        `
        SELECT
          COUNT(*) FILTER (WHERE is_active AND NOT paused_by_admin AND (starts_at IS NULL OR starts_at <= NOW()) AND (ends_at IS NULL OR ends_at > NOW()))::int AS live,
          COUNT(*) FILTER (WHERE is_active AND NOT paused_by_admin AND starts_at > NOW())::int AS scheduled,
          COUNT(*) FILTER (WHERE is_active AND NOT paused_by_admin AND ends_at > NOW() AND ends_at <= NOW() + INTERVAL '48 hours' AND (starts_at IS NULL OR starts_at <= NOW()))::int AS ending_soon,
          COUNT(*) FILTER (WHERE paused_by_admin)::int AS paused_by_admin
        FROM product_offers WHERE shop_id = $1
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT
          COALESCE(SUM(amount_paid) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0)::float AS today,
          COALESCE(SUM(amount_paid) FILTER (WHERE created_at >= date_trunc('week', NOW())), 0)::float AS week,
          COALESCE(SUM(amount_paid) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::float AS month,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('month', NOW()))::int AS bills_month
        FROM store_payments WHERE shop_id = $1
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT to_char(day, 'YYYY-MM-DD') AS date,
          (SELECT COUNT(DISTINCT o.id)::int FROM order_shops os JOIN orders o ON o.id = os.order_id
            WHERE os.shop_id = $1 AND o.created_at >= day AND o.created_at < day + INTERVAL '1 day') AS orders,
          (SELECT COUNT(DISTINCT o.id)::int FROM order_shops os JOIN orders o ON o.id = os.order_id
            WHERE os.shop_id = $1 AND o.status = ANY($2) AND o.created_at >= day AND o.created_at < day + INTERVAL '1 day') AS cancelled,
          (SELECT COALESCE(SUM(amount_paid), 0)::float FROM store_payments
            WHERE shop_id = $1 AND created_at >= day AND created_at < day + INTERVAL '1 day') AS till
        FROM generate_series(date_trunc('day', NOW()) - INTERVAL '13 days', date_trunc('day', NOW()), INTERVAL '1 day') AS day
        ORDER BY day
        `,
        [shopId, CANCELLED]
      ),
      pool.query(
        `
        SELECT COALESCE(oi.replacement_product_id, oi.product_id) AS product_id,
               MAX(COALESCE(oi.replacement_product_name, oi.item_name)) AS name,
               SUM(COALESCE(NULLIF(oi.found_quantity, 0), oi.quantity))::float AS units,
               COUNT(DISTINCT oi.order_id)::int AS orders
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.shop_id = $1 AND oi.shopping_status = ANY($2) AND o.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY units DESC LIMIT 5
        `,
        [shopId, BOUGHT]
      ),
      pool.query(
        `
        SELECT o.id, o.status, o.created_at, c.full_name AS customer_name,
               (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id AND oi.shop_id = os.shop_id) AS item_count,
               (SELECT COALESCE(SUM(oi.price * oi.quantity), 0)::float FROM order_items oi WHERE oi.order_id = o.id AND oi.shop_id = os.shop_id) AS shop_total
        FROM order_shops os JOIN orders o ON o.id = os.order_id
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE os.shop_id = $1
        ORDER BY o.created_at DESC LIMIT 8
        `,
        [shopId]
      ),
    ]);

    const o = orders.rows[0];
    const p = products.rows[0];
    const of = offers.rows[0];
    const t = till.rows[0];

    return res.json({
      success: true,
      // Original fields (kept for compatibility)
      stats: {
        ordersToday: o.orders_today,
        activeOrders: o.active_orders,
        salesToday: seeSales ? round2(t.today) : null,
        salesThisWeek: seeSales ? round2(t.week) : null,
        totalProducts: p.total,
        liveProducts: p.live,
        unavailableProducts: p.unavailable,
        lowStockProducts: p.low_stock,
      },
      orders: {
        today: o.orders_today,
        active: o.active_orders,
        awaitingShopper: o.awaiting_shopper,
        assigned: o.assigned,
        shopping: o.shopping,
        outForDelivery: o.out_for_delivery,
        completedToday: o.completed_today,
        completedWeek: o.completed_week,
        cancelledToday: o.cancelled_today,
        cancelledWeek: o.cancelled_week,
      },
      products: {
        total: p.total, live: p.live, hidden: p.hidden, outOfStock: p.out_of_stock, lowStock: p.low_stock,
        lowStockThreshold: threshold,
        attention: lowList.rows.map((r) => ({
          id: r.id, name: r.product_name, stockQuantity: Number(r.stock_quantity), imageUrl: r.image_url, unit: r.unit, isAvailable: r.is_available,
        })),
      },
      offers: { live: of.live, scheduled: of.scheduled, endingSoon: of.ending_soon, pausedByAdmin: of.paused_by_admin },
      // Money the shop received from GetMe shoppers (owner / manager)
      till: seeSales ? { today: round2(t.today), week: round2(t.week), month: round2(t.month), billsThisMonth: t.bills_month } : null,
      trend: trend.rows.map((r) => ({ date: r.date, orders: r.orders, cancelled: r.cancelled, till: seeSales ? round2(r.till) : null })),
      topProducts: top.rows.map((r) => ({ productId: r.product_id, name: r.name, units: r.units, orders: r.orders })),
      recentOrders: recent.rows.map((row) => ({
        id: row.id,
        status: row.status,
        statusLabel: statusLabel(row.status),
        customerName: firstName(row.customer_name),
        itemCount: row.item_count,
        shopTotal: row.shop_total,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ shop dashboard error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load dashboard' });
  }
};

// =====================================================
// BILLS (the shopper's till receipts for this shop)
// =====================================================

const BILL_FILTERS = {
  verified: "sp.locked_at IS NOT NULL AND sp.review_status IN ('ok', 'approved')",
  under_review: "sp.locked_at IS NOT NULL AND sp.review_status NOT IN ('ok', 'approved')",
  awaiting_bill: 'sp.locked_at IS NULL',
};

const getBills = async (req, res) => {
  try {
    const shopId = req.shop.shopId;
    const { page, pageSize } = readPage(req.query, 20);
    const where = ['sp.shop_id = $1'];
    const params = [shopId];

    if (DATE.test(req.query.from || '')) {
      params.push(req.query.from);
      where.push(`sp.created_at >= $${params.length}::date`);
    }
    if (DATE.test(req.query.to || '')) {
      params.push(req.query.to);
      where.push(`sp.created_at < $${params.length}::date + INTERVAL '1 day'`);
    }
    if (BILL_FILTERS[req.query.status]) where.push(BILL_FILTERS[req.query.status]);
    const orderId = Number(req.query.orderId);
    if (Number.isInteger(orderId) && orderId > 0) {
      params.push(orderId);
      where.push(`sp.order_id = $${params.length}`);
    }

    const whereSql = where.join(' AND ');

    const [count, rows, totals] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM store_payments sp WHERE ${whereSql}`, params),
      pool.query(
        `
        SELECT sp.id, sp.order_id, sp.method, sp.amount_paid::float AS amount_paid, sp.expected_amount::float AS expected_amount,
               sp.variance::float AS variance, sp.review_status, sp.locked_at, sp.created_at,
               sh.full_name AS shopper_name, o.status AS order_status,
               b.bill_url, b.bill_urls, b.bill_uploaded_at
        FROM store_payments sp
        JOIN orders o ON o.id = sp.order_id
        LEFT JOIN shoppers sh ON sh.id = sp.shopper_id
        LEFT JOIN LATERAL (
          SELECT bill_url, bill_urls, bill_uploaded_at FROM order_shop_bills
          WHERE order_id = sp.order_id AND shop_id = sp.shop_id ORDER BY id DESC LIMIT 1
        ) b ON TRUE
        WHERE ${whereSql}
        ORDER BY sp.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, pageSize, (page - 1) * pageSize]
      ),
      pool.query(
        `
        SELECT COUNT(*)::int AS bills, COALESCE(SUM(amount_paid), 0)::float AS paid,
               COALESCE(SUM(expected_amount), 0)::float AS expected
        FROM store_payments sp WHERE ${whereSql}
        `,
        params
      ),
    ]);

    const total = count.rows[0].total;
    const tt = totals.rows[0];

    return res.json({
      success: true,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      totals: { bills: tt.bills, paid: round2(tt.paid), expected: round2(tt.expected), difference: round2(tt.paid - tt.expected) },
      bills: rows.rows.map((r) => ({
        id: r.id,
        orderId: r.order_id,
        orderStatus: r.order_status,
        orderStatusLabel: statusLabel(r.order_status),
        method: r.method,
        amountPaid: r.amount_paid,
        // What the items cost at the prices listed on GetMe
        expectedAmount: r.expected_amount,
        difference: r.variance,
        state: billState(r),
        shopperName: firstName(r.shopper_name),
        recordedAt: r.created_at,
        uploadedAt: r.bill_uploaded_at,
        photos: Array.isArray(r.bill_urls) && r.bill_urls.length ? r.bill_urls : r.bill_url ? [r.bill_url] : [],
      })),
    });
  } catch (error) {
    console.error('❌ shop getBills error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load bills' });
  }
};

// =====================================================
// NOTIFICATIONS (worked out from the shop's data; read state is kept
// in the browser)
// =====================================================

const getNotifications = async (req, res) => {
  try {
    const shopId = req.shop.shopId;
    const threshold = (await pool.query('SELECT low_stock_threshold FROM shops WHERE id = $1', [shopId])).rows[0]?.low_stock_threshold ?? 5;

    const [newOrders, finished, stock, offers, activity, admin, tillPaid] = await Promise.all([
      pool.query(
        `
        SELECT o.id, o.created_at, o.delivery_option,
               (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id AND oi.shop_id = $1) AS items
        FROM order_shops os JOIN orders o ON o.id = os.order_id
        WHERE os.shop_id = $1 AND o.created_at >= NOW() - INTERVAL '48 hours'
        ORDER BY o.created_at DESC LIMIT 20
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT o.id, o.status, COALESCE(o.delivered_at, o.updated_at) AS at, o.failed_delivery_at
        FROM order_shops os JOIN orders o ON o.id = os.order_id
        WHERE os.shop_id = $1 AND o.status IN ('delivered', 'cancelled', 'shopper_search_cancelled')
          AND COALESCE(o.delivered_at, o.updated_at) >= NOW() - INTERVAL '48 hours'
        ORDER BY at DESC LIMIT 20
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT id, product_name, stock_quantity, updated_at
        FROM products WHERE shop_id = $1 AND is_available AND stock_quantity <= $2
        ORDER BY stock_quantity, product_name LIMIT 20
        `,
        [shopId, threshold]
      ),
      pool.query(
        `
        SELECT id, title, starts_at, ends_at, paused_by_admin, admin_note, updated_at,
          CASE
            WHEN paused_by_admin THEN 'paused'
            WHEN is_active AND ends_at > NOW() AND ends_at <= NOW() + INTERVAL '48 hours' AND (starts_at IS NULL OR starts_at <= NOW()) THEN 'ending'
            WHEN is_active AND ends_at <= NOW() AND ends_at > NOW() - INTERVAL '48 hours' THEN 'ended'
            WHEN is_active AND starts_at > NOW() AND starts_at <= NOW() + INTERVAL '24 hours' THEN 'starting'
          END AS kind
        FROM product_offers WHERE shop_id = $1
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT id, action, summary, created_at FROM shop_activity_log
        WHERE shop_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
          AND (action = 'product.import_failed' OR action IN ('shop.auto_open', 'shop.auto_close'))
        ORDER BY created_at DESC LIMIT 20
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT id, action, summary, created_at FROM admin_audit_log
        WHERE entity_type = 'shop' AND entity_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC LIMIT 10
        `,
        [String(shopId)]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `
        SELECT sp.id, sp.order_id, sp.amount_paid::float AS amount_paid, sp.created_at
        FROM store_payments sp WHERE sp.shop_id = $1 AND sp.created_at >= NOW() - INTERVAL '48 hours'
        ORDER BY sp.created_at DESC LIMIT 20
        `,
        [shopId]
      ),
    ]);

    const list = [];
    const add = (n) => list.push(n);
    const money = (v) => `Rs ${Number(v || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    newOrders.rows.forEach((r) => add({
      key: `order-new-${r.id}`, type: 'order', severity: 'info', at: r.created_at, link: `/orders/${r.id}`,
      title: `New order #${r.id}`, detail: `${r.items} item${r.items === 1 ? '' : 's'} from your shop${r.delivery_option === 'scheduled' ? ' · scheduled' : ''}`,
    }));
    finished.rows.forEach((r) => add({
      key: `order-done-${r.id}-${r.status}`, type: 'order', severity: r.status === 'delivered' ? 'success' : r.failed_delivery_at ? 'warning' : 'info', at: r.at, link: `/orders/${r.id}`,
      title: r.status === 'delivered' ? `Order #${r.id} delivered` : `Order #${r.id} cancelled`,
      detail: r.failed_delivery_at ? 'The delivery failed.' : r.status === 'delivered' ? 'The customer received it.' : 'No further action is needed.',
    }));
    tillPaid.rows.forEach((r) => add({
      key: `till-${r.id}`, type: 'bill', severity: 'info', at: r.created_at, link: `/bills?orderId=${r.order_id}`,
      title: `${money(r.amount_paid)} paid at your till`, detail: `GetMe shopper paid for order #${r.order_id}.`,
    }));
    stock.rows.forEach((r) => add({
      key: `stock-${r.id}-${r.stock_quantity}`, type: 'stock', severity: Number(r.stock_quantity) <= 0 ? 'danger' : 'warning', at: r.updated_at, link: '/inventory?stock=' + (Number(r.stock_quantity) <= 0 ? 'out' : 'low'),
      title: Number(r.stock_quantity) <= 0 ? `${r.product_name} is out of stock` : `${r.product_name} is low (${r.stock_quantity} left)`,
      detail: Number(r.stock_quantity) <= 0 ? 'Customers can’t see it until you add stock.' : `At or below your low-stock level of ${threshold}.`,
    }));
    offers.rows.filter((r) => r.kind).forEach((r) => add({
      key: `offer-${r.id}-${r.kind}`, type: 'offer', severity: r.kind === 'paused' ? 'danger' : r.kind === 'ending' ? 'warning' : 'info',
      at: r.kind === 'starting' ? r.starts_at : r.kind === 'paused' ? r.updated_at : r.ends_at, link: '/offers',
      title: r.kind === 'paused' ? `GetMe paused “${r.title}”` : r.kind === 'ending' ? `“${r.title}” ends soon` : r.kind === 'ended' ? `“${r.title}” has ended` : `“${r.title}” starts soon`,
      detail: r.kind === 'paused' ? (r.admin_note || 'Contact GetMe for details.') : r.kind === 'ending' ? 'Extend it if you want to keep the discount.' : r.kind === 'ended' ? 'Customers now see the regular price.' : 'Customers will see the discount when it starts.',
    }));
    activity.rows.forEach((r) => add({
      key: `act-${r.id}`, type: r.action === 'product.import_failed' ? 'import' : 'shop', severity: r.action === 'product.import_failed' ? 'danger' : 'info',
      at: r.created_at, link: r.action === 'product.import_failed' ? '/products/import' : '/profile',
      title: r.action === 'product.import_failed' ? 'Some products could not be imported' : r.summary, detail: r.action === 'product.import_failed' ? r.summary : 'Following your opening hours.',
    }));
    admin.rows.forEach((r) => add({
      key: `admin-${r.id}`, type: 'announcement', severity: 'info', at: r.created_at, link: '/profile',
      title: 'Update from GetMe', detail: r.summary || 'GetMe updated your shop.',
    }));

    list.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

    return res.json({ success: true, generatedAt: new Date().toISOString(), notifications: list.slice(0, 60) });
  } catch (error) {
    console.error('❌ shop notifications error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load notifications' });
  }
};

// =====================================================
// STOCK
// =====================================================

const toMovement = (r) => ({
  id: Number(r.id),
  productId: r.product_id,
  productName: r.product_name,
  change: r.change,
  stockBefore: r.stock_before,
  stockAfter: r.stock_after,
  reason: r.reason,
  reasonLabel: REASON_LABELS[r.reason] || r.reason,
  note: r.note,
  orderId: r.order_id,
  actorType: r.actor_type,
  actorName: r.actor_name,
  at: r.created_at,
});

const getStockMovements = async (req, res) => {
  try {
    const shopId = req.shop.shopId;
    const { page, pageSize } = readPage(req.query, 30);
    const where = ['m.shop_id = $1'];
    const params = [shopId];

    const productId = Number(req.query.productId);
    if (Number.isInteger(productId) && productId > 0) {
      params.push(productId);
      where.push(`m.product_id = $${params.length}`);
    }
    if (REASON_LABELS[req.query.reason]) {
      params.push(req.query.reason);
      where.push(`m.reason = $${params.length}`);
    }
    if (DATE.test(req.query.from || '')) {
      params.push(req.query.from);
      where.push(`m.created_at >= $${params.length}::date`);
    }
    if (DATE.test(req.query.to || '')) {
      params.push(req.query.to);
      where.push(`m.created_at < $${params.length}::date + INTERVAL '1 day'`);
    }

    const whereSql = where.join(' AND ');
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM product_stock_movements m WHERE ${whereSql}`, params),
      pool.query(
        `
        SELECT m.*, p.product_name FROM product_stock_movements m
        LEFT JOIN products p ON p.id = m.product_id
        WHERE ${whereSql}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, pageSize, (page - 1) * pageSize]
      ),
    ]);

    const total = count.rows[0].total;
    return res.json({
      success: true,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      reasons: Object.entries(REASON_LABELS).map(([value, label]) => ({ value, label, manual: MANUAL_REASONS.includes(value) })),
      movements: rows.rows.map(toMovement),
    });
  } catch (error) {
    console.error('❌ shop stock movements error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load stock history' });
  }
};

const getProductStockHistory = async (req, res) => {
  const productId = Number(req.params.id);
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid product ID' });
  }
  try {
    const product = (await pool.query('SELECT * FROM products WHERE id = $1 AND shop_id = $2', [productId, req.shop.shopId])).rows[0];
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    const rows = await pool.query(
      `SELECT m.*, $3::text AS product_name FROM product_stock_movements m
       WHERE m.product_id = $1 AND m.shop_id = $2 ORDER BY m.created_at DESC, m.id DESC LIMIT 100`,
      [productId, req.shop.shopId, product.product_name]
    );
    return res.json({ success: true, product: toProduct(product), movements: rows.rows.map(toMovement) });
  } catch (error) {
    console.error('❌ shop stock history error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load stock history' });
  }
};

const adjustProductStock = async (req, res) => {
  const productId = Number(req.params.id);
  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid product ID' });
  }
  try {
    const result = await adjustStock({
      shopId: req.shop.shopId,
      productId,
      mode: req.body?.mode,
      quantity: req.body?.quantity,
      reason: req.body?.reason,
      note: req.body?.note,
      actor: actorOf(req),
    });

    if (result.error) {
      return res.status(result.error.status).json({ success: false, code: result.error.code, message: result.error.message });
    }

    return res.json({
      success: true,
      message: result.movement ? `Stock is now ${result.product.stock_quantity}` : 'Stock unchanged',
      product: toProduct(result.product),
      movement: result.movement ? toMovement({ ...result.movement, product_name: result.product.product_name }) : null,
    });
  } catch (error) {
    console.error('❌ shop adjust stock error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update stock' });
  }
};

// =====================================================
// EXPORT (same columns as the import template, so it re-imports)
// =====================================================

const EXPORT_COLUMNS = [
  ['Product name *', 'product_name', 34],
  ['Category *', 'category', 24],
  ['Price (Rs) *', 'price', 13],
  ['Stock *', 'stock_quantity', 10],
  ['Sold as', 'unit', 12],
  ['Barcode', 'barcode', 18],
  ['Brand', 'brand', 16],
  ['Size', 'size', 12],
  ['Description', 'description', 40],
  ['Available', 'is_available', 11],
];

const csvCell = (value) => {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const exportProducts = async (req, res) => {
  try {
    const rows = (await pool.query('SELECT * FROM products WHERE shop_id = $1 ORDER BY LOWER(product_name)', [req.shop.shopId])).rows;
    const value = (row, key) => (key === 'is_available' ? (row.is_available ? 'Yes' : 'No') : key === 'price' ? Number(row.price) : key === 'stock_quantity' ? Number(row.stock_quantity) : row[key] ?? '');
    const stamp = new Date().toISOString().slice(0, 10);

    if (req.query.format === 'csv') {
      const lines = [EXPORT_COLUMNS.map(([h]) => h).join(','), ...rows.map((row) => EXPORT_COLUMNS.map(([, key]) => csvCell(value(row, key))).join(','))];
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="getme-products-${stamp}.csv"`);
      return res.send(`﻿${lines.join('\r\n')}\r\n`);
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = EXPORT_COLUMNS.map(([header, key, width]) => ({ header, key, width }));
    sheet.getRow(1).font = { bold: true };
    rows.forEach((row) => sheet.addRow(Object.fromEntries(EXPORT_COLUMNS.map(([, key]) => [key, value(row, key)]))));
    sheet.getColumn('barcode').numFmt = '@';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="getme-products-${stamp}.xlsx"`);
    return res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
  } catch (error) {
    console.error('❌ shop export error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to export products' });
  }
};

module.exports = {
  getDashboard,
  getBills,
  getNotifications,
  getStockMovements,
  getProductStockHistory,
  adjustProductStock,
  exportProducts,
};
