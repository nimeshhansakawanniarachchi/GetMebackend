
// const db = require('../config/db');

// // =====================================================
// // GET SHOPPER ID
// // =====================================================

// const getShopperId = (req) => {
//   return (
//     req.shopper?.shopperId ||
//     req.shopper?.id ||
//     req.shopperId ||
//     req.user?.shopperId ||
//     req.user?.id ||
//     null
//   );
// };

// // =====================================================
// // SAFE NUMBER
// // =====================================================

// const toNumberOrNull = (value) => {
//   if (value === null || value === undefined || value === '') {
//     return null;
//   }

//   const number = Number(value);

//   return Number.isFinite(number) ? number : null;
// };

// // =====================================================
// // GET IMAGE URL FROM AVAILABLE DATABASE FIELDS
// // =====================================================

// const getImageUrl = (row) => {
//   return (
//     row?.image_url ||
//     row?.imageUrl ||
//     row?.image ||
//     row?.product_image ||
//     row?.product_image_url ||
//     row?.photo_url ||
//     row?.photoUrl ||
//     row?.photo ||
//     row?.shopper_photo_url ||
//     null
//   );
// };

// // =====================================================
// // GET MY ORDER BY ID
// // =====================================================

// const getMyOrderById = async (req, res) => {
//   const orderId = Number(req.params.orderId || req.params.id);
//   const shopperId = getShopperId(req);

//   if (!shopperId) {
//     return res.status(401).json({
//       success: false,
//       message: 'Shopper authentication required',
//     });
//   }

//   if (!Number.isInteger(orderId) || orderId <= 0) {
//     return res.status(400).json({
//       success: false,
//       message: 'Invalid order ID',
//     });
//   }

//   try {
//     // ===================================================
//     // 1. GET THE EXACT ORDER
//     // ===================================================

//     const orderResult = await db.query(
//       `
//       SELECT
//         o.*,
//         c.full_name AS customer_name,
//         c.mobile AS customer_phone
//       FROM orders o
//       LEFT JOIN customers c
//         ON c.id = o.customer_id
//       WHERE
//         o.id = $1
//         AND o.shopper_id = $2
//       LIMIT 1
//       `,
//       [orderId, shopperId]
//     );

//     if (orderResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Order not found for this shopper',
//       });
//     }

//     const order = orderResult.rows[0];

//     // ===================================================
//     // 2. GET SHOPS FOR THIS ORDER
//     // ===================================================

//     const shopsResult = await db.query(
//       `
//       SELECT
//         os.*,
//         s.shop_name,
//         s.image_url AS shop_image,
//         s.latitude AS shop_latitude,
//         s.longitude AS shop_longitude
//       FROM order_shops os
//       INNER JOIN shops s
//         ON s.id = os.shop_id
//       WHERE os.order_id = $1
//       ORDER BY os.shop_id ASC
//       `,
//       [orderId]
//     );

//     // ===================================================
//     // 3. GET ITEMS FOR THIS EXACT ORDER
//     // ===================================================

//     const itemsResult = await db.query(
//       `
//       SELECT
//         oi.*,
//         s.shop_name
//       FROM order_items oi
//       LEFT JOIN shops s
//         ON s.id = oi.shop_id
//       WHERE oi.order_id = $1
//       ORDER BY oi.id ASC
//       `,
//       [orderId]
//     );

//     // ===================================================
//     // 4. GET SHOP BILLS
//     // ===================================================

//     const billsResult = await db.query(
//       `
//       SELECT *
//       FROM order_shop_bills
//       WHERE order_id = $1
//       ORDER BY id ASC
//       `,
//       [orderId]
//     );

//     // ===================================================
//     // 5. GET REPLACEMENT ITEMS
//     // ===================================================

// const replacementsResult = await db.query(
//   `
//   SELECT ri.*
//   FROM replacement_items ri
//   INNER JOIN order_items oi
//     ON oi.id = ri.original_item_id
//   WHERE oi.order_id = $1
//   ORDER BY ri.id ASC
//   `,
//   [orderId]
// );
//     // ===================================================
//     // 6. NORMALIZE ORDER ITEMS
//     // ===================================================

