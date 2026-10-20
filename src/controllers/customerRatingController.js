const pool = require('../config/db');

// =====================================================
// ORDER RATINGS
// The customer rates a delivered order (Instacart-style):
// 1–5 stars, quick tags, optional comment. One rating per
// order; sending again updates it.
// =====================================================

// Quick tags the app offers (anything else is dropped)
const RATING_TAGS = [
  'great_communication',
  'good_replacements',
  'careful_handling',
  'fast_delivery',
  'friendly',
  'missing_items',
  'wrong_items',
  'damaged_items',
  'late_delivery',
  'poor_communication',
];

const MAX_COMMENT_LENGTH = 500;

const toRatingResponse = (row) => ({
  orderId: Number(row.order_id),
  rating: Number(row.rating),
  tags: row.tags || [],
  comment: row.comment || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// =====================================================
// RATE ORDER
// POST /api/customer/orders/:orderId/rating
// Body: rating (1-5), tags [string], comment
// =====================================================

const rateOrder = async (req, res) => {
  const customerId = req.customer.customerId;
  const orderId = Number(req.params.orderId);
  const rating = Number(req.body?.rating);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid order' });
  }

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, message: 'Choose 1 to 5 stars' });
  }

  const tags = Array.isArray(req.body?.tags)
    ? [...new Set(req.body.tags.map(String))].filter((tag) => RATING_TAGS.includes(tag))
    : [];

  const comment = String(req.body?.comment || '').trim().slice(0, MAX_COMMENT_LENGTH) || null;

  try {
    const orderResult = await pool.query(
      'SELECT id, status, shopper_id FROM orders WHERE id = $1 AND customer_id = $2',
      [orderId, customerId]
    );

    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (order.status !== 'delivered') {
      return res.status(400).json({
        success: false,
        message: 'You can rate an order after it is delivered',
      });
    }

    const result = await pool.query(
      `
      INSERT INTO order_ratings (order_id, customer_id, shopper_id, rating, tags, comment)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (order_id) DO UPDATE
        SET rating = EXCLUDED.rating,
            tags = EXCLUDED.tags,
            comment = EXCLUDED.comment,
            updated_at = NOW()
      RETURNING *
      `,
      [orderId, customerId, order.shopper_id, rating, tags, comment]
    );

    const saved = toRatingResponse(result.rows[0]);

    // Let the shopper app show the new rating
    if (order.shopper_id) {
      req.app.get('io')?.to(`shopper:${order.shopper_id}`).emit('order-rated', {
        orderId,
        rating,
      });
    }

    return res.json({ success: true, rating: saved });
  } catch (error) {
    console.error('❌ rateOrder error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to save your rating' });
  }
};

// =====================================================
// MY RATINGS
// GET /api/customer/order-ratings
// Every rating this customer has given (keyed by order in the app)
// =====================================================

const getMyRatings = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM order_ratings WHERE customer_id = $1 ORDER BY created_at DESC',
      [req.customer.customerId]
    );

    return res.json({ success: true, ratings: result.rows.map(toRatingResponse) });
  } catch (error) {
    console.error('❌ getMyRatings error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load your ratings' });
  }
};

module.exports = {
  RATING_TAGS,
  rateOrder,
  getMyRatings,
};
