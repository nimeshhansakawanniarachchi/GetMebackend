const pool = require('../../config/db');

const { PROMO_TYPES, normalizePromoCode } = require('../../pricing/promos');
const { ORDER_STATUS_GROUPS } = require('../../utils/orderStatus');
const { adminCan } = require('../../middleware/adminAccess');
const { promoResults, emptyResult } = require('../../reports/promotionResults');

// =====================================================
// ADMIN: PROMO CODES
// GET    /api/admin/promos          list with usage counts
// POST   /api/admin/promos          create
// PATCH  /api/admin/promos/:id      update any field (e.g. isActive)
// =====================================================

const toNumberOrNull = (value) =>
  value === null || value === undefined || value === '' ? null : Number(value);

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

// Whitelists + checks the body; `partial` allows updating a few fields
const readPromoInput = (body, { partial = false } = {}) => {
  const errors = [];
  const value = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body || {}, key);

  if (!partial || has('code')) {
    value.code = normalizePromoCode(body?.code);
    if (!/^[A-Z0-9_-]{3,40}$/.test(value.code)) {
      errors.push('Code must be 3-40 letters, numbers, - or _');
    }
  }

  if (!partial || has('discountType')) {
    value.discount_type = body?.discountType;
    if (!PROMO_TYPES.includes(value.discount_type)) {
      errors.push(`Discount type must be one of: ${PROMO_TYPES.join(', ')}`);
    }
  }

  if (!partial || has('discountValue')) {
    value.discount_value = Number(body?.discountValue ?? 0);
    if (!Number.isFinite(value.discount_value) || value.discount_value < 0) {
      errors.push('Discount value must be 0 or more');
    }
  }

  if (has('description')) {
    value.description = String(body.description || '').trim().slice(0, 200) || null;
  }

  if (has('maxDiscount')) {
    value.max_discount = toNumberOrNull(body.maxDiscount);
    if (value.max_discount != null && !(value.max_discount >= 0)) {
      errors.push('Max discount must be 0 or more');
    }
  }

  if (has('minOrderAmount')) {
    value.min_order_amount = Number(body.minOrderAmount || 0);
    if (!(value.min_order_amount >= 0)) errors.push('Minimum order must be 0 or more');
  }

  for (const [field, column] of [['startsAt', 'starts_at'], ['endsAt', 'ends_at']]) {
    if (has(field)) {
      value[column] = toDateOrNull(body[field]);
      if (value[column] === undefined) errors.push(`${field} is not a valid date`);
    }
  }

  if (has('usageLimit')) {
    value.usage_limit = toNumberOrNull(body.usageLimit);
    if (value.usage_limit != null && !(Number.isInteger(value.usage_limit) && value.usage_limit > 0)) {
      errors.push('Usage limit must be a whole number above 0');
    }
  }

  if (has('perCustomerLimit')) {
    value.per_customer_limit = Number(body.perCustomerLimit);
    if (!(Number.isInteger(value.per_customer_limit) && value.per_customer_limit > 0)) {
      errors.push('Per-customer limit must be a whole number above 0');
    }
  }

  if (has('isActive')) {
    value.is_active = Boolean(body.isActive);
  }

  if (value.discount_type === 'percent' && value.discount_value > 100) {
    errors.push('Percent discount cannot be more than 100');
  }

  return { value, errors };
};

const toPromoResponse = (row) => ({
  id: Number(row.id),
  code: row.code,
  description: row.description,
  discountType: row.discount_type,
  discountValue: Number(row.discount_value),
  maxDiscount: row.max_discount != null ? Number(row.max_discount) : null,
  minOrderAmount: Number(row.min_order_amount),
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  usageLimit: row.usage_limit,
  perCustomerLimit: row.per_customer_limit,
  isActive: row.is_active,
  uses: Number(row.uses || 0),
  totalDiscount: Number(row.total_discount || 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT_PROMOS = `
  SELECT p.*,
    COUNT(r.id) FILTER (WHERE o.status <> ALL($1::text[]))::int AS uses,
    COALESCE(SUM(r.discount_amount) FILTER (WHERE o.status <> ALL($1::text[])), 0) AS total_discount
  FROM promo_codes p
  LEFT JOIN promo_redemptions r ON r.promo_id = p.id
  LEFT JOIN orders o ON o.id = r.order_id
`;

const listPromos = async (req, res) => {
  try {
    const result = await pool.query(
      `${SELECT_PROMOS} GROUP BY p.id ORDER BY p.created_at DESC`,
      [ORDER_STATUS_GROUPS.cancelled]
    );

    // Phase 47: all-time results for staff who may see them (reports.view
    // or promos.manage); GET /promos/:id/results gives a date range
    const showResults = adminCan(req, 'reports.view') || adminCan(req, 'promos.manage');
    const results = showResults ? await promoResults(pool) : null;

    return res.json({
      success: true,
      promos: result.rows.map((row) => ({
        ...toPromoResponse(row),
        ...(showResults ? { results: results.get(Number(row.id)) || emptyResult() } : {}),
      })),
    });
  } catch (error) {
    console.error('❌ listPromos error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load promo codes' });
  }
};

const createPromo = async (req, res) => {
  const { value, errors } = readPromoInput(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  const columns = [...Object.keys(value), 'created_by'];
  const params = [...Object.values(value), req.admin.adminId];

  try {
    const result = await pool.query(
      `
      INSERT INTO promo_codes (${columns.join(', ')})
      VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})
      RETURNING *
      `,
      params
    );

    return res.status(201).json({ success: true, promo: toPromoResponse(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'That code already exists' });
    }

    console.error('❌ createPromo error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to create promo code' });
  }
};

const updatePromo = async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ success: false, message: 'Invalid promo code' });
  }

  const { value, errors } = readPromoInput(req.body, { partial: true });

  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors[0], errors });
  }

  const columns = Object.keys(value);

  if (columns.length === 0) {
    return res.status(400).json({ success: false, message: 'Nothing to update' });
  }

  try {
    const result = await pool.query(
      `
      UPDATE promo_codes
      SET ${columns.map((column, index) => `${column} = $${index + 1}`).join(', ')},
          updated_at = NOW()
      WHERE id = $${columns.length + 1}
      RETURNING *
      `,
      [...Object.values(value), id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ success: false, message: 'Promo code not found' });
    }

    return res.json({ success: true, promo: toPromoResponse(result.rows[0]) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'That code already exists' });
    }

    console.error('❌ updatePromo error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update promo code' });
  }
};

module.exports = {
  listPromos,
  createPromo,
  updatePromo,
};