//     const orderItems = itemsResult.rows.map((item) => {
//       const itemId = toNumberOrNull(item.id);
//       const itemOrderId = toNumberOrNull(item.order_id);
//       const productId = toNumberOrNull(item.product_id);
//       const itemShopId = toNumberOrNull(item.shop_id);

//       const itemName =
//         item.item_name ||
//         item.name ||
//         item.product_name ||
//         item.title ||
//         '';

//       const imageUrl = getImageUrl(item);

//       return {
//         ...item,

//         id: itemId,
//         order_id: itemOrderId,
//         orderId: itemOrderId,

//         product_id: productId,
//         productId,

//         shop_id: itemShopId,
//         shopId: itemShopId,

//         // Product name aliases for the frontend
//         name: itemName,
//         item_name: itemName,
//         itemName,
//         product_name: itemName,
//         productName: itemName,

//         // Keep the original image field and provide aliases
//         image: imageUrl,
//         image_url: imageUrl,
//         imageUrl,

//         // Quantity and unit from the database
//         quantity: item.quantity ?? item.qty ?? 1,
//         qty: item.qty ?? item.quantity ?? 1,
//         unit: item.unit || item.quantity_unit || null,

//         // Voice and shopper-uploaded photo
//         voice_url: item.voice_url || null,
//         shopper_photo_url: item.shopper_photo_url || null,

//         // Shopping progress
//         shopping_status: item.shopping_status || 'pending',

//         found_quantity: item.found_quantity ?? null,
//         found_weight: item.found_weight ?? null,
//         found_weight_unit: item.found_weight_unit ?? null,

//         barcode_scanned: Boolean(item.barcode_scanned),
//       };
//     });

//     // ===================================================
//     // 7. MAP ITEMS TO THEIR CORRECT SHOPS
//     // ===================================================

//     const shops = shopsResult.rows.map((shop) => {
//       const shopId = toNumberOrNull(shop.shop_id);

//       const shopItems = orderItems.filter((item) => {
//         return (
//           item.shop_id !== null &&
//           shopId !== null &&
//           item.shop_id === shopId
//         );
//       });

//       const shopBill =
//         billsResult.rows.find(
//           (bill) =>
//             toNumberOrNull(bill.shop_id) === shopId
//         ) || null;

//       let shoppingStatus = 'shopping';

//       if (
//         shopBill &&
//         String(shopBill.status || '').toLowerCase() === 'completed'
//       ) {
//         shoppingStatus = 'completed';
//       } else if (
//         shopItems.length > 0 &&
//         shopItems.every((item) => {
//           const status = String(
//             item.shopping_status || 'pending'
//           ).toLowerCase();

//           return [
//             'found',
//             'not_found',
//             'replaced',
//             'completed',
//           ].includes(status);
//         })
//       ) {
//         shoppingStatus = 'ready_for_bill';
//       }

//       const shopImage =
//         shop.shop_image ||
//         shop.image_url ||
//         shop.image ||
//         null;

//       return {
//         ...shop,

//         shopId,
//         shop_id: shopId,

//         shopName: shop.shop_name || shop.name || 'Shop',
//         shop_name: shop.shop_name || shop.name || 'Shop',

//         shopImage,
//         shop_image: shopImage,
//         image_url: shopImage,

//         pickupLatitude: toNumberOrNull(shop.shop_latitude),
//         pickupLongitude: toNumberOrNull(shop.shop_longitude),

//         // All these properties contain only this shop's items
//         items: shopItems,
//         orderItems: shopItems,
//         order_items: shopItems,
//         shoppingList: shopItems,
//         shopping_list: shopItems,

//         itemCount: shopItems.length,

//         bill: shopBill,

//         shoppingStatus,
//         shopping_status: shoppingStatus,
//       };
//     });

//     // ===================================================
//     // 8. NORMALIZE CUSTOMER INFORMATION
//     // ===================================================

//     const customerId = toNumberOrNull(order.customer_id);
//     const normalizedShopperId = toNumberOrNull(order.shopper_id);

//     // ===================================================
//     // 9. SEND RESPONSE TO SHOPPER APP
//     // ===================================================

