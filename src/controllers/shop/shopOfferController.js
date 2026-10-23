const pool = require('../../config/db');

const {
  offerLabel,
  offerStatus,
  validateOffer,
} = require('../../pricing/offers');

// =====================================================
// SHOP OFFERS (GetMe-Shop "Offers" page)
// A shop's own discounts on its products. Pricing rules live in
// pricing/offers.js; an admin pause can't be undone here.
// =====================================================

// Orders that used the offer (not cancelled) and what customers
// saved: (shelf - offer unit price) x units bought.
// order_items.price is the pack price, so price / unit_price is
// the units in one pack.
const OFFER_SELECT = `
  SELECT
    o.*,
    p.product_name,
    p.price AS product_price,
    COALESCE(u.orders, 0)::int AS used_orders,
    COALESCE(u.savings, 0)::float AS used_savings
  FROM product_offers o
  LEFT JOIN products p ON p.id = o.product_id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(DISTINCT oi.order_id) AS orders,
      SUM(
        (oi.original_unit_price - oi.unit_price)
        * (oi.price / NULLIF(oi.unit_price, 0))
        * oi.quantity
      ) AS savings
    FROM order_items oi
    INNER JOIN orders ord ON ord.id = oi.order_id
    WHERE oi.offer_id = o.id
      AND ord.status NOT IN ('cancelled', 'shopper_search_cancelled')
  ) u ON TRUE
`;

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const toOffer = (row) => ({
  id: row.id,
  shopId: row.shop_id,
  scope: row.scope,
  productId: row.product_id,
  productName: row.product_name || null,
  productPrice: row.product_price != null ? Number(row.product_price) : null,
  // Price after the offer, for one-product offers
  offerPrice:
    row.scope === 'product' && row.product_price != null
      ? row.discount_type === 'percent'
        ? round2(Number(row.product_price) * (1 - Number(row.discount_value) / 100))
        : Number(row.discount_value)
      : null,
  category: row.category,
  discountType: row.discount_type,
  discountValue: Number(row.discount_value),
  title: row.title,
  label: offerLabel(row),
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  isActive: row.is_active,
  pausedByAdmin: row.paused_by_admin,
  adminNote: row.admin_note,
  // live | scheduled | ended | off | paused_by_admin
  status: offerStatus(row),
  usedOrders: Number(row.used_orders || 0),
  usedSavings: round2(row.used_savings || 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const offerIdOf = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const loadOwnOffer = async (offerId, shopId) => {
  const result = await pool.query(
    `${OFFER_SELECT} WHERE o.id = $1 AND o.shop_id = $2`,
    [offerId, shopId]
  );

  return result.rows[0] || null;
};

// The product for a one-product offer, if it's this shop's
const loadOwnProduct = async (productId, shopId) => {
  const id = Number(productId);

  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const result = await pool.query(
    'SELECT id, product_name, price FROM products WHERE id = $1 AND shop_id = $2',
    [id, shopId]
  );

  return result.rows[0] || null;
};

// =====================================================
// LIST (+ the shop's categories for the form)
// GET /api/shop/offers
// =====================================================

const getOffers = async (req, res) => {
  try {
    const [offers, categories] = await Promise.all([
      pool.query(
        `${OFFER_SELECT} WHERE o.shop_id = $1 ORDER BY o.created_at DESC`,
        [req.shop.shopId]
      ),
      pool.query(
        'SELECT DISTINCT category FROM products WHERE shop_id = $1 ORDER BY category',
        [req.shop.shopId]
      ),
    ]);

    return res.json({
      success: true,
      offers: offers.rows.map(toOffer),
      categories: categories.rows.map((row) => row.category).filter(Boolean),
    });
  } catch (error) {
    console.error('❌ getOffers error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load offers' });
  }
};

// =====================================================
// CREATE
// POST /api/shop/offers
// { scope, productId?, category?, discountType, discountValue,
//   title?, startsAt?, endsAt?, isActive? }
// =====================================================

const createOffer = async (req, res) => {
  try {
    const shopId = req.shop.shopId;

    const product =
      req.body?.scope === 'product'
        ? await loadOwnProduct(req.body?.productId, shopId)
        : null;

    const { value, errors } = validateOffer(req.body, { product });

    if (errors.length) {
      return res.status(400).json({ success: false, message: errors[0], errors });
    }

    const result = await pool.query(
      `
      INSERT INTO product_offers (
        shop_id, scope, product_id, category,
        discount_type, discount_value, title,
        starts_at, ends_at, is_active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
      `,
      [
        shopId,
        value.scope,
        value.productId,
        value.category,
        value.discountType,
        value.discountValue,
        value.title,
        value.startsAt,
        value.endsAt,
        value.isActive,
      ]
    );

    const offer = await loadOwnOffer(result.rows[0].id, shopId);

    return res.status(201).json({
      success: true,
      message: 'Offer created',
      offer: toOffer(offer),
    });
  } catch (error) {
    console.error('❌ createOffer error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to create offer' });
  }
};

// =====================================================
// EDIT / SWITCH ON-OFF
// PATCH /api/shop/offers/:id
// Only the fields sent change; the result is checked again.
// =====================================================

const updateOffer = async (req, res) => {
  try {
    const shopId = req.shop.shopId;
    const offerId = offerIdOf(req);

    if (!offerId) {
      return res.status(400).json({ success: false, message: 'Invalid offer ID' });
    }

    const existing = await loadOwnOffer(offerId, shopId);

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Offer not found' });
    }

    const body = req.body || {};
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);

    const merged = {
      scope: has('scope') ? body.scope : existing.scope,
      productId: has('productId') ? body.productId : existing.product_id,
      category: has('category') ? body.category : existing.category,
      discountType: has('discountType') ? body.discountType : existing.discount_type,
      discountValue: has('discountValue') ? body.discountValue : existing.discount_value,
      title: has('title') ? body.title : existing.title,
      startsAt: has('startsAt') ? body.startsAt : existing.starts_at,
      endsAt: has('endsAt') ? body.endsAt : existing.ends_at,
      isActive: has('isActive') ? body.isActive : existing.is_active,
    };

    const product =
      merged.scope === 'product'
        ? await loadOwnProduct(merged.productId, shopId)
        : null;

    const { value, errors } = validateOffer(merged, { product });

    if (errors.length) {
      return res.status(400).json({ success: false, message: errors[0], errors });
    }

    await pool.query(
      `
      UPDATE product_offers
      SET
        scope = $3,
        product_id = $4,
        category = $5,
        discount_type = $6,
        discount_value = $7,
        title = $8,
        starts_at = $9,
        ends_at = $10,
        is_active = $11,
        updated_at = NOW()
      WHERE id = $1 AND shop_id = $2
      `,
      [
        offerId,
        shopId,
        value.scope,
        value.productId,
        value.category,
        value.discountType,
        value.discountValue,
        value.title,
        value.startsAt,
        value.endsAt,
        value.isActive,
      ]
    );

    const offer = await loadOwnOffer(offerId, shopId);

    return res.json({
      success: true,
      message: 'Offer saved',
      offer: toOffer(offer),
    });
  } catch (error) {
    console.error('❌ updateOffer error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to save offer' });
  }
};

// =====================================================
// DELETE (orders keep the label they were charged with)
// DELETE /api/shop/offers/:id
// =====================================================

const deleteOffer = async (req, res) => {
  try {
    const offerId = offerIdOf(req);

    if (!offerId) {
      return res.status(400).json({ success: false, message: 'Invalid offer ID' });
    }

    const result = await pool.query(
      'DELETE FROM product_offers WHERE id = $1 AND shop_id = $2 RETURNING id',
      [offerId, req.shop.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Offer not found' });
    }

    return res.json({ success: true, message: 'Offer deleted' });
  } catch (error) {
    console.error('❌ deleteOffer error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to delete offer' });
  }
};

module.exports = {
  OFFER_SELECT,
  toOffer,
  getOffers,
  createOffer,
  updateOffer,
  deleteOffer,
};
