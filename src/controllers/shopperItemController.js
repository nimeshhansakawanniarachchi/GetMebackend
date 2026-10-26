
const db = require('../config/db');
const fs = require('fs');
const path = require('path');

const { broadcastOrderChange } = require('../realtime');
const { postChatEvent } = require('../utils/chatEvents');
const { reconcileInBackground } = require('../payments/paymentService');
const { serviceUnitsSql } = require('../pricing/fees');
const { deductForOrderItem } = require('../inventory/stockService');

// Barcodes compare without spaces or leading zeros (UPC-A and
// EAN-13 encode the same code with an extra 0); empty -> null.
// Same rule as the ShopperApp.
const normalizeBarcode = (value) => {
  const code = String(value ?? '').replace(/\s+/g, '').replace(/^0+/, '');

  return code ? code : null;
};

// =====================================================
// GET SHOPPER ID
// =====================================================

// Item actions only while the order is being worked on. A
// cancelled (or finished) order answers 409 ORDER_NOT_ACTIVE so the
// app can stop - nothing is marked, deducted or charged.
const ACTIVE_ORDER_STATUSES = ['shopper_accepted', 'shopping'];

const rejectInactiveOrder = async (res, orderId) => {
  const order = (
    await db.query('SELECT status FROM orders WHERE id = $1', [orderId])
  ).rows[0];

  if (order && ACTIVE_ORDER_STATUSES.includes(order.status)) {
    return false;
  }

  res.status(409).json({
    success: false,
    code: 'ORDER_NOT_ACTIVE',
    status: order?.status || null,
    message:
      order?.status === 'cancelled'
        ? 'This order was cancelled. Stop shopping for it.'
        : 'This order is not being shopped any more.',
  });

  return true;
};

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

      // Admin panel + shop websites
      broadcastOrderChange(io, orderId, {
        event,
        status: eventPayload?.status || null,
      });
    }
  } catch (error) {
    console.error('Socket event error:', error);
  }
};

// =====================================================
// UPLOAD ITEM PHOTO
// =====================================================

const uploadItemPhoto = async (req, res) => {
  const shopperId = getShopperId(req);

  const itemId = Number(
    req.params.itemId || req.params.id
  );

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid item ID',
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Please upload an item photo',
    });
  }

  try {
    const itemResult = await db.query(
      `
      SELECT
        oi.id,
        oi.order_id,
        oi.shop_id,
        o.customer_id
      FROM order_items oi
      INNER JOIN orders o
        ON o.id = oi.order_id
      WHERE
        oi.id = $1
        AND o.shopper_id = $2
      LIMIT 1
      `,
      [itemId, shopperId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order item not found for this shopper',
      });
    }

    const item = itemResult.rows[0];

    if (await rejectInactiveOrder(res, item.order_id)) {
      return undefined;
    }

    const uploadedPath = req.file.path
      ? req.file.path
          .replace(/\\/g, '/')
          .split('uploads/')
          .pop()
      : null;

    if (!uploadedPath) {
      return res.status(500).json({
        success: false,
        message: 'Unable to get uploaded photo path',
      });
    }

    const photoUrl = `/uploads/${uploadedPath}`;

    const updateResult = await db.query(
      `
      UPDATE order_items
      SET shopper_photo_url = $1
      WHERE id = $2
        AND order_id = $3
      RETURNING *
      `,
      [photoUrl, itemId, item.order_id]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order item not found',
      });
    }

    emitOrderSocketEvent({
      req,
      event: 'order-item-updated',
      orderId: item.order_id,
      customerId: item.customer_id,
      shopperId,
      payload: {
        itemId,
        shopId: item.shop_id,
        shopperPhotoUrl: photoUrl,
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Item photo uploaded successfully',
      photoUrl,
      item: updateResult.rows[0],
    });
  } catch (error) {
    console.error('uploadItemPhoto error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to upload item photo',
      error: error.message,
    });
  }
};

// =====================================================
// UPLOAD REPLACEMENT PHOTO
// =====================================================