//     return res.status(200).json({
//       success: true,

//       order: {
//         ...order,

//         id: Number(order.id),
//         orderId: Number(order.id),

//         customer_id: customerId,
//         customerId,

//         shopper_id: normalizedShopperId,

//         customerName:
//           order.customer_name ||
//           `Customer #${customerId ?? ''}`,

//         customer_name:
//           order.customer_name ||
//           `Customer #${customerId ?? ''}`,

//         customerPhone: order.customer_phone || null,
//         customer_phone: order.customer_phone || null,
//         phone: order.customer_phone || null,

//         // Order-level items
//         items: orderItems,
//         orderItems,
//         order_items: orderItems,
//         shoppingList: orderItems,
//         shopping_list: orderItems,

//         // Each shop has its own filtered items
//         shops,
//         shopCount: shops.length,

//         bills: billsResult.rows,

//         replacementItems: replacementsResult.rows,
//         replacement_items: replacementsResult.rows,
//       },
//     });
//   } catch (error) {
//     console.error('getMyOrderById error:', error);

//     return res.status(500).json({
//       success: false,
//       message: 'Failed to get order details',
//       error: error.message,
//     });
//   }
// };

// module.exports = {
//   getMyOrderById,
// };





























// const db = require('../config/db');

// // =====================================================
// // GET SHOPPER ID
// // =====================================================

// const getShopperId = (req) => {
//   return (
//     req.shopper?.shopperId ||
//     req.shopper?.id ||
//     req.shopperId ||
//     req.user?.shopperId ||
//     req.user?.id ||
//     null
//   );
// };

// // =====================================================
// // SAFE NUMBER
// // =====================================================

// const toNumberOrNull = (value) => {
//   if (value === null || value === undefined || value === '') {
//     return null;
//   }

//   const number = Number(value);

//   return Number.isFinite(number) ? number : null;
// };

// // =====================================================
// // GET IMAGE URL FROM AVAILABLE DATABASE FIELDS
// // =====================================================

// const getImageUrl = (row) => {
//   return (
//     row?.image_url ||
//     row?.imageUrl ||
//     row?.image ||
//     row?.product_image ||
//     row?.product_image_url ||
//     row?.photo_url ||
//     row?.photoUrl ||
//     row?.photo ||
//     row?.shopper_photo_url ||
//     null
//   );
// };

// // =====================================================
// // GET MY ORDER BY ID
// // Supports optional ?shopId=3
// // =====================================================

// const getMyOrderById = async (req, res) => {
//   const orderId = Number(req.params.orderId || req.params.id);
//   const shopperId = getShopperId(req);

//   const rawShopId = req.query?.shopId;

//   const requestedShopId =
//     rawShopId === undefined || rawShopId === ''
//       ? null
//       : Number(rawShopId);

//   if (!shopperId) {
//     return res.status(401).json({
//       success: false,
//       message: 'Shopper authentication required',
//     });
//   }

//   if (!Number.isInteger(orderId) || orderId <= 0) {
//     return res.status(400).json({
//       success: false,
//       message: 'Invalid order ID',
//     });
//   }

//   if (
//     requestedShopId !== null &&
//     (!Number.isInteger(requestedShopId) ||
//       requestedShopId <= 0)
//   ) {
//     return res.status(400).json({
//       success: false,
//       message: 'Invalid shop ID',
//     });
//   }

//   try {
//     // ===================================================
//     // 1. GET THE EXACT ORDER
//     // ===================================================

//     const orderResult = await db.query(
//       `
//       SELECT
//         o.*,
//         c.full_name AS customer_name,
//         c.mobile AS customer_phone
//       FROM orders o
//       LEFT JOIN customers c
//         ON c.id = o.customer_id
//       WHERE
//         o.id = $1
//         AND o.shopper_id = $2
//       LIMIT 1
//       `,
//       [orderId, shopperId]
//     );

//     if (orderResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Order not found for this shopper',
//       });
//     }

//     const order = orderResult.rows[0];

//     // ===================================================
//     // 2. GET SHOPS FOR THIS ORDER
//     // ===================================================

