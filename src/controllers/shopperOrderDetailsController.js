
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
// SAFE NUMBER
// =====================================================

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
};

// =====================================================
// GET IMAGE URL FROM AVAILABLE DATABASE FIELDS
// =====================================================

const getImageUrl = (row) => {
  return (
    row?.image_url ||
    row?.imageUrl ||
    row?.image ||
    row?.product_image ||
    row?.product_image_url ||
    row?.photo_url ||
    row?.photoUrl ||
    row?.photo ||
    row?.shopper_photo_url ||
    null
  );
};

// =====================================================
// GET MY ORDER BY ID
// =====================================================

const getMyOrderById = async (req, res) => {
  const orderId = Number(req.params.orderId || req.params.id);
  const shopperId = getShopperId(req);

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
    // ===================================================
    // 1. GET THE EXACT ORDER
    // ===================================================

    const orderResult = await db.query(
      `
      SELECT
        o.*,
        c.full_name AS customer_name,
        c.mobile AS customer_phone
      FROM orders o
      LEFT JOIN customers c
        ON c.id = o.customer_id
      WHERE
        o.id = $1
        AND o.shopper_id = $2
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

    // ===================================================
    // 2. GET SHOPS FOR THIS ORDER
    // ===================================================

    const shopsResult = await db.query(
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

    // ===================================================
    // 3. GET ITEMS FOR THIS EXACT ORDER
    // ===================================================

    const itemsResult = await db.query(
      `
      SELECT
        oi.*,
        s.shop_name
      FROM order_items oi
      LEFT JOIN shops s
        ON s.id = oi.shop_id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
      `,
      [orderId]
    );

    // ===================================================
    // 4. GET SHOP BILLS
    // ===================================================

    const billsResult = await db.query(
      `
      SELECT *
      FROM order_shop_bills
      WHERE order_id = $1
      ORDER BY id ASC
      `,
      [orderId]
    );

    // ===================================================
    // 5. GET REPLACEMENT ITEMS
    // ===================================================

const replacementsResult = await db.query(
  `
  SELECT ri.*
  FROM replacement_items ri
  INNER JOIN order_items oi
    ON oi.id = ri.original_item_id
  WHERE oi.order_id = $1
  ORDER BY ri.id ASC
  `,
  [orderId]
);
    // ===================================================
    // 6. NORMALIZE ORDER ITEMS
    // ===================================================

    const orderItems = itemsResult.rows.map((item) => {
      const itemId = toNumberOrNull(item.id);
      const itemOrderId = toNumberOrNull(item.order_id);
      const productId = toNumberOrNull(item.product_id);
      const itemShopId = toNumberOrNull(item.shop_id);

      const itemName =
        item.item_name ||
        item.name ||
        item.product_name ||
        item.title ||
        '';

      const imageUrl = getImageUrl(item);

      return {
        ...item,

        id: itemId,
        order_id: itemOrderId,
        orderId: itemOrderId,

        product_id: productId,
        productId,

        shop_id: itemShopId,
        shopId: itemShopId,

        // Product name aliases for the frontend
        name: itemName,
        item_name: itemName,
        itemName,
        product_name: itemName,
        productName: itemName,

        // Keep the original image field and provide aliases
        image: imageUrl,
        image_url: imageUrl,
        imageUrl,

        // Quantity and unit from the database
        quantity: item.quantity ?? item.qty ?? 1,
        qty: item.qty ?? item.quantity ?? 1,
        unit: item.unit || item.quantity_unit || null,

        // Voice and shopper-uploaded photo
        voice_url: item.voice_url || null,
        shopper_photo_url: item.shopper_photo_url || null,

        // Shopping progress
        shopping_status: item.shopping_status || 'pending',

        found_quantity: item.found_quantity ?? null,
        found_weight: item.found_weight ?? null,
        found_weight_unit: item.found_weight_unit ?? null,

        barcode_scanned: Boolean(item.barcode_scanned),
      };
    });

    // ===================================================
    // 7. MAP ITEMS TO THEIR CORRECT SHOPS
    // ===================================================

    const shops = shopsResult.rows.map((shop) => {
      const shopId = toNumberOrNull(shop.shop_id);

      const shopItems = orderItems.filter((item) => {
        return (
          item.shop_id !== null &&
          shopId !== null &&
          item.shop_id === shopId
        );
      });

      const shopBill =
        billsResult.rows.find(
          (bill) =>
            toNumberOrNull(bill.shop_id) === shopId
        ) || null;

      let shoppingStatus = 'shopping';

      if (
        shopBill &&
        String(shopBill.status || '').toLowerCase() === 'completed'
      ) {
        shoppingStatus = 'completed';
      } else if (
        shopItems.length > 0 &&
        shopItems.every((item) => {
          const status = String(
            item.shopping_status || 'pending'
          ).toLowerCase();

          return [
            'found',
            'not_found',
            'replaced',
            'completed',
          ].includes(status);
        })
      ) {
        shoppingStatus = 'ready_for_bill';
      }

      const shopImage =
        shop.shop_image ||
        shop.image_url ||
        shop.image ||
        null;

      return {
        ...shop,

        shopId,
        shop_id: shopId,

        shopName: shop.shop_name || shop.name || 'Shop',
        shop_name: shop.shop_name || shop.name || 'Shop',

        shopImage,
        shop_image: shopImage,
        image_url: shopImage,

        pickupLatitude: toNumberOrNull(shop.shop_latitude),
        pickupLongitude: toNumberOrNull(shop.shop_longitude),

        // All these properties contain only this shop's items
        items: shopItems,
        orderItems: shopItems,
        order_items: shopItems,
        shoppingList: shopItems,
        shopping_list: shopItems,

        itemCount: shopItems.length,

        bill: shopBill,

        shoppingStatus,
        shopping_status: shoppingStatus,
      };
    });

    // ===================================================
    // 8. NORMALIZE CUSTOMER INFORMATION
    // ===================================================

    const customerId = toNumberOrNull(order.customer_id);
    const normalizedShopperId = toNumberOrNull(order.shopper_id);

    // ===================================================
    // 9. SEND RESPONSE TO SHOPPER APP
    // ===================================================

    return res.status(200).json({
      success: true,

      order: {
        ...order,

        id: Number(order.id),
        orderId: Number(order.id),

        customer_id: customerId,
        customerId,

        shopper_id: normalizedShopperId,

        customerName:
          order.customer_name ||
          `Customer #${customerId ?? ''}`,

        customer_name:
          order.customer_name ||
          `Customer #${customerId ?? ''}`,

        customerPhone: order.customer_phone || null,
        customer_phone: order.customer_phone || null,
        phone: order.customer_phone || null,

        // Order-level items
        items: orderItems,
        orderItems,
        order_items: orderItems,
        shoppingList: orderItems,
        shopping_list: orderItems,

        // Each shop has its own filtered items
        shops,
        shopCount: shops.length,

        bills: billsResult.rows,

        replacementItems: replacementsResult.rows,
        replacement_items: replacementsResult.rows,
      },
    });
  } catch (error) {
    console.error('getMyOrderById error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to get order details',
      error: error.message,
    });
  }
};

module.exports = {
  getMyOrderById,
};