const uploadReplacementPhoto = async (req, res) => {
  const shopperId = getShopperId(req);

  const itemId = Number(
    req.params.itemId || req.params.id
  );

  const orderId = Number(req.params.orderId);

  // ---------------------------------------------------
  // VALIDATION
  // ---------------------------------------------------

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (
    !Number.isInteger(itemId) ||
    itemId <= 0 ||
    !Number.isInteger(orderId) ||
    orderId <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid order ID or item ID',
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: 'Please upload a replacement photo',
    });
  }

  try {
    // -------------------------------------------------
    // VERIFY ORDER ITEM BELONGS TO THIS SHOPPER
    // -------------------------------------------------

    const itemResult = await db.query(
      `
      SELECT
        oi.id,
        oi.order_id,
        oi.shop_id,
        oi.item_name,
        oi.replacement_preference,
        o.customer_id
      FROM order_items oi
      INNER JOIN orders o
        ON o.id = oi.order_id
      WHERE
        oi.id = $1
        AND oi.order_id = $2
        AND o.shopper_id = $3
      LIMIT 1
      `,
      [itemId, orderId, shopperId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order item not found for this shopper',
        orderId,
        itemId,
      });
    }

    const item = itemResult.rows[0];

    if (await rejectInactiveOrder(res, item.order_id)) {
      return undefined;
    }

    // -------------------------------------------------
    // CUSTOMER ASKED FOR A REFUND, NOT A REPLACEMENT
    // -------------------------------------------------

    if (item.replacement_preference === 'refund') {
      fs.unlink(req.file.path, () => {});

      return res.status(409).json({
        success: false,
        code: 'refund_requested',
        message: 'Customer asked for a refund instead of a replacement.',
        orderId,
        itemId,
      });
    }

    // -------------------------------------------------
    // GET UPLOADED PHOTO URL
    // -------------------------------------------------

    const uploadedPath = req.file.path
      ? req.file.path
          .replace(/\\/g, '/')
          .split('uploads/')
          .pop()
      : null;

    if (!uploadedPath) {
      return res.status(500).json({
        success: false,
        message: 'Unable to get uploaded photo path',
      });
    }

    const photoUrl = `/uploads/${uploadedPath}`;

    // -------------------------------------------------
    // CHECK EXISTING REPLACEMENT RECORD
    //
    // Actual table columns:
    // order_id
    // original_item_id
    // shopper_id
    // option_number
    // photo_url
    // status
    // -------------------------------------------------

    const replacementResult = await db.query(
      `
      SELECT id
      FROM replacement_items
      WHERE
        order_id = $1
        AND original_item_id = $2
        AND shopper_id = $3
      ORDER BY id DESC
      LIMIT 1
      `,
      [item.order_id, item.id, shopperId]
    );

    let savedReplacement;

    // -------------------------------------------------
    // UPDATE EXISTING RECORD
    // -------------------------------------------------

    if (replacementResult.rows.length > 0) {
      const updateResult = await db.query(
        `
       UPDATE replacement_items
SET
  photo_url = $1,
  status = 'waiting_customer',
  updated_at = NOW()
WHERE
  id = $2
  AND status IN ('pending', 'waiting_customer')
RETURNING *
        `,
        [
          photoUrl,
          replacementResult.rows[0].id,
        ]
      );

      savedReplacement = updateResult.rows[0];
    } else {
      // -----------------------------------------------
      // CREATE NEW REPLACEMENT RECORD
      // -----------------------------------------------

      const insertResult = await db.query(
        `
        INSERT INTO replacement_items (
          order_id,
          original_item_id,
          shopper_id,
          option_number,
          photo_url,
          status,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          NOW(),
          NOW()
        )
        RETURNING *
        `,
        [
          item.order_id,
          item.id,
          shopperId,
          1,
          photoUrl,
          'waiting_customer',
        ]
      );

      savedReplacement = insertResult.rows[0];
    }

    // -------------------------------------------------
    // SOCKET.IO EVENT
    // -------------------------------------------------

    emitOrderSocketEvent({
      req,
      event: 'order-item-updated',
      orderId: item.order_id,
      customerId: item.customer_id,
      shopperId,
      payload: {
        itemId: item.id,
        shopId: item.shop_id,
        replacementPhotoUrl: photoUrl,
        replacement: savedReplacement,
      },
    });

    // Chat timeline: "We let <customer> know that <item> is
    // unavailable" (once per item)
    await postChatEvent({
      io: req.app.get('io'),
      orderId: item.order_id,
      eventType: 'item_unavailable',
      data: { itemName: item.item_name },
      onceKey: `item:${item.id}`,
    });

    // -------------------------------------------------
    // RESPONSE
    // -------------------------------------------------

    return res.status(200).json({
      success: true,
      message: 'Replacement photo uploaded successfully',
      photoUrl,
      replacement: savedReplacement,
    });
  } catch (error) {
    console.error(
      'uploadReplacementPhoto error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to upload replacement photo',
      error: error.message,
    });
  }
};

// =====================================================
// VERIFY A SCANNED BARCODE
// POST /api/shopper/orders/:orderId/items/:itemId/verify-barcode
// { barcode, target?: 'found' | 'replacement' }
// Checks the scan against the barcode stored for the ordered
// product (or the customer's approved replacement). Read-only:
// confirming still goes through the status update, which checks
// again.
// =====================================================

