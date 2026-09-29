// const db = require('../config/db');

// // ==================================================
// // CREATE CUSTOMER ORDER
// // ==================================================

// const createOrder = async (req, res) => {
//   const client = await db.connect();

//   try {
//     const customerId = req.customer.customerId;

//     const {
//       shopId,
//       deliveryAddress,
//       deliveryLatitude,
//       deliveryLongitude,
//       deliveryOption,
//       paymentMethod,
//       itemsTotal,
//       deliveryFee,
//       serviceFee,
//       totalAmount,
//       items,
//     } = req.body;

//     // ==================================================
//     // VALIDATION
//     // ==================================================

//     if (!customerId) {
//       return res.status(401).json({
//         success: false,
//         message: 'Customer authentication is required',
//       });
//     }

//     if (!shopId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Shop ID is required',
//       });
//     }

//     if (!deliveryAddress) {
//       return res.status(400).json({
//         success: false,
//         message: 'Delivery address is required',
//       });
//     }

//     if (
//       deliveryLatitude === undefined ||
//       deliveryLatitude === null ||
//       deliveryLongitude === undefined ||
//       deliveryLongitude === null
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'Delivery latitude and longitude are required',
//       });
//     }

//     if (!Array.isArray(items) || items.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message: 'At least one order item is required',
//       });
//     }

//     // ==================================================
//     // VALIDATE LOCATION
//     // ==================================================

//     const latitude = Number(deliveryLatitude);
//     const longitude = Number(deliveryLongitude);

//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude) ||
//       latitude < -90 ||
//       latitude > 90 ||
//       longitude < -180 ||
//       longitude > 180
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid delivery location',
//       });
//     }

//     // ==================================================
//     // VALIDATE SHOP
//     // ==================================================

//     const shopResult = await client.query(
//       `SELECT
//         id,
//         shop_name,
//         status
//        FROM shops
//        WHERE id = $1
//        LIMIT 1`,
//       [shopId]
//     );

//     if (shopResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shop not found',
//       });
//     }

//     const shop = shopResult.rows[0];

//     if (shop.status !== 'approved') {
//       return res.status(400).json({
//         success: false,
//         message: 'This shop is not currently available',
//       });
//     }

//     // ==================================================
//     // START TRANSACTION
//     // ==================================================

//     await client.query('BEGIN');

//     // ==================================================
//     // CREATE ORDER
//     // ==================================================

//     const orderResult = await client.query(
//       `INSERT INTO orders (
//         customer_id,
//         shop_id,
//         delivery_address,
//         delivery_latitude,
//         delivery_longitude,
//         delivery_option,
//         payment_method,
//         items_total,
//         delivery_fee,
//         service_fee,
//         total_amount,
//         status
//       )
//       VALUES (
//         $1,
//         $2,
//         $3,
//         $4,
//         $5,
//         $6,
//         $7,
//         $8,
//         $9,
//         $10,
//         $11,
//         $12
//       )
//       RETURNING
//         id,
//         customer_id,
//         shop_id,
//         delivery_address,
//         delivery_latitude,
//         delivery_longitude,
//         delivery_option,
//         payment_method,
//         items_total,
//         delivery_fee,
//         service_fee,
//         total_amount,
//         status,
//         created_at`,
//       [
//         customerId,
//         shopId,
//         deliveryAddress,
//         latitude,
//         longitude,
//         deliveryOption || 'fast',
//         paymentMethod || 'cash',
//         Number(itemsTotal) || 0,
//         Number(deliveryFee) || 0,
//         Number(serviceFee) || 0,
//         Number(totalAmount) || 0,
//         'waiting_for_shopper',
//       ]
//     );

//     const order = orderResult.rows[0];

//     // ==================================================
//     // CREATE ORDER ITEMS
//     // ==================================================

//     for (const item of items) {
//       const productId =
//         item.productId !== undefined &&
//         item.productId !== null &&
//         item.productId !== ''
//           ? Number(item.productId)
//           : null;

//       const itemName =
//         item.itemName ||
//         item.name ||
//         'Unknown item';

//       const quantity =
//         Number(item.quantity) || 1;

//       const amount =
//         Number(item.amount) || 1;

//       const unit =
//         item.unit ||
//         item.selectedUnit ||
//         null;

//       const price =
//         Number(item.price) || 0;

//       const custom =
//         item.custom === true;

//       const details =
//         item.details ||
//         null;

//       const image =
//         item.image ||
//         item.imageUrl ||
//         null;

//       // -----------------------------------------------
//       // ITEM VALIDATION
//       // -----------------------------------------------

//       if (quantity <= 0) {
//         throw new Error(
//           `Invalid quantity for item: ${itemName}`
//         );
//       }

//       if (amount <= 0) {
//         throw new Error(
//           `Invalid amount for item: ${itemName}`
//         );
//       }

//       // -----------------------------------------------
//       // INSERT ITEM
//       // -----------------------------------------------

//       await client.query(
//         `INSERT INTO order_items (
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10
//         )`,
//         [
//           order.id,
//           productId,
//           itemName,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//         ]
//       );
//     }

//     // ==================================================
//     // COMMIT
//     // ==================================================

//     await client.query('COMMIT');

//     console.log('====================================');
//     console.log('✅ ORDER CREATED');
//     console.log('ORDER ID:', order.id);
//     console.log('CUSTOMER ID:', customerId);
//     console.log('SHOP ID:', shopId);
//     console.log('ITEM COUNT:', items.length);
//     console.log('====================================');

//     // ==================================================
//     // SUCCESS
//     // ==================================================

//     return res.status(201).json({
//       success: true,
//       message: 'Order created successfully',

//       order: {
//         id: order.id,
//         customerId: order.customer_id,
//         shopId: order.shop_id,

//         shopName: shop.shop_name,

//         deliveryAddress:
//           order.delivery_address,

//         deliveryLatitude:
//           Number(order.delivery_latitude),

//         deliveryLongitude:
//           Number(order.delivery_longitude),

//         deliveryOption:
//           order.delivery_option,

//         paymentMethod:
//           order.payment_method,

//         itemsTotal:
//           Number(order.items_total),

//         deliveryFee:
//           Number(order.delivery_fee),

//         serviceFee:
//           Number(order.service_fee),

//         totalAmount:
//           Number(order.total_amount),

//         status:
//           order.status,

//         createdAt:
//           order.created_at,

//         items,
//       },
//     });

//   } catch (error) {

//     // ==================================================
//     // ROLLBACK
//     // ==================================================

//     try {
//       await client.query('ROLLBACK');
//     } catch (rollbackError) {
//       console.error(
//         '❌ ROLLBACK ERROR:',
//         rollbackError.message
//       );
//     }

//     console.error(
//       '❌ CREATE ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message: 'Failed to create order',
//       error: error.message,
//     });

//   } finally {
//     client.release();
//   }
// };


// // ==================================================
// // GET CUSTOMER ORDERS
// // ==================================================

// const getCustomerOrders = async (req, res) => {
//   try {
//     const customerId =
//       req.customer.customerId;

//     const result = await db.query(
//       `SELECT
//         o.id,
//         o.customer_id,
//         o.shop_id,
//         o.delivery_address,
//         o.delivery_latitude,
//         o.delivery_longitude,
//         o.delivery_option,
//         o.payment_method,
//         o.items_total,
//         o.delivery_fee,
//         o.service_fee,
//         o.total_amount,
//         o.status,
//         o.created_at,
//         o.updated_at,
//         s.shop_name,
//         s.image_url AS shop_image
//        FROM orders o
//        INNER JOIN shops s
//          ON s.id = o.shop_id
//        WHERE o.customer_id = $1
//        ORDER BY o.created_at DESC`,
//       [customerId]
//     );

//     return res.status(200).json({
//       success: true,

//       orders: result.rows.map((order) => ({
//         id: order.id,
//         customerId: order.customer_id,
//         shopId: order.shop_id,

//         shopName: order.shop_name,
//         shopImage: order.shop_image,

//         deliveryAddress:
//           order.delivery_address,

//         deliveryLatitude:
//           Number(order.delivery_latitude),

//         deliveryLongitude:
//           Number(order.delivery_longitude),

//         deliveryOption:
//           order.delivery_option,

//         paymentMethod:
//           order.payment_method,

//         itemsTotal:
//           Number(order.items_total),

//         deliveryFee:
//           Number(order.delivery_fee),

//         serviceFee:
//           Number(order.service_fee),

//         totalAmount:
//           Number(order.total_amount),

//         status:
//           order.status,

//         createdAt:
//           order.created_at,

//         updatedAt:
//           order.updated_at,
//       })),
//     });

//   } catch (error) {

//     console.error(
//       '❌ GET CUSTOMER ORDERS ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message: 'Failed to load orders',
//     });
//   }
// };


// // ==================================================
// // GET SINGLE CUSTOMER ORDER
// // ==================================================

// const getCustomerOrderById = async (req, res) => {
//   try {
//     const customerId =
//       req.customer.customerId;

//     const orderId =
//       Number(req.params.orderId);

//     if (!Number.isInteger(orderId)) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid order ID',
//       });
//     }

//     const orderResult = await db.query(
//       `SELECT
//         o.id,
//         o.customer_id,
//         o.shop_id,
//         o.delivery_address,
//         o.delivery_latitude,
//         o.delivery_longitude,
//         o.delivery_option,
//         o.payment_method,
//         o.items_total,
//         o.delivery_fee,
//         o.service_fee,
//         o.total_amount,
//         o.status,
//         o.created_at,
//         o.updated_at,
//         s.shop_name,
//         s.image_url AS shop_image
//        FROM orders o
//        INNER JOIN shops s
//          ON s.id = o.shop_id
//        WHERE o.id = $1
//          AND o.customer_id = $2
//        LIMIT 1`,
//       [orderId, customerId]
//     );

//     if (orderResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Order not found',
//       });
//     }

//     const order =
//       orderResult.rows[0];

//     const itemsResult = await db.query(
//       `SELECT
//         id,
//         order_id,
//         product_id,
//         item_name,
//         quantity,
//         amount,
//         unit,
//         price,
//         custom,
//         details,
//         image,
//         created_at
//        FROM order_items
//        WHERE order_id = $1
//        ORDER BY id ASC`,
//       [orderId]
//     );

//     return res.status(200).json({
//       success: true,

//       order: {
//         id: order.id,
//         customerId: order.customer_id,
//         shopId: order.shop_id,

//         shopName: order.shop_name,
//         shopImage: order.shop_image,

//         deliveryAddress:
//           order.delivery_address,

//         deliveryLatitude:
//           Number(order.delivery_latitude),

//         deliveryLongitude:
//           Number(order.delivery_longitude),

//         deliveryOption:
//           order.delivery_option,

//         paymentMethod:
//           order.payment_method,

//         itemsTotal:
//           Number(order.items_total),

//         deliveryFee:
//           Number(order.delivery_fee),

//         serviceFee:
//           Number(order.service_fee),

//         totalAmount:
//           Number(order.total_amount),

//         status:
//           order.status,

//         createdAt:
//           order.created_at,

//         updatedAt:
//           order.updated_at,

//         items: itemsResult.rows.map(
//           (item) => ({
//             id: item.id,
//             orderId: item.order_id,
//             productId: item.product_id,

//             itemName:
//               item.item_name,

//             quantity:
//               Number(item.quantity),

//             amount:
//               Number(item.amount),

//             unit:
//               item.unit,

//             price:
//               Number(item.price),

//             custom:
//               item.custom,

//             details:
//               item.details,

//             image:
//               item.image,

//             createdAt:
//               item.created_at,
//           })
//         ),
//       },
//     });

//   } catch (error) {

//     console.error(
//       '❌ GET ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message: 'Failed to load order',
//     });
//   }
// };


// // ==================================================
// // CANCEL CUSTOMER ORDER
// // ==================================================

// const cancelCustomerOrder = async (req, res) => {
//   try {
//     const customerId =
//       req.customer.customerId;

//     const orderId =
//       Number(req.params.orderId);

//     if (!Number.isInteger(orderId)) {
//       return res.status(400).json({
//         success: false,
//         message: 'Invalid order ID',
//       });
//     }

//     const result = await db.query(
//       `UPDATE orders
//        SET
//          status = 'cancelled',
//          updated_at = CURRENT_TIMESTAMP
//        WHERE id = $1
//          AND customer_id = $2
//          AND status = 'waiting_for_shopper'
//        RETURNING
//          id,
//          status,
//          updated_at`,
//       [orderId, customerId]
//     );

//     if (result.rows.length === 0) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Order cannot be cancelled at this stage',
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       message: 'Order cancelled successfully',

//       order: {
//         id: result.rows[0].id,
//         status: result.rows[0].status,
//         updatedAt:
//           result.rows[0].updated_at,
//       },
//     });

//   } catch (error) {

//     console.error(
//       '❌ CANCEL ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message: 'Failed to cancel order',
//     });
//   }
// };


// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = {
//   createOrder,
//   getCustomerOrders,
//   getCustomerOrderById,
//   cancelCustomerOrder,
// };















// const pool = require('../config/db');

// // ==================================================
// // CREATE ORDER
// // ==================================================

// const createOrder = async (req, res) => {
//   const client = await pool.connect();

//   try {
//     const customerId =
//       req.customer.customerId;

//     const {
//       shopId,
//       deliveryAddress,
//       deliveryLatitude,
//       deliveryLongitude,
//       deliveryOption = 'fast',
//       paymentMethod = 'cash',
//       items = [],
//       deliveryFee = 0,
//       serviceFee = 0,
//       itemsTotal = 0,
//       totalAmount = 0,
//     } = req.body;

//     // ==================================================
//     // VALIDATION
//     // ==================================================

//     if (!shopId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Shop ID is required',
//       });
//     }

//     if (!deliveryAddress) {
//       return res.status(400).json({
//         success: false,
//         message: 'Delivery address is required',
//       });
//     }

//     if (
//       deliveryLatitude === undefined ||
//       deliveryLongitude === undefined
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Delivery latitude and longitude are required',
//       });
//     }

//     const latitude =
//       Number(deliveryLatitude);

//     const longitude =
//       Number(deliveryLongitude);

//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude)
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Valid latitude and longitude are required',
//       });
//     }

//     if (
//       latitude < -90 ||
//       latitude > 90 ||
//       longitude < -180 ||
//       longitude > 180
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Latitude or longitude is out of range',
//       });
//     }

//     if (
//       !Array.isArray(items) ||
//       items.length === 0
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'At least one order item is required',
//       });
//     }

//     // ==================================================
//     // CHECK SHOP
//     // ==================================================

//     const shopResult = await client.query(
//       `
//       SELECT
//         id,
//         shop_name,
//         image_url,
//         status
//       FROM shops
//       WHERE id = $1
//       `,
//       [shopId]
//     );

//     if (shopResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shop not found',
//       });
//     }

//     const shop =
//       shopResult.rows[0];

//     if (
//       shop.status !== 'approved'
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'This shop is not available',
//       });
//     }

//     // ==================================================
//     // TOTALS
//     // ==================================================

//     const safeItemsTotal =
//       Number(itemsTotal) || 0;

//     const safeDeliveryFee =
//       Number(deliveryFee) || 0;

//     const safeServiceFee =
//       Number(serviceFee) || 0;

//     const safeTotalAmount =
//       Number(totalAmount) ||
//       (
//         safeItemsTotal +
//         safeDeliveryFee +
//         safeServiceFee
//       );

//     // ==================================================
//     // START TRANSACTION
//     // ==================================================

//     await client.query(
//       'BEGIN'
//     );

//     // ==================================================
//     // CREATE ORDER
//     // ==================================================

//     const orderResult =
//       await client.query(
//         `
//         INSERT INTO orders (
//           customer_id,
//           shop_id,
//           delivery_address,
//           delivery_latitude,
//           delivery_longitude,
//           delivery_option,
//           payment_method,
//           items_total,
//           delivery_fee,
//           service_fee,
//           total_amount,
//           status
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10,
//           $11,
//           $12
//         )
//         RETURNING *
//         `,
//         [
//           customerId,
//           shopId,
//           deliveryAddress,
//           latitude,
//           longitude,
//           deliveryOption,
//           paymentMethod,
//           safeItemsTotal,
//           safeDeliveryFee,
//           safeServiceFee,
//           safeTotalAmount,
//           'waiting_for_shopper',
//         ]
//       );

//     const order =
//       orderResult.rows[0];

//     // ==================================================
//     // CREATE ORDER ITEMS
//     // ==================================================

//     for (
//       const item of items
//     ) {
//       const productId =
//         item.productId ||
//         item.product_id ||
//         null;

//       const itemName =
//         item.itemName ||
//         item.item_name ||
//         item.name ||
//         item.productName ||
//         'Item';

//       const quantity =
//         Number(
//           item.quantity
//         ) || 1;

//       const amount =
//         Number(
//           item.amount
//         ) || 1;

//       const unit =
//         item.unit ||
//         item.selectedUnit ||
//         null;

//       const price =
//         Number(
//           item.price
//         ) || 0;

//       const custom =
//         item.custom === true;

//       const details =
//         item.details ||
//         null;

//       const image =
//         item.image ||
//         item.imageUrl ||
//         null;

//       await client.query(
//         `
//         INSERT INTO order_items (
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10
//         )
//         `,
//         [
//           order.id,
//           productId,
//           itemName,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//         ]
//       );
//     }

//     // ==================================================
//     // COMMIT
//     // ==================================================

//     await client.query(
//       'COMMIT'
//     );

//     // ==================================================
//     // GET CREATED ITEMS
//     // ==================================================

//     const createdItemsResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//           created_at
//         FROM order_items
//         WHERE order_id = $1
//         ORDER BY id ASC
//         `,
//         [order.id]
//       );

//     const createdItems =
//       createdItemsResult.rows;

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ ORDER CREATED'
//     );

