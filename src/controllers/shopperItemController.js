
const db = require('../config/db');
const fs = require('fs');
const path = require('path');

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
  } = req.body || {};

  const nextStatus =
    shopping_status ||
    shoppingStatus ||
    status;

  const allowedStatuses = [
    'pending',
    'found',
    'not_found',
    'replaced',
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
        itemId,
        shopperId,
      });
    }

    const item = itemResult.rows[0];

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

        found_quantity = COALESCE(
          $2,
          found_quantity
        ),

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
            'completed',
             'done'
          )
          THEN NOW()
          ELSE NULL
        END

      WHERE
        id = $6
        AND order_id = $7

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
};
