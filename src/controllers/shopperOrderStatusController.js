
const db = require('../config/db');

const { shopperPayForOrder } = require('./shopperPay');

const { broadcastOrderChange } = require('../realtime');

const {
  createShopperNotification,
} = require('./shopperNotificationController');

// =====================================================
// GET SHOPPER ID
// =====================================================

const getShopperId = (req) => {
  return (
    req.shopper?.shopperId ||
    req.shopper?.id ||
    req.shopperId ||
    req.user?.shopperId ||
    req.user?.id ||
    null
  );
};

// =====================================================
// SOCKET.IO EVENT
// =====================================================

const emitOrderSocketEvent = ({
  req,
  event,
  orderId,
  customerId,
  shopperId,
  payload = {},
}) => {
  try {
    const io = req.app.get('io');

    if (!io) {
      return;
    }

    const normalizedOrderId = Number(orderId);
    const normalizedCustomerId = Number(customerId);
    const normalizedShopperId = Number(shopperId);

    const eventPayload = {
      ...payload,
      orderId: normalizedOrderId,
      order_id: normalizedOrderId,
      customerId: normalizedCustomerId,
      customer_id: normalizedCustomerId,
      shopperId: normalizedShopperId,
      shopper_id: normalizedShopperId,
    };

    if (normalizedCustomerId) {
      io.to(`customer:${normalizedCustomerId}`).emit(
        event,
        eventPayload
      );
    }

    if (normalizedShopperId) {
      io.to(`shopper:${normalizedShopperId}`).emit(
        event,
        eventPayload
      );
    }

    if (normalizedOrderId) {
      io.to(`order:${normalizedOrderId}`).emit(
        event,
        eventPayload
      );

      // Admin panel + shop websites
      broadcastOrderChange(io, normalizedOrderId, {
        event,
        status: eventPayload?.status || null,
      });
    }
  } catch (error) {
    console.error(
      '❌ emitOrderSocketEvent error:',
      error
    );
  }
};

// =====================================================
// ACCEPT ORDER
// =====================================================

const acceptOrder = async (req, res) => {
  const shopperId = getShopperId(req);
  const orderId = Number(req.params.orderId || req.params.id);

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid order ID',
    });
  }

  const approvalResult = await db.query(
    'SELECT approval_status FROM shoppers WHERE id = $1',
    [shopperId]
  );

  if (approvalResult.rows[0]?.approval_status !== 'approved') {
    return res.status(403).json({
      success: false,
      message: 'Your account must be approved before you can accept batches.',
    });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    const order = orderResult.rows[0];

    if (order.status !== 'waiting_for_shopper') {
      await client.query('ROLLBACK');

      return res.status(409).json({
        success: false,
        message: 'Order is no longer available',
      });
    }

    if (order.shopper_id !== null) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        success: false,
        message: 'Order has already been assigned',
      });
    }

    const updateResult = await client.query(
      `
      UPDATE orders
      SET
        shopper_id = $1,
        status = 'shopper_accepted',
        updated_at = NOW()
      WHERE
        id = $2
        AND shopper_id IS NULL
        AND status = 'waiting_for_shopper'
      RETURNING *
      `,
      [shopperId, orderId]
    );

    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        success: false,
        message: 'Order has already been accepted',
      });
    }

    const shopsResult = await client.query(
      `
      SELECT
        os.*,
        s.shop_name,
        s.image_url AS shop_image,
        s.latitude AS shop_latitude,
        s.longitude AS shop_longitude
      FROM order_shops os
      INNER JOIN shops s
        ON s.id = os.shop_id
      WHERE os.order_id = $1
      ORDER BY os.shop_id ASC
      `,
      [orderId]
    );

    const itemsResult = await client.query(
      `
      SELECT *
      FROM order_items
      WHERE order_id = $1
      ORDER BY id ASC
      `,
      [orderId]
    );

    await client.query('COMMIT');

    const acceptedOrder = updateResult.rows[0];

    const items = itemsResult.rows.map((item) => ({
      ...item,
      id: Number(item.id),
      order_id: Number(item.order_id),
      shop_id:
        item.shop_id !== null
          ? Number(item.shop_id)
          : null,
      shopping_status: item.shopping_status || 'pending',
    }));

    const shops = shopsResult.rows.map((shop) => {
      const shopItems = items.filter(
        (item) => Number(item.shop_id) === Number(shop.shop_id)
      );

      return {
        ...shop,
        shopId: Number(shop.shop_id),
        shopName: shop.shop_name,
        shopImage: shop.shop_image || null,
        items: shopItems,
        orderItems: shopItems,
        shoppingList: shopItems,
        shoppingStatus: 'shopping',
      };
    });

    emitOrderSocketEvent({
      req,
      event: 'order-status-changed',
      orderId,
      customerId: acceptedOrder.customer_id,
      shopperId,
      payload: {
        status: acceptedOrder.status,
        order: acceptedOrder,
      },
    });

    createShopperNotification({
      io: req.app.get('io'),
      shopperId,
      type: 'batch_accepted',
      title: 'Batch accepted',
      body: `Order #${acceptedOrder.id} from ${
        shops.map((shop) => shop.shop_name).join(' + ') || 'the store'
      }. You'll earn LKR ${shopperPayForOrder(acceptedOrder).toFixed(2)}.`,
      orderId: acceptedOrder.id,
    });

    return res.status(200).json({
      success: true,
      message: 'Order accepted successfully',
      order: {
        ...acceptedOrder,
        id: Number(acceptedOrder.id),
        orderId: Number(acceptedOrder.id),
        customerId: Number(acceptedOrder.customer_id),
        shopperId: Number(shopperId),
        shops,
        items,
        orderItems: items,
        shoppingList: items,
        shopCount: shops.length,
      },
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    console.error('❌ acceptOrder error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to accept order',
      error: error.message,
    });
  } finally {
    client.release();
  }
};