//     console.log(
//       'ORDER ID:',
//       order.id
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     console.log(
//       'SHOP ID:',
//       shopId
//     );

//     console.log(
//       'ITEM COUNT:',
//       createdItems.length
//     );

//     console.log(
//       'ITEMS TOTAL:',
//       order.items_total
//     );

//     console.log(
//       'TOTAL AMOUNT:',
//       order.total_amount
//     );

//     console.log(
//       '===================================='
//     );

//     return res.status(201).json({
//       success: true,

//       message:
//         'Order created successfully',

//       order: {
//         ...order,

//         total:
//           Number(
//             order.total_amount
//           ),

//         totalAmount:
//           Number(
//             order.total_amount
//           ),

//         itemsTotal:
//           Number(
//             order.items_total
//           ),

//         deliveryFee:
//           Number(
//             order.delivery_fee
//           ),

//         serviceFee:
//           Number(
//             order.service_fee
//           ),

//         shop: {
//           id: shop.id,
//           name: shop.shop_name,
//           image: shop.image_url,
//         },

//         items:
//           createdItems,
//       },
//     });

//   } catch (error) {

//     try {
//       await client.query(
//         'ROLLBACK'
//       );
//     } catch (rollbackError) {
//       console.error(
//         '❌ Rollback error:',
//         rollbackError.message
//       );
//     }

//     console.error(
//       '❌ CREATE ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Failed to create order',
//       error:
//         error.message,
//     });

//   } finally {

//     client.release();

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDERS
// // ==================================================

// const getCustomerOrders = async (
//   req,
//   res
// ) => {

//   try {

//     const customerId =
//       req.customer.customerId;

//     // ==================================================
//     // GET ORDERS
//     // ==================================================

//     const ordersResult =
//       await pool.query(
//         `
//         SELECT
//           o.id,
//           o.customer_id,
//           o.shop_id,

//           o.delivery_address,
//           o.delivery_latitude,
//           o.delivery_longitude,

//           o.delivery_option,
//           o.payment_method,

//           o.items_total,
//           o.delivery_fee,
//           o.service_fee,
//           o.total_amount,

//           o.status,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image

//         FROM orders o

//         LEFT JOIN shops s
//           ON s.id = o.shop_id

//         WHERE o.customer_id = $1

//         ORDER BY
//           o.created_at DESC
//         `,
//         [customerId]
//       );

//     // ==================================================
//     // GET ITEMS FOR EACH ORDER
//     // ==================================================

//     const formattedOrders =
//       await Promise.all(
//         ordersResult.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT
//                   oi.id,
//                   oi.order_id,

//                   oi.product_id,

//                   oi.item_name,

//                   oi.quantity,
//                   oi.amount,
//                   oi.unit,
//                   oi.price,

//                   oi.custom,
//                   oi.details,
//                   oi.image,

//                   oi.created_at

//                 FROM order_items oi

//                 WHERE oi.order_id = $1

//                 ORDER BY
//                   oi.id ASC
//                 `,
//                 [order.id]
//               );

//             const items =
//               itemsResult.rows;

//             // ==================================================
//             // TOTAL
//             // ==================================================

//             const totalAmount =
//               Number(
//                 order.total_amount
//               ) || 0;

//             const itemsTotal =
//               Number(
//                 order.items_total
//               ) || 0;

//             const deliveryFee =
//               Number(
//                 order.delivery_fee
//               ) || 0;

//             const serviceFee =
//               Number(
//                 order.service_fee
//               ) || 0;

//             // ==================================================
//             // RETURN
//             // ==================================================

//             return {

//               id:
//                 order.id,

//               customer_id:
//                 order.customer_id,

//               shop_id:
//                 order.shop_id,

//               delivery_address:
//                 order.delivery_address,

//               delivery_latitude:
//                 order.delivery_latitude,

//               delivery_longitude:
//                 order.delivery_longitude,

//               delivery_option:
//                 order.delivery_option,

//               payment_method:
//                 order.payment_method,

//               items_total:
//                 itemsTotal,

//               delivery_fee:
//                 deliveryFee,

//               service_fee:
//                 serviceFee,

//               total_amount:
//                 totalAmount,

//               // Frontend friendly fields
//               total:
//                 totalAmount,

//               totalAmount:
//                 totalAmount,

//               itemsTotal:
//                 itemsTotal,

//               deliveryFee:
//                 deliveryFee,

//               serviceFee:
//                 serviceFee,

//               status:
//                 order.status,

//               created_at:
//                 order.created_at,

//               updated_at:
//                 order.updated_at,

//               // Frontend shop object
//               shop: {

//                 id:
//                   order.shop_id,

//                 name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 shop_name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 image:
//                   order.shop_image ||
//                   null,

//                 image_url:
//                   order.shop_image ||
//                   null,

//               },

//               // IMPORTANT
//               // order_items are returned here
//               items:
//                 items,

//             };

//           }
//         )
//       );

//     // ==================================================
//     // DEBUG
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '📦 CUSTOMER ORDERS'
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     formattedOrders.forEach(
//       (order) => {

//         console.log(
//           `ORDER #${order.id}`
//         );

//         console.log(
//           'ITEM COUNT:',
//           order.items.length
//         );

//         console.log(
//           'ITEMS TOTAL:',
//           order.items_total
//         );

//         console.log(
//           'TOTAL:',
//           order.total_amount
//         );

//       }
//     );

//     console.log(
//       '===================================='
//     );

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     return res.status(200).json({

//       success: true,

//       orders:
//         formattedOrders,

//     });

//   } catch (error) {

//     console.error(
//       '❌ GET CUSTOMER ORDERS ERROR:',
//       error
//     );

//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to load customer orders',

//       error:
//         error.message,

//     });

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDER BY ID
// // ==================================================

// const getCustomerOrderById =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {
//         return res.status(400).json({
//           success: false,
//           message:
//             'Invalid order ID',
//         });
//       }

//       // ==================================================
//       // GET ORDER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             o.*,

//             s.shop_name,
//             s.image_url AS shop_image

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {
//         return res.status(404).json({
//           success: false,
//           message:
//             'Order not found',
//         });
//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ITEMS
//       // ==================================================

//       const itemsResult =
//         await pool.query(
//           `
//           SELECT
//             oi.id,
//             oi.order_id,

//             oi.product_id,

//             oi.item_name,

//             oi.quantity,
//             oi.amount,
//             oi.unit,
//             oi.price,

//             oi.custom,
//             oi.details,
//             oi.image,

//             oi.created_at

//           FROM order_items oi

//           WHERE oi.order_id = $1

//           ORDER BY oi.id ASC
//           `,
//           [orderId]
//         );

//       const items =
//         itemsResult.rows;

//       // ==================================================
//       // TOTALS
//       // ==================================================

//       const totalAmount =
//         Number(
//           order.total_amount
//         ) || 0;

//       const itemsTotal =
//         Number(
//           order.items_total
//         ) || 0;

//       const deliveryFee =
//         Number(
//           order.delivery_fee
//         ) || 0;

//       const serviceFee =
//         Number(
//           order.service_fee
//         ) || 0;

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         order: {

//           ...order,

//           items_total:
//             itemsTotal,

//           delivery_fee:
//             deliveryFee,

//           service_fee:
//             serviceFee,

//           total_amount:
//             totalAmount,

//           total:
//             totalAmount,

//           totalAmount:
//             totalAmount,

//           itemsTotal:
//             itemsTotal,

//           deliveryFee:
//             deliveryFee,

//           serviceFee:
//             serviceFee,

//           shop: {

//             id:
//               order.shop_id,

//             name:
//               order.shop_name ||
//               'Selected Shop',

//             shop_name:
//               order.shop_name ||
//               'Selected Shop',

//             image:
//               order.shop_image ||
//               null,

//             image_url:
//               order.shop_image ||
//               null,

//           },

//           items:
//             items,

//         },

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET CUSTOMER ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // CANCEL CUSTOMER ORDER
// // ==================================================

// const cancelCustomerOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {
//         return res.status(400).json({
//           success: false,
//           message:
//             'Invalid order ID',
//         });
//       }

//       // ==================================================
//       // CHECK ORDER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             id,
//             status
//           FROM orders
//           WHERE
//             id = $1
//             AND customer_id = $2
//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {
//         return res.status(404).json({
//           success: false,
//           message:
//             'Order not found',
//         });
//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // ONLY WAITING ORDERS CAN CANCEL
//       // ==================================================

//       if (
//         order.status !==
//         'waiting_for_shopper'
//       ) {
//         return res.status(400).json({

//           success: false,

//           message:
//             'This order cannot be cancelled now',

//         });
//       }

//       // ==================================================
//       // UPDATE
//       // ==================================================

//       const updateResult =
//         await pool.query(
//           `
//           UPDATE orders

//           SET
//             status = 'cancelled',
//             updated_at = CURRENT_TIMESTAMP

//           WHERE
//             id = $1
//             AND customer_id = $2

//           RETURNING *
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       return res.status(200).json({

//         success: true,

//         message:
//           'Order cancelled successfully',

//         order:
//           updateResult.rows[0],

//       });

//     } catch (error) {

//       console.error(
//         '❌ CANCEL ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to cancel order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = {

//   createOrder,

//   getCustomerOrders,

//   getCustomerOrderById,

//   cancelCustomerOrder,

// };























// const pool = require('../config/db');

// // ==================================================
// // CREATE ORDER
// // ==================================================

// const createOrder = async (req, res) => {
//   const client = await pool.connect();

//   try {
//     const customerId =
//       req.customer.customerId;

//     const {
//       shopId,
//       deliveryAddress,
//       deliveryLatitude,
//       deliveryLongitude,
//       deliveryOption = 'fast',
//       paymentMethod = 'cash',
//       items = [],
//       deliveryFee = 0,
//       serviceFee = 0,
//       itemsTotal = 0,
//       totalAmount = 0,
//     } = req.body;

//     // ==================================================
//     // VALIDATION
//     // ==================================================

//     if (!shopId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Shop ID is required',
//       });
//     }

//     if (!deliveryAddress) {
//       return res.status(400).json({
//         success: false,
//         message: 'Delivery address is required',
//       });
//     }

//     if (
//       deliveryLatitude === undefined ||
//       deliveryLongitude === undefined
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Delivery latitude and longitude are required',
//       });
//     }

//     const latitude =
//       Number(deliveryLatitude);

//     const longitude =
//       Number(deliveryLongitude);

//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude)
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Valid latitude and longitude are required',
//       });
//     }

//     if (
//       latitude < -90 ||
//       latitude > 90 ||
//       longitude < -180 ||
//       longitude > 180
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Latitude or longitude is out of range',
//       });
//     }

//     if (
//       !Array.isArray(items) ||
//       items.length === 0
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'At least one order item is required',
//       });
//     }

//     // ==================================================
//     // CHECK SHOP
//     // ==================================================

//     const shopResult = await client.query(
//       `
//       SELECT
//         id,
//         shop_name,
//         image_url,
//         status,
//         latitude,
//         longitude
//       FROM shops
//       WHERE id = $1
//       `,
//       [shopId]
//     );

//     if (shopResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shop not found',
//       });
//     }

//     const shop =
//       shopResult.rows[0];

//     if (
//       shop.status !== 'approved'
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'This shop is not available',
//       });
//     }

//     // ==================================================
//     // TOTALS
//     // ==================================================

//     const safeItemsTotal =
//       Number(itemsTotal) || 0;

//     const safeDeliveryFee =
//       Number(deliveryFee) || 0;

//     const safeServiceFee =
//       Number(serviceFee) || 0;

//     const safeTotalAmount =
//       Number(totalAmount) ||
//       (
//         safeItemsTotal +
//         safeDeliveryFee +
//         safeServiceFee
//       );

//     // ==================================================
//     // START TRANSACTION
//     // ==================================================

//     await client.query(
//       'BEGIN'
//     );

//     // ==================================================
//     // CREATE ORDER
//     // ==================================================

//     const orderResult =
//       await client.query(
//         `
//         INSERT INTO orders (
//           customer_id,
//           shop_id,
//           delivery_address,
//           delivery_latitude,
//           delivery_longitude,
//           delivery_option,
//           payment_method,
//           items_total,
//           delivery_fee,
//           service_fee,
//           total_amount,
//           status
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10,
//           $11,
//           $12
//         )
//         RETURNING *
//         `,
//         [
//           customerId,
//           shopId,
//           deliveryAddress,
//           latitude,
//           longitude,
//           deliveryOption,
//           paymentMethod,
//           safeItemsTotal,
//           safeDeliveryFee,
//           safeServiceFee,
//           safeTotalAmount,
//           'waiting_for_shopper',
//         ]
//       );

//     const order =
//       orderResult.rows[0];

//     // ==================================================
//     // CREATE ORDER ITEMS
//     // ==================================================

//     for (
//       const item of items
//     ) {
//       const productId =
//         item.productId ||
//         item.product_id ||
//         null;

//       const itemName =
//         item.itemName ||
//         item.item_name ||
//         item.name ||
//         item.productName ||
//         'Item';

//       const quantity =
//         Number(
//           item.quantity
//         ) || 1;

//       const amount =
//         Number(
//           item.amount
//         ) || 1;

//       const unit =
//         item.unit ||
//         item.selectedUnit ||
//         null;

//       const price =
//         Number(
//           item.price
//         ) || 0;

//       const custom =
//         item.custom === true;

//       const details =
//         item.details ||
//         null;

//       const image =
//         item.image ||
//         item.imageUrl ||
//         null;

//       await client.query(
//         `
//         INSERT INTO order_items (
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10
//         )
//         `,
//         [
//           order.id,
//           productId,
//           itemName,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//         ]
//       );
//     }

//     // ==================================================
//     // COMMIT
//     // ==================================================

//     await client.query(
//       'COMMIT'
//     );

//     // ==================================================
//     // GET CREATED ITEMS
//     // ==================================================

//     const createdItemsResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//           created_at
//         FROM order_items
//         WHERE order_id = $1
//         ORDER BY id ASC
//         `,
//         [order.id]
//       );

//     const createdItems =
//       createdItemsResult.rows;

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ ORDER CREATED'
//     );

//     console.log(
//       'ORDER ID:',
//       order.id
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     console.log(
//       'SHOP ID:',
//       shopId
//     );

//     console.log(
//       'ITEM COUNT:',
//       createdItems.length
//     );

//     console.log(
//       'ITEMS TOTAL:',
//       order.items_total
//     );

//     console.log(
//       'TOTAL AMOUNT:',
//       order.total_amount
//     );

//     console.log(
//       '===================================='
//     );

//     return res.status(201).json({
//       success: true,

//       message:
//         'Order created successfully',

//       order: {
//         ...order,

//         total:
//           Number(
//             order.total_amount
//           ),

//         totalAmount:
//           Number(
//             order.total_amount
//           ),

//         itemsTotal:
//           Number(
//             order.items_total
//           ),

//         deliveryFee:
//           Number(
//             order.delivery_fee
//           ),

//         serviceFee:
//           Number(
//             order.service_fee
//           ),

//         shop: {
//           id: shop.id,
//           name: shop.shop_name,
//           image: shop.image_url,

//           latitude:
//             Number(shop.latitude),

//           longitude:
//             Number(shop.longitude),
//         },

//         items:
//           createdItems,
//       },
//     });

//   } catch (error) {

//     try {
//       await client.query(
//         'ROLLBACK'
//       );
//     } catch (rollbackError) {
//       console.error(
//         '❌ Rollback error:',
//         rollbackError.message
//       );
//     }

//     console.error(
//       '❌ CREATE ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Failed to create order',
//       error:
//         error.message,
//     });

//   } finally {

//     client.release();

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDERS
// // ==================================================

// const getCustomerOrders = async (
//   req,
//   res
// ) => {

//   try {

//     const customerId =
//       req.customer.customerId;

//     // ==================================================
//     // GET ORDERS
//     // ==================================================

//     const ordersResult =
//       await pool.query(
//         `
//         SELECT
//           o.id,
//           o.customer_id,
//           o.shop_id,

//           o.delivery_address,
//           o.delivery_latitude,
//           o.delivery_longitude,

//           o.delivery_option,
//           o.payment_method,

//           o.items_total,
//           o.delivery_fee,
//           o.service_fee,
//           o.total_amount,

//           o.status,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         LEFT JOIN shops s
//           ON s.id = o.shop_id

//         WHERE o.customer_id = $1

//         ORDER BY
//           o.created_at DESC
//         `,
//         [customerId]
//       );

//     // ==================================================
//     // GET ITEMS FOR EACH ORDER
//     // ==================================================

//     const formattedOrders =
//       await Promise.all(
//         ordersResult.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT
//                   oi.id,
//                   oi.order_id,

//                   oi.product_id,

//                   oi.item_name,

//                   oi.quantity,
//                   oi.amount,
//                   oi.unit,
//                   oi.price,

//                   oi.custom,
//                   oi.details,
//                   oi.image,

//                   oi.created_at

//                 FROM order_items oi

//                 WHERE oi.order_id = $1

//                 ORDER BY
//                   oi.id ASC
//                 `,
//                 [order.id]
//               );

//             const items =
//               itemsResult.rows;

//             // ==================================================
//             // TOTAL
//             // ==================================================

//             const totalAmount =
//               Number(
//                 order.total_amount
//               ) || 0;

//             const itemsTotal =
//               Number(
//                 order.items_total
//               ) || 0;

//             const deliveryFee =
//               Number(
//                 order.delivery_fee
//               ) || 0;

//             const serviceFee =
//               Number(
//                 order.service_fee
//               ) || 0;

//             // ==================================================
//             // RETURN
//             // ==================================================

//             return {

//               id:
//                 order.id,

//               customer_id:
//                 order.customer_id,

//               shop_id:
//                 order.shop_id,

//               delivery_address:
//                 order.delivery_address,

//               delivery_latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               delivery_longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),

//               delivery_option:
//                 order.delivery_option,

//               payment_method:
//                 order.payment_method,

//               items_total:
//                 itemsTotal,

//               delivery_fee:
//                 deliveryFee,

//               service_fee:
//                 serviceFee,

//               total_amount:
//                 totalAmount,

//               // Frontend friendly fields

//               total:
//                 totalAmount,

//               totalAmount:
//                 totalAmount,

//               itemsTotal:
//                 itemsTotal,

//               deliveryFee:
//                 deliveryFee,

//               serviceFee:
//                 serviceFee,

//               status:
//                 order.status,

//               created_at:
//                 order.created_at,

//               updated_at:
//                 order.updated_at,

//               // ==================================================
//               // SHOP
//               // ==================================================

//               shop: {

//                 id:
//                   order.shop_id,

//                 name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 shop_name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 image:
//                   order.shop_image ||
//                   null,

//                 image_url:
//                   order.shop_image ||
//                   null,

//                 latitude:
//                   Number(
//                     order.shop_latitude
//                   ),

//                 longitude:
//                   Number(
//                     order.shop_longitude
//                   ),

//               },

//               // ==================================================
//               // ITEMS
//               // ==================================================

//               items:
//                 items,

//             };

//           }
//         )
//       );

//     // ==================================================
//     // DEBUG
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '📦 CUSTOMER ORDERS'
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     formattedOrders.forEach(
//       (order) => {

//         console.log(
//           `ORDER #${order.id}`
//         );

//         console.log(
//           'ITEM COUNT:',
//           order.items.length
//         );

//         console.log(
//           'ITEMS TOTAL:',
//           order.items_total
//         );

//         console.log(
//           'TOTAL:',
//           order.total_amount
//         );

//       }
//     );

//     console.log(
//       '===================================='
//     );

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     return res.status(200).json({

//       success: true,

//       orders:
//         formattedOrders,

//     });

//   } catch (error) {

//     console.error(
//       '❌ GET CUSTOMER ORDERS ERROR:',
//       error
//     );

//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to load customer orders',

//       error:
//         error.message,

//     });

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDER BY ID
// // ==================================================

// const getCustomerOrderById =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // GET ORDER + SHOP
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             o.*,

//             s.shop_name,
//             s.image_url AS shop_image,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ITEMS
//       // ==================================================

//       const itemsResult =
//         await pool.query(
//           `
//           SELECT
//             oi.id,
//             oi.order_id,

//             oi.product_id,

//             oi.item_name,

//             oi.quantity,
//             oi.amount,
//             oi.unit,
//             oi.price,

//             oi.custom,
//             oi.details,
//             oi.image,

//             oi.created_at

//           FROM order_items oi

//           WHERE oi.order_id = $1

//           ORDER BY oi.id ASC
//           `,
//           [orderId]
//         );

//       const items =
//         itemsResult.rows;

//       // ==================================================
//       // TOTALS
//       // ==================================================

//       const totalAmount =
//         Number(
//           order.total_amount
//         ) || 0;

//       const itemsTotal =
//         Number(
//           order.items_total
//         ) || 0;

//       const deliveryFee =
//         Number(
//           order.delivery_fee
//         ) || 0;

//       const serviceFee =
//         Number(
//           order.service_fee
//         ) || 0;

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         order: {

//           ...order,

//           delivery_latitude:
//             Number(
//               order.delivery_latitude
//             ),

//           delivery_longitude:
//             Number(
//               order.delivery_longitude
//             ),

//           items_total:
//             itemsTotal,

//           delivery_fee:
//             deliveryFee,

//           service_fee:
//             serviceFee,

//           total_amount:
//             totalAmount,

//           total:
//             totalAmount,

//           totalAmount:
//             totalAmount,

//           itemsTotal:
//             itemsTotal,

//           deliveryFee:
//             deliveryFee,

//           serviceFee:
//             serviceFee,

//           // ==================================================
//           // SHOP
//           // ==================================================

//           shop: {

//             id:
//               order.shop_id,

//             name:
//               order.shop_name ||
//               'Selected Shop',

//             shop_name:
//               order.shop_name ||
//               'Selected Shop',

//             image:
//               order.shop_image ||
//               null,

//             image_url:
//               order.shop_image ||
//               null,

//             latitude:
//               Number(
//                 order.shop_latitude
//               ),

//             longitude:
//               Number(
//                 order.shop_longitude
//               ),

//           },

//           items:
//             items,

//         },

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET CUSTOMER ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // GET NEARBY ONLINE SHOPPERS FOR ORDER
// // ==================================================

// const getNearbyShoppersForOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );


//       // ==================================================
//       // VALIDATE ORDER ID
//       // ==================================================

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }


//       // ==================================================
//       // GET ORDER + SHOP LOCATION
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,
//             o.status,

//             s.shop_name,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );


//       // ==================================================
//       // ORDER NOT FOUND
//       // ==================================================

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }


//       const order =
//         orderResult.rows[0];


//       // ==================================================
//       // CHECK SHOP LOCATION
//       // ==================================================

//       const shopLatitude =
//         Number(
//           order.shop_latitude
//         );

//       const shopLongitude =
//         Number(
//           order.shop_longitude
//         );


//       if (
//         !Number.isFinite(
//           shopLatitude
//         ) ||
//         !Number.isFinite(
//           shopLongitude
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Shop location is not available',

//         });

//       }


//       // ==================================================
//       // GET ONLINE SHOPPERS
//       // ==================================================

//       /*
//        * Find real shoppers who are:
//        *
//        * 1. ONLINE
//        * 2. Have valid location
//        * 3. Within 10 KM of selected shop
//        *
//        * The closest shopper is returned first.
//        */

//       const shoppersResult =
//         await pool.query(
//           `
//           SELECT

//             sh.id,

//             sh.full_name,

//             sh.mobile,

//             sh.status,

//             sh.latitude,

//             sh.longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,
//                     cos(
//                       radians($1)
//                     ) *
//                     cos(
//                       radians(sh.latitude)
//                     ) *
//                     cos(
//                       radians(sh.longitude) -
//                       radians($2)
//                     ) +
//                     sin(
//                       radians($1)
//                     ) *
//                     sin(
//                       radians(sh.latitude)
//                     )
//                   )
//                 )
//               )
//             ) AS distance_km

//           FROM shoppers sh

//           WHERE
//             sh.status = 'online'

//             AND sh.latitude IS NOT NULL

//             AND sh.longitude IS NOT NULL

//             AND sh.latitude BETWEEN -90 AND 90

//             AND sh.longitude BETWEEN -180 AND 180

//           ORDER BY
//             distance_km ASC

//           `,
//           [
//             shopLatitude,
//             shopLongitude,
//           ]
//         );


//       // ==================================================
//       // ONLY 10 KM
//       // ==================================================

//       const shoppers =
//         shoppersResult.rows

//           .filter(
//             (shopper) => {

//               const distance =
//                 Number(
//                   shopper.distance_km
//                 );

//               return (
//                 Number.isFinite(distance) &&
//                 distance <= 10
//               );

//             }
//           )

//           .map(
//             (shopper) => ({

//               id:
//                 shopper.id,

//               name:
//                 shopper.full_name,

//               full_name:
//                 shopper.full_name,

//               mobile:
//                 shopper.mobile,

//               status:
//                 shopper.status,

//               latitude:
//                 Number(
//                   shopper.latitude
//                 ),

//               longitude:
//                 Number(
//                   shopper.longitude
//                 ),

//               distance_km:
//                 Number(
//                   shopper.distance_km
//                 ),

//             })
//           );


//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '📍 NEARBY ONLINE SHOPPERS'
//       );

//       console.log(
//         'ORDER ID:',
//         orderId
//       );

//       console.log(
//         'SHOP ID:',
//         order.shop_id
//       );

//       console.log(
//         'SHOP:',
//         order.shop_name
//       );

//       console.log(
//         'SHOP LOCATION:',
//         shopLatitude,
//         shopLongitude
//       );

//       console.log(
//         'ONLINE SHOPPERS:',
//         shoppers.length
//       );


//       shoppers.forEach(
//         (shopper) => {

//           console.log(
//             '--------------------------------'
//           );

//           console.log(
//             'SHOPPER ID:',
//             shopper.id
//           );

//           console.log(
//             'SHOPPER NAME:',
//             shopper.name
//           );

//           console.log(
//             'STATUS:',
//             shopper.status
//           );

//           console.log(
//             'LOCATION:',
//             shopper.latitude,
//             shopper.longitude
//           );

//           console.log(
//             'DISTANCE:',
//             shopper.distance_km,
//             'KM'
//           );

//         }
//       );


//       console.log(
//         '===================================='
//       );


//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         orderId:
//           order.id,

//         orderStatus:
//           order.status,

//         shop: {

//           id:
//             order.shop_id,

//           name:
//             order.shop_name ||
//             'Selected Shop',

//           latitude:
//             shopLatitude,

//           longitude:
//             shopLongitude,

//         },

//         shoppers:
//           shoppers,

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET NEARBY SHOPPERS ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load nearby shoppers',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // CANCEL CUSTOMER ORDER
// // ==================================================

// const cancelCustomerOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // CHECK ORDER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             id,
//             status
//           FROM orders
//           WHERE
//             id = $1
//             AND customer_id = $2
//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // ONLY WAITING ORDERS CAN CANCEL
//       // ==================================================

//       if (
//         order.status !==
//         'waiting_for_shopper'
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'This order cannot be cancelled now',

//         });

//       }

//       // ==================================================
//       // UPDATE
//       // ==================================================

//       const updateResult =
//         await pool.query(
//           `
//           UPDATE orders

//           SET
//             status = 'cancelled',
//             updated_at = CURRENT_TIMESTAMP

//           WHERE
//             id = $1
//             AND customer_id = $2

//           RETURNING *
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       return res.status(200).json({

//         success: true,

//         message:
//           'Order cancelled successfully',

//         order:
//           updateResult.rows[0],

//       });

//     } catch (error) {

//       console.error(
//         '❌ CANCEL ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to cancel order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = {

//   createOrder,

//   getCustomerOrders,

//   getCustomerOrderById,

//   getNearbyShoppersForOrder,

//   cancelCustomerOrder,

// };










// const pool = require('../config/db');

// // ==================================================
// // CREATE ORDER
// // ==================================================

// const createOrder = async (req, res) => {
//   const client = await pool.connect();

//   try {
//     const customerId =
//       req.customer.customerId;

//     const {
//       shopId,
//       deliveryAddress,
//       deliveryLatitude,
//       deliveryLongitude,
//       deliveryOption = 'fast',
//       paymentMethod = 'cash',
//       items = [],
//       deliveryFee = 0,
//       serviceFee = 0,
//       itemsTotal = 0,
//       totalAmount = 0,
//     } = req.body;

//     // ==================================================
//     // VALIDATION
//     // ==================================================

//     if (!shopId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Shop ID is required',
//       });
//     }

//     if (!deliveryAddress) {
//       return res.status(400).json({
//         success: false,
//         message: 'Delivery address is required',
//       });
//     }

//     if (
//       deliveryLatitude === undefined ||
//       deliveryLongitude === undefined
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Delivery latitude and longitude are required',
//       });
//     }

//     const latitude =
//       Number(deliveryLatitude);

//     const longitude =
//       Number(deliveryLongitude);

//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude)
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Valid latitude and longitude are required',
//       });
//     }

//     if (
//       latitude < -90 ||
//       latitude > 90 ||
//       longitude < -180 ||
//       longitude > 180
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Latitude or longitude is out of range',
//       });
//     }

//     if (
//       !Array.isArray(items) ||
//       items.length === 0
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'At least one order item is required',
//       });
//     }

//     // ==================================================
//     // CHECK SHOP
//     // ==================================================

//     const shopResult = await client.query(
//       `
//       SELECT
//         id,
//         shop_name,
//         image_url,
//         status,
//         latitude,
//         longitude
//       FROM shops
//       WHERE id = $1
//       `,
//       [shopId]
//     );

//     if (shopResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shop not found',
//       });
//     }

//     const shop =
//       shopResult.rows[0];

//     if (
//       shop.status !== 'approved'
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'This shop is not available',
//       });
//     }

//     // ==================================================
//     // TOTALS
//     // ==================================================

//     const safeItemsTotal =
//       Number(itemsTotal) || 0;

//     const safeDeliveryFee =
//       Number(deliveryFee) || 0;

//     const safeServiceFee =
//       Number(serviceFee) || 0;

//     const safeTotalAmount =
//       Number(totalAmount) ||
//       (
//         safeItemsTotal +
//         safeDeliveryFee +
//         safeServiceFee
//       );

//     // ==================================================
//     // START TRANSACTION
//     // ==================================================

//     await client.query(
//       'BEGIN'
//     );

//     // ==================================================
//     // CREATE ORDER
//     // ==================================================

//     const orderResult =
//       await client.query(
//         `
//         INSERT INTO orders (
//           customer_id,
//           shop_id,
//           delivery_address,
//           delivery_latitude,
//           delivery_longitude,
//           delivery_option,
//           payment_method,
//           items_total,
//           delivery_fee,
//           service_fee,
//           total_amount,
//           status
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10,
//           $11,
//           $12
//         )
//         RETURNING *
//         `,
//         [
//           customerId,
//           shopId,
//           deliveryAddress,
//           latitude,
//           longitude,
//           deliveryOption,
//           paymentMethod,
//           safeItemsTotal,
//           safeDeliveryFee,
//           safeServiceFee,
//           safeTotalAmount,
//           'waiting_for_shopper',
//         ]
//       );

//     const order =
//       orderResult.rows[0];

//     // ==================================================
//     // CREATE ORDER ITEMS
//     // ==================================================

//     for (
//       const item of items
//     ) {
//       const productId =
//         item.productId ||
//         item.product_id ||
//         null;

//       const itemName =
//         item.itemName ||
//         item.item_name ||
//         item.name ||
//         item.productName ||
//         'Item';

//       const quantity =
//         Number(
//           item.quantity
//         ) || 1;

//       const amount =
//         Number(
//           item.amount
//         ) || 1;

//       const unit =
//         item.unit ||
//         item.selectedUnit ||
//         null;

//       const price =
//         Number(
//           item.price
//         ) || 0;

//       const custom =
//         item.custom === true;

//       const details =
//         item.details ||
//         null;

//       const image =
//         item.image ||
//         item.imageUrl ||
//         null;

//       await client.query(
//         `
//         INSERT INTO order_items (
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10
//         )
//         `,
//         [
//           order.id,
//           productId,
//           itemName,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//         ]
//       );
//     }

//     // ==================================================
//     // COMMIT
//     // ==================================================

//     await client.query(
//       'COMMIT'
//     );

//     // ==================================================
//     // GET CREATED ITEMS
//     // ==================================================

//     const createdItemsResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//           created_at
//         FROM order_items
//         WHERE order_id = $1
//         ORDER BY id ASC
//         `,
//         [order.id]
//       );

//     const createdItems =
//       createdItemsResult.rows;

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ ORDER CREATED'
//     );

//     console.log(
//       'ORDER ID:',
//       order.id
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     console.log(
//       'SHOP ID:',
//       shopId
//     );

//     console.log(
//       'ITEM COUNT:',
//       createdItems.length
//     );

//     console.log(
//       'ITEMS TOTAL:',
//       order.items_total
//     );

//     console.log(
//       'TOTAL AMOUNT:',
//       order.total_amount
//     );

//     console.log(
//       '===================================='
//     );

//     return res.status(201).json({
//       success: true,

//       message:
//         'Order created successfully',

//       order: {
//         ...order,

//         total:
//           Number(
//             order.total_amount
//           ),

//         totalAmount:
//           Number(
//             order.total_amount
//           ),

//         itemsTotal:
//           Number(
//             order.items_total
//           ),

//         deliveryFee:
//           Number(
//             order.delivery_fee
//           ),

//         serviceFee:
//           Number(
//             order.service_fee
//           ),

//         shop: {
//           id: shop.id,
//           name: shop.shop_name,
//           image: shop.image_url,

//           latitude:
//             Number(shop.latitude),

//           longitude:
//             Number(shop.longitude),
//         },

//         items:
//           createdItems,
//       },
//     });

//   } catch (error) {

//     try {
//       await client.query(
//         'ROLLBACK'
//       );
//     } catch (rollbackError) {
//       console.error(
//         '❌ Rollback error:',
//         rollbackError.message
//       );
//     }

//     console.error(
//       '❌ CREATE ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Failed to create order',
//       error:
//         error.message,
//     });

//   } finally {

//     client.release();

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDERS
// // ==================================================

// const getCustomerOrders = async (
//   req,
//   res
// ) => {

//   try {

//     const customerId =
//       req.customer.customerId;

//     // ==================================================
//     // GET ORDERS
//     // ==================================================

//     const ordersResult =
//       await pool.query(
//         `
//         SELECT
//           o.id,
//           o.customer_id,
//           o.shop_id,
//           o.shopper_id,

//           o.delivery_address,
//           o.delivery_latitude,
//           o.delivery_longitude,

//           o.delivery_option,
//           o.payment_method,

//           o.items_total,
//           o.delivery_fee,
//           o.service_fee,
//           o.total_amount,

//           o.status,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude,

//           sh.id AS shopper_id_joined,
//           sh.full_name AS shopper_name,
//           sh.mobile AS shopper_mobile,
//           sh.status AS shopper_status,
//           sh.latitude AS shopper_latitude,
//           sh.longitude AS shopper_longitude

//         FROM orders o

//         LEFT JOIN shops s
//           ON s.id = o.shop_id

//         LEFT JOIN shoppers sh
//           ON sh.id = o.shopper_id

//         WHERE o.customer_id = $1

//         ORDER BY
//           o.created_at DESC
//         `,
//         [customerId]
//       );

//     // ==================================================
//     // GET ITEMS FOR EACH ORDER
//     // ==================================================

//     const formattedOrders =
//       await Promise.all(
//         ordersResult.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT
//                   oi.id,
//                   oi.order_id,

//                   oi.product_id,

//                   oi.item_name,

//                   oi.quantity,
//                   oi.amount,
//                   oi.unit,
//                   oi.price,

//                   oi.custom,
//                   oi.details,
//                   oi.image,

//                   oi.created_at

//                 FROM order_items oi

//                 WHERE oi.order_id = $1

//                 ORDER BY
//                   oi.id ASC
//                 `,
//                 [order.id]
//               );

//             const items =
//               itemsResult.rows;

//             // ==================================================
//             // TOTAL
//             // ==================================================

//             const totalAmount =
//               Number(
//                 order.total_amount
//               ) || 0;

//             const itemsTotal =
//               Number(
//                 order.items_total
//               ) || 0;

//             const deliveryFee =
//               Number(
//                 order.delivery_fee
//               ) || 0;

//             const serviceFee =
//               Number(
//                 order.service_fee
//               ) || 0;

//             // ==================================================
//             // SHOPPER
//             // ==================================================

//             const shopper =
//               order.shopper_id
//                 ? {
//                     id:
//                       Number(
//                         order.shopper_id
//                       ),

//                     name:
//                       order.shopper_name ||
//                       'Shopper',

//                     full_name:
//                       order.shopper_name ||
//                       'Shopper',

//                     mobile:
//                       order.shopper_mobile ||
//                       null,

//                     status:
//                       order.shopper_status ||
//                       null,

//                     latitude:
//                       Number(
//                         order.shopper_latitude
//                       ),

//                     longitude:
//                       Number(
//                         order.shopper_longitude
//                       ),
//                   }
//                 : null;

//             // ==================================================
//             // RETURN
//             // ==================================================

//             return {

//               id:
//                 order.id,

//               customer_id:
//                 order.customer_id,

//               shop_id:
//                 order.shop_id,

//               shopper_id:
//                 order.shopper_id
//                   ? Number(order.shopper_id)
//                   : null,

//               delivery_address:
//                 order.delivery_address,

//               delivery_latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               delivery_longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),

//               delivery_option:
//                 order.delivery_option,

//               payment_method:
//                 order.payment_method,

//               items_total:
//                 itemsTotal,

//               delivery_fee:
//                 deliveryFee,

//               service_fee:
//                 serviceFee,

//               total_amount:
//                 totalAmount,

//               // Frontend friendly fields

//               total:
//                 totalAmount,

//               totalAmount:
//                 totalAmount,

//               itemsTotal:
//                 itemsTotal,

//               deliveryFee:
//                 deliveryFee,

//               serviceFee:
//                 serviceFee,

//               status:
//                 order.status,

//               created_at:
//                 order.created_at,

//               updated_at:
//                 order.updated_at,

//               // ==================================================
//               // SHOP
//               // ==================================================

//               shop: {

//                 id:
//                   order.shop_id,

//                 name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 shop_name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 image:
//                   order.shop_image ||
//                   null,

//                 image_url:
//                   order.shop_image ||
//                   null,

//                 latitude:
//                   Number(
//                     order.shop_latitude
//                   ),

//                 longitude:
//                   Number(
//                     order.shop_longitude
//                   ),

//               },

//               // ==================================================
//               // SHOPPER
//               // ==================================================

//               shopper:
//                 shopper,

//               assignedShopper:
//                 shopper,

//               assigned_shopper:
//                 shopper,

//               // ==================================================
//               // ITEMS
//               // ==================================================

//               items:
//                 items,

//             };

//           }
//         )
//       );

//     // ==================================================
//     // DEBUG
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '📦 CUSTOMER ORDERS'
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     formattedOrders.forEach(
//       (order) => {

//         console.log(
//           `ORDER #${order.id}`
//         );

//         console.log(
//           'ITEM COUNT:',
//           order.items.length
//         );

//         console.log(
//           'ITEMS TOTAL:',
//           order.items_total
//         );

//         console.log(
//           'TOTAL:',
//           order.total_amount
//         );

//         console.log(
//           'SHOPPER ID:',
//           order.shopper_id
//         );

//         console.log(
//           'SHOPPER:',
//           order.shopper?.name || 'Not assigned'
//         );

//       }
//     );

//     console.log(
//       '===================================='
//     );

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     return res.status(200).json({

//       success: true,

//       orders:
//         formattedOrders,

//     });

//   } catch (error) {

//     console.error(
//       '❌ GET CUSTOMER ORDERS ERROR:',
//       error
//     );

//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to load customer orders',

//       error:
//         error.message,

//     });

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDER BY ID
// // ==================================================

// const getCustomerOrderById =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // GET ORDER + SHOP + SHOPPER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             o.*,

//             s.shop_name,
//             s.image_url AS shop_image,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             sh.id AS shopper_id_joined,
//             sh.full_name AS shopper_name,
//             sh.mobile AS shopper_mobile,
//             sh.status AS shopper_status,
//             sh.latitude AS shopper_latitude,
//             sh.longitude AS shopper_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           LEFT JOIN shoppers sh
//             ON sh.id = o.shopper_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ITEMS
//       // ==================================================

//       const itemsResult =
//         await pool.query(
//           `
//           SELECT
//             oi.id,
//             oi.order_id,

//             oi.product_id,

//             oi.item_name,

//             oi.quantity,
//             oi.amount,
//             oi.unit,
//             oi.price,

//             oi.custom,
//             oi.details,
//             oi.image,

//             oi.created_at

//           FROM order_items oi

//           WHERE oi.order_id = $1

//           ORDER BY oi.id ASC
//           `,
//           [orderId]
//         );

//       const items =
//         itemsResult.rows;

//       // ==================================================
//       // TOTALS
//       // ==================================================

//       const totalAmount =
//         Number(
//           order.total_amount
//         ) || 0;

//       const itemsTotal =
//         Number(
//           order.items_total
//         ) || 0;

//       const deliveryFee =
//         Number(
//           order.delivery_fee
//         ) || 0;

//       const serviceFee =
//         Number(
//           order.service_fee
//         ) || 0;

//       // ==================================================
//       // SHOPPER
//       // ==================================================

//       const shopper =
//         order.shopper_id
//           ? {
//               id:
//                 Number(
//                   order.shopper_id
//                 ),

//               name:
//                 order.shopper_name ||
//                 'Shopper',

//               full_name:
//                 order.shopper_name ||
//                 'Shopper',

//               mobile:
//                 order.shopper_mobile ||
//                 null,

//               status:
//                 order.shopper_status ||
//                 null,

//               latitude:
//                 Number(
//                   order.shopper_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.shopper_longitude
//                 ),
//             }
//           : null;

//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '📦 CUSTOMER ORDER'
//       );

//       console.log(
//         'ORDER ID:',
//         order.id
//       );

//       console.log(
//         'STATUS:',
//         order.status
//       );

//       console.log(
//         'SHOPPER ID:',
//         order.shopper_id
//       );

//       console.log(
//         'SHOPPER:',
//         shopper?.name || 'Not assigned'
//       );

//       console.log(
//         'SHOPPER LOCATION:',
//         shopper
//           ? `${shopper.latitude}, ${shopper.longitude}`
//           : 'Not available'
//       );

//       console.log(
//         '===================================='
//       );

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         order: {

//           ...order,

//           delivery_latitude:
//             Number(
//               order.delivery_latitude
//             ),

//           delivery_longitude:
//             Number(
//               order.delivery_longitude
//             ),

//           items_total:
//             itemsTotal,

//           delivery_fee:
//             deliveryFee,

//           service_fee:
//             serviceFee,

//           total_amount:
//             totalAmount,

//           total:
//             totalAmount,

//           totalAmount:
//             totalAmount,

//           itemsTotal:
//             itemsTotal,

//           deliveryFee:
//             deliveryFee,

//           serviceFee:
//             serviceFee,

//           // ==================================================
//           // SHOP
//           // ==================================================

//           shop: {

//             id:
//               order.shop_id,

//             name:
//               order.shop_name ||
//               'Selected Shop',

//             shop_name:
//               order.shop_name ||
//               'Selected Shop',

//             image:
//               order.shop_image ||
//               null,

//             image_url:
//               order.shop_image ||
//               null,

//             latitude:
//               Number(
//                 order.shop_latitude
//               ),

//             longitude:
//               Number(
//                 order.shop_longitude
//               ),

//           },

//           // ==================================================
//           // SHOPPER
//           // ==================================================

//           shopper:
//             shopper,

//           assignedShopper:
//             shopper,

//           assigned_shopper:
//             shopper,

//           items:
//             items,

//         },

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET CUSTOMER ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // GET NEARBY ONLINE SHOPPERS FOR ORDER
// // ==================================================

// const getNearbyShoppersForOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       // ==================================================
//       // VALIDATE ORDER ID
//       // ==================================================

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // GET ORDER + SHOP LOCATION
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,
//             o.status,
//             o.shopper_id,

//             s.shop_name,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       // ==================================================
//       // ORDER NOT FOUND
//       // ==================================================

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ACCEPTED SHOPPER
//       // ==================================================

//       let acceptedShopper = null;

//       if (order.shopper_id) {

//         const acceptedShopperResult =
//           await pool.query(
//             `
//             SELECT
//               id,
//               full_name,
//               mobile,
//               status,
//               latitude,
//               longitude
//             FROM shoppers
//             WHERE id = $1
//             LIMIT 1
//             `,
//             [
//               order.shopper_id,
//             ]
//           );

//         if (
//           acceptedShopperResult.rows.length > 0
//         ) {

//           const shopper =
//             acceptedShopperResult.rows[0];

//           acceptedShopper = {

//             id:
//               Number(
//                 shopper.id
//               ),

//             name:
//               shopper.full_name ||
//               'Shopper',

//             full_name:
//               shopper.full_name ||
//               'Shopper',

//             mobile:
//               shopper.mobile ||
//               null,

//             status:
//               shopper.status ||
//               null,

//             latitude:
//               Number(
//                 shopper.latitude
//               ),

//             longitude:
//               Number(
//                 shopper.longitude
//               ),

//           };

//         }

//       }

//       // ==================================================
//       // CHECK SHOP LOCATION
//       // ==================================================

//       const shopLatitude =
//         Number(
//           order.shop_latitude
//         );

//       const shopLongitude =
//         Number(
//           order.shop_longitude
//         );

//       if (
//         !Number.isFinite(
//           shopLatitude
//         ) ||
//         !Number.isFinite(
//           shopLongitude
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Shop location is not available',

//         });

//       }

//       // ==================================================
//       // GET ONLINE SHOPPERS
//       // ==================================================

//       /*
//        * Find real shoppers who are:
//        *
//        * 1. ONLINE
//        * 2. Have valid location
//        * 3. Within 10 KM of selected shop
//        *
//        * The closest shopper is returned first.
//        */

//       const shoppersResult =
//         await pool.query(
//           `
//           SELECT

//             sh.id,

//             sh.full_name,

//             sh.mobile,

//             sh.status,

//             sh.latitude,

//             sh.longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,
//                     cos(
//                       radians($1)
//                     ) *
//                     cos(
//                       radians(sh.latitude)
//                     ) *
//                     cos(
//                       radians(sh.longitude) -
//                       radians($2)
//                     ) +
//                     sin(
//                       radians($1)
//                     ) *
//                     sin(
//                       radians(sh.latitude)
//                     )
//                   )
//                 )
//               )
//             ) AS distance_km

//           FROM shoppers sh

//           WHERE
//             sh.status = 'online'

//             AND sh.latitude IS NOT NULL

//             AND sh.longitude IS NOT NULL

//             AND sh.latitude BETWEEN -90 AND 90

//             AND sh.longitude BETWEEN -180 AND 180

//           ORDER BY
//             distance_km ASC
//           `,
//           [
//             shopLatitude,
//             shopLongitude,
//           ]
//         );

//       // ==================================================
//       // ONLY 10 KM
//       // ==================================================

//       const shoppers =
//         shoppersResult.rows

//           .filter(
//             (shopper) => {

//               const distance =
//                 Number(
//                   shopper.distance_km
//                 );

//               return (
//                 Number.isFinite(distance) &&
//                 distance <= 10
//               );

//             }
//           )

//           .map(
//             (shopper) => ({

//               id:
//                 shopper.id,

//               name:
//                 shopper.full_name,

//               full_name:
//                 shopper.full_name,

//               mobile:
//                 shopper.mobile,

//               status:
//                 shopper.status,

//               latitude:
//                 Number(
//                   shopper.latitude
//                 ),

//               longitude:
//                 Number(
//                   shopper.longitude
//                 ),

//               distance_km:
//                 Number(
//                   shopper.distance_km
//                 ),

//             })
//           );

//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '📍 NEARBY ONLINE SHOPPERS'
//       );

//       console.log(
//         'ORDER ID:',
//         orderId
//       );

//       console.log(
//         'SHOP ID:',
//         order.shop_id
//       );

//       console.log(
//         'SHOP:',
//         order.shop_name
//       );

//       console.log(
//         'SHOP LOCATION:',
//         shopLatitude,
//         shopLongitude
//       );

//       console.log(
//         'ORDER STATUS:',
//         order.status
//       );

//       console.log(
//         'ACCEPTED SHOPPER:',
//         acceptedShopper
//       );

//       console.log(
//         'ONLINE SHOPPERS:',
//         shoppers.length
//       );

//       shoppers.forEach(
//         (shopper) => {

//           console.log(
//             '--------------------------------'
//           );

//           console.log(
//             'SHOPPER ID:',
//             shopper.id
//           );

//           console.log(
//             'SHOPPER NAME:',
//             shopper.name
//           );

//           console.log(
//             'STATUS:',
//             shopper.status
//           );

//           console.log(
//             'LOCATION:',
//             shopper.latitude,
//             shopper.longitude
//           );

//           console.log(
//             'DISTANCE:',
//             shopper.distance_km,
//             'KM'
//           );

//         }
//       );

//       console.log(
//         '===================================='
//       );

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         orderId:
//           order.id,

//         orderStatus:
//           order.status,

//         shop: {

//           id:
//             order.shop_id,

//           name:
//             order.shop_name ||
//             'Selected Shop',

//           latitude:
//             shopLatitude,

//           longitude:
//             shopLongitude,

//         },

//         // ==================================================
//         // ACCEPTED SHOPPER
//         // ==================================================

//         shopper:
//           acceptedShopper,

//         acceptedShopper:
//           acceptedShopper,

//         assignedShopper:
//           acceptedShopper,

//         assigned_shopper:
//           acceptedShopper,

//         // ==================================================
//         // NEARBY SHOPPERS
//         // ==================================================

//         shoppers:
//           shoppers,

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET NEARBY SHOPPERS ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load nearby shoppers',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // CANCEL CUSTOMER ORDER
// // ==================================================

// const cancelCustomerOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // CHECK ORDER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             id,
//             status
//           FROM orders
//           WHERE
//             id = $1
//             AND customer_id = $2
//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // ONLY WAITING ORDERS CAN CANCEL
//       // ==================================================

//       if (
//         order.status !==
//         'waiting_for_shopper'
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'This order cannot be cancelled now',

//         });

//       }

//       // ==================================================
//       // UPDATE
//       // ==================================================

//       const updateResult =
//         await pool.query(
//           `
//           UPDATE orders

//           SET
//             status = 'cancelled',
//             updated_at = CURRENT_TIMESTAMP

//           WHERE
//             id = $1
//             AND customer_id = $2

//           RETURNING *
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       return res.status(200).json({

//         success: true,

//         message:
//           'Order cancelled successfully',

//         order:
//           updateResult.rows[0],

//       });

//     } catch (error) {

//       console.error(
//         '❌ CANCEL ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to cancel order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = {

//   createOrder,

//   getCustomerOrders,

//   getCustomerOrderById,

//   getNearbyShoppersForOrder,

//   cancelCustomerOrder,

// };


















// const pool = require('../config/db');

// // ==================================================
// // CREATE ORDER
// // ==================================================

// const createOrder = async (req, res) => {
//   const client = await pool.connect();

//   try {
//     const customerId =
//       req.customer.customerId;

//     const {
//       shopId,
//       deliveryAddress,
//       deliveryLatitude,
//       deliveryLongitude,
//       deliveryOption = 'fast',
//       paymentMethod = 'cash',
//       items = [],
//       deliveryFee = 0,
//       serviceFee = 0,
//       itemsTotal = 0,
//       totalAmount = 0,
//     } = req.body;

//     // ==================================================
//     // VALIDATION
//     // ==================================================

//     if (!shopId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Shop ID is required',
//       });
//     }

//     if (!deliveryAddress) {
//       return res.status(400).json({
//         success: false,
//         message: 'Delivery address is required',
//       });
//     }

//     if (
//       deliveryLatitude === undefined ||
//       deliveryLongitude === undefined
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Delivery latitude and longitude are required',
//       });
//     }

//     const latitude =
//       Number(deliveryLatitude);

//     const longitude =
//       Number(deliveryLongitude);

//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude)
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Valid latitude and longitude are required',
//       });
//     }

//     if (
//       latitude < -90 ||
//       latitude > 90 ||
//       longitude < -180 ||
//       longitude > 180
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Latitude or longitude is out of range',
//       });
//     }

//     if (
//       !Array.isArray(items) ||
//       items.length === 0
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'At least one order item is required',
//       });
//     }

//     // ==================================================
//     // CHECK SHOP
//     // ==================================================

//     const shopResult = await client.query(
//       `
//       SELECT
//         id,
//         shop_name,
//         image_url,
//         status,
//         latitude,
//         longitude
//       FROM shops
//       WHERE id = $1
//       `,
//       [shopId]
//     );

//     if (shopResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shop not found',
//       });
//     }

//     const shop =
//       shopResult.rows[0];

//     if (
//       shop.status !== 'approved'
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'This shop is not available',
//       });
//     }

//     // ==================================================
//     // TOTALS
//     // ==================================================

//     const safeItemsTotal =
//       Number(itemsTotal) || 0;

//     const safeDeliveryFee =
//       Number(deliveryFee) || 0;

//     const safeServiceFee =
//       Number(serviceFee) || 0;

//     const safeTotalAmount =
//       Number(totalAmount) ||
//       (
//         safeItemsTotal +
//         safeDeliveryFee +
//         safeServiceFee
//       );

//     // ==================================================
//     // START TRANSACTION
//     // ==================================================

//     await client.query(
//       'BEGIN'
//     );

//     // ==================================================
//     // CREATE ORDER
//     // ==================================================

//     const orderResult =
//       await client.query(
//         `
//         INSERT INTO orders (
//           customer_id,
//           shop_id,
//           delivery_address,
//           delivery_latitude,
//           delivery_longitude,
//           delivery_option,
//           payment_method,
//           items_total,
//           delivery_fee,
//           service_fee,
//           total_amount,
//           status
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10,
//           $11,
//           $12
//         )
//         RETURNING *
//         `,
//         [
//           customerId,
//           shopId,
//           deliveryAddress,
//           latitude,
//           longitude,
//           deliveryOption,
//           paymentMethod,
//           safeItemsTotal,
//           safeDeliveryFee,
//           safeServiceFee,
//           safeTotalAmount,
//           'waiting_for_shopper',
//         ]
//       );

//     const order =
//       orderResult.rows[0];

//     // ==================================================
//     // CREATE ORDER ITEMS
//     // ==================================================

//     for (
//       const item of items
//     ) {
//       const productId =
//         item.productId ||
//         item.product_id ||
//         null;

//       const itemName =
//         item.itemName ||
//         item.item_name ||
//         item.name ||
//         item.productName ||
//         'Item';

//       const quantity =
//         Number(
//           item.quantity
//         ) || 1;

//       const amount =
//         Number(
//           item.amount
//         ) || 1;

//       const unit =
//         item.unit ||
//         item.selectedUnit ||
//         null;

//       const price =
//         Number(
//           item.price
//         ) || 0;

//       const custom =
//         item.custom === true;

//       const details =
//         item.details ||
//         null;

//       const image =
//         item.image ||
//         item.imageUrl ||
//         null;

//       await client.query(
//         `
//         INSERT INTO order_items (
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10
//         )
//         `,
//         [
//           order.id,
//           productId,
//           itemName,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//         ]
//       );
//     }

//     // ==================================================
//     // COMMIT
//     // ==================================================

//     await client.query(
//       'COMMIT'
//     );

//     // ==================================================
//     // GET CREATED ITEMS
//     // ==================================================

//     const createdItemsResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,

//           shopper_photo_url,
//           shopping_status,
//           found_quantity,
//           found_weight,
//           found_weight_unit,
//           barcode_scanned,
//           completed_at,

//           created_at
//         FROM order_items
//         WHERE order_id = $1
//         ORDER BY id ASC
//         `,
//         [order.id]
//       );

//     const createdItems =
//       createdItemsResult.rows.map(
//         (item) => ({
//           ...item,

//           shoppingStatus:
//             item.shopping_status ||
//             'pending',

//           foundQuantity:
//             item.found_quantity !== null
//               ? Number(item.found_quantity)
//               : null,

//           foundWeight:
//             item.found_weight !== null
//               ? Number(item.found_weight)
//               : null,

//           foundWeightUnit:
//             item.found_weight_unit ||
//             null,

//           barcodeScanned:
//             item.barcode_scanned === true,

//           shopperPhotoUrl:
//             item.shopper_photo_url ||
//             null,

//           completedAt:
//             item.completed_at ||
//             null,
//         })
//       );

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ ORDER CREATED'
//     );

//     console.log(
//       'ORDER ID:',
//       order.id
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     console.log(
//       'SHOP ID:',
//       shopId
//     );

//     console.log(
//       'ITEM COUNT:',
//       createdItems.length
//     );

//     console.log(
//       'ITEMS TOTAL:',
//       order.items_total
//     );

//     console.log(
//       'TOTAL AMOUNT:',
//       order.total_amount
//     );

//     console.log(
//       '===================================='
//     );

//     return res.status(201).json({
//       success: true,

//       message:
//         'Order created successfully',

//       order: {
//         ...order,

//         total:
//           Number(
//             order.total_amount
//           ),

//         totalAmount:
//           Number(
//             order.total_amount
//           ),

//         itemsTotal:
//           Number(
//             order.items_total
//           ),

//         deliveryFee:
//           Number(
//             order.delivery_fee
//           ),

//         serviceFee:
//           Number(
//             order.service_fee
//           ),

//         shop: {
//           id: shop.id,
//           name: shop.shop_name,
//           image: shop.image_url,

//           latitude:
//             Number(shop.latitude),

//           longitude:
//             Number(shop.longitude),
//         },

//         items:
//           createdItems,
//       },
//     });

//   } catch (error) {

//     try {
//       await client.query(
//         'ROLLBACK'
//       );
//     } catch (rollbackError) {
//       console.error(
//         '❌ Rollback error:',
//         rollbackError.message
//       );
//     }

//     console.error(
//       '❌ CREATE ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Failed to create order',
//       error:
//         error.message,
//     });

//   } finally {

//     client.release();

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDERS
// // ==================================================

// const getCustomerOrders = async (
//   req,
//   res
// ) => {

//   try {

//     const customerId =
//       req.customer.customerId;

//     // ==================================================
//     // GET ORDERS
//     // ==================================================

//     const ordersResult =
//       await pool.query(
//         `
//         SELECT
//           o.id,
//           o.customer_id,
//           o.shop_id,
//           o.shopper_id,

//           o.delivery_address,
//           o.delivery_latitude,
//           o.delivery_longitude,

//           o.delivery_option,
//           o.payment_method,

//           o.items_total,
//           o.delivery_fee,
//           o.service_fee,
//           o.total_amount,

//           o.status,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude,

//           sh.id AS shopper_id_joined,
//           sh.full_name AS shopper_name,
//           sh.mobile AS shopper_mobile,
//           sh.status AS shopper_status,
//           sh.latitude AS shopper_latitude,
//           sh.longitude AS shopper_longitude

//         FROM orders o

//         LEFT JOIN shops s
//           ON s.id = o.shop_id

//         LEFT JOIN shoppers sh
//           ON sh.id = o.shopper_id

//         WHERE o.customer_id = $1

//         ORDER BY
//           o.created_at DESC
//         `,
//         [customerId]
//       );

//     // ==================================================
//     // GET ITEMS FOR EACH ORDER
//     // ==================================================

//     const formattedOrders =
//       await Promise.all(
//         ordersResult.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT
//                   oi.id,
//                   oi.order_id,

//                   oi.product_id,

//                   oi.item_name,

//                   oi.quantity,
//                   oi.amount,
//                   oi.unit,
//                   oi.price,

//                   oi.custom,
//                   oi.details,
//                   oi.image,

//                   oi.shopper_photo_url,
//                   oi.shopping_status,
//                   oi.found_quantity,
//                   oi.found_weight,
//                   oi.found_weight_unit,
//                   oi.barcode_scanned,
//                   oi.completed_at,

//                   oi.created_at

//                 FROM order_items oi

//                 WHERE oi.order_id = $1

//                 ORDER BY
//                   oi.id ASC
//                 `,
//                 [order.id]
//               );

//             // ==================================================
//             // FORMAT ITEMS
//             // ==================================================

//             const items =
//               itemsResult.rows.map(
//                 (item) => ({

//                   ...item,

//                   // Database field
//                   shopping_status:
//                     item.shopping_status ||
//                     'pending',

//                   // Frontend friendly field
//                   shoppingStatus:
//                     item.shopping_status ||
//                     'pending',

//                   found_quantity:
//                     item.found_quantity !== null
//                       ? Number(item.found_quantity)
//                       : null,

//                   foundQuantity:
//                     item.found_quantity !== null
//                       ? Number(item.found_quantity)
//                       : null,

//                   found_weight:
//                     item.found_weight !== null
//                       ? Number(item.found_weight)
//                       : null,

//                   foundWeight:
//                     item.found_weight !== null
//                       ? Number(item.found_weight)
//                       : null,

//                   found_weight_unit:
//                     item.found_weight_unit ||
//                     null,

//                   foundWeightUnit:
//                     item.found_weight_unit ||
//                     null,

//                   barcode_scanned:
//                     item.barcode_scanned === true,

//                   barcodeScanned:
//                     item.barcode_scanned === true,

//                   shopper_photo_url:
//                     item.shopper_photo_url ||
//                     null,

//                   shopperPhotoUrl:
//                     item.shopper_photo_url ||
//                     null,

//                   completed_at:
//                     item.completed_at ||
//                     null,

//                   completedAt:
//                     item.completed_at ||
//                     null,

//                 })
//               );

//             // ==================================================
//             // TOTAL
//             // ==================================================

//             const totalAmount =
//               Number(
//                 order.total_amount
//               ) || 0;

//             const itemsTotal =
//               Number(
//                 order.items_total
//               ) || 0;

//             const deliveryFee =
//               Number(
//                 order.delivery_fee
//               ) || 0;

//             const serviceFee =
//               Number(
//                 order.service_fee
//               ) || 0;

//             // ==================================================
//             // SHOPPER
//             // ==================================================

//             const shopper =
//               order.shopper_id
//                 ? {
//                     id:
//                       Number(
//                         order.shopper_id
//                       ),

//                     name:
//                       order.shopper_name ||
//                       'Shopper',

//                     full_name:
//                       order.shopper_name ||
//                       'Shopper',

//                     mobile:
//                       order.shopper_mobile ||
//                       null,

//                     status:
//                       order.shopper_status ||
//                       null,

//                     latitude:
//                       Number(
//                         order.shopper_latitude
//                       ),

//                     longitude:
//                       Number(
//                         order.shopper_longitude
//                       ),
//                   }
//                 : null;

//             // ==================================================
//             // RETURN
//             // ==================================================

//             return {

//               id:
//                 order.id,

//               customer_id:
//                 order.customer_id,

//               shop_id:
//                 order.shop_id,

//               shopper_id:
//                 order.shopper_id
//                   ? Number(order.shopper_id)
//                   : null,

//               delivery_address:
//                 order.delivery_address,

//               delivery_latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               delivery_longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),

//               delivery_option:
//                 order.delivery_option,

//               payment_method:
//                 order.payment_method,

//               items_total:
//                 itemsTotal,

//               delivery_fee:
//                 deliveryFee,

//               service_fee:
//                 serviceFee,

//               total_amount:
//                 totalAmount,

//               // Frontend friendly fields

//               total:
//                 totalAmount,

//               totalAmount:
//                 totalAmount,

//               itemsTotal:
//                 itemsTotal,

//               deliveryFee:
//                 deliveryFee,

//               serviceFee:
//                 serviceFee,

//               status:
//                 order.status,

//               created_at:
//                 order.created_at,

//               updated_at:
//                 order.updated_at,

//               // ==================================================
//               // SHOP
//               // ==================================================

//               shop: {

//                 id:
//                   order.shop_id,

//                 name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 shop_name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 image:
//                   order.shop_image ||
//                   null,

//                 image_url:
//                   order.shop_image ||
//                   null,

//                 latitude:
//                   Number(
//                     order.shop_latitude
//                   ),

//                 longitude:
//                   Number(
//                     order.shop_longitude
//                   ),

//               },

//               // ==================================================
//               // SHOPPER
//               // ==================================================

//               shopper:
//                 shopper,

//               assignedShopper:
//                 shopper,

//               assigned_shopper:
//                 shopper,

//               // ==================================================
//               // ITEMS
//               // ==================================================

//               items:
//                 items,

//               // Extra aliases for frontend compatibility

//               shoppingList:
//                 items,

//               orderItems:
//                 items,

//             };

//           }
//         )
//       );

//     // ==================================================
//     // DEBUG
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '📦 CUSTOMER ORDERS'
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     formattedOrders.forEach(
//       (order) => {

//         console.log(
//           `ORDER #${order.id}`
//         );

//         console.log(
//           'ITEM COUNT:',
//           order.items.length
//         );

//         console.log(
//           'ITEMS TOTAL:',
//           order.items_total
//         );

//         console.log(
//           'TOTAL:',
//           order.total_amount
//         );

//         console.log(
//           'SHOPPER ID:',
//           order.shopper_id
//         );

//         console.log(
//           'SHOPPER:',
//           order.shopper?.name ||
//           'Not assigned'
//         );

//         console.log(
//           'SHOPPING STATUS:',
//           order.items.map(
//             (item) => ({
//               id: item.id,
//               name: item.item_name,
//               status: item.shopping_status,
//             })
//           )
//         );

//       }
//     );

//     console.log(
//       '===================================='
//     );

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     return res.status(200).json({

//       success: true,

//       orders:
//         formattedOrders,

//     });

//   } catch (error) {

//     console.error(
//       '❌ GET CUSTOMER ORDERS ERROR:',
//       error
//     );

//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to load customer orders',

//       error:
//         error.message,

//     });

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDER BY ID
// // ==================================================

// const getCustomerOrderById =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // GET ORDER + SHOP + SHOPPER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             o.*,

//             s.shop_name,
//             s.image_url AS shop_image,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             sh.id AS shopper_id_joined,
//             sh.full_name AS shopper_name,
//             sh.mobile AS shopper_mobile,
//             sh.status AS shopper_status,
//             sh.latitude AS shopper_latitude,
//             sh.longitude AS shopper_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           LEFT JOIN shoppers sh
//             ON sh.id = o.shopper_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ITEMS
//       // ==================================================

//       const itemsResult =
//         await pool.query(
//           `
//           SELECT
//             oi.id,
//             oi.order_id,

//             oi.product_id,

//             oi.item_name,

//             oi.quantity,
//             oi.amount,
//             oi.unit,
//             oi.price,

//             oi.custom,
//             oi.details,
//             oi.image,

//             oi.shopper_photo_url,
//             oi.shopping_status,
//             oi.found_quantity,
//             oi.found_weight,
//             oi.found_weight_unit,
//             oi.barcode_scanned,
//             oi.completed_at,

//             oi.created_at

//           FROM order_items oi

//           WHERE oi.order_id = $1

//           ORDER BY oi.id ASC
//           `,
//           [orderId]
//         );

//       // ==================================================
//       // FORMAT ITEMS
//       // ==================================================

//       const items =
//         itemsResult.rows.map(
//           (item) => ({

//             ...item,

//             // ==================================================
//             // SHOPPING STATUS
//             // ==================================================

//             shopping_status:
//               item.shopping_status ||
//               'pending',

//             shoppingStatus:
//               item.shopping_status ||
//               'pending',

//             // ==================================================
//             // FOUND QUANTITY
//             // ==================================================

//             found_quantity:
//               item.found_quantity !== null
//                 ? Number(item.found_quantity)
//                 : null,

//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(item.found_quantity)
//                 : null,

//             // ==================================================
//             // FOUND WEIGHT
//             // ==================================================

//             found_weight:
//               item.found_weight !== null
//                 ? Number(item.found_weight)
//                 : null,

//             foundWeight:
//               item.found_weight !== null
//                 ? Number(item.found_weight)
//                 : null,

//             // ==================================================
//             // WEIGHT UNIT
//             // ==================================================

//             found_weight_unit:
//               item.found_weight_unit ||
//               null,

//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,

//             // ==================================================
//             // BARCODE
//             // ==================================================

//             barcode_scanned:
//               item.barcode_scanned === true,

//             barcodeScanned:
//               item.barcode_scanned === true,

//             // ==================================================
//             // SHOPPER PHOTO
//             // ==================================================

//             shopper_photo_url:
//               item.shopper_photo_url ||
//               null,

//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,

//             // ==================================================
//             // COMPLETED TIME
//             // ==================================================

//             completed_at:
//               item.completed_at ||
//               null,

//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         );

//       // ==================================================
//       // TOTALS
//       // ==================================================

//       const totalAmount =
//         Number(
//           order.total_amount
//         ) || 0;

//       const itemsTotal =
//         Number(
//           order.items_total
//         ) || 0;

//       const deliveryFee =
//         Number(
//           order.delivery_fee
//         ) || 0;

//       const serviceFee =
//         Number(
//           order.service_fee
//         ) || 0;

//       // ==================================================
//       // SHOPPER
//       // ==================================================

//       const shopper =
//         order.shopper_id
//           ? {
//               id:
//                 Number(
//                   order.shopper_id
//                 ),

//               name:
//                 order.shopper_name ||
//                 'Shopper',

//               full_name:
//                 order.shopper_name ||
//                 'Shopper',

//               mobile:
//                 order.shopper_mobile ||
//                 null,

//               status:
//                 order.shopper_status ||
//                 null,

//               latitude:
//                 Number(
//                   order.shopper_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.shopper_longitude
//                 ),
//           }
//         : null;

//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '📦 CUSTOMER ORDER'
//       );

//       console.log(
//         'ORDER ID:',
//         order.id
//       );

//       console.log(
//         'STATUS:',
//         order.status
//       );

//       console.log(
//         'SHOPPER ID:',
//         order.shopper_id
//       );

//       console.log(
//         'SHOPPER:',
//         shopper?.name ||
//         'Not assigned'
//       );

//       console.log(
//         'SHOPPER LOCATION:',
//         shopper
//           ? `${shopper.latitude}, ${shopper.longitude}`
//           : 'Not available'
//       );

//       console.log(
//         'ITEM SHOPPING STATUS:',
//         items.map(
//           (item) => ({
//             id: item.id,
//             name: item.item_name,
//             status: item.shopping_status,
//             foundQuantity:
//               item.found_quantity,
//             foundWeight:
//               item.found_weight,
//             photo:
//               item.shopper_photo_url,
//             completedAt:
//               item.completed_at,
//           })
//         )
//       );

//       console.log(
//         '===================================='
//       );

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         order: {

//           ...order,

//           delivery_latitude:
//             Number(
//               order.delivery_latitude
//             ),

//           delivery_longitude:
//             Number(
//               order.delivery_longitude
//             ),

//           items_total:
//             itemsTotal,

//           delivery_fee:
//             deliveryFee,

//           service_fee:
//             serviceFee,

//           total_amount:
//             totalAmount,

//           total:
//             totalAmount,

//           totalAmount:
//             totalAmount,

//           itemsTotal:
//             itemsTotal,

//           deliveryFee:
//             deliveryFee,

//           serviceFee:
//             serviceFee,

//           // ==================================================
//           // SHOP
//           // ==================================================

//           shop: {

//             id:
//               order.shop_id,

//             name:
//               order.shop_name ||
//               'Selected Shop',

//             shop_name:
//               order.shop_name ||
//               'Selected Shop',

//             image:
//               order.shop_image ||
//               null,

//             image_url:
//               order.shop_image ||
//               null,

//             latitude:
//               Number(
//                 order.shop_latitude
//               ),

//             longitude:
//               Number(
//                 order.shop_longitude
//               ),

//           },

//           // ==================================================
//           // SHOPPER
//           // ==================================================

//           shopper:
//             shopper,

//           assignedShopper:
//             shopper,

//           assigned_shopper:
//             shopper,

//           // ==================================================
//           // ITEMS
//           // ==================================================

//           items:
//             items,

//           // Frontend aliases

//           shoppingList:
//             items,

//           orderItems:
//             items,

//         },

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET CUSTOMER ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // GET NEARBY ONLINE SHOPPERS FOR ORDER
// // ==================================================

// const getNearbyShoppersForOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       // ==================================================
//       // VALIDATE ORDER ID
//       // ==================================================

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // GET ORDER + SHOP LOCATION
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,
//             o.status,
//             o.shopper_id,

//             s.shop_name,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       // ==================================================
//       // ORDER NOT FOUND
//       // ==================================================

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ACCEPTED SHOPPER
//       // ==================================================

//       let acceptedShopper = null;

//       if (order.shopper_id) {

//         const acceptedShopperResult =
//           await pool.query(
//             `
//             SELECT
//               id,
//               full_name,
//               mobile,
//               status,
//               latitude,
//               longitude
//             FROM shoppers
//             WHERE id = $1
//             LIMIT 1
//             `,
//             [
//               order.shopper_id,
//             ]
//           );

//         if (
//           acceptedShopperResult.rows.length > 0
//         ) {

//           const shopper =
//             acceptedShopperResult.rows[0];

//           acceptedShopper = {

//             id:
//               Number(
//                 shopper.id
//               ),

//             name:
//               shopper.full_name ||
//               'Shopper',

//             full_name:
//               shopper.full_name ||
//               'Shopper',

//             mobile:
//               shopper.mobile ||
//               null,

//             status:
//               shopper.status ||
//               null,

//             latitude:
//               Number(
//                 shopper.latitude
//               ),

//             longitude:
//               Number(
//                 shopper.longitude
//               ),

//           };

//         }

//       }

//       // ==================================================
//       // CHECK SHOP LOCATION
//       // ==================================================

//       const shopLatitude =
//         Number(
//           order.shop_latitude
//         );

//       const shopLongitude =
//         Number(
//           order.shop_longitude
//         );

//       if (
//         !Number.isFinite(
//           shopLatitude
//         ) ||
//         !Number.isFinite(
//           shopLongitude
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Shop location is not available',

//         });

//       }

//       // ==================================================
//       // GET ONLINE SHOPPERS
//       // ==================================================

//       const shoppersResult =
//         await pool.query(
//           `
//           SELECT

//             sh.id,

//             sh.full_name,

//             sh.mobile,

//             sh.status,

//             sh.latitude,

//             sh.longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,
//                     cos(
//                       radians($1)
//                     ) *
//                     cos(
//                       radians(sh.latitude)
//                     ) *
//                     cos(
//                       radians(sh.longitude) -
//                       radians($2)
//                     ) +
//                     sin(
//                       radians($1)
//                     ) *
//                     sin(
//                       radians(sh.latitude)
//                     )
//                   )
//                 )
//               )
//             ) AS distance_km

//           FROM shoppers sh

//           WHERE
//             sh.status = 'online'

//             AND sh.latitude IS NOT NULL

//             AND sh.longitude IS NOT NULL

//             AND sh.latitude BETWEEN -90 AND 90

//             AND sh.longitude BETWEEN -180 AND 180

//           ORDER BY
//             distance_km ASC
//           `,
//           [
//             shopLatitude,
//             shopLongitude,
//           ]
//         );

//       // ==================================================
//       // ONLY 10 KM
//       // ==================================================

//       const shoppers =
//         shoppersResult.rows

//           .filter(
//             (shopper) => {

//               const distance =
//                 Number(
//                   shopper.distance_km
//                 );

//               return (
//                 Number.isFinite(distance) &&
//                 distance <= 10
//               );

//             }
//           )

//           .map(
//             (shopper) => ({

//               id:
//                 shopper.id,

//               name:
//                 shopper.full_name,

//               full_name:
//                 shopper.full_name,

//               mobile:
//                 shopper.mobile,

//               status:
//                 shopper.status,

//               latitude:
//                 Number(
//                   shopper.latitude
//                 ),

//               longitude:
//                 Number(
//                   shopper.longitude
//                 ),

//               distance_km:
//                 Number(
//                   shopper.distance_km
//                 ),

//             })
//           );

//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '📍 NEARBY ONLINE SHOPPERS'
//       );

//       console.log(
//         'ORDER ID:',
//         orderId
//       );

//       console.log(
//         'SHOP ID:',
//         order.shop_id
//       );

//       console.log(
//         'SHOP:',
//         order.shop_name
//       );

//       console.log(
//         'SHOP LOCATION:',
//         shopLatitude,
//         shopLongitude
//       );

//       console.log(
//         'ORDER STATUS:',
//         order.status
//       );

//       console.log(
//         'ACCEPTED SHOPPER:',
//         acceptedShopper
//       );

//       console.log(
//         'ONLINE SHOPPERS:',
//         shoppers.length
//       );

//       shoppers.forEach(
//         (shopper) => {

//           console.log(
//             '--------------------------------'
//           );

//           console.log(
//             'SHOPPER ID:',
//             shopper.id
//           );

//           console.log(
//             'SHOPPER NAME:',
//             shopper.name
//           );

//           console.log(
//             'STATUS:',
//             shopper.status
//           );

//           console.log(
//             'LOCATION:',
//             shopper.latitude,
//             shopper.longitude
//           );

//           console.log(
//             'DISTANCE:',
//             shopper.distance_km,
//             'KM'
//           );

//         }
//       );

//       console.log(
//         '===================================='
//       );

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         orderId:
//           order.id,

//         orderStatus:
//           order.status,

//         shop: {

//           id:
//             order.shop_id,

//           name:
//             order.shop_name ||
//             'Selected Shop',

//           latitude:
//             shopLatitude,

//           longitude:
//             shopLongitude,

//         },

//         // ==================================================
//         // ACCEPTED SHOPPER
//         // ==================================================

//         shopper:
//           acceptedShopper,

//         acceptedShopper:
//           acceptedShopper,

//         assignedShopper:
//           acceptedShopper,

//         assigned_shopper:
//           acceptedShopper,

//         // ==================================================
//         // NEARBY SHOPPERS
//         // ==================================================

//         shoppers:
//           shoppers,

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET NEARBY SHOPPERS ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load nearby shoppers',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // CANCEL CUSTOMER ORDER
// // ==================================================

// const cancelCustomerOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // CHECK ORDER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             id,
//             status
//           FROM orders
//           WHERE
//             id = $1
//             AND customer_id = $2
//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // ONLY WAITING ORDERS CAN CANCEL
//       // ==================================================

//       if (
//         order.status !==
//         'waiting_for_shopper'
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'This order cannot be cancelled now',

//         });

//       }

//       // ==================================================
//       // UPDATE
//       // ==================================================

//       const updateResult =
//         await pool.query(
//           `
//           UPDATE orders

//           SET
//             status = 'cancelled',
//             updated_at = CURRENT_TIMESTAMP

//           WHERE
//             id = $1
//             AND customer_id = $2

//           RETURNING *
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       return res.status(200).json({

//         success: true,

//         message:
//           'Order cancelled successfully',

//         order:
//           updateResult.rows[0],

//       });

//     } catch (error) {

//       console.error(
//         '❌ CANCEL ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to cancel order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = {

//   createOrder,

//   getCustomerOrders,

//   getCustomerOrderById,

//   getNearbyShoppersForOrder,

//   cancelCustomerOrder,

// };


















































// const pool = require('../config/db');

// // ==================================================
// // CREATE ORDER
// // ==================================================

// const createOrder = async (req, res) => {
//   const client = await pool.connect();

//   try {
//     const customerId =
//       req.customer.customerId;

//     const {
//       shopId,
//       deliveryAddress,
//       deliveryLatitude,
//       deliveryLongitude,
//       deliveryOption = 'fast',
//       paymentMethod = 'cash',
//       items = [],
//       deliveryFee = 0,
//       serviceFee = 0,
//       itemsTotal = 0,
//       totalAmount = 0,
//     } = req.body;

//     // ==================================================
//     // VALIDATION
//     // ==================================================

//     if (!shopId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Shop ID is required',
//       });
//     }

//     if (!deliveryAddress) {
//       return res.status(400).json({
//         success: false,
//         message: 'Delivery address is required',
//       });
//     }

//     if (
//       deliveryLatitude === undefined ||
//       deliveryLongitude === undefined
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Delivery latitude and longitude are required',
//       });
//     }

//     const latitude =
//       Number(deliveryLatitude);

//     const longitude =
//       Number(deliveryLongitude);

//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude)
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Valid latitude and longitude are required',
//       });
//     }

//     if (
//       latitude < -90 ||
//       latitude > 90 ||
//       longitude < -180 ||
//       longitude > 180
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Latitude or longitude is out of range',
//       });
//     }

//     if (
//       !Array.isArray(items) ||
//       items.length === 0
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'At least one order item is required',
//       });
//     }

//     // ==================================================
//     // CHECK SHOP
//     // ==================================================

//     const shopResult = await client.query(
//       `
//       SELECT
//         id,
//         shop_name,
//         image_url,
//         status,
//         latitude,
//         longitude
//       FROM shops
//       WHERE id = $1
//       `,
//       [shopId]
//     );

//     if (shopResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shop not found',
//       });
//     }

//     const shop =
//       shopResult.rows[0];

//     if (
//       shop.status !== 'approved'
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'This shop is not available',
//       });
//     }

//     // ==================================================
//     // TOTALS
//     // ==================================================

//     const safeItemsTotal =
//       Number(itemsTotal) || 0;

//     const safeDeliveryFee =
//       Number(deliveryFee) || 0;

//     const safeServiceFee =
//       Number(serviceFee) || 0;

//     const safeTotalAmount =
//       Number(totalAmount) ||
//       (
//         safeItemsTotal +
//         safeDeliveryFee +
//         safeServiceFee
//       );

//     // ==================================================
//     // START TRANSACTION
//     // ==================================================

//     await client.query(
//       'BEGIN'
//     );

//     // ==================================================
//     // CREATE ORDER
//     // ==================================================

//     const orderResult =
//       await client.query(
//         `
//         INSERT INTO orders (
//           customer_id,
//           shop_id,
//           delivery_address,
//           delivery_latitude,
//           delivery_longitude,
//           delivery_option,
//           payment_method,
//           items_total,
//           delivery_fee,
//           service_fee,
//           total_amount,
//           status
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10,
//           $11,
//           $12
//         )
//         RETURNING *
//         `,
//         [
//           customerId,
//           shopId,
//           deliveryAddress,
//           latitude,
//           longitude,
//           deliveryOption,
//           paymentMethod,
//           safeItemsTotal,
//           safeDeliveryFee,
//           safeServiceFee,
//           safeTotalAmount,
//           'waiting_for_shopper',
//         ]
//       );

//     const order =
//       orderResult.rows[0];

//     // ==================================================
//     // CREATE ORDER ITEMS
//     // ==================================================

//     for (
//       const item of items
//     ) {
//       const productId =
//         item.productId ||
//         item.product_id ||
//         null;

//       const itemName =
//         item.itemName ||
//         item.item_name ||
//         item.name ||
//         item.productName ||
//         'Item';

//       const quantity =
//         Number(
//           item.quantity
//         ) || 1;

//       const amount =
//         Number(
//           item.amount
//         ) || 1;

//       const unit =
//         item.unit ||
//         item.selectedUnit ||
//         null;

//       const price =
//         Number(
//           item.price
//         ) || 0;

//       const custom =
//         item.custom === true;

//       const details =
//         item.details ||
//         null;

//       const image =
//         item.image ||
//         item.imageUrl ||
//         null;

//       await client.query(
//         `
//         INSERT INTO order_items (
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10
//         )
//         `,
//         [
//           order.id,
//           productId,
//           itemName,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//         ]
//       );
//     }

//     // ==================================================
//     // COMMIT
//     // ==================================================

//     await client.query(
//       'COMMIT'
//     );

//     // ==================================================
//     // GET CREATED ITEMS
//     // ==================================================

//     const createdItemsResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,

//           shopper_photo_url,
//           shopping_status,
//           found_quantity,
//           found_weight,
//           found_weight_unit,
//           barcode_scanned,
//           completed_at,

//           created_at
//         FROM order_items
//         WHERE order_id = $1
//         ORDER BY id ASC
//         `,
//         [order.id]
//       );

//     const createdItems =
//       createdItemsResult.rows.map(
//         (item) => ({
//           ...item,

//           shoppingStatus:
//             item.shopping_status ||
//             'pending',

//           foundQuantity:
//             item.found_quantity !== null
//               ? Number(item.found_quantity)
//               : null,

//           foundWeight:
//             item.found_weight !== null
//               ? Number(item.found_weight)
//               : null,

//           foundWeightUnit:
//             item.found_weight_unit ||
//             null,

//           barcodeScanned:
//             item.barcode_scanned === true,

//           shopperPhotoUrl:
//             item.shopper_photo_url ||
//             null,

//           completedAt:
//             item.completed_at ||
//             null,
//         })
//       );

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ ORDER CREATED'
//     );

//     console.log(
//       'ORDER ID:',
//       order.id
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     console.log(
//       'SHOP ID:',
//       shopId
//     );

//     console.log(
//       'ITEM COUNT:',
//       createdItems.length
//     );

//     console.log(
//       'ITEMS TOTAL:',
//       order.items_total
//     );

//     console.log(
//       'TOTAL AMOUNT:',
//       order.total_amount
//     );

//     console.log(
//       '===================================='
//     );

//     return res.status(201).json({
//       success: true,

//       message:
//         'Order created successfully',

//       order: {
//         ...order,

//         total:
//           Number(
//             order.total_amount
//           ),

//         totalAmount:
//           Number(
//             order.total_amount
//           ),

//         itemsTotal:
//           Number(
//             order.items_total
//           ),

//         deliveryFee:
//           Number(
//             order.delivery_fee
//           ),

//         serviceFee:
//           Number(
//             order.service_fee
//           ),

//         shop: {
//           id: shop.id,
//           name: shop.shop_name,
//           image: shop.image_url,

//           latitude:
//             Number(shop.latitude),

//           longitude:
//             Number(shop.longitude),
//         },

//         items:
//           createdItems,
//       },
//     });

//   } catch (error) {

//     try {
//       await client.query(
//         'ROLLBACK'
//       );
//     } catch (rollbackError) {
//       console.error(
//         '❌ Rollback error:',
//         rollbackError.message
//       );
//     }

//     console.error(
//       '❌ CREATE ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Failed to create order',
//       error:
//         error.message,
//     });

//   } finally {

//     client.release();

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDERS
// // ==================================================

// const getCustomerOrders = async (
//   req,
//   res
// ) => {

//   try {

//     const customerId =
//       req.customer.customerId;

//     // ==================================================
//     // GET ORDERS
//     // ==================================================

//     const ordersResult =
//       await pool.query(
//         `
//         SELECT
//           o.id,
//           o.customer_id,
//           o.shop_id,
//           o.shopper_id,

//           o.delivery_address,
//           o.delivery_latitude,
//           o.delivery_longitude,

//           o.delivery_option,
//           o.payment_method,

//           o.items_total,
//           o.delivery_fee,
//           o.service_fee,
//           o.total_amount,

//           o.status,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude,

//           sh.id AS shopper_id_joined,
//           sh.full_name AS shopper_name,
//           sh.mobile AS shopper_mobile,
//           sh.status AS shopper_status,
//           sh.latitude AS shopper_latitude,
//           sh.longitude AS shopper_longitude

//         FROM orders o

//         LEFT JOIN shops s
//           ON s.id = o.shop_id

//         LEFT JOIN shoppers sh
//           ON sh.id = o.shopper_id

//         WHERE o.customer_id = $1

//         ORDER BY
//           o.created_at DESC
//         `,
//         [customerId]
//       );

//     // ==================================================
//     // GET ITEMS FOR EACH ORDER
//     // ==================================================

//     const formattedOrders =
//       await Promise.all(
//         ordersResult.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT
//                   oi.id,
//                   oi.order_id,

//                   oi.product_id,

//                   oi.item_name,

//                   oi.quantity,
//                   oi.amount,
//                   oi.unit,
//                   oi.price,

//                   oi.custom,
//                   oi.details,
//                   oi.image,

//                   oi.shopper_photo_url,
//                   oi.shopping_status,
//                   oi.found_quantity,
//                   oi.found_weight,
//                   oi.found_weight_unit,
//                   oi.barcode_scanned,
//                   oi.completed_at,

//                   oi.created_at,

//                   COALESCE(
//                     (
//                       SELECT json_agg(
//                         json_build_object(
//                           'id', ri.id,
//                           'order_id', ri.order_id,
//                           'original_item_id', ri.original_item_id,
//                           'shopper_id', ri.shopper_id,
//                           'option_number', ri.option_number,

//                           'photo_url', ri.photo_url,
//                           'photoUrl', ri.photo_url,

//                           'replacement_photo_url', ri.photo_url,
//                           'replacementPhotoUrl', ri.photo_url,

//                           'status', ri.status,

//                           'created_at', ri.created_at,
//                           'updated_at', ri.updated_at
//                         )
//                         ORDER BY
//                           ri.option_number ASC
//                       )
//                       FROM replacement_items ri
//                       WHERE
//                         ri.order_id = oi.order_id
//                         AND ri.original_item_id = oi.id
//                     ),
//                     '[]'::json
//                   ) AS replacement_items

//                 FROM order_items oi

//                 WHERE oi.order_id = $1

//                 ORDER BY
//                   oi.id ASC
//                 `,
//                 [order.id]
//               );

//             // ==================================================
//             // FORMAT ITEMS
//             // ==================================================

//             const items =
//               itemsResult.rows.map(
//                 (item) => ({

//                   ...item,

//                   // ==================================================
//                   // REPLACEMENT ITEMS
//                   // ==================================================

//                   replacement_items:
//                     Array.isArray(
//                       item.replacement_items
//                     )
//                       ? item.replacement_items
//                       : [],

//                   replacementItems:
//                     Array.isArray(
//                       item.replacement_items
//                     )
//                       ? item.replacement_items
//                       : [],

//                   replacements:
//                     Array.isArray(
//                       item.replacement_items
//                     )
//                       ? item.replacement_items
//                       : [],

//                   // ==================================================
//                   // DATABASE FIELD
//                   // ==================================================

//                   shopping_status:
//                     item.shopping_status ||
//                     'pending',

//                   // ==================================================
//                   // FRONTEND FIELD
//                   // ==================================================

//                   shoppingStatus:
//                     item.shopping_status ||
//                     'pending',

//                   // ==================================================
//                   // FOUND QUANTITY
//                   // ==================================================

//                   found_quantity:
//                     item.found_quantity !== null
//                       ? Number(item.found_quantity)
//                       : null,

//                   foundQuantity:
//                     item.found_quantity !== null
//                       ? Number(item.found_quantity)
//                       : null,

//                   // ==================================================
//                   // FOUND WEIGHT
//                   // ==================================================

//                   found_weight:
//                     item.found_weight !== null
//                       ? Number(item.found_weight)
//                       : null,

//                   foundWeight:
//                     item.found_weight !== null
//                       ? Number(item.found_weight)
//                       : null,

//                   // ==================================================
//                   // WEIGHT UNIT
//                   // ==================================================

//                   found_weight_unit:
//                     item.found_weight_unit ||
//                     null,

//                   foundWeightUnit:
//                     item.found_weight_unit ||
//                     null,

//                   // ==================================================
//                   // BARCODE
//                   // ==================================================

//                   barcode_scanned:
//                     item.barcode_scanned === true,

//                   barcodeScanned:
//                     item.barcode_scanned === true,

//                   // ==================================================
//                   // SHOPPER PHOTO
//                   // ==================================================

//                   shopper_photo_url:
//                     item.shopper_photo_url ||
//                     null,

//                   shopperPhotoUrl:
//                     item.shopper_photo_url ||
//                     null,

//                   // ==================================================
//                   // COMPLETED TIME
//                   // ==================================================

//                   completed_at:
//                     item.completed_at ||
//                     null,

//                   completedAt:
//                     item.completed_at ||
//                     null,

//                 })
//               );

//             // ==================================================
//             // TOTAL
//             // ==================================================

//             const totalAmount =
//               Number(
//                 order.total_amount
//               ) || 0;

//             const itemsTotal =
//               Number(
//                 order.items_total
//               ) || 0;

//             const deliveryFee =
//               Number(
//                 order.delivery_fee
//               ) || 0;

//             const serviceFee =
//               Number(
//                 order.service_fee
//               ) || 0;

//             // ==================================================
//             // SHOPPER
//             // ==================================================

//             const shopper =
//               order.shopper_id
//                 ? {
//                     id:
//                       Number(
//                         order.shopper_id
//                       ),

//                     name:
//                       order.shopper_name ||
//                       'Shopper',

//                     full_name:
//                       order.shopper_name ||
//                       'Shopper',

//                     mobile:
//                       order.shopper_mobile ||
//                       null,

//                     status:
//                       order.shopper_status ||
//                       null,

//                     latitude:
//                       Number(
//                         order.shopper_latitude
//                       ),

//                     longitude:
//                       Number(
//                         order.shopper_longitude
//                       ),
//                   }
//                 : null;

//             // ==================================================
//             // RETURN
//             // ==================================================

//             return {

//               id:
//                 order.id,

//               customer_id:
//                 order.customer_id,

//               shop_id:
//                 order.shop_id,

//               shopper_id:
//                 order.shopper_id
//                   ? Number(order.shopper_id)
//                   : null,

//               delivery_address:
//                 order.delivery_address,

//               delivery_latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               delivery_longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),

//               delivery_option:
//                 order.delivery_option,

//               payment_method:
//                 order.payment_method,

//               items_total:
//                 itemsTotal,

//               delivery_fee:
//                 deliveryFee,

//               service_fee:
//                 serviceFee,

//               total_amount:
//                 totalAmount,

//               // Frontend friendly fields

//               total:
//                 totalAmount,

//               totalAmount:
//                 totalAmount,

//               itemsTotal:
//                 itemsTotal,

//               deliveryFee:
//                 deliveryFee,

//               serviceFee:
//                 serviceFee,

//               status:
//                 order.status,

//               created_at:
//                 order.created_at,

//               updated_at:
//                 order.updated_at,

//               // ==================================================
//               // SHOP
//               // ==================================================

//               shop: {

//                 id:
//                   order.shop_id,

//                 name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 shop_name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 image:
//                   order.shop_image ||
//                   null,

//                 image_url:
//                   order.shop_image ||
//                   null,

//                 latitude:
//                   Number(
//                     order.shop_latitude
//                   ),

//                 longitude:
//                   Number(
//                     order.shop_longitude
//                   ),

//               },

//               // ==================================================
//               // SHOPPER
//               // ==================================================

//               shopper:
//                 shopper,

//               assignedShopper:
//                 shopper,

//               assigned_shopper:
//                 shopper,

//               // ==================================================
//               // ITEMS
//               // ==================================================

//               items:
//                 items,

//               // Extra aliases for frontend compatibility

//               shoppingList:
//                 items,

//               orderItems:
//                 items,

//             };

//           }
//         )
//       );

//     // ==================================================
//     // DEBUG
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '📦 CUSTOMER ORDERS'
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     formattedOrders.forEach(
//       (order) => {

//         console.log(
//           `ORDER #${order.id}`
//         );

//         console.log(
//           'ITEM COUNT:',
//           order.items.length
//         );

//         console.log(
//           'ITEMS TOTAL:',
//           order.items_total
//         );

//         console.log(
//           'TOTAL:',
//           order.total_amount
//         );

//         console.log(
//           'SHOPPER ID:',
//           order.shopper_id
//         );

//         console.log(
//           'SHOPPER:',
//           order.shopper?.name ||
//           'Not assigned'
//         );

//         console.log(
//           'SHOPPING STATUS:',
//           order.items.map(
//             (item) => ({
//               id: item.id,
//               name: item.item_name,
//               status: item.shopping_status,
//             })
//           )
//         );

//         console.log(
//           'REPLACEMENTS:',
//           order.items.map(
//             (item) => ({
//               itemId: item.id,
//               itemName: item.item_name,
//               replacements:
//                 item.replacement_items?.map(
//                   (replacement) => ({
//                     id: replacement.id,
//                     photo:
//                       replacement.photo_url,
//                     status:
//                       replacement.status,
//                     option:
//                       replacement.option_number,
//                   })
//                 ) || [],
//             })
//           )
//         );

//       }
//     );

//     console.log(
//       '===================================='
//     );

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     return res.status(200).json({

//       success: true,

//       orders:
//         formattedOrders,

//     });

//   } catch (error) {

//     console.error(
//       '❌ GET CUSTOMER ORDERS ERROR:',
//       error
//     );

//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to load customer orders',

//       error:
//         error.message,

//     });

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDER BY ID
// // ==================================================

// const getCustomerOrderById =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // GET ORDER + SHOP + SHOPPER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             o.*,

//             s.shop_name,
//             s.image_url AS shop_image,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             sh.id AS shopper_id_joined,
//             sh.full_name AS shopper_name,
//             sh.mobile AS shopper_mobile,
//             sh.status AS shopper_status,
//             sh.latitude AS shopper_latitude,
//             sh.longitude AS shopper_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           LEFT JOIN shoppers sh
//             ON sh.id = o.shopper_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ITEMS + REPLACEMENTS
//       // ==================================================

//       const itemsResult =
//         await pool.query(
//           `
//           SELECT
//             oi.id,
//             oi.order_id,

//             oi.product_id,

//             oi.item_name,

//             oi.quantity,
//             oi.amount,
//             oi.unit,
//             oi.price,

//             oi.custom,
//             oi.details,
//             oi.image,

//             oi.shopper_photo_url,
//             oi.shopping_status,
//             oi.found_quantity,
//             oi.found_weight,
//             oi.found_weight_unit,
//             oi.barcode_scanned,
//             oi.completed_at,

//             oi.created_at,

//             COALESCE(
//               (
//                 SELECT json_agg(
//                   json_build_object(
//                     'id', ri.id,
//                     'order_id', ri.order_id,
//                     'original_item_id', ri.original_item_id,
//                     'shopper_id', ri.shopper_id,
//                     'option_number', ri.option_number,

//                     'photo_url', ri.photo_url,
//                     'photoUrl', ri.photo_url,

//                     'replacement_photo_url', ri.photo_url,
//                     'replacementPhotoUrl', ri.photo_url,

//                     'status', ri.status,

//                     'created_at', ri.created_at,
//                     'updated_at', ri.updated_at
//                   )
//                   ORDER BY
//                     ri.option_number ASC
//                 )
//                 FROM replacement_items ri
//                 WHERE
//                   ri.order_id = oi.order_id
//                   AND ri.original_item_id = oi.id
//               ),
//               '[]'::json
//             ) AS replacement_items

//           FROM order_items oi

//           WHERE oi.order_id = $1

//           ORDER BY oi.id ASC
//           `,
//           [orderId]
//         );

//       // ==================================================
//       // FORMAT ITEMS
//       // ==================================================

//       const items =
//         itemsResult.rows.map(
//           (item) => ({

//             ...item,

//             // ==================================================
//             // REPLACEMENT ITEMS
//             // ==================================================

//             replacement_items:
//               Array.isArray(
//                 item.replacement_items
//               )
//                 ? item.replacement_items
//                 : [],

//             replacementItems:
//               Array.isArray(
//                 item.replacement_items
//               )
//                 ? item.replacement_items
//                 : [],

//             replacements:
//               Array.isArray(
//                 item.replacement_items
//               )
//                 ? item.replacement_items
//                 : [],

//             // ==================================================
//             // SHOPPING STATUS
//             // ==================================================

//             shopping_status:
//               item.shopping_status ||
//               'pending',

//             shoppingStatus:
//               item.shopping_status ||
//               'pending',

//             // ==================================================
//             // FOUND QUANTITY
//             // ==================================================

//             found_quantity:
//               item.found_quantity !== null
//                 ? Number(item.found_quantity)
//                 : null,

//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(item.found_quantity)
//                 : null,

//             // ==================================================
//             // FOUND WEIGHT
//             // ==================================================

//             found_weight:
//               item.found_weight !== null
//                 ? Number(item.found_weight)
//                 : null,

//             foundWeight:
//               item.found_weight !== null
//                 ? Number(item.found_weight)
//                 : null,

//             // ==================================================
//             // WEIGHT UNIT
//             // ==================================================

//             found_weight_unit:
//               item.found_weight_unit ||
//               null,

//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,

//             // ==================================================
//             // BARCODE
//             // ==================================================

//             barcode_scanned:
//               item.barcode_scanned === true,

//             barcodeScanned:
//               item.barcode_scanned === true,

//             // ==================================================
//             // SHOPPER PHOTO
//             // ==================================================

//             shopper_photo_url:
//               item.shopper_photo_url ||
//               null,

//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,

//             // ==================================================
//             // COMPLETED TIME
//             // ==================================================

//             completed_at:
//               item.completed_at ||
//               null,

//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         );

//       // ==================================================
//       // TOTALS
//       // ==================================================

//       const totalAmount =
//         Number(
//           order.total_amount
//         ) || 0;

//       const itemsTotal =
//         Number(
//           order.items_total
//         ) || 0;

//       const deliveryFee =
//         Number(
//           order.delivery_fee
//         ) || 0;

//       const serviceFee =
//         Number(
//           order.service_fee
//         ) || 0;

//       // ==================================================
//       // SHOPPER
//       // ==================================================

//       const shopper =
//         order.shopper_id
//           ? {
//               id:
//                 Number(
//                   order.shopper_id
//                 ),

//               name:
//                 order.shopper_name ||
//                 'Shopper',

//               full_name:
//                 order.shopper_name ||
//                 'Shopper',

//               mobile:
//                 order.shopper_mobile ||
//                 null,

//               status:
//                 order.shopper_status ||
//                 null,

//               latitude:
//                 Number(
//                   order.shopper_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.shopper_longitude
//                 ),
//           }
//         : null;

//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '📦 CUSTOMER ORDER'
//       );

//       console.log(
//         'ORDER ID:',
//         order.id
//       );

//       console.log(
//         'STATUS:',
//         order.status
//       );

//       console.log(
//         'SHOPPER ID:',
//         order.shopper_id
//       );

//       console.log(
//         'SHOPPER:',
//         shopper?.name ||
//         'Not assigned'
//       );

//       console.log(
//         'SHOPPER LOCATION:',
//         shopper
//           ? `${shopper.latitude}, ${shopper.longitude}`
//           : 'Not available'
//       );

//       console.log(
//         'ITEM SHOPPING STATUS:',
//         items.map(
//           (item) => ({
//             id: item.id,
//             name: item.item_name,
//             status: item.shopping_status,
//             foundQuantity:
//               item.found_quantity,
//             foundWeight:
//               item.found_weight,
//             photo:
//               item.shopper_photo_url,
//             completedAt:
//               item.completed_at,
//           })
//         )
//       );

//       console.log(
//         'REPLACEMENT ITEMS:',
//         items.map(
//           (item) => ({
//             itemId: item.id,
//             itemName: item.item_name,
//             replacements:
//               item.replacement_items?.map(
//                 (replacement) => ({
//                   id: replacement.id,
//                   originalItemId:
//                     replacement.original_item_id,
//                   option:
//                     replacement.option_number,
//                   photo:
//                     replacement.photo_url,
//                   status:
//                     replacement.status,
//                 })
//               ) || [],
//           })
//         )
//       );

//       console.log(
//         '===================================='
//       );

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         order: {

//           ...order,

//           delivery_latitude:
//             Number(
//               order.delivery_latitude
//             ),

//           delivery_longitude:
//             Number(
//               order.delivery_longitude
//             ),

//           items_total:
//             itemsTotal,

//           delivery_fee:
//             deliveryFee,

//           service_fee:
//             serviceFee,

//           total_amount:
//             totalAmount,

//           total:
//             totalAmount,

//           totalAmount:
//             totalAmount,

//           itemsTotal:
//             itemsTotal,

//           deliveryFee:
//             deliveryFee,

//           serviceFee:
//             serviceFee,

//           // ==================================================
//           // SHOP
//           // ==================================================

//           shop: {

//             id:
//               order.shop_id,

//             name:
//               order.shop_name ||
//               'Selected Shop',

//             shop_name:
//               order.shop_name ||
//               'Selected Shop',

//             image:
//               order.shop_image ||
//               null,

//             image_url:
//               order.shop_image ||
//               null,

//             latitude:
//               Number(
//                 order.shop_latitude
//               ),

//             longitude:
//               Number(
//                 order.shop_longitude
//               ),

//           },

//           // ==================================================
//           // SHOPPER
//           // ==================================================

//           shopper:
//             shopper,

//           assignedShopper:
//             shopper,

//           assigned_shopper:
//             shopper,

//           // ==================================================
//           // ITEMS
//           // ==================================================

//           items:
//             items,

//           // Frontend aliases

//           shoppingList:
//             items,

//           orderItems:
//             items,

//         },

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET CUSTOMER ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // GET NEARBY ONLINE SHOPPERS FOR ORDER
// // ==================================================

// const getNearbyShoppersForOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       // ==================================================
//       // VALIDATE ORDER ID
//       // ==================================================

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // GET ORDER + SHOP LOCATION
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,
//             o.status,
//             o.shopper_id,

//             s.shop_name,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       // ==================================================
//       // ORDER NOT FOUND
//       // ==================================================

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ACCEPTED SHOPPER
//       // ==================================================

//       let acceptedShopper = null;

//       if (order.shopper_id) {

//         const acceptedShopperResult =
//           await pool.query(
//             `
//             SELECT
//               id,
//               full_name,
//               mobile,
//               status,
//               latitude,
//               longitude
//             FROM shoppers
//             WHERE id = $1
//             LIMIT 1
//             `,
//             [
//               order.shopper_id,
//             ]
//           );

//         if (
//           acceptedShopperResult.rows.length > 0
//         ) {

//           const shopper =
//             acceptedShopperResult.rows[0];

//           acceptedShopper = {

//             id:
//               Number(
//                 shopper.id
//               ),

//             name:
//               shopper.full_name ||
//               'Shopper',

//             full_name:
//               shopper.full_name ||
//               'Shopper',

//             mobile:
//               shopper.mobile ||
//               null,

//             status:
//               shopper.status ||
//               null,

//             latitude:
//               Number(
//                 shopper.latitude
//               ),

//             longitude:
//               Number(
//                 shopper.longitude
//               ),

//           };

//         }

//       }

//       // ==================================================
//       // CHECK SHOP LOCATION
//       // ==================================================

//       const shopLatitude =
//         Number(
//           order.shop_latitude
//         );

//       const shopLongitude =
//         Number(
//           order.shop_longitude
//         );

//       if (
//         !Number.isFinite(
//           shopLatitude
//         ) ||
//         !Number.isFinite(
//           shopLongitude
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Shop location is not available',

//         });

//       }

//       // ==================================================
//       // GET ONLINE SHOPPERS
//       // ==================================================

//       const shoppersResult =
//         await pool.query(
//           `
//           SELECT

//             sh.id,

//             sh.full_name,

//             sh.mobile,

//             sh.status,

//             sh.latitude,

//             sh.longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,
//                     cos(
//                       radians($1)
//                     ) *
//                     cos(
//                       radians(sh.latitude)
//                     ) *
//                     cos(
//                       radians(sh.longitude) -
//                       radians($2)
//                     ) +
//                     sin(
//                       radians($1)
//                     ) *
//                     sin(
//                       radians(sh.latitude)
//                     )
//                   )
//                 )
//               )
//             ) AS distance_km

//           FROM shoppers sh

//           WHERE
//             sh.status = 'online'

//             AND sh.latitude IS NOT NULL

//             AND sh.longitude IS NOT NULL

//             AND sh.latitude BETWEEN -90 AND 90

//             AND sh.longitude BETWEEN -180 AND 180

//           ORDER BY
//             distance_km ASC
//           `,
//           [
//             shopLatitude,
//             shopLongitude,
//           ]
//         );

//       // ==================================================
//       // ONLY 10 KM
//       // ==================================================

//       const shoppers =
//         shoppersResult.rows

//           .filter(
//             (shopper) => {

//               const distance =
//                 Number(
//                   shopper.distance_km
//                 );

//               return (
//                 Number.isFinite(distance) &&
//                 distance <= 10
//               );

//             }
//           )

//           .map(
//             (shopper) => ({

//               id:
//                 shopper.id,

//               name:
//                 shopper.full_name,

//               full_name:
//                 shopper.full_name,

//               mobile:
//                 shopper.mobile,

//               status:
//                 shopper.status,

//               latitude:
//                 Number(
//                   shopper.latitude
//                 ),

//               longitude:
//                 Number(
//                   shopper.longitude
//                 ),

//               distance_km:
//                 Number(
//                   shopper.distance_km
//                 ),

//             })
//           );

//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '📍 NEARBY ONLINE SHOPPERS'
//       );

//       console.log(
//         'ORDER ID:',
//         orderId
//       );

//       console.log(
//         'SHOP ID:',
//         order.shop_id
//       );

//       console.log(
//         'SHOP:',
//         order.shop_name
//       );

//       console.log(
//         'SHOP LOCATION:',
//         shopLatitude,
//         shopLongitude
//       );

//       console.log(
//         'ORDER STATUS:',
//         order.status
//       );

//       console.log(
//         'ACCEPTED SHOPPER:',
//         acceptedShopper
//       );

//       console.log(
//         'ONLINE SHOPPERS:',
//         shoppers.length
//       );

//       shoppers.forEach(
//         (shopper) => {

//           console.log(
//             '--------------------------------'
//           );

//           console.log(
//             'SHOPPER ID:',
//             shopper.id
//           );

//           console.log(
//             'SHOPPER NAME:',
//             shopper.name
//           );

//           console.log(
//             'STATUS:',
//             shopper.status
//           );

//           console.log(
//             'LOCATION:',
//             shopper.latitude,
//             shopper.longitude
//           );

//           console.log(
//             'DISTANCE:',
//             shopper.distance_km,
//             'KM'
//           );

//         }
//       );

//       console.log(
//         '===================================='
//       );

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         orderId:
//           order.id,

//         orderStatus:
//           order.status,

//         shop: {

//           id:
//             order.shop_id,

//           name:
//             order.shop_name ||
//             'Selected Shop',

//           latitude:
//             shopLatitude,

//           longitude:
//             shopLongitude,

//         },

//         // ==================================================
//         // ACCEPTED SHOPPER
//         // ==================================================

//         shopper:
//           acceptedShopper,

//         acceptedShopper:
//           acceptedShopper,

//         assignedShopper:
//           acceptedShopper,

//         assigned_shopper:
//           acceptedShopper,

//         // ==================================================
//         // NEARBY SHOPPERS
//         // ==================================================

//         shoppers:
//           shoppers,

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET NEARBY SHOPPERS ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load nearby shoppers',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // CANCEL CUSTOMER ORDER
// // ==================================================

// const cancelCustomerOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // CHECK ORDER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             id,
//             status
//           FROM orders
//           WHERE
//             id = $1
//             AND customer_id = $2
//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // ONLY WAITING ORDERS CAN CANCEL
//       // ==================================================

//       if (
//         order.status !==
//         'waiting_for_shopper'
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'This order cannot be cancelled now',

//         });

//       }

//       // ==================================================
//       // UPDATE
//       // ==================================================

//       const updateResult =
//         await pool.query(
//           `
//           UPDATE orders

//           SET
//             status = 'cancelled',
//             updated_at = CURRENT_TIMESTAMP

//           WHERE
//             id = $1
//             AND customer_id = $2

//           RETURNING *
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       return res.status(200).json({

//         success: true,

//         message:
//           'Order cancelled successfully',

//         order:
//           updateResult.rows[0],

//       });

//     } catch (error) {

//       console.error(
//         '❌ CANCEL ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to cancel order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = {

//   createOrder,

//   getCustomerOrders,

//   getCustomerOrderById,

//   getNearbyShoppersForOrder,

//   cancelCustomerOrder,

// };



























// const pool = require('../config/db');

// // ==================================================
// // CREATE ORDER
// // ==================================================

// const createOrder = async (req, res) => {
//   const client = await pool.connect();

//   try {
//     const customerId =
//       req.customer.customerId;

//     const {
//       shopId,
//       deliveryAddress,
//       deliveryLatitude,
//       deliveryLongitude,
//       deliveryOption = 'fast',
//       paymentMethod = 'cash',
//       items = [],
//       deliveryFee = 0,
//       serviceFee = 0,
//       itemsTotal = 0,
//       totalAmount = 0,
//     } = req.body;

//     // ==================================================
//     // VALIDATION
//     // ==================================================

//     if (!shopId) {
//       return res.status(400).json({
//         success: false,
//         message: 'Shop ID is required',
//       });
//     }

//     if (!deliveryAddress) {
//       return res.status(400).json({
//         success: false,
//         message: 'Delivery address is required',
//       });
//     }

//     if (
//       deliveryLatitude === undefined ||
//       deliveryLongitude === undefined
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Delivery latitude and longitude are required',
//       });
//     }

//     const latitude =
//       Number(deliveryLatitude);

//     const longitude =
//       Number(deliveryLongitude);

//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude)
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Valid latitude and longitude are required',
//       });
//     }

//     if (
//       latitude < -90 ||
//       latitude > 90 ||
//       longitude < -180 ||
//       longitude > 180
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Latitude or longitude is out of range',
//       });
//     }

//     if (
//       !Array.isArray(items) ||
//       items.length === 0
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'At least one order item is required',
//       });
//     }

//     // ==================================================
//     // CHECK SHOP
//     // ==================================================

//     const shopResult = await client.query(
//       `
//       SELECT
//         id,
//         shop_name,
//         image_url,
//         status,
//         latitude,
//         longitude
//       FROM shops
//       WHERE id = $1
//       `,
//       [shopId]
//     );

//     if (shopResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shop not found',
//       });
//     }

//     const shop =
//       shopResult.rows[0];

//     if (
//       shop.status !== 'approved'
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'This shop is not available',
//       });
//     }

//     // ==================================================
//     // TOTALS
//     // ==================================================

//     const safeItemsTotal =
//       Number(itemsTotal) || 0;

//     const safeDeliveryFee =
//       Number(deliveryFee) || 0;

//     const safeServiceFee =
//       Number(serviceFee) || 0;

//     const safeTotalAmount =
//       Number(totalAmount) ||
//       (
//         safeItemsTotal +
//         safeDeliveryFee +
//         safeServiceFee
//       );

//     // ==================================================
//     // START TRANSACTION
//     // ==================================================

//     await client.query(
//       'BEGIN'
//     );

//     // ==================================================
//     // CREATE ORDER
//     // ==================================================

//     const orderResult =
//       await client.query(
//         `
//         INSERT INTO orders (
//           customer_id,
//           shop_id,
//           delivery_address,
//           delivery_latitude,
//           delivery_longitude,
//           delivery_option,
//           payment_method,
//           items_total,
//           delivery_fee,
//           service_fee,
//           total_amount,
//           status
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10,
//           $11,
//           $12
//         )
//         RETURNING *
//         `,
//         [
//           customerId,
//           shopId,
//           deliveryAddress,
//           latitude,
//           longitude,
//           deliveryOption,
//           paymentMethod,
//           safeItemsTotal,
//           safeDeliveryFee,
//           safeServiceFee,
//           safeTotalAmount,
//           'waiting_for_shopper',
//         ]
//       );

//     const order =
//       orderResult.rows[0];

//     // ==================================================
//     // CREATE ORDER ITEMS
//     // ==================================================

//     for (
//       const item of items
//     ) {
//       const productId =
//         item.productId ||
//         item.product_id ||
//         null;

//       const itemName =
//         item.itemName ||
//         item.item_name ||
//         item.name ||
//         item.productName ||
//         'Item';

//       const quantity =
//         Number(
//           item.quantity
//         ) || 1;

//       const amount =
//         Number(
//           item.amount
//         ) || 1;

//       const unit =
//         item.unit ||
//         item.selectedUnit ||
//         null;

//       const price =
//         Number(
//           item.price
//         ) || 0;

//       const custom =
//         item.custom === true;

//       const details =
//         item.details ||
//         null;

//       const image =
//         item.image ||
//         item.imageUrl ||
//         null;

//       await client.query(
//         `
//         INSERT INTO order_items (
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image
//         )
//         VALUES (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           $6,
//           $7,
//           $8,
//           $9,
//           $10
//         )
//         `,
//         [
//           order.id,
//           productId,
//           itemName,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,
//         ]
//       );
//     }

//     // ==================================================
//     // COMMIT
//     // ==================================================

//     await client.query(
//       'COMMIT'
//     );

//     // ==================================================
//     // GET CREATED ITEMS
//     // ==================================================

//     const createdItemsResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           order_id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image,

//           shopper_photo_url,
//           shopping_status,
//           found_quantity,
//           found_weight,
//           found_weight_unit,
//           barcode_scanned,
//           completed_at,

//           created_at
//         FROM order_items
//         WHERE order_id = $1
//         ORDER BY id ASC
//         `,
//         [order.id]
//       );

//     const createdItems =
//       createdItemsResult.rows.map(
//         (item) => ({
//           ...item,

//           shoppingStatus:
//             item.shopping_status ||
//             'pending',

//           foundQuantity:
//             item.found_quantity !== null
//               ? Number(item.found_quantity)
//               : null,

//           foundWeight:
//             item.found_weight !== null
//               ? Number(item.found_weight)
//               : null,

//           foundWeightUnit:
//             item.found_weight_unit ||
//             null,

//           barcodeScanned:
//             item.barcode_scanned === true,

//           shopperPhotoUrl:
//             item.shopper_photo_url ||
//             null,

//           completedAt:
//             item.completed_at ||
//             null,
//         })
//       );

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ ORDER CREATED'
//     );

//     console.log(
//       'ORDER ID:',
//       order.id
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     console.log(
//       'SHOP ID:',
//       shopId
//     );

//     console.log(
//       'ITEM COUNT:',
//       createdItems.length
//     );

//     console.log(
//       'ITEMS TOTAL:',
//       order.items_total
//     );

//     console.log(
//       'TOTAL AMOUNT:',
//       order.total_amount
//     );

//     console.log(
//       '===================================='
//     );

//     return res.status(201).json({
//       success: true,

//       message:
//         'Order created successfully',

//       order: {
//         ...order,

//         total:
//           Number(
//             order.total_amount
//           ),

//         totalAmount:
//           Number(
//             order.total_amount
//           ),

//         itemsTotal:
//           Number(
//             order.items_total
//           ),

//         deliveryFee:
//           Number(
//             order.delivery_fee
//           ),

//         serviceFee:
//           Number(
//             order.service_fee
//           ),

//         shop: {
//           id: shop.id,
//           name: shop.shop_name,
//           image: shop.image_url,

//           latitude:
//             Number(shop.latitude),

//           longitude:
//             Number(shop.longitude),
//         },

//         items:
//           createdItems,
//       },
//     });

//   } catch (error) {

//     try {
//       await client.query(
//         'ROLLBACK'
//       );
//     } catch (rollbackError) {
//       console.error(
//         '❌ Rollback error:',
//         rollbackError.message
//       );
//     }

//     console.error(
//       '❌ CREATE ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Failed to create order',
//       error:
//         error.message,
//     });

//   } finally {

//     client.release();

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDERS
// // ==================================================

// const getCustomerOrders = async (
//   req,
//   res
// ) => {

//   try {

//     const customerId =
//       req.customer.customerId;

//     // ==================================================
//     // GET ORDERS
//     // ==================================================

//     const ordersResult =
//       await pool.query(
//         `
//         SELECT
//           o.id,
//           o.customer_id,
//           o.shop_id,
//           o.shopper_id,

//           o.delivery_address,
//           o.delivery_latitude,
//           o.delivery_longitude,

//           o.delivery_option,
//           o.payment_method,

//           o.items_total,
//           o.delivery_fee,
//           o.service_fee,
//           o.total_amount,

//           o.status,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude,

//           sh.id AS shopper_id_joined,
//           sh.full_name AS shopper_name,
//           sh.mobile AS shopper_mobile,
//           sh.status AS shopper_status,
//           sh.latitude AS shopper_latitude,
//           sh.longitude AS shopper_longitude

//         FROM orders o

//         LEFT JOIN shops s
//           ON s.id = o.shop_id

//         LEFT JOIN shoppers sh
//           ON sh.id = o.shopper_id

//         WHERE o.customer_id = $1

//         ORDER BY
//           o.created_at DESC
//         `,
//         [customerId]
//       );

//     // ==================================================
//     // GET ITEMS FOR EACH ORDER
//     // ==================================================

//     const formattedOrders =
//       await Promise.all(
//         ordersResult.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT
//                   oi.id,
//                   oi.order_id,

//                   oi.product_id,

//                   oi.item_name,

//                   oi.quantity,
//                   oi.amount,
//                   oi.unit,
//                   oi.price,

//                   oi.custom,
//                   oi.details,
//                   oi.image,

//                   oi.shopper_photo_url,
//                   oi.shopping_status,
//                   oi.found_quantity,
//                   oi.found_weight,
//                   oi.found_weight_unit,
//                   oi.barcode_scanned,
//                   oi.completed_at,

//                   oi.created_at,

//                   COALESCE(
//                     (
//                       SELECT json_agg(
//                         json_build_object(
//                           'id', ri.id,
//                           'order_id', ri.order_id,
//                           'original_item_id', ri.original_item_id,
//                           'shopper_id', ri.shopper_id,
//                           'option_number', ri.option_number,

//                           'photo_url', ri.photo_url,
//                           'photoUrl', ri.photo_url,

//                           'replacement_photo_url', ri.photo_url,
//                           'replacementPhotoUrl', ri.photo_url,

//                           'status', ri.status,

//                           'created_at', ri.created_at,
//                           'updated_at', ri.updated_at
//                         )
//                         ORDER BY
//                           ri.option_number ASC
//                       )
//                       FROM replacement_items ri
//                       WHERE
//                         ri.order_id = oi.order_id
//                         AND ri.original_item_id = oi.id
//                     ),
//                     '[]'::json
//                   ) AS replacement_items

//                 FROM order_items oi

//                 WHERE oi.order_id = $1

//                 ORDER BY
//                   oi.id ASC
//                 `,
//                 [order.id]
//               );

//             // ==================================================
//             // FORMAT ITEMS
//             // ==================================================

//             const items =
//               itemsResult.rows.map(
//                 (item) => ({

//                   ...item,

//                   // ==================================================
//                   // REPLACEMENT ITEMS
//                   // ==================================================

//                   replacement_items:
//                     Array.isArray(
//                       item.replacement_items
//                     )
//                       ? item.replacement_items
//                       : [],

//                   replacementItems:
//                     Array.isArray(
//                       item.replacement_items
//                     )
//                       ? item.replacement_items
//                       : [],

//                   replacements:
//                     Array.isArray(
//                       item.replacement_items
//                     )
//                       ? item.replacement_items
//                       : [],

//                   // ==================================================
//                   // DATABASE FIELD
//                   // ==================================================

//                   shopping_status:
//                     item.shopping_status ||
//                     'pending',

//                   // ==================================================
//                   // FRONTEND FIELD
//                   // ==================================================

//                   shoppingStatus:
//                     item.shopping_status ||
//                     'pending',

//                   // ==================================================
//                   // FOUND QUANTITY
//                   // ==================================================

//                   found_quantity:
//                     item.found_quantity !== null
//                       ? Number(item.found_quantity)
//                       : null,

//                   foundQuantity:
//                     item.found_quantity !== null
//                       ? Number(item.found_quantity)
//                       : null,

//                   // ==================================================
//                   // FOUND WEIGHT
//                   // ==================================================

//                   found_weight:
//                     item.found_weight !== null
//                       ? Number(item.found_weight)
//                       : null,

//                   foundWeight:
//                     item.found_weight !== null
//                       ? Number(item.found_weight)
//                       : null,

//                   // ==================================================
//                   // WEIGHT UNIT
//                   // ==================================================

//                   found_weight_unit:
//                     item.found_weight_unit ||
//                     null,

//                   foundWeightUnit:
//                     item.found_weight_unit ||
//                     null,

//                   // ==================================================
//                   // BARCODE
//                   // ==================================================

//                   barcode_scanned:
//                     item.barcode_scanned === true,

//                   barcodeScanned:
//                     item.barcode_scanned === true,

//                   // ==================================================
//                   // SHOPPER PHOTO
//                   // ==================================================

//                   shopper_photo_url:
//                     item.shopper_photo_url ||
//                     null,

//                   shopperPhotoUrl:
//                     item.shopper_photo_url ||
//                     null,

//                   // ==================================================
//                   // COMPLETED TIME
//                   // ==================================================

//                   completed_at:
//                     item.completed_at ||
//                     null,

//                   completedAt:
//                     item.completed_at ||
//                     null,

//                 })
//               );

//             // ==================================================
//             // TOTAL
//             // ==================================================

//             const totalAmount =
//               Number(
//                 order.total_amount
//               ) || 0;

//             const itemsTotal =
//               Number(
//                 order.items_total
//               ) || 0;

//             const deliveryFee =
//               Number(
//                 order.delivery_fee
//               ) || 0;

//             const serviceFee =
//               Number(
//                 order.service_fee
//               ) || 0;

//             // ==================================================
//             // SHOPPER
//             // ==================================================

//             const shopper =
//               order.shopper_id
//                 ? {
//                     id:
//                       Number(
//                         order.shopper_id
//                       ),

//                     name:
//                       order.shopper_name ||
//                       'Shopper',

//                     full_name:
//                       order.shopper_name ||
//                       'Shopper',

//                     mobile:
//                       order.shopper_mobile ||
//                       null,

//                     status:
//                       order.shopper_status ||
//                       null,

//                     latitude:
//                       Number(
//                         order.shopper_latitude
//                       ),

//                     longitude:
//                       Number(
//                         order.shopper_longitude
//                       ),
//                   }
//                 : null;

//             // ==================================================
//             // RETURN
//             // ==================================================

//             return {

//               id:
//                 order.id,

//               customer_id:
//                 order.customer_id,

//               shop_id:
//                 order.shop_id,

//               shopper_id:
//                 order.shopper_id
//                   ? Number(order.shopper_id)
//                   : null,

//               delivery_address:
//                 order.delivery_address,

//               delivery_latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               delivery_longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),

//               delivery_option:
//                 order.delivery_option,

//               payment_method:
//                 order.payment_method,

//               items_total:
//                 itemsTotal,

//               delivery_fee:
//                 deliveryFee,

//               service_fee:
//                 serviceFee,

//               total_amount:
//                 totalAmount,

//               total:
//                 totalAmount,

//               totalAmount:
//                 totalAmount,

//               itemsTotal:
//                 itemsTotal,

//               deliveryFee:
//                 deliveryFee,

//               serviceFee:
//                 serviceFee,

//               status:
//                 order.status,

//               created_at:
//                 order.created_at,

//               updated_at:
//                 order.updated_at,

//               // ==================================================
//               // SHOP
//               // ==================================================

//               shop: {

//                 id:
//                   order.shop_id,

//                 name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 shop_name:
//                   order.shop_name ||
//                   'Selected Shop',

//                 image:
//                   order.shop_image ||
//                   null,

//                 image_url:
//                   order.shop_image ||
//                   null,

//                 latitude:
//                   Number(
//                     order.shop_latitude
//                   ),

//                 longitude:
//                   Number(
//                     order.shop_longitude
//                   ),

//               },

//               // ==================================================
//               // SHOPPER
//               // ==================================================

//               shopper:
//                 shopper,

//               assignedShopper:
//                 shopper,

//               assigned_shopper:
//                 shopper,

//               // ==================================================
//               // ITEMS
//               // ==================================================

//               items:
//                 items,

//               shoppingList:
//                 items,

//               orderItems:
//                 items,

//             };

//           }
//         )
//       );

//     // ==================================================
//     // DEBUG
//     // ==================================================

//     console.log(
//       '===================================='
//     );

//     console.log(
//       '📦 CUSTOMER ORDERS'
//     );

//     console.log(
//       'CUSTOMER ID:',
//       customerId
//     );

//     formattedOrders.forEach(
//       (order) => {

//         console.log(
//           `ORDER #${order.id}`
//         );

//         console.log(
//           'ITEM COUNT:',
//           order.items.length
//         );

//         console.log(
//           'ITEMS TOTAL:',
//           order.items_total
//         );

//         console.log(
//           'TOTAL:',
//           order.total_amount
//         );

//         console.log(
//           'SHOPPER ID:',
//           order.shopper_id
//         );

//         console.log(
//           'SHOPPER:',
//           order.shopper?.name ||
//           'Not assigned'
//         );

//         console.log(
//           'SHOPPING STATUS:',
//           order.items.map(
//             (item) => ({
//               id: item.id,
//               name: item.item_name,
//               status: item.shopping_status,
//             })
//           )
//         );

//         console.log(
//           'REPLACEMENTS:',
//           order.items.map(
//             (item) => ({
//               itemId: item.id,
//               itemName: item.item_name,
//               replacements:
//                 item.replacement_items?.map(
//                   (replacement) => ({
//                     id: replacement.id,
//                     photo:
//                       replacement.photo_url,
//                     status:
//                       replacement.status,
//                     option:
//                       replacement.option_number,
//                   })
//                 ) || [],
//             })
//           )
//         );

//       }
//     );

//     console.log(
//       '===================================='
//     );

//     // ==================================================
//     // RESPONSE
//     // ==================================================

//     return res.status(200).json({

//       success: true,

//       orders:
//         formattedOrders,

//     });

//   } catch (error) {

//     console.error(
//       '❌ GET CUSTOMER ORDERS ERROR:',
//       error
//     );

//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to load customer orders',

//       error:
//         error.message,

//     });

//   }
// };


// // ==================================================
// // GET CUSTOMER ORDER BY ID
// // ==================================================

// const getCustomerOrderById =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // GET ORDER + SHOP + SHOPPER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             o.*,

//             s.shop_name,
//             s.image_url AS shop_image,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             sh.id AS shopper_id_joined,
//             sh.full_name AS shopper_name,
//             sh.mobile AS shopper_mobile,
//             sh.status AS shopper_status,
//             sh.latitude AS shopper_latitude,
//             sh.longitude AS shopper_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           LEFT JOIN shoppers sh
//             ON sh.id = o.shopper_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ITEMS + REPLACEMENTS
//       // ==================================================

//       const itemsResult =
//         await pool.query(
//           `
//           SELECT
//             oi.id,
//             oi.order_id,

//             oi.product_id,

//             oi.item_name,

//             oi.quantity,
//             oi.amount,
//             oi.unit,
//             oi.price,

//             oi.custom,
//             oi.details,
//             oi.image,

//             oi.shopper_photo_url,
//             oi.shopping_status,
//             oi.found_quantity,
//             oi.found_weight,
//             oi.found_weight_unit,
//             oi.barcode_scanned,
//             oi.completed_at,

//             oi.created_at,

//             COALESCE(
//               (
//                 SELECT json_agg(
//                   json_build_object(
//                     'id', ri.id,
//                     'order_id', ri.order_id,
//                     'original_item_id', ri.original_item_id,
//                     'shopper_id', ri.shopper_id,
//                     'option_number', ri.option_number,

//                     'photo_url', ri.photo_url,
//                     'photoUrl', ri.photo_url,

//                     'replacement_photo_url', ri.photo_url,
//                     'replacementPhotoUrl', ri.photo_url,

//                     'status', ri.status,

//                     'created_at', ri.created_at,
//                     'updated_at', ri.updated_at
//                   )
//                   ORDER BY
//                     ri.option_number ASC
//                 )
//                 FROM replacement_items ri
//                 WHERE
//                   ri.order_id = oi.order_id
//                   AND ri.original_item_id = oi.id
//               ),
//               '[]'::json
//             ) AS replacement_items

//           FROM order_items oi

//           WHERE oi.order_id = $1

//           ORDER BY oi.id ASC
//           `,
//           [orderId]
//         );

//       // ==================================================
//       // FORMAT ITEMS
//       // ==================================================

//       const items =
//         itemsResult.rows.map(
//           (item) => ({

//             ...item,

//             // ==================================================
//             // REPLACEMENT ITEMS
//             // ==================================================

//             replacement_items:
//               Array.isArray(
//                 item.replacement_items
//               )
//                 ? item.replacement_items
//                 : [],

//             replacementItems:
//               Array.isArray(
//                 item.replacement_items
//               )
//                 ? item.replacement_items
//                 : [],

//             replacements:
//               Array.isArray(
//                 item.replacement_items
//               )
//                 ? item.replacement_items
//                 : [],

//             // ==================================================
//             // SHOPPING STATUS
//             // ==================================================

//             shopping_status:
//               item.shopping_status ||
//               'pending',

//             shoppingStatus:
//               item.shopping_status ||
//               'pending',

//             // ==================================================
//             // FOUND QUANTITY
//             // ==================================================

//             found_quantity:
//               item.found_quantity !== null
//                 ? Number(item.found_quantity)
//                 : null,

//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(item.found_quantity)
//                 : null,

//             // ==================================================
//             // FOUND WEIGHT
//             // ==================================================

//             found_weight:
//               item.found_weight !== null
//                 ? Number(item.found_weight)
//                 : null,

//             foundWeight:
//               item.found_weight !== null
//                 ? Number(item.found_weight)
//                 : null,

//             // ==================================================
//             // WEIGHT UNIT
//             // ==================================================

//             found_weight_unit:
//               item.found_weight_unit ||
//               null,

//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,

//             // ==================================================
//             // BARCODE
//             // ==================================================

//             barcode_scanned:
//               item.barcode_scanned === true,

//             barcodeScanned:
//               item.barcode_scanned === true,

//             // ==================================================
//             // SHOPPER PHOTO
//             // ==================================================

//             shopper_photo_url:
//               item.shopper_photo_url ||
//               null,

//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,

//             // ==================================================
//             // COMPLETED TIME
//             // ==================================================

//             completed_at:
//               item.completed_at ||
//               null,

//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         );

//       // ==================================================
//       // TOTALS
//       // ==================================================

//       const totalAmount =
//         Number(
//           order.total_amount
//         ) || 0;

//       const itemsTotal =
//         Number(
//           order.items_total
//         ) || 0;

//       const deliveryFee =
//         Number(
//           order.delivery_fee
//         ) || 0;

//       const serviceFee =
//         Number(
//           order.service_fee
//         ) || 0;

//       // ==================================================
//       // SHOPPER
//       // ==================================================

//       const shopper =
//         order.shopper_id
//           ? {
//               id:
//                 Number(
//                   order.shopper_id
//                 ),

//               name:
//                 order.shopper_name ||
//                 'Shopper',

//               full_name:
//                 order.shopper_name ||
//                 'Shopper',

//               mobile:
//                 order.shopper_mobile ||
//                 null,

//               status:
//                 order.shopper_status ||
//                 null,

//               latitude:
//                 Number(
//                   order.shopper_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.shopper_longitude
//                 ),
//           }
//         : null;

//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '📦 CUSTOMER ORDER'
//       );

//       console.log(
//         'ORDER ID:',
//         order.id
//       );

//       console.log(
//         'STATUS:',
//         order.status
//       );

//       console.log(
//         'SHOPPER ID:',
//         order.shopper_id
//       );

//       console.log(
//         'SHOPPER:',
//         shopper?.name ||
//         'Not assigned'
//       );

//       console.log(
//         'SHOPPER LOCATION:',
//         shopper
//           ? `${shopper.latitude}, ${shopper.longitude}`
//           : 'Not available'
//       );

//       console.log(
//         'ITEM SHOPPING STATUS:',
//         items.map(
//           (item) => ({
//             id: item.id,
//             name: item.item_name,
//             status: item.shopping_status,
//             foundQuantity:
//               item.found_quantity,
//             foundWeight:
//               item.found_weight,
//             photo:
//               item.shopper_photo_url,
//             completedAt:
//               item.completed_at,
//           })
//         )
//       );

//       console.log(
//         'REPLACEMENT ITEMS:',
//         items.map(
//           (item) => ({
//             itemId: item.id,
//             itemName: item.item_name,
//             replacements:
//               item.replacement_items?.map(
//                 (replacement) => ({
//                   id: replacement.id,
//                   originalItemId:
//                     replacement.original_item_id,
//                   option:
//                     replacement.option_number,
//                   photo:
//                     replacement.photo_url,
//                   status:
//                     replacement.status,
//                 })
//               ) || [],
//           })
//         )
//       );

//       console.log(
//         '===================================='
//       );

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         order: {

//           ...order,

//           delivery_latitude:
//             Number(
//               order.delivery_latitude
//             ),

//           delivery_longitude:
//             Number(
//               order.delivery_longitude
//             ),

//           items_total:
//             itemsTotal,

//           delivery_fee:
//             deliveryFee,

//           service_fee:
//             serviceFee,

//           total_amount:
//             totalAmount,

//           total:
//             totalAmount,

//           totalAmount:
//             totalAmount,

//           itemsTotal:
//             itemsTotal,

//           deliveryFee:
//             deliveryFee,

//           serviceFee:
//             serviceFee,

//           // ==================================================
//           // SHOP
//           // ==================================================

//           shop: {

//             id:
//               order.shop_id,

//             name:
//               order.shop_name ||
//               'Selected Shop',

//             shop_name:
//               order.shop_name ||
//               'Selected Shop',

//             image:
//               order.shop_image ||
//               null,

//             image_url:
//               order.shop_image ||
//               null,

//             latitude:
//               Number(
//                 order.shop_latitude
//               ),

//             longitude:
//               Number(
//                 order.shop_longitude
//               ),

//           },

//           // ==================================================
//           // SHOPPER
//           // ==================================================

//           shopper:
//             shopper,

//           assignedShopper:
//             shopper,

//           assigned_shopper:
//             shopper,

//           // ==================================================
//           // ITEMS
//           // ==================================================

//           items:
//             items,

//           shoppingList:
//             items,

//           orderItems:
//             items,

//         },

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET CUSTOMER ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // GET NEARBY ONLINE SHOPPERS FOR ORDER
// // ==================================================

// const getNearbyShoppersForOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       // ==================================================
//       // VALIDATE ORDER ID
//       // ==================================================

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // GET ORDER + SHOP LOCATION
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,
//             o.status,
//             o.shopper_id,

//             s.shop_name,

//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude

//           FROM orders o

//           LEFT JOIN shops s
//             ON s.id = o.shop_id

//           WHERE
//             o.id = $1
//             AND o.customer_id = $2

//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       // ==================================================
//       // ORDER NOT FOUND
//       // ==================================================

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // GET ACCEPTED SHOPPER
//       // ==================================================

//       let acceptedShopper = null;

//       if (order.shopper_id) {

//         const acceptedShopperResult =
//           await pool.query(
//             `
//             SELECT
//               id,
//               full_name,
//               mobile,
//               status,
//               latitude,
//               longitude
//             FROM shoppers
//             WHERE id = $1
//             LIMIT 1
//             `,
//             [
//               order.shopper_id,
//             ]
//           );

//         if (
//           acceptedShopperResult.rows.length > 0
//         ) {

//           const shopper =
//             acceptedShopperResult.rows[0];

//           acceptedShopper = {

//             id:
//               Number(
//                 shopper.id
//               ),

//             name:
//               shopper.full_name ||
//               'Shopper',

//             full_name:
//               shopper.full_name ||
//               'Shopper',

//             mobile:
//               shopper.mobile ||
//               null,

//             status:
//               shopper.status ||
//               null,

//             latitude:
//               Number(
//                 shopper.latitude
//               ),

//             longitude:
//               Number(
//                 shopper.longitude
//               ),

//           };

//         }

//       }

//       // ==================================================
//       // CHECK SHOP LOCATION
//       // ==================================================

//       const shopLatitude =
//         Number(
//           order.shop_latitude
//         );

//       const shopLongitude =
//         Number(
//           order.shop_longitude
//         );

//       if (
//         !Number.isFinite(
//           shopLatitude
//         ) ||
//         !Number.isFinite(
//           shopLongitude
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Shop location is not available',

//         });

//       }

//       // ==================================================
//       // GET ONLINE SHOPPERS
//       // ==================================================

//       const shoppersResult =
//         await pool.query(
//           `
//           SELECT

//             sh.id,

//             sh.full_name,

//             sh.mobile,

//             sh.status,

//             sh.latitude,

//             sh.longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,
//                     cos(
//                       radians($1)
//                     ) *
//                     cos(
//                       radians(sh.latitude)
//                     ) *
//                     cos(
//                       radians(sh.longitude) -
//                       radians($2)
//                     ) +
//                     sin(
//                       radians($1)
//                     ) *
//                     sin(
//                       radians(sh.latitude)
//                     )
//                   )
//                 )
//               )
//             ) AS distance_km

//           FROM shoppers sh

//           WHERE
//             sh.status = 'online'

//             AND sh.latitude IS NOT NULL

//             AND sh.longitude IS NOT NULL

//             AND sh.latitude BETWEEN -90 AND 90

//             AND sh.longitude BETWEEN -180 AND 180

//           ORDER BY
//             distance_km ASC
//           `,
//           [
//             shopLatitude,
//             shopLongitude,
//           ]
//         );

//       // ==================================================
//       // ONLY 10 KM
//       // ==================================================

//       const shoppers =
//         shoppersResult.rows

//           .filter(
//             (shopper) => {

//               const distance =
//                 Number(
//                   shopper.distance_km
//                 );

//               return (
//                 Number.isFinite(distance) &&
//                 distance <= 10
//               );

//             }
//           )

//           .map(
//             (shopper) => ({

//               id:
//                 shopper.id,

//               name:
//                 shopper.full_name,

//               full_name:
//                 shopper.full_name,

//               mobile:
//                 shopper.mobile,

//               status:
//                 shopper.status,

//               latitude:
//                 Number(
//                   shopper.latitude
//                 ),

//               longitude:
//                 Number(
//                   shopper.longitude
//                 ),

//               distance_km:
//                 Number(
//                   shopper.distance_km
//                 ),

//             })
//           );

//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '📍 NEARBY ONLINE SHOPPERS'
//       );

//       console.log(
//         'ORDER ID:',
//         orderId
//       );

//       console.log(
//         'SHOP ID:',
//         order.shop_id
//       );

//       console.log(
//         'SHOP:',
//         order.shop_name
//       );

//       console.log(
//         'SHOP LOCATION:',
//         shopLatitude,
//         shopLongitude
//       );

//       console.log(
//         'ORDER STATUS:',
//         order.status
//       );

//       console.log(
//         'ACCEPTED SHOPPER:',
//         acceptedShopper
//       );

//       console.log(
//         'ONLINE SHOPPERS:',
//         shoppers.length
//       );

//       shoppers.forEach(
//         (shopper) => {

//           console.log(
//             '--------------------------------'
//           );

//           console.log(
//             'SHOPPER ID:',
//             shopper.id
//           );

//           console.log(
//             'SHOPPER NAME:',
//             shopper.name
//           );

//           console.log(
//             'STATUS:',
//             shopper.status
//           );

//           console.log(
//             'LOCATION:',
//             shopper.latitude,
//             shopper.longitude
//           );

//           console.log(
//             'DISTANCE:',
//             shopper.distance_km,
//             'KM'
//           );

//         }
//       );

//       console.log(
//         '===================================='
//       );

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         orderId:
//           order.id,

//         orderStatus:
//           order.status,

//         shop: {

//           id:
//             order.shop_id,

//           name:
//             order.shop_name ||
//             'Selected Shop',

//           latitude:
//             shopLatitude,

//           longitude:
//             shopLongitude,

//         },

//         // ==================================================
//         // ACCEPTED SHOPPER
//         // ==================================================

//         shopper:
//           acceptedShopper,

//         acceptedShopper:
//           acceptedShopper,

//         assignedShopper:
//           acceptedShopper,

//         assigned_shopper:
//           acceptedShopper,

//         // ==================================================
//         // NEARBY SHOPPERS
//         // ==================================================

//         shoppers:
//           shoppers,

//       });

//     } catch (error) {

//       console.error(
//         '❌ GET NEARBY SHOPPERS ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to load nearby shoppers',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // CANCEL CUSTOMER ORDER
// // ==================================================

// const cancelCustomerOrder =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       if (
//         !Number.isInteger(
//           orderId
//         )
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order ID',

//         });

//       }

//       // ==================================================
//       // CHECK ORDER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             id,
//             status
//           FROM orders
//           WHERE
//             id = $1
//             AND customer_id = $2
//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       const order =
//         orderResult.rows[0];

//       // ==================================================
//       // ONLY WAITING ORDERS CAN CANCEL
//       // ==================================================

//       if (
//         order.status !==
//         'waiting_for_shopper'
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'This order cannot be cancelled now',

//         });

//       }

//       // ==================================================
//       // UPDATE
//       // ==================================================

//       const updateResult =
//         await pool.query(
//           `
//           UPDATE orders

//           SET
//             status = 'cancelled',
//             updated_at = CURRENT_TIMESTAMP

//           WHERE
//             id = $1
//             AND customer_id = $2

//           RETURNING *
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       return res.status(200).json({

//         success: true,

//         message:
//           'Order cancelled successfully',

//         order:
//           updateResult.rows[0],

//       });

//     } catch (error) {

//       console.error(
//         '❌ CANCEL ORDER ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to cancel order',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // UPDATE REPLACEMENT STATUS
// // ==================================================

// const updateReplacementStatus =
//   async (
//     req,
//     res
//   ) => {

//     try {

//       const customerId =
//         req.customer.customerId;

//       const orderId =
//         Number(
//           req.params.orderId
//         );

//       const itemId =
//         Number(
//           req.params.itemId
//         );

//       const replacementId =
//         Number(
//           req.params.replacementId
//         );

//       const {
//         status
//       } = req.body;

//       // ==================================================
//       // VALIDATE IDS
//       // ==================================================

//       if (
//         !Number.isInteger(orderId) ||
//         !Number.isInteger(itemId) ||
//         !Number.isInteger(replacementId)
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Invalid order, item, or replacement ID',

//         });

//       }

//       // ==================================================
//       // VALIDATE STATUS
//       // ==================================================

//       if (
//         status !== 'accepted' &&
//         status !== 'rejected'
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'Status must be accepted or rejected',

//         });

//       }

//       // ==================================================
//       // CHECK ORDER BELONGS TO CUSTOMER
//       // ==================================================

//       const orderResult =
//         await pool.query(
//           `
//           SELECT
//             id,
//             customer_id
//           FROM orders
//           WHERE
//             id = $1
//             AND customer_id = $2
//           LIMIT 1
//           `,
//           [
//             orderId,
//             customerId,
//           ]
//         );

//       if (
//         orderResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order not found',

//         });

//       }

//       // ==================================================
//       // CHECK ORDER ITEM
//       // ==================================================

//       const itemResult =
//         await pool.query(
//           `
//           SELECT
//             id,
//             order_id,
//             item_name
//           FROM order_items
//           WHERE
//             id = $1
//             AND order_id = $2
//           LIMIT 1
//           `,
//           [
//             itemId,
//             orderId,
//           ]
//         );

//       if (
//         itemResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Order item not found',

//         });

//       }

//       const item =
//         itemResult.rows[0];

//       // ==================================================
//       // CHECK REPLACEMENT
//       // ==================================================

//       const replacementResult =
//         await pool.query(
//           `
//           SELECT
//             id,
//             order_id,
//             original_item_id,
//             shopper_id,
//             option_number,
//             photo_url,
//             status,
//             created_at,
//             updated_at
//           FROM replacement_items
//           WHERE
//             id = $1
//             AND order_id = $2
//             AND original_item_id = $3
//           LIMIT 1
//           `,
//           [
//             replacementId,
//             orderId,
//             itemId,
//           ]
//         );

//       if (
//         replacementResult.rows.length === 0
//       ) {

//         return res.status(404).json({

//           success: false,

//           message:
//             'Replacement item not found',

//         });

//       }

//       const replacement =
//         replacementResult.rows[0];

//       // ==================================================
//       // ONLY WAITING CUSTOMER REPLACEMENTS
//       // ==================================================

//       if (
//         replacement.status !==
//         'waiting_customer'
//       ) {

//         return res.status(400).json({

//           success: false,

//           message:
//             'This replacement has already been processed',

//           status:
//             replacement.status,

//         });

//       }

//       // ==================================================
//       // UPDATE REPLACEMENT
//       // ==================================================

//       const updateResult =
//         await pool.query(
//           `
//           UPDATE replacement_items

//           SET
//             status = $1,
//             updated_at = CURRENT_TIMESTAMP

//           WHERE
//             id = $2
//             AND order_id = $3
//             AND original_item_id = $4

//           RETURNING
//             id,
//             order_id,
//             original_item_id,
//             shopper_id,
//             option_number,
//             photo_url,
//             status,
//             created_at,
//             updated_at
//           `,
//           [
//             status,
//             replacementId,
//             orderId,
//             itemId,
//           ]
//         );

//       const updatedReplacement =
//         updateResult.rows[0];

//       // ==================================================
//       // DEBUG
//       // ==================================================

//       console.log(
//         '===================================='
//       );

//       console.log(
//         '🔄 REPLACEMENT STATUS UPDATED'
//       );

//       console.log(
//         'CUSTOMER ID:',
//         customerId
//       );

//       console.log(
//         'ORDER ID:',
//         orderId
//       );

//       console.log(
//         'ITEM ID:',
//         itemId
//       );

//       console.log(
//         'ITEM:',
//         item.item_name
//       );

//       console.log(
//         'REPLACEMENT ID:',
//         replacementId
//       );

//       console.log(
//         'OPTION:',
//         replacement.option_number
//       );

//       console.log(
//         'OLD STATUS:',
//         replacement.status
//       );

//       console.log(
//         'NEW STATUS:',
//         updatedReplacement.status
//       );

//       console.log(
//         '===================================='
//       );

//       // ==================================================
//       // RESPONSE
//       // ==================================================

//       return res.status(200).json({

//         success: true,

//         message:
//           status === 'accepted'
//             ? 'Replacement accepted successfully'
//             : 'Replacement rejected successfully',

//         replacement: {

//           id:
//             updatedReplacement.id,

//           orderId:
//             updatedReplacement.order_id,

//           originalItemId:
//             updatedReplacement.original_item_id,

//           shopperId:
//             updatedReplacement.shopper_id,

//           optionNumber:
//             updatedReplacement.option_number,

//           photoUrl:
//             updatedReplacement.photo_url,

//           photo_url:
//             updatedReplacement.photo_url,

//           replacementPhotoUrl:
//             updatedReplacement.photo_url,

//           replacement_photo_url:
//             updatedReplacement.photo_url,

//           status:
//             updatedReplacement.status,

//           createdAt:
//             updatedReplacement.created_at,

//           updatedAt:
//             updatedReplacement.updated_at,

//         },

//       });

//     } catch (error) {

//       console.error(
//         '❌ UPDATE REPLACEMENT STATUS ERROR:',
//         error
//       );

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to update replacement status',

//         error:
//           error.message,

//       });

//     }

//   };


// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = {

//   createOrder,

//   getCustomerOrders,

//   getCustomerOrderById,

//   getNearbyShoppersForOrder,

//   cancelCustomerOrder,

//   updateReplacementStatus,

// };













const pool = require('../config/db');

// ==================================================
// CREATE ORDER
// ==================================================

const createOrder = async (req, res) => {
  const client = await pool.connect();

  try {
    const customerId =
      req.customer.customerId;

    const {
      shopId,
      deliveryAddress,
      deliveryLatitude,
      deliveryLongitude,
      deliveryOption = 'fast',
      paymentMethod = 'cash',
      items = [],
      deliveryFee = 0,
      serviceFee = 0,
      itemsTotal = 0,
      totalAmount = 0,
    } = req.body;

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: 'Shop ID is required',
      });
    }

    if (!deliveryAddress) {
      return res.status(400).json({
        success: false,
        message: 'Delivery address is required',
      });
    }

    if (
      deliveryLatitude === undefined ||
      deliveryLongitude === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Delivery latitude and longitude are required',
      });
    }

    const latitude =
      Number(deliveryLatitude);

    const longitude =
      Number(deliveryLongitude);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Valid latitude and longitude are required',
      });
    }

    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Latitude or longitude is out of range',
      });
    }

    if (
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          'At least one order item is required',
      });
    }

    // ==================================================
    // CHECK SHOP
    // ==================================================

    const shopResult = await client.query(
      `
      SELECT
        id,
        shop_name,
        image_url,
        status,
        latitude,
        longitude
      FROM shops
      WHERE id = $1
      `,
      [shopId]
    );

    if (shopResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Shop not found',
      });
    }

    const shop =
      shopResult.rows[0];

    if (
      shop.status !== 'approved'
    ) {
      return res.status(400).json({
        success: false,
        message:
          'This shop is not available',
      });
    }

    // ==================================================
    // TOTALS
    // ==================================================

    const safeItemsTotal =
      Number(itemsTotal) || 0;

    const safeDeliveryFee =
      Number(deliveryFee) || 0;

    const safeServiceFee =
      Number(serviceFee) || 0;

    const safeTotalAmount =
      Number(totalAmount) ||
      (
        safeItemsTotal +
        safeDeliveryFee +
        safeServiceFee
      );

    // ==================================================
    // START TRANSACTION
    // ==================================================

    await client.query(
      'BEGIN'
    );

    // ==================================================
    // CREATE ORDER
    // ==================================================

    const orderResult =
      await client.query(
        `
        INSERT INTO orders (
          customer_id,
          shop_id,
          delivery_address,
          delivery_latitude,
          delivery_longitude,
          delivery_option,
          payment_method,
          items_total,
          delivery_fee,
          service_fee,
          total_amount,
          status
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12
        )
        RETURNING *
        `,
        [
          customerId,
          shopId,
          deliveryAddress,
          latitude,
          longitude,
          deliveryOption,
          paymentMethod,
          safeItemsTotal,
          safeDeliveryFee,
          safeServiceFee,
          safeTotalAmount,
          'waiting_for_shopper',
        ]
      );

    const order =
      orderResult.rows[0];

    // ==================================================
    // CREATE ORDER ITEMS
    // ==================================================

    for (
      const item of items
    ) {
      const productId =
        item.productId ||
        item.product_id ||
        null;

      const itemName =
        item.itemName ||
        item.item_name ||
        item.name ||
        item.productName ||
        'Item';

      const quantity =
        Number(
          item.quantity
        ) || 1;

      const amount =
        Number(
          item.amount
        ) || 1;

      const unit =
        item.unit ||
        item.selectedUnit ||
        null;

      const price =
        Number(
          item.price
        ) || 0;

      const custom =
        item.custom === true;

      const details =
        item.details ||
        null;

      const image =
        item.image ||
        item.imageUrl ||
        null;

      await client.query(
        `
        INSERT INTO order_items (
          order_id,
          product_id,
          item_name,
          quantity,
          amount,
          unit,
          price,
          custom,
          details,
          image
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10
        )
        `,
        [
          order.id,
          productId,
          itemName,
          quantity,
          amount,
          unit,
          price,
          custom,
          details,
          image,
        ]
      );
    }

    // ==================================================
    // COMMIT
    // ==================================================

    await client.query(
      'COMMIT'
    );

    // ==================================================
    // GET CREATED ITEMS
    // ==================================================

    const createdItemsResult =
      await pool.query(
        `
        SELECT
          id,
          order_id,
          product_id,
          item_name,
          quantity,
          amount,
          unit,
          price,
          custom,
          details,
          image,

          shopper_photo_url,
          shopping_status,
          found_quantity,
          found_weight,
          found_weight_unit,
          barcode_scanned,
          completed_at,

          created_at
        FROM order_items
        WHERE order_id = $1
        ORDER BY id ASC
        `,
        [order.id]
      );

    const createdItems =
      createdItemsResult.rows.map(
        (item) => ({
          ...item,

          shoppingStatus:
            item.shopping_status ||
            'pending',

          foundQuantity:
            item.found_quantity !== null
              ? Number(item.found_quantity)
              : null,

          foundWeight:
            item.found_weight !== null
              ? Number(item.found_weight)
              : null,

          foundWeightUnit:
            item.found_weight_unit ||
            null,

          barcodeScanned:
            item.barcode_scanned === true,

          shopperPhotoUrl:
            item.shopper_photo_url ||
            null,

          completedAt:
            item.completed_at ||
            null,
        })
      );

    // ==================================================
    // RESPONSE
    // ==================================================

    console.log(
      '===================================='
    );

    console.log(
      '✅ ORDER CREATED'
    );

    console.log(
      'ORDER ID:',
      order.id
    );

    console.log(
      'CUSTOMER ID:',
      customerId
    );

    console.log(
      'SHOP ID:',
      shopId
    );

    console.log(
      'ITEM COUNT:',
      createdItems.length
    );

    console.log(
      'ITEMS TOTAL:',
      order.items_total
    );

    console.log(
      'TOTAL AMOUNT:',
      order.total_amount
    );

    console.log(
      '===================================='
    );

    return res.status(201).json({
      success: true,

      message:
        'Order created successfully',

      order: {
        ...order,

        total:
          Number(
            order.total_amount
          ),

        totalAmount:
          Number(
            order.total_amount
          ),

        itemsTotal:
          Number(
            order.items_total
          ),

        deliveryFee:
          Number(
            order.delivery_fee
          ),

        serviceFee:
          Number(
            order.service_fee
          ),

        shop: {
          id: shop.id,
          name: shop.shop_name,
          image: shop.image_url,

          latitude:
            Number(shop.latitude),

          longitude:
            Number(shop.longitude),
        },

        items:
          createdItems,
      },
    });

  } catch (error) {

    try {
      await client.query(
        'ROLLBACK'
      );
    } catch (rollbackError) {
      console.error(
        '❌ Rollback error:',
        rollbackError.message
      );
    }

    console.error(
      '❌ CREATE ORDER ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Failed to create order',
      error:
        error.message,
    });

  } finally {

    client.release();

  }
};


// ==================================================
// GET CUSTOMER ORDERS
// ==================================================

const getCustomerOrders = async (
  req,
  res
) => {

  try {

    const customerId =
      req.customer.customerId;

    // ==================================================
    // GET ORDERS
    // ==================================================

    const ordersResult =
      await pool.query(
        `
        SELECT
          o.id,
          o.customer_id,
          o.shop_id,
          o.shopper_id,

          o.delivery_address,
          o.delivery_latitude,
          o.delivery_longitude,

          o.delivery_option,
          o.payment_method,

          o.items_total,
          o.delivery_fee,
          o.service_fee,
          o.total_amount,

          o.status,

          o.created_at,
          o.updated_at,

          s.shop_name,
          s.image_url AS shop_image,

          s.latitude AS shop_latitude,
          s.longitude AS shop_longitude,

          sh.id AS shopper_id_joined,
          sh.full_name AS shopper_name,
          sh.mobile AS shopper_mobile,
          sh.status AS shopper_status,
          sh.latitude AS shopper_latitude,
          sh.longitude AS shopper_longitude

        FROM orders o

        LEFT JOIN shops s
          ON s.id = o.shop_id

        LEFT JOIN shoppers sh
          ON sh.id = o.shopper_id

        WHERE o.customer_id = $1

        ORDER BY
          o.created_at DESC
        `,
        [customerId]
      );

    // ==================================================
    // GET ITEMS FOR EACH ORDER
    // ==================================================

    const formattedOrders =
      await Promise.all(
        ordersResult.rows.map(
          async (order) => {

            const itemsResult =
              await pool.query(
                `
                SELECT
                  oi.id,
                  oi.order_id,

                  oi.product_id,

                  oi.item_name,

                  oi.quantity,
                  oi.amount,
                  oi.unit,
                  oi.price,

                  oi.custom,
                  oi.details,
                  oi.image,

                  oi.shopper_photo_url,
                  oi.shopping_status,
                  oi.found_quantity,
                  oi.found_weight,
                  oi.found_weight_unit,
                  oi.barcode_scanned,
                  oi.completed_at,

                  oi.created_at,

                  COALESCE(
                    (
                      SELECT json_agg(
                        json_build_object(
                          'id', ri.id,
                          'order_id', ri.order_id,
                          'original_item_id', ri.original_item_id,
                          'shopper_id', ri.shopper_id,
                          'option_number', ri.option_number,

                          'photo_url', ri.photo_url,
                          'photoUrl', ri.photo_url,

                          'replacement_photo_url', ri.photo_url,
                          'replacementPhotoUrl', ri.photo_url,

                          'status', ri.status,

                          'created_at', ri.created_at,
                          'updated_at', ri.updated_at
                        )
                        ORDER BY
                          ri.option_number ASC
                      )
                      FROM replacement_items ri
                      WHERE
                        ri.order_id = oi.order_id
                        AND ri.original_item_id = oi.id
                    ),
                    '[]'::json
                  ) AS replacement_items

                FROM order_items oi

                WHERE oi.order_id = $1

                ORDER BY
                  oi.id ASC
                `,
                [order.id]
              );

            // ==================================================
            // FORMAT ITEMS
            // ==================================================

            const items =
              itemsResult.rows.map(
                (item) => ({

                  ...item,

                  // ==================================================
                  // REPLACEMENT ITEMS
                  // ==================================================

                  replacement_items:
                    Array.isArray(
                      item.replacement_items
                    )
                      ? item.replacement_items
                      : [],

                  replacementItems:
                    Array.isArray(
                      item.replacement_items
                    )
                      ? item.replacement_items
                      : [],

                  replacements:
                    Array.isArray(
                      item.replacement_items
                    )
                      ? item.replacement_items
                      : [],

                  // ==================================================
                  // DATABASE FIELD
                  // ==================================================

                  shopping_status:
                    item.shopping_status ||
                    'pending',

                  // ==================================================
                  // FRONTEND FIELD
                  // ==================================================

                  shoppingStatus:
                    item.shopping_status ||
                    'pending',

                  // ==================================================
                  // FOUND QUANTITY
                  // ==================================================

                  found_quantity:
                    item.found_quantity !== null
                      ? Number(item.found_quantity)
                      : null,

                  foundQuantity:
                    item.found_quantity !== null
                      ? Number(item.found_quantity)
                      : null,

                  // ==================================================
                  // FOUND WEIGHT
                  // ==================================================

                  found_weight:
                    item.found_weight !== null
                      ? Number(item.found_weight)
                      : null,

                  foundWeight:
                    item.found_weight !== null
                      ? Number(item.found_weight)
                      : null,

                  // ==================================================
                  // WEIGHT UNIT
                  // ==================================================

                  found_weight_unit:
                    item.found_weight_unit ||
                    null,

                  foundWeightUnit:
                    item.found_weight_unit ||
                    null,

                  // ==================================================
                  // BARCODE
                  // ==================================================

                  barcode_scanned:
                    item.barcode_scanned === true,

                  barcodeScanned:
                    item.barcode_scanned === true,

                  // ==================================================
                  // SHOPPER PHOTO
                  // ==================================================

                  shopper_photo_url:
                    item.shopper_photo_url ||
                    null,

                  shopperPhotoUrl:
                    item.shopper_photo_url ||
                    null,

                  // ==================================================
                  // COMPLETED TIME
                  // ==================================================

                  completed_at:
                    item.completed_at ||
                    null,

                  completedAt:
                    item.completed_at ||
                    null,

                })
              );

            // ==================================================
            // TOTAL
            // ==================================================

            const totalAmount =
              Number(
                order.total_amount
              ) || 0;

            const itemsTotal =
              Number(
                order.items_total
              ) || 0;

            const deliveryFee =
              Number(
                order.delivery_fee
              ) || 0;

            const serviceFee =
              Number(
                order.service_fee
              ) || 0;

            // ==================================================
            // SHOPPER
            // ==================================================

            const shopper =
              order.shopper_id
                ? {
                    id:
                      Number(
                        order.shopper_id
                      ),

                    name:
                      order.shopper_name ||
                      'Shopper',

                    full_name:
                      order.shopper_name ||
                      'Shopper',

                    mobile:
                      order.shopper_mobile ||
                      null,

                    status:
                      order.shopper_status ||
                      null,

                    latitude:
                      Number(
                        order.shopper_latitude
                      ),

                    longitude:
                      Number(
                        order.shopper_longitude
                      ),
                  }
                : null;

            // ==================================================
            // RETURN
            // ==================================================

            return {

              id:
                order.id,

              customer_id:
                order.customer_id,

              shop_id:
                order.shop_id,

              shopper_id:
                order.shopper_id
                  ? Number(order.shopper_id)
                  : null,

              delivery_address:
                order.delivery_address,

              delivery_latitude:
                Number(
                  order.delivery_latitude
                ),

              delivery_longitude:
                Number(
                  order.delivery_longitude
                ),

              delivery_option:
                order.delivery_option,

              payment_method:
                order.payment_method,

              items_total:
                itemsTotal,

              delivery_fee:
                deliveryFee,

              service_fee:
                serviceFee,

              total_amount:
                totalAmount,

              total:
                totalAmount,

              totalAmount:
                totalAmount,

              itemsTotal:
                itemsTotal,

              deliveryFee:
                deliveryFee,

              serviceFee:
                serviceFee,

              status:
                order.status,

              created_at:
                order.created_at,

              updated_at:
                order.updated_at,

              // ==================================================
              // SHOP
              // ==================================================

              shop: {

                id:
                  order.shop_id,

                name:
                  order.shop_name ||
                  'Selected Shop',

                shop_name:
                  order.shop_name ||
                  'Selected Shop',

                image:
                  order.shop_image ||
                  null,

                image_url:
                  order.shop_image ||
                  null,

                latitude:
                  Number(
                    order.shop_latitude
                  ),

                longitude:
                  Number(
                    order.shop_longitude
                  ),

              },

              // ==================================================
              // SHOPPER
              // ==================================================

              shopper:
                shopper,

              assignedShopper:
                shopper,

              assigned_shopper:
                shopper,

              // ==================================================
              // ITEMS
              // ==================================================

              items:
                items,

              shoppingList:
                items,

              orderItems:
                items,

            };

          }
        )
      );

    // ==================================================
    // DEBUG
    // ==================================================

    console.log(
      '===================================='
    );

    console.log(
      '📦 CUSTOMER ORDERS'
    );

    console.log(
      'CUSTOMER ID:',
      customerId
    );

    formattedOrders.forEach(
      (order) => {

        console.log(
          `ORDER #${order.id}`
        );

        console.log(
          'ITEM COUNT:',
          order.items.length
        );

        console.log(
          'ITEMS TOTAL:',
          order.items_total
        );

        console.log(
          'TOTAL:',
          order.total_amount
        );

        console.log(
          'SHOPPER ID:',
          order.shopper_id
        );

        console.log(
          'SHOPPER:',
          order.shopper?.name ||
          'Not assigned'
        );

        console.log(
          'SHOPPING STATUS:',
          order.items.map(
            (item) => ({
              id: item.id,
              name: item.item_name,
              status: item.shopping_status,
            })
          )
        );

        console.log(
          'REPLACEMENTS:',
          order.items.map(
            (item) => ({
              itemId: item.id,
              itemName: item.item_name,
              replacements:
                item.replacement_items?.map(
                  (replacement) => ({
                    id: replacement.id,
                    photo:
                      replacement.photo_url,
                    status:
                      replacement.status,
                    option:
                      replacement.option_number,
                  })
                ) || [],
            })
          )
        );

      }
    );

    console.log(
      '===================================='
    );

    // ==================================================
    // RESPONSE
    // ==================================================

    return res.status(200).json({

      success: true,

      orders:
        formattedOrders,

    });

  } catch (error) {

    console.error(
      '❌ GET CUSTOMER ORDERS ERROR:',
      error
    );

    return res.status(500).json({

      success: false,

      message:
        'Failed to load customer orders',

      error:
        error.message,

    });

  }

};


// ==================================================
// GET CUSTOMER ORDER BY ID
// ==================================================

const getCustomerOrderById =
  async (
    req,
    res
  ) => {

    try {

      const customerId =
        req.customer.customerId;

      const orderId =
        Number(
          req.params.orderId
        );

      if (
        !Number.isInteger(
          orderId
        )
      ) {

        return res.status(400).json({

          success: false,

          message:
            'Invalid order ID',

        });

      }

      // ==================================================
      // GET ORDER + SHOP + SHOPPER
      // ==================================================

      const orderResult =
        await pool.query(
          `
          SELECT
            o.*,

            s.shop_name,
            s.image_url AS shop_image,

            s.latitude AS shop_latitude,
            s.longitude AS shop_longitude,

            sh.id AS shopper_id_joined,
            sh.full_name AS shopper_name,
            sh.mobile AS shopper_mobile,
            sh.status AS shopper_status,
            sh.latitude AS shopper_latitude,
            sh.longitude AS shopper_longitude

          FROM orders o

          LEFT JOIN shops s
            ON s.id = o.shop_id

          LEFT JOIN shoppers sh
            ON sh.id = o.shopper_id

          WHERE
            o.id = $1
            AND o.customer_id = $2

          LIMIT 1
          `,
          [
            orderId,
            customerId,
          ]
        );

      if (
        orderResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            'Order not found',

        });

      }

      const order =
        orderResult.rows[0];

      // ==================================================
      // GET ITEMS + REPLACEMENTS
      // ==================================================

      const itemsResult =
        await pool.query(
          `
          SELECT
            oi.id,
            oi.order_id,

            oi.product_id,

            oi.item_name,

            oi.quantity,
            oi.amount,
            oi.unit,
            oi.price,

            oi.custom,
            oi.details,
            oi.image,

            oi.shopper_photo_url,
            oi.shopping_status,
            oi.found_quantity,
            oi.found_weight,
            oi.found_weight_unit,
            oi.barcode_scanned,
            oi.completed_at,

            oi.created_at,

            COALESCE(
              (
                SELECT json_agg(
                  json_build_object(
                    'id', ri.id,
                    'order_id', ri.order_id,
                    'original_item_id', ri.original_item_id,
                    'shopper_id', ri.shopper_id,
                    'option_number', ri.option_number,

                    'photo_url', ri.photo_url,
                    'photoUrl', ri.photo_url,

                    'replacement_photo_url', ri.photo_url,
                    'replacementPhotoUrl', ri.photo_url,

                    'status', ri.status,

                    'created_at', ri.created_at,
                    'updated_at', ri.updated_at
                  )
                  ORDER BY
                    ri.option_number ASC
                )
                FROM replacement_items ri
                WHERE
                  ri.order_id = oi.order_id
                  AND ri.original_item_id = oi.id
              ),
              '[]'::json
            ) AS replacement_items

          FROM order_items oi

          WHERE oi.order_id = $1

          ORDER BY oi.id ASC
          `,
          [orderId]
        );

      // ==================================================
      // FORMAT ITEMS
      // ==================================================

      const items =
        itemsResult.rows.map(
          (item) => ({

            ...item,

            // ==================================================
            // REPLACEMENT ITEMS
            // ==================================================

            replacement_items:
              Array.isArray(
                item.replacement_items
              )
                ? item.replacement_items
                : [],

            replacementItems:
              Array.isArray(
                item.replacement_items
              )
                ? item.replacement_items
                : [],

            replacements:
              Array.isArray(
                item.replacement_items
              )
                ? item.replacement_items
                : [],

            // ==================================================
            // SHOPPING STATUS
            // ==================================================

            shopping_status:
              item.shopping_status ||
              'pending',

            shoppingStatus:
              item.shopping_status ||
              'pending',

            // ==================================================
            // FOUND QUANTITY
            // ==================================================

            found_quantity:
              item.found_quantity !== null
                ? Number(item.found_quantity)
                : null,

            foundQuantity:
              item.found_quantity !== null
                ? Number(item.found_quantity)
                : null,

            // ==================================================
            // FOUND WEIGHT
            // ==================================================

            found_weight:
              item.found_weight !== null
                ? Number(item.found_weight)
                : null,

            foundWeight:
              item.found_weight !== null
                ? Number(item.found_weight)
                : null,

            // ==================================================
            // WEIGHT UNIT
            // ==================================================

            found_weight_unit:
              item.found_weight_unit ||
              null,

            foundWeightUnit:
              item.found_weight_unit ||
              null,

            // ==================================================
            // BARCODE
            // ==================================================

            barcode_scanned:
              item.barcode_scanned === true,

            barcodeScanned:
              item.barcode_scanned === true,

            // ==================================================
            // SHOPPER PHOTO
            // ==================================================

            shopper_photo_url:
              item.shopper_photo_url ||
              null,

            shopperPhotoUrl:
              item.shopper_photo_url ||
              null,

            // ==================================================
            // COMPLETED TIME
            // ==================================================

            completed_at:
              item.completed_at ||
              null,

            completedAt:
              item.completed_at ||
              null,

          })
        );

      // ==================================================
      // TOTALS
      // ==================================================

      const totalAmount =
        Number(
          order.total_amount
        ) || 0;

      const itemsTotal =
        Number(
          order.items_total
        ) || 0;

      const deliveryFee =
        Number(
          order.delivery_fee
        ) || 0;

      const serviceFee =
        Number(
          order.service_fee
        ) || 0;

      // ==================================================
      // SHOPPER
      // ==================================================

      const shopper =
        order.shopper_id
          ? {
              id:
                Number(
                  order.shopper_id
                ),

              name:
                order.shopper_name ||
                'Shopper',

              full_name:
                order.shopper_name ||
                'Shopper',

              mobile:
                order.shopper_mobile ||
                null,

              status:
                order.shopper_status ||
                null,

              latitude:
                Number(
                  order.shopper_latitude
                ),

              longitude:
                Number(
                  order.shopper_longitude
                ),
          }
        : null;

      // ==================================================
      // DEBUG
      // ==================================================

      console.log(
        '===================================='
      );

      console.log(
        '📦 CUSTOMER ORDER'
      );

      console.log(
        'ORDER ID:',
        order.id
      );

      console.log(
        'STATUS:',
        order.status
      );

      console.log(
        'SHOPPER ID:',
        order.shopper_id
      );

      console.log(
        'SHOPPER:',
        shopper?.name ||
        'Not assigned'
      );

      console.log(
        'SHOPPER LOCATION:',
        shopper
          ? `${shopper.latitude}, ${shopper.longitude}`
          : 'Not available'
      );

      console.log(
        'ITEM SHOPPING STATUS:',
        items.map(
          (item) => ({
            id: item.id,
            name: item.item_name,
            status: item.shopping_status,
            foundQuantity:
              item.found_quantity,
            foundWeight:
              item.found_weight,
            photo:
              item.shopper_photo_url,
            completedAt:
              item.completed_at,
          })
        )
      );

      console.log(
        'REPLACEMENT ITEMS:',
        items.map(
          (item) => ({
            itemId: item.id,
            itemName: item.item_name,
            replacements:
              item.replacement_items?.map(
                (replacement) => ({
                  id: replacement.id,
                  originalItemId:
                    replacement.original_item_id,
                  option:
                    replacement.option_number,
                  photo:
                    replacement.photo_url,
                  status:
                    replacement.status,
                })
              ) || [],
          })
        )
      );

      console.log(
        '===================================='
      );

      // ==================================================
      // RESPONSE
      // ==================================================

      return res.status(200).json({

        success: true,

        order: {

          ...order,

          delivery_latitude:
            Number(
              order.delivery_latitude
            ),

          delivery_longitude:
            Number(
              order.delivery_longitude
            ),

          items_total:
            itemsTotal,

          delivery_fee:
            deliveryFee,

          service_fee:
            serviceFee,

          total_amount:
            totalAmount,

          total:
            totalAmount,

          totalAmount:
            totalAmount,

          itemsTotal:
            itemsTotal,

          deliveryFee:
            deliveryFee,

          serviceFee:
            serviceFee,

          // ==================================================
          // SHOP
          // ==================================================

          shop: {

            id:
              order.shop_id,

            name:
              order.shop_name ||
              'Selected Shop',

            shop_name:
              order.shop_name ||
              'Selected Shop',

            image:
              order.shop_image ||
              null,

            image_url:
              order.shop_image ||
              null,

            latitude:
              Number(
                order.shop_latitude
              ),

            longitude:
              Number(
                order.shop_longitude
              ),

          },

          // ==================================================
          // SHOPPER
          // ==================================================

          shopper:
            shopper,

          assignedShopper:
            shopper,

          assigned_shopper:
            shopper,

          // ==================================================
          // ITEMS
          // ==================================================

          items:
            items,

          shoppingList:
            items,

          orderItems:
            items,

        },

      });

    } catch (error) {

      console.error(
        '❌ GET CUSTOMER ORDER ERROR:',
        error
      );

      return res.status(500).json({

        success: false,

        message:
          'Failed to load order',

        error:
          error.message,

      });

    }

  };


// ==================================================
// GET NEARBY ONLINE SHOPPERS FOR ORDER
// ==================================================

const getNearbyShoppersForOrder =
  async (
    req,
    res
  ) => {

    try {

      const customerId =
        req.customer.customerId;

      const orderId =
        Number(
          req.params.orderId
        );

      // ==================================================
      // VALIDATE ORDER ID
      // ==================================================

      if (
        !Number.isInteger(
          orderId
        )
      ) {

        return res.status(400).json({

          success: false,

          message:
            'Invalid order ID',

        });

      }

      // ==================================================
      // GET ORDER + SHOP LOCATION
      // ==================================================

      const orderResult =
        await pool.query(
          `
          SELECT

            o.id,
            o.customer_id,
            o.shop_id,
            o.status,
            o.shopper_id,

            s.shop_name,

            s.latitude AS shop_latitude,
            s.longitude AS shop_longitude

          FROM orders o

          LEFT JOIN shops s
            ON s.id = o.shop_id

          WHERE
            o.id = $1
            AND o.customer_id = $2

          LIMIT 1
          `,
          [
            orderId,
            customerId,
          ]
        );

      // ==================================================
      // ORDER NOT FOUND
      // ==================================================

      if (
        orderResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            'Order not found',

        });

      }

      const order =
        orderResult.rows[0];

      // ==================================================
      // GET ACCEPTED SHOPPER
      // ==================================================

      let acceptedShopper = null;

      if (order.shopper_id) {

        const acceptedShopperResult =
          await pool.query(
            `
            SELECT
              id,
              full_name,
              mobile,
              status,
              latitude,
              longitude
            FROM shoppers
            WHERE id = $1
            LIMIT 1
            `,
            [
              order.shopper_id,
            ]
          );

        if (
          acceptedShopperResult.rows.length > 0
        ) {

          const shopper =
            acceptedShopperResult.rows[0];

          acceptedShopper = {

            id:
              Number(
                shopper.id
              ),

            name:
              shopper.full_name ||
              'Shopper',

            full_name:
              shopper.full_name ||
              'Shopper',

            mobile:
              shopper.mobile ||
              null,

            status:
              shopper.status ||
              null,

            latitude:
              Number(
                shopper.latitude
              ),

            longitude:
              Number(
                shopper.longitude
              ),

          };

        }

      }

      // ==================================================
      // CHECK SHOP LOCATION
      // ==================================================

      const shopLatitude =
        Number(
          order.shop_latitude
        );

      const shopLongitude =
        Number(
          order.shop_longitude
        );

      if (
        !Number.isFinite(
          shopLatitude
        ) ||
        !Number.isFinite(
          shopLongitude
        )
      ) {

        return res.status(400).json({

          success: false,

          message:
            'Shop location is not available',

        });

      }

      // ==================================================
      // GET ONLINE SHOPPERS
      // ==================================================

      const shoppersResult =
        await pool.query(
          `
          SELECT

            sh.id,

            sh.full_name,

            sh.mobile,

            sh.status,

            sh.latitude,

            sh.longitude,

            (
              6371 *
              acos(
                LEAST(
                  1,
                  GREATEST(
                    -1,
                    cos(
                      radians($1)
                    ) *
                    cos(
                      radians(sh.latitude)
                    ) *
                    cos(
                      radians(sh.longitude) -
                      radians($2)
                    ) +
                    sin(
                      radians($1)
                    ) *
                    sin(
                      radians(sh.latitude)
                    )
                  )
                )
              )
            ) AS distance_km

          FROM shoppers sh

          WHERE
            sh.status = 'online'

            AND sh.latitude IS NOT NULL

            AND sh.longitude IS NOT NULL

            AND sh.latitude BETWEEN -90 AND 90

            AND sh.longitude BETWEEN -180 AND 180

          ORDER BY
            distance_km ASC
          `,
          [
            shopLatitude,
            shopLongitude,
          ]
        );

      // ==================================================
      // ONLY 10 KM
      // ==================================================

      const shoppers =
        shoppersResult.rows

          .filter(
            (shopper) => {

              const distance =
                Number(
                  shopper.distance_km
                );

              return (
                Number.isFinite(distance) &&
                distance <= 10
              );

            }
          )

          .map(
            (shopper) => ({

              id:
                shopper.id,

              name:
                shopper.full_name,

              full_name:
                shopper.full_name,

              mobile:
                shopper.mobile,

              status:
                shopper.status,

              latitude:
                Number(
                  shopper.latitude
                ),

              longitude:
                Number(
                  shopper.longitude
                ),

              distance_km:
                Number(
                  shopper.distance_km
                ),

            })
          );

      // ==================================================
      // DEBUG
      // ==================================================

      console.log(
        '===================================='
      );

      console.log(
        '📍 NEARBY ONLINE SHOPPERS'
      );

      console.log(
        'ORDER ID:',
        orderId
      );

      console.log(
        'SHOP ID:',
        order.shop_id
      );

      console.log(
        'SHOP:',
        order.shop_name
      );

      console.log(
        'SHOP LOCATION:',
        shopLatitude,
        shopLongitude
      );

      console.log(
        'ORDER STATUS:',
        order.status
      );

      console.log(
        'ACCEPTED SHOPPER:',
        acceptedShopper
      );

      console.log(
        'ONLINE SHOPPERS:',
        shoppers.length
      );

      shoppers.forEach(
        (shopper) => {

          console.log(
            '--------------------------------'
          );

          console.log(
            'SHOPPER ID:',
            shopper.id
          );

          console.log(
            'SHOPPER NAME:',
            shopper.name
          );

          console.log(
            'STATUS:',
            shopper.status
          );

          console.log(
            'LOCATION:',
            shopper.latitude,
            shopper.longitude
          );

          console.log(
            'DISTANCE:',
            shopper.distance_km,
            'KM'
          );

        }
      );

      console.log(
        '===================================='
      );

      // ==================================================
      // RESPONSE
      // ==================================================

      return res.status(200).json({

        success: true,

        orderId:
          order.id,

        orderStatus:
          order.status,

        shop: {

          id:
            order.shop_id,

          name:
            order.shop_name ||
            'Selected Shop',

          latitude:
            shopLatitude,

          longitude:
            shopLongitude,

        },

        // ==================================================
        // ACCEPTED SHOPPER
        // ==================================================

        shopper:
          acceptedShopper,

        acceptedShopper:
          acceptedShopper,

        assignedShopper:
          acceptedShopper,

        assigned_shopper:
          acceptedShopper,

        // ==================================================
        // NEARBY SHOPPERS
        // ==================================================

        shoppers:
          shoppers,

      });

    } catch (error) {

      console.error(
        '❌ GET NEARBY SHOPPERS ERROR:',
        error
      );

      return res.status(500).json({

        success: false,

        message:
          'Failed to load nearby shoppers',

        error:
          error.message,

      });

    }

  };


// ==================================================
// CANCEL CUSTOMER ORDER
// ==================================================

const cancelCustomerOrder =
  async (
    req,
    res
  ) => {

    try {

      const customerId =
        req.customer.customerId;

      const orderId =
        Number(
          req.params.orderId
        );

      if (
        !Number.isInteger(
          orderId
        )
      ) {

        return res.status(400).json({

          success: false,

          message:
            'Invalid order ID',

        });

      }

      // ==================================================
      // CHECK ORDER
      // ==================================================

      const orderResult =
        await pool.query(
          `
          SELECT
            id,
            status
          FROM orders
          WHERE
            id = $1
            AND customer_id = $2
          LIMIT 1
          `,
          [
            orderId,
            customerId,
          ]
        );

      if (
        orderResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            'Order not found',

        });

      }

      const order =
        orderResult.rows[0];

      // ==================================================
      // ONLY WAITING ORDERS CAN CANCEL
      // ==================================================

      if (
        order.status !==
        'waiting_for_shopper'
      ) {

        return res.status(400).json({

          success: false,

          message:
            'This order cannot be cancelled now',

        });

      }

      // ==================================================
      // UPDATE
      // ==================================================

      const updateResult =
        await pool.query(
          `
          UPDATE orders

          SET
            status = 'cancelled',
            updated_at = CURRENT_TIMESTAMP

          WHERE
            id = $1
            AND customer_id = $2

          RETURNING *
          `,
          [
            orderId,
            customerId,
          ]
        );

      return res.status(200).json({

        success: true,

        message:
          'Order cancelled successfully',

        order:
          updateResult.rows[0],

      });

    } catch (error) {

      console.error(
        '❌ CANCEL ORDER ERROR:',
        error
      );

      return res.status(500).json({

        success: false,

        message:
          'Failed to cancel order',

        error:
          error.message,

      });

    }

  };


// ==================================================
// UPDATE REPLACEMENT STATUS
// ==================================================

const updateReplacementStatus =
  async (
    req,
    res
  ) => {

    try {

      const customerId =
        req.customer.customerId;

      const orderId =
        Number(
          req.params.orderId
        );

      const replacementId =
        Number(
          req.params.replacementId
        );

      const {
        status,
        decision
      } = req.body;

      // ==================================================
      // VALIDATE IDS
      // ==================================================

      if (
        !Number.isInteger(orderId) ||
        !Number.isInteger(replacementId)
      ) {

        return res.status(400).json({

          success: false,

          message:
            'Invalid order or replacement ID',

        });

      }

      // ==================================================
      // GET DECISION
      // ==================================================

      const finalStatus =
        decision === 'accepted'
          ? 'accepted'
          : decision === 'rejected'
            ? 'rejected'
            : status === 'accepted'
              ? 'accepted'
              : status === 'rejected'
                ? 'rejected'
                : null;

      // ==================================================
      // VALIDATE DECISION
      // ==================================================

      if (!finalStatus) {

        return res.status(400).json({

          success: false,

          message:
            'Decision must be accepted or rejected',

        });

      }

      // ==================================================
      // CHECK ORDER BELONGS TO CUSTOMER
      // ==================================================

      const orderResult =
        await pool.query(
          `
          SELECT
            id,
            customer_id
          FROM orders
          WHERE
            id = $1
            AND customer_id = $2
          LIMIT 1
          `,
          [
            orderId,
            customerId,
          ]
        );

      if (
        orderResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            'Order not found',

        });

      }

      // ==================================================
      // CHECK REPLACEMENT
      // ==================================================

      const replacementResult =
        await pool.query(
          `
          SELECT
            id,
            order_id,
            original_item_id,
            shopper_id,
            option_number,
            photo_url,
            status,
            created_at,
            updated_at
          FROM replacement_items
          WHERE
            id = $1
            AND order_id = $2
          LIMIT 1
          `,
          [
            replacementId,
            orderId,
          ]
        );

      if (
        replacementResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            'Replacement item not found',

        });

      }

      const replacement =
        replacementResult.rows[0];

      // ==================================================
      // ONLY WAITING CUSTOMER REPLACEMENTS
      // ==================================================

      if (
        replacement.status !==
        'waiting_customer'
      ) {

        return res.status(400).json({

          success: false,

          message:
            'This replacement has already been processed',

          status:
            replacement.status,

        });

      }

      // ==================================================
      // DATABASE STATUS
      // ==================================================

      const databaseStatus =
        finalStatus === 'accepted'
          ? 'customer_accepted'
          : 'customer_rejected';

      // ==================================================
      // UPDATE REPLACEMENT
      // ==================================================

      const updateResult =
        await pool.query(
          `
          UPDATE replacement_items

          SET
            status = $1,
            updated_at = CURRENT_TIMESTAMP

          WHERE
            id = $2
            AND order_id = $3

          RETURNING
            id,
            order_id,
            original_item_id,
            shopper_id,
            option_number,
            photo_url,
            status,
            created_at,
            updated_at
          `,
          [
            databaseStatus,
            replacementId,
            orderId,
          ]
        );

      if (
        updateResult.rows.length === 0
      ) {

        return res.status(404).json({

          success: false,

          message:
            'Replacement item could not be updated',

        });

      }

      const updatedReplacement =
        updateResult.rows[0];

      // ==================================================
      // DEBUG
      // ==================================================

      console.log(
        '===================================='
      );

      console.log(
        '🔄 REPLACEMENT STATUS UPDATED'
      );

      console.log(
        'CUSTOMER ID:',
        customerId
      );

      console.log(
        'ORDER ID:',
        orderId
      );

      console.log(
        'REPLACEMENT ID:',
        replacementId
      );

      console.log(
        'ORIGINAL ITEM ID:',
        replacement.original_item_id
      );

      console.log(
        'OLD STATUS:',
        replacement.status
      );

      console.log(
        'NEW STATUS:',
        updatedReplacement.status
      );

      console.log(
        '===================================='
      );

      // ==================================================
      // RESPONSE
      // ==================================================

      return res.status(200).json({

        success: true,

        message:
          finalStatus === 'accepted'
            ? 'Replacement accepted successfully'
            : 'Replacement rejected successfully',

        replacement: {

          id:
            updatedReplacement.id,

          orderId:
            updatedReplacement.order_id,

          originalItemId:
            updatedReplacement.original_item_id,

          shopperId:
            updatedReplacement.shopper_id,

          optionNumber:
            updatedReplacement.option_number,

          photoUrl:
            updatedReplacement.photo_url,

          photo_url:
            updatedReplacement.photo_url,

          replacementPhotoUrl:
            updatedReplacement.photo_url,

          replacement_photo_url:
            updatedReplacement.photo_url,

          status:
            updatedReplacement.status,

          createdAt:
            updatedReplacement.created_at,

          updatedAt:
            updatedReplacement.updated_at,

        },

      });

    } catch (error) {

      console.error(
        '❌ UPDATE REPLACEMENT STATUS ERROR:',
        error
      );

      return res.status(500).json({

        success: false,

        message:
          'Failed to update replacement status',

        error:
          error.message,

      });

    }

  };


// ==================================================
// EXPORT
// ==================================================

module.exports = {

  createOrder,

  getCustomerOrders,

  getCustomerOrderById,

  getNearbyShoppersForOrder,

  cancelCustomerOrder,

  updateReplacementStatus,

};