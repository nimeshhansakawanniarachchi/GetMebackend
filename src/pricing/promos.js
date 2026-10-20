const pool = require('../config/db');

const { round2 } = require('./fees');
const { ORDER_STATUS_GROUPS } = require('../utils/orderStatus');

// =====================================================
// PROMO CODES
// A code takes money off the order total; GetMe pays the
// discount, so shop and shopper pay are unchanged.
//   percent       -> % of items total (capped by max_discount)
//   fixed         -> flat amount off items total
//   free_delivery -> delivery fee + priority fee
// =====================================================

const PROMO_TYPES = ['percent', 'fixed', 'free_delivery'];

const normalizePromoCode = (code) =>
  String(code || '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 40);

const result = (code, applied, message, extra = {}) => ({
  code,
  applied,
  message,
  discount: 0,
  promoId: null,
  ...extra,
});

// Money off for a valid promo row (never more than the order)
const discountFor = (promo, { itemsTotal, deliveryFee, fastDeliveryFee }) => {
  const value = Number(promo.discount_value) || 0;
  let discount = 0;

  if (promo.discount_type === 'percent') {
    discount = (itemsTotal * value) / 100;

    if (promo.max_discount != null) {
      discount = Math.min(discount, Number(promo.max_discount));
    }
  } else if (promo.discount_type === 'fixed') {
    discount = Math.min(value, itemsTotal);
  } else if (promo.discount_type === 'free_delivery') {
    discount = deliveryFee + fastDeliveryFee;
  }

  return round2(Math.max(0, Math.min(discount, itemsTotal + deliveryFee + fastDeliveryFee)));
};

const describePromo = (promo) => {
  if (promo.description) return promo.description;

  const value = Number(promo.discount_value) || 0;

  if (promo.discount_type === 'percent') return `${value}% off your items`;
  if (promo.discount_type === 'fixed') return `Rs ${value.toFixed(2)} off`;

  return 'Free delivery';
};

// Checks a code for this customer + order amounts.
// Pass a transaction `client` with lock=true when placing the order so
// two orders can't both take the last use of a limited code.
const evaluatePromo = async ({
  code,
  customerId,
  itemsTotal = 0,
  deliveryFee = 0,
  fastDeliveryFee = 0,
  client = pool,
  lock = false,
}) => {
  const normalized = normalizePromoCode(code);

  if (!normalized) return null;

  const promoResult = await client.query(
    `SELECT * FROM promo_codes WHERE code = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [normalized]
  );

  const promo = promoResult.rows[0];

  if (!promo || !promo.is_active) {
    return result(normalized, false, "This promo code isn't valid");
  }

  const now = new Date();

  if (promo.starts_at && new Date(promo.starts_at) > now) {
    return result(normalized, false, "This promo code isn't active yet");
  }

  if (promo.ends_at && new Date(promo.ends_at) < now) {
    return result(normalized, false, 'This promo code has expired');
  }

  const minimum = Number(promo.min_order_amount) || 0;

  if (itemsTotal < minimum) {
    return result(
      normalized,
      false,
      `Add Rs ${(minimum - itemsTotal).toFixed(2)} more in items to use this code`
    );
  }

  const usage = await client.query(
    `
    SELECT
      COUNT(*)::int AS total_uses,
      COUNT(*) FILTER (WHERE r.customer_id = $2)::int AS customer_uses
    FROM promo_redemptions r
    JOIN orders o ON o.id = r.order_id
    WHERE r.promo_id = $1
      AND o.status <> ALL($3::text[])
    `,
    [promo.id, customerId || 0, ORDER_STATUS_GROUPS.cancelled]
  );

  const { total_uses: totalUses, customer_uses: customerUses } = usage.rows[0];

  if (promo.usage_limit != null && totalUses >= promo.usage_limit) {
    return result(normalized, false, 'This promo code has been fully used');
  }

  if (customerId && customerUses >= promo.per_customer_limit) {
    return result(normalized, false, "You've already used this promo code");
  }

  const discount = discountFor(promo, { itemsTotal, deliveryFee, fastDeliveryFee });

  if (discount <= 0) {
    return result(normalized, false, "This promo code doesn't apply to this order");
  }

  return result(normalized, true, describePromo(promo), {
    discount,
    promoId: promo.id,
    type: promo.discount_type,
  });
};

module.exports = {
  PROMO_TYPES,
  normalizePromoCode,
  evaluatePromo,
};
