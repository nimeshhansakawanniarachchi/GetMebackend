const pool = require('../config/db');


// ==================================================
// FORMAT ORDER ID
// ==================================================

const formatOrderId = (id) => {

  return `#GM${String(id).padStart(5, '0')}`;

};


// ==================================================
// FORMAT STATUS
// ==================================================

const formatStatus = (status) => {

  switch (status) {

    case 'waiting_for_shopper':
      return 'Waiting for Shopper';

    case 'shopper_accepted':
      return 'Shopper Accepted';

    case 'shopping':
      return 'Shopping';

    case 'out_for_delivery':
      return 'Out for Delivery';

    case 'delivered':
      return 'Delivered';

    case 'cancelled':
      return 'Cancelled';

    default:
      return status || 'Unknown';

  }

};


// ==================================================
// DASHBOARD
// ==================================================

const getDashboard = async (
  req,
  res
) => {

  try {

    const totalOrdersResult =
      await pool.query(`
        SELECT COUNT(*) AS count
        FROM orders
      `);


    const totalCustomersResult =
      await pool.query(`
        SELECT COUNT(*) AS count
        FROM customers
      `);


    const totalShopsResult =
      await pool.query(`
        SELECT COUNT(*) AS count
        FROM shops
      `);


    const todaySalesResult =
      await pool.query(`
        SELECT
          COALESCE(
            SUM(total_amount),
            0
          ) AS total
        FROM orders
        WHERE
          DATE(created_at) =
          CURRENT_DATE
          AND status != 'cancelled'
      `);


    const statusResult =
      await pool.query(`
        SELECT
          status,
          COUNT(*) AS count
        FROM orders
        GROUP BY status
      `);


    const statusCounts = {

      waiting_for_shopper: 0,

      shopper_accepted: 0,

      shopping: 0,

      out_for_delivery: 0,

      delivered: 0,

      cancelled: 0,

    };


    statusResult.rows.forEach(
      (row) => {

        statusCounts[
          row.status
        ] = Number(
          row.count
        );

      }
    );


    const recentOrdersResult =
      await pool.query(`
        SELECT

          o.id,

          o.total_amount,

          o.status,

          o.created_at,

          c.full_name
            AS customer_name,

          s.shop_name
            AS shop_name

        FROM orders o

        LEFT JOIN customers c
          ON c.id = o.customer_id

        LEFT JOIN shops s
          ON s.id = o.shop_id

        ORDER BY
          o.created_at DESC

        LIMIT 5
      `);


    const recentOrders =
      recentOrdersResult.rows.map(
        (order) => ({

          id:
            formatOrderId(
              order.id
            ),

          databaseId:
            order.id,

          customer:
            order.customer_name ||
            'Unknown Customer',

          shop:
            order.shop_name ||
            'Unknown Shop',

          total:
            `LKR ${Number(
              order.total_amount || 0
            ).toFixed(2)}`,

          status:
            formatStatus(
              order.status
            ),

          databaseStatus:
            order.status,

          date:
            order.created_at,

        })
      );


    return res.json({

      success: true,

      stats: {

        totalOrders:
          Number(
            totalOrdersResult
              .rows[0]
              .count
          ),

        totalCustomers:
          Number(
            totalCustomersResult
              .rows[0]
              .count
          ),

        totalShops:
          Number(
            totalShopsResult
              .rows[0]
              .count
          ),

        todaySales:
          Number(
            todaySalesResult
              .rows[0]
              .total || 0
          ),

      },

      orderOverview: {

        waitingForShopper:
          statusCounts
            .waiting_for_shopper,

        shopperAccepted:
          statusCounts
            .shopper_accepted,

        shopping:
          statusCounts
            .shopping,

        outForDelivery:
          statusCounts
            .out_for_delivery,

        delivered:
          statusCounts
            .delivered,

        cancelled:
          statusCounts
            .cancelled,

      },

      recentOrders,

    });

  } catch (error) {

    console.error(
      '❌ Admin dashboard error:',
      error
    );

    return res.status(500).json({

      success: false,

      message:
        'Failed to load dashboard',

    });

  }

};