// =====================================================
// START SHOPPING
// =====================================================

const startShopping = async (req, res) => {
  const shopperId = getShopperId(req);
  const orderId = Number(req.params.orderId || req.params.id);
  const shopId = Number(req.body.shopId || req.params.shopId);

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (
    !Number.isInteger(orderId) ||
    orderId <= 0 ||
    !Number.isInteger(shopId) ||
    shopId <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: 'Valid order ID and shop ID are required',
    });
  }

  try {
    const orderResult = await db.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1 AND shopper_id = $2
      LIMIT 1
      `,
      [orderId, shopperId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found for this shopper',
      });
    }

    const order = orderResult.rows[0];

    if (
      !['shopper_accepted', 'shopping'].includes(order.status)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Order cannot be started in its current status',
        status: order.status,
      });
    }

    const shopResult = await db.query(
      `
      SELECT *
      FROM order_shops
      WHERE order_id = $1 AND shop_id = $2
      LIMIT 1
      `,
      [orderId, shopId]
    );

    if (shopResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'This shop does not belong to the order',
      });
    }

    const itemsResult = await db.query(
      `
      SELECT *
      FROM order_items
      WHERE order_id = $1 AND shop_id = $2
      ORDER BY id ASC
      `,
      [orderId, shopId]
    );

    if (itemsResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No items found for this shop',
      });
    }

    // order_shop_bills uses shopping_status, not status.
    const billResult = await db.query(
      `
      SELECT *
      FROM order_shop_bills
      WHERE order_id = $1 AND shop_id = $2
      ORDER BY id DESC
      LIMIT 1
      `,
      [orderId, shopId]
    );

    if (
      billResult.rows.length > 0 &&
      String(
        billResult.rows[0].shopping_status || ''
      ).toLowerCase() === 'completed'
    ) {
      return res.status(400).json({
        success: false,
        message: 'Shopping for this shop is already completed',
      });
    }

    const updateResult = await db.query(
      `
      UPDATE orders
      SET
        status = CASE
          WHEN status = 'shopper_accepted' THEN 'shopping'
          ELSE status
        END,
        updated_at = NOW()
      WHERE id = $1 AND shopper_id = $2
      RETURNING *
      `,
      [orderId, shopperId]
    );

    emitOrderSocketEvent({
      req,
      event: 'order-status-changed',
      orderId,
      customerId: order.customer_id,
      shopperId,
      payload: {
        status: updateResult.rows[0]?.status || order.status,
        shopId,
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Shopping started',
      order: updateResult.rows[0],
      shopId,
      items: itemsResult.rows,
      bill: billResult.rows[0] || null,
    });
  } catch (error) {
    console.error('❌ startShopping error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to start shopping',
      error: error.message,
    });
  }
};

// =====================================================
// START DELIVERY
// =====================================================

const startDelivery = async (req, res) => {
  const shopperId = getShopperId(req);
  const orderId = Number(req.params.orderId || req.params.id);

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid order ID',
    });
  }

  try {
    const orderResult = await db.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1 AND shopper_id = $2
      LIMIT 1
      `,
      [orderId, shopperId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found for this shopper',
      });
    }

    const order = orderResult.rows[0];

    if (order.status !== 'shopping') {
      return res.status(400).json({
        success: false,
        message: 'Order is not ready for delivery',
        status: order.status,
      });
    }

    // Check each shop's latest bill using shopping_status.
    const shopsResult = await db.query(
      `
      SELECT
        os.shop_id,
        b.shopping_status AS bill_status
      FROM order_shops os
      LEFT JOIN LATERAL (
        SELECT shopping_status
        FROM order_shop_bills
        WHERE
          order_id = os.order_id
          AND shop_id = os.shop_id
        ORDER BY id DESC
        LIMIT 1
      ) b ON TRUE
      WHERE os.order_id = $1
      `,
      [orderId]
    );

    if (shopsResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No shops found for this order',
      });
    }

    const allBillsCompleted = shopsResult.rows.every(
      (shop) =>
        String(shop.bill_status || '').toLowerCase() === 'completed'
    );

    if (!allBillsCompleted) {
      return res.status(400).json({
        success: false,
        message: 'Complete shopping and bills for every shop first',
      });
    }

    const updateResult = await db.query(
      `
      UPDATE orders
      SET
        status = 'out_for_delivery',
        updated_at = NOW()
      WHERE
        id = $1
        AND shopper_id = $2
        AND status = 'shopping'
      RETURNING *
      `,
      [orderId, shopperId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: 'Order status changed; please refresh',
      });
    }

    const updatedOrder = updateResult.rows[0];

    emitOrderSocketEvent({
      req,
      event: 'order-status-changed',
      orderId,
      customerId: order.customer_id,
      shopperId,
      payload: {
        status: updatedOrder.status,
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Delivery started',
      order: updatedOrder,
    });
  } catch (error) {
    console.error('❌ startDelivery error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to start delivery',
      error: error.message,
    });
  }
};