//     const shopsResult = await db.query(
//       `
//       SELECT
//         os.*,
//         s.shop_name,
//         s.image_url AS shop_image,
//         s.latitude AS shop_latitude,
//         s.longitude AS shop_longitude
//       FROM order_shops os
//       INNER JOIN shops s
//         ON s.id = os.shop_id
//       WHERE os.order_id = $1
//       ORDER BY os.shop_id ASC
//       `,
//       [orderId]
//     );

//     // ===================================================
//     // 3. VALIDATE REQUESTED SHOP
//     // ===================================================

//     if (requestedShopId !== null) {
//       const shopExists = shopsResult.rows.some(
//         (shop) =>
//           toNumberOrNull(shop.shop_id) === requestedShopId
//       );

//       if (!shopExists) {
//         return res.status(404).json({
//           success: false,
//           message: 'Shop not found in this order',
//         });
//       }
//     }

//     // ===================================================
//     // 4. GET ALL ITEMS FOR THIS EXACT ORDER
//     // Keep all items for shop-level calculations.
//     // ===================================================

//     const itemsResult = await db.query(
//       `
//       SELECT
//         oi.*,
//         s.shop_name
//       FROM order_items oi
//       LEFT JOIN shops s
//         ON s.id = oi.shop_id
//       WHERE oi.order_id = $1
//       ORDER BY oi.id ASC
//       `,
//       [orderId]
//     );

//     // ===================================================
//     // 5. GET SHOP BILLS
//     // ===================================================

//     const billsResult = await db.query(
//       `
//       SELECT *
//       FROM order_shop_bills
//       WHERE order_id = $1
//       ORDER BY id ASC
//       `,
//       [orderId]
//     );

//     // ===================================================
//     // 6. GET REPLACEMENT ITEMS
//     // ===================================================

//     const replacementsResult = await db.query(
//       `
//       SELECT ri.*
//       FROM replacement_items ri
//       INNER JOIN order_items oi
//         ON oi.id = ri.original_item_id
//       WHERE oi.order_id = $1
//       ORDER BY ri.id ASC
//       `,
//       [orderId]
//     );

//     // ===================================================
//     // 7. NORMALIZE ALL ORDER ITEMS
//     // ===================================================

//     const allOrderItems = itemsResult.rows.map((item) => {
//       const itemId = toNumberOrNull(item.id);
//       const itemOrderId = toNumberOrNull(item.order_id);
//       const productId = toNumberOrNull(item.product_id);
//       const itemShopId = toNumberOrNull(item.shop_id);

//       const itemName =
//         item.item_name ||
//         item.name ||
//         item.product_name ||
//         item.title ||
//         '';

//       const imageUrl = getImageUrl(item);

//       return {
//         ...item,

//         id: itemId,
//         order_id: itemOrderId,
//         orderId: itemOrderId,

//         product_id: productId,
//         productId,

//         shop_id: itemShopId,
//         shopId: itemShopId,

//         name: itemName,
//         item_name: itemName,
//         itemName,
//         product_name: itemName,
//         productName: itemName,

//         image: imageUrl,
//         image_url: imageUrl,
//         imageUrl,

//         quantity: item.quantity ?? item.qty ?? 1,
//         qty: item.qty ?? item.quantity ?? 1,
//         unit: item.unit || item.quantity_unit || null,

//         voice_url: item.voice_url || null,
//         shopper_photo_url: item.shopper_photo_url || null,

//         shopping_status: item.shopping_status || 'pending',

//         found_quantity: item.found_quantity ?? null,
//         found_weight: item.found_weight ?? null,
//         found_weight_unit: item.found_weight_unit ?? null,

//         barcode_scanned: Boolean(item.barcode_scanned),
//       };
//     });

//     // ===================================================
//     // 8. FILTER ORDER-LEVEL ITEMS FOR REQUESTED SHOP
//     // If shopId is omitted, preserve the original response.
//     // ===================================================

//     const responseOrderItems =
//       requestedShopId === null
//         ? allOrderItems
//         : allOrderItems.filter(
//             (item) => item.shop_id === requestedShopId
//           );