const ALREADY_FOUND_STATUSES = ['found', 'replaced', 'refunded', 'done', 'completed'];

const verifyItemBarcode = async (req, res) => {
  const shopperId = getShopperId(req);
  const orderId = Number(req.params.orderId);
  const itemId = Number(req.params.itemId);
  const target = req.body?.target === 'replacement' ? 'replacement' : 'found';
  const rawBarcode = String(req.body?.barcode ?? '').replace(/\s+/g, '');
  const scannedBarcode = normalizeBarcode(rawBarcode);

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (
    !Number.isInteger(orderId) || orderId <= 0 ||
    !Number.isInteger(itemId) || itemId <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid order or item ID',
    });
  }

  if (!scannedBarcode || rawBarcode.length > 64) {
    return res.status(400).json({
      success: false,
      message: 'Scan or enter a barcode',
    });
  }

  try {
    const result = await db.query(
      `
      SELECT
        oi.id,
        oi.shopping_status,
        p.barcode AS product_barcode,
        rp.barcode AS replacement_barcode
      FROM order_items oi
      INNER JOIN orders o
        ON o.id = oi.order_id
      LEFT JOIN products p
        ON p.id = oi.product_id
      LEFT JOIN products rp
        ON rp.id = oi.replacement_product_id
      WHERE
        oi.id = $1
        AND oi.order_id = $2
        AND o.shopper_id = $3
      LIMIT 1
      `,
      [itemId, orderId, shopperId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order item not found for this shopper',
      });
    }

    const item = result.rows[0];

    if (await rejectInactiveOrder(res, orderId)) {
      return undefined;
    }
    const expectedBarcode = normalizeBarcode(
      target === 'replacement'
        ? item.replacement_barcode
        : item.product_barcode
    );

    const base = {
      success: true,
      itemId,
      target,
      barcode: rawBarcode,
      hasBarcode: Boolean(expectedBarcode),
      alreadyFound: ALREADY_FOUND_STATUSES.includes(item.shopping_status),
    };

    if (!expectedBarcode) {
      return res.json({
        ...base,
        verified: false,
        code: 'no_barcode',
        message: 'Barcode verification is unavailable for this item',
      });
    }

    if (expectedBarcode !== scannedBarcode) {
      return res.json({
        ...base,
        verified: false,
        code: 'barcode_mismatch',
        message: 'Barcode does not match',
      });
    }

    return res.json({
      ...base,
      verified: true,
      code: 'verified',
      message: 'Item verified successfully',
    });
  } catch (error) {
    console.error('❌ verifyItemBarcode error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to verify barcode',
    });
  }
};

// =====================================================
// UPDATE ITEM SHOPPING STATUS
// =====================================================

