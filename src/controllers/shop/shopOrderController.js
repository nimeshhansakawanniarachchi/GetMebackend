const pool = require('../../config/db');

const {
  statusLabel,
  firstName,
} = require('./shopFormat');

const { ORDER_STATUS_GROUPS } = require('../../utils/orderStatus');

const { readPage } = require('../../utils/pagination');

// Orders a shop should act on / watch right now
const ACTIVE_STATUSES = ORDER_STATUS_GROUPS.active;

const CANCELLED_STATUSES = ORDER_STATUS_GROUPS.cancelled;

// Value of this shop's items in an order (unit price x quantity)
const SHOP_ITEMS_TOTAL_SQL = `
  COALESCE((
    SELECT SUM(oi.price * oi.quantity)
    FROM order_items oi
    WHERE oi.order_id = o.id AND oi.shop_id = os.shop_id
  ), 0)
`;

const STATUS_FILTERS = ORDER_STATUS_GROUPS;


// =====================================================
// DASHBOARD
// GET /api/shop/dashboard
// =====================================================

const getDashboard = async (req, res) => {
  try {
    const shopId = req.shop.shopId;

    const [ordersResult, productsResult, salesResult, recentResult] =
      await Promise.all([
        pool.query(
          `
          SELECT
            COUNT(*) FILTER (
              WHERE o.created_at >= date_trunc('day', NOW())
                AND o.status <> ALL($2)
            )::int AS orders_today,
            COUNT(*) FILTER (WHERE o.status = ANY($3))::int AS active_orders
          FROM order_shops os
          JOIN orders o ON o.id = os.order_id
          WHERE os.shop_id = $1
          `,
          [shopId, CANCELLED_STATUSES, ACTIVE_STATUSES]
        ),

        pool.query(
          `
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_available AND stock_quantity > 0)::int AS live,
            COUNT(*) FILTER (
              WHERE stock_quantity <= 0 OR is_available = false
            )::int AS unavailable,
            COUNT(*) FILTER (
              WHERE is_available AND stock_quantity BETWEEN 1 AND 5
            )::int AS low_stock
          FROM products
          WHERE shop_id = $1
          `,
          [shopId]
        ),

        pool.query(
          `
          SELECT
            COALESCE(SUM(oi.price * oi.quantity) FILTER (
              WHERE COALESCE(o.delivered_at, o.updated_at) >= date_trunc('day', NOW())
            ), 0)::float AS sales_today,
            COALESCE(SUM(oi.price * oi.quantity) FILTER (
              WHERE COALESCE(o.delivered_at, o.updated_at) >= date_trunc('week', NOW())
            ), 0)::float AS sales_week
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE oi.shop_id = $1 AND o.status = 'delivered'
          `,
          [shopId]
        ),

        pool.query(
          `
          SELECT
            o.id, o.status, o.created_at,
            c.full_name AS customer_name,
            (SELECT COUNT(*)::int FROM order_items oi
             WHERE oi.order_id = o.id AND oi.shop_id = os.shop_id) AS item_count,
            ${SHOP_ITEMS_TOTAL_SQL}::float AS shop_total
          FROM order_shops os
          JOIN orders o ON o.id = os.order_id
          LEFT JOIN customers c ON c.id = o.customer_id
          WHERE os.shop_id = $1
          ORDER BY o.created_at DESC
          LIMIT 5
          `,
          [shopId]
        ),
      ]);

    const orders = ordersResult.rows[0];
    const products = productsResult.rows[0];
    const sales = salesResult.rows[0];

    return res.json({
      success: true,
      stats: {
        ordersToday: orders.orders_today,
        activeOrders: orders.active_orders,
        salesToday: sales.sales_today,
        salesThisWeek: sales.sales_week,
        totalProducts: products.total,
        liveProducts: products.live,
        unavailableProducts: products.unavailable,
        lowStockProducts: products.low_stock,
      },
      recentOrders: recentResult.rows.map((row) => ({
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
    console.error('❌ shop getDashboard error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load dashboard' });
  }
};


// =====================================================
// ORDERS LIST
// GET /api/shop/orders?status=active|delivery|delivered|cancelled&page=1
// =====================================================

const getOrders = async (req, res) => {
  try {
    const shopId = req.shop.shopId;
    const { page, pageSize } = readPage(req.query);
    const statuses = STATUS_FILTERS[req.query.status] || null;

    const params = [shopId];
    let statusClause = '';

    if (statuses) {
      params.push(statuses);
      statusClause = `AND o.status = ANY($${params.length})`;
    }

    const countResult = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM order_shops os
      JOIN orders o ON o.id = os.order_id
      WHERE os.shop_id = $1 ${statusClause}
      `,
      params
    );

    params.push(pageSize, (page - 1) * pageSize);

    const result = await pool.query(
      `
      SELECT
        o.id, o.status, o.created_at, o.updated_at, o.delivered_at,
        o.delivery_option,
        c.full_name AS customer_name,
        sh.full_name AS shopper_name,
        (SELECT COUNT(*)::int FROM order_items oi
         WHERE oi.order_id = o.id AND oi.shop_id = os.shop_id) AS item_count,
        ${SHOP_ITEMS_TOTAL_SQL}::float AS shop_total,
        EXISTS (
          SELECT 1 FROM order_shop_bills b
          WHERE b.order_id = o.id AND b.shop_id = os.shop_id AND b.bill_url IS NOT NULL
        ) AS has_bill
      FROM order_shops os
      JOIN orders o ON o.id = os.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN shoppers sh ON sh.id = o.shopper_id
      WHERE os.shop_id = $1 ${statusClause}
      ORDER BY o.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params
    );

    const total = countResult.rows[0].total;

    return res.json({
      success: true,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      orders: result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        statusLabel: statusLabel(row.status),
        customerName: firstName(row.customer_name),
        shopperName: row.shopper_name || null,
        deliveryOption: row.delivery_option,
        itemCount: row.item_count,
        shopTotal: row.shop_total,
        hasBill: row.has_bill,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
      })),
    });
  } catch (error) {
    console.error('❌ shop getOrders error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load orders' });
  }
};


