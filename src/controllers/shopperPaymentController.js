
const db = require('../config/db');

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
// SOCKET.IO ORDER EVENT
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

    if (!io) return;

    const eventPayload = {
      ...payload,
      orderId: Number(orderId),
      order_id: Number(orderId),
      customerId: Number(customerId),
      customer_id: Number(customerId),
      shopperId: Number(shopperId),
      shopper_id: Number(shopperId),
    };

    if (customerId) {
      io.to(`customer:${customerId}`).emit(
        event,
        eventPayload
      );
    }

    if (shopperId) {
      io.to(`shopper:${shopperId}`).emit(
        event,
        eventPayload
      );
    }

    if (orderId) {
      io.to(`order:${orderId}`).emit(
        event,
        eventPayload
      );
    }
  } catch (error) {
    console.error('Socket event error:', error);
  }
};

// =====================================================
// UPDATE ORDER PAYMENT
// =====================================================

const updateOrderPayment = async (req, res) => {
  const shopperId = getShopperId(req);

  const orderId = Number(
    req.params.orderId ||
    req.params.id ||
    req.body?.orderId ||
    req.body?.order_id
  );

  const paymentData = req.body || {};

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid order ID',
    });
  }

  try {
    // ================================================
    // VERIFY ORDER OWNERSHIP
    // ================================================

    const orderResult = await db.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
        AND shopper_id = $2
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

    const paymentMethod =
      paymentData.payment_method ??
      paymentData.paymentMethod ??
      null;

    const paymentStatus =
      paymentData.payment_status ??
      paymentData.paymentStatus ??
      null;

    const paymentReference =
      paymentData.payment_reference ??
      paymentData.paymentReference ??
      null;

    const paidAmount =
      paymentData.paid_amount ??
      paymentData.paidAmount ??
      paymentData.amount ??
      null;

    if (
      paymentMethod === null ||
      String(paymentMethod).trim() === ''
    ) {
      return res.status(400).json({
        success: false,
        message: 'Payment method is required',
      });
    }

    // ================================================
    // UPDATE PAYMENT METHOD
    // ================================================

    const updateResult = await db.query(
      `
      UPDATE orders
      SET
        payment_method = $1,
        updated_at = NOW()
      WHERE
        id = $2
        AND shopper_id = $3
      RETURNING *
      `,
      [paymentMethod, orderId, shopperId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found for this shopper',
      });
    }

    const updatedOrder = updateResult.rows[0];

    // ================================================
    // SOCKET.IO EVENT
    // ================================================

    emitOrderSocketEvent({
      req,
      event: 'order-payment-updated',
      orderId,
      customerId: order.customer_id,
      shopperId,
      payload: {
        paymentMethod,
        paymentStatus,
        paymentReference,
        paidAmount,
      },
    });

    // ================================================
    // RESPONSE
    // ================================================

    return res.status(200).json({
      success: true,
      message: 'Order payment information updated',
      order: updatedOrder,
    });
  } catch (error) {
    console.error('updateOrderPayment error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to update order payment',
      error: error.message,
    });
  }
};

// =====================================================
// UPLOAD BILL
// =====================================================

