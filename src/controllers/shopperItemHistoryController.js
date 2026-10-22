const pool = require('../config/db');

// =====================================================
// LAST FOUND (ShopperApp "Item might still be here" sheet)
// GET /api/shopper/products/:productId/last-found
//     ?shopId=&excludeOrderId=
//
// The most recent time this product was found (status 'found', or
// 'done'/'completed' with a found quantity) at this
// shop within LAST_FOUND_DAYS, from any shopper's order (except
// the current one). Only the finding shopper's first name is
// returned. { lastFound: { foundAt, shopperFirstName } | null }
// =====================================================

const LAST_FOUND_DAYS = 7;

const toPositiveInt = (value) => {
  const number = Number(value);

  return Number.isInteger(number) && number > 0 ? number : null;
};

const getLastFound = async (req, res) => {
  try {
    const productId = toPositiveInt(req.params.productId);
    const shopId = toPositiveInt(req.query.shopId);
    const excludeOrderId = toPositiveInt(req.query.excludeOrderId);

    if (!productId || !shopId) {
      return res.status(400).json({
        success: false,
        message: 'Valid productId and shopId are required',
      });
    }

    const result = await pool.query(
      `
      SELECT
        oi.completed_at AS found_at,
        s.full_name AS shopper_name
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      LEFT JOIN shoppers s ON s.id = o.shopper_id
      WHERE oi.product_id = $1
        AND COALESCE(oi.shop_id, o.shop_id) = $2
        -- The app saves 'found', then 'done' after the photo; 'done'
        -- with found_quantity 0 means refunded / not found
        AND oi.shopping_status IN ('found', 'done', 'completed')
        AND COALESCE(oi.found_quantity, 1) > 0
        AND oi.completed_at IS NOT NULL
        AND oi.completed_at >= NOW() - ($3 || ' days')::interval
        AND ($4::int IS NULL OR oi.order_id <> $4::int)
      ORDER BY oi.completed_at DESC
      LIMIT 1
      `,
      [productId, shopId, String(LAST_FOUND_DAYS), excludeOrderId]
    );

    const row = result.rows[0];

    return res.json({
      success: true,
      lastFound: row
        ? {
            foundAt: row.found_at,
            // First name only - no other shopper details
            shopperFirstName:
              String(row.shopper_name || '').trim().split(/\s+/)[0] || null,
          }
        : null,
    });
  } catch (error) {
    console.error('Get last found error:', error);

    return res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

module.exports = {
  getLastFound,
};
