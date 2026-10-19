const pool = require('../../config/db');

const {
  ORDER_STATUS_GROUPS,
  FINISHED_STATUSES,
  statusLabel,
} = require('../../utils/orderStatus');

const { readPage, pageMeta } = require('../../utils/pagination');

const { SHOPPER_PAY_SQL } = require('../shopperPay');

const { broadcastOrderChange } = require('../../realtime');

const {
  createShopperNotification,
} = require('../shopperNotificationController');

const toNumber = (value) => (value == null ? null : Number(value));


// =====================================================
// ORDERS LIST
// GET /api/admin/orders?status=active|delivery|delivered|cancelled
//   &from=YYYY-MM-DD&to=YYYY-MM-DD&search=&page=&pageSize=
// =====================================================

const listOrders = async (req, res) => {
  try {
    const paging = readPage(req.query);
    const where = [];
    const params = [];

    const statuses = ORDER_STATUS_GROUPS[req.query.status];

    if (statuses) {
      params.push(statuses);
      where.push(`o.status = ANY($${params.length})`);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) {
      params.push(req.query.from);
      where.push(`o.created_at >= $${params.length}::date`);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) {
      params.push(req.query.to);
      where.push(`o.created_at < $${params.length}::date + INTERVAL '1 day'`);
    }

    const search = String(req.query.search || '').trim();

    if (search) {
      // "#42" or "42" also matches the order number exactly
      const orderNumber = Number(search.replace(/^#/, ''));

      params.push(Number.isInteger(orderNumber) ? orderNumber : -1);
      const idParam = `$${params.length}`;

      params.push(`%${search.toLowerCase()}%`);
      const like = `$${params.length}`;

      where.push(`(
        o.id = ${idParam}
        OR LOWER(c.full_name) LIKE ${like}
        OR c.mobile LIKE ${like}
        OR LOWER(sh.full_name) LIKE ${like}
        OR EXISTS (
          SELECT 1 FROM order_shops os2
          WHERE os2.order_id = o.id AND LOWER(os2.shop_name) LIKE ${like}
        )
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN shoppers sh ON sh.id = o.shopper_id
      ${whereSql}
    `;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total ${baseFrom}`,
      params
    );

    const listParams = [...params, paging.pageSize, paging.offset];

    const result = await pool.query(
      `
      SELECT
        o.id, o.status, o.total_amount, o.payment_method, o.payment_status,
        o.delivery_option, o.created_at, o.delivered_at,
        c.full_name AS customer_name, c.mobile AS customer_mobile,
        sh.full_name AS shopper_name,
        (
          SELECT STRING_AGG(os.shop_name, ' + ' ORDER BY os.id)
          FROM order_shops os WHERE os.order_id = o.id
        ) AS shop_names,
        (
          SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id
        ) AS item_count
      ${baseFrom}
      ORDER BY o.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.json({
      success: true,
      ...pageMeta(paging, countResult.rows[0].total),
      orders: result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        statusLabel: statusLabel(row.status),
        customerName: row.customer_name || 'Customer',
        customerMobile: row.customer_mobile,
        shopperName: row.shopper_name || null,
        shopNames: row.shop_names || '—',
        itemCount: row.item_count,
        totalAmount: Number(row.total_amount || 0),
        paymentMethod: row.payment_method,
        paymentStatus: row.payment_status || 'unpaid',
        deliveryOption: row.delivery_option,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin listOrders error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load orders' });
  }
};


// =====================================================
// ORDER DETAIL
// GET /api/admin/orders/:id
// =====================================================

const getOrder = async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const orderResult = await pool.query(
      `
      SELECT
        o.*,
        ${SHOPPER_PAY_SQL}::float AS shopper_pay,
        c.full_name AS customer_name, c.mobile AS customer_mobile, c.email AS customer_email,
        sh.full_name AS shopper_name, sh.mobile AS shopper_mobile,
        sh.vehicle_type, sh.vehicle_number
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN shoppers sh ON sh.id = o.shopper_id
      WHERE o.id = $1
      `,
      [orderId]
    );

    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const [shopsResult, itemsResult, replacementsResult, billsResult, chatResult] =
      await Promise.all([
        pool.query(
          `
          SELECT os.shop_id, COALESCE(s.shop_name, os.shop_name) AS shop_name,
                 COALESCE(s.image_url, os.shop_image) AS image_url, s.address, s.mobile
          FROM order_shops os
          LEFT JOIN shops s ON s.id = os.shop_id
          WHERE os.order_id = $1
          ORDER BY os.id
          `,
          [orderId]
        ),
        pool.query(
          'SELECT * FROM order_items WHERE order_id = $1 ORDER BY shop_id, id',
          [orderId]
        ),
        pool.query(
          `
          SELECT id, original_item_id, option_number, photo_url, status, created_at
          FROM replacement_items WHERE order_id = $1
          ORDER BY original_item_id, option_number
          `,
          [orderId]
        ),
        pool.query(
          `
          SELECT shop_id, bill_url, bill_uploaded_at, shopping_status
          FROM order_shop_bills WHERE order_id = $1
          ORDER BY id
          `,
          [orderId]
        ),
        pool.query(
          `
          SELECT id, sender_type, message, created_at
          FROM chat_messages WHERE order_id = $1
          ORDER BY created_at ASC
          LIMIT 200
          `,
          [orderId]
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
        createdAt: row.created_at,
      });
      replacementsByItem.set(row.original_item_id, list);
    });

    const billsByShop = new Map(
      billsResult.rows.map((bill) => [bill.shop_id, bill])
    );

    const shops = shopsResult.rows.map((shop) => {
      const bill = billsByShop.get(shop.shop_id);

      return {
        id: shop.shop_id,
        name: shop.shop_name,
        imageUrl: shop.image_url,
        address: shop.address,
        mobile: shop.mobile,
        bill: bill?.bill_url
          ? { url: bill.bill_url, uploadedAt: bill.bill_uploaded_at, status: bill.shopping_status }
          : null,
        items: itemsResult.rows
          .filter((item) => Number(item.shop_id) === Number(shop.shop_id))
          .map((item) => ({
            id: item.id,
            name: item.item_name,
            quantity: Number(item.quantity || 0),
            unit: item.unit,
            price: Number(item.price || 0),
            lineTotal: Number(item.price || 0) * Number(item.quantity || 0),
            custom: item.custom === true,
            details: item.details,
            image: item.image,
            voiceUrl: item.voice_url,
            shoppingStatus: item.shopping_status || 'pending',
            foundQuantity: toNumber(item.found_quantity),
            foundWeight: toNumber(item.found_weight),
            foundWeightUnit: item.found_weight_unit,
            shopperPhotoUrl: item.shopper_photo_url,
            replacements: replacementsByItem.get(item.id) || [],
          })),
      };
    });

    // Timeline from the timestamps the order already records
    const timeline = [
      ['Order placed', order.created_at],
      ['Shopper search started', order.shopper_search_started_at],
      ['Bill uploaded', order.bill_uploaded_at],
      ['Paid', order.paid_at],
      ['Shopper arrived', order.arrival_confirmed_at],
      ['Delivered', order.delivered_at],
    ]
      .filter(([, at]) => at)
      .map(([label, at]) => ({ label, at }))
      .sort((a, b) => new Date(a.at) - new Date(b.at));

    return res.json({
      success: true,
      order: {
        id: order.id,
        status: order.status,
        statusLabel: statusLabel(order.status),
        canCancel: !FINISHED_STATUSES.includes(order.status),
        cancelledBy: order.cancelled_by,
        cancelReason: order.cancel_reason,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        customer: {
          id: order.customer_id,
          name: order.customer_name,
          mobile: order.customer_mobile,
          email: order.customer_email,
        },
        shopper: order.shopper_id
          ? {
              id: order.shopper_id,
              name: order.shopper_name,
              mobile: order.shopper_mobile,
              vehicleType: order.vehicle_type,
              vehicleNumber: order.vehicle_number,
            }
          : null,
        delivery: {
          address: order.delivery_address,
          latitude: toNumber(order.delivery_latitude),
          longitude: toNumber(order.delivery_longitude),
          option: order.delivery_option,
          distanceKm: toNumber(order.distance_km),
          scheduledDate: order.scheduled_date,
          scheduledStartTime: order.scheduled_start_time,
          scheduledEndTime: order.scheduled_end_time,
        },
        money: {
          itemsTotal: Number(order.items_total || 0),
          actualItemsTotal: toNumber(order.actual_items_total),
          deliveryFee: Number(order.delivery_fee || 0),
          fastDeliveryFee: Number(order.fast_delivery_fee || 0),
          serviceFee: Number(order.service_fee || 0),
          totalAmount: Number(order.total_amount || 0),
          shopperPay: Number(order.shopper_pay || 0),
        },
        payment: {
          method: order.payment_method,
          status: order.payment_status || 'unpaid',
          reference: order.payment_id,
          paidAt: order.paid_at,
          reimbursementStatus: order.reimbursement_status,
          reimbursementAmount: toNumber(order.reimbursement_amount),
          reimbursedAt: order.reimbursed_at,
        },
        shops,
        timeline,
        chat: chatResult.rows.map((row) => ({
          id: row.id,
          senderType: row.sender_type,
          message: row.message,
          createdAt: row.created_at,
        })),
      },
    });
  } catch (error) {
    console.error('❌ admin getOrder error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load order' });
  }
};


// =====================================================
// CANCEL ORDER
// PATCH /api/admin/orders/:id/cancel { reason }
// =====================================================

const cancelOrder = async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const reason = String(req.body?.reason || '').trim();

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    if (reason.length < 3) {
      return res.status(400).json({ success: false, message: 'Enter a reason for cancelling' });
    }

    const result = await pool.query(
      `
      UPDATE orders
      SET
        status = 'cancelled',
        cancelled_by = 'admin',
        cancel_reason = $2,
        delivery_pin = NULL,
        updated_at = NOW()
      WHERE id = $1 AND NOT (status = ANY($3))
      RETURNING id, customer_id, shopper_id, status
      `,
      [orderId, reason.slice(0, 500), FINISHED_STATUSES]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: 'This order is already finished and cannot be cancelled',
      });
    }

    const order = result.rows[0];
    const io = req.app.get('io');

    const payload = {
      orderId,
      order_id: orderId,
      status: 'cancelled',
      cancelledBy: 'admin',
      reason,
    };

    if (io) {
      io.to(`order:${orderId}`).emit('order-status-changed', payload);
      io.to(`customer:${order.customer_id}`).emit('order-status-changed', payload);

      if (order.shopper_id) {
        io.to(`shopper:${order.shopper_id}`).emit('order-status-changed', payload);
      }
    }

    broadcastOrderChange(io, orderId, { event: 'order-status-changed', status: 'cancelled' });

    if (order.shopper_id) {
      createShopperNotification({
        io,
        shopperId: order.shopper_id,
        type: 'order_cancelled',
        title: 'Order cancelled',
        body: `GetMe cancelled order #${orderId}: ${reason}`,
        orderId,
      });
    }

    return res.json({ success: true, message: 'Order cancelled' });
  } catch (error) {
    console.error('❌ admin cancelOrder error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to cancel order' });
  }
};

module.exports = {
  listOrders,
  getOrder,
  cancelOrder,
};