// ==================================================
// ALL ORDERS
// ==================================================

const getOrders = async (
  req,
  res
) => {

  try {

    const result =
      await pool.query(`
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

          c.full_name
            AS customer_name,

          c.mobile
            AS customer_mobile,

          c.email
            AS customer_email,

          s.shop_name
            AS shop_name,

          s.address
            AS shop_address,

          s.mobile
            AS shop_mobile

        FROM orders o

        LEFT JOIN customers c
          ON c.id = o.customer_id

        LEFT JOIN shops s
          ON s.id = o.shop_id

        ORDER BY
          o.created_at DESC
      `);


    const orders =
      await Promise.all(

        result.rows.map(
          async (order) => {

            const itemsResult =
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

                  created_at

                FROM order_items

                WHERE
                  order_id = $1

                ORDER BY
                  id ASC
                `,
                [
                  order.id
                ]
              );


            const itemCount =
              itemsResult.rows.reduce(
                (
                  total,
                  item
                ) => {

                  return (
                    total +
                    Number(
                      item.quantity || 0
                    )
                  );

                },
                0
              );


            const itemsList =
              itemsResult.rows.map(
                (item) => ({

                  id:
                    item.id,

                  orderId:
                    item.order_id,

                  productId:
                    item.product_id,

                  itemName:
                    item.item_name,

                  quantity:
                    Number(
                      item.quantity || 0
                    ),

                  amount:
                    Number(
                      item.amount || 0
                    ),

                  unit:
                    item.unit ||
                    null,

                  price:
                    Number(
                      item.price || 0
                    ),

                  custom:
                    item.custom,

                  details:
                    item.details ||
                    '',

                  image:
                    item.image ||
                    '',

                  createdAt:
                    item.created_at,

                })
              );


            return {

              id:
                formatOrderId(
                  order.id
                ),

              databaseId:
                order.id,


              customer:
                order.customer_name ||
                'Unknown Customer',

              customerId:
                order.customer_id,

              customerMobile:
                order.customer_mobile ||
                '',

              customerEmail:
                order.customer_email ||
                '',


              shop:
                order.shop_name ||
                'Unknown Shop',

              shopId:
                order.shop_id,

              shopAddress:
                order.shop_address ||
                '',

              shopMobile:
                order.shop_mobile ||
                '',


              shopper:
                'Not Assigned',


              items:
                itemCount,

              itemsList,


              itemsTotal:
                Number(
                  order.items_total || 0
                ),

              deliveryFee:
                Number(
                  order.delivery_fee || 0
                ),

              serviceFee:
                Number(
                  order.service_fee || 0
                ),

              totalAmount:
                Number(
                  order.total_amount || 0
                ),

              total:
                `LKR ${Number(
                  order.total_amount || 0
                ).toFixed(2)}`,


              deliveryAddress:
                order.delivery_address,

              deliveryLatitude:
                Number(
                  order.delivery_latitude
                ),

              deliveryLongitude:
                Number(
                  order.delivery_longitude
                ),

              deliveryOption:
                order.delivery_option,

              paymentMethod:
                order.payment_method,


              status:
                formatStatus(
                  order.status
                ),

              databaseStatus:
                order.status,


              date:
                order.created_at,

              updatedAt:
                order.updated_at,

            };

          }
        )
      );


    return res.json({

      success: true,

      count:
        orders.length,

      orders,

    });

  } catch (error) {

    console.error(
      '❌ Admin orders error:',
      error
    );

    return res.status(500).json({

      success: false,

      message:
        'Failed to load orders',

    });

  }

};


// ==================================================
// SINGLE ORDER
// ==================================================

const getOrderById = async (
  req,
  res
) => {

  try {

    const {
      orderId
    } = req.params;


    const result =
      await pool.query(
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

          c.full_name
            AS customer_name,

          c.mobile
            AS customer_mobile,

          c.email
            AS customer_email,

          s.shop_name
            AS shop_name,

          s.address
            AS shop_address,

          s.mobile
            AS shop_mobile

        FROM orders o

        LEFT JOIN customers c
          ON c.id = o.customer_id

        LEFT JOIN shops s
          ON s.id = o.shop_id

        WHERE
          o.id = $1

        LIMIT 1
        `,
        [
          orderId
        ]
      );


    if (
      result.rows.length === 0
    ) {

      return res.status(404).json({

        success: false,

        message:
          'Order not found',

      });

    }


    const order =
      result.rows[0];


    const itemsResult =
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

          created_at

        FROM order_items

        WHERE
          order_id = $1

        ORDER BY
          id ASC
        `,
        [
          order.id
        ]
      );


    const itemCount =
      itemsResult.rows.reduce(
        (
          total,
          item
        ) => {

          return (
            total +
            Number(
              item.quantity || 0
            )
          );

        },
        0
      );


    const itemsList =
      itemsResult.rows.map(
        (item) => ({

          id:
            item.id,

          orderId:
            item.order_id,

          productId:
            item.product_id,

          itemName:
            item.item_name,

          quantity:
            Number(
              item.quantity || 0
            ),

          amount:
            Number(
              item.amount || 0
            ),

          unit:
            item.unit ||
            null,

          price:
            Number(
              item.price || 0
            ),

          custom:
            item.custom,

          details:
            item.details ||
            '',

          image:
            item.image ||
            '',

          createdAt:
            item.created_at,

        })
      );


    const formattedOrder = {

      id:
        formatOrderId(
          order.id
        ),

      databaseId:
        order.id,


      customer:
        order.customer_name ||
        'Unknown Customer',

      customerId:
        order.customer_id,

      customerMobile:
        order.customer_mobile ||
        '',

      customerEmail:
        order.customer_email ||
        '',


      shop:
        order.shop_name ||
        'Unknown Shop',

      shopId:
        order.shop_id,

      shopAddress:
        order.shop_address ||
        '',

      shopMobile:
        order.shop_mobile ||
        '',


      shopper:
        'Not Assigned',


      items:
        itemCount,

      itemsList,


      itemsTotal:
        Number(
          order.items_total || 0
        ),

      deliveryFee:
        Number(
          order.delivery_fee || 0
        ),

      serviceFee:
        Number(
          order.service_fee || 0
        ),

      totalAmount:
        Number(
          order.total_amount || 0
        ),

      total:
        `LKR ${Number(
          order.total_amount || 0
        ).toFixed(2)}`,


      deliveryAddress:
        order.delivery_address,

      deliveryLatitude:
        Number(
          order.delivery_latitude
        ),

      deliveryLongitude:
        Number(
          order.delivery_longitude
        ),

      deliveryOption:
        order.delivery_option,

      paymentMethod:
        order.payment_method,


      status:
        formatStatus(
          order.status
        ),

      databaseStatus:
        order.status,


      date:
        order.created_at,

      updatedAt:
        order.updated_at,

    };


    return res.json({

      success: true,

      order:
        formattedOrder,

    });

  } catch (error) {

    console.error(
      '❌ Admin order details error:',
      error
    );

    return res.status(500).json({

      success: false,

      message:
        'Failed to load order',

    });

  }

};


// ==================================================
// CUSTOMERS
// ==================================================

const getCustomers = async (
  req,
  res
) => {

  try {

    const result =
      await pool.query(`
        SELECT

          c.id,

          c.full_name,

          c.mobile,

          c.email,

          c.created_at,

          COUNT(o.id)
            AS order_count,

          COALESCE(
            SUM(
              CASE
                WHEN o.status != 'cancelled'
                THEN o.total_amount
                ELSE 0
              END
            ),
            0
          ) AS total_spent

        FROM customers c

        LEFT JOIN orders o
          ON o.customer_id = c.id

        GROUP BY

          c.id,

          c.full_name,

          c.mobile,

          c.email,

          c.created_at

        ORDER BY
          c.created_at DESC
      `);


    const customers =
      result.rows.map(
        (customer) => ({

          id:
            customer.id,

          name:
            customer.full_name ||
            'Unknown Customer',

          mobile:
            customer.mobile ||
            '',

          email:
            customer.email ||
            '',

          orders:
            Number(
              customer.order_count || 0
            ),

          totalSpent:
            Number(
              customer.total_spent || 0
            ),

          joinedDate:
            customer.created_at,

        })
      );


    return res.json({

      success: true,

      count:
        customers.length,

      customers,

    });

  } catch (error) {

    console.error(
      '❌ Admin customers error:',
      error
    );

    return res.status(500).json({

      success: false,

      message:
        'Failed to load customers',

    });

  }

};


// ==================================================
// REGISTERED SHOPS
// ==================================================

const getShops = async (
  req,
  res
) => {

  try {

    const result =
      await pool.query(`
        SELECT

          id,

          shop_name,

          email,

          mobile,

          address,

          status,

          image_url,

          latitude,

          longitude,

          created_at,

          updated_at

        FROM shops

        ORDER BY
          created_at DESC
      `);


    const shops =
      result.rows.map(
        (shop) => ({

          id:
            shop.id,

          name:
            shop.shop_name ||
            'Unknown Shop',

          email:
            shop.email ||
            '',

          mobile:
            shop.mobile ||
            '',

          address:
            shop.address ||
            '',

          status:
            shop.status ||
            'pending',

          image:
            shop.image_url ||
            '',

          latitude:
            shop.latitude !== null
              ? Number(
                  shop.latitude
                )
              : null,

          longitude:
            shop.longitude !== null
              ? Number(
                  shop.longitude
                )
              : null,

          createdAt:
            shop.created_at,

          updatedAt:
            shop.updated_at,

        })
      );


    return res.json({

      success: true,

      count:
        shops.length,

      shops,

    });

  } catch (error) {

    console.error(
      '❌ Admin shops error:',
      error
    );

    return res.status(500).json({

      success: false,

      message:
        'Failed to load shops',

    });

  }

};





// ==================================================
// PRODUCTS
// ==================================================

const getProducts = async (
  req,
  res
) => {

  try {

    const result =
      await pool.query(`
        SELECT

          p.id,

          p.shop_id,

          p.product_name,

          p.category,

          p.price,

          p.stock_quantity,

          p.description,

          p.image_url,

          p.is_available,

          p.created_at,

          p.updated_at,

          s.shop_name

        FROM products p

        LEFT JOIN shops s
          ON s.id = p.shop_id

        ORDER BY
          p.created_at DESC
      `);


    const products =
      result.rows.map(
        (product) => ({

          id:
            product.id,

          shopId:
            product.shop_id,

          shopName:
            product.shop_name ||
            'Unknown Shop',

          name:
            product.product_name ||
            'Unknown Product',

          category:
            product.category ||
            '',

          price:
            Number(
              product.price || 0
            ),

          stockQuantity:
            Number(
              product.stock_quantity || 0
            ),

          description:
            product.description ||
            '',

          image:
            product.image_url ||
            '',

          isAvailable:
            product.is_available,

          createdAt:
            product.created_at,

          updatedAt:
            product.updated_at,

        })
      );


    return res.json({

      success: true,

      count:
        products.length,

      products,

    });

  } catch (error) {

    console.error(
      '❌ Admin products error:',
      error
    );

    return res.status(500).json({

      success: false,

      message:
        'Failed to load products',

    });

  }

};






// ==================================================
// EXPORTS
// ==================================================

module.exports = {

  getDashboard,

  getOrders,

  getOrderById,

  getCustomers,

  getShops,

   getProducts,

};