// =====================================================
// ORDER DETAIL (only this shop's part of the order)
// GET /api/shop/orders/:id
// Customer privacy: first name only, no phone or address.
// =====================================================

const getOrder = async (req, res) => {
  try {
    const shopId = req.shop.shopId;
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const orderResult = await pool.query(
      `
      SELECT
        o.id, o.status, o.created_at, o.updated_at, o.delivered_at,
        o.delivery_option, o.scheduled_date, o.scheduled_start_time, o.scheduled_end_time,
        c.full_name AS customer_name,
        sh.full_name AS shopper_name,
        sh.mobile AS shopper_mobile,
        sh.vehicle_type, sh.vehicle_number
      FROM order_shops os
      JOIN orders o ON o.id = os.order_id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN shoppers sh ON sh.id = o.shopper_id
      WHERE os.shop_id = $1 AND o.id = $2
      `,
      [shopId, orderId]
    );

    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const [itemsResult, replacementsResult, billResult] = await Promise.all([
      pool.query(
        `
        SELECT oi.*, p.image_url AS product_image
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1 AND oi.shop_id = $2
        ORDER BY oi.id ASC
        `,
        [orderId, shopId]
      ),
      pool.query(
        `
        SELECT r.id, r.original_item_id, r.option_number, r.photo_url, r.status
        FROM replacement_items r
        JOIN order_items oi ON oi.id = r.original_item_id
        WHERE r.order_id = $1 AND oi.shop_id = $2
        ORDER BY r.original_item_id, r.option_number
        `,
        [orderId, shopId]
      ),
      pool.query(
        `
        SELECT bill_url, bill_uploaded_at, shopping_status
        FROM order_shop_bills
        WHERE order_id = $1 AND shop_id = $2
        ORDER BY id DESC
        LIMIT 1
        `,
        [orderId, shopId]
      ),
    ]);

    const replacementsByItem = new Map();

    replacementsResult.rows.forEach((row) => {
      const list = replacementsByItem.get(row.original_item_id) || [];
      list.push({
        id: row.id,
        optionNumber: row.option_number,
        photoUrl: row.photo_url,
        status: row.status,
      });
      replacementsByItem.set(row.original_item_id, list);
    });

    const items = itemsResult.rows.map((item) => ({
      id: item.id,
      productId: item.product_id,
      name: item.item_name,
      quantity: Number(item.quantity || 0),
      unit: item.unit,
      price: Number(item.price || 0),
      lineTotal: Number(item.price || 0) * Number(item.quantity || 0),
      custom: item.custom === true,
      details: item.details || null,
      image: item.product_image || item.image || null,
      shoppingStatus: item.shopping_status || 'pending',
      foundQuantity: item.found_quantity != null ? Number(item.found_quantity) : null,
      foundWeight: item.found_weight != null ? Number(item.found_weight) : null,
      foundWeightUnit: item.found_weight_unit || null,
      shopperPhotoUrl: item.shopper_photo_url || null,
      replacements: replacementsByItem.get(item.id) || [],
    }));

    const bill = billResult.rows[0];

    return res.json({
      success: true,
      order: {
        id: order.id,
        status: order.status,
        statusLabel: statusLabel(order.status),
        customerName: firstName(order.customer_name),
        deliveryOption: order.delivery_option,
        scheduledDate: order.scheduled_date,
        scheduledStartTime: order.scheduled_start_time,
        scheduledEndTime: order.scheduled_end_time,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        deliveredAt: order.delivered_at,
        shopper: order.shopper_name
          ? {
              name: order.shopper_name,
              mobile: order.shopper_mobile,
              vehicleType: order.vehicle_type,
              vehicleNumber: order.vehicle_number,
            }
          : null,
        items,
        shopTotal: items.reduce((total, item) => total + item.lineTotal, 0),
        bill: bill?.bill_url
          ? {
              url: bill.bill_url,
              uploadedAt: bill.bill_uploaded_at,
              status: bill.shopping_status,
            }
          : null,
      },
    });
  } catch (error) {
    console.error('❌ shop getOrder error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load order' });
  }
};

module.exports = {
  getDashboard,
  getOrders,
  getOrder,
};
