
// =====================================================
// SHOPPER NEARBY CONTROLLER
// =====================================================

const pool = require('../config/db');

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
// GET NEARBY SHOPPERS FOR ORDER
// GET /api/shopper/orders/:orderId/nearby-shoppers
// =====================================================

const getNearbyShoppersForOrder = async (req, res) => {
  try {
    const shopperId = getShopperId(req);
    const orderId = Number(req.params.orderId);

    // -------------------------------------------------
    // VALIDATE SHOPPER
    // -------------------------------------------------

    if (!shopperId) {
      return res.status(401).json({
        success: false,
        message: 'Shopper authentication required',
      });
    }

    // -------------------------------------------------
    // VALIDATE ORDER ID
    // -------------------------------------------------

    if (
      !Number.isInteger(orderId) ||
      orderId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID',
      });
    }

    // -------------------------------------------------
    // VERIFY ORDER OWNERSHIP
    // -------------------------------------------------

    const orderResult = await pool.query(
      `
      SELECT
        id,
        shopper_id,
        status
      FROM orders
      WHERE id = $1
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
        message: 'Order not found for this shopper',
      });
    }

    // -------------------------------------------------
    // GET SHOPS ASSOCIATED WITH THE ORDER
    // -------------------------------------------------

    const shopsResult = await pool.query(
      `
      SELECT
        os.shop_id,
        s.name AS shop_name,
        s.latitude,
        s.longitude
      FROM order_shops os
      INNER JOIN shops s
        ON s.id = os.shop_id
      WHERE os.order_id = $1
      ORDER BY os.shop_id ASC
      `,
      [orderId]
    );

    // -------------------------------------------------
    // RESPONSE
    // -------------------------------------------------

    return res.status(200).json({
      success: true,

      orderId: Number(orderId),

      orderStatus:
        orderResult.rows[0].status,

      shops: shopsResult.rows.map((shop) => ({
        shopId: Number(shop.shop_id),
        shopName: shop.shop_name,

        latitude:
          shop.latitude == null
            ? null
            : Number(shop.latitude),

        longitude:
          shop.longitude == null
            ? null
            : Number(shop.longitude),
      })),
    });

  } catch (error) {
    console.error(
      '❌ getNearbyShoppersForOrder error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to get nearby shopper information',
    });
  }
};

// =====================================================
// EXPORT
// =====================================================

module.exports = {
  getNearbyShoppersForOrder,
};
