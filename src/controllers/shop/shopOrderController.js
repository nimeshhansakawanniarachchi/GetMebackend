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

// What was bought for one item at GetMe prices: found quantity (or
// weight x price per kg), the replacement's price when replaced,
// nothing when refunded; null while still pending
const WEIGHT_FACTORS = { g: 0.001, ml: 0.001, kg: 1, l: 1 };
const boughtOf = (item) => {
  const status = String(item.shopping_status || 'pending').toLowerCase();
  if (['refunded', 'not_found', 'unavailable'].includes(status)) return { boughtQuantity: 0, boughtTotal: 0 };
  if (!['found', 'replaced', 'done', 'completed'].includes(status)) return { boughtQuantity: null, boughtTotal: null };
  const weight = Number(item.found_weight);
  const unitPrice = item.unit_price != null ? Number(item.unit_price) : null;
  if (weight > 0 && unitPrice !== null) {
    const factor = WEIGHT_FACTORS[String(item.found_weight_unit || 'kg').toLowerCase()] ?? 1;
    return { boughtQuantity: weight, boughtTotal: Math.round(unitPrice * weight * factor * 100) / 100 };
  }
  const pack = status === 'replaced' && item.replacement_product_price != null ? Number(item.replacement_product_price) : Number(item.price || 0);
  const quantity = Number(item.found_quantity) > 0 ? Number(item.found_quantity) : Number(item.quantity || 1);
  return { boughtQuantity: quantity, boughtTotal: Math.round(pack * quantity * 100) / 100 };
};


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
//   &search= (order number or one of this shop's product names)
//   &from=YYYY-MM-DD&to=YYYY-MM-DD
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

    const search = String(req.query.search || '').trim().slice(0, 80);
    if (search) {
      const orderNumber = Number(search.replace(/^#/, ''));
      params.push(Number.isInteger(orderNumber) && orderNumber > 0 ? orderNumber : -1);
      const idParam = `$${params.length}`;
      params.push(`%${search.toLowerCase()}%`);
      const like = `$${params.length}`;
      statusClause += ` AND (o.id = ${idParam} OR EXISTS (
        SELECT 1 FROM order_items si WHERE si.order_id = o.id AND si.shop_id = os.shop_id AND LOWER(si.item_name) LIKE ${like}
      ))`;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) {
      params.push(req.query.from);
      statusClause += ` AND o.created_at >= $${params.length}::date`;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) {
      params.push(req.query.to);
      statusClause += ` AND o.created_at < $${params.length}::date + INTERVAL '1 day'`;
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

    const [itemsResult, replacementsResult, billResult, paymentResult, otherShopsResult] = await Promise.all([
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
        SELECT bill_url, bill_urls, bill_uploaded_at, shopping_status
        FROM order_shop_bills
        WHERE order_id = $1 AND shop_id = $2
        ORDER BY id DESC
        LIMIT 1
        `,
        [orderId, shopId]
      ),
      // What the shopper recorded paying at this shop's till
      pool.query(
        `
        SELECT method, amount_paid, expected_amount, variance, review_status, locked_at, created_at
        FROM store_payments WHERE order_id = $1 AND shop_id = $2
        `,
        [orderId, shopId]
      ),
      // How many other shops are on this order (their items stay hidden)
      pool.query('SELECT COUNT(*)::int AS n FROM order_shops WHERE order_id = $1 AND shop_id <> $2', [orderId, shopId]),
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
      replacementName: item.replacement_product_name || null,
      ...boughtOf(item),
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
        otherShops: otherShopsResult.rows[0].n,
        items,
        shopTotal: items.reduce((total, item) => total + item.lineTotal, 0),
        // Value of what was actually bought at GetMe prices (refunded
        // items count 0; null while still being shopped)
        boughtTotal: items.every((item) => item.boughtTotal !== null)
          ? Math.round(items.reduce((total, item) => total + item.boughtTotal, 0) * 100) / 100
          : null,
        tillPayment: paymentResult.rows[0]
          ? {
              method: paymentResult.rows[0].method,
              amountPaid: Number(paymentResult.rows[0].amount_paid),
              expectedAmount: Number(paymentResult.rows[0].expected_amount),
              difference: Number(paymentResult.rows[0].variance),
              billState: !paymentResult.rows[0].locked_at
                ? 'awaiting_bill'
                : ['ok', 'approved'].includes(paymentResult.rows[0].review_status) ? 'verified' : 'under_review',
              recordedAt: paymentResult.rows[0].created_at,
            }
          : null,
        bill: bill?.bill_url
          ? {
              url: bill.bill_url,
              photos: Array.isArray(bill.bill_urls) && bill.bill_urls.length ? bill.bill_urls : [bill.bill_url],
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
