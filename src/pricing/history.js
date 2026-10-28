const pool = require('../config/db');

// =====================================================
// PRICE + OFFER HISTORY (phase 29)
// product_price_history: every change of products.price, with the
// old and new price, where it came from and who made it.
// product_offer_history: every offer change with the row before
// and after. Both are written inside the caller's transaction, so
// a change that rolls back leaves no history behind.
// =====================================================

const PRICE_SOURCES = ['created', 'manual', 'import', 'admin'];

// A price that moves by more than this (either way) is flagged for
// GetMe to look at in the admin panel
const SUSPICIOUS_CHANGE_PERCENT = 50;

const samePrice = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.005;

/**
 * Records a price change (no-op when the price didn't change).
 * actor: { type, id, name } (shopAccess.actorOf / an admin / system)
 */
const recordPriceChange = async (client, { shopId, productId, oldPrice = null, newPrice, source, actor, note = null }) => {
  if (oldPrice != null && samePrice(oldPrice, newPrice)) return false;
  if (!PRICE_SOURCES.includes(source)) throw new Error(`Unknown price source ${source}`);

  await (client || pool).query(
    `
    INSERT INTO product_price_history
      (shop_id, product_id, old_price, new_price, source, note, actor_type, actor_id, actor_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      shopId,
      productId,
      oldPrice == null ? null : Number(oldPrice),
      Number(newPrice),
      source,
      note ? String(note).slice(0, 300) : null,
      actor?.type || 'system',
      actor?.id ?? null,
      actor?.name ? String(actor.name).slice(0, 120) : null,
    ]
  );

  await (client || pool).query('UPDATE products SET price_updated_at = NOW() WHERE id = $1', [productId]);

  return true;
};

// The fields of an offer row worth keeping in its history
const offerSnapshot = (offer) =>
  offer
    ? {
        scope: offer.scope,
        productId: offer.product_id ?? null,
        category: offer.category ?? null,
        discountType: offer.discount_type,
        discountValue: offer.discount_value != null ? Number(offer.discount_value) : null,
        title: offer.title ?? null,
        startsAt: offer.starts_at ?? null,
        endsAt: offer.ends_at ?? null,
        isActive: offer.is_active,
        pausedByAdmin: offer.paused_by_admin,
        minQuantity: offer.min_quantity ?? 1,
        maxPerOrder: offer.max_per_order ?? null,
      }
    : null;

const recordOfferChange = async (client, { offerId, shopId, action, before = null, after = null, actor }) => {
  await (client || pool).query(
    `
    INSERT INTO product_offer_history
      (offer_id, shop_id, action, before, after, actor_type, actor_id, actor_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      offerId,
      shopId,
      action,
      before ? JSON.stringify(offerSnapshot(before)) : null,
      after ? JSON.stringify(offerSnapshot(after)) : null,
      actor?.type || 'system',
      actor?.id ?? null,
      actor?.name ? String(actor.name).slice(0, 120) : null,
    ]
  );
};

const changePercent = (oldPrice, newPrice) =>
  Number(oldPrice) > 0 ? ((Number(newPrice) - Number(oldPrice)) / Number(oldPrice)) * 100 : null;

const isSuspiciousChange = (oldPrice, newPrice) => {
  if (oldPrice == null) return false;
  if (Number(newPrice) === 0 && Number(oldPrice) > 0) return true;
  const percent = changePercent(oldPrice, newPrice);
  return percent != null && Math.abs(percent) > SUSPICIOUS_CHANGE_PERCENT;
};

module.exports = {
  PRICE_SOURCES,
  SUSPICIOUS_CHANGE_PERCENT,
  recordPriceChange,
  recordOfferChange,
  offerSnapshot,
  changePercent,
  isSuspiciousChange,
};
