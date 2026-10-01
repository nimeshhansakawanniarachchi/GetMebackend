// const pool = require('../config/db');


// // ==================================================
// // GET AVAILABLE ORDERS
// // ==================================================

// const getAvailableOrders = async (req, res) => {
//   try {

//     const shopperId = req.shopper.shopperId;

//     // ----------------------------------------------
//     // Get shopper location
//     // ----------------------------------------------

//     const shopperResult = await pool.query(
//       `
//       SELECT
//         id,
//         latitude,
//         longitude
//       FROM shoppers
//       WHERE id = $1
//       `,
//       [shopperId]
//     );

//     if (shopperResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shopper not found',
//       });
//     }

//     const shopper = shopperResult.rows[0];

//     if (
//       shopper.latitude === null ||
//       shopper.longitude === null ||
//       !Number.isFinite(Number(shopper.latitude)) ||
//       !Number.isFinite(Number(shopper.longitude))
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'Shopper location is not available',
//       });
//     }


//     // ----------------------------------------------
//     // Find available orders near shopper
//     // ----------------------------------------------

//     const ordersResult = await pool.query(
//       `
//       SELECT
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

//         s.shop_name,
//         s.image_url AS shop_image,
//         s.latitude AS shop_latitude,
//         s.longitude AS shop_longitude

//       FROM orders o

//       INNER JOIN shops s
//         ON s.id = o.shop_id

//       WHERE
//         o.status = 'waiting_for_shopper'
//         AND o.shopper_id IS NULL
//         AND s.status = 'approved'

//         AND s.latitude IS NOT NULL
//         AND s.longitude IS NOT NULL

//         AND (
//           6371 * acos(
//             LEAST(
//               1,
//               GREATEST(
//                 -1,
//                 cos(radians($1))
//                 * cos(radians(s.latitude))
//                 * cos(
//                   radians(s.longitude) - radians($2)
//                 )
//                 + sin(radians($1))
//                 * sin(radians(s.latitude))
//               )
//             )
//           )
//         ) <= 10

//       ORDER BY o.created_at ASC
//       `,
//       [
//         Number(shopper.latitude),
//         Number(shopper.longitude),
//       ]
//     );


//     // ----------------------------------------------
//     // Build response
//     // ----------------------------------------------

//     const orders = [];

//     for (const order of ordersResult.rows) {

//       // --------------------------------------------
//       // Get order items
//       // --------------------------------------------

//       const itemsResult = await pool.query(
//         `
//         SELECT
//           id,
//           product_id,
//           item_name,
//           quantity,
//           amount,
//           unit,
//           price,
//           custom,
//           details,
//           image

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC
//         `,
//         [order.id]
//       );


//       // --------------------------------------------
//       // Calculate shopper -> shop distance
//       // --------------------------------------------

//       const distanceResult = await pool.query(
//         `
//         SELECT
//           (
//             6371 * acos(
//               LEAST(
//                 1,
//                 GREATEST(
//                   -1,
//                   cos(radians($1))
//                   * cos(radians($3))
//                   * cos(
//                     radians($4) - radians($2)
//                   )
//                   + sin(radians($1))
//                   * sin(radians($3))
//                 )
//               )
//             )
//           ) AS distance_km
//         `,
//         [
//           Number(shopper.latitude),
//           Number(shopper.longitude),
//           Number(order.shop_latitude),
//           Number(order.shop_longitude),
//         ]
//       );


//       const distanceKm = Number(
//         distanceResult.rows[0]?.distance_km || 0
//       );


//       orders.push({

//         id: order.id,

//         customerId:
//           order.customer_id,

//         shopId:
//           order.shop_id,

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

//         distanceKm:
//           Number(distanceKm.toFixed(2)),

//         shop: {

//           id:
//             order.shop_id,

//           name:
//             order.shop_name,

//           image:
//             order.shop_image,

//           latitude:
//             Number(order.shop_latitude),

//           longitude:
//             Number(order.shop_longitude),

//         },

//         items:
//           itemsResult.rows.map((item) => ({

//             id:
//               item.id,

//             productId:
//               item.product_id,

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

//           })),

//       });

//     }


//     return res.json({

//       success: true,

//       orders,

//     });

//   } catch (error) {

//     console.error(
//       '❌ GET SHOPPER ORDERS ERROR:',
//       error
//     );

//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to load shopper orders',

//       error:
//         error.message,

//     });

//   }
// };


// // ==================================================
// // ACCEPT ORDER
// // ==================================================

// const acceptOrder = async (req, res) => {

//   const client = await pool.connect();

//   try {

//     const shopperId =
//       req.shopper.shopperId;

//     const orderId =
//       Number(req.params.orderId);


//     if (!Number.isInteger(orderId)) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     await client.query('BEGIN');


//     // ----------------------------------------------
//     // Lock order
//     // ----------------------------------------------

//     const orderResult =
//       await client.query(
//         `
//         SELECT
//           id,
//           shop_id,
//           status,
//           shopper_id

//         FROM orders

//         WHERE id = $1

//         FOR UPDATE
//         `,
//         [orderId]
//       );


//     if (orderResult.rows.length === 0) {

//       await client.query('ROLLBACK');

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // ----------------------------------------------
//     // Check order availability
//     // ----------------------------------------------

//     if (
//       order.status !==
//         'waiting_for_shopper' ||
//       order.shopper_id !== null
//     ) {

//       await client.query('ROLLBACK');

//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//       });

//     }


//     // ----------------------------------------------
//     // Assign shopper
//     // ----------------------------------------------

//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET
//           shopper_id = $1,
//           status = 'shopper_accepted',
//           updated_at = NOW()

//         WHERE id = $2

//         RETURNING
//           id,
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
//           status,
//           shopper_id,
//           created_at,
//           updated_at
//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     await client.query('COMMIT');


//     return res.json({

//       success: true,

//       message:
//         'Order accepted successfully',

//       order:
//         updateResult.rows[0],

//     });

//   } catch (error) {

//     try {
//       await client.query('ROLLBACK');
//     } catch (rollbackError) {
//       console.error(
//         '❌ ROLLBACK ERROR:',
//         rollbackError
//       );
//     }

//     console.error(
//       '❌ ACCEPT ORDER ERROR:',
//       error
//     );

//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });

//   } finally {

//     client.release();

//   }

// };


// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

// };






// const pool = require('../config/db');


// // =====================================================
// // HELPER
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
// // GET AVAILABLE ORDERS FOR SHOPPER
// // =====================================================

// const getAvailableOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     // =================================================
//     // GET SHOPPER LOCATION
//     // =================================================

//     const shopperResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status
//         FROM shoppers
//         WHERE id = $1
//         LIMIT 1
//         `,
//         [shopperId]
//       );


//     if (
//       shopperResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Shopper not found',

//       });

//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);


//     const shopperLongitude =
//       Number(shopper.longitude);


//     // =================================================
//     // CHECK SHOPPER LOCATION
//     // =================================================

//     if (
//       !Number.isFinite(
//         shopperLatitude
//       ) ||
//       !Number.isFinite(
//         shopperLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shopper location is not available',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 SHOPPER LOCATION'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Latitude:',
//       shopperLatitude
//     );

//     console.log(
//       'Longitude:',
//       shopperLongitude
//     );


//     // =================================================
//     // FIND AVAILABLE ORDERS
//     // =================================================
//     //
//     // Only:
//     //
//     // waiting_for_shopper
//     // shopper_id IS NULL
//     // approved shop
//     //
//     // AND shop is within 10 KM
//     // from shopper
//     //
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         WITH available_orders AS (

//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,

//             o.delivery_address,

//             o.delivery_latitude,
//             o.delivery_longitude,

//             o.delivery_option,
//             o.payment_method,

//             o.items_total,
//             o.delivery_fee,
//             o.service_fee,
//             o.total_amount,

//             o.status,

//             o.created_at,
//             o.updated_at,

//             s.shop_name,
//             s.image_url AS shop_image,
//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,

//                     cos(
//                       radians($1)
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.longitude
//                       )
//                       -
//                       radians($2)
//                     )

//                     +

//                     sin(
//                       radians($1)
//                     )

//                     *

//                     sin(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                   )
//                 )
//               )
//             ) AS shop_distance_km

//           FROM orders o

//           INNER JOIN shops s
//             ON s.id = o.shop_id

//           WHERE

//             o.status =
//               'waiting_for_shopper'

//             AND

//             o.shopper_id IS NULL

//             AND

//             s.status =
//               'approved'

//             AND

//             s.latitude IS NOT NULL

//             AND

//             s.longitude IS NOT NULL

//         )

//         SELECT *

//         FROM available_orders

//         WHERE
//           shop_distance_km <= 10

//         ORDER BY

//           shop_distance_km ASC,

//           created_at ASC

//         `,
//         [
//           shopperLatitude,
//           shopperLongitude,
//         ]
//       );


//     console.log(
//       '📦 AVAILABLE REAL ORDERS:',
//       result.rows.length
//     );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC
//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             const distance =
//               Number(
//                 order.shop_distance_km
//               );


//             // =================================================
//             // RETURN ORDER
//             // =================================================

//             return {

//               id:
//                 Number(
//                   order.id
//                 ),


//               customerId:
//                 Number(
//                   order.customer_id
//                 ),


//               shopId:
//                 Number(
//                   order.shop_id
//                 ),


//               // ===============================================
//               // SHOP
//               // ===============================================

//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image || null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               // ===============================================
//               // CUSTOMER
//               // ===============================================

//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               // ===============================================
//               // MONEY
//               // ===============================================

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               // ===============================================
//               // DISTANCE
//               // ===============================================

//               distance:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? `${distance.toFixed(1)} km`
//                   : '0.0 km',


//               distanceKm:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? Number(
//                       distance.toFixed(2)
//                     )
//                   : 0,


//               // ===============================================
//               // ORDER INFO
//               // ===============================================

//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,

//               status:
//                 order.status,

//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               // ===============================================
//               // ITEMS
//               // ===============================================

//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       item.id,

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ ORDERS SENT TO SHOPPER:',
//       orders.length
//     );

//     console.log(
//       '========================================'
//     );


//     // =================================================
//     // RESPONSE
//     // =================================================

//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };



// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (req, res) => {

//   const client =
//     await pool.connect();


//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📦 ACCEPT ORDER'
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );


//     await client.query(
//       'BEGIN'
//     );


//     // =================================================
//     // LOCK ORDER
//     // =================================================

//     const orderResult =
//       await client.query(
//         `
//         SELECT

//           id,
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

//           status,
//           shopper_id,

//           created_at

//         FROM orders

//         WHERE id = $1

//         FOR UPDATE

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // CHECK STATUS
//     // =================================================

//     if (
//       order.status !==
//       'waiting_for_shopper'
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//         status:
//           order.status,

//       });

//     }


//     // =================================================
//     // CHECK SHOPPER
//     // =================================================

//     if (
//       order.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order has already been accepted',

//       });

//     }


//     // =================================================
//     // ASSIGN SHOPPER
//     // =================================================

//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET

//           shopper_id =
//             $1,

//           status =
//             'shopper_accepted',

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND status =
//             'waiting_for_shopper'

//           AND shopper_id IS NULL

//         RETURNING *

//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order was already accepted',

//       });

//     }


//     // =================================================
//     // GET SHOP
//     // =================================================

//     const shopResult =
//       await client.query(
//         `
//         SELECT

//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude,
//           status

//         FROM shops

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [order.shop_id]
//       );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const itemsResult =
//       await client.query(
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
//           image

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     await client.query(
//       'COMMIT'
//     );


//     const updatedOrder =
//       updateResult.rows[0];


//     const shop =
//       shopResult.rows[0] ||
//       null;


//     const items =
//       itemsResult.rows;


//     // =================================================
//     // RESPONSE ORDER
//     // =================================================

//     const responseOrder = {

//       id:
//         Number(
//           updatedOrder.id
//         ),


//       customerId:
//         Number(
//           updatedOrder.customer_id
//         ),


//       shopId:
//         Number(
//           updatedOrder.shop_id
//         ),


//       shopperId:
//         Number(
//           updatedOrder.shopper_id
//         ),


//       // ===============================================
//       // SHOP
//       // ===============================================

//       store:
//         shop?.shop_name ||
//         'Shop',

//       storeName:
//         shop?.shop_name ||
//         'Shop',

//       shop:
//         shop?.shop_name ||
//         'Shop',

//       shopImage:
//         shop?.image_url ||
//         null,


//       pickupLatitude:
//         Number(
//           shop?.latitude
//         ),

//       pickupLongitude:
//         Number(
//           shop?.longitude
//         ),


//       // ===============================================
//       // CUSTOMER
//       // ===============================================

//       customer:
//         updatedOrder.delivery_address,

//       customerName:
//         `Customer #${updatedOrder.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       latitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       longitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       deliveryAddress:
//         updatedOrder.delivery_address,


//       // ===============================================
//       // ORDER
//       // ===============================================

//       deliveryOption:
//         updatedOrder.delivery_option,

//       paymentMethod:
//         updatedOrder.payment_method,


//       // ===============================================
//       // MONEY
//       // ===============================================

//       itemsTotal:
//         Number(
//           updatedOrder.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           updatedOrder.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           updatedOrder.total_amount || 0
//         ),

//       fee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),


//       // ===============================================
//       // STATUS
//       // ===============================================

//       status:
//         updatedOrder.status,


//       createdAt:
//         updatedOrder.created_at,

//       updatedAt:
//         updatedOrder.updated_at,


//       // ===============================================
//       // ITEMS
//       // ===============================================

//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               item.id,

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,

//           })
//         ),


//       orderItems:
//         items,

//     };


//     console.log(
//       '✅ ORDER ACCEPTED'
//     );

//     console.log(
//       'Order:',
//       responseOrder.id
//     );

//     console.log(
//       'Shopper:',
//       responseOrder.shopperId
//     );

//     console.log(
//       'Status:',
//       responseOrder.status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Order accepted successfully',

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     try {

//       await client.query(
//         'ROLLBACK'
//       );

//     } catch (_) {}


//     console.error(
//       '❌ ACCEPT SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });


//   } finally {

//     client.release();

//   }

// };



// // =====================================================
// // GET MY ACTIVE ORDERS
// // =====================================================

// const getMyOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const result =
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

//           o.shopper_id,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC

//         `,
//         [shopperId]
//       );


//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT *

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC

//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),

//               shopperId:
//                 Number(
//                   order.shopper_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,


//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),


//               status:
//                 order.status,


//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       item.id,

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET MY SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };



// // =====================================================
// // EXPORT
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   getMyOrders,

// };


















// const pool = require('../config/db');


// // =====================================================
// // HELPER
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
// // GET AVAILABLE ORDERS FOR SHOPPER
// // =====================================================

// const getAvailableOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     // =================================================
//     // GET SHOPPER LOCATION
//     // =================================================

//     const shopperResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status
//         FROM shoppers
//         WHERE id = $1
//         LIMIT 1
//         `,
//         [shopperId]
//       );


//     if (
//       shopperResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Shopper not found',

//       });

//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);


//     const shopperLongitude =
//       Number(shopper.longitude);


//     // =================================================
//     // CHECK SHOPPER LOCATION
//     // =================================================

//     if (
//       !Number.isFinite(
//         shopperLatitude
//       ) ||
//       !Number.isFinite(
//         shopperLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shopper location is not available',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 SHOPPER LOCATION'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Latitude:',
//       shopperLatitude
//     );

//     console.log(
//       'Longitude:',
//       shopperLongitude
//     );


//     // =================================================
//     // FIND AVAILABLE ORDERS
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         WITH available_orders AS (

//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,

//             o.delivery_address,

//             o.delivery_latitude,
//             o.delivery_longitude,

//             o.delivery_option,
//             o.payment_method,

//             o.items_total,
//             o.delivery_fee,
//             o.service_fee,
//             o.total_amount,

//             o.status,

//             o.created_at,
//             o.updated_at,

//             s.shop_name,
//             s.image_url AS shop_image,
//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,

//                     cos(
//                       radians($1)
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.longitude
//                       )
//                       -
//                       radians($2)
//                     )

//                     +

//                     sin(
//                       radians($1)
//                     )

//                     *

//                     sin(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                   )
//                 )
//               )
//             ) AS shop_distance_km

//           FROM orders o

//           INNER JOIN shops s
//             ON s.id = o.shop_id

//           WHERE

//             o.status =
//               'waiting_for_shopper'

//             AND

//             o.shopper_id IS NULL

//             AND

//             s.status =
//               'approved'

//             AND

//             s.latitude IS NOT NULL

//             AND

//             s.longitude IS NOT NULL

//         )

//         SELECT *

//         FROM available_orders

//         WHERE
//           shop_distance_km <= 10

//         ORDER BY

//           shop_distance_km ASC,

//           created_at ASC

//         `,
//         [
//           shopperLatitude,
//           shopperLongitude,
//         ]
//       );


//     console.log(
//       '📦 AVAILABLE REAL ORDERS:',
//       result.rows.length
//     );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC
//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             const distance =
//               Number(
//                 order.shop_distance_km
//               );


//             // =================================================
//             // RETURN ORDER
//             // =================================================

//             return {

//               id:
//                 Number(
//                   order.id
//                 ),


//               customerId:
//                 Number(
//                   order.customer_id
//                 ),


//               shopId:
//                 Number(
//                   order.shop_id
//                 ),


//               // ===============================================
//               // SHOP
//               // ===============================================

//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image || null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               // ===============================================
//               // CUSTOMER
//               // ===============================================

//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               // ===============================================
//               // MONEY
//               // ===============================================

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               // ===============================================
//               // DISTANCE
//               // ===============================================

//               distance:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? `${distance.toFixed(1)} km`
//                   : '0.0 km',


//               distanceKm:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? Number(
//                       distance.toFixed(2)
//                     )
//                   : 0,


//               // ===============================================
//               // ORDER INFO
//               // ===============================================

//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,

//               status:
//                 order.status,

//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               // ===============================================
//               // ITEMS
//               // ===============================================

//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       item.id,

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ ORDERS SENT TO SHOPPER:',
//       orders.length
//     );

//     console.log(
//       '========================================'
//     );


//     // =================================================
//     // RESPONSE
//     // =================================================

//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (req, res) => {

//   const client =
//     await pool.connect();


//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📦 ACCEPT ORDER'
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );


//     await client.query(
//       'BEGIN'
//     );


//     // =================================================
//     // LOCK ORDER
//     // =================================================

//     const orderResult =
//       await client.query(
//         `
//         SELECT

//           id,
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

//           status,
//           shopper_id,

//           created_at

//         FROM orders

//         WHERE id = $1

//         FOR UPDATE

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // CHECK STATUS
//     // =================================================

//     if (
//       order.status !==
//       'waiting_for_shopper'
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//         status:
//           order.status,

//       });

//     }


//     // =================================================
//     // CHECK SHOPPER
//     // =================================================

//     if (
//       order.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order has already been accepted',

//       });

//     }


//     // =================================================
//     // ASSIGN SHOPPER
//     // =================================================

//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET

//           shopper_id =
//             $1,

//           status =
//             'shopper_accepted',

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND status =
//             'waiting_for_shopper'

//           AND shopper_id IS NULL

//         RETURNING *

//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order was already accepted',

//       });

//     }


//     // =================================================
//     // GET SHOP
//     // =================================================

//     const shopResult =
//       await client.query(
//         `
//         SELECT

//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude,
//           status

//         FROM shops

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [order.shop_id]
//       );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const itemsResult =
//       await client.query(
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
//           image

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     await client.query(
//       'COMMIT'
//     );


//     const updatedOrder =
//       updateResult.rows[0];


//     const shop =
//       shopResult.rows[0] ||
//       null;


//     const items =
//       itemsResult.rows;


//     // =================================================
//     // RESPONSE ORDER
//     // =================================================

//     const responseOrder = {

//       id:
//         Number(
//           updatedOrder.id
//         ),


//       customerId:
//         Number(
//           updatedOrder.customer_id
//         ),


//       shopId:
//         Number(
//           updatedOrder.shop_id
//         ),


//       shopperId:
//         Number(
//           updatedOrder.shopper_id
//         ),


//       // ===============================================
//       // SHOP
//       // ===============================================

//       store:
//         shop?.shop_name ||
//         'Shop',

//       storeName:
//         shop?.shop_name ||
//         'Shop',

//       shop:
//         shop?.shop_name ||
//         'Shop',

//       shopImage:
//         shop?.image_url ||
//         null,


//       pickupLatitude:
//         Number(
//           shop?.latitude
//         ),

//       pickupLongitude:
//         Number(
//           shop?.longitude
//         ),


//       // ===============================================
//       // CUSTOMER
//       // ===============================================

//       customer:
//         updatedOrder.delivery_address,

//       customerName:
//         `Customer #${updatedOrder.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       latitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       longitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       deliveryAddress:
//         updatedOrder.delivery_address,


//       // ===============================================
//       // ORDER
//       // ===============================================

//       deliveryOption:
//         updatedOrder.delivery_option,

//       paymentMethod:
//         updatedOrder.payment_method,


//       // ===============================================
//       // MONEY
//       // ===============================================

//       itemsTotal:
//         Number(
//           updatedOrder.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           updatedOrder.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           updatedOrder.total_amount || 0
//         ),

//       fee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),


//       // ===============================================
//       // STATUS
//       // ===============================================

//       status:
//         updatedOrder.status,


//       createdAt:
//         updatedOrder.created_at,

//       updatedAt:
//         updatedOrder.updated_at,


//       // ===============================================
//       // ITEMS
//       // ===============================================

//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               item.id,

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,

//           })
//         ),


//       orderItems:
//         items,

//     };


//     console.log(
//       '✅ ORDER ACCEPTED'
//     );

//     console.log(
//       'Order:',
//       responseOrder.id
//     );

//     console.log(
//       'Shopper:',
//       responseOrder.shopperId
//     );

//     console.log(
//       'Status:',
//       responseOrder.status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Order accepted successfully',

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     try {

//       await client.query(
//         'ROLLBACK'
//       );

//     } catch (_) {}


//     console.error(
//       '❌ ACCEPT SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });


//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // GET MY ACTIVE ORDERS
// // =====================================================

// const getMyOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const result =
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

//           o.shopper_id,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC

//         `,
//         [shopperId]
//       );


//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT *

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC

//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),

//               shopperId:
//                 Number(
//                   order.shopper_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,


//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),


//               status:
//                 order.status,


//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       item.id,

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET MY SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY ONLINE SHOPPERS FOR CUSTOMER ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     // =================================================
//     // GET ORDER + SHOP LOCATION
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           o.id,
//           o.shop_id,

//           s.shop_name,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE o.id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const shopLatitude =
//       Number(
//         order.shop_latitude
//       );


//     const shopLongitude =
//       Number(
//         order.shop_longitude
//       );


//     if (
//       !Number.isFinite(
//         shopLatitude
//       ) ||
//       !Number.isFinite(
//         shopLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop location is not available',

//       });

//     }


//     // =================================================
//     // FIND ONLINE SHOPPERS NEAR SHOP
//     // =================================================

//     const shoppersResult =
//       await pool.query(
//         `
//         SELECT

//           id,

//           latitude,
//           longitude,

//           status

//         FROM shoppers

//         WHERE

//           status = 'online'

//           AND latitude IS NOT NULL

//           AND longitude IS NOT NULL

//           AND (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) <= 10

//         ORDER BY

//           (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) ASC

//         `,
//         [
//           shopLatitude,
//           shopLongitude,
//         ]
//       );


//     // =================================================
//     // FORMAT SHOPPERS
//     // =================================================

//     const shoppers =
//       shoppersResult.rows.map(
//         shopper => {

//           const latitude =
//             Number(
//               shopper.latitude
//             );


//           const longitude =
//             Number(
//               shopper.longitude
//             );


//           const distanceKm =
//             6371 *

//             Math.acos(

//               Math.min(

//                 1,

//                 Math.max(

//                   -1,

//                   Math.cos(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     (
//                       longitude -
//                       shopLongitude
//                     ) *
//                     Math.PI /
//                     180
//                   )

//                   +

//                   Math.sin(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.sin(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                 )

//               )

//             );


//           return {

//             id:
//               Number(
//                 shopper.id
//               ),

//             latitude,

//             longitude,

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 distanceKm.toFixed(2)
//               ),

//           };

//         }
//       );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 NEARBY SHOPPERS'
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Shop:',
//       order.shop_name
//     );

//     console.log(
//       'Shop Latitude:',
//       shopLatitude
//     );

//     console.log(
//       'Shop Longitude:',
//       shopLongitude
//     );

//     console.log(
//       'Nearby shoppers:',
//       shoppers.length
//     );

//     console.log(
//       '========================================'
//     );


//     // =================================================
//     // RESPONSE
//     // =================================================

//     return res.json({

//       success: true,

//       orderId,

//       shop: {

//         id:
//           Number(
//             order.shop_id
//           ),

//         name:
//           order.shop_name,

//         latitude:
//           shopLatitude,

//         longitude:
//           shopLongitude,

//       },

//       count:
//         shoppers.length,

//       shoppers,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET NEARBY SHOPPERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORT
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   getMyOrders,

//   getNearbyShoppersForOrder,

// };


















// const pool = require('../config/db');


// // =====================================================
// // HELPER
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
// // GET AVAILABLE ORDERS FOR SHOPPER
// // =====================================================

// const getAvailableOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     // =================================================
//     // GET SHOPPER LOCATION
//     // =================================================

//     const shopperResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status
//         FROM shoppers
//         WHERE id = $1
//         LIMIT 1
//         `,
//         [shopperId]
//       );


//     if (
//       shopperResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Shopper not found',

//       });

//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);


//     const shopperLongitude =
//       Number(shopper.longitude);


//     if (
//       !Number.isFinite(
//         shopperLatitude
//       ) ||
//       !Number.isFinite(
//         shopperLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shopper location is not available',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 SHOPPER LOCATION'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Latitude:',
//       shopperLatitude
//     );

//     console.log(
//       'Longitude:',
//       shopperLongitude
//     );


//     // =================================================
//     // FIND AVAILABLE ORDERS
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         WITH available_orders AS (

//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,

//             o.delivery_address,

//             o.delivery_latitude,
//             o.delivery_longitude,

//             o.delivery_option,
//             o.payment_method,

//             o.items_total,
//             o.delivery_fee,
//             o.service_fee,
//             o.total_amount,

//             o.status,

//             o.created_at,
//             o.updated_at,

//             s.shop_name,
//             s.image_url AS shop_image,
//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,

//                     cos(
//                       radians($1)
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.longitude
//                       )
//                       -
//                       radians($2)
//                     )

//                     +

//                     sin(
//                       radians($1)
//                     )

//                     *

//                     sin(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                   )
//                 )
//               )
//             ) AS shop_distance_km

//           FROM orders o

//           INNER JOIN shops s
//             ON s.id = o.shop_id

//           WHERE

//             o.status =
//               'waiting_for_shopper'

//             AND

//             o.shopper_id IS NULL

//             AND

//             s.status =
//               'approved'

//             AND

//             s.latitude IS NOT NULL

//             AND

//             s.longitude IS NOT NULL

//         )

//         SELECT *

//         FROM available_orders

//         WHERE
//           shop_distance_km <= 10

//         ORDER BY

//           shop_distance_km ASC,

//           created_at ASC

//         `,
//         [
//           shopperLatitude,
//           shopperLongitude,
//         ]
//       );


//     console.log(
//       '📦 AVAILABLE REAL ORDERS:',
//       result.rows.length
//     );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC
//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             const distance =
//               Number(
//                 order.shop_distance_km
//               );


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),


//               // =======================================
//               // SHOP
//               // =======================================

//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               // =======================================
//               // CUSTOMER
//               // =======================================

//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               // =======================================
//               // MONEY
//               // =======================================

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               // =======================================
//               // DISTANCE
//               // =======================================

//               distance:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? `${distance.toFixed(1)} km`
//                   : '0.0 km',


//               distanceKm:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? Number(
//                       distance.toFixed(2)
//                     )
//                   : 0,


//               // =======================================
//               // ORDER INFO
//               // =======================================

//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,

//               status:
//                 order.status,

//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               // =======================================
//               // ITEMS
//               // =======================================

//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,


//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',


//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,


//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,


//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,


//                     barcodeScanned:
//                       item.barcode_scanned === true,


//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ ORDERS SENT TO SHOPPER:',
//       orders.length
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (req, res) => {

//   const client =
//     await pool.connect();


//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     await client.query(
//       'BEGIN'
//     );


//     // =================================================
//     // LOCK ORDER
//     // =================================================

//     const orderResult =
//       await client.query(
//         `
//         SELECT

//           id,
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

//           status,
//           shopper_id,

//           created_at

//         FROM orders

//         WHERE id = $1

//         FOR UPDATE

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // CHECK STATUS
//     // =================================================

//     if (
//       order.status !==
//       'waiting_for_shopper'
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//         status:
//           order.status,

//       });

//     }


//     // =================================================
//     // CHECK SHOPPER
//     // =================================================

//     if (
//       order.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order has already been accepted',

//       });

//     }


//     // =================================================
//     // ASSIGN SHOPPER
//     // =================================================

//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET

//           shopper_id =
//             $1,

//           status =
//             'shopper_accepted',

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND status =
//             'waiting_for_shopper'

//           AND shopper_id IS NULL

//         RETURNING *

//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order was already accepted',

//       });

//     }


//     // =================================================
//     // GET SHOP
//     // =================================================

//     const shopResult =
//       await client.query(
//         `
//         SELECT

//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude,
//           status

//         FROM shops

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [order.shop_id]
//       );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const itemsResult =
//       await client.query(
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
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     await client.query(
//       'COMMIT'
//     );


//     const updatedOrder =
//       updateResult.rows[0];


//     const shop =
//       shopResult.rows[0] ||
//       null;


//     const items =
//       itemsResult.rows;


//     // =================================================
//     // RESPONSE ORDER
//     // =================================================

//     const responseOrder = {

//       id:
//         Number(
//           updatedOrder.id
//         ),

//       customerId:
//         Number(
//           updatedOrder.customer_id
//         ),

//       shopId:
//         Number(
//           updatedOrder.shop_id
//         ),

//       shopperId:
//         Number(
//           updatedOrder.shopper_id
//         ),


//       store:
//         shop?.shop_name ||
//         'Shop',

//       storeName:
//         shop?.shop_name ||
//         'Shop',

//       shop:
//         shop?.shop_name ||
//         'Shop',

//       shopImage:
//         shop?.image_url ||
//         null,


//       pickupLatitude:
//         Number(
//           shop?.latitude
//         ),

//       pickupLongitude:
//         Number(
//           shop?.longitude
//         ),


//       customer:
//         updatedOrder.delivery_address,

//       customerName:
//         `Customer #${updatedOrder.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       latitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       longitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       deliveryAddress:
//         updatedOrder.delivery_address,


//       deliveryOption:
//         updatedOrder.delivery_option,

//       paymentMethod:
//         updatedOrder.payment_method,


//       itemsTotal:
//         Number(
//           updatedOrder.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           updatedOrder.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           updatedOrder.total_amount || 0
//         ),

//       fee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),


//       status:
//         updatedOrder.status,


//       createdAt:
//         updatedOrder.created_at,

//       updatedAt:
//         updatedOrder.updated_at,


//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               Number(
//                 item.id
//               ),

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,


//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,

//             shoppingStatus:
//               item.shopping_status ||
//               'pending',

//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(
//                     item.found_quantity
//                   )
//                 : null,

//             foundWeight:
//               item.found_weight !== null
//                 ? Number(
//                     item.found_weight
//                   )
//                 : null,

//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,

//             barcodeScanned:
//               item.barcode_scanned === true,

//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         ),


//       orderItems:
//         items,

//     };


//     console.log(
//       '✅ ORDER ACCEPTED:',
//       responseOrder.id
//     );


//     return res.json({

//       success: true,

//       message:
//         'Order accepted successfully',

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     try {

//       await client.query(
//         'ROLLBACK'
//       );

//     } catch (_) {}


//     console.error(
//       '❌ ACCEPT SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });


//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // START SHOPPING
// // =====================================================

// const startShopping = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     // =================================================
//     // GET ORDER
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status,
//           updated_at

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // CHECK SHOPPER
//     // =================================================

//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     // =================================================
//     // ALREADY SHOPPING
//     // =================================================

//     if (
//       order.status ===
//       'shopping'
//     ) {

//       return res.json({

//         success: true,

//         message:
//           'Shopping has already started',

//         order: {

//           id:
//             Number(
//               order.id
//             ),

//           customerId:
//             Number(
//               order.customer_id
//             ),

//           shopId:
//             Number(
//               order.shop_id
//             ),

//           shopperId:
//             Number(
//               order.shopper_id
//             ),

//           status:
//             'shopping',

//           updatedAt:
//             order.updated_at,

//         },

//       });

//     }


//     // =================================================
//     // CHECK CURRENT STATUS
//     // =================================================

//     if (
//       order.status !==
//       'shopper_accepted'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order cannot start shopping from current status',

//         status:
//           order.status,

//       });

//     }


//     // =================================================
//     // UPDATE STATUS
//     // =================================================

//     const updateResult =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           status =
//             'shopping',

//           updated_at =
//             NOW()

//         WHERE

//           id = $1

//           AND shopper_id = $2

//           AND status =
//             'shopper_accepted'

//         RETURNING *

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Unable to start shopping',

//       });

//     }


//     const updatedOrder =
//       updateResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🛒 SHOPPING STARTED'
//     );

//     console.log(
//       'Order ID:',
//       updatedOrder.id
//     );

//     console.log(
//       'Shopper ID:',
//       updatedOrder.shopper_id
//     );

//     console.log(
//       'Status:',
//       updatedOrder.status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Shopping started successfully',

//       order: {

//         id:
//           Number(
//             updatedOrder.id
//           ),

//         customerId:
//           Number(
//             updatedOrder.customer_id
//           ),

//         shopId:
//           Number(
//             updatedOrder.shop_id
//           ),

//         shopperId:
//           Number(
//             updatedOrder.shopper_id
//           ),

//         status:
//           updatedOrder.status,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ START SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start shopping',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ACTIVE ORDERS
// // =====================================================

// const getMyOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const result =
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

//           o.shopper_id,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC

//         `,
//         [shopperId]
//       );


//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC

//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),

//               shopperId:
//                 Number(
//                   order.shopper_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,


//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),


//               status:
//                 order.status,


//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,

//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',

//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,

//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,

//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,

//                     barcodeScanned:
//                       item.barcode_scanned === true,

//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET MY SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY ONLINE SHOPPERS FOR CUSTOMER ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           o.id,
//           o.shop_id,

//           s.shop_name,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE o.id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const shopLatitude =
//       Number(
//         order.shop_latitude
//       );


//     const shopLongitude =
//       Number(
//         order.shop_longitude
//       );


//     if (
//       !Number.isFinite(
//         shopLatitude
//       ) ||
//       !Number.isFinite(
//         shopLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop location is not available',

//       });

//     }


//     const shoppersResult =
//       await pool.query(
//         `
//         SELECT

//           id,

//           latitude,
//           longitude,

//           status

//         FROM shoppers

//         WHERE

//           status = 'online'

//           AND latitude IS NOT NULL

//           AND longitude IS NOT NULL

//           AND (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) <= 10

//         ORDER BY

//           (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) ASC

//         `,
//         [
//           shopLatitude,
//           shopLongitude,
//         ]
//       );


//     const shoppers =
//       shoppersResult.rows.map(
//         shopper => {

//           const latitude =
//             Number(
//               shopper.latitude
//             );


//           const longitude =
//             Number(
//               shopper.longitude
//             );


//           const distanceKm =
//             6371 *

//             Math.acos(

//               Math.min(

//                 1,

//                 Math.max(

//                   -1,

//                   Math.cos(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     (
//                       longitude -
//                       shopLongitude
//                     ) *
//                     Math.PI /
//                     180
//                   )

//                   +

//                   Math.sin(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.sin(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                 )

//               )

//             );


//           return {

//             id:
//               Number(
//                 shopper.id
//               ),

//             latitude,

//             longitude,

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 distanceKm.toFixed(2)
//               ),

//           };

//         }
//       );


//     return res.json({

//       success: true,

//       orderId,

//       shop: {

//         id:
//           Number(
//             order.shop_id
//           ),

//         name:
//           order.shop_name,

//         latitude:
//           shopLatitude,

//         longitude:
//           shopLongitude,

//       },

//       count:
//         shoppers.length,

//       shoppers,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET NEARBY SHOPPERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // =====================================================

// const uploadItemPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Item photo is required',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📸 ITEM PHOTO UPLOAD'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Item ID:',
//       itemId
//     );

//     console.log(
//       'File:',
//       req.file.filename
//     );


//     // =================================================
//     // CHECK ORDER
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     // =================================================
//     // CHECK ITEM
//     // =================================================

//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     // =================================================
//     // READ OPTIONAL SHOPPING DATA
//     // =================================================

//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const parsedQuantity =
//       foundQuantity !== undefined &&
//       foundQuantity !== null &&
//       foundQuantity !== ''
//         ? Number(foundQuantity)
//         : null;


//     const parsedWeight =
//       foundWeight !== undefined &&
//       foundWeight !== null &&
//       foundWeight !== ''
//         ? Number(foundWeight)
//         : null;


//     const parsedBarcode =
//       barcodeScanned === true ||
//       barcodeScanned === 'true';


//     // =================================================
//     // PHOTO URL
//     // =================================================

//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


//     // =================================================
//     // UPDATE ITEM
//     // =================================================

//     const updateResult =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopper_photo_url =
//             $1,

//           shopping_status =
//             'done',

//           found_quantity =
//             $2,

//           found_weight =
//             $3,

//           found_weight_unit =
//             $4,

//           barcode_scanned =
//             $5,

//           completed_at =
//             NOW()

//         WHERE

//           id = $6

//           AND order_id = $7

//         RETURNING *

//         `,
//         [
//           photoUrl,
//           parsedQuantity,
//           parsedWeight,
//           foundWeightUnit ||
//             null,
//           parsedBarcode,
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save item photo',

//       });

//     }


//     const item =
//       updateResult.rows[0];


//     console.log(
//       '✅ ITEM PHOTO SAVED'
//     );

//     console.log(
//       'Photo URL:',
//       item.shopper_photo_url
//     );

//     console.log(
//       'Shopping status:',
//       item.shopping_status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Item photo uploaded successfully',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status ||
//           'done',

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ ITEM PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload item photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ITEM SHOPPING DATA
// // =====================================================

// const updateItemShoppingStatus = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     // =================================================
//     // CHECK ORDER
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     if (
//       Number(
//         orderResult.rows[0].shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     // =================================================
//     // UPDATE ITEM
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopping_status =
//             'done',

//           found_quantity =
//             $1,

//           found_weight =
//             $2,

//           found_weight_unit =
//             $3,

//           barcode_scanned =
//             $4,

//           completed_at =
//             NOW()

//         WHERE

//           id = $5

//           AND order_id = $6

//         RETURNING *

//         `,
//         [

//           foundQuantity !== undefined &&
//           foundQuantity !== null &&
//           foundQuantity !== ''
//             ? Number(foundQuantity)
//             : null,

//           foundWeight !== undefined &&
//           foundWeight !== null &&
//           foundWeight !== ''
//             ? Number(foundWeight)
//             : null,

//           foundWeightUnit ||
//             null,

//           barcodeScanned === true ||
//           barcodeScanned === 'true',

//           itemId,
//           orderId,

//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const item =
//       result.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Item shopping data updated',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status,

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPDATE ITEM SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update item shopping data',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORT
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   startShopping,

//   getMyOrders,

//   getNearbyShoppersForOrder,

//   uploadItemPhoto,

//   updateItemShoppingStatus,

// };
















// const pool = require('../config/db');


// // =====================================================
// // HELPER
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
// // GET AVAILABLE ORDERS FOR SHOPPER
// // =====================================================

// const getAvailableOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     // =================================================
//     // GET SHOPPER LOCATION
//     // =================================================

//     const shopperResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status
//         FROM shoppers
//         WHERE id = $1
//         LIMIT 1
//         `,
//         [shopperId]
//       );


//     if (
//       shopperResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Shopper not found',

//       });

//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);


//     const shopperLongitude =
//       Number(shopper.longitude);


//     if (
//       !Number.isFinite(
//         shopperLatitude
//       ) ||
//       !Number.isFinite(
//         shopperLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shopper location is not available',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 SHOPPER LOCATION'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Latitude:',
//       shopperLatitude
//     );

//     console.log(
//       'Longitude:',
//       shopperLongitude
//     );


//     // =================================================
//     // FIND AVAILABLE ORDERS
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         WITH available_orders AS (

//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,

//             o.delivery_address,

//             o.delivery_latitude,
//             o.delivery_longitude,

//             o.delivery_option,
//             o.payment_method,

//             o.items_total,
//             o.delivery_fee,
//             o.service_fee,
//             o.total_amount,

//             o.status,

//             o.created_at,
//             o.updated_at,

//             s.shop_name,
//             s.image_url AS shop_image,
//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,

//                     cos(
//                       radians($1)
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.longitude
//                       )
//                       -
//                       radians($2)
//                     )

//                     +

//                     sin(
//                       radians($1)
//                     )

//                     *

//                     sin(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                   )
//                 )
//               )
//             ) AS shop_distance_km

//           FROM orders o

//           INNER JOIN shops s
//             ON s.id = o.shop_id

//           WHERE

//             o.status =
//               'waiting_for_shopper'

//             AND

//             o.shopper_id IS NULL

//             AND

//             s.status =
//               'approved'

//             AND

//             s.latitude IS NOT NULL

//             AND

//             s.longitude IS NOT NULL

//         )

//         SELECT *

//         FROM available_orders

//         WHERE
//           shop_distance_km <= 10

//         ORDER BY

//           shop_distance_km ASC,

//           created_at ASC

//         `,
//         [
//           shopperLatitude,
//           shopperLongitude,
//         ]
//       );


//     console.log(
//       '📦 AVAILABLE REAL ORDERS:',
//       result.rows.length
//     );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC
//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             const distance =
//               Number(
//                 order.shop_distance_km
//               );


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),


//               // =======================================
//               // SHOP
//               // =======================================

//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               // =======================================
//               // CUSTOMER
//               // =======================================

//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               // =======================================
//               // MONEY
//               // =======================================

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               // =======================================
//               // DISTANCE
//               // =======================================

//               distance:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? `${distance.toFixed(1)} km`
//                   : '0.0 km',


//               distanceKm:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? Number(
//                       distance.toFixed(2)
//                     )
//                   : 0,


//               // =======================================
//               // ORDER INFO
//               // =======================================

//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,

//               status:
//                 order.status,

//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               // =======================================
//               // ITEMS
//               // =======================================

//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,


//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',


//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,


//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,


//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,


//                     barcodeScanned:
//                       item.barcode_scanned === true,


//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     // =====================================================
//     // GROUP MULTI-SHOP ORDERS
//     // =====================================================
//     //
//     // Orders from the same customer going to the same
//     // delivery location/address are treated as one batch.
//     //
//     // Example:
//     //
//     // Order 101 -> Keells
//     // Order 102 -> Cargills
//     //
//     // becomes:
//     //
//     // Batch:
//     //   orderGroupId: customer-5-6.92710-79.86120
//     //   shops: [Keells, Cargills]
//     //
//     // =====================================================

//     const orderGroups =
//       new Map();


//     orders.forEach(
//       (order) => {

//         const customerId =
//           Number(
//             order.customerId
//           );


//         const customerLatitude =
//           Number(
//             order.customerLatitude
//           );


//         const customerLongitude =
//           Number(
//             order.customerLongitude
//           );


//         const deliveryAddress =
//           String(
//             order.deliveryAddress ||
//             order.customer ||
//             ''
//           )
//             .trim()
//             .toLowerCase();


//         // =============================================
//         // LOCATION KEY
//         // =============================================

//         let locationKey =
//           'no-location';


//         if (
//           Number.isFinite(
//             customerLatitude
//           ) &&
//           Number.isFinite(
//             customerLongitude
//           )
//         ) {

//           locationKey =
//             `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//         }


//         // =============================================
//         // GROUP KEY
//         // =============================================
//         //
//         // Same customer + same delivery location
//         // + same delivery address
//         //
//         // =============================================

//         const groupKey =
//           `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//         if (
//           !orderGroups.has(
//             groupKey
//           )
//         ) {

//           orderGroups.set(
//             groupKey,
//             {
//               orderGroupId:
//                 groupKey,

//               customerId,

//               customerLatitude,

//               customerLongitude,

//               deliveryAddress,

//               orders: [],

//             }
//           );

//         }


//         const group =
//           orderGroups.get(
//             groupKey
//           );


//         group.orders.push(
//           order
//         );

//       }
//     );


//     // =====================================================
//     // ADD GROUP INFORMATION TO EVERY ORDER
//     // =====================================================

//     const ordersWithGroups =
//       orders.map(
//         (order) => {

//           const customerId =
//             Number(
//               order.customerId
//             );


//           const customerLatitude =
//             Number(
//               order.customerLatitude
//             );


//           const customerLongitude =
//             Number(
//               order.customerLongitude
//             );


//           const deliveryAddress =
//             String(
//               order.deliveryAddress ||
//               order.customer ||
//               ''
//             )
//               .trim()
//               .toLowerCase();


//           let locationKey =
//             'no-location';


//           if (
//             Number.isFinite(
//               customerLatitude
//             ) &&
//             Number.isFinite(
//               customerLongitude
//             )
//           ) {

//             locationKey =
//               `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//           }


//           const groupKey =
//             `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//           const group =
//             orderGroups.get(
//               groupKey
//             );


//           const groupedOrders =
//             group?.orders ||
//             [order];


//           // ===========================================
//           // UNIQUE SHOPS
//           // ===========================================

//           const uniqueShops =
//             [];


//           const seenShopIds =
//             new Set();


//           groupedOrders.forEach(
//             (groupOrder) => {

//               const shopId =
//                 Number(
//                   groupOrder.shopId
//                 );


//               if (
//                 !seenShopIds.has(
//                   shopId
//                 )
//               ) {

//                 seenShopIds.add(
//                   shopId
//                 );


//                 uniqueShops.push({

//                   id:
//                     shopId,

//                   name:
//                     groupOrder.storeName ||
//                     groupOrder.store ||
//                     groupOrder.shop ||
//                     'Shop',

//                   image:
//                     groupOrder.shopImage ||
//                     null,

//                   latitude:
//                     Number(
//                       groupOrder.pickupLatitude
//                     ),

//                   longitude:
//                     Number(
//                       groupOrder.pickupLongitude
//                     ),

//                   orderId:
//                     Number(
//                       groupOrder.id
//                     ),

//                 });

//               }

//             }
//           );


//           const shopNames =
//             uniqueShops.map(
//               shop =>
//                 shop.name
//             );


//           return {

//             ...order,


//             // =========================================
//             // GROUP / BATCH INFORMATION
//             // =========================================

//             orderGroupId:
//               group?.orderGroupId ||
//               groupKey,


//             batchId:
//               group?.orderGroupId ||
//               groupKey,


//             customerOrderId:
//               group?.orderGroupId ||
//               groupKey,


//             shopCount:
//               uniqueShops.length,


//             shopNames,


//             shops:
//               uniqueShops,


//             batchOrders:
//               groupedOrders.map(
//                 groupOrder => ({

//                   ...groupOrder,

//                 })
//               ),

//           };

//         }
//       );


//     // =====================================================
//     // GROUP DEBUG LOG
//     // =====================================================

//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📦 MULTI-SHOP GROUPING'
//     );

//     console.log(
//       'Total individual orders:',
//       orders.length
//     );

//     console.log(
//       'Total order groups:',
//       orderGroups.size
//     );


//     ordersWithGroups.forEach(
//       (order) => {

//         console.log(
//           'Order:',
//           order.id
//         );

//         console.log(
//           'Group:',
//           order.orderGroupId
//         );

//         console.log(
//           'Shop count:',
//           order.shopCount
//         );

//         console.log(
//           'Shops:',
//           order.shopNames
//         );

//       }
//     );


//     console.log(
//       '========================================'
//     );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ ORDERS SENT TO SHOPPER:',
//       ordersWithGroups.length
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         ordersWithGroups.length,

//       orders:
//         ordersWithGroups,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (req, res) => {

//   const client =
//     await pool.connect();


//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     await client.query(
//       'BEGIN'
//     );


//     // =================================================
//     // LOCK ORDER
//     // =================================================

//     const orderResult =
//       await client.query(
//         `
//         SELECT

//           id,
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

//           status,
//           shopper_id,

//           created_at

//         FROM orders

//         WHERE id = $1

//         FOR UPDATE

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // CHECK STATUS
//     // =================================================

//     if (
//       order.status !==
//       'waiting_for_shopper'
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//         status:
//           order.status,

//       });

//     }


//     // =================================================
//     // CHECK SHOPPER
//     // =================================================

//     if (
//       order.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order has already been accepted',

//       });

//     }


//     // =================================================
//     // ASSIGN SHOPPER
//     // =================================================

//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET

//           shopper_id =
//             $1,

//           status =
//             'shopper_accepted',

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND status =
//             'waiting_for_shopper'

//           AND shopper_id IS NULL

//         RETURNING *

//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order was already accepted',

//       });

//     }


//     // =================================================
//     // GET SHOP
//     // =================================================

//     const shopResult =
//       await client.query(
//         `
//         SELECT

//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude,
//           status

//         FROM shops

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [order.shop_id]
//       );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const itemsResult =
//       await client.query(
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
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     await client.query(
//       'COMMIT'
//     );


//     const updatedOrder =
//       updateResult.rows[0];


//     const shop =
//       shopResult.rows[0] ||
//       null;


//     const items =
//       itemsResult.rows;


//     // =================================================
//     // RESPONSE ORDER
//     // =================================================

//     const responseOrder = {

//       id:
//         Number(
//           updatedOrder.id
//         ),

//       customerId:
//         Number(
//           updatedOrder.customer_id
//         ),

//       shopId:
//         Number(
//           updatedOrder.shop_id
//         ),

//       shopperId:
//         Number(
//           updatedOrder.shopper_id
//         ),


//       store:
//         shop?.shop_name ||
//         'Shop',

//       storeName:
//         shop?.shop_name ||
//         'Shop',

//       shop:
//         shop?.shop_name ||
//         'Shop',

//       shopImage:
//         shop?.image_url ||
//         null,


//       pickupLatitude:
//         Number(
//           shop?.latitude
//         ),

//       pickupLongitude:
//         Number(
//           shop?.longitude
//         ),


//       customer:
//         updatedOrder.delivery_address,

//       customerName:
//         `Customer #${updatedOrder.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       latitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       longitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       deliveryAddress:
//         updatedOrder.delivery_address,


//       deliveryOption:
//         updatedOrder.delivery_option,

//       paymentMethod:
//         updatedOrder.payment_method,


//       itemsTotal:
//         Number(
//           updatedOrder.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           updatedOrder.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           updatedOrder.total_amount || 0
//         ),

//       fee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),


//       status:
//         updatedOrder.status,


//       createdAt:
//         updatedOrder.created_at,

//       updatedAt:
//         updatedOrder.updated_at,


//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               Number(
//                 item.id
//               ),

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,


//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,

//             shoppingStatus:
//               item.shopping_status ||
//               'pending',

//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(
//                     item.found_quantity
//                   )
//                 : null,

//             foundWeight:
//               item.found_weight !== null
//                 ? Number(
//                     item.found_weight
//                   )
//                 : null,

//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,

//             barcodeScanned:
//               item.barcode_scanned === true,

//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         ),


//       orderItems:
//         items,

//     };


//     console.log(
//       '✅ ORDER ACCEPTED:',
//       responseOrder.id
//     );


//     return res.json({

//       success: true,

//       message:
//         'Order accepted successfully',

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     try {

//       await client.query(
//         'ROLLBACK'
//       );

//     } catch (_) {}


//     console.error(
//       '❌ ACCEPT SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });


//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // START SHOPPING
// // =====================================================

// const startShopping = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status,
//           updated_at

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     if (
//       order.status ===
//       'shopping'
//     ) {

//       return res.json({

//         success: true,

//         message:
//           'Shopping has already started',

//         order: {

//           id:
//             Number(
//               order.id
//             ),

//           customerId:
//             Number(
//               order.customer_id
//             ),

//           shopId:
//             Number(
//               order.shop_id
//             ),

//           shopperId:
//             Number(
//               order.shopper_id
//             ),

//           status:
//             'shopping',

//           updatedAt:
//             order.updated_at,

//         },

//       });

//     }


//     if (
//       order.status !==
//       'shopper_accepted'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order cannot start shopping from current status',

//         status:
//           order.status,

//       });

//     }


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           status =
//             'shopping',

//           updated_at =
//             NOW()

//         WHERE

//           id = $1

//           AND shopper_id = $2

//           AND status =
//             'shopper_accepted'

//         RETURNING *

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Unable to start shopping',

//       });

//     }


//     const updatedOrder =
//       updateResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🛒 SHOPPING STARTED'
//     );

//     console.log(
//       'Order ID:',
//       updatedOrder.id
//     );

//     console.log(
//       'Shopper ID:',
//       updatedOrder.shopper_id
//     );

//     console.log(
//       'Status:',
//       updatedOrder.status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Shopping started successfully',

//       order: {

//         id:
//           Number(
//             updatedOrder.id
//           ),

//         customerId:
//           Number(
//             updatedOrder.customer_id
//           ),

//         shopId:
//           Number(
//             updatedOrder.shop_id
//           ),

//         shopperId:
//           Number(
//             updatedOrder.shopper_id
//           ),

//         status:
//           updatedOrder.status,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ START SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start shopping',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ACTIVE ORDERS
// // =====================================================

// const getMyOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const result =
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

//           o.shopper_id,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC

//         `,
//         [shopperId]
//       );


//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC

//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),

//               shopperId:
//                 Number(
//                   order.shopper_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,


//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),


//               status:
//                 order.status,


//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,

//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',

//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,

//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,

//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,

//                     barcodeScanned:
//                       item.barcode_scanned === true,

//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET MY SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY ONLINE SHOPPERS FOR CUSTOMER ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           o.id,
//           o.shop_id,

//           s.shop_name,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE o.id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const shopLatitude =
//       Number(
//         order.shop_latitude
//       );


//     const shopLongitude =
//       Number(
//         order.shop_longitude
//       );


//     if (
//       !Number.isFinite(
//         shopLatitude
//       ) ||
//       !Number.isFinite(
//         shopLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop location is not available',

//       });

//     }


//     const shoppersResult =
//       await pool.query(
//         `
//         SELECT

//           id,

//           latitude,
//           longitude,

//           status

//         FROM shoppers

//         WHERE

//           status = 'online'

//           AND latitude IS NOT NULL

//           AND longitude IS NOT NULL

//           AND (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) <= 10

//         ORDER BY

//           (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) ASC

//         `,
//         [
//           shopLatitude,
//           shopLongitude,
//         ]
//       );


//     const shoppers =
//       shoppersResult.rows.map(
//         shopper => {

//           const latitude =
//             Number(
//               shopper.latitude
//             );


//           const longitude =
//             Number(
//               shopper.longitude
//             );


//           const distanceKm =
//             6371 *

//             Math.acos(

//               Math.min(

//                 1,

//                 Math.max(

//                   -1,

//                   Math.cos(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     (
//                       longitude -
//                       shopLongitude
//                     ) *
//                     Math.PI /
//                     180
//                   )

//                   +

//                   Math.sin(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.sin(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                 )

//               )

//             );


//           return {

//             id:
//               Number(
//                 shopper.id
//               ),

//             latitude,

//             longitude,

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 distanceKm.toFixed(2)
//               ),

//           };

//         }
//       );


//     return res.json({

//       success: true,

//       orderId,

//       shop: {

//         id:
//           Number(
//             order.shop_id
//           ),

//         name:
//           order.shop_name,

//         latitude:
//           shopLatitude,

//         longitude:
//           shopLongitude,

//       },

//       count:
//         shoppers.length,

//       shoppers,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET NEARBY SHOPPERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // =====================================================

// const uploadItemPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Item photo is required',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📸 ITEM PHOTO UPLOAD'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Item ID:',
//       itemId
//     );

//     console.log(
//       'File:',
//       req.file.filename
//     );


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const parsedQuantity =
//       foundQuantity !== undefined &&
//       foundQuantity !== null &&
//       foundQuantity !== ''
//         ? Number(foundQuantity)
//         : null;


//     const parsedWeight =
//       foundWeight !== undefined &&
//       foundWeight !== null &&
//       foundWeight !== ''
//         ? Number(foundWeight)
//         : null;


//     const parsedBarcode =
//       barcodeScanned === true ||
//       barcodeScanned === 'true';


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopper_photo_url =
//             $1,

//           shopping_status =
//             'done',

//           found_quantity =
//             $2,

//           found_weight =
//             $3,

//           found_weight_unit =
//             $4,

//           barcode_scanned =
//             $5,

//           completed_at =
//             NOW()

//         WHERE

//           id = $6

//           AND order_id = $7

//         RETURNING *

//         `,
//         [
//           photoUrl,
//           parsedQuantity,
//           parsedWeight,
//           foundWeightUnit ||
//             null,
//           parsedBarcode,
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save item photo',

//       });

//     }


//     const item =
//       updateResult.rows[0];


//     console.log(
//       '✅ ITEM PHOTO SAVED'
//     );

//     console.log(
//       'Photo URL:',
//       item.shopper_photo_url
//     );

//     console.log(
//       'Shopping status:',
//       item.shopping_status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Item photo uploaded successfully',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status ||
//           'done',

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ ITEM PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload item photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ITEM SHOPPING DATA
// // =====================================================

// const updateItemShoppingStatus = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     if (
//       Number(
//         orderResult.rows[0].shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopping_status =
//             'done',

//           found_quantity =
//             $1,

//           found_weight =
//             $2,

//           found_weight_unit =
//             $3,

//           barcode_scanned =
//             $4,

//           completed_at =
//             NOW()

//         WHERE

//           id = $5

//           AND order_id = $6

//         RETURNING *

//         `,
//         [

//           foundQuantity !== undefined &&
//           foundQuantity !== null &&
//           foundQuantity !== ''
//             ? Number(foundQuantity)
//             : null,

//           foundWeight !== undefined &&
//           foundWeight !== null &&
//           foundWeight !== ''
//             ? Number(foundWeight)
//             : null,

//           foundWeightUnit ||
//             null,

//           barcodeScanned === true ||
//           barcodeScanned === 'true',

//           itemId,
//           orderId,

//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const item =
//       result.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Item shopping data updated',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status,

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPDATE ITEM SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update item shopping data',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORT
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   startShopping,

//   getMyOrders,

//   getNearbyShoppersForOrder,

//   uploadItemPhoto,

//   updateItemShoppingStatus,

// };






















// const pool = require('../config/db');


// // =====================================================
// // HELPER
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
// // GET AVAILABLE ORDERS FOR SHOPPER
// // =====================================================

// const getAvailableOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     // =================================================
//     // GET SHOPPER LOCATION
//     // =================================================

//     const shopperResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status
//         FROM shoppers
//         WHERE id = $1
//         LIMIT 1
//         `,
//         [shopperId]
//       );


//     if (
//       shopperResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Shopper not found',

//       });

//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);


//     const shopperLongitude =
//       Number(shopper.longitude);


//     if (
//       !Number.isFinite(
//         shopperLatitude
//       ) ||
//       !Number.isFinite(
//         shopperLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shopper location is not available',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 SHOPPER LOCATION'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Latitude:',
//       shopperLatitude
//     );

//     console.log(
//       'Longitude:',
//       shopperLongitude
//     );


//     // =================================================
//     // FIND AVAILABLE ORDERS
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         WITH available_orders AS (

//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,

//             o.delivery_address,

//             o.delivery_latitude,
//             o.delivery_longitude,

//             o.delivery_option,
//             o.payment_method,

//             o.items_total,
//             o.delivery_fee,
//             o.service_fee,
//             o.total_amount,

//             o.status,

//             o.created_at,
//             o.updated_at,

//             s.shop_name,
//             s.image_url AS shop_image,
//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,

//                     cos(
//                       radians($1)
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.longitude
//                       )
//                       -
//                       radians($2)
//                     )

//                     +

//                     sin(
//                       radians($1)
//                     )

//                     *

//                     sin(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                   )
//                 )
//               )
//             ) AS shop_distance_km

//           FROM orders o

//           INNER JOIN shops s
//             ON s.id = o.shop_id

//           WHERE

//             o.status =
//               'waiting_for_shopper'

//             AND

//             o.shopper_id IS NULL

//             AND

//             s.status =
//               'approved'

//             AND

//             s.latitude IS NOT NULL

//             AND

//             s.longitude IS NOT NULL

//         )

//         SELECT *

//         FROM available_orders

//         WHERE
//           shop_distance_km <= 10

//         ORDER BY

//           shop_distance_km ASC,

//           created_at ASC

//         `,
//         [
//           shopperLatitude,
//           shopperLongitude,
//         ]
//       );


//     console.log(
//       '📦 AVAILABLE REAL ORDERS:',
//       result.rows.length
//     );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC
//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             const distance =
//               Number(
//                 order.shop_distance_km
//               );


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               distance:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? `${distance.toFixed(1)} km`
//                   : '0.0 km',


//               distanceKm:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? Number(
//                       distance.toFixed(2)
//                     )
//                   : 0,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,

//               status:
//                 order.status,

//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,


//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',


//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,


//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,


//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,


//                     barcodeScanned:
//                       item.barcode_scanned === true,


//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     // =====================================================
//     // GROUP MULTI-SHOP ORDERS
//     // =====================================================

//     const orderGroups =
//       new Map();


//     orders.forEach(
//       (order) => {

//         const customerId =
//           Number(
//             order.customerId
//           );


//         const customerLatitude =
//           Number(
//             order.customerLatitude
//           );


//         const customerLongitude =
//           Number(
//             order.customerLongitude
//           );


//         const deliveryAddress =
//           String(
//             order.deliveryAddress ||
//             order.customer ||
//             ''
//           )
//             .trim()
//             .toLowerCase();


//         let locationKey =
//           'no-location';


//         if (
//           Number.isFinite(
//             customerLatitude
//           ) &&
//           Number.isFinite(
//             customerLongitude
//           )
//         ) {

//           locationKey =
//             `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//         }


//         const groupKey =
//           `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//         if (
//           !orderGroups.has(
//             groupKey
//           )
//         ) {

//           orderGroups.set(
//             groupKey,
//             {
//               orderGroupId:
//                 groupKey,

//               customerId,

//               customerLatitude,

//               customerLongitude,

//               deliveryAddress,

//               orders: [],

//             }
//           );

//         }


//         const group =
//           orderGroups.get(
//             groupKey
//           );


//         group.orders.push(
//           order
//         );

//       }
//     );


//     // =====================================================
//     // ADD GROUP INFORMATION
//     // =====================================================

//     const ordersWithGroups =
//       orders.map(
//         (order) => {

//           const customerId =
//             Number(
//               order.customerId
//             );


//           const customerLatitude =
//             Number(
//               order.customerLatitude
//             );


//           const customerLongitude =
//             Number(
//               order.customerLongitude
//             );


//           const deliveryAddress =
//             String(
//               order.deliveryAddress ||
//               order.customer ||
//               ''
//             )
//               .trim()
//               .toLowerCase();


//           let locationKey =
//             'no-location';


//           if (
//             Number.isFinite(
//               customerLatitude
//             ) &&
//             Number.isFinite(
//               customerLongitude
//             )
//           ) {

//             locationKey =
//               `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//           }


//           const groupKey =
//             `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//           const group =
//             orderGroups.get(
//               groupKey
//             );


//           const groupedOrders =
//             group?.orders ||
//             [order];


//           const uniqueShops =
//             [];


//           const seenShopIds =
//             new Set();


//           groupedOrders.forEach(
//             (groupOrder) => {

//               const shopId =
//                 Number(
//                   groupOrder.shopId
//                 );


//               if (
//                 !seenShopIds.has(
//                   shopId
//                 )
//               ) {

//                 seenShopIds.add(
//                   shopId
//                 );


//                 uniqueShops.push({

//                   id:
//                     shopId,

//                   name:
//                     groupOrder.storeName ||
//                     groupOrder.store ||
//                     groupOrder.shop ||
//                     'Shop',

//                   image:
//                     groupOrder.shopImage ||
//                     null,

//                   latitude:
//                     Number(
//                       groupOrder.pickupLatitude
//                     ),

//                   longitude:
//                     Number(
//                       groupOrder.pickupLongitude
//                     ),

//                   orderId:
//                     Number(
//                       groupOrder.id
//                     ),

//                 });

//               }

//             }
//           );


//           const shopNames =
//             uniqueShops.map(
//               shop =>
//                 shop.name
//             );


//           return {

//             ...order,

//             orderGroupId:
//               group?.orderGroupId ||
//               groupKey,

//             batchId:
//               group?.orderGroupId ||
//               groupKey,

//             customerOrderId:
//               group?.orderGroupId ||
//               groupKey,

//             shopCount:
//               uniqueShops.length,

//             shopNames,

//             shops:
//               uniqueShops,

//             batchOrders:
//               groupedOrders.map(
//                 groupOrder => ({
//                   ...groupOrder,
//                 })
//               ),

//           };

//         }
//       );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📦 MULTI-SHOP GROUPING'
//     );

//     console.log(
//       'Total individual orders:',
//       orders.length
//     );

//     console.log(
//       'Total order groups:',
//       orderGroups.size
//     );


//     ordersWithGroups.forEach(
//       (order) => {

//         console.log(
//           'Order:',
//           order.id
//         );

//         console.log(
//           'Group:',
//           order.orderGroupId
//         );

//         console.log(
//           'Shop count:',
//           order.shopCount
//         );

//         console.log(
//           'Shops:',
//           order.shopNames
//         );

//       }
//     );


//     console.log(
//       '========================================'
//     );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ ORDERS SENT TO SHOPPER:',
//       ordersWithGroups.length
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         ordersWithGroups.length,

//       orders:
//         ordersWithGroups,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (req, res) => {

//   const client =
//     await pool.connect();


//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     await client.query(
//       'BEGIN'
//     );


//     const orderResult =
//       await client.query(
//         `
//         SELECT

//           id,
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

//           status,
//           shopper_id,

//           created_at

//         FROM orders

//         WHERE id = $1

//         FOR UPDATE

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       order.status !==
//       'waiting_for_shopper'
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//         status:
//           order.status,

//       });

//     }


//     if (
//       order.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order has already been accepted',

//       });

//     }


//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET

//           shopper_id =
//             $1,

//           status =
//             'shopper_accepted',

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND status =
//             'waiting_for_shopper'

//           AND shopper_id IS NULL

//         RETURNING *

//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order was already accepted',

//       });

//     }


//     const shopResult =
//       await client.query(
//         `
//         SELECT

//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude,
//           status

//         FROM shops

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [order.shop_id]
//       );


//     const itemsResult =
//       await client.query(
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
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     await client.query(
//       'COMMIT'
//     );


//     const updatedOrder =
//       updateResult.rows[0];


//     const shop =
//       shopResult.rows[0] ||
//       null;


//     const items =
//       itemsResult.rows;


//     const responseOrder = {

//       id:
//         Number(
//           updatedOrder.id
//         ),

//       customerId:
//         Number(
//           updatedOrder.customer_id
//         ),

//       shopId:
//         Number(
//           updatedOrder.shop_id
//         ),

//       shopperId:
//         Number(
//           updatedOrder.shopper_id
//         ),


//       store:
//         shop?.shop_name ||
//         'Shop',

//       storeName:
//         shop?.shop_name ||
//         'Shop',

//       shop:
//         shop?.shop_name ||
//         'Shop',

//       shopImage:
//         shop?.image_url ||
//         null,


//       pickupLatitude:
//         Number(
//           shop?.latitude
//         ),

//       pickupLongitude:
//         Number(
//           shop?.longitude
//         ),


//       customer:
//         updatedOrder.delivery_address,

//       customerName:
//         `Customer #${updatedOrder.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       latitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       longitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       deliveryAddress:
//         updatedOrder.delivery_address,


//       deliveryOption:
//         updatedOrder.delivery_option,

//       paymentMethod:
//         updatedOrder.payment_method,


//       itemsTotal:
//         Number(
//           updatedOrder.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           updatedOrder.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           updatedOrder.total_amount || 0
//         ),

//       fee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),


//       status:
//         updatedOrder.status,


//       createdAt:
//         updatedOrder.created_at,

//       updatedAt:
//         updatedOrder.updated_at,


//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               Number(
//                 item.id
//               ),

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,


//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,

//             shoppingStatus:
//               item.shopping_status ||
//               'pending',

//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(
//                     item.found_quantity
//                   )
//                 : null,

//             foundWeight:
//               item.found_weight !== null
//                 ? Number(
//                     item.found_weight
//                   )
//                 : null,

//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,

//             barcodeScanned:
//               item.barcode_scanned === true,

//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         ),


//       orderItems:
//         items,

//     };


//     console.log(
//       '✅ ORDER ACCEPTED:',
//       responseOrder.id
//     );


//     return res.json({

//       success: true,

//       message:
//         'Order accepted successfully',

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     try {

//       await client.query(
//         'ROLLBACK'
//       );

//     } catch (_) {}


//     console.error(
//       '❌ ACCEPT SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });


//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // START SHOPPING
// // =====================================================

// const startShopping = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status,
//           updated_at

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     if (
//       order.status ===
//       'shopping'
//     ) {

//       return res.json({

//         success: true,

//         message:
//           'Shopping has already started',

//         order: {

//           id:
//             Number(
//               order.id
//             ),

//           customerId:
//             Number(
//               order.customer_id
//             ),

//           shopId:
//             Number(
//               order.shop_id
//             ),

//           shopperId:
//             Number(
//               order.shopper_id
//             ),

//           status:
//             'shopping',

//           updatedAt:
//             order.updated_at,

//         },

//       });

//     }


//     if (
//       order.status !==
//       'shopper_accepted'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order cannot start shopping from current status',

//         status:
//           order.status,

//       });

//     }


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           status =
//             'shopping',

//           updated_at =
//             NOW()

//         WHERE

//           id = $1

//           AND shopper_id = $2

//           AND status =
//             'shopper_accepted'

//         RETURNING *

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Unable to start shopping',

//       });

//     }


//     const updatedOrder =
//       updateResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🛒 SHOPPING STARTED'
//     );

//     console.log(
//       'Order ID:',
//       updatedOrder.id
//     );

//     console.log(
//       'Shopper ID:',
//       updatedOrder.shopper_id
//     );

//     console.log(
//       'Status:',
//       updatedOrder.status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Shopping started successfully',

//       order: {

//         id:
//           Number(
//             updatedOrder.id
//           ),

//         customerId:
//           Number(
//             updatedOrder.customer_id
//           ),

//         shopId:
//           Number(
//             updatedOrder.shop_id
//           ),

//         shopperId:
//           Number(
//             updatedOrder.shopper_id
//           ),

//         status:
//           updatedOrder.status,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ START SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start shopping',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ACTIVE ORDERS
// // =====================================================

// const getMyOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const result =
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

//           o.shopper_id,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC

//         `,
//         [shopperId]
//       );


//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC

//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),

//               shopperId:
//                 Number(
//                   order.shopper_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,


//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),


//               status:
//                 order.status,


//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,

//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',

//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,

//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,

//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,

//                     barcodeScanned:
//                       item.barcode_scanned === true,

//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET MY SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY ONLINE SHOPPERS FOR CUSTOMER ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           o.id,
//           o.shop_id,

//           s.shop_name,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE o.id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const shopLatitude =
//       Number(
//         order.shop_latitude
//       );


//     const shopLongitude =
//       Number(
//         order.shop_longitude
//       );


//     if (
//       !Number.isFinite(
//         shopLatitude
//       ) ||
//       !Number.isFinite(
//         shopLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop location is not available',

//       });

//     }


//     const shoppersResult =
//       await pool.query(
//         `
//         SELECT

//           id,

//           latitude,
//           longitude,

//           status

//         FROM shoppers

//         WHERE

//           status = 'online'

//           AND latitude IS NOT NULL

//           AND longitude IS NOT NULL

//           AND (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) <= 10

//         ORDER BY

//           (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) ASC

//         `,
//         [
//           shopLatitude,
//           shopLongitude,
//         ]
//       );


//     const shoppers =
//       shoppersResult.rows.map(
//         shopper => {

//           const latitude =
//             Number(
//               shopper.latitude
//             );


//           const longitude =
//             Number(
//               shopper.longitude
//             );


//           const distanceKm =
//             6371 *

//             Math.acos(

//               Math.min(

//                 1,

//                 Math.max(

//                   -1,

//                   Math.cos(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     (
//                       longitude -
//                       shopLongitude
//                     ) *
//                     Math.PI /
//                     180
//                   )

//                   +

//                   Math.sin(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.sin(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                 )

//               )

//             );


//           return {

//             id:
//               Number(
//                 shopper.id
//               ),

//             latitude,

//             longitude,

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 distanceKm.toFixed(2)
//               ),

//           };

//         }
//       );


//     return res.json({

//       success: true,

//       orderId,

//       shop: {

//         id:
//           Number(
//             order.shop_id
//           ),

//         name:
//           order.shop_name,

//         latitude:
//           shopLatitude,

//         longitude:
//           shopLongitude,

//       },

//       count:
//         shoppers.length,

//       shoppers,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET NEARBY SHOPPERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // =====================================================

// const uploadItemPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Item photo is required',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📸 ITEM PHOTO UPLOAD'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Item ID:',
//       itemId
//     );

//     console.log(
//       'File:',
//       req.file.filename
//     );


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const parsedQuantity =
//       foundQuantity !== undefined &&
//       foundQuantity !== null &&
//       foundQuantity !== ''
//         ? Number(foundQuantity)
//         : null;


//     const parsedWeight =
//       foundWeight !== undefined &&
//       foundWeight !== null &&
//       foundWeight !== ''
//         ? Number(foundWeight)
//         : null;


//     const parsedBarcode =
//       barcodeScanned === true ||
//       barcodeScanned === 'true';


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopper_photo_url =
//             $1,

//           shopping_status =
//             'done',

//           found_quantity =
//             $2,

//           found_weight =
//             $3,

//           found_weight_unit =
//             $4,

//           barcode_scanned =
//             $5,

//           completed_at =
//             NOW()

//         WHERE

//           id = $6

//           AND order_id = $7

//         RETURNING *

//         `,
//         [
//           photoUrl,
//           parsedQuantity,
//           parsedWeight,
//           foundWeightUnit ||
//             null,
//           parsedBarcode,
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save item photo',

//       });

//     }


//     const item =
//       updateResult.rows[0];


//     console.log(
//       '✅ ITEM PHOTO SAVED'
//     );

//     console.log(
//       'Photo URL:',
//       item.shopper_photo_url
//     );

//     console.log(
//       'Shopping status:',
//       item.shopping_status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Item photo uploaded successfully',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status ||
//           'done',

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ ITEM PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload item photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER REPLACEMENT PHOTO
// // =====================================================
// //
// // This is for ReplacementItems.js.
// //
// // Shopper takes a replacement-item photo.
// // The photo is saved in:
// //
// // src/uploads/replacements
// //
// // and the URL is saved in:
// //
// // replacement_items
// //
// // =====================================================

// const uploadReplacementPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Replacement photo is required',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📸 REPLACEMENT PHOTO UPLOAD'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Original Item ID:',
//       itemId
//     );

//     console.log(
//       'File:',
//       req.file.filename
//     );


//     // =================================================
//     // CHECK ORDER
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           customer_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // CHECK SHOPPER
//     // =================================================

//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     // =================================================
//     // CHECK ORIGINAL ITEM
//     // =================================================

//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Original order item not found',

//       });

//     }


//     const originalItem =
//       itemResult.rows[0];


//     // =================================================
//     // GET NEXT OPTION NUMBER
//     // =================================================

//     const optionResult =
//       await pool.query(
//         `
//         SELECT

//           COALESCE(
//             MAX(option_number),
//             0
//           ) + 1 AS next_option

//         FROM replacement_items

//         WHERE

//           order_id = $1

//           AND original_item_id = $2

//         `,
//         [
//           orderId,
//           itemId,
//         ]
//       );


//     const optionNumber =
//       Number(
//         optionResult.rows[0]?.next_option ||
//         1
//       );


//     // =================================================
//     // PHOTO URL
//     // =================================================

//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/replacements/${req.file.filename}`;


//     // =================================================
//     // SAVE REPLACEMENT PHOTO
//     // =================================================

//     const insertResult =
//       await pool.query(
//         `
//         INSERT INTO replacement_items (

//           order_id,

//           original_item_id,

//           shopper_id,

//           option_number,

//           photo_url,

//           status,

//           created_at,

//           updated_at

//         )

//         VALUES (

//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           'waiting_customer',
//           NOW(),
//           NOW()

//         )

//         RETURNING *

//         `,
//         [
//           orderId,
//           itemId,
//           shopperId,
//           optionNumber,
//           photoUrl,
//         ]
//       );


//     if (
//       insertResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save replacement photo',

//       });

//     }


//     const replacement =
//       insertResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ REPLACEMENT PHOTO SAVED'
//     );

//     console.log(
//       'Replacement ID:',
//       replacement.id
//     );

//     console.log(
//       'Option Number:',
//       replacement.option_number
//     );

//     console.log(
//       'Photo URL:',
//       replacement.photo_url
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Replacement photo uploaded successfully',

//       replacement: {

//         id:
//           Number(
//             replacement.id
//           ),

//         orderId:
//           Number(
//             replacement.order_id
//           ),

//         originalItemId:
//           Number(
//             replacement.original_item_id
//           ),

//         originalItemName:
//           originalItem.item_name,

//         shopperId:
//           Number(
//             replacement.shopper_id
//           ),

//         optionNumber:
//           Number(
//             replacement.option_number
//           ),

//         photoUrl:
//           replacement.photo_url,

//         replacementPhotoUrl:
//           replacement.photo_url,

//         status:
//           replacement.status,

//         createdAt:
//           replacement.created_at,

//         updatedAt:
//           replacement.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ REPLACEMENT PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload replacement photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ITEM SHOPPING DATA
// // =====================================================

// const updateItemShoppingStatus = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     if (
//       Number(
//         orderResult.rows[0].shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopping_status =
//             'done',

//           found_quantity =
//             $1,

//           found_weight =
//             $2,

//           found_weight_unit =
//             $3,

//           barcode_scanned =
//             $4,

//           completed_at =
//             NOW()

//         WHERE

//           id = $5

//           AND order_id = $6

//         RETURNING *

//         `,
//         [

//           foundQuantity !== undefined &&
//           foundQuantity !== null &&
//           foundQuantity !== ''
//             ? Number(foundQuantity)
//             : null,

//           foundWeight !== undefined &&
//           foundWeight !== null &&
//           foundWeight !== ''
//             ? Number(foundWeight)
//             : null,

//           foundWeightUnit ||
//             null,

//           barcodeScanned === true ||
//           barcodeScanned === 'true',

//           itemId,
//           orderId,

//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const item =
//       result.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Item shopping data updated',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status,

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPDATE ITEM SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update item shopping data',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORT
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   startShopping,

//   getMyOrders,

//   getNearbyShoppersForOrder,

//   uploadItemPhoto,

//   uploadReplacementPhoto,

//   updateItemShoppingStatus,

// };










// const pool = require('../config/db');


// // =====================================================
// // HELPER
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
// // GET AVAILABLE ORDERS FOR SHOPPER
// // =====================================================

// const getAvailableOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     // =================================================
//     // GET SHOPPER LOCATION
//     // =================================================

//     const shopperResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status
//         FROM shoppers
//         WHERE id = $1
//         LIMIT 1
//         `,
//         [shopperId]
//       );


//     if (
//       shopperResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Shopper not found',

//       });

//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);


//     const shopperLongitude =
//       Number(shopper.longitude);


//     if (
//       !Number.isFinite(
//         shopperLatitude
//       ) ||
//       !Number.isFinite(
//         shopperLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shopper location is not available',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 SHOPPER LOCATION'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Latitude:',
//       shopperLatitude
//     );

//     console.log(
//       'Longitude:',
//       shopperLongitude
//     );


//     // =================================================
//     // FIND AVAILABLE ORDERS
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         WITH available_orders AS (

//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,

//             o.delivery_address,

//             o.delivery_latitude,
//             o.delivery_longitude,

//             o.delivery_option,
//             o.payment_method,

//             o.items_total,
//             o.delivery_fee,
//             o.service_fee,
//             o.total_amount,

//             o.status,

//             o.created_at,
//             o.updated_at,

//             s.shop_name,
//             s.image_url AS shop_image,
//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,

//                     cos(
//                       radians($1)
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.longitude
//                       )
//                       -
//                       radians($2)
//                     )

//                     +

//                     sin(
//                       radians($1)
//                     )

//                     *

//                     sin(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                   )
//                 )
//               )
//             ) AS shop_distance_km

//           FROM orders o

//           INNER JOIN shops s
//             ON s.id = o.shop_id

//           WHERE

//             o.status =
//               'waiting_for_shopper'

//             AND

//             o.shopper_id IS NULL

//             AND

//             s.status =
//               'approved'

//             AND

//             s.latitude IS NOT NULL

//             AND

//             s.longitude IS NOT NULL

//         )

//         SELECT *

//         FROM available_orders

//         WHERE
//           shop_distance_km <= 10

//         ORDER BY

//           shop_distance_km ASC,

//           created_at ASC

//         `,
//         [
//           shopperLatitude,
//           shopperLongitude,
//         ]
//       );


//     console.log(
//       '📦 AVAILABLE REAL ORDERS:',
//       result.rows.length
//     );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC
//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             const distance =
//               Number(
//                 order.shop_distance_km
//               );


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               distance:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? `${distance.toFixed(1)} km`
//                   : '0.0 km',


//               distanceKm:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? Number(
//                       distance.toFixed(2)
//                     )
//                   : 0,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,

//               status:
//                 order.status,

//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,


//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',


//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,


//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,


//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,


//                     barcodeScanned:
//                       item.barcode_scanned === true,


//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     // =====================================================
//     // GROUP MULTI-SHOP ORDERS
//     // =====================================================

//     const orderGroups =
//       new Map();


//     orders.forEach(
//       (order) => {

//         const customerId =
//           Number(
//             order.customerId
//           );


//         const customerLatitude =
//           Number(
//             order.customerLatitude
//           );


//         const customerLongitude =
//           Number(
//             order.customerLongitude
//           );


//         const deliveryAddress =
//           String(
//             order.deliveryAddress ||
//             order.customer ||
//             ''
//           )
//             .trim()
//             .toLowerCase();


//         let locationKey =
//           'no-location';


//         if (
//           Number.isFinite(
//             customerLatitude
//           ) &&
//           Number.isFinite(
//             customerLongitude
//           )
//         ) {

//           locationKey =
//             `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//         }


//         const groupKey =
//           `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//         if (
//           !orderGroups.has(
//             groupKey
//           )
//         ) {

//           orderGroups.set(
//             groupKey,
//             {
//               orderGroupId:
//                 groupKey,

//               customerId,

//               customerLatitude,

//               customerLongitude,

//               deliveryAddress,

//               orders: [],

//             }
//           );

//         }


//         const group =
//           orderGroups.get(
//             groupKey
//           );


//         group.orders.push(
//           order
//         );

//       }
//     );


//     // =====================================================
//     // ADD GROUP INFORMATION
//     // =====================================================

//     const ordersWithGroups =
//       orders.map(
//         (order) => {

//           const customerId =
//             Number(
//               order.customerId
//             );


//           const customerLatitude =
//             Number(
//               order.customerLatitude
//             );


//           const customerLongitude =
//             Number(
//               order.customerLongitude
//             );


//           const deliveryAddress =
//             String(
//               order.deliveryAddress ||
//               order.customer ||
//               ''
//             )
//               .trim()
//               .toLowerCase();


//           let locationKey =
//             'no-location';


//           if (
//             Number.isFinite(
//               customerLatitude
//             ) &&
//             Number.isFinite(
//               customerLongitude
//             )
//           ) {

//             locationKey =
//               `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//           }


//           const groupKey =
//             `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//           const group =
//             orderGroups.get(
//               groupKey
//             );


//           const groupedOrders =
//             group?.orders ||
//             [order];


//           const uniqueShops =
//             [];


//           const seenShopIds =
//             new Set();


//           groupedOrders.forEach(
//             (groupOrder) => {

//               const shopId =
//                 Number(
//                   groupOrder.shopId
//                 );


//               if (
//                 !seenShopIds.has(
//                   shopId
//                 )
//               ) {

//                 seenShopIds.add(
//                   shopId
//                 );


//                 uniqueShops.push({

//                   id:
//                     shopId,

//                   name:
//                     groupOrder.storeName ||
//                     groupOrder.store ||
//                     groupOrder.shop ||
//                     'Shop',

//                   image:
//                     groupOrder.shopImage ||
//                     null,

//                   latitude:
//                     Number(
//                       groupOrder.pickupLatitude
//                     ),

//                   longitude:
//                     Number(
//                       groupOrder.pickupLongitude
//                     ),

//                   orderId:
//                     Number(
//                       groupOrder.id
//                     ),

//                 });

//               }

//             }
//           );


//           const shopNames =
//             uniqueShops.map(
//               shop =>
//                 shop.name
//             );


//           return {

//             ...order,

//             orderGroupId:
//               group?.orderGroupId ||
//               groupKey,

//             batchId:
//               group?.orderGroupId ||
//               groupKey,

//             customerOrderId:
//               group?.orderGroupId ||
//               groupKey,

//             shopCount:
//               uniqueShops.length,

//             shopNames,

//             shops:
//               uniqueShops,

//             batchOrders:
//               groupedOrders.map(
//                 groupOrder => ({
//                   ...groupOrder,
//                 })
//               ),

//           };

//         }
//       );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📦 MULTI-SHOP GROUPING'
//     );

//     console.log(
//       'Total individual orders:',
//       orders.length
//     );

//     console.log(
//       'Total order groups:',
//       orderGroups.size
//     );


//     ordersWithGroups.forEach(
//       (order) => {

//         console.log(
//           'Order:',
//           order.id
//         );

//         console.log(
//           'Group:',
//           order.orderGroupId
//         );

//         console.log(
//           'Shop count:',
//           order.shopCount
//         );

//         console.log(
//           'Shops:',
//           order.shopNames
//         );

//       }
//     );


//     console.log(
//       '========================================'
//     );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ ORDERS SENT TO SHOPPER:',
//       ordersWithGroups.length
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         ordersWithGroups.length,

//       orders:
//         ordersWithGroups,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET SINGLE SHOPPER ORDER
// // =====================================================

// const getMyOrderById = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     // =================================================
//     // GET ORDER
//     // =================================================

//     const orderResult =
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
//           o.shopper_id,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE

//           o.id = $1

//           AND

//           o.shopper_id = $2

//         LIMIT 1

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found or does not belong to this shopper',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // GET ORDER ITEMS
//     // =================================================

//     const itemsResult =
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
//           completed_at

//         FROM order_items

//         WHERE

//           order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     const items =
//       itemsResult.rows;


//     // =================================================
//     // GET REPLACEMENT ITEMS
//     // =================================================

//     const replacementsResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           original_item_id,
//           shopper_id,
//           option_number,

//           photo_url,

//           status,

//           created_at,
//           updated_at

//         FROM replacement_items

//         WHERE

//           order_id = $1

//         ORDER BY

//           original_item_id ASC,
//           option_number ASC,
//           id ASC

//         `,
//         [orderId]
//       );


//     const replacementItems =
//       replacementsResult.rows.map(
//         replacement => ({

//           id:
//             Number(
//               replacement.id
//             ),

//           orderId:
//             Number(
//               replacement.order_id
//             ),

//           originalItemId:
//             Number(
//               replacement.original_item_id
//             ),

//           shopperId:
//             Number(
//               replacement.shopper_id
//             ),

//           optionNumber:
//             Number(
//               replacement.option_number
//             ),

//           photoUrl:
//             replacement.photo_url,

//           photo_url:
//             replacement.photo_url,

//           replacementPhotoUrl:
//             replacement.photo_url,

//           replacement_photo_url:
//             replacement.photo_url,

//           status:
//             replacement.status,

//           createdAt:
//             replacement.created_at,

//           updatedAt:
//             replacement.updated_at,

//         })
//       );


//     // =================================================
//     // BUILD RESPONSE
//     // =================================================

//     const responseOrder = {

//       id:
//         Number(
//           order.id
//         ),

//       customerId:
//         Number(
//           order.customer_id
//         ),

//       shopId:
//         Number(
//           order.shop_id
//         ),

//       shopperId:
//         Number(
//           order.shopper_id
//         ),


//       store:
//         order.shop_name,

//       storeName:
//         order.shop_name,

//       shop:
//         order.shop_name,


//       shopImage:
//         order.shop_image ||
//         null,


//       pickupLatitude:
//         Number(
//           order.shop_latitude
//         ),

//       pickupLongitude:
//         Number(
//           order.shop_longitude
//         ),


//       customer:
//         order.delivery_address,

//       customerName:
//         `Customer #${order.customer_id}`,


//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           order.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           order.delivery_longitude
//         ),


//       latitude:
//         Number(
//           order.delivery_latitude
//         ),

//       longitude:
//         Number(
//           order.delivery_longitude
//         ),


//       deliveryAddress:
//         order.delivery_address,


//       deliveryOption:
//         order.delivery_option,

//       paymentMethod:
//         order.payment_method,


//       itemsTotal:
//         Number(
//           order.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           order.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           order.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           order.total_amount || 0
//         ),

//       fee:
//         Number(
//           order.delivery_fee || 0
//         ),


//       status:
//         order.status,


//       createdAt:
//         order.created_at,

//       updatedAt:
//         order.updated_at,


//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               Number(
//                 item.id
//               ),

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,


//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,


//             shoppingStatus:
//               item.shopping_status ||
//               'pending',


//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(
//                     item.found_quantity
//                   )
//                 : null,


//             foundWeight:
//               item.found_weight !== null
//                 ? Number(
//                     item.found_weight
//                   )
//                 : null,


//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,


//             barcodeScanned:
//               item.barcode_scanned === true,


//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         ),


//       orderItems:
//         items,


//       // =================================================
//       // REPLACEMENT ITEMS
//       // =================================================

//       replacementItems,

//       replacements:
//         replacementItems,

//     };


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🔄 SHOPPER ORDER STATUS FETCH'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Order Status:',
//       order.status
//     );

//     console.log(
//       'Replacement Count:',
//       replacementItems.length
//     );


//     replacementItems.forEach(
//       replacement => {

//         console.log(
//           'Replacement:',
//           replacement.id,
//           'Original Item:',
//           replacement.originalItemId,
//           'Status:',
//           replacement.status
//         );

//       }
//     );


//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SINGLE SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper order',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (req, res) => {

//   const client =
//     await pool.connect();


//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     await client.query(
//       'BEGIN'
//     );


//     const orderResult =
//       await client.query(
//         `
//         SELECT

//           id,
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

//           status,
//           shopper_id,

//           created_at

//         FROM orders

//         WHERE id = $1

//         FOR UPDATE

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       order.status !==
//       'waiting_for_shopper'
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//         status:
//           order.status,

//       });

//     }


//     if (
//       order.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order has already been accepted',

//       });

//     }


//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET

//           shopper_id =
//             $1,

//           status =
//             'shopper_accepted',

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND status =
//             'waiting_for_shopper'

//           AND shopper_id IS NULL

//         RETURNING *

//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order was already accepted',

//       });

//     }


//     const shopResult =
//       await client.query(
//         `
//         SELECT

//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude,
//           status

//         FROM shops

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [order.shop_id]
//       );


//     const itemsResult =
//       await client.query(
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
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     await client.query(
//       'COMMIT'
//     );


//     const updatedOrder =
//       updateResult.rows[0];


//     const shop =
//       shopResult.rows[0] ||
//       null;


//     const items =
//       itemsResult.rows;


//     const responseOrder = {

//       id:
//         Number(
//           updatedOrder.id
//         ),

//       customerId:
//         Number(
//           updatedOrder.customer_id
//         ),

//       shopId:
//         Number(
//           updatedOrder.shop_id
//         ),

//       shopperId:
//         Number(
//           updatedOrder.shopper_id
//         ),


//       store:
//         shop?.shop_name ||
//         'Shop',

//       storeName:
//         shop?.shop_name ||
//         'Shop',

//       shop:
//         shop?.shop_name ||
//         'Shop',

//       shopImage:
//         shop?.image_url ||
//         null,


//       pickupLatitude:
//         Number(
//           shop?.latitude
//         ),

//       pickupLongitude:
//         Number(
//           shop?.longitude
//         ),


//       customer:
//         updatedOrder.delivery_address,

//       customerName:
//         `Customer #${updatedOrder.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       latitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       longitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       deliveryAddress:
//         updatedOrder.delivery_address,


//       deliveryOption:
//         updatedOrder.delivery_option,

//       paymentMethod:
//         updatedOrder.payment_method,


//       itemsTotal:
//         Number(
//           updatedOrder.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           updatedOrder.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           updatedOrder.total_amount || 0
//         ),

//       fee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),


//       status:
//         updatedOrder.status,


//       createdAt:
//         updatedOrder.created_at,

//       updatedAt:
//         updatedOrder.updated_at,


//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               Number(
//                 item.id
//               ),

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,


//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,

//             shoppingStatus:
//               item.shopping_status ||
//               'pending',

//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(
//                     item.found_quantity
//                   )
//                 : null,

//             foundWeight:
//               item.found_weight !== null
//                 ? Number(
//                     item.found_weight
//                   )
//                 : null,

//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,

//             barcodeScanned:
//               item.barcode_scanned === true,

//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         ),


//       orderItems:
//         items,

//     };


//     console.log(
//       '✅ ORDER ACCEPTED:',
//       responseOrder.id
//     );


//     return res.json({

//       success: true,

//       message:
//         'Order accepted successfully',

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     try {

//       await client.query(
//         'ROLLBACK'
//       );

//     } catch (_) {}


//     console.error(
//       '❌ ACCEPT SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });


//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // START SHOPPING
// // =====================================================

// const startShopping = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status,
//           updated_at

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     if (
//       order.status ===
//       'shopping'
//     ) {

//       return res.json({

//         success: true,

//         message:
//           'Shopping has already started',

//         order: {

//           id:
//             Number(
//               order.id
//             ),

//           customerId:
//             Number(
//               order.customer_id
//             ),

//           shopId:
//             Number(
//               order.shop_id
//             ),

//           shopperId:
//             Number(
//               order.shopper_id
//             ),

//           status:
//             'shopping',

//           updatedAt:
//             order.updated_at,

//         },

//       });

//     }


//     if (
//       order.status !==
//       'shopper_accepted'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order cannot start shopping from current status',

//         status:
//           order.status,

//       });

//     }


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           status =
//             'shopping',

//           updated_at =
//             NOW()

//         WHERE

//           id = $1

//           AND shopper_id = $2

//           AND status =
//             'shopper_accepted'

//         RETURNING *

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Unable to start shopping',

//       });

//     }


//     const updatedOrder =
//       updateResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🛒 SHOPPING STARTED'
//     );

//     console.log(
//       'Order ID:',
//       updatedOrder.id
//     );

//     console.log(
//       'Shopper ID:',
//       updatedOrder.shopper_id
//     );

//     console.log(
//       'Status:',
//       updatedOrder.status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Shopping started successfully',

//       order: {

//         id:
//           Number(
//             updatedOrder.id
//           ),

//         customerId:
//           Number(
//             updatedOrder.customer_id
//           ),

//         shopId:
//           Number(
//             updatedOrder.shop_id
//           ),

//         shopperId:
//           Number(
//             updatedOrder.shopper_id
//           ),

//         status:
//           updatedOrder.status,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ START SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start shopping',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ACTIVE ORDERS
// // =====================================================

// const getMyOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const result =
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

//           o.shopper_id,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC

//         `,
//         [shopperId]
//       );


//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC

//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),

//               shopperId:
//                 Number(
//                   order.shopper_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,


//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),


//               status:
//                 order.status,


//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,

//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',

//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,

//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,

//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,

//                     barcodeScanned:
//                       item.barcode_scanned === true,

//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET MY SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY ONLINE SHOPPERS FOR CUSTOMER ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           o.id,
//           o.shop_id,

//           s.shop_name,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE o.id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const shopLatitude =
//       Number(
//         order.shop_latitude
//       );


//     const shopLongitude =
//       Number(
//         order.shop_longitude
//       );


//     if (
//       !Number.isFinite(
//         shopLatitude
//       ) ||
//       !Number.isFinite(
//         shopLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop location is not available',

//       });

//     }


//     const shoppersResult =
//       await pool.query(
//         `
//         SELECT

//           id,

//           latitude,
//           longitude,

//           status

//         FROM shoppers

//         WHERE

//           status = 'online'

//           AND latitude IS NOT NULL

//           AND longitude IS NOT NULL

//           AND (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) <= 10

//         ORDER BY

//           (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) ASC

//         `,
//         [
//           shopLatitude,
//           shopLongitude,
//         ]
//       );


//     const shoppers =
//       shoppersResult.rows.map(
//         shopper => {

//           const latitude =
//             Number(
//               shopper.latitude
//             );


//           const longitude =
//             Number(
//               shopper.longitude
//             );


//           const distanceKm =
//             6371 *

//             Math.acos(

//               Math.min(

//                 1,

//                 Math.max(

//                   -1,

//                   Math.cos(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     (
//                       longitude -
//                       shopLongitude
//                     ) *
//                     Math.PI /
//                     180
//                   )

//                   +

//                   Math.sin(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.sin(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                 )

//               )

//             );


//           return {

//             id:
//               Number(
//                 shopper.id
//               ),

//             latitude,

//             longitude,

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 distanceKm.toFixed(2)
//               ),

//           };

//         }
//       );


//     return res.json({

//       success: true,

//       orderId,

//       shop: {

//         id:
//           Number(
//             order.shop_id
//           ),

//         name:
//           order.shop_name,

//         latitude:
//           shopLatitude,

//         longitude:
//           shopLongitude,

//       },

//       count:
//         shoppers.length,

//       shoppers,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET NEARBY SHOPPERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // =====================================================

// const uploadItemPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Item photo is required',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📸 ITEM PHOTO UPLOAD'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Item ID:',
//       itemId
//     );

//     console.log(
//       'File:',
//       req.file.filename
//     );


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const parsedQuantity =
//       foundQuantity !== undefined &&
//       foundQuantity !== null &&
//       foundQuantity !== ''
//         ? Number(foundQuantity)
//         : null;


//     const parsedWeight =
//       foundWeight !== undefined &&
//       foundWeight !== null &&
//       foundWeight !== ''
//         ? Number(foundWeight)
//         : null;


//     const parsedBarcode =
//       barcodeScanned === true ||
//       barcodeScanned === 'true';


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopper_photo_url =
//             $1,

//           shopping_status =
//             'done',

//           found_quantity =
//             $2,

//           found_weight =
//             $3,

//           found_weight_unit =
//             $4,

//           barcode_scanned =
//             $5,

//           completed_at =
//             NOW()

//         WHERE

//           id = $6

//           AND order_id = $7

//         RETURNING *

//         `,
//         [
//           photoUrl,
//           parsedQuantity,
//           parsedWeight,
//           foundWeightUnit ||
//             null,
//           parsedBarcode,
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save item photo',

//       });

//     }


//     const item =
//       updateResult.rows[0];


//     console.log(
//       '✅ ITEM PHOTO SAVED'
//     );

//     console.log(
//       'Photo URL:',
//       item.shopper_photo_url
//     );

//     console.log(
//       'Shopping status:',
//       item.shopping_status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Item photo uploaded successfully',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status ||
//           'done',

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ ITEM PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload item photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER REPLACEMENT PHOTO
// // =====================================================

// const uploadReplacementPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Replacement photo is required',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📸 REPLACEMENT PHOTO UPLOAD'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Original Item ID:',
//       itemId
//     );

//     console.log(
//       'File:',
//       req.file.filename
//     );


//     // =================================================
//     // CHECK ORDER
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           customer_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // CHECK SHOPPER
//     // =================================================

//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     // =================================================
//     // CHECK ORIGINAL ITEM
//     // =================================================

//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Original order item not found',

//       });

//     }


//     const originalItem =
//       itemResult.rows[0];


//     // =================================================
//     // GET NEXT OPTION NUMBER
//     // =================================================

//     const optionResult =
//       await pool.query(
//         `
//         SELECT

//           COALESCE(
//             MAX(option_number),
//             0
//           ) + 1 AS next_option

//         FROM replacement_items

//         WHERE

//           order_id = $1

//           AND original_item_id = $2

//         `,
//         [
//           orderId,
//           itemId,
//         ]
//       );


//     const optionNumber =
//       Number(
//         optionResult.rows[0]?.next_option ||
//         1
//       );


//     // =================================================
//     // PHOTO URL
//     // =================================================

//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/replacements/${req.file.filename}`;


//     // =================================================
//     // SAVE REPLACEMENT PHOTO
//     // =================================================

//     const insertResult =
//       await pool.query(
//         `
//         INSERT INTO replacement_items (

//           order_id,

//           original_item_id,

//           shopper_id,

//           option_number,

//           photo_url,

//           status,

//           created_at,

//           updated_at

//         )

//         VALUES (

//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           'waiting_customer',
//           NOW(),
//           NOW()

//         )

//         RETURNING *

//         `,
//         [
//           orderId,
//           itemId,
//           shopperId,
//           optionNumber,
//           photoUrl,
//         ]
//       );


//     if (
//       insertResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save replacement photo',

//       });

//     }


//     const replacement =
//       insertResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ REPLACEMENT PHOTO SAVED'
//     );

//     console.log(
//       'Replacement ID:',
//       replacement.id
//     );

//     console.log(
//       'Option Number:',
//       replacement.option_number
//     );

//     console.log(
//       'Photo URL:',
//       replacement.photo_url
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Replacement photo uploaded successfully',

//       replacement: {

//         id:
//           Number(
//             replacement.id
//           ),

//         orderId:
//           Number(
//             replacement.order_id
//           ),

//         originalItemId:
//           Number(
//             replacement.original_item_id
//           ),

//         originalItemName:
//           originalItem.item_name,

//         shopperId:
//           Number(
//             replacement.shopper_id
//           ),

//         optionNumber:
//           Number(
//             replacement.option_number
//           ),

//         photoUrl:
//           replacement.photo_url,

//         replacementPhotoUrl:
//           replacement.photo_url,

//         status:
//           replacement.status,

//         createdAt:
//           replacement.created_at,

//         updatedAt:
//           replacement.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ REPLACEMENT PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload replacement photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ITEM SHOPPING DATA
// // =====================================================

// const updateItemShoppingStatus = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     if (
//       Number(
//         orderResult.rows[0].shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopping_status =
//             'done',

//           found_quantity =
//             $1,

//           found_weight =
//             $2,

//           found_weight_unit =
//             $3,

//           barcode_scanned =
//             $4,

//           completed_at =
//             NOW()

//         WHERE

//           id = $5

//           AND order_id = $6

//         RETURNING *

//         `,
//         [

//           foundQuantity !== undefined &&
//           foundQuantity !== null &&
//           foundQuantity !== ''
//             ? Number(foundQuantity)
//             : null,

//           foundWeight !== undefined &&
//           foundWeight !== null &&
//           foundWeight !== ''
//             ? Number(foundWeight)
//             : null,

//           foundWeightUnit ||
//             null,

//           barcodeScanned === true ||
//           barcodeScanned === 'true',

//           itemId,
//           orderId,

//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const item =
//       result.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Item shopping data updated',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status,

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPDATE ITEM SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update item shopping data',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORT
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   startShopping,

//   getMyOrders,

//   getMyOrderById,

//   getNearbyShoppersForOrder,

//   uploadItemPhoto,

//   uploadReplacementPhoto,

//   updateItemShoppingStatus,

// };













// const pool = require('../config/db');


// // =====================================================
// // HELPER
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
// // GET AVAILABLE ORDERS FOR SHOPPER
// // =====================================================

// const getAvailableOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     // =================================================
//     // GET SHOPPER LOCATION
//     // =================================================

//     const shopperResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status
//         FROM shoppers
//         WHERE id = $1
//         LIMIT 1
//         `,
//         [shopperId]
//       );


//     if (
//       shopperResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Shopper not found',

//       });

//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);


//     const shopperLongitude =
//       Number(shopper.longitude);


//     if (
//       !Number.isFinite(
//         shopperLatitude
//       ) ||
//       !Number.isFinite(
//         shopperLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shopper location is not available',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 SHOPPER LOCATION'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Latitude:',
//       shopperLatitude
//     );

//     console.log(
//       'Longitude:',
//       shopperLongitude
//     );


//     // =================================================
//     // FIND AVAILABLE ORDERS
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         WITH available_orders AS (

//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,

//             o.delivery_address,

//             o.delivery_latitude,
//             o.delivery_longitude,

//             o.delivery_option,
//             o.payment_method,

//             o.items_total,
//             o.delivery_fee,
//             o.service_fee,
//             o.total_amount,

//             o.status,

//             o.created_at,
//             o.updated_at,

//             s.shop_name,
//             s.image_url AS shop_image,
//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,

//                     cos(
//                       radians($1)
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.longitude
//                       )
//                       -
//                       radians($2)
//                     )

//                     +

//                     sin(
//                       radians($1)
//                     )

//                     *

//                     sin(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                   )
//                 )
//               )
//             ) AS shop_distance_km

//           FROM orders o

//           INNER JOIN shops s
//             ON s.id = o.shop_id

//           WHERE

//             o.status =
//               'waiting_for_shopper'

//             AND

//             o.shopper_id IS NULL

//             AND

//             s.status =
//               'approved'

//             AND

//             s.latitude IS NOT NULL

//             AND

//             s.longitude IS NOT NULL

//         )

//         SELECT *

//         FROM available_orders

//         WHERE
//           shop_distance_km <= 10

//         ORDER BY

//           shop_distance_km ASC,

//           created_at ASC

//         `,
//         [
//           shopperLatitude,
//           shopperLongitude,
//         ]
//       );


//     console.log(
//       '📦 AVAILABLE REAL ORDERS:',
//       result.rows.length
//     );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC
//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             const distance =
//               Number(
//                 order.shop_distance_km
//               );


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               distance:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? `${distance.toFixed(1)} km`
//                   : '0.0 km',


//               distanceKm:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? Number(
//                       distance.toFixed(2)
//                     )
//                   : 0,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,

//               status:
//                 order.status,

//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,


//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',


//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,


//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,


//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,


//                     barcodeScanned:
//                       item.barcode_scanned === true,


//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     // =====================================================
//     // GROUP MULTI-SHOP ORDERS
//     // =====================================================

//     const orderGroups =
//       new Map();


//     orders.forEach(
//       (order) => {

//         const customerId =
//           Number(
//             order.customerId
//           );


//         const customerLatitude =
//           Number(
//             order.customerLatitude
//           );


//         const customerLongitude =
//           Number(
//             order.customerLongitude
//           );


//         const deliveryAddress =
//           String(
//             order.deliveryAddress ||
//             order.customer ||
//             ''
//           )
//             .trim()
//             .toLowerCase();


//         let locationKey =
//           'no-location';


//         if (
//           Number.isFinite(
//             customerLatitude
//           ) &&
//           Number.isFinite(
//             customerLongitude
//           )
//         ) {

//           locationKey =
//             `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//         }


//         const groupKey =
//           `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//         if (
//           !orderGroups.has(
//             groupKey
//           )
//         ) {

//           orderGroups.set(
//             groupKey,
//             {
//               orderGroupId:
//                 groupKey,

//               customerId,

//               customerLatitude,

//               customerLongitude,

//               deliveryAddress,

//               orders: [],

//             }
//           );

//         }


//         const group =
//           orderGroups.get(
//             groupKey
//           );


//         group.orders.push(
//           order
//         );

//       }
//     );


//     // =====================================================
//     // ADD GROUP INFORMATION
//     // =====================================================

//     const ordersWithGroups =
//       orders.map(
//         (order) => {

//           const customerId =
//             Number(
//               order.customerId
//             );


//           const customerLatitude =
//             Number(
//               order.customerLatitude
//             );


//           const customerLongitude =
//             Number(
//               order.customerLongitude
//             );


//           const deliveryAddress =
//             String(
//               order.deliveryAddress ||
//               order.customer ||
//               ''
//             )
//               .trim()
//               .toLowerCase();


//           let locationKey =
//             'no-location';


//           if (
//             Number.isFinite(
//               customerLatitude
//             ) &&
//             Number.isFinite(
//               customerLongitude
//             )
//           ) {

//             locationKey =
//               `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//           }


//           const groupKey =
//             `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//           const group =
//             orderGroups.get(
//               groupKey
//             );


//           const groupedOrders =
//             group?.orders ||
//             [order];


//           const uniqueShops =
//             [];


//           const seenShopIds =
//             new Set();


//           groupedOrders.forEach(
//             (groupOrder) => {

//               const shopId =
//                 Number(
//                   groupOrder.shopId
//                 );


//               if (
//                 !seenShopIds.has(
//                   shopId
//                 )
//               ) {

//                 seenShopIds.add(
//                   shopId
//                 );


//                 uniqueShops.push({

//                   id:
//                     shopId,

//                   name:
//                     groupOrder.storeName ||
//                     groupOrder.store ||
//                     groupOrder.shop ||
//                     'Shop',

//                   image:
//                     groupOrder.shopImage ||
//                     null,

//                   latitude:
//                     Number(
//                       groupOrder.pickupLatitude
//                     ),

//                   longitude:
//                     Number(
//                       groupOrder.pickupLongitude
//                     ),

//                   orderId:
//                     Number(
//                       groupOrder.id
//                     ),

//                 });

//               }

//             }
//           );


//           const shopNames =
//             uniqueShops.map(
//               shop =>
//                 shop.name
//             );


//           return {

//             ...order,

//             orderGroupId:
//               group?.orderGroupId ||
//               groupKey,

//             batchId:
//               group?.orderGroupId ||
//               groupKey,

//             customerOrderId:
//               group?.orderGroupId ||
//               groupKey,

//             shopCount:
//               uniqueShops.length,

//             shopNames,

//             shops:
//               uniqueShops,

//             batchOrders:
//               groupedOrders.map(
//                 groupOrder => ({
//                   ...groupOrder,
//                 })
//               ),

//           };

//         }
//       );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📦 MULTI-SHOP GROUPING'
//     );

//     console.log(
//       'Total individual orders:',
//       orders.length
//     );

//     console.log(
//       'Total order groups:',
//       orderGroups.size
//     );


//     ordersWithGroups.forEach(
//       (order) => {

//         console.log(
//           'Order:',
//           order.id
//         );

//         console.log(
//           'Group:',
//           order.orderGroupId
//         );

//         console.log(
//           'Shop count:',
//           order.shopCount
//         );

//         console.log(
//           'Shops:',
//           order.shopNames
//         );

//       }
//     );


//     console.log(
//       '========================================'
//     );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ ORDERS SENT TO SHOPPER:',
//       ordersWithGroups.length
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         ordersWithGroups.length,

//       orders:
//         ordersWithGroups,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET SINGLE SHOPPER ORDER
// // =====================================================

// const getMyOrderById = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     // =================================================
//     // GET ORDER
//     // =================================================

//     const orderResult =
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
//           o.shopper_id,

//           o.payment_id,
//           o.payment_status,
//           o.paid_at,

//           o.bill_url,
//           o.bill_uploaded_at,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE

//           o.id = $1

//           AND

//           o.shopper_id = $2

//         LIMIT 1

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found or does not belong to this shopper',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // GET ORDER ITEMS
//     // =================================================

//     const itemsResult =
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
//           completed_at

//         FROM order_items

//         WHERE

//           order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     const items =
//       itemsResult.rows;


//     // =================================================
//     // GET REPLACEMENT ITEMS
//     // =================================================

//     const replacementsResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           original_item_id,
//           shopper_id,
//           option_number,

//           photo_url,

//           status,

//           created_at,
//           updated_at

//         FROM replacement_items

//         WHERE

//           order_id = $1

//         ORDER BY

//           original_item_id ASC,
//           option_number ASC,
//           id ASC

//         `,
//         [orderId]
//       );


//     const replacementItems =
//       replacementsResult.rows.map(
//         replacement => ({

//           id:
//             Number(
//               replacement.id
//             ),

//           orderId:
//             Number(
//               replacement.order_id
//             ),

//           originalItemId:
//             Number(
//               replacement.original_item_id
//             ),

//           shopperId:
//             Number(
//               replacement.shopper_id
//             ),

//           optionNumber:
//             Number(
//               replacement.option_number
//             ),

//           photoUrl:
//             replacement.photo_url,

//           photo_url:
//             replacement.photo_url,

//           replacementPhotoUrl:
//             replacement.photo_url,

//           replacement_photo_url:
//             replacement.photo_url,

//           status:
//             replacement.status,

//           createdAt:
//             replacement.created_at,

//           updatedAt:
//             replacement.updated_at,

//         })
//       );


//     // =================================================
//     // BUILD RESPONSE
//     // =================================================

//     const responseOrder = {

//       id:
//         Number(
//           order.id
//         ),

//       customerId:
//         Number(
//           order.customer_id
//         ),

//       shopId:
//         Number(
//           order.shop_id
//         ),

//       shopperId:
//         Number(
//           order.shopper_id
//         ),


//       store:
//         order.shop_name,

//       storeName:
//         order.shop_name,

//       shop:
//         order.shop_name,


//       shopImage:
//         order.shop_image ||
//         null,


//       pickupLatitude:
//         Number(
//           order.shop_latitude
//         ),

//       pickupLongitude:
//         Number(
//           order.shop_longitude
//         ),


//       customer:
//         order.delivery_address,

//       customerName:
//         `Customer #${order.customer_id}`,


//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           order.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           order.delivery_longitude
//         ),


//       latitude:
//         Number(
//           order.delivery_latitude
//         ),

//       longitude:
//         Number(
//           order.delivery_longitude
//         ),


//       deliveryAddress:
//         order.delivery_address,


//       deliveryOption:
//         order.delivery_option,

//       paymentMethod:
//         order.payment_method,


//       itemsTotal:
//         Number(
//           order.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           order.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           order.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           order.total_amount || 0
//         ),

//       fee:
//         Number(
//           order.delivery_fee || 0
//         ),


//       status:
//         order.status,


//       // =================================================
//       // PAYMENT INFORMATION
//       // =================================================

//       paymentId:
//         order.payment_id ||
//         null,

//       paymentStatus:
//         order.payment_status ||
//         null,

//       paidAt:
//         order.paid_at ||
//         null,


//       // =================================================
//       // BILL INFORMATION
//       // =================================================

//       billUrl:
//         order.bill_url ||
//         null,

//       billImage:
//         order.bill_url ||
//         null,

//       billUploadedAt:
//         order.bill_uploaded_at ||
//         null,


//       createdAt:
//         order.created_at,

//       updatedAt:
//         order.updated_at,


//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               Number(
//                 item.id
//               ),

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,


//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,


//             shoppingStatus:
//               item.shopping_status ||
//               'pending',


//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(
//                     item.found_quantity
//                   )
//                 : null,


//             foundWeight:
//               item.found_weight !== null
//                 ? Number(
//                     item.found_weight
//                   )
//                 : null,


//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,


//             barcodeScanned:
//               item.barcode_scanned === true,


//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         ),


//       orderItems:
//         items,


//       // =================================================
//       // REPLACEMENT ITEMS
//       // =================================================

//       replacementItems,

//       replacements:
//         replacementItems,

//     };


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🔄 SHOPPER ORDER STATUS FETCH'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Order Status:',
//       order.status
//     );

//     console.log(
//       'Payment Status:',
//       order.payment_status
//     );

//     console.log(
//       'Bill URL:',
//       order.bill_url
//     );

//     console.log(
//       'Replacement Count:',
//       replacementItems.length
//     );


//     replacementItems.forEach(
//       replacement => {

//         console.log(
//           'Replacement:',
//           replacement.id,
//           'Original Item:',
//           replacement.originalItemId,
//           'Status:',
//           replacement.status
//         );

//       }
//     );


//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SINGLE SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper order',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (req, res) => {

//   const client =
//     await pool.connect();


//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     await client.query(
//       'BEGIN'
//     );


//     const orderResult =
//       await client.query(
//         `
//         SELECT

//           id,
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

//           status,
//           shopper_id,

//           created_at

//         FROM orders

//         WHERE id = $1

//         FOR UPDATE

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       order.status !==
//       'waiting_for_shopper'
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//         status:
//           order.status,

//       });

//     }


//     if (
//       order.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order has already been accepted',

//       });

//     }


//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET

//           shopper_id =
//             $1,

//           status =
//             'shopper_accepted',

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND status =
//             'waiting_for_shopper'

//           AND shopper_id IS NULL

//         RETURNING *

//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order was already accepted',

//       });

//     }


//     const shopResult =
//       await client.query(
//         `
//         SELECT

//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude,
//           status

//         FROM shops

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [order.shop_id]
//       );


//     const itemsResult =
//       await client.query(
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
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     await client.query(
//       'COMMIT'
//     );


//     const updatedOrder =
//       updateResult.rows[0];


//     const shop =
//       shopResult.rows[0] ||
//       null;


//     const items =
//       itemsResult.rows;


//     const responseOrder = {

//       id:
//         Number(
//           updatedOrder.id
//         ),

//       customerId:
//         Number(
//           updatedOrder.customer_id
//         ),

//       shopId:
//         Number(
//           updatedOrder.shop_id
//         ),

//       shopperId:
//         Number(
//           updatedOrder.shopper_id
//         ),


//       store:
//         shop?.shop_name ||
//         'Shop',

//       storeName:
//         shop?.shop_name ||
//         'Shop',

//       shop:
//         shop?.shop_name ||
//         'Shop',

//       shopImage:
//         shop?.image_url ||
//         null,


//       pickupLatitude:
//         Number(
//           shop?.latitude
//         ),

//       pickupLongitude:
//         Number(
//           shop?.longitude
//         ),


//       customer:
//         updatedOrder.delivery_address,

//       customerName:
//         `Customer #${updatedOrder.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       latitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       longitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       deliveryAddress:
//         updatedOrder.delivery_address,


//       deliveryOption:
//         updatedOrder.delivery_option,

//       paymentMethod:
//         updatedOrder.payment_method,


//       itemsTotal:
//         Number(
//           updatedOrder.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           updatedOrder.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           updatedOrder.total_amount || 0
//         ),

//       fee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),


//       status:
//         updatedOrder.status,


//       createdAt:
//         updatedOrder.created_at,

//       updatedAt:
//         updatedOrder.updated_at,


//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               Number(
//                 item.id
//               ),

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,


//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,

//             shoppingStatus:
//               item.shopping_status ||
//               'pending',

//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(
//                     item.found_quantity
//                   )
//                 : null,

//             foundWeight:
//               item.found_weight !== null
//                 ? Number(
//                     item.found_weight
//                   )
//                 : null,

//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,

//             barcodeScanned:
//               item.barcode_scanned === true,

//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         ),


//       orderItems:
//         items,

//     };


//     console.log(
//       '✅ ORDER ACCEPTED:',
//       responseOrder.id
//     );


//     return res.json({

//       success: true,

//       message:
//         'Order accepted successfully',

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     try {

//       await client.query(
//         'ROLLBACK'
//       );

//     } catch (_) {}


//     console.error(
//       '❌ ACCEPT SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });


//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // START SHOPPING
// // =====================================================

// const startShopping = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status,
//           updated_at

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     if (
//       order.status ===
//       'shopping'
//     ) {

//       return res.json({

//         success: true,

//         message:
//           'Shopping has already started',

//         order: {

//           id:
//             Number(
//               order.id
//             ),

//           customerId:
//             Number(
//               order.customer_id
//             ),

//           shopId:
//             Number(
//               order.shop_id
//             ),

//           shopperId:
//             Number(
//               order.shopper_id
//             ),

//           status:
//             'shopping',

//           updatedAt:
//             order.updated_at,

//         },

//       });

//     }


//     if (
//       order.status !==
//       'shopper_accepted'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order cannot start shopping from current status',

//         status:
//           order.status,

//       });

//     }


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           status =
//             'shopping',

//           updated_at =
//             NOW()

//         WHERE

//           id = $1

//           AND shopper_id = $2

//           AND status =
//             'shopper_accepted'

//         RETURNING *

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Unable to start shopping',

//       });

//     }


//     const updatedOrder =
//       updateResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🛒 SHOPPING STARTED'
//     );

//     console.log(
//       'Order ID:',
//       updatedOrder.id
//     );

//     console.log(
//       'Shopper ID:',
//       updatedOrder.shopper_id
//     );

//     console.log(
//       'Status:',
//       updatedOrder.status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Shopping started successfully',

//       order: {

//         id:
//           Number(
//             updatedOrder.id
//           ),

//         customerId:
//           Number(
//             updatedOrder.customer_id
//           ),

//         shopId:
//           Number(
//             updatedOrder.shop_id
//           ),

//         shopperId:
//           Number(
//             updatedOrder.shopper_id
//           ),

//         status:
//           updatedOrder.status,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ START SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start shopping',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ACTIVE ORDERS
// // =====================================================

// const getMyOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const result =
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

//           o.shopper_id,

//           o.payment_id,
//           o.payment_status,
//           o.paid_at,

//           o.bill_url,
//           o.bill_uploaded_at,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC

//         `,
//         [shopperId]
//       );


//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC

//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),

//               shopperId:
//                 Number(
//                   order.shopper_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,


//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),


//               status:
//                 order.status,


//               // =================================================
//               // PAYMENT INFORMATION
//               // =================================================

//               paymentId:
//                 order.payment_id ||
//                 null,

//               paymentStatus:
//                 order.payment_status ||
//                 null,

//               paidAt:
//                 order.paid_at ||
//                 null,


//               // =================================================
//               // BILL INFORMATION
//               // =================================================

//               billUrl:
//                 order.bill_url ||
//                 null,

//               billImage:
//                 order.bill_url ||
//                 null,

//               billUploadedAt:
//                 order.bill_uploaded_at ||
//                 null,


//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,

//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',

//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,

//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,

//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,

//                     barcodeScanned:
//                       item.barcode_scanned === true,

//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET MY SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY ONLINE SHOPPERS FOR CUSTOMER ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           o.id,
//           o.shop_id,

//           s.shop_name,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE o.id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const shopLatitude =
//       Number(
//         order.shop_latitude
//       );


//     const shopLongitude =
//       Number(
//         order.shop_longitude
//       );


//     if (
//       !Number.isFinite(
//         shopLatitude
//       ) ||
//       !Number.isFinite(
//         shopLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop location is not available',

//       });

//     }


//     const shoppersResult =
//       await pool.query(
//         `
//         SELECT

//           id,

//           latitude,
//           longitude,

//           status

//         FROM shoppers

//         WHERE

//           status = 'online'

//           AND latitude IS NOT NULL

//           AND longitude IS NOT NULL

//           AND (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) <= 10

//         ORDER BY

//           (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) ASC

//         `,
//         [
//           shopLatitude,
//           shopLongitude,
//         ]
//       );


//     const shoppers =
//       shoppersResult.rows.map(
//         shopper => {

//           const latitude =
//             Number(
//               shopper.latitude
//             );


//           const longitude =
//             Number(
//               shopper.longitude
//             );


//           const distanceKm =
//             6371 *

//             Math.acos(

//               Math.min(

//                 1,

//                 Math.max(

//                   -1,

//                   Math.cos(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     (
//                       longitude -
//                       shopLongitude
//                     ) *
//                     Math.PI /
//                     180
//                   )

//                   +

//                   Math.sin(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.sin(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                 )

//               )

//             );


//           return {

//             id:
//               Number(
//                 shopper.id
//               ),

//             latitude,

//             longitude,

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 distanceKm.toFixed(2)
//               ),

//           };

//         }
//       );


//     return res.json({

//       success: true,

//       orderId,

//       shop: {

//         id:
//           Number(
//             order.shop_id
//           ),

//         name:
//           order.shop_name,

//         latitude:
//           shopLatitude,

//         longitude:
//           shopLongitude,

//       },

//       count:
//         shoppers.length,

//       shoppers,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET NEARBY SHOPPERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // =====================================================

// const uploadItemPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Item photo is required',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📸 ITEM PHOTO UPLOAD'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Item ID:',
//       itemId
//     );

//     console.log(
//       'File:',
//       req.file.filename
//     );


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const parsedQuantity =
//       foundQuantity !== undefined &&
//       foundQuantity !== null &&
//       foundQuantity !== ''
//         ? Number(foundQuantity)
//         : null;


//     const parsedWeight =
//       foundWeight !== undefined &&
//       foundWeight !== null &&
//       foundWeight !== ''
//         ? Number(foundWeight)
//         : null;


//     const parsedBarcode =
//       barcodeScanned === true ||
//       barcodeScanned === 'true';


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopper_photo_url =
//             $1,

//           shopping_status =
//             'done',

//           found_quantity =
//             $2,

//           found_weight =
//             $3,

//           found_weight_unit =
//             $4,

//           barcode_scanned =
//             $5,

//           completed_at =
//             NOW()

//         WHERE

//           id = $6

//           AND order_id = $7

//         RETURNING *

//         `,
//         [
//           photoUrl,
//           parsedQuantity,
//           parsedWeight,
//           foundWeightUnit ||
//             null,
//           parsedBarcode,
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save item photo',

//       });

//     }


//     const item =
//       updateResult.rows[0];


//     console.log(
//       '✅ ITEM PHOTO SAVED'
//     );

//     console.log(
//       'Photo URL:',
//       item.shopper_photo_url
//     );

//     console.log(
//       'Shopping status:',
//       item.shopping_status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Item photo uploaded successfully',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status ||
//           'done',

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ ITEM PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload item photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER REPLACEMENT PHOTO
// // =====================================================

// const uploadReplacementPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Replacement photo is required',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📸 REPLACEMENT PHOTO UPLOAD'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Original Item ID:',
//       itemId
//     );

//     console.log(
//       'File:',
//       req.file.filename
//     );


//     // =================================================
//     // CHECK ORDER
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           customer_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // CHECK SHOPPER
//     // =================================================

//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     // =================================================
//     // CHECK ORIGINAL ITEM
//     // =================================================

//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Original order item not found',

//       });

//     }


//     const originalItem =
//       itemResult.rows[0];


//     // =================================================
//     // GET NEXT OPTION NUMBER
//     // =================================================

//     const optionResult =
//       await pool.query(
//         `
//         SELECT

//           COALESCE(
//             MAX(option_number),
//             0
//           ) + 1 AS next_option

//         FROM replacement_items

//         WHERE

//           order_id = $1

//           AND original_item_id = $2

//         `,
//         [
//           orderId,
//           itemId,
//         ]
//       );


//     const optionNumber =
//       Number(
//         optionResult.rows[0]?.next_option ||
//         1
//       );


//     // =================================================
//     // PHOTO URL
//     // =================================================

//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/replacements/${req.file.filename}`;


//     // =================================================
//     // SAVE REPLACEMENT PHOTO
//     // =================================================

//     const insertResult =
//       await pool.query(
//         `
//         INSERT INTO replacement_items (

//           order_id,

//           original_item_id,

//           shopper_id,

//           option_number,

//           photo_url,

//           status,

//           created_at,

//           updated_at

//         )

//         VALUES (

//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           'waiting_customer',
//           NOW(),
//           NOW()

//         )

//         RETURNING *

//         `,
//         [
//           orderId,
//           itemId,
//           shopperId,
//           optionNumber,
//           photoUrl,
//         ]
//       );


//     if (
//       insertResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save replacement photo',

//       });

//     }


//     const replacement =
//       insertResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ REPLACEMENT PHOTO SAVED'
//     );

//     console.log(
//       'Replacement ID:',
//       replacement.id
//     );

//     console.log(
//       'Option Number:',
//       replacement.option_number
//     );

//     console.log(
//       'Photo URL:',
//       replacement.photo_url
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Replacement photo uploaded successfully',

//       replacement: {

//         id:
//           Number(
//             replacement.id
//           ),

//         orderId:
//           Number(
//             replacement.order_id
//           ),

//         originalItemId:
//           Number(
//             replacement.original_item_id
//           ),

//         originalItemName:
//           originalItem.item_name,

//         shopperId:
//           Number(
//             replacement.shopper_id
//           ),

//         optionNumber:
//           Number(
//             replacement.option_number
//           ),

//         photoUrl:
//           replacement.photo_url,

//         replacementPhotoUrl:
//           replacement.photo_url,

//         status:
//           replacement.status,

//         createdAt:
//           replacement.created_at,

//         updatedAt:
//           replacement.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ REPLACEMENT PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload replacement photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ITEM SHOPPING DATA
// // =====================================================

// const updateItemShoppingStatus = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     if (
//       Number(
//         orderResult.rows[0].shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopping_status =
//             'done',

//           found_quantity =
//             $1,

//           found_weight =
//             $2,

//           found_weight_unit =
//             $3,

//           barcode_scanned =
//             $4,

//           completed_at =
//             NOW()

//         WHERE

//           id = $5

//           AND order_id = $6

//         RETURNING *

//         `,
//         [

//           foundQuantity !== undefined &&
//           foundQuantity !== null &&
//           foundQuantity !== ''
//             ? Number(foundQuantity)
//             : null,

//           foundWeight !== undefined &&
//           foundWeight !== null &&
//           foundWeight !== ''
//             ? Number(foundWeight)
//             : null,

//           foundWeightUnit ||
//             null,

//           barcodeScanned === true ||
//           barcodeScanned === 'true',

//           itemId,
//           orderId,

//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const item =
//       result.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Item shopping data updated',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status,

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPDATE ITEM SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update item shopping data',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ORDER PAYMENT
// // =====================================================

// const updateOrderPayment = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const {
//       paymentId,
//       paymentStatus,
//       paidAt,
//     } = req.body;


//     if (!paymentId) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Payment ID is required',

//       });

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           payment_id =
//             $1,

//           payment_status =
//             $2,

//           paid_at =
//             $3,

//           updated_at =
//             NOW()

//         WHERE

//           id = $4

//           AND shopper_id = $5

//         RETURNING

//           id,
//           payment_id,
//           payment_status,
//           paid_at

//         `,
//         [

//           String(
//             paymentId
//           ),

//           paymentStatus ||
//             'paid',

//           paidAt ||
//             new Date(),

//           orderId,

//           shopperId,

//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found or does not belong to this shopper',

//       });

//     }


//     const payment =
//       result.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '💳 PAYMENT UPDATED'
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'Payment ID:',
//       payment.payment_id
//     );

//     console.log(
//       'Payment Status:',
//       payment.payment_status
//     );

//     console.log(
//       'Paid At:',
//       payment.paid_at
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Payment information saved successfully',

//       payment: {

//         orderId:
//           Number(
//             payment.id
//           ),

//         paymentId:
//           payment.payment_id,

//         paymentStatus:
//           payment.payment_status,

//         paidAt:
//           payment.paid_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPDATE ORDER PAYMENT ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update order payment',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SUPERMARKET BILL
// // =====================================================

// const uploadBill = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Bill image is required',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🧾 SUPERMARKET BILL UPLOAD'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Order ID:',
//       orderId
//     );

//     console.log(
//       'File:',
//       req.file.filename
//     );


//     // =================================================
//     // CHECK ORDER OWNERSHIP
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           payment_id,
//           payment_status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     // =================================================
//     // BUILD BILL URL
//     // =================================================

//     const billUrl =
//       `${req.protocol}://${req.get('host')}/uploads/bills/${req.file.filename}`;


//     // =================================================
//     // SAVE BILL
//     // =================================================

//     const updateResult =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           bill_url =
//             $1,

//           bill_uploaded_at =
//             NOW(),

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND shopper_id = $3

//         RETURNING

//           id,
//           payment_id,
//           payment_status,
//           paid_at,
//           bill_url,
//           bill_uploaded_at

//         `,
//         [
//           billUrl,
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save bill information',

//       });

//     }


//     const savedBill =
//       updateResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ SUPERMARKET BILL SAVED'
//     );

//     console.log(
//       'Order ID:',
//       savedBill.id
//     );

//     console.log(
//       'Bill URL:',
//       savedBill.bill_url
//     );

//     console.log(
//       'Bill Uploaded At:',
//       savedBill.bill_uploaded_at
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Bill uploaded successfully',

//       bill: {

//         orderId:
//           Number(
//             savedBill.id
//           ),

//         billUrl:
//           savedBill.bill_url,

//         billImage:
//           savedBill.bill_url,

//         uploadedAt:
//           savedBill.bill_uploaded_at,

//         paymentId:
//           savedBill.payment_id ||
//           null,

//         paymentStatus:
//           savedBill.payment_status ||
//           null,

//         paidAt:
//           savedBill.paid_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPLOAD BILL ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload bill',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORT
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   startShopping,

//   getMyOrders,

//   getMyOrderById,

//   getNearbyShoppersForOrder,

//   uploadItemPhoto,

//   uploadReplacementPhoto,

//   updateItemShoppingStatus,

//   updateOrderPayment,

//   uploadBill,

// };





































// const pool = require('../config/db');


// // =====================================================
// // HELPER
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
// // GET AVAILABLE ORDERS FOR SHOPPER
// // =====================================================

// const getAvailableOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     // =================================================
//     // GET SHOPPER LOCATION
//     // =================================================

//     const shopperResult =
//       await pool.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status
//         FROM shoppers
//         WHERE id = $1
//         LIMIT 1
//         `,
//         [shopperId]
//       );


//     if (
//       shopperResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Shopper not found',

//       });

//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);


//     const shopperLongitude =
//       Number(shopper.longitude);


//     if (
//       !Number.isFinite(
//         shopperLatitude
//       ) ||
//       !Number.isFinite(
//         shopperLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shopper location is not available',

//       });

//     }


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 SHOPPER LOCATION'
//     );

//     console.log(
//       'Shopper ID:',
//       shopperId
//     );

//     console.log(
//       'Latitude:',
//       shopperLatitude
//     );

//     console.log(
//       'Longitude:',
//       shopperLongitude
//     );


//     // =================================================
//     // FIND AVAILABLE ORDERS
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         WITH available_orders AS (

//           SELECT

//             o.id,
//             o.customer_id,
//             o.shop_id,

//             o.delivery_address,

//             o.delivery_latitude,
//             o.delivery_longitude,

//             o.delivery_option,
//             o.payment_method,

//             o.items_total,
//             o.delivery_fee,
//             o.service_fee,
//             o.total_amount,

//             o.status,

//             o.created_at,
//             o.updated_at,

//             s.shop_name,
//             s.image_url AS shop_image,
//             s.latitude AS shop_latitude,
//             s.longitude AS shop_longitude,

//             (
//               6371 *
//               acos(
//                 LEAST(
//                   1,
//                   GREATEST(
//                     -1,

//                     cos(
//                       radians($1)
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                     *

//                     cos(
//                       radians(
//                         s.longitude
//                       )
//                       -
//                       radians($2)
//                     )

//                     +

//                     sin(
//                       radians($1)
//                     )

//                     *

//                     sin(
//                       radians(
//                         s.latitude
//                       )
//                     )

//                   )
//                 )
//               )
//             ) AS shop_distance_km

//           FROM orders o

//           INNER JOIN shops s
//             ON s.id = o.shop_id

//           WHERE

//             o.status =
//               'waiting_for_shopper'

//             AND

//             o.shopper_id IS NULL

//             AND

//             s.status =
//               'approved'

//             AND

//             s.latitude IS NOT NULL

//             AND

//             s.longitude IS NOT NULL

//         )

//         SELECT *

//         FROM available_orders

//         WHERE
//           shop_distance_km <= 10

//         ORDER BY

//           shop_distance_km ASC,

//           created_at ASC

//         `,
//         [
//           shopperLatitude,
//           shopperLongitude,
//         ]
//       );


//     console.log(
//       '📦 AVAILABLE REAL ORDERS:',
//       result.rows.length
//     );


//     // =================================================
//     // GET ITEMS
//     // =================================================

//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC
//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             const distance =
//               Number(
//                 order.shop_distance_km
//               );


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),


//               distance:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? `${distance.toFixed(1)} km`
//                   : '0.0 km',


//               distanceKm:
//                 Number.isFinite(
//                   distance
//                 )
//                   ? Number(
//                       distance.toFixed(2)
//                     )
//                   : 0,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,

//               status:
//                 order.status,

//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,


//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',


//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,


//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,


//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,


//                     barcodeScanned:
//                       item.barcode_scanned === true,


//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     // =====================================================
//     // GROUP MULTI-SHOP ORDERS
//     // =====================================================

//     const orderGroups =
//       new Map();


//     orders.forEach(
//       (order) => {

//         const customerId =
//           Number(
//             order.customerId
//           );


//         const customerLatitude =
//           Number(
//             order.customerLatitude
//           );


//         const customerLongitude =
//           Number(
//             order.customerLongitude
//           );


//         const deliveryAddress =
//           String(
//             order.deliveryAddress ||
//             order.customer ||
//             ''
//           )
//             .trim()
//             .toLowerCase();


//         let locationKey =
//           'no-location';


//         if (
//           Number.isFinite(
//             customerLatitude
//           ) &&
//           Number.isFinite(
//             customerLongitude
//           )
//         ) {

//           locationKey =
//             `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//         }


//         const groupKey =
//           `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//         if (
//           !orderGroups.has(
//             groupKey
//           )
//         ) {

//           orderGroups.set(
//             groupKey,
//             {
//               orderGroupId:
//                 groupKey,

//               customerId,

//               customerLatitude,

//               customerLongitude,

//               deliveryAddress,

//               orders: [],

//             }
//           );

//         }


//         const group =
//           orderGroups.get(
//             groupKey
//           );


//         group.orders.push(
//           order
//         );

//       }
//     );


//     // =====================================================
//     // ADD GROUP INFORMATION
//     // =====================================================

//     const ordersWithGroups =
//       orders.map(
//         (order) => {

//           const customerId =
//             Number(
//               order.customerId
//             );


//           const customerLatitude =
//             Number(
//               order.customerLatitude
//             );


//           const customerLongitude =
//             Number(
//               order.customerLongitude
//             );


//           const deliveryAddress =
//             String(
//               order.deliveryAddress ||
//               order.customer ||
//               ''
//             )
//               .trim()
//               .toLowerCase();


//           let locationKey =
//             'no-location';


//           if (
//             Number.isFinite(
//               customerLatitude
//             ) &&
//             Number.isFinite(
//               customerLongitude
//             )
//           ) {

//             locationKey =
//               `${customerLatitude.toFixed(5)}-${customerLongitude.toFixed(5)}`;

//           }


//           const groupKey =
//             `customer-${customerId}-${locationKey}-${deliveryAddress}`;


//           const group =
//             orderGroups.get(
//               groupKey
//             );


//           const groupedOrders =
//             group?.orders ||
//             [order];


//           const uniqueShops =
//             [];


//           const seenShopIds =
//             new Set();


//           groupedOrders.forEach(
//             (groupOrder) => {

//               const shopId =
//                 Number(
//                   groupOrder.shopId
//                 );


//               if (
//                 !seenShopIds.has(
//                   shopId
//                 )
//               ) {

//                 seenShopIds.add(
//                   shopId
//                 );


//                 uniqueShops.push({

//                   id:
//                     shopId,

//                   name:
//                     groupOrder.storeName ||
//                     groupOrder.store ||
//                     groupOrder.shop ||
//                     'Shop',

//                   image:
//                     groupOrder.shopImage ||
//                     null,

//                   latitude:
//                     Number(
//                       groupOrder.pickupLatitude
//                     ),

//                   longitude:
//                     Number(
//                       groupOrder.pickupLongitude
//                     ),

//                   orderId:
//                     Number(
//                       groupOrder.id
//                     ),

//                 });

//               }

//             }
//           );


//           const shopNames =
//             uniqueShops.map(
//               shop =>
//                 shop.name
//             );


//           return {

//             ...order,

//             orderGroupId:
//               group?.orderGroupId ||
//               groupKey,

//             batchId:
//               group?.orderGroupId ||
//               groupKey,

//             customerOrderId:
//               group?.orderGroupId ||
//               groupKey,

//             shopCount:
//               uniqueShops.length,

//             shopNames,

//             shops:
//               uniqueShops,

//             batchOrders:
//               groupedOrders.map(
//                 groupOrder => ({
//                   ...groupOrder,
//                 })
//               ),

//           };

//         }
//       );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📦 MULTI-SHOP GROUPING'
//     );

//     console.log(
//       'Total individual orders:',
//       orders.length
//     );

//     console.log(
//       'Total order groups:',
//       orderGroups.size
//     );


//     ordersWithGroups.forEach(
//       (order) => {

//         console.log(
//           'Order:',
//           order.id
//         );

//         console.log(
//           'Group:',
//           order.orderGroupId
//         );

//         console.log(
//           'Shop count:',
//           order.shopCount
//         );

//         console.log(
//           'Shops:',
//           order.shopNames
//         );

//       }
//     );


//     console.log(
//       '========================================'
//     );


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ ORDERS SENT TO SHOPPER:',
//       ordersWithGroups.length
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         ordersWithGroups.length,

//       orders:
//         ordersWithGroups,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET SINGLE SHOPPER ORDER
// // =====================================================

// const getMyOrderById = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
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
//           o.shopper_id,

//           o.payment_id,
//           o.payment_status,
//           o.paid_at,

//           o.bill_url,
//           o.bill_uploaded_at,

//           o.delivery_pin,
//           o.arrival_confirmed_at,
//           o.delivered_at,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE

//           o.id = $1

//           AND

//           o.shopper_id = $2

//         LIMIT 1

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found or does not belong to this shopper',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const itemsResult =
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
//           completed_at

//         FROM order_items

//         WHERE

//           order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     const items =
//       itemsResult.rows;


//     const replacementsResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           original_item_id,
//           shopper_id,
//           option_number,

//           photo_url,

//           status,

//           created_at,
//           updated_at

//         FROM replacement_items

//         WHERE

//           order_id = $1

//         ORDER BY

//           original_item_id ASC,
//           option_number ASC,
//           id ASC

//         `,
//         [orderId]
//       );


//     const replacementItems =
//       replacementsResult.rows.map(
//         replacement => ({

//           id:
//             Number(
//               replacement.id
//             ),

//           orderId:
//             Number(
//               replacement.order_id
//             ),

//           originalItemId:
//             Number(
//               replacement.original_item_id
//             ),

//           shopperId:
//             Number(
//               replacement.shopper_id
//             ),

//           optionNumber:
//             Number(
//               replacement.option_number
//             ),

//           photoUrl:
//             replacement.photo_url,

//           photo_url:
//             replacement.photo_url,

//           replacementPhotoUrl:
//             replacement.photo_url,

//           replacement_photo_url:
//             replacement.photo_url,

//           status:
//             replacement.status,

//           createdAt:
//             replacement.created_at,

//           updatedAt:
//             replacement.updated_at,

//         })
//       );


//     const responseOrder = {

//       id:
//         Number(
//           order.id
//         ),

//       customerId:
//         Number(
//           order.customer_id
//         ),

//       shopId:
//         Number(
//           order.shop_id
//         ),

//       shopperId:
//         Number(
//           order.shopper_id
//         ),


//       store:
//         order.shop_name,

//       storeName:
//         order.shop_name,

//       shop:
//         order.shop_name,


//       shopImage:
//         order.shop_image ||
//         null,


//       pickupLatitude:
//         Number(
//           order.shop_latitude
//         ),

//       pickupLongitude:
//         Number(
//           order.shop_longitude
//         ),


//       customer:
//         order.delivery_address,

//       customerName:
//         `Customer #${order.customer_id}`,


//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           order.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           order.delivery_longitude
//         ),


//       latitude:
//         Number(
//           order.delivery_latitude
//         ),

//       longitude:
//         Number(
//           order.delivery_longitude
//         ),


//       deliveryAddress:
//         order.delivery_address,


//       deliveryOption:
//         order.delivery_option,

//       paymentMethod:
//         order.payment_method,


//       itemsTotal:
//         Number(
//           order.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           order.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           order.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           order.total_amount || 0
//         ),

//       fee:
//         Number(
//           order.delivery_fee || 0
//         ),


//       status:
//         order.status,


//       paymentId:
//         order.payment_id ||
//         null,

//       paymentStatus:
//         order.payment_status ||
//         null,

//       paidAt:
//         order.paid_at ||
//         null,


//       billUrl:
//         order.bill_url ||
//         null,

//       billImage:
//         order.bill_url ||
//         null,

//       billUploadedAt:
//         order.bill_uploaded_at ||
//         null,


//       // =================================================
//       // DELIVERY INFORMATION
//       // =================================================

//       deliveryPin:
//         order.delivery_pin ||
//         null,

//       arrivalConfirmedAt:
//         order.arrival_confirmed_at ||
//         null,

//       deliveredAt:
//         order.delivered_at ||
//         null,


//       createdAt:
//         order.created_at,

//       updatedAt:
//         order.updated_at,


//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               Number(
//                 item.id
//               ),

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,


//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,


//             shoppingStatus:
//               item.shopping_status ||
//               'pending',


//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(
//                     item.found_quantity
//                   )
//                 : null,


//             foundWeight:
//               item.found_weight !== null
//                 ? Number(
//                     item.found_weight
//                   )
//                 : null,


//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,


//             barcodeScanned:
//               item.barcode_scanned === true,


//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         ),


//       orderItems:
//         items,


//       replacementItems,

//       replacements:
//         replacementItems,

//     };


//     return res.json({

//       success: true,

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET SINGLE SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper order',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (req, res) => {

//   const client =
//     await pool.connect();


//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     await client.query(
//       'BEGIN'
//     );


//     const orderResult =
//       await client.query(
//         `
//         SELECT

//           id,
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

//           status,
//           shopper_id,

//           created_at

//         FROM orders

//         WHERE id = $1

//         FOR UPDATE

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       order.status !==
//       'waiting_for_shopper'
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//         status:
//           order.status,

//       });

//     }


//     if (
//       order.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order has already been accepted',

//       });

//     }


//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET

//           shopper_id =
//             $1,

//           status =
//             'shopper_accepted',

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND status =
//             'waiting_for_shopper'

//           AND shopper_id IS NULL

//         RETURNING *

//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );


//       return res.status(409).json({

//         success: false,

//         message:
//           'This order was already accepted',

//       });

//     }


//     const shopResult =
//       await client.query(
//         `
//         SELECT

//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude,
//           status

//         FROM shops

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [order.shop_id]
//       );


//     const itemsResult =
//       await client.query(
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
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC

//         `,
//         [orderId]
//       );


//     await client.query(
//       'COMMIT'
//     );


//     const updatedOrder =
//       updateResult.rows[0];


//     const shop =
//       shopResult.rows[0] ||
//       null;


//     const items =
//       itemsResult.rows;


//     const responseOrder = {

//       id:
//         Number(
//           updatedOrder.id
//         ),

//       customerId:
//         Number(
//           updatedOrder.customer_id
//         ),

//       shopId:
//         Number(
//           updatedOrder.shop_id
//         ),

//       shopperId:
//         Number(
//           updatedOrder.shopper_id
//         ),


//       store:
//         shop?.shop_name ||
//         'Shop',

//       storeName:
//         shop?.shop_name ||
//         'Shop',

//       shop:
//         shop?.shop_name ||
//         'Shop',

//       shopImage:
//         shop?.image_url ||
//         null,


//       pickupLatitude:
//         Number(
//           shop?.latitude
//         ),

//       pickupLongitude:
//         Number(
//           shop?.longitude
//         ),


//       customer:
//         updatedOrder.delivery_address,

//       customerName:
//         `Customer #${updatedOrder.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       customerLongitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       latitude:
//         Number(
//           updatedOrder.delivery_latitude
//         ),

//       longitude:
//         Number(
//           updatedOrder.delivery_longitude
//         ),


//       deliveryAddress:
//         updatedOrder.delivery_address,


//       deliveryOption:
//         updatedOrder.delivery_option,

//       paymentMethod:
//         updatedOrder.payment_method,


//       itemsTotal:
//         Number(
//           updatedOrder.items_total || 0
//         ),

//       deliveryFee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),

//       serviceFee:
//         Number(
//           updatedOrder.service_fee || 0
//         ),

//       totalAmount:
//         Number(
//           updatedOrder.total_amount || 0
//         ),

//       fee:
//         Number(
//           updatedOrder.delivery_fee || 0
//         ),


//       status:
//         updatedOrder.status,


//       createdAt:
//         updatedOrder.created_at,

//       updatedAt:
//         updatedOrder.updated_at,


//       items:
//         items.length,


//       shoppingList:
//         items.map(
//           item => ({

//             id:
//               Number(
//                 item.id
//               ),

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               Number(
//                 item.quantity || 1
//               ),

//             amount:
//               Number(
//                 item.amount || 0
//               ),

//             unit:
//               item.unit,

//             price:
//               Number(
//                 item.price || 0
//               ),

//             custom:
//               item.custom === true,

//             details:
//               item.details,

//             image:
//               item.image,


//             shopperPhotoUrl:
//               item.shopper_photo_url ||
//               null,

//             shoppingStatus:
//               item.shopping_status ||
//               'pending',

//             foundQuantity:
//               item.found_quantity !== null
//                 ? Number(
//                     item.found_quantity
//                   )
//                 : null,

//             foundWeight:
//               item.found_weight !== null
//                 ? Number(
//                     item.found_weight
//                   )
//                 : null,

//             foundWeightUnit:
//               item.found_weight_unit ||
//               null,

//             barcodeScanned:
//               item.barcode_scanned === true,

//             completedAt:
//               item.completed_at ||
//               null,

//           })
//         ),


//       orderItems:
//         items,

//     };


//     console.log(
//       '✅ ORDER ACCEPTED:',
//       responseOrder.id
//     );


//     return res.json({

//       success: true,

//       message:
//         'Order accepted successfully',

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     try {

//       await client.query(
//         'ROLLBACK'
//       );

//     } catch (_) {}


//     console.error(
//       '❌ ACCEPT SHOPPER ORDER ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });


//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // START SHOPPING
// // =====================================================

// const startShopping = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status,
//           updated_at

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     if (
//       order.status ===
//       'shopping'
//     ) {

//       return res.json({

//         success: true,

//         message:
//           'Shopping has already started',

//         order: {

//           id:
//             Number(
//               order.id
//             ),

//           customerId:
//             Number(
//               order.customer_id
//             ),

//           shopId:
//             Number(
//               order.shop_id
//             ),

//           shopperId:
//             Number(
//               order.shopper_id
//             ),

//           status:
//             'shopping',

//           updatedAt:
//             order.updated_at,

//         },

//       });

//     }


//     if (
//       order.status !==
//       'shopper_accepted'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order cannot start shopping from current status',

//         status:
//           order.status,

//       });

//     }


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           status =
//             'shopping',

//           updated_at =
//             NOW()

//         WHERE

//           id = $1

//           AND shopper_id = $2

//           AND status =
//             'shopper_accepted'

//         RETURNING *

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Unable to start shopping',

//       });

//     }


//     const updatedOrder =
//       updateResult.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🛒 SHOPPING STARTED'
//     );

//     console.log(
//       'Order ID:',
//       updatedOrder.id
//     );

//     console.log(
//       'Shopper ID:',
//       updatedOrder.shopper_id
//     );

//     console.log(
//       'Status:',
//       updatedOrder.status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Shopping started successfully',

//       order: {

//         id:
//           Number(
//             updatedOrder.id
//           ),

//         customerId:
//           Number(
//             updatedOrder.customer_id
//           ),

//         shopId:
//           Number(
//             updatedOrder.shop_id
//           ),

//         shopperId:
//           Number(
//             updatedOrder.shopper_id
//           ),

//         status:
//           updatedOrder.status,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ START SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start shopping',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // START DELIVERY
// // =====================================================

// const startDelivery = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     // =================================================
//     // CHECK ORDER
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           status,
//           payment_status,
//           bill_url

//         FROM orders

//         WHERE

//           id = $1

//           AND shopper_id = $2

//         LIMIT 1

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found or does not belong to this shopper',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // PREVENT STARTING DELIVERY TOO EARLY
//     // =================================================

//     if (
//       order.status ===
//       'out_for_delivery'
//     ) {

//       return res.json({

//         success: true,

//         message:
//           'Delivery has already started',

//         order: {

//           id:
//             Number(
//               order.id
//             ),

//           shopperId:
//             Number(
//               order.shopper_id
//             ),

//           status:
//             order.status,

//         },

//       });

//     }


//     if (
//       order.status !==
//       'shopping'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order cannot start delivery from current status',

//         status:
//           order.status,

//       });

//     }


//     // =================================================
//     // REQUIRE BILL BEFORE DELIVERY
//     // =================================================

//     if (!order.bill_url) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Supermarket bill must be uploaded before starting delivery',

//       });

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           status =
//             'out_for_delivery',

//           updated_at =
//             NOW()

//         WHERE

//           id = $1

//           AND shopper_id = $2

//           AND status = 'shopping'

//         RETURNING

//           id,
//           shopper_id,
//           status,
//           updated_at

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Unable to start delivery',

//       });

//     }


//     const updatedOrder =
//       result.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '🚚 DELIVERY STARTED'
//     );

//     console.log(
//       'Order ID:',
//       updatedOrder.id
//     );

//     console.log(
//       'Shopper ID:',
//       updatedOrder.shopper_id
//     );

//     console.log(
//       'Status:',
//       updatedOrder.status
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Delivery started successfully',

//       order: {

//         id:
//           Number(
//             updatedOrder.id
//           ),

//         shopperId:
//           Number(
//             updatedOrder.shopper_id
//           ),

//         status:
//           updatedOrder.status,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ START DELIVERY ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start delivery',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // CONFIRM ARRIVAL
// // =====================================================

// const confirmArrival = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     // =================================================
//     // CHECK ORDER
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           customer_id,
//           shopper_id,
//           status,
//           delivery_pin,
//           arrival_confirmed_at

//         FROM orders

//         WHERE

//           id = $1

//           AND shopper_id = $2

//         LIMIT 1

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found or does not belong to this shopper',

//       });

//     }


//     const existingOrder =
//       orderResult.rows[0];


//     // =================================================
//     // ALREADY ARRIVED
//     // =================================================

//     if (
//       existingOrder.status ===
//         'arrived' &&
//       existingOrder.delivery_pin
//     ) {

//       return res.json({

//         success: true,

//         message:
//           'Arrival has already been confirmed',

//         order: {

//           id:
//             Number(
//               existingOrder.id
//             ),

//           customerId:
//             Number(
//               existingOrder.customer_id
//             ),

//           shopperId:
//             Number(
//               existingOrder.shopper_id
//             ),

//           status:
//             existingOrder.status,

//           deliveryPin:
//             existingOrder.delivery_pin,

//           arrivalConfirmedAt:
//             existingOrder.arrival_confirmed_at,

//         },

//       });

//     }


//     if (
//       existingOrder.status !==
//       'out_for_delivery'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Arrival cannot be confirmed from current order status',

//         status:
//           existingOrder.status,

//       });

//     }


//     // =================================================
//     // GENERATE 6 DIGIT CUSTOMER PIN
//     // =================================================

//     const deliveryPin =
//       Math.floor(
//         100000 +
//         Math.random() * 900000
//       ).toString();


//     // =================================================
//     // SAVE ARRIVAL + PIN
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           delivery_pin =
//             $1,

//           arrival_confirmed_at =
//             NOW(),

//           status =
//             'arrived',

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND shopper_id = $3

//           AND status =
//             'out_for_delivery'

//         RETURNING

//           id,
//           customer_id,
//           shopper_id,
//           status,
//           delivery_pin,
//           arrival_confirmed_at,
//           updated_at

//         `,
//         [
//           deliveryPin,
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Unable to confirm arrival',

//       });

//     }


//     const order =
//       result.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '📍 CUSTOMER ARRIVAL CONFIRMED'
//     );

//     console.log(
//       'Order ID:',
//       order.id
//     );

//     console.log(
//       'Shopper ID:',
//       order.shopper_id
//     );

//     console.log(
//       'Customer ID:',
//       order.customer_id
//     );

//     console.log(
//       'Delivery PIN:',
//       order.delivery_pin
//     );

//     console.log(
//       'Arrival Time:',
//       order.arrival_confirmed_at
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Customer arrival confirmed',

//       order: {

//         id:
//           Number(
//             order.id
//           ),

//         customerId:
//           Number(
//             order.customer_id
//           ),

//         shopperId:
//           Number(
//             order.shopper_id
//           ),

//         status:
//           order.status,

//         deliveryPin:
//           order.delivery_pin,

//         arrivalConfirmedAt:
//           order.arrival_confirmed_at,

//         updatedAt:
//           order.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ CONFIRM ARRIVAL ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to confirm arrival',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // VERIFY CUSTOMER DELIVERY PIN
// // =====================================================

// const verifyDeliveryPin = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const enteredPin =
//       String(
//         req.body?.pin ||
//         req.body?.deliveryPin ||
//         ''
//       ).trim();


//     if (
//       !/^\d{6}$/.test(
//         enteredPin
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Delivery PIN must contain exactly 6 digits',

//       });

//     }


//     // =================================================
//     // GET ORDER
//     // =================================================

//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           customer_id,
//           shopper_id,
//           status,
//           delivery_pin

//         FROM orders

//         WHERE

//           id = $1

//           AND shopper_id = $2

//         LIMIT 1

//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found or does not belong to this shopper',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // =================================================
//     // ARRIVAL MUST BE CONFIRMED
//     // =================================================

//     if (
//       order.status !==
//       'arrived'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Customer arrival must be confirmed first',

//         status:
//           order.status,

//       });

//     }


//     // =================================================
//     // CHECK PIN
//     // =================================================

//     if (
//       !order.delivery_pin ||
//       enteredPin !==
//         String(
//           order.delivery_pin
//         )
//     ) {

//       console.log(
//         '❌ INCORRECT DELIVERY PIN'
//       );

//       console.log(
//         'Order ID:',
//         orderId
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           'Incorrect customer delivery PIN',

//         verified:
//           false,

//       });

//     }


//     // =================================================
//     // COMPLETE DELIVERY
//     // =================================================

//     const result =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           status =
//             'delivered',

//           delivered_at =
//             NOW(),

//           updated_at =
//             NOW()

//         WHERE

//           id = $1

//           AND shopper_id = $2

//           AND status =
//             'arrived'

//           AND delivery_pin =
//             $3

//         RETURNING

//           id,
//           customer_id,
//           shopper_id,
//           status,
//           delivered_at

//         `,
//         [
//           orderId,
//           shopperId,
//           enteredPin,
//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Unable to complete delivery',

//       });

//     }


//     const deliveredOrder =
//       result.rows[0];


//     console.log(
//       '========================================'
//     );

//     console.log(
//       '✅ DELIVERY COMPLETED'
//     );

//     console.log(
//       'Order ID:',
//       deliveredOrder.id
//     );

//     console.log(
//       'Shopper ID:',
//       deliveredOrder.shopper_id
//     );

//     console.log(
//       'Customer ID:',
//       deliveredOrder.customer_id
//     );

//     console.log(
//       'Delivered At:',
//       deliveredOrder.delivered_at
//     );

//     console.log(
//       '========================================'
//     );


//     return res.json({

//       success: true,

//       message:
//         'Delivery completed successfully',

//       verified:
//         true,

//       order: {

//         id:
//           Number(
//             deliveredOrder.id
//           ),

//         customerId:
//           Number(
//             deliveredOrder.customer_id
//           ),

//         shopperId:
//           Number(
//             deliveredOrder.shopper_id
//           ),

//         status:
//           deliveredOrder.status,

//         deliveredAt:
//           deliveredOrder.delivered_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ VERIFY DELIVERY PIN ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to verify delivery PIN',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ACTIVE ORDERS
// // =====================================================

// const getMyOrders = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const result =
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

//           o.shopper_id,

//           o.payment_id,
//           o.payment_status,
//           o.paid_at,

//           o.bill_url,
//           o.bill_uploaded_at,

//           o.delivery_pin,
//           o.arrival_confirmed_at,
//           o.delivered_at,

//           o.created_at,
//           o.updated_at,

//           s.shop_name,
//           s.image_url AS shop_image,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC

//         `,
//         [shopperId]
//       );


//     const orders =
//       await Promise.all(

//         result.rows.map(
//           async (order) => {

//             const itemsResult =
//               await pool.query(
//                 `
//                 SELECT

//                   id,
//                   order_id,
//                   product_id,
//                   item_name,
//                   quantity,
//                   amount,
//                   unit,
//                   price,
//                   custom,
//                   details,
//                   image,

//                   shopper_photo_url,
//                   shopping_status,
//                   found_quantity,
//                   found_weight,
//                   found_weight_unit,
//                   barcode_scanned,
//                   completed_at

//                 FROM order_items

//                 WHERE order_id = $1

//                 ORDER BY id ASC

//                 `,
//                 [order.id]
//               );


//             const items =
//               itemsResult.rows;


//             return {

//               id:
//                 Number(
//                   order.id
//                 ),

//               customerId:
//                 Number(
//                   order.customer_id
//                 ),

//               shopId:
//                 Number(
//                   order.shop_id
//                 ),

//               shopperId:
//                 Number(
//                   order.shopper_id
//                 ),


//               store:
//                 order.shop_name,

//               storeName:
//                 order.shop_name,

//               shop:
//                 order.shop_name,

//               shopImage:
//                 order.shop_image ||
//                 null,


//               pickupLatitude:
//                 Number(
//                   order.shop_latitude
//                 ),

//               pickupLongitude:
//                 Number(
//                   order.shop_longitude
//                 ),


//               customer:
//                 order.delivery_address,

//               customerName:
//                 `Customer #${order.customer_id}`,

//               phone:
//                 null,

//               customerPhone:
//                 null,


//               customerLatitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               customerLongitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               latitude:
//                 Number(
//                   order.delivery_latitude
//                 ),

//               longitude:
//                 Number(
//                   order.delivery_longitude
//                 ),


//               deliveryAddress:
//                 order.delivery_address,


//               deliveryOption:
//                 order.delivery_option,

//               paymentMethod:
//                 order.payment_method,


//               itemsTotal:
//                 Number(
//                   order.items_total || 0
//                 ),

//               deliveryFee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),

//               serviceFee:
//                 Number(
//                   order.service_fee || 0
//                 ),

//               totalAmount:
//                 Number(
//                   order.total_amount || 0
//                 ),

//               fee:
//                 Number(
//                   order.delivery_fee || 0
//                 ),


//               status:
//                 order.status,


//               paymentId:
//                 order.payment_id ||
//                 null,

//               paymentStatus:
//                 order.payment_status ||
//                 null,

//               paidAt:
//                 order.paid_at ||
//                 null,


//               billUrl:
//                 order.bill_url ||
//                 null,

//               billImage:
//                 order.bill_url ||
//                 null,

//               billUploadedAt:
//                 order.bill_uploaded_at ||
//                 null,


//               deliveryPin:
//                 order.delivery_pin ||
//                 null,

//               arrivalConfirmedAt:
//                 order.arrival_confirmed_at ||
//                 null,

//               deliveredAt:
//                 order.delivered_at ||
//                 null,


//               createdAt:
//                 order.created_at,

//               updatedAt:
//                 order.updated_at,


//               items:
//                 items.length,


//               shoppingList:
//                 items.map(
//                   item => ({

//                     id:
//                       Number(
//                         item.id
//                       ),

//                     productId:
//                       item.product_id,

//                     name:
//                       item.item_name,

//                     productName:
//                       item.item_name,

//                     quantity:
//                       Number(
//                         item.quantity || 1
//                       ),

//                     amount:
//                       Number(
//                         item.amount || 0
//                       ),

//                     unit:
//                       item.unit,

//                     price:
//                       Number(
//                         item.price || 0
//                       ),

//                     custom:
//                       item.custom === true,

//                     details:
//                       item.details,

//                     image:
//                       item.image,


//                     shopperPhotoUrl:
//                       item.shopper_photo_url ||
//                       null,

//                     shoppingStatus:
//                       item.shopping_status ||
//                       'pending',

//                     foundQuantity:
//                       item.found_quantity !== null
//                         ? Number(
//                             item.found_quantity
//                           )
//                         : null,

//                     foundWeight:
//                       item.found_weight !== null
//                         ? Number(
//                             item.found_weight
//                           )
//                         : null,

//                     foundWeightUnit:
//                       item.found_weight_unit ||
//                       null,

//                     barcodeScanned:
//                       item.barcode_scanned === true,

//                     completedAt:
//                       item.completed_at ||
//                       null,

//                   })
//                 ),


//               orderItems:
//                 items,

//             };

//           }
//         )

//       );


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET MY SHOPPER ORDERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY ONLINE SHOPPERS FOR CUSTOMER ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           o.id,
//           o.shop_id,

//           s.shop_name,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE o.id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const shopLatitude =
//       Number(
//         order.shop_latitude
//       );


//     const shopLongitude =
//       Number(
//         order.shop_longitude
//       );


//     if (
//       !Number.isFinite(
//         shopLatitude
//       ) ||
//       !Number.isFinite(
//         shopLongitude
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop location is not available',

//       });

//     }


//     const shoppersResult =
//       await pool.query(
//         `
//         SELECT

//           id,

//           latitude,
//           longitude,

//           status

//         FROM shoppers

//         WHERE

//           status = 'online'

//           AND latitude IS NOT NULL

//           AND longitude IS NOT NULL

//           AND (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) <= 10

//         ORDER BY

//           (

//             6371 *

//             acos(

//               LEAST(

//                 1,

//                 GREATEST(

//                   -1,

//                   cos(
//                     radians($1)
//                   )

//                   *

//                   cos(
//                     radians(latitude)
//                   )

//                   *

//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )

//                   +

//                   sin(
//                     radians($1)
//                   )

//                   *

//                   sin(
//                     radians(latitude)
//                   )

//                 )

//               )

//             )

//           ) ASC

//         `,
//         [
//           shopLatitude,
//           shopLongitude,
//         ]
//       );


//     const shoppers =
//       shoppersResult.rows.map(
//         shopper => {

//           const latitude =
//             Number(
//               shopper.latitude
//             );


//           const longitude =
//             Number(
//               shopper.longitude
//             );


//           const distanceKm =
//             6371 *

//             Math.acos(

//               Math.min(

//                 1,

//                 Math.max(

//                   -1,

//                   Math.cos(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.cos(
//                     (
//                       longitude -
//                       shopLongitude
//                     ) *
//                     Math.PI /
//                     180
//                   )

//                   +

//                   Math.sin(
//                     shopLatitude *
//                     Math.PI /
//                     180
//                   )

//                   *

//                   Math.sin(
//                     latitude *
//                     Math.PI /
//                     180
//                   )

//                 )

//               )

//             );


//           return {

//             id:
//               Number(
//                 shopper.id
//               ),

//             latitude,

//             longitude,

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 distanceKm.toFixed(2)
//               ),

//           };

//         }
//       );


//     return res.json({

//       success: true,

//       orderId,

//       shop: {

//         id:
//           Number(
//             order.shop_id
//           ),

//         name:
//           order.shop_name,

//         latitude:
//           shopLatitude,

//         longitude:
//           shopLongitude,

//       },

//       count:
//         shoppers.length,

//       shoppers,

//     });


//   } catch (error) {

//     console.error(
//       '❌ GET NEARBY SHOPPERS ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // =====================================================

// const uploadItemPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Item photo is required',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const parsedQuantity =
//       foundQuantity !== undefined &&
//       foundQuantity !== null &&
//       foundQuantity !== ''
//         ? Number(foundQuantity)
//         : null;


//     const parsedWeight =
//       foundWeight !== undefined &&
//       foundWeight !== null &&
//       foundWeight !== ''
//         ? Number(foundWeight)
//         : null;


//     const parsedBarcode =
//       barcodeScanned === true ||
//       barcodeScanned === 'true';


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopper_photo_url =
//             $1,

//           shopping_status =
//             'done',

//           found_quantity =
//             $2,

//           found_weight =
//             $3,

//           found_weight_unit =
//             $4,

//           barcode_scanned =
//             $5,

//           completed_at =
//             NOW()

//         WHERE

//           id = $6

//           AND order_id = $7

//         RETURNING *

//         `,
//         [
//           photoUrl,
//           parsedQuantity,
//           parsedWeight,
//           foundWeightUnit ||
//             null,
//           parsedBarcode,
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save item photo',

//       });

//     }


//     const item =
//       updateResult.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Item photo uploaded successfully',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status ||
//           'done',

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ ITEM PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload item photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SHOPPER REPLACEMENT PHOTO
// // =====================================================

// const uploadReplacementPhoto = async (req, res) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Replacement photo is required',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           customer_id,
//           status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const itemResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           order_id,
//           item_name

//         FROM order_items

//         WHERE

//           id = $1

//           AND order_id = $2

//         LIMIT 1

//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (
//       itemResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Original order item not found',

//       });

//     }


//     const originalItem =
//       itemResult.rows[0];


//     const optionResult =
//       await pool.query(
//         `
//         SELECT

//           COALESCE(
//             MAX(option_number),
//             0
//           ) + 1 AS next_option

//         FROM replacement_items

//         WHERE

//           order_id = $1

//           AND original_item_id = $2

//         `,
//         [
//           orderId,
//           itemId,
//         ]
//       );


//     const optionNumber =
//       Number(
//         optionResult.rows[0]?.next_option ||
//         1
//       );


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/replacements/${req.file.filename}`;


//     const insertResult =
//       await pool.query(
//         `
//         INSERT INTO replacement_items (

//           order_id,

//           original_item_id,

//           shopper_id,

//           option_number,

//           photo_url,

//           status,

//           created_at,

//           updated_at

//         )

//         VALUES (

//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           'waiting_customer',
//           NOW(),
//           NOW()

//         )

//         RETURNING *

//         `,
//         [
//           orderId,
//           itemId,
//           shopperId,
//           optionNumber,
//           photoUrl,
//         ]
//       );


//     if (
//       insertResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save replacement photo',

//       });

//     }


//     const replacement =
//       insertResult.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Replacement photo uploaded successfully',

//       replacement: {

//         id:
//           Number(
//             replacement.id
//           ),

//         orderId:
//           Number(
//             replacement.order_id
//           ),

//         originalItemId:
//           Number(
//             replacement.original_item_id
//           ),

//         originalItemName:
//           originalItem.item_name,

//         shopperId:
//           Number(
//             replacement.shopper_id
//           ),

//         optionNumber:
//           Number(
//             replacement.option_number
//           ),

//         photoUrl:
//           replacement.photo_url,

//         replacementPhotoUrl:
//           replacement.photo_url,

//         status:
//           replacement.status,

//         createdAt:
//           replacement.created_at,

//         updatedAt:
//           replacement.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ REPLACEMENT PHOTO UPLOAD ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload replacement photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ITEM SHOPPING DATA
// // =====================================================

// const updateItemShoppingStatus = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     const itemId =
//       Number(
//         req.params.itemId
//       );


//     if (
//       !Number.isInteger(orderId) ||
//       !Number.isInteger(itemId)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order or item ID',

//       });

//     }


//     const {
//       foundQuantity,
//       foundWeight,
//       foundWeightUnit,
//       barcodeScanned,
//     } = req.body;


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     if (
//       Number(
//         orderResult.rows[0].shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE order_items

//         SET

//           shopping_status =
//             'done',

//           found_quantity =
//             $1,

//           found_weight =
//             $2,

//           found_weight_unit =
//             $3,

//           barcode_scanned =
//             $4,

//           completed_at =
//             NOW()

//         WHERE

//           id = $5

//           AND order_id = $6

//         RETURNING *

//         `,
//         [

//           foundQuantity !== undefined &&
//           foundQuantity !== null &&
//           foundQuantity !== ''
//             ? Number(foundQuantity)
//             : null,

//           foundWeight !== undefined &&
//           foundWeight !== null &&
//           foundWeight !== ''
//             ? Number(foundWeight)
//             : null,

//           foundWeightUnit ||
//             null,

//           barcodeScanned === true ||
//           barcodeScanned === 'true',

//           itemId,
//           orderId,

//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order item not found',

//       });

//     }


//     const item =
//       result.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Item shopping data updated',

//       item: {

//         id:
//           Number(
//             item.id
//           ),

//         orderId:
//           Number(
//             item.order_id
//           ),

//         itemName:
//           item.item_name,

//         shopperPhotoUrl:
//           item.shopper_photo_url ||
//           null,

//         shoppingStatus:
//           item.shopping_status,

//         foundQuantity:
//           item.found_quantity !== null
//             ? Number(
//                 item.found_quantity
//               )
//             : null,

//         foundWeight:
//           item.found_weight !== null
//             ? Number(
//                 item.found_weight
//               )
//             : null,

//         foundWeightUnit:
//           item.found_weight_unit ||
//           null,

//         barcodeScanned:
//           item.barcode_scanned === true,

//         completedAt:
//           item.completed_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPDATE ITEM SHOPPING ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update item shopping data',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ORDER PAYMENT
// // =====================================================

// const updateOrderPayment = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     const {
//       paymentId,
//       paymentStatus,
//       paidAt,
//     } = req.body;


//     if (!paymentId) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Payment ID is required',

//       });

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           payment_id =
//             $1,

//           payment_status =
//             $2,

//           paid_at =
//             $3,

//           updated_at =
//             NOW()

//         WHERE

//           id = $4

//           AND shopper_id = $5

//         RETURNING

//           id,
//           payment_id,
//           payment_status,
//           paid_at

//         `,
//         [

//           String(
//             paymentId
//           ),

//           paymentStatus ||
//             'paid',

//           paidAt ||
//             new Date(),

//           orderId,

//           shopperId,

//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found or does not belong to this shopper',

//       });

//     }


//     const payment =
//       result.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Payment information saved successfully',

//       payment: {

//         orderId:
//           Number(
//             payment.id
//           ),

//         paymentId:
//           payment.payment_id,

//         paymentStatus:
//           payment.payment_status,

//         paidAt:
//           payment.paid_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPDATE ORDER PAYMENT ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update order payment',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD SUPERMARKET BILL
// // =====================================================

// const uploadBill = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Shopper authentication required',

//       });

//     }


//     const orderId =
//       Number(
//         req.params.orderId
//       );


//     if (
//       !Number.isInteger(
//         orderId
//       )
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid order ID',

//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Bill image is required',

//       });

//     }


//     const orderResult =
//       await pool.query(
//         `
//         SELECT

//           id,
//           shopper_id,
//           payment_id,
//           payment_status

//         FROM orders

//         WHERE id = $1

//         LIMIT 1

//         `,
//         [orderId]
//       );


//     if (
//       orderResult.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Order not found',

//       });

//     }


//     const order =
//       orderResult.rows[0];


//     if (
//       Number(
//         order.shopper_id
//       ) !==
//       Number(shopperId)
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'This order does not belong to this shopper',

//       });

//     }


//     const billUrl =
//       `${req.protocol}://${req.get('host')}/uploads/bills/${req.file.filename}`;


//     const updateResult =
//       await pool.query(
//         `
//         UPDATE orders

//         SET

//           bill_url =
//             $1,

//           bill_uploaded_at =
//             NOW(),

//           updated_at =
//             NOW()

//         WHERE

//           id = $2

//           AND shopper_id = $3

//         RETURNING

//           id,
//           payment_id,
//           payment_status,
//           paid_at,
//           bill_url,
//           bill_uploaded_at

//         `,
//         [
//           billUrl,
//           orderId,
//           shopperId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to save bill information',

//       });

//     }


//     const savedBill =
//       updateResult.rows[0];


//     return res.json({

//       success: true,

//       message:
//         'Bill uploaded successfully',

//       bill: {

//         orderId:
//           Number(
//             savedBill.id
//           ),

//         billUrl:
//           savedBill.bill_url,

//         billImage:
//           savedBill.bill_url,

//         uploadedAt:
//           savedBill.bill_uploaded_at,

//         paymentId:
//           savedBill.payment_id ||
//           null,

//         paymentStatus:
//           savedBill.payment_status ||
//           null,

//         paidAt:
//           savedBill.paid_at ||
//           null,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ UPLOAD BILL ERROR:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload bill',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORT
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   startShopping,

//   startDelivery,

//   confirmArrival,

//   verifyDeliveryPin,

//   getMyOrders,

//   getMyOrderById,

//   getNearbyShoppersForOrder,

//   uploadItemPhoto,

//   uploadReplacementPhoto,

//   updateItemShoppingStatus,

//   updateOrderPayment,

//   uploadBill,

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
// // GET AVAILABLE ORDERS
// // =====================================================

// const getAvailableOrders = async (req, res) => {
//   try {

//     const shopperId = getShopperId(req);

//     if (!shopperId) {
//       return res.status(401).json({
//         success: false,
//         message: 'Shopper authentication required',
//       });
//     }


//     // -------------------------------------------------
//     // GET SHOPPER LOCATION
//     // -------------------------------------------------

//     const shopperResult = await db.query(
//       `
//       SELECT
//         id,
//         latitude,
//         longitude,
//         status
//       FROM shoppers
//       WHERE id = $1
//       LIMIT 1
//       `,
//       [shopperId]
//     );


//     if (shopperResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shopper not found',
//       });
//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);

//     const shopperLongitude =
//       Number(shopper.longitude);


//     if (
//       !Number.isFinite(shopperLatitude) ||
//       !Number.isFinite(shopperLongitude)
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Shopper location is not available',
//       });

//     }


//     // -------------------------------------------------
//     // GET AVAILABLE ORDERS
//     // -------------------------------------------------

//     const ordersResult = await db.query(
//       `
//       SELECT
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
//         s.image_url AS shop_image,

//         s.latitude AS shop_latitude,
//         s.longitude AS shop_longitude,

//         (
//           6371 * acos(
//             LEAST(
//               1,
//               GREATEST(
//                 -1,
//                 cos(radians($1))
//                 *
//                 cos(radians(s.latitude))
//                 *
//                 cos(
//                   radians(s.longitude)
//                   -
//                   radians($2)
//                 )
//                 +
//                 sin(radians($1))
//                 *
//                 sin(radians(s.latitude))
//               )
//             )
//           )
//         ) AS shop_distance_km

//       FROM orders o

//       INNER JOIN shops s
//         ON s.id = o.shop_id

//       WHERE
//         o.status = 'waiting_for_shopper'
//         AND o.shopper_id IS NULL

//         AND s.status = 'approved'

//         AND s.latitude IS NOT NULL
//         AND s.longitude IS NOT NULL

//       ORDER BY
//         shop_distance_km ASC,
//         o.created_at ASC
//       `,
//       [
//         shopperLatitude,
//         shopperLongitude,
//       ]
//     );


//     // -------------------------------------------------
//     // FILTER WITHIN 10 KM
//     // -------------------------------------------------

//     const nearbyOrders =
//       ordersResult.rows.filter((order) => {

//         const distance =
//           Number(order.shop_distance_km);

//         return (
//           Number.isFinite(distance) &&
//           distance <= 10
//         );

//       });


//     // -------------------------------------------------
//     // BUILD ORDERS
//     // -------------------------------------------------

//     const orders = [];


//     for (const order of nearbyOrders) {

//       // -----------------------------------------------
//       // GET ORDER ITEMS
//       // -----------------------------------------------

//       const itemsResult =
//         await db.query(
//           `
//           SELECT
//             id,
//             order_id,
//             product_id,
//             item_name,
//             quantity,
//             amount,
//             unit,
//             price,
//             custom,
//             details,
//             image,

//             voice_url,

//             shopper_photo_url,
//             shopping_status,
//             found_quantity,
//             found_weight,
//             found_weight_unit,
//             barcode_scanned,
//             completed_at

//           FROM order_items

//           WHERE order_id = $1

//           ORDER BY id ASC
//           `,
//           [order.id]
//         );


//       const orderItems =
//         itemsResult.rows.map((item) => ({

//           id:
//             item.id,

//           orderId:
//             item.order_id,

//           productId:
//             item.product_id,

//           name:
//             item.item_name,

//           productName:
//             item.item_name,

//           quantity:
//             item.quantity,

//           amount:
//             item.amount,

//           unit:
//             item.unit,

//           price:
//             item.price,

//           custom:
//             item.custom,

//           details:
//             item.details,

//           image:
//             item.image,

//           // -------------------------------------------
//           // CUSTOMER VOICE NOTE
//           // -------------------------------------------

//           voiceUrl:
//             item.voice_url || null,

//           shopperPhotoUrl:
//             item.shopper_photo_url || null,

//           shoppingStatus:
//             item.shopping_status || 'pending',

//           foundQuantity:
//             item.found_quantity,

//           foundWeight:
//             item.found_weight,

//           foundWeightUnit:
//             item.found_weight_unit,

//           barcodeScanned:
//             item.barcode_scanned || false,

//           completedAt:
//             item.completed_at,

//         }));


//       // -----------------------------------------------
//       // ORDER OBJECT
//       // -----------------------------------------------

//       const distanceKm =
//         Number(order.shop_distance_km);


//       const orderObject = {

//         id:
//           order.id,

//         customerId:
//           order.customer_id,

//         shopId:
//           order.shop_id,


//         store:
//           order.shop_name,

//         storeName:
//           order.shop_name,

//         shop:
//           order.shop_name,


//         shopImage:
//           order.shop_image || null,


//         pickupLatitude:
//           Number(order.shop_latitude),

//         pickupLongitude:
//           Number(order.shop_longitude),


//         customer:
//           order.delivery_address,

//         customerName:
//           `Customer #${order.customer_id}`,

//         phone:
//           null,

//         customerPhone:
//           null,


//         customerLatitude:
//           Number(order.delivery_latitude),

//         customerLongitude:
//           Number(order.delivery_longitude),


//         latitude:
//           Number(order.delivery_latitude),

//         longitude:
//           Number(order.delivery_longitude),


//         deliveryAddress:
//           order.delivery_address,


//         itemsTotal:
//           Number(order.items_total || 0),

//         deliveryFee:
//           Number(order.delivery_fee || 0),

//         serviceFee:
//           Number(order.service_fee || 0),

//         totalAmount:
//           Number(order.total_amount || 0),


//         distance:
//           `${distanceKm.toFixed(2)} km`,

//         distanceKm:
//           distanceKm,


//         deliveryOption:
//           order.delivery_option,

//         paymentMethod:
//           order.payment_method,


//         status:
//           order.status,


//         createdAt:
//           order.created_at,

//         updatedAt:
//           order.updated_at,


//         items:
//           orderItems.length,


//         shoppingList:
//           orderItems,

//         orderItems:
//           orderItems,

//       };


//       orders.push(orderObject);

//     }


//     // =================================================
//     // GROUP MULTI-SHOP ORDERS
//     // =================================================

//     const groupedOrders = [];


//     const groups = new Map();


//     for (const order of orders) {

//       const latitude =
//         Number(order.customerLatitude)
//           .toFixed(5);

//       const longitude =
//         Number(order.customerLongitude)
//           .toFixed(5);

//       const address =
//         String(
//           order.customer || ''
//         )
//           .trim()
//           .toLowerCase();


//       const groupKey =
//         `${order.customerId}_${latitude}_${longitude}_${address}`;


//       if (!groups.has(groupKey)) {

//         groups.set(
//           groupKey,
//           []
//         );

//       }


//       groups
//         .get(groupKey)
//         .push(order);

//     }


//     for (
//       const [
//         groupKey,
//         groupOrders
//       ] of groups
//     ) {

//       const shopNames =
//         groupOrders.map(
//           (order) =>
//             order.storeName
//         );


//       const shops =
//         groupOrders.map(
//           (order) => ({

//             shopId:
//               order.shopId,

//             shopName:
//               order.storeName,

//             shopImage:
//               order.shopImage,

//             pickupLatitude:
//               order.pickupLatitude,

//             pickupLongitude:
//               order.pickupLongitude,

//             distanceKm:
//               order.distanceKm,

//           })
//         );


//       const orderGroupId =
//         `customer-${groupOrders[0].customerId}-${Math.round(
//           Date.now() / 1000
//         )}-${groupOrders[0].id}`;


//       for (const order of groupOrders) {

//         order.orderGroupId =
//           orderGroupId;

//         order.batchId =
//           orderGroupId;

//         order.customerOrderId =
//           orderGroupId;

//         order.shopCount =
//           groupOrders.length;

//         order.shopNames =
//           shopNames;

//         order.shops =
//           shops;

//         order.batchOrders =
//           groupOrders.map(
//             (batchOrder) => ({

//               id:
//                 batchOrder.id,

//               shopId:
//                 batchOrder.shopId,

//               storeName:
//                 batchOrder.storeName,

//               shopImage:
//                 batchOrder.shopImage,

//               pickupLatitude:
//                 batchOrder.pickupLatitude,

//               pickupLongitude:
//                 batchOrder.pickupLongitude,

//               distanceKm:
//                 batchOrder.distanceKm,

//               status:
//                 batchOrder.status,

//               items:
//                 batchOrder.items,

//             })
//           );

//       }

//     }


//     // =================================================
//     // RESPONSE
//     // =================================================

//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ getAvailableOrders error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }
// };


// // =====================================================
// // GET MY ORDER BY ID
// // =====================================================

// const getMyOrderById = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!Number.isInteger(orderId)) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Invalid order ID',
//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT
//           o.*,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.id = $1
//           AND o.shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // -------------------------------------------------
//     // ORDER ITEMS
//     // -------------------------------------------------

//     const itemsResult =
//       await db.query(
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

//           voice_url,

//           shopper_photo_url,
//           shopping_status,
//           found_quantity,
//           found_weight,
//           found_weight_unit,
//           barcode_scanned,
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC
//         `,
//         [orderId]
//       );


//     const orderItems =
//       itemsResult.rows.map(
//         (item) => ({

//           id:
//             item.id,

//           orderId:
//             item.order_id,

//           productId:
//             item.product_id,

//           name:
//             item.item_name,

//           productName:
//             item.item_name,

//           quantity:
//             item.quantity,

//           amount:
//             item.amount,

//           unit:
//             item.unit,

//           price:
//             item.price,

//           custom:
//             item.custom,

//           details:
//             item.details,

//           image:
//             item.image,

//           voiceUrl:
//             item.voice_url || null,

//           shopperPhotoUrl:
//             item.shopper_photo_url || null,

//           shoppingStatus:
//             item.shopping_status || 'pending',

//           foundQuantity:
//             item.found_quantity,

//           foundWeight:
//             item.found_weight,

//           foundWeightUnit:
//             item.found_weight_unit,

//           barcodeScanned:
//             item.barcode_scanned || false,

//           completedAt:
//             item.completed_at,

//         })
//       );


//     // -------------------------------------------------
//     // REPLACEMENTS
//     // -------------------------------------------------

//     let replacementItems = [];


//     try {

//       const replacementResult =
//         await db.query(
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

//           WHERE order_id = $1

//           ORDER BY
//             original_item_id ASC,
//             option_number ASC,
//             id ASC
//           `,
//           [orderId]
//         );


//       replacementItems =
//         replacementResult.rows.map(
//           (item) => ({

//             id:
//               item.id,

//             orderId:
//               item.order_id,

//             originalItemId:
//               item.original_item_id,

//             shopperId:
//               item.shopper_id,

//             optionNumber:
//               item.option_number,

//             photoUrl:
//               item.photo_url,

//             status:
//               item.status,

//             createdAt:
//               item.created_at,

//             updatedAt:
//               item.updated_at,

//           })
//         );

//     } catch (replacementError) {

//       console.error(
//         '⚠️ Replacement items query failed:',
//         replacementError.message
//       );

//       replacementItems = [];

//     }


//     // -------------------------------------------------
//     // RESPONSE ORDER
//     // -------------------------------------------------

//     const responseOrder = {

//       id:
//         order.id,

//       customerId:
//         order.customer_id,

//       shopId:
//         order.shop_id,

//       shopperId:
//         order.shopper_id,


//       store:
//         order.shop_name,

//       storeName:
//         order.shop_name,

//       shop:
//         order.shop_name,


//       shopImage:
//         order.shop_image || null,


//       pickupLatitude:
//         order.shop_latitude !== null
//           ? Number(order.shop_latitude)
//           : null,

//       pickupLongitude:
//         order.shop_longitude !== null
//           ? Number(order.shop_longitude)
//           : null,


//       customer:
//         order.delivery_address,

//       customerName:
//         `Customer #${order.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(order.delivery_latitude),

//       customerLongitude:
//         Number(order.delivery_longitude),


//       latitude:
//         Number(order.delivery_latitude),

//       longitude:
//         Number(order.delivery_longitude),


//       deliveryAddress:
//         order.delivery_address,


//       deliveryOption:
//         order.delivery_option,

//       paymentMethod:
//         order.payment_method,


//       itemsTotal:
//         Number(order.items_total || 0),

//       deliveryFee:
//         Number(order.delivery_fee || 0),

//       serviceFee:
//         Number(order.service_fee || 0),

//       totalAmount:
//         Number(order.total_amount || 0),


//       status:
//         order.status,


//       createdAt:
//         order.created_at,

//       updatedAt:
//         order.updated_at,


//       paymentId:
//         order.payment_id || null,

//       paymentStatus:
//         order.payment_status || null,

//       paidAt:
//         order.paid_at || null,


//       billUrl:
//         order.bill_url || null,

//       billUploadedAt:
//         order.bill_uploaded_at || null,


//       deliveryPin:
//         order.delivery_pin || null,

//       arrivalConfirmedAt:
//         order.arrival_confirmed_at || null,

//       deliveredAt:
//         order.delivered_at || null,


//       items:
//         orderItems.length,

//       shoppingList:
//         orderItems,

//       orderItems:
//         orderItems,


//       replacementItems:
//         replacementItems,

//       replacements:
//         replacementItems,

//     };


//     return res.json({

//       success: true,

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     console.error(
//       '❌ getMyOrderById error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get order',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (
//   req,
//   res
// ) => {

//   const client =
//     await db.connect();

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!Number.isInteger(orderId)) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Invalid order ID',
//       });

//     }


//     await client.query(
//       'BEGIN'
//     );


//     const existingResult =
//       await client.query(
//         `
//         SELECT *
//         FROM orders
//         WHERE id = $1
//         FOR UPDATE
//         `,
//         [orderId]
//       );


//     if (
//       existingResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const existingOrder =
//       existingResult.rows[0];


//     if (
//       existingOrder.status !==
//         'waiting_for_shopper' ||
//       existingOrder.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );

//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//       });

//     }


//     // -------------------------------------------------
//     // ACCEPT
//     // -------------------------------------------------

//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET
//           shopper_id = $1,
//           status = 'shopper_accepted',
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND status = 'waiting_for_shopper'
//           AND shopper_id IS NULL

//         RETURNING *
//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order was already accepted',

//       });

//     }


//     const acceptedOrder =
//       updateResult.rows[0];


//     // -------------------------------------------------
//     // SHOP
//     // -------------------------------------------------

//     const shopResult =
//       await client.query(
//         `
//         SELECT
//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude

//         FROM shops

//         WHERE id = $1

//         LIMIT 1
//         `,
//         [acceptedOrder.shop_id]
//       );


//     const shop =
//       shopResult.rows[0] || null;


//     // -------------------------------------------------
//     // ITEMS
//     // -------------------------------------------------

//     const itemsResult =
//       await client.query(
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

//           voice_url,

//           shopper_photo_url,
//           shopping_status,
//           found_quantity,
//           found_weight,
//           found_weight_unit,
//           barcode_scanned,
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC
//         `,
//         [orderId]
//       );


//     const orderItems =
//       itemsResult.rows.map(
//         (item) => ({

//           id:
//             item.id,

//           orderId:
//             item.order_id,

//           productId:
//             item.product_id,

//           name:
//             item.item_name,

//           productName:
//             item.item_name,

//           quantity:
//             item.quantity,

//           amount:
//             item.amount,

//           unit:
//             item.unit,

//           price:
//             item.price,

//           custom:
//             item.custom,

//           details:
//             item.details,

//           image:
//             item.image,

//           voiceUrl:
//             item.voice_url || null,

//           shopperPhotoUrl:
//             item.shopper_photo_url || null,

//           shoppingStatus:
//             item.shopping_status || 'pending',

//           foundQuantity:
//             item.found_quantity,

//           foundWeight:
//             item.found_weight,

//           foundWeightUnit:
//             item.found_weight_unit,

//           barcodeScanned:
//             item.barcode_scanned || false,

//           completedAt:
//             item.completed_at,

//         })
//       );


//     await client.query(
//       'COMMIT'
//     );


//     return res.json({

//       success: true,

//       order: {

//         id:
//           acceptedOrder.id,

//         customerId:
//           acceptedOrder.customer_id,

//         shopId:
//           acceptedOrder.shop_id,

//         shopperId:
//           acceptedOrder.shopper_id,


//         store:
//           shop?.shop_name || null,

//         storeName:
//           shop?.shop_name || null,

//         shop:
//           shop?.shop_name || null,


//         shopImage:
//           shop?.image_url || null,


//         pickupLatitude:
//           shop?.latitude !== null &&
//           shop?.latitude !== undefined
//             ? Number(shop.latitude)
//             : null,

//         pickupLongitude:
//           shop?.longitude !== null &&
//           shop?.longitude !== undefined
//             ? Number(shop.longitude)
//             : null,


//         customer:
//           acceptedOrder.delivery_address,

//         customerName:
//           `Customer #${acceptedOrder.customer_id}`,

//         phone:
//           null,

//         customerPhone:
//           null,


//         customerLatitude:
//           Number(
//             acceptedOrder.delivery_latitude
//           ),

//         customerLongitude:
//           Number(
//             acceptedOrder.delivery_longitude
//           ),


//         latitude:
//           Number(
//             acceptedOrder.delivery_latitude
//           ),

//         longitude:
//           Number(
//             acceptedOrder.delivery_longitude
//           ),


//         deliveryAddress:
//           acceptedOrder.delivery_address,


//         deliveryOption:
//           acceptedOrder.delivery_option,

//         paymentMethod:
//           acceptedOrder.payment_method,


//         itemsTotal:
//           Number(
//             acceptedOrder.items_total || 0
//           ),

//         deliveryFee:
//           Number(
//             acceptedOrder.delivery_fee || 0
//           ),

//         serviceFee:
//           Number(
//             acceptedOrder.service_fee || 0
//           ),

//         totalAmount:
//           Number(
//             acceptedOrder.total_amount || 0
//           ),


//         status:
//           acceptedOrder.status,


//         createdAt:
//           acceptedOrder.created_at,

//         updatedAt:
//           acceptedOrder.updated_at,


//         items:
//           orderItems.length,

//         shoppingList:
//           orderItems,

//         orderItems:
//           orderItems,

//       },

//     });


//   } catch (error) {

//     try {
//       await client.query(
//         'ROLLBACK'
//       );
//     } catch (_) {}


//     console.error(
//       '❌ acceptOrder error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });

//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // START SHOPPING
// // =====================================================

// const startShopping = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status === 'shopping'
//     ) {

//       return res.json({

//         success: true,

//         order: {

//           id:
//             order.id,

//           customerId:
//             order.customer_id,

//           shopId:
//             order.shop_id,

//           shopperId:
//             order.shopper_id,

//           status:
//             order.status,

//         },

//       });

//     }


//     if (
//       order.status !==
//         'shopper_accepted'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot start shopping while order status is ${order.status}`,

//       });

//     }


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           status = 'shopping',
//           updated_at = NOW()

//         WHERE
//           id = $1
//           AND shopper_id = $2
//           AND status = 'shopper_accepted'

//         RETURNING
//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status,
//           updated_at
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     return res.json({

//       success: true,

//       order: {

//         id:
//           updateResult.rows[0].id,

//         customerId:
//           updateResult.rows[0].customer_id,

//         shopId:
//           updateResult.rows[0].shop_id,

//         shopperId:
//           updateResult.rows[0].shopper_id,

//         status:
//           updateResult.rows[0].status,

//         updatedAt:
//           updateResult.rows[0].updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ startShopping error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start shopping',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // START DELIVERY
// // =====================================================

// const startDelivery = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           shopper_id,
//           status,
//           bill_url

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status ===
//         'out_for_delivery'
//     ) {

//       return res.json({

//         success: true,

//         order: {

//           id:
//             order.id,

//           shopperId:
//             order.shopper_id,

//           status:
//             order.status,

//         },

//       });

//     }


//     if (
//       order.status !== 'shopping'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot start delivery while order status is ${order.status}`,

//       });

//     }


//     if (!order.bill_url) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Supermarket bill is required before starting delivery',

//       });

//     }


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           status = 'out_for_delivery',
//           updated_at = NOW()

//         WHERE
//           id = $1
//           AND shopper_id = $2
//           AND status = 'shopping'

//         RETURNING
//           id,
//           shopper_id,
//           status,
//           updated_at
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     return res.json({

//       success: true,

//       order: {

//         id:
//           updateResult.rows[0].id,

//         shopperId:
//           updateResult.rows[0].shopper_id,

//         status:
//           updateResult.rows[0].status,

//         updatedAt:
//           updateResult.rows[0].updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ startDelivery error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start delivery',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // CONFIRM ARRIVAL
// // =====================================================

// const confirmArrival = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           shopper_id,
//           status,
//           delivery_pin

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status === 'arrived' &&
//       order.delivery_pin
//     ) {

//       return res.json({

//         success: true,

//         deliveryPin:
//           order.delivery_pin,

//         order: {

//           id:
//             order.id,

//           shopperId:
//             order.shopper_id,

//           status:
//             order.status,

//           deliveryPin:
//             order.delivery_pin,

//         },

//       });

//     }


//     if (
//       order.status !==
//         'out_for_delivery'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot confirm arrival while order status is ${order.status}`,

//       });

//     }


//     // -------------------------------------------------
//     // GENERATE 6 DIGIT PIN
//     // -------------------------------------------------

//     const deliveryPin =
//       Math.floor(
//         100000 +
//         Math.random() * 900000
//       ).toString();


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           delivery_pin = $1,
//           arrival_confirmed_at = NOW(),
//           status = 'arrived',
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND shopper_id = $3
//           AND status = 'out_for_delivery'

//         RETURNING
//           id,
//           shopper_id,
//           status,
//           delivery_pin,
//           arrival_confirmed_at,
//           updated_at
//         `,
//         [
//           deliveryPin,
//           orderId,
//           shopperId,
//         ]
//       );


//     const updatedOrder =
//       updateResult.rows[0];


//     return res.json({

//       success: true,

//       deliveryPin:
//         updatedOrder.delivery_pin,

//       order: {

//         id:
//           updatedOrder.id,

//         shopperId:
//           updatedOrder.shopper_id,

//         status:
//           updatedOrder.status,

//         deliveryPin:
//           updatedOrder.delivery_pin,

//         arrivalConfirmedAt:
//           updatedOrder.arrival_confirmed_at,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ confirmArrival error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to confirm arrival',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // VERIFY DELIVERY PIN
// // =====================================================

// const verifyDeliveryPin = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const pin =
//       String(
//         req.body.pin ||
//         req.body.deliveryPin ||
//         ''
//       ).trim();


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (
//       !/^\d{6}$/.test(pin)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'A valid 6-digit delivery PIN is required',

//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           shopper_id,
//           status,
//           delivery_pin

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status !== 'arrived'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot verify delivery PIN while order status is ${order.status}`,

//       });

//     }


//     if (
//       String(order.delivery_pin) !==
//       pin
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid delivery PIN',

//       });

//     }


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           status = 'delivered',
//           delivered_at = NOW(),
//           updated_at = NOW()

//         WHERE
//           id = $1
//           AND shopper_id = $2
//           AND status = 'arrived'
//           AND delivery_pin = $3

//         RETURNING
//           id,
//           shopper_id,
//           status,
//           delivered_at,
//           updated_at
//         `,
//         [
//           orderId,
//           shopperId,
//           pin,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Delivery could not be completed',

//       });

//     }


//     const completedOrder =
//       updateResult.rows[0];


//     return res.json({

//       success: true,

//       verified: true,

//       order: {

//         id:
//           completedOrder.id,

//         shopperId:
//           completedOrder.shopper_id,

//         status:
//           completedOrder.status,

//         deliveredAt:
//           completedOrder.delivered_at,

//         updatedAt:
//           completedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ verifyDeliveryPin error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to verify delivery PIN',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ORDERS
// // =====================================================

// const getMyOrders = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const ordersResult =
//       await db.query(
//         `
//         SELECT
//           o.*,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC
//         `,
//         [shopperId]
//       );


//     const orders = [];


//     for (
//       const order
//       of ordersResult.rows
//     ) {

//       const itemsResult =
//         await db.query(
//           `
//           SELECT
//             id,
//             order_id,
//             product_id,
//             item_name,
//             quantity,
//             amount,
//             unit,
//             price,
//             custom,
//             details,
//             image,

//             voice_url,

//             shopper_photo_url,
//             shopping_status,
//             found_quantity,
//             found_weight,
//             found_weight_unit,
//             barcode_scanned,
//             completed_at

//           FROM order_items

//           WHERE order_id = $1

//           ORDER BY id ASC
//           `,
//           [order.id]
//         );


//       const orderItems =
//         itemsResult.rows.map(
//           (item) => ({

//             id:
//               item.id,

//             orderId:
//               item.order_id,

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               item.quantity,

//             amount:
//               item.amount,

//             unit:
//               item.unit,

//             price:
//               item.price,

//             custom:
//               item.custom,

//             details:
//               item.details,

//             image:
//               item.image,

//             // -----------------------------------------
//             // CUSTOMER VOICE NOTE
//             // -----------------------------------------

//             voiceUrl:
//               item.voice_url || null,

//             shopperPhotoUrl:
//               item.shopper_photo_url || null,

//             shoppingStatus:
//               item.shopping_status || 'pending',

//             foundQuantity:
//               item.found_quantity,

//             foundWeight:
//               item.found_weight,

//             foundWeightUnit:
//               item.found_weight_unit,

//             barcodeScanned:
//               item.barcode_scanned || false,

//             completedAt:
//               item.completed_at,

//           })
//         );


//       orders.push({

//         id:
//           order.id,

//         customerId:
//           order.customer_id,

//         shopId:
//           order.shop_id,

//         shopperId:
//           order.shopper_id,


//         store:
//           order.shop_name,

//         storeName:
//           order.shop_name,

//         shop:
//           order.shop_name,


//         shopImage:
//           order.shop_image || null,


//         pickupLatitude:
//           order.shop_latitude !== null
//             ? Number(order.shop_latitude)
//             : null,

//         pickupLongitude:
//           order.shop_longitude !== null
//             ? Number(order.shop_longitude)
//             : null,


//         customer:
//           order.delivery_address,

//         customerName:
//           `Customer #${order.customer_id}`,

//         phone:
//           null,

//         customerPhone:
//           null,


//         customerLatitude:
//           Number(order.delivery_latitude),

//         customerLongitude:
//           Number(order.delivery_longitude),


//         latitude:
//           Number(order.delivery_latitude),

//         longitude:
//           Number(order.delivery_longitude),


//         deliveryAddress:
//           order.delivery_address,


//         deliveryOption:
//           order.delivery_option,

//         paymentMethod:
//           order.payment_method,


//         itemsTotal:
//           Number(order.items_total || 0),

//         deliveryFee:
//           Number(order.delivery_fee || 0),

//         serviceFee:
//           Number(order.service_fee || 0),

//         totalAmount:
//           Number(order.total_amount || 0),


//         status:
//           order.status,


//         createdAt:
//           order.created_at,

//         updatedAt:
//           order.updated_at,


//         paymentId:
//           order.payment_id || null,

//         paymentStatus:
//           order.payment_status || null,

//         paidAt:
//           order.paid_at || null,


//         billUrl:
//           order.bill_url || null,

//         billUploadedAt:
//           order.bill_uploaded_at || null,


//         deliveryPin:
//           order.delivery_pin || null,

//         arrivalConfirmedAt:
//           order.arrival_confirmed_at || null,

//         deliveredAt:
//           order.delivered_at || null,


//         items:
//           orderItems.length,

//         shoppingList:
//           orderItems,

//         orderItems:
//           orderItems,

//       });

//     }


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ getMyOrders error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY SHOPPERS FOR ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT
//           o.id,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.id = $1

//         LIMIT 1
//         `,
//         [orderId]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const latitude =
//       Number(order.shop_latitude);

//     const longitude =
//       Number(order.shop_longitude);


//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop coordinates are not available',

//       });

//     }


//     const shoppersResult =
//       await db.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status,

//           (
//             6371 * acos(
//               LEAST(
//                 1,
//                 GREATEST(
//                   -1,
//                   cos(radians($1))
//                   *
//                   cos(radians(latitude))
//                   *
//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )
//                   +
//                   sin(radians($1))
//                   *
//                   sin(radians(latitude))
//                 )
//               )
//             )
//           ) AS distance_km

//         FROM shoppers

//         WHERE
//           status = 'online'

//           AND latitude IS NOT NULL
//           AND longitude IS NOT NULL

//           AND id != $3

//         HAVING
//           (
//             6371 * acos(
//               LEAST(
//                 1,
//                 GREATEST(
//                   -1,
//                   cos(radians($1))
//                   *
//                   cos(radians(latitude))
//                   *
//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )
//                   +
//                   sin(radians($1))
//                   *
//                   sin(radians(latitude))
//                 )
//               )
//             )
//           ) <= 10

//         ORDER BY
//           distance_km ASC
//         `,
//         [
//           latitude,
//           longitude,
//           shopperId,
//         ]
//       );


//     return res.json({

//       success: true,

//       count:
//         shoppersResult.rows.length,

//       shoppers:
//         shoppersResult.rows.map(
//           (shopper) => ({

//             id:
//               shopper.id,

//             latitude:
//               Number(shopper.latitude),

//             longitude:
//               Number(shopper.longitude),

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 shopper.distance_km
//               ),

//           })
//         ),

//     });


//   } catch (error) {

//     console.error(
//       '❌ getNearbyShoppersForOrder error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD ITEM PHOTO
// // =====================================================

// const uploadItemPhoto = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const itemId =
//       Number(req.params.itemId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Photo is required',

//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ORDER
//     // -------------------------------------------------

//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders
//         WHERE
//           id = $1
//           AND shopper_id = $2
//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ITEM
//     // -------------------------------------------------

//     const itemResult =
//       await db.query(
//         `
//         SELECT id
//         FROM order_items
//         WHERE
//           id = $1
//           AND order_id = $2
//         LIMIT 1
//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (itemResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order item not found',
//       });

//     }


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


//     const foundQuantity =
//       req.body.foundQuantity !== undefined
//         ? Number(req.body.foundQuantity)
//         : null;


//     const foundWeight =
//       req.body.foundWeight !== undefined
//         ? Number(req.body.foundWeight)
//         : null;


//     const foundWeightUnit =
//       req.body.foundWeightUnit ||
//       null;


//     const barcodeScanned =
//       req.body.barcodeScanned === true ||
//       req.body.barcodeScanned === 'true';


//     const updateResult =
//       await db.query(
//         `
//         UPDATE order_items

//         SET
//           shopper_photo_url = $1,
//           shopping_status = 'done',

//           found_quantity = $2,
//           found_weight = $3,
//           found_weight_unit = $4,

//           barcode_scanned = $5,

//           completed_at = NOW()

//         WHERE
//           id = $6
//           AND order_id = $7

//         RETURNING *
//         `,
//         [
//           photoUrl,
//           foundQuantity,
//           foundWeight,
//           foundWeightUnit,
//           barcodeScanned,
//           itemId,
//           orderId,
//         ]
//       );


//     return res.json({

//       success: true,

//       item: {

//         id:
//           updateResult.rows[0].id,

//         orderId:
//           updateResult.rows[0].order_id,

//         name:
//           updateResult.rows[0].item_name,

//         image:
//           updateResult.rows[0].image,

//         voiceUrl:
//           updateResult.rows[0].voice_url || null,

//         shopperPhotoUrl:
//           updateResult.rows[0].shopper_photo_url,

//         shoppingStatus:
//           updateResult.rows[0].shopping_status,

//         foundQuantity:
//           updateResult.rows[0].found_quantity,

//         foundWeight:
//           updateResult.rows[0].found_weight,

//         foundWeightUnit:
//           updateResult.rows[0].found_weight_unit,

//         barcodeScanned:
//           updateResult.rows[0].barcode_scanned,

//         completedAt:
//           updateResult.rows[0].completed_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ uploadItemPhoto error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload item photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD REPLACEMENT PHOTO
// // =====================================================

// const uploadReplacementPhoto = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const itemId =
//       Number(req.params.itemId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Replacement photo is required',

//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ORDER
//     // -------------------------------------------------

//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ITEM
//     // -------------------------------------------------

//     const itemResult =
//       await db.query(
//         `
//         SELECT id
//         FROM order_items

//         WHERE
//           id = $1
//           AND order_id = $2

//         LIMIT 1
//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (itemResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order item not found',
//       });

//     }


//     // -------------------------------------------------
//     // NEXT OPTION NUMBER
//     // -------------------------------------------------

//     const optionResult =
//       await db.query(
//         `
//         SELECT
//           COALESCE(
//             MAX(option_number),
//             0
//           ) + 1 AS next_option

//         FROM replacement_items

//         WHERE
//           order_id = $1
//           AND original_item_id = $2
//         `,
//         [
//           orderId,
//           itemId,
//         ]
//       );


//     const optionNumber =
//       Number(
//         optionResult.rows[0]
//           .next_option
//       );


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/replacements/${req.file.filename}`;


//     const insertResult =
//       await db.query(
//         `
//         INSERT INTO replacement_items
//         (
//           order_id,
//           original_item_id,
//           shopper_id,
//           option_number,
//           photo_url,
//           status
//         )

//         VALUES
//         (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           'waiting_customer'
//         )

//         RETURNING *
//         `,
//         [
//           orderId,
//           itemId,
//           shopperId,
//           optionNumber,
//           photoUrl,
//         ]
//       );


//     const replacement =
//       insertResult.rows[0];


//     return res.json({

//       success: true,

//       replacement: {

//         id:
//           replacement.id,

//         orderId:
//           replacement.order_id,

//         originalItemId:
//           replacement.original_item_id,

//         shopperId:
//           replacement.shopper_id,

//         optionNumber:
//           replacement.option_number,

//         photoUrl:
//           replacement.photo_url,

//         status:
//           replacement.status,

//         createdAt:
//           replacement.created_at,

//         updatedAt:
//           replacement.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ uploadReplacementPhoto error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload replacement photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ITEM SHOPPING STATUS
// // =====================================================

// const updateItemShoppingStatus = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const itemId =
//       Number(req.params.itemId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const foundQuantity =
//       req.body.foundQuantity !== undefined
//         ? Number(req.body.foundQuantity)
//         : null;


//     const foundWeight =
//       req.body.foundWeight !== undefined
//         ? Number(req.body.foundWeight)
//         : null;


//     const foundWeightUnit =
//       req.body.foundWeightUnit ||
//       null;


//     const barcodeScanned =
//       req.body.barcodeScanned === true ||
//       req.body.barcodeScanned === 'true';


//     const result =
//       await db.query(
//         `
//         UPDATE order_items

//         SET
//           shopping_status = 'done',

//           found_quantity = $1,
//           found_weight = $2,
//           found_weight_unit = $3,

//           barcode_scanned = $4,

//           completed_at = NOW()

//         WHERE
//           id = $5
//           AND order_id = $6

//         RETURNING *
//         `,
//         [
//           foundQuantity,
//           foundWeight,
//           foundWeightUnit,
//           barcodeScanned,
//           itemId,
//           orderId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order item not found',
//       });

//     }


//     const item =
//       result.rows[0];


//     return res.json({

//       success: true,

//       item: {

//         id:
//           item.id,

//         orderId:
//           item.order_id,

//         name:
//           item.item_name,

//         quantity:
//           item.quantity,

//         image:
//           item.image,

//         voiceUrl:
//           item.voice_url || null,

//         shoppingStatus:
//           item.shopping_status,

//         foundQuantity:
//           item.found_quantity,

//         foundWeight:
//           item.found_weight,

//         foundWeightUnit:
//           item.found_weight_unit,

//         barcodeScanned:
//           item.barcode_scanned,

//         completedAt:
//           item.completed_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ updateItemShoppingStatus error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update item shopping status',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ORDER PAYMENT
// // =====================================================

// const updateOrderPayment = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const paymentId =
//       req.body.paymentId;


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!paymentId) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Payment ID is required',

//       });

//     }


//     const result =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           payment_id = $1,
//           payment_status = 'paid',
//           paid_at = NOW(),
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND shopper_id = $3

//         RETURNING
//           id,
//           payment_id,
//           payment_status,
//           paid_at,
//           updated_at
//         `,
//         [
//           paymentId,
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     return res.json({

//       success: true,

//       payment: {

//         paymentId:
//           order.payment_id,

//         paymentStatus:
//           order.payment_status,

//         paidAt:
//           order.paid_at,

//       },

//       order: {

//         id:
//           order.id,

//         paymentId:
//           order.payment_id,

//         paymentStatus:
//           order.payment_status,

//         paidAt:
//           order.paid_at,

//         updatedAt:
//           order.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ updateOrderPayment error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update payment',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD BILL
// // =====================================================

// const uploadBill = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Bill image is required',

//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const billUrl =
//       `${req.protocol}://${req.get('host')}/uploads/bills/${req.file.filename}`;


//     const result =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           bill_url = $1,
//           bill_uploaded_at = NOW(),
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND shopper_id = $3

//         RETURNING
//           id,
//           bill_url,
//           bill_uploaded_at,
//           updated_at
//         `,
//         [
//           billUrl,
//           orderId,
//           shopperId,
//         ]
//       );


//     const order =
//       result.rows[0];


//     return res.json({

//       success: true,

//       bill: {

//         billUrl:
//           order.bill_url,

//         billUploadedAt:
//           order.bill_uploaded_at,

//       },

//       order: {

//         id:
//           order.id,

//         billUrl:
//           order.bill_url,

//         billUploadedAt:
//           order.bill_uploaded_at,

//         updatedAt:
//           order.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ uploadBill error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload bill',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORTS
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   startShopping,

//   startDelivery,

//   confirmArrival,

//   verifyDeliveryPin,

//   getMyOrders,

//   getMyOrderById,

//   getNearbyShoppersForOrder,

//   uploadItemPhoto,

//   uploadReplacementPhoto,

//   updateItemShoppingStatus,

//   updateOrderPayment,

//   uploadBill,

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
// // GET AVAILABLE ORDERS
// // =====================================================

// const getAvailableOrders = async (req, res) => {
//   try {

//     const shopperId = getShopperId(req);

//     if (!shopperId) {
//       return res.status(401).json({
//         success: false,
//         message: 'Shopper authentication required',
//       });
//     }


//     // -------------------------------------------------
//     // GET SHOPPER LOCATION
//     // -------------------------------------------------

//     const shopperResult = await db.query(
//       `
//       SELECT
//         id,
//         latitude,
//         longitude,
//         status
//       FROM shoppers
//       WHERE id = $1
//       LIMIT 1
//       `,
//       [shopperId]
//     );


//     if (shopperResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shopper not found',
//       });
//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);

//     const shopperLongitude =
//       Number(shopper.longitude);


//     if (
//       !Number.isFinite(shopperLatitude) ||
//       !Number.isFinite(shopperLongitude)
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Shopper location is not available',
//       });

//     }


//     // -------------------------------------------------
//     // GET AVAILABLE ORDERS
//     // -------------------------------------------------

//     const ordersResult = await db.query(
//       `
//       SELECT
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
//         s.image_url AS shop_image,

//         s.latitude AS shop_latitude,
//         s.longitude AS shop_longitude,

//         (
//           6371 * acos(
//             LEAST(
//               1,
//               GREATEST(
//                 -1,
//                 cos(radians($1))
//                 *
//                 cos(radians(s.latitude))
//                 *
//                 cos(
//                   radians(s.longitude)
//                   -
//                   radians($2)
//                 )
//                 +
//                 sin(radians($1))
//                 *
//                 sin(radians(s.latitude))
//               )
//             )
//           )
//         ) AS shop_distance_km

//       FROM orders o

//       INNER JOIN shops s
//         ON s.id = o.shop_id

//       WHERE
//         o.status = 'waiting_for_shopper'
//         AND o.shopper_id IS NULL

//         AND s.status = 'approved'

//         AND s.latitude IS NOT NULL
//         AND s.longitude IS NOT NULL

//       ORDER BY
//         shop_distance_km ASC,
//         o.created_at ASC
//       `,
//       [
//         shopperLatitude,
//         shopperLongitude,
//       ]
//     );


//     // -------------------------------------------------
//     // FILTER WITHIN 10 KM
//     // -------------------------------------------------

//     const nearbyOrders =
//       ordersResult.rows.filter((order) => {

//         const distance =
//           Number(order.shop_distance_km);

//         return (
//           Number.isFinite(distance) &&
//           distance <= 10
//         );

//       });


//     // -------------------------------------------------
//     // BUILD ORDERS
//     // -------------------------------------------------

//     const orders = [];


//     for (const order of nearbyOrders) {

//       // -----------------------------------------------
//       // GET ORDER ITEMS
//       // -----------------------------------------------

//       const itemsResult =
//         await db.query(
//           `
//           SELECT
//             id,
//             order_id,
//             product_id,
//             item_name,
//             quantity,
//             amount,
//             unit,
//             price,
//             custom,
//             details,
//             image,

//             voice_url,

//             shopper_photo_url,
//             shopping_status,
//             found_quantity,
//             found_weight,
//             found_weight_unit,
//             barcode_scanned,
//             completed_at

//           FROM order_items

//           WHERE order_id = $1

//           ORDER BY id ASC
//           `,
//           [order.id]
//         );


//       const orderItems =
//         itemsResult.rows.map((item) => ({

//           id:
//             item.id,

//           orderId:
//             item.order_id,

//           productId:
//             item.product_id,

//           name:
//             item.item_name,

//           productName:
//             item.item_name,

//           quantity:
//             item.quantity,

//           amount:
//             item.amount,

//           unit:
//             item.unit,

//           price:
//             item.price,

//           custom:
//             item.custom,

//           details:
//             item.details,

//           image:
//             item.image,

//           // -------------------------------------------
//           // CUSTOMER VOICE NOTE
//           // -------------------------------------------

//           voiceUrl:
//             item.voice_url || null,

//           shopperPhotoUrl:
//             item.shopper_photo_url || null,

//           shoppingStatus:
//             item.shopping_status || 'pending',

//           foundQuantity:
//             item.found_quantity,

//           foundWeight:
//             item.found_weight,

//           foundWeightUnit:
//             item.found_weight_unit,

//           barcodeScanned:
//             item.barcode_scanned || false,

//           completedAt:
//             item.completed_at,

//         }));


//       // -----------------------------------------------
//       // ORDER OBJECT
//       // -----------------------------------------------

//       const distanceKm =
//         Number(order.shop_distance_km);


//       const orderObject = {

//         id:
//           order.id,

//         customerId:
//           order.customer_id,

//         shopId:
//           order.shop_id,


//         store:
//           order.shop_name,

//         storeName:
//           order.shop_name,

//         shop:
//           order.shop_name,


//         shopImage:
//           order.shop_image || null,


//         pickupLatitude:
//           Number(order.shop_latitude),

//         pickupLongitude:
//           Number(order.shop_longitude),


//         customer:
//           order.delivery_address,

//         customerName:
//           `Customer #${order.customer_id}`,

//         phone:
//           null,

//         customerPhone:
//           null,


//         customerLatitude:
//           Number(order.delivery_latitude),

//         customerLongitude:
//           Number(order.delivery_longitude),


//         latitude:
//           Number(order.delivery_latitude),

//         longitude:
//           Number(order.delivery_longitude),


//         deliveryAddress:
//           order.delivery_address,


//         itemsTotal:
//           Number(order.items_total || 0),

//         deliveryFee:
//           Number(order.delivery_fee || 0),

//         serviceFee:
//           Number(order.service_fee || 0),

//         totalAmount:
//           Number(order.total_amount || 0),


//         distance:
//           `${distanceKm.toFixed(2)} km`,

//         distanceKm:
//           distanceKm,


//         deliveryOption:
//           order.delivery_option,

//         paymentMethod:
//           order.payment_method,


//         status:
//           order.status,


//         createdAt:
//           order.created_at,

//         updatedAt:
//           order.updated_at,


//         items:
//           orderItems.length,


//         shoppingList:
//           orderItems,

//         orderItems:
//           orderItems,

//       };


//       orders.push(orderObject);

//     }


//     // =================================================
//     // GROUP MULTI-SHOP ORDERS
//     // =================================================
//     //
//     // IMPORTANT:
//     //
//     // Previously grouping was based only on:
//     // customer + latitude + longitude + address.
//     //
//     // That caused completely separate orders from the
//     // same customer/location to become ONE group.
//     //
//     // Example:
//     // Order 16 and Order 17
//     // same customer + same address
//     // => incorrectly became one card.
//     //
//     // Now the order creation time is also included.
//     // Orders created separately are therefore kept as
//     // separate shopper cards.
//     //
//     // Orders created as part of the same checkout within
//     // the same second can still remain grouped.
//     // =================================================

//     const groupedOrders = [];

//     const groups = new Map();


//     for (const order of orders) {

//       const latitude =
//         Number(order.customerLatitude)
//           .toFixed(5);

//       const longitude =
//         Number(order.customerLongitude)
//           .toFixed(5);

//       const address =
//         String(
//           order.customer || ''
//         )
//           .trim()
//           .toLowerCase();


//       // -------------------------------------------------
//       // USE ORDER CREATION SECOND
//       // -------------------------------------------------
//       //
//       // This prevents separate orders made later from
//       // the same customer/location being merged.
//       //
//       const createdAtSecond =
//         order.createdAt
//           ? new Date(order.createdAt)
//               .toISOString()
//               .slice(0, 19)
//           : `order-${order.id}`;


//       const groupKey =
//         `${order.customerId}_${latitude}_${longitude}_${address}_${createdAtSecond}`;


//       if (!groups.has(groupKey)) {

//         groups.set(
//           groupKey,
//           []
//         );

//       }


//       groups
//         .get(groupKey)
//         .push(order);

//     }


//     for (
//       const [
//         groupKey,
//         groupOrders
//       ] of groups
//     ) {

//       const shopNames =
//         groupOrders.map(
//           (order) =>
//             order.storeName
//         );


//       const shops =
//         groupOrders.map(
//           (order) => ({

//             shopId:
//               order.shopId,

//             shopName:
//               order.storeName,

//             shopImage:
//               order.shopImage,

//             pickupLatitude:
//               order.pickupLatitude,

//             pickupLongitude:
//               order.pickupLongitude,

//             distanceKm:
//               order.distanceKm,

//           })
//         );


//       // -------------------------------------------------
//       // STABLE GROUP ID
//       // -------------------------------------------------
//       //
//       // Do NOT use Date.now() here.
//       //
//       // Date.now() changes every time the shopper polls
//       // the endpoint, which can create a different group
//       // ID on every refresh.
//       //
//       const firstOrder =
//         groupOrders[0];


//       const orderGroupId =
//         `customer-${firstOrder.customerId}-${new Date(
//           firstOrder.createdAt
//         ).getTime()}-${firstOrder.id}`;


//       for (const order of groupOrders) {

//         order.orderGroupId =
//           orderGroupId;

//         order.batchId =
//           orderGroupId;

//         order.customerOrderId =
//           orderGroupId;

//         order.shopCount =
//           groupOrders.length;

//         order.shopNames =
//           shopNames;

//         order.shops =
//           shops;

//         order.batchOrders =
//           groupOrders.map(
//             (batchOrder) => ({

//               id:
//                 batchOrder.id,

//               shopId:
//                 batchOrder.shopId,

//               storeName:
//                 batchOrder.storeName,

//               shopImage:
//                 batchOrder.shopImage,

//               pickupLatitude:
//                 batchOrder.pickupLatitude,

//               pickupLongitude:
//                 batchOrder.pickupLongitude,

//               distanceKm:
//                 batchOrder.distanceKm,

//               status:
//                 batchOrder.status,

//               items:
//                 batchOrder.items,

//             })
//           );

//       }

//     }


//     // =================================================
//     // RESPONSE
//     // =================================================

//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ getAvailableOrders error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ORDER BY ID
// // =====================================================

// const getMyOrderById = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!Number.isInteger(orderId)) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Invalid order ID',
//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT
//           o.*,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.id = $1
//           AND o.shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // -------------------------------------------------
//     // ORDER ITEMS
//     // -------------------------------------------------

//     const itemsResult =
//       await db.query(
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

//           voice_url,

//           shopper_photo_url,
//           shopping_status,
//           found_quantity,
//           found_weight,
//           found_weight_unit,
//           barcode_scanned,
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC
//         `,
//         [orderId]
//       );


//     const orderItems =
//       itemsResult.rows.map(
//         (item) => ({

//           id:
//             item.id,

//           orderId:
//             item.order_id,

//           productId:
//             item.product_id,

//           name:
//             item.item_name,

//           productName:
//             item.item_name,

//           quantity:
//             item.quantity,

//           amount:
//             item.amount,

//           unit:
//             item.unit,

//           price:
//             item.price,

//           custom:
//             item.custom,

//           details:
//             item.details,

//           image:
//             item.image,

//           voiceUrl:
//             item.voice_url || null,

//           shopperPhotoUrl:
//             item.shopper_photo_url || null,

//           shoppingStatus:
//             item.shopping_status || 'pending',

//           foundQuantity:
//             item.found_quantity,

//           foundWeight:
//             item.found_weight,

//           foundWeightUnit:
//             item.found_weight_unit,

//           barcodeScanned:
//             item.barcode_scanned || false,

//           completedAt:
//             item.completed_at,

//         })
//       );


//     // -------------------------------------------------
//     // REPLACEMENTS
//     // -------------------------------------------------

//     let replacementItems = [];


//     try {

//       const replacementResult =
//         await db.query(
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

//           WHERE order_id = $1

//           ORDER BY
//             original_item_id ASC,
//             option_number ASC,
//             id ASC
//           `,
//           [orderId]
//         );


//       replacementItems =
//         replacementResult.rows.map(
//           (item) => ({

//             id:
//               item.id,

//             orderId:
//               item.order_id,

//             originalItemId:
//               item.original_item_id,

//             shopperId:
//               item.shopper_id,

//             optionNumber:
//               item.option_number,

//             photoUrl:
//               item.photo_url,

//             status:
//               item.status,

//             createdAt:
//               item.created_at,

//             updatedAt:
//               item.updated_at,

//           })
//         );

//     } catch (replacementError) {

//       console.error(
//         '⚠️ Replacement items query failed:',
//         replacementError.message
//       );

//       replacementItems = [];

//     }


//     // -------------------------------------------------
//     // RESPONSE ORDER
//     // -------------------------------------------------

//     const responseOrder = {

//       id:
//         order.id,

//       customerId:
//         order.customer_id,

//       shopId:
//         order.shop_id,

//       shopperId:
//         order.shopper_id,


//       store:
//         order.shop_name,

//       storeName:
//         order.shop_name,

//       shop:
//         order.shop_name,


//       shopImage:
//         order.shop_image || null,


//       pickupLatitude:
//         order.shop_latitude !== null
//           ? Number(order.shop_latitude)
//           : null,

//       pickupLongitude:
//         order.shop_longitude !== null
//           ? Number(order.shop_longitude)
//           : null,


//       customer:
//         order.delivery_address,

//       customerName:
//         `Customer #${order.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(order.delivery_latitude),

//       customerLongitude:
//         Number(order.delivery_longitude),


//       latitude:
//         Number(order.delivery_latitude),

//       longitude:
//         Number(order.delivery_longitude),


//       deliveryAddress:
//         order.delivery_address,


//       deliveryOption:
//         order.delivery_option,

//       paymentMethod:
//         order.payment_method,


//       itemsTotal:
//         Number(order.items_total || 0),

//       deliveryFee:
//         Number(order.delivery_fee || 0),

//       serviceFee:
//         Number(order.service_fee || 0),

//       totalAmount:
//         Number(order.total_amount || 0),


//       status:
//         order.status,


//       createdAt:
//         order.created_at,

//       updatedAt:
//         order.updated_at,


//       paymentId:
//         order.payment_id || null,

//       paymentStatus:
//         order.payment_status || null,

//       paidAt:
//         order.paid_at || null,


//       billUrl:
//         order.bill_url || null,

//       billUploadedAt:
//         order.bill_uploaded_at || null,


//       deliveryPin:
//         order.delivery_pin || null,

//       arrivalConfirmedAt:
//         order.arrival_confirmed_at || null,

//       deliveredAt:
//         order.delivered_at || null,


//       items:
//         orderItems.length,

//       shoppingList:
//         orderItems,

//       orderItems:
//         orderItems,


//       replacementItems:
//         replacementItems,

//       replacements:
//         replacementItems,

//     };


//     return res.json({

//       success: true,

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     console.error(
//       '❌ getMyOrderById error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get order',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (
//   req,
//   res
// ) => {

//   const client =
//     await db.connect();

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!Number.isInteger(orderId)) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Invalid order ID',
//       });

//     }


//     await client.query(
//       'BEGIN'
//     );


//     const existingResult =
//       await client.query(
//         `
//         SELECT *
//         FROM orders
//         WHERE id = $1
//         FOR UPDATE
//         `,
//         [orderId]
//       );


//     if (
//       existingResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const existingOrder =
//       existingResult.rows[0];


//     if (
//       existingOrder.status !==
//         'waiting_for_shopper' ||
//       existingOrder.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );

//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//       });

//     }


//     // -------------------------------------------------
//     // ACCEPT
//     // -------------------------------------------------

//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET
//           shopper_id = $1,
//           status = 'shopper_accepted',
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND status = 'waiting_for_shopper'
//           AND shopper_id IS NULL

//         RETURNING *
//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order was already accepted',

//       });

//     }


//     const acceptedOrder =
//       updateResult.rows[0];


//     // -------------------------------------------------
//     // SHOP
//     // -------------------------------------------------

//     const shopResult =
//       await client.query(
//         `
//         SELECT
//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude

//         FROM shops

//         WHERE id = $1

//         LIMIT 1
//         `,
//         [acceptedOrder.shop_id]
//       );


//     const shop =
//       shopResult.rows[0] || null;


//     // -------------------------------------------------
//     // ITEMS
//     // -------------------------------------------------

//     const itemsResult =
//       await client.query(
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

//           voice_url,

//           shopper_photo_url,
//           shopping_status,
//           found_quantity,
//           found_weight,
//           found_weight_unit,
//           barcode_scanned,
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC
//         `,
//         [orderId]
//       );


//     const orderItems =
//       itemsResult.rows.map(
//         (item) => ({

//           id:
//             item.id,

//           orderId:
//             item.order_id,

//           productId:
//             item.product_id,

//           name:
//             item.item_name,

//           productName:
//             item.item_name,

//           quantity:
//             item.quantity,

//           amount:
//             item.amount,

//           unit:
//             item.unit,

//           price:
//             item.price,

//           custom:
//             item.custom,

//           details:
//             item.details,

//           image:
//             item.image,

//           voiceUrl:
//             item.voice_url || null,

//           shopperPhotoUrl:
//             item.shopper_photo_url || null,

//           shoppingStatus:
//             item.shopping_status || 'pending',

//           foundQuantity:
//             item.found_quantity,

//           foundWeight:
//             item.found_weight,

//           foundWeightUnit:
//             item.found_weight_unit,

//           barcodeScanned:
//             item.barcode_scanned || false,

//           completedAt:
//             item.completed_at,

//         })
//       );


//     await client.query(
//       'COMMIT'
//     );


//     return res.json({

//       success: true,

//       order: {

//         id:
//           acceptedOrder.id,

//         customerId:
//           acceptedOrder.customer_id,

//         shopId:
//           acceptedOrder.shop_id,

//         shopperId:
//           acceptedOrder.shopper_id,


//         store:
//           shop?.shop_name || null,

//         storeName:
//           shop?.shop_name || null,

//         shop:
//           shop?.shop_name || null,


//         shopImage:
//           shop?.image_url || null,


//         pickupLatitude:
//           shop?.latitude !== null &&
//           shop?.latitude !== undefined
//             ? Number(shop.latitude)
//             : null,

//         pickupLongitude:
//           shop?.longitude !== null &&
//           shop?.longitude !== undefined
//             ? Number(shop.longitude)
//             : null,


//         customer:
//           acceptedOrder.delivery_address,

//         customerName:
//           `Customer #${acceptedOrder.customer_id}`,

//         phone:
//           null,

//         customerPhone:
//           null,


//         customerLatitude:
//           Number(
//             acceptedOrder.delivery_latitude
//           ),

//         customerLongitude:
//           Number(
//             acceptedOrder.delivery_longitude
//           ),


//         latitude:
//           Number(
//             acceptedOrder.delivery_latitude
//           ),

//         longitude:
//           Number(
//             acceptedOrder.delivery_longitude
//           ),


//         deliveryAddress:
//           acceptedOrder.delivery_address,


//         deliveryOption:
//           acceptedOrder.delivery_option,

//         paymentMethod:
//           acceptedOrder.payment_method,


//         itemsTotal:
//           Number(
//             acceptedOrder.items_total || 0
//           ),

//         deliveryFee:
//           Number(
//             acceptedOrder.delivery_fee || 0
//           ),

//         serviceFee:
//           Number(
//             acceptedOrder.service_fee || 0
//           ),

//         totalAmount:
//           Number(
//             acceptedOrder.total_amount || 0
//           ),


//         status:
//           acceptedOrder.status,


//         createdAt:
//           acceptedOrder.created_at,

//         updatedAt:
//           acceptedOrder.updated_at,


//         items:
//           orderItems.length,

//         shoppingList:
//           orderItems,

//         orderItems:
//           orderItems,

//       },

//     });


//   } catch (error) {

//     try {
//       await client.query(
//         'ROLLBACK'
//       );
//     } catch (_) {}


//     console.error(
//       '❌ acceptOrder error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });

//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // START SHOPPING
// // =====================================================

// const startShopping = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status === 'shopping'
//     ) {

//       return res.json({

//         success: true,

//         order: {

//           id:
//             order.id,

//           customerId:
//             order.customer_id,

//           shopId:
//             order.shop_id,

//           shopperId:
//             order.shopper_id,

//           status:
//             order.status,

//         },

//       });

//     }


//     if (
//       order.status !==
//         'shopper_accepted'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot start shopping while order status is ${order.status}`,

//       });

//     }


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           status = 'shopping',
//           updated_at = NOW()

//         WHERE
//           id = $1
//           AND shopper_id = $2
//           AND status = 'shopper_accepted'

//         RETURNING
//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status,
//           updated_at
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     return res.json({

//       success: true,

//       order: {

//         id:
//           updateResult.rows[0].id,

//         customerId:
//           updateResult.rows[0].customer_id,

//         shopId:
//           updateResult.rows[0].shop_id,

//         shopperId:
//           updateResult.rows[0].shopper_id,

//         status:
//           updateResult.rows[0].status,

//         updatedAt:
//           updateResult.rows[0].updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ startShopping error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start shopping',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // START DELIVERY
// // =====================================================

// const startDelivery = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           shopper_id,
//           status,
//           bill_url

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status ===
//         'out_for_delivery'
//     ) {

//       return res.json({

//         success: true,

//         order: {

//           id:
//             order.id,

//           shopperId:
//             order.shopper_id,

//           status:
//             order.status,

//         },

//       });

//     }


//     if (
//       order.status !== 'shopping'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot start delivery while order status is ${order.status}`,

//       });

//     }


//     if (!order.bill_url) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Supermarket bill is required before starting delivery',

//       });

//     }


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           status = 'out_for_delivery',
//           updated_at = NOW()

//         WHERE
//           id = $1
//           AND shopper_id = $2
//           AND status = 'shopping'

//         RETURNING
//           id,
//           shopper_id,
//           status,
//           updated_at
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     return res.json({

//       success: true,

//       order: {

//         id:
//           updateResult.rows[0].id,

//         shopperId:
//           updateResult.rows[0].shopper_id,

//         status:
//           updateResult.rows[0].status,

//         updatedAt:
//           updateResult.rows[0].updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ startDelivery error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start delivery',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // CONFIRM ARRIVAL
// // =====================================================

// const confirmArrival = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           shopper_id,
//           status,
//           delivery_pin

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status === 'arrived' &&
//       order.delivery_pin
//     ) {

//       return res.json({

//         success: true,

//         deliveryPin:
//           order.delivery_pin,

//         order: {

//           id:
//             order.id,

//           shopperId:
//             order.shopper_id,

//           status:
//             order.status,

//           deliveryPin:
//             order.delivery_pin,

//         },

//       });

//     }


//     if (
//       order.status !==
//         'out_for_delivery'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot confirm arrival while order status is ${order.status}`,

//       });

//     }


//     // -------------------------------------------------
//     // GENERATE 6 DIGIT PIN
//     // -------------------------------------------------

//     const deliveryPin =
//       Math.floor(
//         100000 +
//         Math.random() * 900000
//       ).toString();


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           delivery_pin = $1,
//           arrival_confirmed_at = NOW(),
//           status = 'arrived',
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND shopper_id = $3
//           AND status = 'out_for_delivery'

//         RETURNING
//           id,
//           shopper_id,
//           status,
//           delivery_pin,
//           arrival_confirmed_at,
//           updated_at
//         `,
//         [
//           deliveryPin,
//           orderId,
//           shopperId,
//         ]
//       );


//     const updatedOrder =
//       updateResult.rows[0];


//     return res.json({

//       success: true,

//       deliveryPin:
//         updatedOrder.delivery_pin,

//       order: {

//         id:
//           updatedOrder.id,

//         shopperId:
//           updatedOrder.shopper_id,

//         status:
//           updatedOrder.status,

//         deliveryPin:
//           updatedOrder.delivery_pin,

//         arrivalConfirmedAt:
//           updatedOrder.arrival_confirmed_at,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ confirmArrival error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to confirm arrival',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // VERIFY DELIVERY PIN
// // =====================================================

// const verifyDeliveryPin = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const pin =
//       String(
//         req.body.pin ||
//         req.body.deliveryPin ||
//         ''
//       ).trim();


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (
//       !/^\d{6}$/.test(pin)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'A valid 6-digit delivery PIN is required',

//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           shopper_id,
//           status,
//           delivery_pin

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status !== 'arrived'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot verify delivery PIN while order status is ${order.status}`,

//       });

//     }


//     if (
//       String(order.delivery_pin) !==
//       pin
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid delivery PIN',

//       });

//     }


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           status = 'delivered',
//           delivered_at = NOW(),
//           updated_at = NOW()

//         WHERE
//           id = $1
//           AND shopper_id = $2
//           AND status = 'arrived'
//           AND delivery_pin = $3

//         RETURNING
//           id,
//           shopper_id,
//           status,
//           delivered_at,
//           updated_at
//         `,
//         [
//           orderId,
//           shopperId,
//           pin,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Delivery could not be completed',

//       });

//     }


//     const completedOrder =
//       updateResult.rows[0];


//     return res.json({

//       success: true,

//       verified: true,

//       order: {

//         id:
//           completedOrder.id,

//         shopperId:
//           completedOrder.shopper_id,

//         status:
//           completedOrder.status,

//         deliveredAt:
//           completedOrder.delivered_at,

//         updatedAt:
//           completedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ verifyDeliveryPin error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to verify delivery PIN',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ORDERS
// // =====================================================

// const getMyOrders = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const ordersResult =
//       await db.query(
//         `
//         SELECT
//           o.*,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC
//         `,
//         [shopperId]
//       );


//     const orders = [];


//     for (
//       const order
//       of ordersResult.rows
//     ) {

//       const itemsResult =
//         await db.query(
//           `
//           SELECT
//             id,
//             order_id,
//             product_id,
//             item_name,
//             quantity,
//             amount,
//             unit,
//             price,
//             custom,
//             details,
//             image,

//             voice_url,

//             shopper_photo_url,
//             shopping_status,
//             found_quantity,
//             found_weight,
//             found_weight_unit,
//             barcode_scanned,
//             completed_at

//           FROM order_items

//           WHERE order_id = $1

//           ORDER BY id ASC
//           `,
//           [order.id]
//         );


//       const orderItems =
//         itemsResult.rows.map(
//           (item) => ({

//             id:
//               item.id,

//             orderId:
//               item.order_id,

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               item.quantity,

//             amount:
//               item.amount,

//             unit:
//               item.unit,

//             price:
//               item.price,

//             custom:
//               item.custom,

//             details:
//               item.details,

//             image:
//               item.image,

//             // -----------------------------------------
//             // CUSTOMER VOICE NOTE
//             // -----------------------------------------

//             voiceUrl:
//               item.voice_url || null,

//             shopperPhotoUrl:
//               item.shopper_photo_url || null,

//             shoppingStatus:
//               item.shopping_status || 'pending',

//             foundQuantity:
//               item.found_quantity,

//             foundWeight:
//               item.found_weight,

//             foundWeightUnit:
//               item.found_weight_unit,

//             barcodeScanned:
//               item.barcode_scanned || false,

//             completedAt:
//               item.completed_at,

//           })
//         );


//       orders.push({

//         id:
//           order.id,

//         customerId:
//           order.customer_id,

//         shopId:
//           order.shop_id,

//         shopperId:
//           order.shopper_id,


//         store:
//           order.shop_name,

//         storeName:
//           order.shop_name,

//         shop:
//           order.shop_name,


//         shopImage:
//           order.shop_image || null,


//         pickupLatitude:
//           order.shop_latitude !== null
//             ? Number(order.shop_latitude)
//             : null,

//         pickupLongitude:
//           order.shop_longitude !== null
//             ? Number(order.shop_longitude)
//             : null,


//         customer:
//           order.delivery_address,

//         customerName:
//           `Customer #${order.customer_id}`,

//         phone:
//           null,

//         customerPhone:
//           null,


//         customerLatitude:
//           Number(order.delivery_latitude),

//         customerLongitude:
//           Number(order.delivery_longitude),


//         latitude:
//           Number(order.delivery_latitude),

//         longitude:
//           Number(order.delivery_longitude),


//         deliveryAddress:
//           order.delivery_address,


//         deliveryOption:
//           order.delivery_option,

//         paymentMethod:
//           order.payment_method,


//         itemsTotal:
//           Number(order.items_total || 0),

//         deliveryFee:
//           Number(order.delivery_fee || 0),

//         serviceFee:
//           Number(order.service_fee || 0),

//         totalAmount:
//           Number(order.total_amount || 0),


//         status:
//           order.status,


//         createdAt:
//           order.created_at,

//         updatedAt:
//           order.updated_at,


//         paymentId:
//           order.payment_id || null,

//         paymentStatus:
//           order.payment_status || null,

//         paidAt:
//           order.paid_at || null,


//         billUrl:
//           order.bill_url || null,

//         billUploadedAt:
//           order.bill_uploaded_at || null,


//         deliveryPin:
//           order.delivery_pin || null,

//         arrivalConfirmedAt:
//           order.arrival_confirmed_at || null,

//         deliveredAt:
//           order.delivered_at || null,


//         items:
//           orderItems.length,

//         shoppingList:
//           orderItems,

//         orderItems:
//           orderItems,

//       });

//     }


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ getMyOrders error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY SHOPPERS FOR ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT
//           o.id,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.id = $1

//         LIMIT 1
//         `,
//         [orderId]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const latitude =
//       Number(order.shop_latitude);

//     const longitude =
//       Number(order.shop_longitude);


//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop coordinates are not available',

//       });

//     }


//     const shoppersResult =
//       await db.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status,

//           (
//             6371 * acos(
//               LEAST(
//                 1,
//                 GREATEST(
//                   -1,
//                   cos(radians($1))
//                   *
//                   cos(radians(latitude))
//                   *
//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )
//                   +
//                   sin(radians($1))
//                   *
//                   sin(radians(latitude))
//                 )
//               )
//             )
//           ) AS distance_km

//         FROM shoppers

//         WHERE
//           status = 'online'

//           AND latitude IS NOT NULL
//           AND longitude IS NOT NULL

//           AND id != $3

//         HAVING
//           (
//             6371 * acos(
//               LEAST(
//                 1,
//                 GREATEST(
//                   -1,
//                   cos(radians($1))
//                   *
//                   cos(radians(latitude))
//                   *
//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )
//                   +
//                   sin(radians($1))
//                   *
//                   sin(radians(latitude))
//                 )
//               )
//             )
//           ) <= 10

//         ORDER BY
//           distance_km ASC
//         `,
//         [
//           latitude,
//           longitude,
//           shopperId,
//         ]
//       );


//     return res.json({

//       success: true,

//       count:
//         shoppersResult.rows.length,

//       shoppers:
//         shoppersResult.rows.map(
//           (shopper) => ({

//             id:
//               shopper.id,

//             latitude:
//               Number(shopper.latitude),

//             longitude:
//               Number(shopper.longitude),

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 shopper.distance_km
//               ),

//           })
//         ),

//     });


//   } catch (error) {

//     console.error(
//       '❌ getNearbyShoppersForOrder error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD ITEM PHOTO
// // =====================================================

// const uploadItemPhoto = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const itemId =
//       Number(req.params.itemId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Photo is required',

//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ORDER
//     // -------------------------------------------------

//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders
//         WHERE
//           id = $1
//           AND shopper_id = $2
//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ITEM
//     // -------------------------------------------------

//     const itemResult =
//       await db.query(
//         `
//         SELECT id
//         FROM order_items
//         WHERE
//           id = $1
//           AND order_id = $2
//         LIMIT 1
//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (itemResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order item not found',
//       });

//     }


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


//     const foundQuantity =
//       req.body.foundQuantity !== undefined
//         ? Number(req.body.foundQuantity)
//         : null;


//     const foundWeight =
//       req.body.foundWeight !== undefined
//         ? Number(req.body.foundWeight)
//         : null;


//     const foundWeightUnit =
//       req.body.foundWeightUnit ||
//       null;


//     const barcodeScanned =
//       req.body.barcodeScanned === true ||
//       req.body.barcodeScanned === 'true';


//     const updateResult =
//       await db.query(
//         `
//         UPDATE order_items

//         SET
//           shopper_photo_url = $1,
//           shopping_status = 'done',

//           found_quantity = $2,
//           found_weight = $3,
//           found_weight_unit = $4,

//           barcode_scanned = $5,

//           completed_at = NOW()

//         WHERE
//           id = $6
//           AND order_id = $7

//         RETURNING *
//         `,
//         [
//           photoUrl,
//           foundQuantity,
//           foundWeight,
//           foundWeightUnit,
//           barcodeScanned,
//           itemId,
//           orderId,
//         ]
//       );


//     return res.json({

//       success: true,

//       item: {

//         id:
//           updateResult.rows[0].id,

//         orderId:
//           updateResult.rows[0].order_id,

//         name:
//           updateResult.rows[0].item_name,

//         image:
//           updateResult.rows[0].image,

//         voiceUrl:
//           updateResult.rows[0].voice_url || null,

//         shopperPhotoUrl:
//           updateResult.rows[0].shopper_photo_url,

//         shoppingStatus:
//           updateResult.rows[0].shopping_status,

//         foundQuantity:
//           updateResult.rows[0].found_quantity,

//         foundWeight:
//           updateResult.rows[0].found_weight,

//         foundWeightUnit:
//           updateResult.rows[0].found_weight_unit,

//         barcodeScanned:
//           updateResult.rows[0].barcode_scanned,

//         completedAt:
//           updateResult.rows[0].completed_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ uploadItemPhoto error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload item photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD REPLACEMENT PHOTO
// // =====================================================

// const uploadReplacementPhoto = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const itemId =
//       Number(req.params.itemId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Replacement photo is required',

//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ORDER
//     // -------------------------------------------------

//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ITEM
//     // -------------------------------------------------

//     const itemResult =
//       await db.query(
//         `
//         SELECT id
//         FROM order_items

//         WHERE
//           id = $1
//           AND order_id = $2

//         LIMIT 1
//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (itemResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order item not found',
//       });

//     }


//     // -------------------------------------------------
//     // NEXT OPTION NUMBER
//     // -------------------------------------------------

//     const optionResult =
//       await db.query(
//         `
//         SELECT
//           COALESCE(
//             MAX(option_number),
//             0
//           ) + 1 AS next_option

//         FROM replacement_items

//         WHERE
//           order_id = $1
//           AND original_item_id = $2
//         `,
//         [
//           orderId,
//           itemId,
//         ]
//       );


//     const optionNumber =
//       Number(
//         optionResult.rows[0]
//           .next_option
//       );


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/replacements/${req.file.filename}`;


//     const insertResult =
//       await db.query(
//         `
//         INSERT INTO replacement_items
//         (
//           order_id,
//           original_item_id,
//           shopper_id,
//           option_number,
//           photo_url,
//           status
//         )

//         VALUES
//         (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           'waiting_customer'
//         )

//         RETURNING *
//         `,
//         [
//           orderId,
//           itemId,
//           shopperId,
//           optionNumber,
//           photoUrl,
//         ]
//       );


//     const replacement =
//       insertResult.rows[0];


//     return res.json({

//       success: true,

//       replacement: {

//         id:
//           replacement.id,

//         orderId:
//           replacement.order_id,

//         originalItemId:
//           replacement.original_item_id,

//         shopperId:
//           replacement.shopper_id,

//         optionNumber:
//           replacement.option_number,

//         photoUrl:
//           replacement.photo_url,

//         status:
//           replacement.status,

//         createdAt:
//           replacement.created_at,

//         updatedAt:
//           replacement.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ uploadReplacementPhoto error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload replacement photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ITEM SHOPPING STATUS
// // =====================================================

// const updateItemShoppingStatus = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const itemId =
//       Number(req.params.itemId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const foundQuantity =
//       req.body.foundQuantity !== undefined
//         ? Number(req.body.foundQuantity)
//         : null;


//     const foundWeight =
//       req.body.foundWeight !== undefined
//         ? Number(req.body.foundWeight)
//         : null;


//     const foundWeightUnit =
//       req.body.foundWeightUnit ||
//       null;


//     const barcodeScanned =
//       req.body.barcodeScanned === true ||
//       req.body.barcodeScanned === 'true';


//     const result =
//       await db.query(
//         `
//         UPDATE order_items

//         SET
//           shopping_status = 'done',

//           found_quantity = $1,
//           found_weight = $2,
//           found_weight_unit = $3,

//           barcode_scanned = $4,

//           completed_at = NOW()

//         WHERE
//           id = $5
//           AND order_id = $6

//         RETURNING *
//         `,
//         [
//           foundQuantity,
//           foundWeight,
//           foundWeightUnit,
//           barcodeScanned,
//           itemId,
//           orderId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order item not found',
//       });

//     }


//     const item =
//       result.rows[0];


//     return res.json({

//       success: true,

//       item: {

//         id:
//           item.id,

//         orderId:
//           item.order_id,

//         name:
//           item.item_name,

//         quantity:
//           item.quantity,

//         image:
//           item.image,

//         voiceUrl:
//           item.voice_url || null,

//         shoppingStatus:
//           item.shopping_status,

//         foundQuantity:
//           item.found_quantity,

//         foundWeight:
//           item.found_weight,

//         foundWeightUnit:
//           item.found_weight_unit,

//         barcodeScanned:
//           item.barcode_scanned,

//         completedAt:
//           item.completed_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ updateItemShoppingStatus error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update item shopping status',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ORDER PAYMENT
// // =====================================================

// const updateOrderPayment = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const paymentId =
//       req.body.paymentId;


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!paymentId) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Payment ID is required',

//       });

//     }


//     const result =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           payment_id = $1,
//           payment_status = 'paid',
//           paid_at = NOW(),
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND shopper_id = $3

//         RETURNING
//           id,
//           payment_id,
//           payment_status,
//           paid_at,
//           updated_at
//         `,
//         [
//           paymentId,
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     return res.json({

//       success: true,

//       payment: {

//         paymentId:
//           order.payment_id,

//         paymentStatus:
//           order.payment_status,

//         paidAt:
//           order.paid_at,

//       },

//       order: {

//         id:
//           order.id,

//         paymentId:
//           order.payment_id,

//         paymentStatus:
//           order.payment_status,

//         paidAt:
//           order.paid_at,

//         updatedAt:
//           order.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ updateOrderPayment error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update payment',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD BILL
// // =====================================================

// const uploadBill = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Bill image is required',

//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const billUrl =
//       `${req.protocol}://${req.get('host')}/uploads/bills/${req.file.filename}`;


//     const result =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           bill_url = $1,
//           bill_uploaded_at = NOW(),
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND shopper_id = $3

//         RETURNING
//           id,
//           bill_url,
//           bill_uploaded_at,
//           updated_at
//         `,
//         [
//           billUrl,
//           orderId,
//           shopperId,
//         ]
//       );


//     const order =
//       result.rows[0];


//     return res.json({

//       success: true,

//       bill: {

//         billUrl:
//           order.bill_url,

//         billUploadedAt:
//           order.bill_uploaded_at,

//       },

//       order: {

//         id:
//           order.id,

//         billUrl:
//           order.bill_url,

//         billUploadedAt:
//           order.bill_uploaded_at,

//         updatedAt:
//           order.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ uploadBill error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload bill',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORTS
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   startShopping,

//   startDelivery,

//   confirmArrival,

//   verifyDeliveryPin,

//   getMyOrders,

//   getMyOrderById,

//   getNearbyShoppersForOrder,

//   uploadItemPhoto,

//   uploadReplacementPhoto,

//   updateItemShoppingStatus,

//   updateOrderPayment,

//   uploadBill,

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
// // GET AVAILABLE ORDERS
// // =====================================================

// const getAvailableOrders = async (req, res) => {
//   try {

//     const shopperId = getShopperId(req);

//     if (!shopperId) {
//       return res.status(401).json({
//         success: false,
//         message: 'Shopper authentication required',
//       });
//     }


//     // -------------------------------------------------
//     // GET SHOPPER LOCATION
//     // -------------------------------------------------

//     const shopperResult = await db.query(
//       `
//       SELECT
//         id,
//         latitude,
//         longitude,
//         status
//       FROM shoppers
//       WHERE id = $1
//       LIMIT 1
//       `,
//       [shopperId]
//     );


//     if (shopperResult.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shopper not found',
//       });
//     }


//     const shopper =
//       shopperResult.rows[0];


//     const shopperLatitude =
//       Number(shopper.latitude);

//     const shopperLongitude =
//       Number(shopper.longitude);


//     if (
//       !Number.isFinite(shopperLatitude) ||
//       !Number.isFinite(shopperLongitude)
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Shopper location is not available',
//       });

//     }


//     // -------------------------------------------------
//     // GET AVAILABLE ORDERS
//     // -------------------------------------------------

//     const ordersResult = await db.query(
//       `
//       SELECT
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
//         s.image_url AS shop_image,

//         s.latitude AS shop_latitude,
//         s.longitude AS shop_longitude,

//         (
//           6371 * acos(
//             LEAST(
//               1,
//               GREATEST(
//                 -1,
//                 cos(radians($1))
//                 *
//                 cos(radians(s.latitude))
//                 *
//                 cos(
//                   radians(s.longitude)
//                   -
//                   radians($2)
//                 )
//                 +
//                 sin(radians($1))
//                 *
//                 sin(radians(s.latitude))
//               )
//             )
//           )
//         ) AS shop_distance_km

//       FROM orders o

//       INNER JOIN shops s
//         ON s.id = o.shop_id

//       WHERE
//         o.status = 'waiting_for_shopper'
//         AND o.shopper_id IS NULL

//         AND s.status = 'approved'

//         AND s.latitude IS NOT NULL
//         AND s.longitude IS NOT NULL

//       ORDER BY
//         shop_distance_km ASC,
//         o.created_at ASC
//       `,
//       [
//         shopperLatitude,
//         shopperLongitude,
//       ]
//     );


//     // -------------------------------------------------
//     // FILTER WITHIN 10 KM
//     // -------------------------------------------------

//     const nearbyOrders =
//       ordersResult.rows.filter((order) => {

//         const distance =
//           Number(order.shop_distance_km);

//         return (
//           Number.isFinite(distance) &&
//           distance <= 10
//         );

//       });


//     // -------------------------------------------------
//     // BUILD ORDERS
//     // -------------------------------------------------

//     const orders = [];


//     for (const order of nearbyOrders) {

//       // -----------------------------------------------
//       // GET ORDER ITEMS
//       // -----------------------------------------------

//       const itemsResult =
//         await db.query(
//           `
//           SELECT
//             id,
//             order_id,
//             product_id,
//             item_name,
//             quantity,
//             amount,
//             unit,
//             price,
//             custom,
//             details,
//             image,

//             voice_url,

//             shopper_photo_url,
//             shopping_status,
//             found_quantity,
//             found_weight,
//             found_weight_unit,
//             barcode_scanned,
//             completed_at

//           FROM order_items

//           WHERE order_id = $1

//           ORDER BY id ASC
//           `,
//           [order.id]
//         );


//       const orderItems =
//         itemsResult.rows.map((item) => ({

//           id:
//             item.id,

//           orderId:
//             item.order_id,

//           productId:
//             item.product_id,

//           name:
//             item.item_name,

//           productName:
//             item.item_name,

//           quantity:
//             item.quantity,

//           amount:
//             item.amount,

//           unit:
//             item.unit,

//           price:
//             item.price,

//           custom:
//             item.custom,

//           details:
//             item.details,

//           image:
//             item.image,

//           // -------------------------------------------
//           // CUSTOMER VOICE NOTE
//           // -------------------------------------------

//           voiceUrl:
//             item.voice_url || null,

//           shopperPhotoUrl:
//             item.shopper_photo_url || null,

//           shoppingStatus:
//             item.shopping_status || 'pending',

//           foundQuantity:
//             item.found_quantity,

//           foundWeight:
//             item.found_weight,

//           foundWeightUnit:
//             item.found_weight_unit,

//           barcodeScanned:
//             item.barcode_scanned || false,

//           completedAt:
//             item.completed_at,

//         }));


//       // -----------------------------------------------
//       // ORDER OBJECT
//       // -----------------------------------------------

//       const distanceKm =
//         Number(order.shop_distance_km);


//       const orderObject = {

//         id:
//           order.id,

//         customerId:
//           order.customer_id,

//         shopId:
//           order.shop_id,


//         store:
//           order.shop_name,

//         storeName:
//           order.shop_name,

//         shop:
//           order.shop_name,


//         shopImage:
//           order.shop_image || null,


//         pickupLatitude:
//           Number(order.shop_latitude),

//         pickupLongitude:
//           Number(order.shop_longitude),


//         customer:
//           order.delivery_address,

//         customerName:
//           `Customer #${order.customer_id}`,

//         phone:
//           null,

//         customerPhone:
//           null,


//         customerLatitude:
//           Number(order.delivery_latitude),

//         customerLongitude:
//           Number(order.delivery_longitude),


//         latitude:
//           Number(order.delivery_latitude),

//         longitude:
//           Number(order.delivery_longitude),


//         deliveryAddress:
//           order.delivery_address,


//         itemsTotal:
//           Number(order.items_total || 0),

//         deliveryFee:
//           Number(order.delivery_fee || 0),

//         serviceFee:
//           Number(order.service_fee || 0),

//         totalAmount:
//           Number(order.total_amount || 0),


//         distance:
//           `${distanceKm.toFixed(2)} km`,

//         distanceKm:
//           distanceKm,


//         deliveryOption:
//           order.delivery_option,

//         paymentMethod:
//           order.payment_method,


//         status:
//           order.status,


//         createdAt:
//           order.created_at,

//         updatedAt:
//           order.updated_at,


//         items:
//           orderItems.length,


//         shoppingList:
//           orderItems,

//         orderItems:
//           orderItems,

//       };


//       orders.push(orderObject);

//     }


//     // =================================================
//     // GROUP MULTI-SHOP ORDERS
//     // =================================================

//     const groupedOrders = [];

//     const groups = new Map();


//     for (const order of orders) {

//       const latitude =
//         Number(order.customerLatitude)
//           .toFixed(5);

//       const longitude =
//         Number(order.customerLongitude)
//           .toFixed(5);

//       const address =
//         String(
//           order.customer || ''
//         )
//           .trim()
//           .toLowerCase();


//       // -------------------------------------------------
//       // USE ORDER CREATION SECOND
//       // -------------------------------------------------

//       const createdAtSecond =
//         order.createdAt
//           ? new Date(order.createdAt)
//               .toISOString()
//               .slice(0, 19)
//           : `order-${order.id}`;


//       const groupKey =
//         `${order.customerId}_${latitude}_${longitude}_${address}_${createdAtSecond}`;


//       if (!groups.has(groupKey)) {

//         groups.set(
//           groupKey,
//           []
//         );

//       }


//       groups
//         .get(groupKey)
//         .push(order);

//     }


//     for (
//       const [
//         groupKey,
//         groupOrders
//       ] of groups
//     ) {

//       const shopNames =
//         groupOrders.map(
//           (order) =>
//             order.storeName
//         );


//       const shops =
//         groupOrders.map(
//           (order) => ({

//             shopId:
//               order.shopId,

//             shopName:
//               order.storeName,

//             shopImage:
//               order.shopImage,

//             pickupLatitude:
//               order.pickupLatitude,

//             pickupLongitude:
//               order.pickupLongitude,

//             distanceKm:
//               order.distanceKm,

//           })
//         );


//       // -------------------------------------------------
//       // STABLE GROUP ID
//       // -------------------------------------------------

//       const firstOrder =
//         groupOrders[0];


//       const orderGroupId =
//         `customer-${firstOrder.customerId}-${new Date(
//           firstOrder.createdAt
//         ).getTime()}-${firstOrder.id}`;


//       for (const order of groupOrders) {

//         order.orderGroupId =
//           orderGroupId;

//         order.batchId =
//           orderGroupId;

//         order.customerOrderId =
//           orderGroupId;

//         order.shopCount =
//           groupOrders.length;

//         order.shopNames =
//           shopNames;

//         order.shops =
//           shops;

//         order.batchOrders =
//           groupOrders.map(
//             (batchOrder) => ({

//               id:
//                 batchOrder.id,

//               shopId:
//                 batchOrder.shopId,

//               storeName:
//                 batchOrder.storeName,

//               shopImage:
//                 batchOrder.shopImage,

//               pickupLatitude:
//                 batchOrder.pickupLatitude,

//               pickupLongitude:
//                 batchOrder.pickupLongitude,

//               distanceKm:
//                 batchOrder.distanceKm,

//               status:
//                 batchOrder.status,

//               items:
//                 batchOrder.items,

//             })
//           );

//       }

//     }


//     // =================================================
//     // DEBUG LOG
//     // =================================================

//     console.log(
//       '🟢 SHOPPER ID:',
//       shopperId
//     );

//     console.log(
//       '🟢 SHOPPER LOCATION:',
//       {
//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,
//       }
//     );

//     console.log(
//       '🟢 RAW AVAILABLE ORDERS:',
//       ordersResult.rows.map(
//         (order) => ({
//           id:
//             order.id,

//           shopId:
//             order.shop_id,

//           shopName:
//             order.shop_name,

//           status:
//             order.status,

//           shopperId:
//             order.shopper_id,

//           shopStatus:
//             order.shop_status,

//           distanceKm:
//             Number(
//               order.shop_distance_km
//             ),
//         })
//       )
//     );

//     console.log(
//       '🟢 ORDERS WITHIN 10KM:',
//       nearbyOrders.map(
//         (order) => ({
//           id:
//             order.id,

//           shopId:
//             order.shop_id,

//           shopName:
//             order.shop_name,

//           status:
//             order.status,

//           distanceKm:
//             Number(
//               order.shop_distance_km
//             ),
//         })
//       )
//     );

//     console.log(
//       '🟢 AVAILABLE ORDERS FINAL:',
//       orders.map(
//         (order) => ({
//           id:
//             order.id,

//           shopId:
//             order.shopId,

//           storeName:
//             order.storeName,

//           distanceKm:
//             order.distanceKm,

//           status:
//             order.status,
//         })
//       )
//     );


//     // =================================================
//     // RESPONSE
//     // =================================================

//     return res.json({

//       success: true,

//       shopperLocation: {

//         latitude:
//           shopperLatitude,

//         longitude:
//           shopperLongitude,

//       },

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ getAvailableOrders error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get available orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ORDER BY ID
// // =====================================================

// const getMyOrderById = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!Number.isInteger(orderId)) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Invalid order ID',
//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT
//           o.*,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.id = $1
//           AND o.shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       orderResult.rows[0];


//     // -------------------------------------------------
//     // ORDER ITEMS
//     // -------------------------------------------------

//     const itemsResult =
//       await db.query(
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

//           voice_url,

//           shopper_photo_url,
//           shopping_status,
//           found_quantity,
//           found_weight,
//           found_weight_unit,
//           barcode_scanned,
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC
//         `,
//         [orderId]
//       );


//     const orderItems =
//       itemsResult.rows.map(
//         (item) => ({

//           id:
//             item.id,

//           orderId:
//             item.order_id,

//           productId:
//             item.product_id,

//           name:
//             item.item_name,

//           productName:
//             item.item_name,

//           quantity:
//             item.quantity,

//           amount:
//             item.amount,

//           unit:
//             item.unit,

//           price:
//             item.price,

//           custom:
//             item.custom,

//           details:
//             item.details,

//           image:
//             item.image,

//           voiceUrl:
//             item.voice_url || null,

//           shopperPhotoUrl:
//             item.shopper_photo_url || null,

//           shoppingStatus:
//             item.shopping_status || 'pending',

//           foundQuantity:
//             item.found_quantity,

//           foundWeight:
//             item.found_weight,

//           foundWeightUnit:
//             item.found_weight_unit,

//           barcodeScanned:
//             item.barcode_scanned || false,

//           completedAt:
//             item.completed_at,

//         })
//       );


//     // -------------------------------------------------
//     // REPLACEMENTS
//     // -------------------------------------------------

//     let replacementItems = [];


//     try {

//       const replacementResult =
//         await db.query(
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

//           WHERE order_id = $1

//           ORDER BY
//             original_item_id ASC,
//             option_number ASC,
//             id ASC
//           `,
//           [orderId]
//         );


//       replacementItems =
//         replacementResult.rows.map(
//           (item) => ({

//             id:
//               item.id,

//             orderId:
//               item.order_id,

//             originalItemId:
//               item.original_item_id,

//             shopperId:
//               item.shopper_id,

//             optionNumber:
//               item.option_number,

//             photoUrl:
//               item.photo_url,

//             status:
//               item.status,

//             createdAt:
//               item.created_at,

//             updatedAt:
//               item.updated_at,

//           })
//         );

//     } catch (replacementError) {

//       console.error(
//         '⚠️ Replacement items query failed:',
//         replacementError.message
//       );

//       replacementItems = [];

//     }


//     // -------------------------------------------------
//     // RESPONSE ORDER
//     // -------------------------------------------------

//     const responseOrder = {

//       id:
//         order.id,

//       customerId:
//         order.customer_id,

//       shopId:
//         order.shop_id,

//       shopperId:
//         order.shopper_id,


//       store:
//         order.shop_name,

//       storeName:
//         order.shop_name,

//       shop:
//         order.shop_name,


//       shopImage:
//         order.shop_image || null,


//       pickupLatitude:
//         order.shop_latitude !== null
//           ? Number(order.shop_latitude)
//           : null,

//       pickupLongitude:
//         order.shop_longitude !== null
//           ? Number(order.shop_longitude)
//           : null,


//       customer:
//         order.delivery_address,

//       customerName:
//         `Customer #${order.customer_id}`,

//       phone:
//         null,

//       customerPhone:
//         null,


//       customerLatitude:
//         Number(order.delivery_latitude),

//       customerLongitude:
//         Number(order.delivery_longitude),


//       latitude:
//         Number(order.delivery_latitude),

//       longitude:
//         Number(order.delivery_longitude),


//       deliveryAddress:
//         order.delivery_address,


//       deliveryOption:
//         order.delivery_option,

//       paymentMethod:
//         order.payment_method,


//       itemsTotal:
//         Number(order.items_total || 0),

//       deliveryFee:
//         Number(order.delivery_fee || 0),

//       serviceFee:
//         Number(order.service_fee || 0),

//       totalAmount:
//         Number(order.total_amount || 0),


//       status:
//         order.status,


//       createdAt:
//         order.created_at,

//       updatedAt:
//         order.updated_at,


//       paymentId:
//         order.payment_id || null,

//       paymentStatus:
//         order.payment_status || null,

//       paidAt:
//         order.paid_at || null,


//       billUrl:
//         order.bill_url || null,

//       billUploadedAt:
//         order.bill_uploaded_at || null,


//       deliveryPin:
//         order.delivery_pin || null,

//       arrivalConfirmedAt:
//         order.arrival_confirmed_at || null,

//       deliveredAt:
//         order.delivered_at || null,


//       items:
//         orderItems.length,

//       shoppingList:
//         orderItems,

//       orderItems:
//         orderItems,


//       replacementItems:
//         replacementItems,

//       replacements:
//         replacementItems,

//     };


//     return res.json({

//       success: true,

//       order:
//         responseOrder,

//     });


//   } catch (error) {

//     console.error(
//       '❌ getMyOrderById error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get order',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// const acceptOrder = async (
//   req,
//   res
// ) => {

//   const client =
//     await db.connect();

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!Number.isInteger(orderId)) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Invalid order ID',
//       });

//     }


//     await client.query(
//       'BEGIN'
//     );


//     const existingResult =
//       await client.query(
//         `
//         SELECT *
//         FROM orders
//         WHERE id = $1
//         FOR UPDATE
//         `,
//         [orderId]
//       );


//     if (
//       existingResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const existingOrder =
//       existingResult.rows[0];


//     if (
//       existingOrder.status !==
//         'waiting_for_shopper' ||
//       existingOrder.shopper_id !== null
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );

//       return res.status(409).json({

//         success: false,

//         message:
//           'This order is no longer available',

//       });

//     }


//     // -------------------------------------------------
//     // ACCEPT
//     // -------------------------------------------------

//     const updateResult =
//       await client.query(
//         `
//         UPDATE orders

//         SET
//           shopper_id = $1,
//           status = 'shopper_accepted',
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND status = 'waiting_for_shopper'
//           AND shopper_id IS NULL

//         RETURNING *
//         `,
//         [
//           shopperId,
//           orderId,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       await client.query(
//         'ROLLBACK'
//       );

//       return res.status(409).json({

//         success: false,

//         message:
//           'Order was already accepted',

//       });

//     }


//     const acceptedOrder =
//       updateResult.rows[0];


//     // -------------------------------------------------
//     // SHOP
//     // -------------------------------------------------

//     const shopResult =
//       await client.query(
//         `
//         SELECT
//           id,
//           shop_name,
//           image_url,
//           latitude,
//           longitude

//         FROM shops

//         WHERE id = $1

//         LIMIT 1
//         `,
//         [acceptedOrder.shop_id]
//       );


//     const shop =
//       shopResult.rows[0] || null;


//     // -------------------------------------------------
//     // ITEMS
//     // -------------------------------------------------

//     const itemsResult =
//       await client.query(
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

//           voice_url,

//           shopper_photo_url,
//           shopping_status,
//           found_quantity,
//           found_weight,
//           found_weight_unit,
//           barcode_scanned,
//           completed_at

//         FROM order_items

//         WHERE order_id = $1

//         ORDER BY id ASC
//         `,
//         [orderId]
//       );


//     const orderItems =
//       itemsResult.rows.map(
//         (item) => ({

//           id:
//             item.id,

//           orderId:
//             item.order_id,

//           productId:
//             item.product_id,

//           name:
//             item.item_name,

//           productName:
//             item.item_name,

//           quantity:
//             item.quantity,

//           amount:
//             item.amount,

//           unit:
//             item.unit,

//           price:
//             item.price,

//           custom:
//             item.custom,

//           details:
//             item.details,

//           image:
//             item.image,

//           voiceUrl:
//             item.voice_url || null,

//           shopperPhotoUrl:
//             item.shopper_photo_url || null,

//           shoppingStatus:
//             item.shopping_status || 'pending',

//           foundQuantity:
//             item.found_quantity,

//           foundWeight:
//             item.found_weight,

//           foundWeightUnit:
//             item.found_weight_unit,

//           barcodeScanned:
//             item.barcode_scanned || false,

//           completedAt:
//             item.completed_at,

//         })
//       );


//     await client.query(
//       'COMMIT'
//     );


//     return res.json({

//       success: true,

//       order: {

//         id:
//           acceptedOrder.id,

//         customerId:
//           acceptedOrder.customer_id,

//         shopId:
//           acceptedOrder.shop_id,

//         shopperId:
//           acceptedOrder.shopper_id,


//         store:
//           shop?.shop_name || null,

//         storeName:
//           shop?.shop_name || null,

//         shop:
//           shop?.shop_name || null,


//         shopImage:
//           shop?.image_url || null,


//         pickupLatitude:
//           shop?.latitude !== null &&
//           shop?.latitude !== undefined
//             ? Number(shop.latitude)
//             : null,

//         pickupLongitude:
//           shop?.longitude !== null &&
//           shop?.longitude !== undefined
//             ? Number(shop.longitude)
//             : null,


//         customer:
//           acceptedOrder.delivery_address,

//         customerName:
//           `Customer #${acceptedOrder.customer_id}`,

//         phone:
//           null,

//         customerPhone:
//           null,


//         customerLatitude:
//           Number(
//             acceptedOrder.delivery_latitude
//           ),

//         customerLongitude:
//           Number(
//             acceptedOrder.delivery_longitude
//           ),


//         latitude:
//           Number(
//             acceptedOrder.delivery_latitude
//           ),

//         longitude:
//           Number(
//             acceptedOrder.delivery_longitude
//           ),


//         deliveryAddress:
//           acceptedOrder.delivery_address,


//         deliveryOption:
//           acceptedOrder.delivery_option,

//         paymentMethod:
//           acceptedOrder.payment_method,


//         itemsTotal:
//           Number(
//             acceptedOrder.items_total || 0
//           ),

//         deliveryFee:
//           Number(
//             acceptedOrder.delivery_fee || 0
//           ),

//         serviceFee:
//           Number(
//             acceptedOrder.service_fee || 0
//           ),

//         totalAmount:
//           Number(
//             acceptedOrder.total_amount || 0
//           ),


//         status:
//           acceptedOrder.status,


//         createdAt:
//           acceptedOrder.created_at,

//         updatedAt:
//           acceptedOrder.updated_at,


//         items:
//           orderItems.length,

//         shoppingList:
//           orderItems,

//         orderItems:
//           orderItems,

//       },

//     });


//   } catch (error) {

//     try {
//       await client.query(
//         'ROLLBACK'
//       );
//     } catch (_) {}


//     console.error(
//       '❌ acceptOrder error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to accept order',

//       error:
//         error.message,

//     });

//   } finally {

//     client.release();

//   }

// };


// // =====================================================
// // START SHOPPING
// // =====================================================

// const startShopping = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status === 'shopping'
//     ) {

//       return res.json({

//         success: true,

//         order: {

//           id:
//             order.id,

//           customerId:
//             order.customer_id,

//           shopId:
//             order.shop_id,

//           shopperId:
//             order.shopper_id,

//           status:
//             order.status,

//         },

//       });

//     }


//     if (
//       order.status !==
//         'shopper_accepted'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot start shopping while order status is ${order.status}`,

//       });

//     }


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           status = 'shopping',
//           updated_at = NOW()

//         WHERE
//           id = $1
//           AND shopper_id = $2
//           AND status = 'shopper_accepted'

//         RETURNING
//           id,
//           customer_id,
//           shop_id,
//           shopper_id,
//           status,
//           updated_at
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     return res.json({

//       success: true,

//       order: {

//         id:
//           updateResult.rows[0].id,

//         customerId:
//           updateResult.rows[0].customer_id,

//         shopId:
//           updateResult.rows[0].shop_id,

//         shopperId:
//           updateResult.rows[0].shopper_id,

//         status:
//           updateResult.rows[0].status,

//         updatedAt:
//           updateResult.rows[0].updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ startShopping error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start shopping',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // START DELIVERY
// // =====================================================

// const startDelivery = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           shopper_id,
//           status,
//           bill_url

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status ===
//         'out_for_delivery'
//     ) {

//       return res.json({

//         success: true,

//         order: {

//           id:
//             order.id,

//           shopperId:
//             order.shopper_id,

//           status:
//             order.status,

//         },

//       });

//     }


//     if (
//       order.status !== 'shopping'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot start delivery while order status is ${order.status}`,

//       });

//     }


//     if (!order.bill_url) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Supermarket bill is required before starting delivery',

//       });

//     }


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           status = 'out_for_delivery',
//           updated_at = NOW()

//         WHERE
//           id = $1
//           AND shopper_id = $2
//           AND status = 'shopping'

//         RETURNING
//           id,
//           shopper_id,
//           status,
//           updated_at
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     return res.json({

//       success: true,

//       order: {

//         id:
//           updateResult.rows[0].id,

//         shopperId:
//           updateResult.rows[0].shopper_id,

//         status:
//           updateResult.rows[0].status,

//         updatedAt:
//           updateResult.rows[0].updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ startDelivery error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to start delivery',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // CONFIRM ARRIVAL
// // =====================================================

// const confirmArrival = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           shopper_id,
//           status,
//           delivery_pin

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status === 'arrived' &&
//       order.delivery_pin
//     ) {

//       return res.json({

//         success: true,

//         deliveryPin:
//           order.delivery_pin,

//         order: {

//           id:
//             order.id,

//           shopperId:
//             order.shopper_id,

//           status:
//             order.status,

//           deliveryPin:
//             order.delivery_pin,

//         },

//       });

//     }


//     if (
//       order.status !==
//         'out_for_delivery'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot confirm arrival while order status is ${order.status}`,

//       });

//     }


//     // -------------------------------------------------
//     // GENERATE 6 DIGIT PIN
//     // -------------------------------------------------

//     const deliveryPin =
//       Math.floor(
//         100000 +
//         Math.random() * 900000
//       ).toString();


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           delivery_pin = $1,
//           arrival_confirmed_at = NOW(),
//           status = 'arrived',
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND shopper_id = $3
//           AND status = 'out_for_delivery'

//         RETURNING
//           id,
//           shopper_id,
//           status,
//           delivery_pin,
//           arrival_confirmed_at,
//           updated_at
//         `,
//         [
//           deliveryPin,
//           orderId,
//           shopperId,
//         ]
//       );


//     const updatedOrder =
//       updateResult.rows[0];


//     return res.json({

//       success: true,

//       deliveryPin:
//         updatedOrder.delivery_pin,

//       order: {

//         id:
//           updatedOrder.id,

//         shopperId:
//           updatedOrder.shopper_id,

//         status:
//           updatedOrder.status,

//         deliveryPin:
//           updatedOrder.delivery_pin,

//         arrivalConfirmedAt:
//           updatedOrder.arrival_confirmed_at,

//         updatedAt:
//           updatedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ confirmArrival error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to confirm arrival',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // VERIFY DELIVERY PIN
// // =====================================================

// const verifyDeliveryPin = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const pin =
//       String(
//         req.body.pin ||
//         req.body.deliveryPin ||
//         ''
//       ).trim();


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (
//       !/^\d{6}$/.test(pin)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'A valid 6-digit delivery PIN is required',

//       });

//     }


//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           shopper_id,
//           status,
//           delivery_pin

//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     if (
//       order.status !== 'arrived'
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           `Cannot verify delivery PIN while order status is ${order.status}`,

//       });

//     }


//     if (
//       String(order.delivery_pin) !==
//       pin
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid delivery PIN',

//       });

//     }


//     const updateResult =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           status = 'delivered',
//           delivered_at = NOW(),
//           updated_at = NOW()

//         WHERE
//           id = $1
//           AND shopper_id = $2
//           AND status = 'arrived'
//           AND delivery_pin = $3

//         RETURNING
//           id,
//           shopper_id,
//           status,
//           delivered_at,
//           updated_at
//         `,
//         [
//           orderId,
//           shopperId,
//           pin,
//         ]
//       );


//     if (
//       updateResult.rows.length === 0
//     ) {

//       return res.status(409).json({

//         success: false,

//         message:
//           'Delivery could not be completed',

//       });

//     }


//     const completedOrder =
//       updateResult.rows[0];


//     return res.json({

//       success: true,

//       verified: true,

//       order: {

//         id:
//           completedOrder.id,

//         shopperId:
//           completedOrder.shopper_id,

//         status:
//           completedOrder.status,

//         deliveredAt:
//           completedOrder.delivered_at,

//         updatedAt:
//           completedOrder.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ verifyDeliveryPin error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to verify delivery PIN',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET MY ORDERS
// // =====================================================

// const getMyOrders = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const ordersResult =
//       await db.query(
//         `
//         SELECT
//           o.*,

//           s.shop_name,
//           s.image_url AS shop_image,

//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.shopper_id = $1

//         ORDER BY
//           o.created_at DESC
//         `,
//         [shopperId]
//       );


//     const orders = [];


//     for (
//       const order
//       of ordersResult.rows
//     ) {

//       const itemsResult =
//         await db.query(
//           `
//           SELECT
//             id,
//             order_id,
//             product_id,
//             item_name,
//             quantity,
//             amount,
//             unit,
//             price,
//             custom,
//             details,
//             image,

//             voice_url,

//             shopper_photo_url,
//             shopping_status,
//             found_quantity,
//             found_weight,
//             found_weight_unit,
//             barcode_scanned,
//             completed_at

//           FROM order_items

//           WHERE order_id = $1

//           ORDER BY id ASC
//           `,
//           [order.id]
//         );


//       const orderItems =
//         itemsResult.rows.map(
//           (item) => ({

//             id:
//               item.id,

//             orderId:
//               item.order_id,

//             productId:
//               item.product_id,

//             name:
//               item.item_name,

//             productName:
//               item.item_name,

//             quantity:
//               item.quantity,

//             amount:
//               item.amount,

//             unit:
//               item.unit,

//             price:
//               item.price,

//             custom:
//               item.custom,

//             details:
//               item.details,

//             image:
//               item.image,

//             // -----------------------------------------
//             // CUSTOMER VOICE NOTE
//             // -----------------------------------------

//             voiceUrl:
//               item.voice_url || null,

//             shopperPhotoUrl:
//               item.shopper_photo_url || null,

//             shoppingStatus:
//               item.shopping_status || 'pending',

//             foundQuantity:
//               item.found_quantity,

//             foundWeight:
//               item.found_weight,

//             foundWeightUnit:
//               item.found_weight_unit,

//             barcodeScanned:
//               item.barcode_scanned || false,

//             completedAt:
//               item.completed_at,

//           })
//         );


//       orders.push({

//         id:
//           order.id,

//         customerId:
//           order.customer_id,

//         shopId:
//           order.shop_id,

//         shopperId:
//           order.shopper_id,


//         store:
//           order.shop_name,

//         storeName:
//           order.shop_name,

//         shop:
//           order.shop_name,


//         shopImage:
//           order.shop_image || null,


//         pickupLatitude:
//           order.shop_latitude !== null
//             ? Number(order.shop_latitude)
//             : null,

//         pickupLongitude:
//           order.shop_longitude !== null
//             ? Number(order.shop_longitude)
//             : null,


//         customer:
//           order.delivery_address,

//         customerName:
//           `Customer #${order.customer_id}`,

//         phone:
//           null,

//         customerPhone:
//           null,


//         customerLatitude:
//           Number(order.delivery_latitude),

//         customerLongitude:
//           Number(order.delivery_longitude),


//         latitude:
//           Number(order.delivery_latitude),

//         longitude:
//           Number(order.delivery_longitude),


//         deliveryAddress:
//           order.delivery_address,


//         deliveryOption:
//           order.delivery_option,

//         paymentMethod:
//           order.payment_method,


//         itemsTotal:
//           Number(order.items_total || 0),

//         deliveryFee:
//           Number(order.delivery_fee || 0),

//         serviceFee:
//           Number(order.service_fee || 0),

//         totalAmount:
//           Number(order.total_amount || 0),


//         status:
//           order.status,


//         createdAt:
//           order.created_at,

//         updatedAt:
//           order.updated_at,


//         paymentId:
//           order.payment_id || null,

//         paymentStatus:
//           order.payment_status || null,

//         paidAt:
//           order.paid_at || null,


//         billUrl:
//           order.bill_url || null,

//         billUploadedAt:
//           order.bill_uploaded_at || null,


//         deliveryPin:
//           order.delivery_pin || null,

//         arrivalConfirmedAt:
//           order.arrival_confirmed_at || null,

//         deliveredAt:
//           order.delivered_at || null,


//         items:
//           orderItems.length,

//         shoppingList:
//           orderItems,

//         orderItems:
//           orderItems,

//       });

//     }


//     return res.json({

//       success: true,

//       count:
//         orders.length,

//       orders,

//     });


//   } catch (error) {

//     console.error(
//       '❌ getMyOrders error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get shopper orders',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // GET NEARBY SHOPPERS FOR ORDER
// // =====================================================

// const getNearbyShoppersForOrder = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT
//           o.id,
//           s.latitude AS shop_latitude,
//           s.longitude AS shop_longitude

//         FROM orders o

//         INNER JOIN shops s
//           ON s.id = o.shop_id

//         WHERE
//           o.id = $1

//         LIMIT 1
//         `,
//         [orderId]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       orderResult.rows[0];


//     const latitude =
//       Number(order.shop_latitude);

//     const longitude =
//       Number(order.shop_longitude);


//     if (
//       !Number.isFinite(latitude) ||
//       !Number.isFinite(longitude)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Shop coordinates are not available',

//       });

//     }


//     const shoppersResult =
//       await db.query(
//         `
//         SELECT
//           id,
//           latitude,
//           longitude,
//           status,

//           (
//             6371 * acos(
//               LEAST(
//                 1,
//                 GREATEST(
//                   -1,
//                   cos(radians($1))
//                   *
//                   cos(radians(latitude))
//                   *
//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )
//                   +
//                   sin(radians($1))
//                   *
//                   sin(radians(latitude))
//                 )
//               )
//             )
//           ) AS distance_km

//         FROM shoppers

//         WHERE
//           status = 'online'

//           AND latitude IS NOT NULL
//           AND longitude IS NOT NULL

//           AND id != $3

//         HAVING
//           (
//             6371 * acos(
//               LEAST(
//                 1,
//                 GREATEST(
//                   -1,
//                   cos(radians($1))
//                   *
//                   cos(radians(latitude))
//                   *
//                   cos(
//                     radians(longitude)
//                     -
//                     radians($2)
//                   )
//                   +
//                   sin(radians($1))
//                   *
//                   sin(radians(latitude))
//                 )
//               )
//             )
//           ) <= 10

//         ORDER BY
//           distance_km ASC
//         `,
//         [
//           latitude,
//           longitude,
//           shopperId,
//         ]
//       );


//     return res.json({

//       success: true,

//       count:
//         shoppersResult.rows.length,

//       shoppers:
//         shoppersResult.rows.map(
//           (shopper) => ({

//             id:
//               shopper.id,

//             latitude:
//               Number(shopper.latitude),

//             longitude:
//               Number(shopper.longitude),

//             status:
//               shopper.status,

//             distanceKm:
//               Number(
//                 shopper.distance_km
//               ),

//           })
//         ),

//     });


//   } catch (error) {

//     console.error(
//       '❌ getNearbyShoppersForOrder error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to get nearby shoppers',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD ITEM PHOTO
// // =====================================================

// const uploadItemPhoto = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const itemId =
//       Number(req.params.itemId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Photo is required',

//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ORDER
//     // -------------------------------------------------

//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders
//         WHERE
//           id = $1
//           AND shopper_id = $2
//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ITEM
//     // -------------------------------------------------

//     const itemResult =
//       await db.query(
//         `
//         SELECT id
//         FROM order_items
//         WHERE
//           id = $1
//           AND order_id = $2
//         LIMIT 1
//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (itemResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order item not found',
//       });

//     }


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


//     const foundQuantity =
//       req.body.foundQuantity !== undefined
//         ? Number(req.body.foundQuantity)
//         : null;


//     const foundWeight =
//       req.body.foundWeight !== undefined
//         ? Number(req.body.foundWeight)
//         : null;


//     const foundWeightUnit =
//       req.body.foundWeightUnit ||
//       null;


//     const barcodeScanned =
//       req.body.barcodeScanned === true ||
//       req.body.barcodeScanned === 'true';


//     const updateResult =
//       await db.query(
//         `
//         UPDATE order_items

//         SET
//           shopper_photo_url = $1,
//           shopping_status = 'done',

//           found_quantity = $2,
//           found_weight = $3,
//           found_weight_unit = $4,

//           barcode_scanned = $5,

//           completed_at = NOW()

//         WHERE
//           id = $6
//           AND order_id = $7

//         RETURNING *
//         `,
//         [
//           photoUrl,
//           foundQuantity,
//           foundWeight,
//           foundWeightUnit,
//           barcodeScanned,
//           itemId,
//           orderId,
//         ]
//       );


//     return res.json({

//       success: true,

//       item: {

//         id:
//           updateResult.rows[0].id,

//         orderId:
//           updateResult.rows[0].order_id,

//         name:
//           updateResult.rows[0].item_name,

//         image:
//           updateResult.rows[0].image,

//         voiceUrl:
//           updateResult.rows[0].voice_url || null,

//         shopperPhotoUrl:
//           updateResult.rows[0].shopper_photo_url,

//         shoppingStatus:
//           updateResult.rows[0].shopping_status,

//         foundQuantity:
//           updateResult.rows[0].found_quantity,

//         foundWeight:
//           updateResult.rows[0].found_weight,

//         foundWeightUnit:
//           updateResult.rows[0].found_weight_unit,

//         barcodeScanned:
//           updateResult.rows[0].barcode_scanned,

//         completedAt:
//           updateResult.rows[0].completed_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ uploadItemPhoto error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload item photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD REPLACEMENT PHOTO
// // =====================================================

// const uploadReplacementPhoto = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const itemId =
//       Number(req.params.itemId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Replacement photo is required',

//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ORDER
//     // -------------------------------------------------

//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     // -------------------------------------------------
//     // VERIFY ITEM
//     // -------------------------------------------------

//     const itemResult =
//       await db.query(
//         `
//         SELECT id
//         FROM order_items

//         WHERE
//           id = $1
//           AND order_id = $2

//         LIMIT 1
//         `,
//         [
//           itemId,
//           orderId,
//         ]
//       );


//     if (itemResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order item not found',
//       });

//     }


//     // -------------------------------------------------
//     // NEXT OPTION NUMBER
//     // -------------------------------------------------

//     const optionResult =
//       await db.query(
//         `
//         SELECT
//           COALESCE(
//             MAX(option_number),
//             0
//           ) + 1 AS next_option

//         FROM replacement_items

//         WHERE
//           order_id = $1
//           AND original_item_id = $2
//         `,
//         [
//           orderId,
//           itemId,
//         ]
//       );


//     const optionNumber =
//       Number(
//         optionResult.rows[0]
//           .next_option
//       );


//     const photoUrl =
//       `${req.protocol}://${req.get('host')}/uploads/replacements/${req.file.filename}`;


//     const insertResult =
//       await db.query(
//         `
//         INSERT INTO replacement_items
//         (
//           order_id,
//           original_item_id,
//           shopper_id,
//           option_number,
//           photo_url,
//           status
//         )

//         VALUES
//         (
//           $1,
//           $2,
//           $3,
//           $4,
//           $5,
//           'waiting_customer'
//         )

//         RETURNING *
//         `,
//         [
//           orderId,
//           itemId,
//           shopperId,
//           optionNumber,
//           photoUrl,
//         ]
//       );


//     const replacement =
//       insertResult.rows[0];


//     return res.json({

//       success: true,

//       replacement: {

//         id:
//           replacement.id,

//         orderId:
//           replacement.order_id,

//         originalItemId:
//           replacement.original_item_id,

//         shopperId:
//           replacement.shopper_id,

//         optionNumber:
//           replacement.option_number,

//         photoUrl:
//           replacement.photo_url,

//         status:
//           replacement.status,

//         createdAt:
//           replacement.created_at,

//         updatedAt:
//           replacement.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ uploadReplacementPhoto error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload replacement photo',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ITEM SHOPPING STATUS
// // =====================================================

// const updateItemShoppingStatus = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const itemId =
//       Number(req.params.itemId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const foundQuantity =
//       req.body.foundQuantity !== undefined
//         ? Number(req.body.foundQuantity)
//         : null;


//     const foundWeight =
//       req.body.foundWeight !== undefined
//         ? Number(req.body.foundWeight)
//         : null;


//     const foundWeightUnit =
//       req.body.foundWeightUnit ||
//       null;


//     const barcodeScanned =
//       req.body.barcodeScanned === true ||
//       req.body.barcodeScanned === 'true';


//     const result =
//       await db.query(
//         `
//         UPDATE order_items

//         SET
//           shopping_status = 'done',

//           found_quantity = $1,
//           found_weight = $2,
//           found_weight_unit = $3,

//           barcode_scanned = $4,

//           completed_at = NOW()

//         WHERE
//           id = $5
//           AND order_id = $6

//         RETURNING *
//         `,
//         [
//           foundQuantity,
//           foundWeight,
//           foundWeightUnit,
//           barcodeScanned,
//           itemId,
//           orderId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order item not found',
//       });

//     }


//     const item =
//       result.rows[0];


//     return res.json({

//       success: true,

//       item: {

//         id:
//           item.id,

//         orderId:
//           item.order_id,

//         name:
//           item.item_name,

//         quantity:
//           item.quantity,

//         image:
//           item.image,

//         voiceUrl:
//           item.voice_url || null,

//         shoppingStatus:
//           item.shopping_status,

//         foundQuantity:
//           item.found_quantity,

//         foundWeight:
//           item.found_weight,

//         foundWeightUnit:
//           item.found_weight_unit,

//         barcodeScanned:
//           item.barcode_scanned,

//         completedAt:
//           item.completed_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ updateItemShoppingStatus error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update item shopping status',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPDATE ORDER PAYMENT
// // =====================================================

// const updateOrderPayment = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);

//     const paymentId =
//       req.body.paymentId;


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!paymentId) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Payment ID is required',

//       });

//     }


//     const result =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           payment_id = $1,
//           payment_status = 'paid',
//           paid_at = NOW(),
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND shopper_id = $3

//         RETURNING
//           id,
//           payment_id,
//           payment_status,
//           paid_at,
//           updated_at
//         `,
//         [
//           paymentId,
//           orderId,
//           shopperId,
//         ]
//       );


//     if (result.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const order =
//       result.rows[0];


//     return res.json({

//       success: true,

//       payment: {

//         paymentId:
//           order.payment_id,

//         paymentStatus:
//           order.payment_status,

//         paidAt:
//           order.paid_at,

//       },

//       order: {

//         id:
//           order.id,

//         paymentId:
//           order.payment_id,

//         paymentStatus:
//           order.payment_status,

//         paidAt:
//           order.paid_at,

//         updatedAt:
//           order.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ updateOrderPayment error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update payment',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // UPLOAD BILL
// // =====================================================

// const uploadBill = async (
//   req,
//   res
// ) => {

//   try {

//     const shopperId =
//       getShopperId(req);

//     const orderId =
//       Number(req.params.orderId);


//     if (!shopperId) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Shopper authentication required',
//       });

//     }


//     if (!req.file) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Bill image is required',

//       });

//     }


//     const orderResult =
//       await db.query(
//         `
//         SELECT id
//         FROM orders

//         WHERE
//           id = $1
//           AND shopper_id = $2

//         LIMIT 1
//         `,
//         [
//           orderId,
//           shopperId,
//         ]
//       );


//     if (orderResult.rows.length === 0) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Order not found',
//       });

//     }


//     const billUrl =
//       `${req.protocol}://${req.get('host')}/uploads/bills/${req.file.filename}`;


//     const result =
//       await db.query(
//         `
//         UPDATE orders

//         SET
//           bill_url = $1,
//           bill_uploaded_at = NOW(),
//           updated_at = NOW()

//         WHERE
//           id = $2
//           AND shopper_id = $3

//         RETURNING
//           id,
//           bill_url,
//           bill_uploaded_at,
//           updated_at
//         `,
//         [
//           billUrl,
//           orderId,
//           shopperId,
//         ]
//       );


//     const order =
//       result.rows[0];


//     return res.json({

//       success: true,

//       bill: {

//         billUrl:
//           order.bill_url,

//         billUploadedAt:
//           order.bill_uploaded_at,

//       },

//       order: {

//         id:
//           order.id,

//         billUrl:
//           order.bill_url,

//         billUploadedAt:
//           order.bill_uploaded_at,

//         updatedAt:
//           order.updated_at,

//       },

//     });


//   } catch (error) {

//     console.error(
//       '❌ uploadBill error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to upload bill',

//       error:
//         error.message,

//     });

//   }

// };


// // =====================================================
// // EXPORTS
// // =====================================================

// module.exports = {

//   getAvailableOrders,

//   acceptOrder,

//   startShopping,

//   startDelivery,

//   confirmArrival,

//   verifyDeliveryPin,

//   getMyOrders,

//   getMyOrderById,

//   getNearbyShoppersForOrder,

//   uploadItemPhoto,

//   uploadReplacementPhoto,

//   updateItemShoppingStatus,

//   updateOrderPayment,

//   uploadBill,

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
// GET AVAILABLE ORDERS
// =====================================================

const getAvailableOrders = async (req, res) => {
  try {

    const shopperId = getShopperId(req);

    if (!shopperId) {
      return res.status(401).json({
        success: false,
        message: 'Shopper authentication required',
      });
    }


    // -------------------------------------------------
    // GET SHOPPER LOCATION
    // -------------------------------------------------

    const shopperResult = await db.query(
      `
      SELECT
        id,
        latitude,
        longitude,
        status
      FROM shoppers
      WHERE id = $1
      LIMIT 1
      `,
      [shopperId]
    );


    if (shopperResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Shopper not found',
      });
    }


    const shopper =
      shopperResult.rows[0];


    const shopperLatitude =
      Number(shopper.latitude);

    const shopperLongitude =
      Number(shopper.longitude);


    if (
      !Number.isFinite(shopperLatitude) ||
      !Number.isFinite(shopperLongitude)
    ) {

      return res.status(400).json({
        success: false,
        message:
          'Shopper location is not available',
      });

    }


    // -------------------------------------------------
    // GET AVAILABLE ORDERS
    // -------------------------------------------------

    const ordersResult = await db.query(
      `
      SELECT
        o.id,
        o.customer_id,
        o.shop_id,

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

        (
          6371 * acos(
            LEAST(
              1,
              GREATEST(
                -1,
                cos(radians($1))
                *
                cos(radians(s.latitude))
                *
                cos(
                  radians(s.longitude)
                  -
                  radians($2)
                )
                +
                sin(radians($1))
                *
                sin(radians(s.latitude))
              )
            )
          )
        ) AS shop_distance_km

      FROM orders o

      INNER JOIN shops s
        ON s.id = o.shop_id

      WHERE
        o.status = 'waiting_for_shopper'
        AND o.shopper_id IS NULL

        AND s.status = 'approved'

        AND s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL

      ORDER BY
        shop_distance_km ASC,
        o.created_at ASC
      `,
      [
        shopperLatitude,
        shopperLongitude,
      ]
    );


    // -------------------------------------------------
    // FILTER WITHIN 10 KM
    // -------------------------------------------------

    const nearbyOrders =
      ordersResult.rows.filter((order) => {

        const distance =
          Number(order.shop_distance_km);

        return (
          Number.isFinite(distance) &&
          distance <= 10
        );

      });


    // -------------------------------------------------
    // BUILD ORDERS
    // -------------------------------------------------

    const orders = [];


    for (const order of nearbyOrders) {

      // -----------------------------------------------
      // GET ORDER ITEMS
      // -----------------------------------------------

      const itemsResult =
        await db.query(
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

            voice_url,

            shopper_photo_url,
            shopping_status,
            found_quantity,
            found_weight,
            found_weight_unit,
            barcode_scanned,
            completed_at

          FROM order_items

          WHERE order_id = $1

          ORDER BY id ASC
          `,
          [order.id]
        );


      const orderItems =
        itemsResult.rows.map((item) => ({

          id:
            item.id,

          orderId:
            item.order_id,

          productId:
            item.product_id,

          name:
            item.item_name,

          productName:
            item.item_name,

          quantity:
            item.quantity,

          amount:
            item.amount,

          unit:
            item.unit,

          price:
            item.price,

          custom:
            item.custom,

          details:
            item.details,

          image:
            item.image,

          // -------------------------------------------
          // CUSTOMER VOICE NOTE
          // -------------------------------------------

          voiceUrl:
            item.voice_url || null,

          shopperPhotoUrl:
            item.shopper_photo_url || null,

          shoppingStatus:
            item.shopping_status || 'pending',

          foundQuantity:
            item.found_quantity,

          foundWeight:
            item.found_weight,

          foundWeightUnit:
            item.found_weight_unit,

          barcodeScanned:
            item.barcode_scanned || false,

          completedAt:
            item.completed_at,

        }));


      // -----------------------------------------------
      // ORDER OBJECT
      // -----------------------------------------------

      const distanceKm =
        Number(order.shop_distance_km);


      const orderObject = {

        id:
          order.id,

        customerId:
          order.customer_id,

        shopId:
          order.shop_id,


        store:
          order.shop_name,

        storeName:
          order.shop_name,

        shop:
          order.shop_name,


        shopImage:
          order.shop_image || null,


        pickupLatitude:
          Number(order.shop_latitude),

        pickupLongitude:
          Number(order.shop_longitude),


        customer:
          order.delivery_address,

        customerName:
          `Customer #${order.customer_id}`,

        phone:
          null,

        customerPhone:
          null,


        customerLatitude:
          Number(order.delivery_latitude),

        customerLongitude:
          Number(order.delivery_longitude),


        latitude:
          Number(order.delivery_latitude),

        longitude:
          Number(order.delivery_longitude),


        deliveryAddress:
          order.delivery_address,


        itemsTotal:
          Number(order.items_total || 0),

        deliveryFee:
          Number(order.delivery_fee || 0),

        serviceFee:
          Number(order.service_fee || 0),

        totalAmount:
          Number(order.total_amount || 0),


        distance:
          `${distanceKm.toFixed(2)} km`,

        distanceKm:
          distanceKm,


        deliveryOption:
          order.delivery_option,

        paymentMethod:
          order.payment_method,


        status:
          order.status,


        createdAt:
          order.created_at,

        updatedAt:
          order.updated_at,


        items:
          orderItems.length,


        shoppingList:
          orderItems,

        orderItems:
          orderItems,

      };


      orders.push(orderObject);

    }


    // =================================================
    // GROUP MULTI-SHOP ORDERS
    // =================================================

    const groupedOrders = [];

    const groups = new Map();


    for (const order of orders) {

      const latitude =
        Number(order.customerLatitude)
          .toFixed(5);

      const longitude =
        Number(order.customerLongitude)
          .toFixed(5);

      const address =
        String(
          order.customer || ''
        )
          .trim()
          .toLowerCase();


      // -------------------------------------------------
      // USE ORDER CREATION SECOND
      // -------------------------------------------------

      const createdAtSecond =
        order.createdAt
          ? new Date(order.createdAt)
              .toISOString()
              .slice(0, 19)
          : `order-${order.id}`;


      const groupKey =
        `${order.customerId}_${latitude}_${longitude}_${address}_${createdAtSecond}`;


      if (!groups.has(groupKey)) {

        groups.set(
          groupKey,
          []
        );

      }


      groups
        .get(groupKey)
        .push(order);

    }


    for (
      const [
        groupKey,
        groupOrders
      ] of groups
    ) {

      const shopNames =
        groupOrders.map(
          (order) =>
            order.storeName
        );


      const shops =
        groupOrders.map(
          (order) => ({

            shopId:
              order.shopId,

            shopName:
              order.storeName,

            shopImage:
              order.shopImage,

            pickupLatitude:
              order.pickupLatitude,

            pickupLongitude:
              order.pickupLongitude,

            distanceKm:
              order.distanceKm,

          })
        );


      // -------------------------------------------------
      // STABLE GROUP ID
      // -------------------------------------------------

      const firstOrder =
        groupOrders[0];


      const orderGroupId =
        `customer-${firstOrder.customerId}-${new Date(
          firstOrder.createdAt
        ).getTime()}-${firstOrder.id}`;


      for (const order of groupOrders) {

        order.orderGroupId =
          orderGroupId;

        order.batchId =
          orderGroupId;

        order.customerOrderId =
          orderGroupId;

        order.shopCount =
          groupOrders.length;

        order.shopNames =
          shopNames;

        order.shops =
          shops;

        order.batchOrders =
          groupOrders.map(
            (batchOrder) => ({

              id:
                batchOrder.id,

              shopId:
                batchOrder.shopId,

              storeName:
                batchOrder.storeName,

              shopImage:
                batchOrder.shopImage,

              pickupLatitude:
                batchOrder.pickupLatitude,

              pickupLongitude:
                batchOrder.pickupLongitude,

              distanceKm:
                batchOrder.distanceKm,

              status:
                batchOrder.status,

              items:
                batchOrder.items,

            })
          );

      }

    }


    // =================================================
    // DEBUG LOG
    // =================================================

    console.log(
      '🟢 SHOPPER ID:',
      shopperId
    );

    console.log(
      '🟢 SHOPPER LOCATION:',
      {
        latitude:
          shopperLatitude,

        longitude:
          shopperLongitude,
      }
    );

    console.log(
      '🟢 RAW AVAILABLE ORDERS:',
      ordersResult.rows.map(
        (order) => ({
          id:
            order.id,

          shopId:
            order.shop_id,

          shopName:
            order.shop_name,

          status:
            order.status,

          shopperId:
            order.shopper_id,

          shopStatus:
            order.shop_status,

          distanceKm:
            Number(
              order.shop_distance_km
            ),
        })
      )
    );

    console.log(
      '🟢 ORDERS WITHIN 10KM:',
      nearbyOrders.map(
        (order) => ({
          id:
            order.id,

          shopId:
            order.shop_id,

          shopName:
            order.shop_name,

          status:
            order.status,

          distanceKm:
            Number(
              order.shop_distance_km
            ),
        })
      )
    );

    console.log(
      '🟢 AVAILABLE ORDERS FINAL:',
      orders.map(
        (order) => ({
          id:
            order.id,

          shopId:
            order.shopId,

          storeName:
            order.storeName,

          distanceKm:
            order.distanceKm,

          status:
            order.status,
        })
      )
    );


    // =================================================
    // RESPONSE
    // =================================================

    // IMPORTANT:
    // Prevent Express/browser/client caching from
    // returning HTTP 304 instead of the JSON body.

    res.set({
      'Cache-Control':
        'no-store, no-cache, must-revalidate, proxy-revalidate',

      'Pragma':
        'no-cache',

      'Expires':
        '0',
    });


    return res.status(200).json({

      success: true,

      shopperLocation: {

        latitude:
          shopperLatitude,

        longitude:
          shopperLongitude,

      },

      count:
        orders.length,

      orders,

    });


  } catch (error) {

    console.error(
      '❌ getAvailableOrders error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to get available orders',

      error:
        error.message,

    });

  }

};


// =====================================================
// GET MY ORDER BY ID
// =====================================================

const getMyOrderById = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    if (!Number.isInteger(orderId)) {

      return res.status(400).json({
        success: false,
        message:
          'Invalid order ID',
      });

    }


    const orderResult =
      await db.query(
        `
        SELECT
          o.*,

          s.shop_name,
          s.image_url AS shop_image,

          s.latitude AS shop_latitude,
          s.longitude AS shop_longitude

        FROM orders o

        INNER JOIN shops s
          ON s.id = o.shop_id

        WHERE
          o.id = $1
          AND o.shopper_id = $2

        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );


    if (orderResult.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const order =
      orderResult.rows[0];


    // -------------------------------------------------
    // ORDER ITEMS
    // -------------------------------------------------

    const itemsResult =
      await db.query(
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

          voice_url,

          shopper_photo_url,
          shopping_status,
          found_quantity,
          found_weight,
          found_weight_unit,
          barcode_scanned,
          completed_at

        FROM order_items

        WHERE order_id = $1

        ORDER BY id ASC
        `,
        [orderId]
      );


    const orderItems =
      itemsResult.rows.map(
        (item) => ({

          id:
            item.id,

          orderId:
            item.order_id,

          productId:
            item.product_id,

          name:
            item.item_name,

          productName:
            item.item_name,

          quantity:
            item.quantity,

          amount:
            item.amount,

          unit:
            item.unit,

          price:
            item.price,

          custom:
            item.custom,

          details:
            item.details,

          image:
            item.image,

          voiceUrl:
            item.voice_url || null,

          shopperPhotoUrl:
            item.shopper_photo_url || null,

          shoppingStatus:
            item.shopping_status || 'pending',

          foundQuantity:
            item.found_quantity,

          foundWeight:
            item.found_weight,

          foundWeightUnit:
            item.found_weight_unit,

          barcodeScanned:
            item.barcode_scanned || false,

          completedAt:
            item.completed_at,

        })
      );


    // -------------------------------------------------
    // REPLACEMENTS
    // -------------------------------------------------

    let replacementItems = [];


    try {

      const replacementResult =
        await db.query(
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

          WHERE order_id = $1

          ORDER BY
            original_item_id ASC,
            option_number ASC,
            id ASC
          `,
          [orderId]
        );


      replacementItems =
        replacementResult.rows.map(
          (item) => ({

            id:
              item.id,

            orderId:
              item.order_id,

            originalItemId:
              item.original_item_id,

            shopperId:
              item.shopper_id,

            optionNumber:
              item.option_number,

            photoUrl:
              item.photo_url,

            status:
              item.status,

            createdAt:
              item.created_at,

            updatedAt:
              item.updated_at,

          })
        );

    } catch (replacementError) {

      console.error(
        '⚠️ Replacement items query failed:',
        replacementError.message
      );

      replacementItems = [];

    }


    // -------------------------------------------------
    // RESPONSE ORDER
    // -------------------------------------------------

    const responseOrder = {

      id:
        order.id,

      customerId:
        order.customer_id,

      shopId:
        order.shop_id,

      shopperId:
        order.shopper_id,


      store:
        order.shop_name,

      storeName:
        order.shop_name,

      shop:
        order.shop_name,


      shopImage:
        order.shop_image || null,


      pickupLatitude:
        order.shop_latitude !== null
          ? Number(order.shop_latitude)
          : null,

      pickupLongitude:
        order.shop_longitude !== null
          ? Number(order.shop_longitude)
          : null,


      customer:
        order.delivery_address,

      customerName:
        `Customer #${order.customer_id}`,

      phone:
        null,

      customerPhone:
        null,


      customerLatitude:
        Number(order.delivery_latitude),

      customerLongitude:
        Number(order.delivery_longitude),


      latitude:
        Number(order.delivery_latitude),

      longitude:
        Number(order.delivery_longitude),


      deliveryAddress:
        order.delivery_address,


      deliveryOption:
        order.delivery_option,

      paymentMethod:
        order.payment_method,


      itemsTotal:
        Number(order.items_total || 0),

      deliveryFee:
        Number(order.delivery_fee || 0),

      serviceFee:
        Number(order.service_fee || 0),

      totalAmount:
        Number(order.total_amount || 0),


      status:
        order.status,


      createdAt:
        order.created_at,

      updatedAt:
        order.updated_at,


      paymentId:
        order.payment_id || null,

      paymentStatus:
        order.payment_status || null,

      paidAt:
        order.paid_at || null,


      billUrl:
        order.bill_url || null,

      billUploadedAt:
        order.bill_uploaded_at || null,


      deliveryPin:
        order.delivery_pin || null,

      arrivalConfirmedAt:
        order.arrival_confirmed_at || null,

      deliveredAt:
        order.delivered_at || null,


      items:
        orderItems.length,

      shoppingList:
        orderItems,

      orderItems:
        orderItems,


      replacementItems:
        replacementItems,

      replacements:
        replacementItems,

    };


    return res.json({

      success: true,

      order:
        responseOrder,

    });


  } catch (error) {

    console.error(
      '❌ getMyOrderById error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to get order',

      error:
        error.message,

    });

  }

};


// =====================================================
// ACCEPT ORDER
// =====================================================

const acceptOrder = async (
  req,
  res
) => {

  const client =
    await db.connect();

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    if (!Number.isInteger(orderId)) {

      return res.status(400).json({
        success: false,
        message:
          'Invalid order ID',
      });

    }


    await client.query(
      'BEGIN'
    );


    const existingResult =
      await client.query(
        `
        SELECT *
        FROM orders
        WHERE id = $1
        FOR UPDATE
        `,
        [orderId]
      );


    if (
      existingResult.rows.length === 0
    ) {

      await client.query(
        'ROLLBACK'
      );

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const existingOrder =
      existingResult.rows[0];


    if (
      existingOrder.status !==
        'waiting_for_shopper' ||
      existingOrder.shopper_id !== null
    ) {

      await client.query(
        'ROLLBACK'
      );

      return res.status(409).json({

        success: false,

        message:
          'This order is no longer available',

      });

    }


    // -------------------------------------------------
    // ACCEPT
    // -------------------------------------------------

    const updateResult =
      await client.query(
        `
        UPDATE orders

        SET
          shopper_id = $1,
          status = 'shopper_accepted',
          updated_at = NOW()

        WHERE
          id = $2
          AND status = 'waiting_for_shopper'
          AND shopper_id IS NULL

        RETURNING *
        `,
        [
          shopperId,
          orderId,
        ]
      );


    if (
      updateResult.rows.length === 0
    ) {

      await client.query(
        'ROLLBACK'
      );

      return res.status(409).json({

        success: false,

        message:
          'Order was already accepted',

      });

    }


    const acceptedOrder =
      updateResult.rows[0];


    // -------------------------------------------------
    // SHOP
    // -------------------------------------------------

    const shopResult =
      await client.query(
        `
        SELECT
          id,
          shop_name,
          image_url,
          latitude,
          longitude

        FROM shops

        WHERE id = $1

        LIMIT 1
        `,
        [acceptedOrder.shop_id]
      );


    const shop =
      shopResult.rows[0] || null;


    // -------------------------------------------------
    // ITEMS
    // -------------------------------------------------

    const itemsResult =
      await client.query(
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

          voice_url,

          shopper_photo_url,
          shopping_status,
          found_quantity,
          found_weight,
          found_weight_unit,
          barcode_scanned,
          completed_at

        FROM order_items

        WHERE order_id = $1

        ORDER BY id ASC
        `,
        [orderId]
      );


    const orderItems =
      itemsResult.rows.map(
        (item) => ({

          id:
            item.id,

          orderId:
            item.order_id,

          productId:
            item.product_id,

          name:
            item.item_name,

          productName:
            item.item_name,

          quantity:
            item.quantity,

          amount:
            item.amount,

          unit:
            item.unit,

          price:
            item.price,

          custom:
            item.custom,

          details:
            item.details,

          image:
            item.image,

          voiceUrl:
            item.voice_url || null,

          shopperPhotoUrl:
            item.shopper_photo_url || null,

          shoppingStatus:
            item.shopping_status || 'pending',

          foundQuantity:
            item.found_quantity,

          foundWeight:
            item.found_weight,

          foundWeightUnit:
            item.found_weight_unit,

          barcodeScanned:
            item.barcode_scanned || false,

          completedAt:
            item.completed_at,

        })
      );


    await client.query(
      'COMMIT'
    );


    return res.json({

      success: true,

      order: {

        id:
          acceptedOrder.id,

        customerId:
          acceptedOrder.customer_id,

        shopId:
          acceptedOrder.shop_id,

        shopperId:
          acceptedOrder.shopper_id,


        store:
          shop?.shop_name || null,

        storeName:
          shop?.shop_name || null,

        shop:
          shop?.shop_name || null,


        shopImage:
          shop?.image_url || null,


        pickupLatitude:
          shop?.latitude !== null &&
          shop?.latitude !== undefined
            ? Number(shop.latitude)
            : null,

        pickupLongitude:
          shop?.longitude !== null &&
          shop?.longitude !== undefined
            ? Number(shop.longitude)
            : null,


        customer:
          acceptedOrder.delivery_address,

        customerName:
          `Customer #${acceptedOrder.customer_id}`,

        phone:
          null,

        customerPhone:
          null,


        customerLatitude:
          Number(
            acceptedOrder.delivery_latitude
          ),

        customerLongitude:
          Number(
            acceptedOrder.delivery_longitude
          ),


        latitude:
          Number(
            acceptedOrder.delivery_latitude
          ),

        longitude:
          Number(
            acceptedOrder.delivery_longitude
          ),


        deliveryAddress:
          acceptedOrder.delivery_address,


        deliveryOption:
          acceptedOrder.delivery_option,

        paymentMethod:
          acceptedOrder.payment_method,


        itemsTotal:
          Number(
            acceptedOrder.items_total || 0
          ),

        deliveryFee:
          Number(
            acceptedOrder.delivery_fee || 0
          ),

        serviceFee:
          Number(
            acceptedOrder.service_fee || 0
          ),

        totalAmount:
          Number(
            acceptedOrder.total_amount || 0
          ),


        status:
          acceptedOrder.status,


        createdAt:
          acceptedOrder.created_at,

        updatedAt:
          acceptedOrder.updated_at,


        items:
          orderItems.length,

        shoppingList:
          orderItems,

        orderItems:
          orderItems,

      },

    });


  } catch (error) {

    try {
      await client.query(
        'ROLLBACK'
      );
    } catch (_) {}


    console.error(
      '❌ acceptOrder error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to accept order',

      error:
        error.message,

    });

  } finally {

    client.release();

  }

};


// =====================================================
// START SHOPPING
// =====================================================

const startShopping = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    const result =
      await db.query(
        `
        SELECT
          id,
          customer_id,
          shop_id,
          shopper_id,
          status

        FROM orders

        WHERE
          id = $1
          AND shopper_id = $2

        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );


    if (result.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const order =
      result.rows[0];


    if (
      order.status === 'shopping'
    ) {

      return res.json({

        success: true,

        order: {

          id:
            order.id,

          customerId:
            order.customer_id,

          shopId:
            order.shop_id,

          shopperId:
            order.shopper_id,

          status:
            order.status,

        },

      });

    }


    if (
      order.status !==
        'shopper_accepted'
    ) {

      return res.status(409).json({

        success: false,

        message:
          `Cannot start shopping while order status is ${order.status}`,

      });

    }


    const updateResult =
      await db.query(
        `
        UPDATE orders

        SET
          status = 'shopping',
          updated_at = NOW()

        WHERE
          id = $1
          AND shopper_id = $2
          AND status = 'shopper_accepted'

        RETURNING
          id,
          customer_id,
          shop_id,
          shopper_id,
          status,
          updated_at
        `,
        [
          orderId,
          shopperId,
        ]
      );


    return res.json({

      success: true,

      order: {

        id:
          updateResult.rows[0].id,

        customerId:
          updateResult.rows[0].customer_id,

        shopId:
          updateResult.rows[0].shop_id,

        shopperId:
          updateResult.rows[0].shopper_id,

        status:
          updateResult.rows[0].status,

        updatedAt:
          updateResult.rows[0].updated_at,

      },

    });


  } catch (error) {

    console.error(
      '❌ startShopping error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to start shopping',

      error:
        error.message,

    });

  }

};


// =====================================================
// START DELIVERY
// =====================================================

const startDelivery = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    const result =
      await db.query(
        `
        SELECT
          id,
          shopper_id,
          status,
          bill_url

        FROM orders

        WHERE
          id = $1
          AND shopper_id = $2

        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );


    if (result.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const order =
      result.rows[0];


    if (
      order.status ===
        'out_for_delivery'
    ) {

      return res.json({

        success: true,

        order: {

          id:
            order.id,

          shopperId:
            order.shopper_id,

          status:
            order.status,

        },

      });

    }


    if (
      order.status !== 'shopping'
    ) {

      return res.status(409).json({

        success: false,

        message:
          `Cannot start delivery while order status is ${order.status}`,

      });

    }


    if (!order.bill_url) {

      return res.status(400).json({

        success: false,

        message:
          'Supermarket bill is required before starting delivery',

      });

    }


    const updateResult =
      await db.query(
        `
        UPDATE orders

        SET
          status = 'out_for_delivery',
          updated_at = NOW()

        WHERE
          id = $1
          AND shopper_id = $2
          AND status = 'shopping'

        RETURNING
          id,
          shopper_id,
          status,
          updated_at
        `,
        [
          orderId,
          shopperId,
        ]
      );


    return res.json({

      success: true,

      order: {

        id:
          updateResult.rows[0].id,

        shopperId:
          updateResult.rows[0].shopper_id,

        status:
          updateResult.rows[0].status,

        updatedAt:
          updateResult.rows[0].updated_at,

      },

    });


  } catch (error) {

    console.error(
      '❌ startDelivery error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to start delivery',

      error:
        error.message,

    });

  }

};


// =====================================================
// CONFIRM ARRIVAL
// =====================================================

const confirmArrival = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    const result =
      await db.query(
        `
        SELECT
          id,
          shopper_id,
          status,
          delivery_pin

        FROM orders

        WHERE
          id = $1
          AND shopper_id = $2

        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );


    if (result.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const order =
      result.rows[0];


    if (
      order.status === 'arrived' &&
      order.delivery_pin
    ) {

      return res.json({

        success: true,

        deliveryPin:
          order.delivery_pin,

        order: {

          id:
            order.id,

          shopperId:
            order.shopper_id,

          status:
            order.status,

          deliveryPin:
            order.delivery_pin,

        },

      });

    }


    if (
      order.status !==
        'out_for_delivery'
    ) {

      return res.status(409).json({

        success: false,

        message:
          `Cannot confirm arrival while order status is ${order.status}`,

      });

    }


    // -------------------------------------------------
    // GENERATE 6 DIGIT PIN
    // -------------------------------------------------

    const deliveryPin =
      Math.floor(
        100000 +
        Math.random() * 900000
      ).toString();


    const updateResult =
      await db.query(
        `
        UPDATE orders

        SET
          delivery_pin = $1,
          arrival_confirmed_at = NOW(),
          status = 'arrived',
          updated_at = NOW()

        WHERE
          id = $2
          AND shopper_id = $3
          AND status = 'out_for_delivery'

        RETURNING
          id,
          shopper_id,
          status,
          delivery_pin,
          arrival_confirmed_at,
          updated_at
        `,
        [
          deliveryPin,
          orderId,
          shopperId,
        ]
      );


    const updatedOrder =
      updateResult.rows[0];


    return res.json({

      success: true,

      deliveryPin:
        updatedOrder.delivery_pin,

      order: {

        id:
          updatedOrder.id,

        shopperId:
          updatedOrder.shopper_id,

        status:
          updatedOrder.status,

        deliveryPin:
          updatedOrder.delivery_pin,

        arrivalConfirmedAt:
          updatedOrder.arrival_confirmed_at,

        updatedAt:
          updatedOrder.updated_at,

      },

    });


  } catch (error) {

    console.error(
      '❌ confirmArrival error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to confirm arrival',

      error:
        error.message,

    });

  }

};


// =====================================================
// VERIFY DELIVERY PIN
// =====================================================

const verifyDeliveryPin = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);

    const pin =
      String(
        req.body.pin ||
        req.body.deliveryPin ||
        ''
      ).trim();


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    if (
      !/^\d{6}$/.test(pin)
    ) {

      return res.status(400).json({

        success: false,

        message:
          'A valid 6-digit delivery PIN is required',

      });

    }


    const result =
      await db.query(
        `
        SELECT
          id,
          shopper_id,
          status,
          delivery_pin

        FROM orders

        WHERE
          id = $1
          AND shopper_id = $2

        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );


    if (result.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const order =
      result.rows[0];


    if (
      order.status !== 'arrived'
    ) {

      return res.status(409).json({

        success: false,

        message:
          `Cannot verify delivery PIN while order status is ${order.status}`,

      });

    }


    if (
      String(order.delivery_pin) !==
      pin
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Invalid delivery PIN',

      });

    }


    const updateResult =
      await db.query(
        `
        UPDATE orders

        SET
          status = 'delivered',
          delivered_at = NOW(),
          updated_at = NOW()

        WHERE
          id = $1
          AND shopper_id = $2
          AND status = 'arrived'
          AND delivery_pin = $3

        RETURNING
          id,
          shopper_id,
          status,
          delivered_at,
          updated_at
        `,
        [
          orderId,
          shopperId,
          pin,
        ]
      );


    if (
      updateResult.rows.length === 0
    ) {

      return res.status(409).json({

        success: false,

        message:
          'Delivery could not be completed',

      });

    }


    const completedOrder =
      updateResult.rows[0];


    return res.json({

      success: true,

      verified: true,

      order: {

        id:
          completedOrder.id,

        shopperId:
          completedOrder.shopper_id,

        status:
          completedOrder.status,

        deliveredAt:
          completedOrder.delivered_at,

        updatedAt:
          completedOrder.updated_at,

      },

    });


  } catch (error) {

    console.error(
      '❌ verifyDeliveryPin error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to verify delivery PIN',

      error:
        error.message,

    });

  }

};


// =====================================================
// GET MY ORDERS
// =====================================================

const getMyOrders = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    const ordersResult =
      await db.query(
        `
        SELECT
          o.*,

          s.shop_name,
          s.image_url AS shop_image,

          s.latitude AS shop_latitude,
          s.longitude AS shop_longitude

        FROM orders o

        INNER JOIN shops s
          ON s.id = o.shop_id

        WHERE
          o.shopper_id = $1

        ORDER BY
          o.created_at DESC
        `,
        [shopperId]
      );


    const orders = [];


    for (
      const order
      of ordersResult.rows
    ) {

      const itemsResult =
        await db.query(
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

            voice_url,

            shopper_photo_url,
            shopping_status,
            found_quantity,
            found_weight,
            found_weight_unit,
            barcode_scanned,
            completed_at

          FROM order_items

          WHERE order_id = $1

          ORDER BY id ASC
          `,
          [order.id]
        );


      const orderItems =
        itemsResult.rows.map(
          (item) => ({

            id:
              item.id,

            orderId:
              item.order_id,

            productId:
              item.product_id,

            name:
              item.item_name,

            productName:
              item.item_name,

            quantity:
              item.quantity,

            amount:
              item.amount,

            unit:
              item.unit,

            price:
              item.price,

            custom:
              item.custom,

            details:
              item.details,

            image:
              item.image,

            // -----------------------------------------
            // CUSTOMER VOICE NOTE
            // -----------------------------------------

            voiceUrl:
              item.voice_url || null,

            shopperPhotoUrl:
              item.shopper_photo_url || null,

            shoppingStatus:
              item.shopping_status || 'pending',

            foundQuantity:
              item.found_quantity,

            foundWeight:
              item.found_weight,

            foundWeightUnit:
              item.found_weight_unit,

            barcodeScanned:
              item.barcode_scanned || false,

            completedAt:
              item.completed_at,

          })
        );


      orders.push({

        id:
          order.id,

        customerId:
          order.customer_id,

        shopId:
          order.shop_id,

        shopperId:
          order.shopper_id,


        store:
          order.shop_name,

        storeName:
          order.shop_name,

        shop:
          order.shop_name,


        shopImage:
          order.shop_image || null,


        pickupLatitude:
          order.shop_latitude !== null
            ? Number(order.shop_latitude)
            : null,

        pickupLongitude:
          order.shop_longitude !== null
            ? Number(order.shop_longitude)
            : null,


        customer:
          order.delivery_address,

        customerName:
          `Customer #${order.customer_id}`,

        phone:
          null,

        customerPhone:
          null,


        customerLatitude:
          Number(order.delivery_latitude),

        customerLongitude:
          Number(order.delivery_longitude),


        latitude:
          Number(order.delivery_latitude),

        longitude:
          Number(order.delivery_longitude),


        deliveryAddress:
          order.delivery_address,


        deliveryOption:
          order.delivery_option,

        paymentMethod:
          order.payment_method,


        itemsTotal:
          Number(order.items_total || 0),

        deliveryFee:
          Number(order.delivery_fee || 0),

        serviceFee:
          Number(order.service_fee || 0),

        totalAmount:
          Number(order.total_amount || 0),


        status:
          order.status,


        createdAt:
          order.created_at,

        updatedAt:
          order.updated_at,


        paymentId:
          order.payment_id || null,

        paymentStatus:
          order.payment_status || null,

        paidAt:
          order.paid_at || null,


        billUrl:
          order.bill_url || null,

        billUploadedAt:
          order.bill_uploaded_at || null,


        deliveryPin:
          order.delivery_pin || null,

        arrivalConfirmedAt:
          order.arrival_confirmed_at || null,

        deliveredAt:
          order.delivered_at || null,


        items:
          orderItems.length,

        shoppingList:
          orderItems,

        orderItems:
          orderItems,

      });

    }


    return res.json({

      success: true,

      count:
        orders.length,

      orders,

    });


  } catch (error) {

    console.error(
      '❌ getMyOrders error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to get shopper orders',

      error:
        error.message,

    });

  }

};


// =====================================================
// GET NEARBY SHOPPERS FOR ORDER
// =====================================================

const getNearbyShoppersForOrder = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    const orderResult =
      await db.query(
        `
        SELECT
          o.id,
          s.latitude AS shop_latitude,
          s.longitude AS shop_longitude

        FROM orders o

        INNER JOIN shops s
          ON s.id = o.shop_id

        WHERE
          o.id = $1

        LIMIT 1
        `,
        [orderId]
      );


    if (orderResult.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const order =
      orderResult.rows[0];


    const latitude =
      Number(order.shop_latitude);

    const longitude =
      Number(order.shop_longitude);


    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Shop coordinates are not available',

      });

    }


    const shoppersResult =
      await db.query(
        `
        SELECT
          id,
          latitude,
          longitude,
          status,

          (
            6371 * acos(
              LEAST(
                1,
                GREATEST(
                  -1,
                  cos(radians($1))
                  *
                  cos(radians(latitude))
                  *
                  cos(
                    radians(longitude)
                    -
                    radians($2)
                  )
                  +
                  sin(radians($1))
                  *
                  sin(radians(latitude))
                )
              )
            )
          ) AS distance_km

        FROM shoppers

        WHERE
          status = 'online'

          AND latitude IS NOT NULL
          AND longitude IS NOT NULL

          AND id != $3

        HAVING
          (
            6371 * acos(
              LEAST(
                1,
                GREATEST(
                  -1,
                  cos(radians($1))
                  *
                  cos(radians(latitude))
                  *
                  cos(
                    radians(longitude)
                    -
                    radians($2)
                  )
                  +
                  sin(radians($1))
                  *
                  sin(radians(latitude))
                )
              )
            )
          ) <= 10

        ORDER BY
          distance_km ASC
        `,
        [
          latitude,
          longitude,
          shopperId,
        ]
      );


    return res.json({

      success: true,

      count:
        shoppersResult.rows.length,

      shoppers:
        shoppersResult.rows.map(
          (shopper) => ({

            id:
              shopper.id,

            latitude:
              Number(shopper.latitude),

            longitude:
              Number(shopper.longitude),

            status:
              shopper.status,

            distanceKm:
              Number(
                shopper.distance_km
              ),

          })
        ),

    });


  } catch (error) {

    console.error(
      '❌ getNearbyShoppersForOrder error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to get nearby shoppers',

      error:
        error.message,

    });

  }

};


// =====================================================
// UPLOAD ITEM PHOTO
// =====================================================

const uploadItemPhoto = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);

    const itemId =
      Number(req.params.itemId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    if (!req.file) {

      return res.status(400).json({

        success: false,

        message:
          'Photo is required',

      });

    }


    // -------------------------------------------------
    // VERIFY ORDER
    // -------------------------------------------------

    const orderResult =
      await db.query(
        `
        SELECT id
        FROM orders
        WHERE
          id = $1
          AND shopper_id = $2
        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );


    if (orderResult.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    // -------------------------------------------------
    // VERIFY ITEM
    // -------------------------------------------------

    const itemResult =
      await db.query(
        `
        SELECT id
        FROM order_items
        WHERE
          id = $1
          AND order_id = $2
        LIMIT 1
        `,
        [
          itemId,
          orderId,
        ]
      );


    if (itemResult.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order item not found',
      });

    }


    const photoUrl =
      `${req.protocol}://${req.get('host')}/uploads/items/${req.file.filename}`;


    const foundQuantity =
      req.body.foundQuantity !== undefined
        ? Number(req.body.foundQuantity)
        : null;


    const foundWeight =
      req.body.foundWeight !== undefined
        ? Number(req.body.foundWeight)
        : null;


    const foundWeightUnit =
      req.body.foundWeightUnit ||
      null;


    const barcodeScanned =
      req.body.barcodeScanned === true ||
      req.body.barcodeScanned === 'true';


    const updateResult =
      await db.query(
        `
        UPDATE order_items

        SET
          shopper_photo_url = $1,
          shopping_status = 'done',

          found_quantity = $2,
          found_weight = $3,
          found_weight_unit = $4,

          barcode_scanned = $5,

          completed_at = NOW()

        WHERE
          id = $6
          AND order_id = $7

        RETURNING *
        `,
        [
          photoUrl,
          foundQuantity,
          foundWeight,
          foundWeightUnit,
          barcodeScanned,
          itemId,
          orderId,
        ]
      );


    return res.json({

      success: true,

      item: {

        id:
          updateResult.rows[0].id,

        orderId:
          updateResult.rows[0].order_id,

        name:
          updateResult.rows[0].item_name,

        image:
          updateResult.rows[0].image,

        voiceUrl:
          updateResult.rows[0].voice_url || null,

        shopperPhotoUrl:
          updateResult.rows[0].shopper_photo_url,

        shoppingStatus:
          updateResult.rows[0].shopping_status,

        foundQuantity:
          updateResult.rows[0].found_quantity,

        foundWeight:
          updateResult.rows[0].found_weight,

        foundWeightUnit:
          updateResult.rows[0].found_weight_unit,

        barcodeScanned:
          updateResult.rows[0].barcode_scanned,

        completedAt:
          updateResult.rows[0].completed_at,

      },

    });


  } catch (error) {

    console.error(
      '❌ uploadItemPhoto error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to upload item photo',

      error:
        error.message,

    });

  }

};


// =====================================================
// UPLOAD REPLACEMENT PHOTO
// =====================================================

const uploadReplacementPhoto = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);

    const itemId =
      Number(req.params.itemId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    if (!req.file) {

      return res.status(400).json({

        success: false,

        message:
          'Replacement photo is required',

      });

    }


    // -------------------------------------------------
    // VERIFY ORDER
    // -------------------------------------------------

    const orderResult =
      await db.query(
        `
        SELECT id
        FROM orders

        WHERE
          id = $1
          AND shopper_id = $2

        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );


    if (orderResult.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    // -------------------------------------------------
    // VERIFY ITEM
    // -------------------------------------------------

    const itemResult =
      await db.query(
        `
        SELECT id
        FROM order_items

        WHERE
          id = $1
          AND order_id = $2

        LIMIT 1
        `,
        [
          itemId,
          orderId,
        ]
      );


    if (itemResult.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order item not found',
      });

    }


    // -------------------------------------------------
    // NEXT OPTION NUMBER
    // -------------------------------------------------

    const optionResult =
      await db.query(
        `
        SELECT
          COALESCE(
            MAX(option_number),
            0
          ) + 1 AS next_option

        FROM replacement_items

        WHERE
          order_id = $1
          AND original_item_id = $2
        `,
        [
          orderId,
          itemId,
        ]
      );


    const optionNumber =
      Number(
        optionResult.rows[0]
          .next_option
      );


    const photoUrl =
      `${req.protocol}://${req.get('host')}/uploads/replacements/${req.file.filename}`;


    const insertResult =
      await db.query(
        `
        INSERT INTO replacement_items
        (
          order_id,
          original_item_id,
          shopper_id,
          option_number,
          photo_url,
          status
        )

        VALUES
        (
          $1,
          $2,
          $3,
          $4,
          $5,
          'waiting_customer'
        )

        RETURNING *
        `,
        [
          orderId,
          itemId,
          shopperId,
          optionNumber,
          photoUrl,
        ]
      );


    const replacement =
      insertResult.rows[0];


    return res.json({

      success: true,

      replacement: {

        id:
          replacement.id,

        orderId:
          replacement.order_id,

        originalItemId:
          replacement.original_item_id,

        shopperId:
          replacement.shopper_id,

        optionNumber:
          replacement.option_number,

        photoUrl:
          replacement.photo_url,

        status:
          replacement.status,

        createdAt:
          replacement.created_at,

        updatedAt:
          replacement.updated_at,

      },

    });


  } catch (error) {

    console.error(
      '❌ uploadReplacementPhoto error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to upload replacement photo',

      error:
        error.message,

    });

  }

};


// =====================================================
// UPDATE ITEM SHOPPING STATUS
// =====================================================

const updateItemShoppingStatus = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);

    const itemId =
      Number(req.params.itemId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    const orderResult =
      await db.query(
        `
        SELECT id
        FROM orders

        WHERE
          id = $1
          AND shopper_id = $2

        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );


    if (orderResult.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const foundQuantity =
      req.body.foundQuantity !== undefined
        ? Number(req.body.foundQuantity)
        : null;


    const foundWeight =
      req.body.foundWeight !== undefined
        ? Number(req.body.foundWeight)
        : null;


    const foundWeightUnit =
      req.body.foundWeightUnit ||
      null;


    const barcodeScanned =
      req.body.barcodeScanned === true ||
      req.body.barcodeScanned === 'true';


    const result =
      await db.query(
        `
        UPDATE order_items

        SET
          shopping_status = 'done',

          found_quantity = $1,
          found_weight = $2,
          found_weight_unit = $3,

          barcode_scanned = $4,

          completed_at = NOW()

        WHERE
          id = $5
          AND order_id = $6

        RETURNING *
        `,
        [
          foundQuantity,
          foundWeight,
          foundWeightUnit,
          barcodeScanned,
          itemId,
          orderId,
        ]
      );


    if (result.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order item not found',
      });

    }


    const item =
      result.rows[0];


    return res.json({

      success: true,

      item: {

        id:
          item.id,

        orderId:
          item.order_id,

        name:
          item.item_name,

        quantity:
          item.quantity,

        image:
          item.image,

        voiceUrl:
          item.voice_url || null,

        shoppingStatus:
          item.shopping_status,

        foundQuantity:
          item.found_quantity,

        foundWeight:
          item.found_weight,

        foundWeightUnit:
          item.found_weight_unit,

        barcodeScanned:
          item.barcode_scanned,

        completedAt:
          item.completed_at,

      },

    });


  } catch (error) {

    console.error(
      '❌ updateItemShoppingStatus error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to update item shopping status',

      error:
        error.message,

    });

  }

};


// =====================================================
// UPDATE ORDER PAYMENT
// =====================================================

const updateOrderPayment = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);

    const paymentId =
      req.body.paymentId;


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    if (!paymentId) {

      return res.status(400).json({

        success: false,

        message:
          'Payment ID is required',

      });

    }


    const result =
      await db.query(
        `
        UPDATE orders

        SET
          payment_id = $1,
          payment_status = 'paid',
          paid_at = NOW(),
          updated_at = NOW()

        WHERE
          id = $2
          AND shopper_id = $3

        RETURNING
          id,
          payment_id,
          payment_status,
          paid_at,
          updated_at
        `,
        [
          paymentId,
          orderId,
          shopperId,
        ]
      );


    if (result.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const order =
      result.rows[0];


    return res.json({

      success: true,

      payment: {

        paymentId:
          order.payment_id,

        paymentStatus:
          order.payment_status,

        paidAt:
          order.paid_at,

      },

      order: {

        id:
          order.id,

        paymentId:
          order.payment_id,

        paymentStatus:
          order.payment_status,

        paidAt:
          order.paid_at,

        updatedAt:
          order.updated_at,

      },

    });


  } catch (error) {

    console.error(
      '❌ updateOrderPayment error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to update payment',

      error:
        error.message,

    });

  }

};


// =====================================================
// UPLOAD BILL
// =====================================================

const uploadBill = async (
  req,
  res
) => {

  try {

    const shopperId =
      getShopperId(req);

    const orderId =
      Number(req.params.orderId);


    if (!shopperId) {

      return res.status(401).json({
        success: false,
        message:
          'Shopper authentication required',
      });

    }


    if (!req.file) {

      return res.status(400).json({

        success: false,

        message:
          'Bill image is required',

      });

    }


    const orderResult =
      await db.query(
        `
        SELECT id
        FROM orders

        WHERE
          id = $1
          AND shopper_id = $2

        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );


    if (orderResult.rows.length === 0) {

      return res.status(404).json({
        success: false,
        message:
          'Order not found',
      });

    }


    const billUrl =
      `${req.protocol}://${req.get('host')}/uploads/bills/${req.file.filename}`;


    const result =
      await db.query(
        `
        UPDATE orders

        SET
          bill_url = $1,
          bill_uploaded_at = NOW(),
          updated_at = NOW()

        WHERE
          id = $2
          AND shopper_id = $3

        RETURNING
          id,
          bill_url,
          bill_uploaded_at,
          updated_at
        `,
        [
          billUrl,
          orderId,
          shopperId,
        ]
      );


    const order =
      result.rows[0];


    return res.json({

      success: true,

      bill: {

        billUrl:
          order.bill_url,

        billUploadedAt:
          order.bill_uploaded_at,

      },

      order: {

        id:
          order.id,

        billUrl:
          order.bill_url,

        billUploadedAt:
          order.bill_uploaded_at,

        updatedAt:
          order.updated_at,

      },

    });


  } catch (error) {

    console.error(
      '❌ uploadBill error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to upload bill',

      error:
        error.message,

    });

  }

};


// =====================================================
// EXPORTS
// =====================================================

module.exports = {

  getAvailableOrders,

  acceptOrder,

  startShopping,

  startDelivery,

  confirmArrival,

  verifyDeliveryPin,

  getMyOrders,

  getMyOrderById,

  getNearbyShoppersForOrder,

  uploadItemPhoto,

  uploadReplacementPhoto,

  updateItemShoppingStatus,

  updateOrderPayment,

  uploadBill,

};