const uploadBill = async (req, res) => {
  const shopperId = getShopperId(req);

  const orderId = Number(
    req.params.orderId ||
    req.params.id ||
    req.body?.orderId ||
    req.body?.order_id
  );

  const shopId = Number(
    req.params.shopId ||
    req.body?.shopId ||
    req.body?.shop_id
  );

  // ================================================
  // REQUEST DEBUG LOG
  // ================================================

  console.log('BILL UPLOAD REQUEST:', {
    orderId,
    shopId,
    shopperId,
    params: req.params,
    body: req.body,
    fileReceived: Boolean(req.file),
    filePath: req.file?.path || null,
  });

  // ================================================
  // VALIDATION
  // ================================================

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
      received: {
        orderId,
        shopId,
      },
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Please upload the shop bill',
    });
  }

  try {
    // ================================================
    // VERIFY ORDER OWNERSHIP
    // ================================================

    const orderResult = await db.query(
      `
      SELECT *
      FROM orders
      WHERE id = $1
        AND shopper_id = $2
      LIMIT 1
      `,
      [orderId, shopperId]
    );

    if (orderResult.rows.length === 0) {
      console.error('BILL ORDER VALIDATION FAILED:', {
        orderId,
        shopperId,
      });

      return res.status(404).json({
        success: false,
        message: 'Order not found for this shopper',
        orderId,
      });
    }

    const order = orderResult.rows[0];

    // ================================================
    // VERIFY ACTUAL SHOP ID BELONGS TO ORDER
    // Use order_shops.shop_id, NOT order_shops.id
    // ================================================

    const shopResult = await db.query(
      `
      SELECT
        os.id AS order_shop_id,
        os.order_id,
        os.shop_id,
        os.shop_name,
        s.shop_name AS database_shop_name
      FROM order_shops os
      LEFT JOIN shops s
        ON s.id = os.shop_id
      WHERE
        os.order_id = $1
        AND os.shop_id = $2
      LIMIT 1
      `,
      [orderId, shopId]
    );

    if (shopResult.rows.length === 0) {
      const orderShopsResult = await db.query(
        `
        SELECT
          id,
          order_id,
          shop_id,
          shop_name
        FROM order_shops
        WHERE order_id = $1
        ORDER BY id
        `,
        [orderId]
      );

      console.error('SHOP DOES NOT BELONG TO ORDER:', {
        requestedOrderId: orderId,
        requestedShopId: shopId,
        associatedShops: orderShopsResult.rows,
      });

      return res.status(404).json({
        success: false,
        message: 'Shop does not belong to this order',
        requestedOrderId: orderId,
        requestedShopId: shopId,
        associatedShops: orderShopsResult.rows,
      });
    }

    const shop = shopResult.rows[0];

    console.log('BILL SHOP VALIDATED:', {
      orderId,
      shopId,
      orderShopId: shop.order_shop_id,
      shopName:
        shop.database_shop_name ||
        shop.shop_name,
    });

    // ================================================
    // GET UPLOADED BILL PATH
    // ================================================

    const uploadedPath = req.file.path
      ? req.file.path.replace(/\\/g, '/')
      : '';

    const uploadsIndex = uploadedPath.indexOf('uploads/');

    const billUrl =
      uploadsIndex !== -1
        ? `/${uploadedPath.substring(uploadsIndex)}`
        : null;

    if (!billUrl) {
      console.error('INVALID BILL FILE PATH:', {
        filePath: req.file.path,
        uploadedPath,
      });

      return res.status(500).json({
        success: false,
        message: 'Unable to get uploaded bill path',
      });
    }

    // ================================================
    // FIND EXISTING BILL FOR THIS ORDER AND SHOP
    // ================================================

    const existingBillResult = await db.query(
      `
      SELECT id
      FROM order_shop_bills
      WHERE
        order_id = $1
        AND shop_id = $2
      ORDER BY id DESC
      LIMIT 1
      `,
      [orderId, shopId]
    );

    let bill;

    // ================================================
    // UPDATE EXISTING BILL
    // ================================================

    if (existingBillResult.rows.length > 0) {
      const existingBillId =
        existingBillResult.rows[0].id;

      const updateBillResult = await db.query(
        `
        UPDATE order_shop_bills
        SET
          bill_url = $1,
          bill_uploaded_at = NOW(),
          updated_at = NOW()
        WHERE id = $2
        RETURNING *
        `,
        [
          billUrl,
          existingBillId,
        ]
      );

      bill = updateBillResult.rows[0];
    } else {
      // ==============================================
      // INSERT NEW BILL
      // ==============================================

      const insertBillResult = await db.query(
        `
        INSERT INTO order_shop_bills (
          order_id,
          shop_id,
          bill_url,
          bill_uploaded_at,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          NOW(),
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          orderId,
          shopId,
          billUrl,
        ]
      );

      bill = insertBillResult.rows[0];
    }

    console.log('BILL SAVED SUCCESSFULLY:', {
      orderId,
      shopId,
      billId: bill?.id,
      billUrl: bill?.bill_url,
      billUploadedAt: bill?.bill_uploaded_at,
    });

    // ================================================
    // SOCKET.IO EVENT
    // ================================================

    emitOrderSocketEvent({
      req,
      event: 'order-bill-uploaded',
      orderId,
      customerId: order.customer_id,
      shopperId,
      payload: {
        shopId,
        billUrl,
        bill,
      },
    });

    // ================================================
    // RESPONSE
    // ================================================

    return res.status(200).json({
      success: true,
      message: 'Shop bill uploaded successfully',
      billUrl,
      bill,
    });
  } catch (error) {
    console.error('uploadBill error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to upload shop bill',
      error: error.message,
    });
  }
};

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  updateOrderPayment,
  uploadBill,
};
