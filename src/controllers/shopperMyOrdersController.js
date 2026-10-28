
// =====================================================
// SHOPPER MY ORDERS CONTROLLER
// =====================================================

const pool = require('../config/db');
const { SHOPPER_PAY_SQL } = require('./shopperPay');
const { paymentStatesFor } = require('../payments/orderPaymentState');
const { moneyFlowsFor } = require('../payments/orderMoneyFlows');

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
// GET SHOP IMAGE
// Supports common shop image field names
// =====================================================

const getShopImage = (shop) => {
  if (!shop) return null;

  return (
    shop.shop_image_url ||
    shop.shopImageUrl ||
    shop.shop_image ||
    shop.shopImage ||
    shop.image_url ||
    shop.imageUrl ||
    shop.image ||
    shop.photo_url ||
    shop.photoUrl ||
    null
  );
};

// =====================================================
// GET MY ORDERS
// GET /api/shopper/orders/my
// =====================================================

const getMyOrders = async (req, res) => {
  try {
    const shopperId = getShopperId(req);

    if (!shopperId) {
      return res.status(401).json({
        success: false,
        message: 'Shopper authentication required',
      });
    }

    // -------------------------------------------------
    // LOAD ORDERS, SHOPS, AND ORDER ITEMS
    // -------------------------------------------------

    const result = await pool.query(
      `
      SELECT
        o.*,

        -- Same customer contact as GET /orders/:id, so screens that
        -- merge both responses don't lose the phone (call button)
        c.full_name AS customer_name,
        COALESCE(o.contact_phone, c.mobile) AS customer_phone,

        -- The shopper's pay (settled earnings once recorded), so the
        -- completed batches list never shows the customer's total.
        -- Cancelled: only what was recorded (failed delivery fee)
        (CASE
          WHEN o.status = 'cancelled' THEN COALESCE(
            (SELECT se.net_amount FROM shopper_earnings se WHERE se.order_id = o.id AND se.status <> 'void'),
            0
          )
          ELSE ${SHOPPER_PAY_SQL}
        END)::float AS shopper_earnings,

        COALESCE(
          (
            SELECT json_agg(shop_data.shop ORDER BY shop_data.id)
            FROM (
              SELECT DISTINCT
                s.id,
                to_jsonb(s) AS shop
              FROM order_shops os

              LEFT JOIN shops s
                ON s.id = COALESCE(os.shop_id, o.shop_id)

              WHERE os.order_id = o.id
                AND s.id IS NOT NULL

              UNION

              SELECT
                s.id,
                to_jsonb(s) AS shop
              FROM shops s

              WHERE s.id = o.shop_id

                AND NOT EXISTS (
                  SELECT 1
                  FROM order_shops os2
                  WHERE os2.order_id = o.id
                )
            ) AS shop_data
          ),
          '[]'::json
        ) AS shops,

        COALESCE(
          (
            SELECT json_agg(
              -- Barcodes the ShopperApp verifies scans against
              to_jsonb(oi) || jsonb_build_object(
                'product_barcode', p.barcode,
                'replacement_product_barcode', rp.barcode
              )
              ORDER BY oi.id
            )
            FROM order_items oi
            LEFT JOIN products p
              ON p.id = oi.product_id
            LEFT JOIN products rp
              ON rp.id = oi.replacement_product_id
            WHERE oi.order_id = o.id
          ),
          '[]'::json
        ) AS items,

        (
          SELECT COUNT(*)::integer
          FROM order_items oi
          WHERE oi.order_id = o.id
        ) AS total_items

      FROM orders o

      LEFT JOIN customers c
        ON c.id = o.customer_id

      WHERE o.shopper_id = $1

      ORDER BY o.id DESC
      `,
      [shopperId]
    );

    // -------------------------------------------------
    // NORMALIZE ORDERS AND SHOP DETAILS
    // -------------------------------------------------

    const orders = result.rows.map((order) => {
      const shops = Array.isArray(order.shops)
        ? order.shops.map((shop) => {
            // The SQL query returns each shop as JSON.
            // Support both direct shop objects and wrapped objects.
            return shop?.shop || shop;
          })
        : [];

      const items = Array.isArray(order.items)
        ? order.items
        : [];

      const firstShop = shops[0] || null;

      const shopName =
        firstShop?.shop_name ||
        firstShop?.shopName ||
        firstShop?.name ||
        null;

      const shopImage = getShopImage(firstShop);

      // -------------------------------------------------
      // GROUP ITEMS BY SHOP
      // -------------------------------------------------

      const shopsWithItems = shops.map((shop) => {
        const shopId = Number(shop?.id);

        const shopItems = items.filter((item) => {
          const itemShopId = item?.shop_id;

          // If the item has a shop_id, match it to this shop.
          if (
            itemShopId !== null &&
            itemShopId !== undefined
          ) {
            return Number(itemShopId) === shopId;
          }

          // If an item has no shop_id and the order has
          // only one shop, assign it to that shop.
          if (shops.length === 1) {
            return true;
          }

          // Do not assign unlinked items to an arbitrary
          // shop in a multi-shop order.
          return false;
        });

        return {
          ...shop,
          items: shopItems,
          totalItems: shopItems.length,
        };
      });

      // -------------------------------------------------
      // RESPONSE ORDER OBJECT
      // -------------------------------------------------

      return {
        ...order,

        // Complete shop list, including shop-wise items
        shops: shopsWithItems,

        // All item entries for this order
        items,

        // Each order_items row counts as one item.
        // Quantity is intentionally NOT summed.
        totalItems: items.length,

        // Compatibility alias
        total_items: items.length,

        shopNames: shopsWithItems
          .map(
            (shop) =>
              shop?.shop_name ||
              shop?.shopName ||
              shop?.name ||
              null
          )
          .filter(Boolean),

        // Compatibility fields for existing UI
        shop: shopName,
        shopName,
        shopImage,

        // Customer contact (same fields as the order details API)
        customerName: order.customer_name || `Customer #${order.customer_id ?? ''}`,
        customer_name: order.customer_name || `Customer #${order.customer_id ?? ''}`,
        customerPhone: order.customer_phone || null,
        customer_phone: order.customer_phone || null,
        phone: order.customer_phone || null,

        shop_id:
          firstShop?.id ??
          order.shop_id ??
          null,

        shopId:
          firstShop?.id ??
          order.shop_id ??
          null,
      };
    });

    // -------------------------------------------------
    // RESPONSE
    // -------------------------------------------------

    res.set('Cache-Control', 'no-store');

    // Each order's customer payment from the real records
    // (payments/orderPaymentState.js)
    const paymentStates = await paymentStatesFor(orders);
    const moneyFlows = await moneyFlowsFor(orders, shopperId);

    return res.status(200).json({
      success: true,
      orders: orders.map((order) => ({
        ...order,
        paymentState: paymentStates.get(Number(order.id)) || null,
        // Store payments + reimbursement (payments/orderMoneyFlows.js)
        moneyFlows: moneyFlows.get(Number(order.id)) || null,
      })),
    });
  } catch (error) {
    console.error('❌ getMyOrders error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to load shopper orders',
      error:
        process.env.NODE_ENV === 'development'
          ? error.message
          : undefined,
    });
  }
};

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  getMyOrders,
};