//     // ===================================================
//     // 9. MAP ALL ITEMS TO THEIR CORRECT SHOPS
//     // Always use allOrderItems here so other shops retain
//     // their own items and shopping status.
//     // ===================================================

//     const shops = shopsResult.rows.map((shop) => {
//       const shopId = toNumberOrNull(shop.shop_id);

//       const shopItems = allOrderItems.filter((item) => {
//         return (
//           item.shop_id !== null &&
//           shopId !== null &&
//           item.shop_id === shopId
//         );
//       });

//       const shopBill =
//         billsResult.rows.find(
//           (bill) =>
//             toNumberOrNull(bill.shop_id) === shopId
//         ) || null;

//       let shoppingStatus = 'shopping';

//       if (
//         shopBill &&
//         String(shopBill.status || '').toLowerCase() === 'completed'
//       ) {
//         shoppingStatus = 'completed';
//       } else if (
//         shopItems.length > 0 &&
//         shopItems.every((item) => {
//           const status = String(
//             item.shopping_status || 'pending'
//           ).toLowerCase();

//           return [
//             'found',
//             'not_found',
//             'replaced',
//             'completed',
//           ].includes(status);
//         })
//       ) {
//         shoppingStatus = 'ready_for_bill';
//       }

//       const shopImage =
//         shop.shop_image ||
//         shop.image_url ||
//         shop.image ||
//         null;

//       return {
//         ...shop,

//         shopId,
//         shop_id: shopId,

//         shopName: shop.shop_name || shop.name || 'Shop',
//         shop_name: shop.shop_name || shop.name || 'Shop',

//         shopImage,
//         shop_image: shopImage,
//         image_url: shopImage,

//         pickupLatitude: toNumberOrNull(shop.shop_latitude),
//         pickupLongitude: toNumberOrNull(shop.shop_longitude),

//         items: shopItems,
//         orderItems: shopItems,
//         order_items: shopItems,
//         shoppingList: shopItems,
//         shopping_list: shopItems,

//         itemCount: shopItems.length,

//         bill: shopBill,

//         shoppingStatus,
//         shopping_status: shoppingStatus,
//       };
//     });

//     // ===================================================
//     // 10. NORMALIZE CUSTOMER INFORMATION
//     // ===================================================

//     const customerId = toNumberOrNull(order.customer_id);
//     const normalizedShopperId = toNumberOrNull(order.shopper_id);

//     // ===================================================
//     // 11. SEND RESPONSE TO SHOPPER APP
//     // ===================================================

//     return res.status(200).json({
//       success: true,

//       order: {
//         ...order,

//         id: Number(order.id),
//         orderId: Number(order.id),

//         customer_id: customerId,
//         customerId,

//         shopper_id: normalizedShopperId,

//         customerName:
//           order.customer_name ||
//           `Customer #${customerId ?? ''}`,

//         customer_name:
//           order.customer_name ||
//           `Customer #${customerId ?? ''}`,

//         customerPhone: order.customer_phone || null,
//         customer_phone: order.customer_phone || null,
//         phone: order.customer_phone || null,

//         // These order-level lists respect the optional shopId.
//         items: responseOrderItems,
//         orderItems: responseOrderItems,
//         order_items: responseOrderItems,
//         shoppingList: responseOrderItems,
//         shopping_list: responseOrderItems,

//         // This collection still contains every shop and its
//         // correctly separated items.
//         shops,
//         shopCount: shops.length,

//         bills: billsResult.rows,

//         replacementItems: replacementsResult.rows,
//         replacement_items: replacementsResult.rows,
//       },
//     });
//   } catch (error) {
//     console.error('getMyOrderById error:', error);

//     return res.status(500).json({
//       success: false,
//       message: 'Failed to get order details',
//       error: error.message,
//     });
//   }
// };

// module.exports = {
//   getMyOrderById,
// };























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
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
};

// =====================================================
// GET IMAGE URL
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
    null
  );
};

// =====================================================
// GET MY ORDER BY ID
// Optional query: ?shopId=3
//
// Without shopId:
//   Return the complete order.
//
// With shopId:
//   Order-level items and replacements are filtered
//   to the selected shop.
//
// The shops array retains each shop's own items.
// =====================================================