// =====================================================
// CONFIRM ARRIVAL
// =====================================================

const confirmArrival = async (req, res) => {
  const shopperId = getShopperId(req);
  const orderId = Number(req.params.orderId || req.params.id);

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid order ID',
    });
  }

  try {
    const orderResult = await db.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1 AND shopper_id = $2
      LIMIT 1
      `,
      [orderId, shopperId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found for this shopper',
      });
    }

    const order = orderResult.rows[0];

    if (order.status !== 'out_for_delivery') {
      return res.status(400).json({
        success: false,
        message: 'Order is not currently out for delivery',
        status: order.status,
      });
    }

    const pin = String(
      Math.floor(100000 + Math.random() * 900000)
    );

    const updateResult = await db.query(
      `
      UPDATE orders
      SET
        status = 'arrived',
        delivery_pin = $1,
        updated_at = NOW()
      WHERE id = $2 AND shopper_id = $3
      RETURNING *
      `,
      [pin, orderId, shopperId]
    );

    const updatedOrder = updateResult.rows[0];

    emitOrderSocketEvent({
      req,
      event: 'order-status-changed',
      orderId,
      customerId: order.customer_id,
      shopperId,
      payload: {
        status: updatedOrder.status,
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Arrival confirmed',
      order: updatedOrder,
      deliveryPin: pin,
    });
  } catch (error) {
    console.error('❌ confirmArrival error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to confirm arrival',
      error: error.message,
    });
  }
};

// =====================================================
// VERIFY DELIVERY PIN
// =====================================================

const verifyDeliveryPin = async (req, res) => {
  const shopperId = getShopperId(req);
  const orderId = Number(req.params.orderId || req.params.id);

  const submittedPin = String(
    req.body.pin ||
    req.body.deliveryPin ||
    req.body.delivery_pin ||
    ''
  ).trim();

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid order ID',
    });
  }

  if (!/^\d{6}$/.test(submittedPin)) {
    return res.status(400).json({
      success: false,
      message: 'Enter a valid 6-digit delivery PIN',
    });
  }

  try {
    const orderResult = await db.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1 AND shopper_id = $2
      LIMIT 1
      `,
      [orderId, shopperId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found for this shopper',
      });
    }

    const order = orderResult.rows[0];

    if (order.status !== 'arrived') {
      return res.status(400).json({
        success: false,
        message: 'Confirm arrival before verifying the PIN',
        status: order.status,
      });
    }

    if (String(order.delivery_pin || '') !== submittedPin) {
      return res.status(400).json({
        success: false,
        message: 'Incorrect delivery PIN',
      });
    }

    const updateResult = await db.query(
      `
      UPDATE orders
      SET
        status = 'delivered',
        delivery_pin = NULL,
        delivered_at = NOW(),
        updated_at = NOW()
      WHERE
        id = $1
        AND shopper_id = $2
        AND status = 'arrived'
      RETURNING *
      `,
      [orderId, shopperId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: 'Order status changed; please refresh',
      });
    }

    const updatedOrder = updateResult.rows[0];

    emitOrderSocketEvent({
      req,
      event: 'order-status-changed',
      orderId,
      customerId: order.customer_id,
      shopperId,
      payload: {
        status: updatedOrder.status,
      },
    });

    createShopperNotification({
      io: req.app.get('io'),
      shopperId,
      type: 'delivered',
      title: 'Delivery complete',
      body: `Order #${updatedOrder.id} delivered. You earned LKR ${shopperPayForOrder(
        updatedOrder
      ).toFixed(2)}.`,
      orderId: updatedOrder.id,
    });

    return res.status(200).json({
      success: true,
      message: 'Delivery completed successfully',
      order: updatedOrder,
    });
  } catch (error) {
    console.error('❌ verifyDeliveryPin error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to verify delivery PIN',
      error: error.message,
    });
  }
};

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  acceptOrder,
  startShopping,
  startDelivery,
  confirmArrival,
  verifyDeliveryPin,
};