const updateItemShoppingStatus = async (req, res) => {
  const shopperId = getShopperId(req);

  const itemId = Number(
    req.params.itemId || req.params.id
  );

  const {
    shopping_status,
    shoppingStatus,
    status,
    found_quantity,
    foundQuantity,
    found_weight,
    foundWeight,
    found_weight_unit,
    foundWeightUnit,
    barcode_scanned,
    barcodeScanned,
    // What the shopper scanned / typed; checked against the product
    barcode,
  } = req.body || {};

  const nextStatus =
    shopping_status ||
    shoppingStatus ||
    status;

  const scannedBarcode = normalizeBarcode(barcode);

  const allowedStatuses = [
    'pending',
    'found',
    'not_found',
    'replaced',
    // Unavailable and refunded instead of replaced (final)
    'refunded',
    'completed',
    'done',
  ];

  // ---------------------------------------------------
  // VALIDATION
  // ---------------------------------------------------

  if (!shopperId) {
    return res.status(401).json({
      success: false,
      message: 'Shopper authentication required',
    });
  }

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Invalid item ID',
    });
  }

  if (
    typeof nextStatus !== 'string' ||
    !allowedStatuses.includes(nextStatus)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid shopping status',
      allowedStatuses,
    });
  }

  try {
    // -------------------------------------------------
    // VERIFY ITEM BELONGS TO THIS SHOPPER
    // -------------------------------------------------

    const itemResult = await db.query(
      `
      SELECT
        oi.id,
        oi.order_id,
        oi.shop_id,
        oi.item_name,
        oi.replacement_product_name,
        o.customer_id,
        p.barcode AS product_barcode,
        rp.barcode AS replacement_barcode
      FROM order_items oi
      INNER JOIN orders o
        ON o.id = oi.order_id
      LEFT JOIN products p
        ON p.id = oi.product_id
      LEFT JOIN products rp
        ON rp.id = oi.replacement_product_id
      WHERE
        oi.id = $1
        AND o.shopper_id = $2
      LIMIT 1
      `,
      [itemId, shopperId]
    );

    if (itemResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order item not found for this shopper',
        itemId,
        shopperId,
      });
    }

    const item = itemResult.rows[0];

    if (await rejectInactiveOrder(res, item.order_id)) {
      return undefined;
    }

    // -------------------------------------------------
    // BARCODE VERIFICATION
    // A scanned barcode must match the product being confirmed:
    // the ordered product when found, the customer's approved
    // replacement when replaced. Products without a stored
    // barcode can't be checked and are accepted.
    // Found / replaced: a product with a barcode on file must be
    // scanned (or its number typed) before it can be confirmed.
    // -------------------------------------------------

    const requiredBarcode = normalizeBarcode(
      nextStatus === 'found'
        ? item.product_barcode
        : nextStatus === 'replaced'
        ? item.replacement_barcode
        : null
    );

    if (requiredBarcode && !scannedBarcode) {
      return res.status(409).json({
        success: false,
        code: 'barcode_required',
        message: nextStatus === 'replaced'
          ? 'Scan the replacement\'s barcode to confirm it\'s the right product.'
          : 'Scan the item\'s barcode to confirm it\'s the right product.',
        itemId,
      });
    }

    if (scannedBarcode) {
      const expectedBarcode = normalizeBarcode(
        nextStatus === 'replaced'
          ? item.replacement_barcode
          : ['found', 'done', 'completed'].includes(nextStatus)
          ? item.product_barcode
          : null
      );

      if (expectedBarcode && expectedBarcode !== scannedBarcode) {
        return res.status(409).json({
          success: false,
          code: 'barcode_mismatch',
          message: 'Wrong item scanned. This barcode does not match the item.',
          itemId,
        });
      }
    }

    // -------------------------------------------------
    // NORMALIZE OPTIONAL VALUES
    // -------------------------------------------------

    const quantityValue =
      found_quantity ?? foundQuantity ?? null;

    const weightValue =
      found_weight ?? foundWeight ?? null;

    const weightUnitValue =
      found_weight_unit ?? foundWeightUnit ?? null;

    const barcodeValue =
      barcode_scanned ?? barcodeScanned ?? null;

    // -------------------------------------------------
    // UPDATE ITEM STATUS
    // -------------------------------------------------

    const updateResult = await db.query(
      `
      UPDATE order_items
      SET
        shopping_status = $1::varchar,

        -- Refunded: nothing was found
        found_quantity = CASE
          WHEN $1::varchar = 'refunded' THEN 0
          ELSE COALESCE($2, found_quantity)
        END,

        -- Refunded: what the customer gets back for it - the line
        -- total (price x quantity) + its service fee, with the GetMe
        -- fee on both (rates saved on the order; fees.customerTotals)
        refund_amount = CASE
          WHEN $1::varchar = 'refunded'
          THEN ROUND(
            (
              COALESCE(order_items.price, 0) * COALESCE(order_items.quantity, 1)
              + (SELECT service_fee_per_unit FROM orders WHERE orders.id = order_items.order_id)
                * ${serviceUnitsSql('order_items')}
            ) * (1 + (SELECT getme_fee_percent FROM orders WHERE orders.id = order_items.order_id) / 100),
            2
          )
          ELSE refund_amount
        END,

        refunded_at = CASE
          WHEN $1::varchar = 'refunded' THEN NOW()
          ELSE refunded_at
        END,

        found_weight = COALESCE(
          $3,
          found_weight
        ),

        found_weight_unit = COALESCE(
          $4::varchar,
          found_weight_unit
        ),

        barcode_scanned = COALESCE(
          $5::boolean,
          barcode_scanned
        ),

        completed_at = CASE
          WHEN $1::varchar IN (
            'found',
            'not_found',
            'replaced',
            'refunded',
            'completed',
             'done'
          )
          THEN NOW()
          ELSE NULL
        END

      WHERE
        id = $6
        AND order_id = $7
        -- Found / replaced / refunded once only: a repeated scan or
        -- double tap can't confirm the same item again, and an item
        -- that was found or replaced can't be refunded
        AND NOT (
          $1::varchar IN ('found', 'replaced', 'refunded')
          AND COALESCE(shopping_status, 'pending') IN ('found', 'replaced', 'done', 'completed', 'refunded')
        )
        -- A refund is final: nothing changes the item afterwards
        AND COALESCE(shopping_status, 'pending') <> 'refunded'
        -- 'done' / 'completed' only finish an item that was already
        -- found (barcode-verified) or replaced, so they can't skip
        -- the barcode check
        AND NOT (
          $1::varchar IN ('done', 'completed')
          AND COALESCE(shopping_status, 'pending') NOT IN ('found', 'replaced', 'done', 'completed')
        )

      RETURNING *
      `,
      [
        nextStatus,
        quantityValue,
        weightValue,
        weightUnitValue,
        barcodeValue,
        itemId,
        item.order_id,
      ]
    );

    if (
      updateResult.rows.length === 0 &&
      (nextStatus === 'found' || nextStatus === 'replaced' || nextStatus === 'refunded')
    ) {
      // What the item is now decides the answer
      const current = await db.query(
        'SELECT shopping_status FROM order_items WHERE id = $1',
        [itemId]
      );

      const currentStatus = String(current.rows[0]?.shopping_status || '');

      if (currentStatus === 'refunded') {
        return res.status(409).json({
          success: false,
          code: 'already_refunded',
          message: 'This item has already been refunded.',
          itemId,
        });
      }

      if (nextStatus === 'refunded') {
        return res.status(409).json({
          success: false,
          code: 'already_completed',
          message: 'This item was already found or replaced, so it can\'t be refunded.',
          itemId,
        });
      }

      return res.status(409).json({
        success: false,
        code: nextStatus === 'replaced' ? 'already_replaced' : 'already_found',
        message: nextStatus === 'replaced'
          ? 'This item is already replaced.'
          : 'This item is already marked as found.',
        itemId,
      });
    }

    if (
      updateResult.rows.length === 0 &&
      (nextStatus === 'done' || nextStatus === 'completed')
    ) {
      return res.status(409).json({
        success: false,
        code: 'not_found_yet',
        message: 'Mark the item as found (scan its barcode) before finishing it.',
        itemId,
      });
    }

    if (updateResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Item status update did not match an order item',
        itemId,
        orderId: item.order_id,
      });
    }

    const updatedItem = updateResult.rows[0];

    // -------------------------------------------------
    // SOCKET.IO REAL-TIME EVENT
    // -------------------------------------------------

    emitOrderSocketEvent({
      req,
      event: 'order-item-updated',
      orderId: item.order_id,
      customerId: item.customer_id,
      shopperId,
      payload: {
        itemId: updatedItem.id,
        shopId: item.shop_id,
        shoppingStatus: updatedItem.shopping_status,
        item: updatedItem,
      },
    });

    // -------------------------------------------------
    // CHAT TIMELINE
    // -------------------------------------------------

    const io = req.app.get('io');
    const itemName = item.item_name;
    const itemKey = `item:${item.id}`;

    if (
      nextStatus === 'not_found' ||
      nextStatus === 'replaced' ||
      nextStatus === 'refunded'
    ) {
      await postChatEvent({
        io,
        orderId: item.order_id,
        eventType: 'item_unavailable',
        data: { itemName },
        onceKey: itemKey,
      });
    }

    if (nextStatus === 'replaced') {
      const replacementName = item.replacement_product_name || null;

      await postChatEvent({
        io,
        orderId: item.order_id,
        eventType: 'item_replaced',
        data: { itemName, replacementName },
        onceKey: itemKey,
      });

      // The customer chose this replacement when ordering
      await postChatEvent({
        io,
        orderId: item.order_id,
        eventType: 'replacement_approved',
        data: { itemName, replacementName, preApproved: true },
        onceKey: itemKey,
      });
    }

    // Bought: the shop's listed stock goes down (once per item,
    // inventory/stockService.js); not awaited so the shopper's
    // screen never waits on it
    if (nextStatus === 'found' || nextStatus === 'replaced') {
      deductForOrderItem(updatedItem.id, io);
    }

    // Paid by saved card: the item's price goes back to the card
    if (nextStatus === 'refunded') {
      reconcileInBackground(item.order_id, {
        io,
        reason: `${itemName || 'Item'} unavailable`,
      });
    }

    // -------------------------------------------------
    // RESPONSE
    // -------------------------------------------------

    return res.status(200).json({
      success: true,
      message: 'Item shopping status updated successfully',
      item: updatedItem,
    });
  } catch (error) {
    console.error(
      'updateItemShoppingStatus error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to update item shopping status',
      error: error.message,
    });
  }
};

// =====================================================
// EXPORTS
// =====================================================

module.exports = {
  uploadItemPhoto,
  uploadReplacementPhoto,
  updateItemShoppingStatus,
  verifyItemBarcode,
};