const getMyOrderById = async (req, res) => {
  const orderId = Number(
    req.params.orderId || req.params.id
  );

  const shopperId = getShopperId(req);

  const rawShopId = req.query?.shopId;

  const requestedShopId =
    rawShopId === undefined || rawShopId === ''
      ? null
      : Number(rawShopId);

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

  if (
    requestedShopId !== null &&
    (
      !Number.isInteger(requestedShopId) ||
      requestedShopId <= 0
    )
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid shop ID',
    });
  }

  try {
    // ===================================================
    // 1. GET EXACT ORDER
    // ===================================================

    const orderResult = await db.query(
      `
      SELECT
        o.*,
        c.full_name AS customer_name,
        COALESCE(o.contact_phone, c.mobile) AS customer_phone
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

    const orderShops = shopsResult.rows;

    // ===================================================
    // 3. VALIDATE SELECTED SHOP
    // ===================================================

    if (requestedShopId !== null) {
      const shopExists = orderShops.some(
        (shop) =>
          toNumberOrNull(shop.shop_id) ===
          requestedShopId
      );

      if (!shopExists) {
        return res.status(404).json({
          success: false,
          message: 'Shop not found in this order',
        });
      }
    }

    // ===================================================
    // 4. GET ALL ITEMS FOR THE EXACT ORDER
    // ===================================================

    const itemsResult = await db.query(
      `
      SELECT
        oi.*,
        s.shop_name,
        p.category AS product_category,
        -- Barcodes the ShopperApp verifies scans against
        p.barcode AS product_barcode,
        rp.barcode AS replacement_product_barcode
      FROM order_items oi
      LEFT JOIN shops s
        ON s.id = oi.shop_id
      LEFT JOIN products p
        ON p.id = oi.product_id
      LEFT JOIN products rp
        ON rp.id = oi.replacement_product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id ASC
      `,
      [orderId]
    );

    // ===================================================
    // 5. GET SHOP BILLS
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
    // 6. GET REPLACEMENTS WITH ORIGINAL ITEM SHOP ID
    //
    // original_shop_id lets us filter replacement records
    // to the selected shop without guessing from the
    // replacement's own ID.
    // ===================================================

    const replacementsResult = await db.query(
      `
      SELECT
        ri.*,
        oi.shop_id AS original_shop_id,
        oi.order_id AS original_order_id
      FROM replacement_items ri
      INNER JOIN order_items oi
        ON oi.id = ri.original_item_id
      WHERE oi.order_id = $1
      ORDER BY ri.id ASC
      `,
      [orderId]
    );

    // ===================================================
    // 7. NORMALIZE ALL ORDER ITEMS
    // ===================================================

    const allOrderItems = itemsResult.rows.map(
      (item) => {
        const itemId = toNumberOrNull(item.id);
        const itemOrderId = toNumberOrNull(
          item.order_id
        );
        const productId = toNumberOrNull(
          item.product_id
        );
        const itemShopId = toNumberOrNull(
          item.shop_id
        );

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

          name: itemName,
          item_name: itemName,
          itemName,
          product_name: itemName,
          productName: itemName,

          image: imageUrl,
          image_url: imageUrl,
          imageUrl,

          quantity: item.quantity ?? item.qty ?? 1,
          qty: item.qty ?? item.quantity ?? 1,

          unit:
            item.unit ||
            item.quantity_unit ||
            null,

          voice_url: item.voice_url || null,

          shopper_photo_url:
            item.shopper_photo_url || null,

          shopping_status:
            item.shopping_status || 'pending',

          found_quantity:
            item.found_quantity ?? null,

          found_weight:
            item.found_weight ?? null,

          found_weight_unit:
            item.found_weight_unit ?? null,

          barcode_scanned:
            Boolean(item.barcode_scanned),

          // Product category for aisle grouping (null for custom items)
          category: item.product_category ?? null,
        };
      }
    );

    // ===================================================
    // 8. FILTER ORDER-LEVEL ITEMS
    // ===================================================

    const responseOrderItems =
      requestedShopId === null
        ? allOrderItems
        : allOrderItems.filter(
            (item) =>
              item.shop_id === requestedShopId
          );

    // ===================================================
    // 9. NORMALIZE REPLACEMENTS
    // ===================================================

    const allReplacementItems =
      replacementsResult.rows.map(
        (replacement) => {
          const originalItemId =
            toNumberOrNull(
              replacement.original_item_id
            );

          const originalShopId =
            toNumberOrNull(
              replacement.original_shop_id
            );

          const originalOrderId =
            toNumberOrNull(
              replacement.original_order_id
            );

          return {
            ...replacement,

            original_item_id: originalItemId,
            originalItemId: originalItemId,

            original_shop_id: originalShopId,
            originalShopId: originalShopId,

            original_order_id: originalOrderId,
            originalOrderId: originalOrderId,
          };
        }
      );

    // ===================================================
    // 10. FILTER REPLACEMENTS FOR SELECTED SHOP
    // ===================================================

    const responseReplacementItems =
      requestedShopId === null
        ? allReplacementItems
        : allReplacementItems.filter(
            (replacement) =>
              replacement.original_shop_id ===
              requestedShopId
          );

    // ===================================================
    // 11. MAP ITEMS AND BILLS TO EACH SHOP
    //
    // Always use allOrderItems here so the shops array
    // continues to contain the full, separated batch.
    // ===================================================

    const shops = orderShops.map((shop) => {
      const shopId = toNumberOrNull(
        shop.shop_id
      );

      const shopItems = allOrderItems.filter(
        (item) =>
          item.shop_id !== null &&
          shopId !== null &&
          item.shop_id === shopId
      );

      const shopReplacements =
        allReplacementItems.filter(
          (replacement) =>
            replacement.original_shop_id === shopId
        );

      // Latest bill for the shop (bills are ordered by id), the
      // same one start-delivery checks
      const shopBill =
        [...billsResult.rows].reverse().find(
          (bill) =>
            toNumberOrNull(bill.shop_id) ===
            shopId
        ) || null;

      let shoppingStatus = 'shopping';

      // order_shop_bills keeps this in shopping_status
      if (
        shopBill &&
        String(
          shopBill.shopping_status ||
          shopBill.status ||
          ''
        ).toLowerCase() === 'completed'
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
            'refunded',
            'completed',
            'done',
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

        shopName:
          shop.shop_name ||
          shop.name ||
          'Shop',

        shop_name:
          shop.shop_name ||
          shop.name ||
          'Shop',

        shopImage,
        shop_image: shopImage,
        image_url: shopImage,

        pickupLatitude: toNumberOrNull(
          shop.shop_latitude
        ),

        pickupLongitude: toNumberOrNull(
          shop.shop_longitude
        ),

        items: shopItems,
        orderItems: shopItems,
        order_items: shopItems,
        shoppingList: shopItems,
        shopping_list: shopItems,

        replacementItems: shopReplacements,
        replacement_items: shopReplacements,

        itemCount: shopItems.length,

        bill: shopBill,

        shoppingStatus,
        shopping_status: shoppingStatus,
      };
    });

    // ===================================================
    // 12. NORMALIZE CUSTOMER INFORMATION
    // ===================================================

    const customerId = toNumberOrNull(
      order.customer_id
    );

    const normalizedShopperId = toNumberOrNull(
      order.shopper_id
    );

    // ===================================================
    // 13. SEND RESPONSE
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

        customerPhone:
          order.customer_phone || null,

        customer_phone:
          order.customer_phone || null,

        phone:
          order.customer_phone || null,

        // Selected-shop filtering applies to these arrays.
        items: responseOrderItems,

        orderItems: responseOrderItems,

        order_items: responseOrderItems,

        shoppingList: responseOrderItems,

        shopping_list: responseOrderItems,

        replacementItems: responseReplacementItems,

        replacement_items: responseReplacementItems,

        // Keep the complete, shop-separated batch data.
        shops,

        shopCount: shops.length,

        selectedShopId: requestedShopId,

        bills: billsResult.rows,
      },
    });
  } catch (error) {
    console.error(
      'getMyOrderById error:',
      error
    );

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

