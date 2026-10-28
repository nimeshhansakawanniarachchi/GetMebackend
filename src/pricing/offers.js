const pool = require('../config/db');

const { round2 } = require('./fees');

// =====================================================
// SHOP OFFERS (product_offers, phase 14)
// A shop's discount on one product, a category, or the whole
// shop: percent off or a sale price. The best active offer
// (lowest price) wins; offers don't add up. Used by the product
// lists the customer sees AND by the quote, so the app's prices
// and the order's prices always match. Orders keep what they were
// charged (order_items.original_unit_price / offer_id / offer_label).
//
// Phase 29: min_quantity = the offer only applies to a line of at
// least N units (product lists show it as bulk_offer, not as the
// price); max_per_order = while the offer runs, a customer can buy
// at most N units of that product in one order (the quote refuses
// more, like a shelf "Limit 4" tag).
// Units: pieces for products sold each, packs for kg / L products.
// =====================================================

const OFFER_TYPES = ['percent', 'sale_price'];
const OFFER_SCOPES = ['product', 'category', 'shop'];

const MAX_PERCENT = 90;
const MAX_OFFER_QUANTITY = 100;

const normalizeCategory = (category) =>
  String(category || '').trim().toLowerCase();

const minQuantityOf = (offer) => Math.max(1, Number(offer.min_quantity) || 1);
const maxPerOrderOf = (offer) => (offer.max_per_order == null ? null : Number(offer.max_per_order));

const offerLabel = (offer) => {
  if (offer.title) return offer.title;

  const base = offer.discount_type === 'percent' ? `${Number(offer.discount_value)}% off` : 'Sale price';

  return minQuantityOf(offer) > 1 ? `Buy ${minQuantityOf(offer)}+: ${base}` : base;
};

// Live = switched on, not paused by an admin, and running at `at`
const isLive = (offer, at = new Date()) =>
  offer.is_active &&
  !offer.paused_by_admin &&
  new Date(offer.starts_at) <= at &&
  (offer.ends_at == null || new Date(offer.ends_at) > at);

// Live offers of these shops at `at`. `until`: also still running
// then (scheduled orders must get the offer on the delivery day).
const loadLiveOffers = async (shopIds, { at = new Date(), until = null, client = pool } = {}) => {
  const ids = [...new Set(shopIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];

  if (ids.length === 0) {
    return [];
  }

  const result = await client.query(
    `
    SELECT *
    FROM product_offers
    WHERE shop_id = ANY($1::int[])
      AND is_active = TRUE
      AND paused_by_admin = FALSE
      AND starts_at <= $2
      AND (ends_at IS NULL OR ends_at > $2)
      AND ($3::timestamp IS NULL OR ends_at IS NULL OR ends_at > $3)
    `,
    [ids, at, until]
  );

  return result.rows;
};

const appliesTo = (offer, product) => {
  if (Number(offer.shop_id) !== Number(product.shop_id)) return false;

  if (offer.scope === 'product') return Number(offer.product_id) === Number(product.id);
  if (offer.scope === 'category') return normalizeCategory(offer.category) === normalizeCategory(product.category);

  return offer.scope === 'shop';
};

const offerPrice = (offer, shelfPrice) =>
  offer.discount_type === 'percent'
    ? round2(shelfPrice * (1 - Number(offer.discount_value) / 100))
    : round2(Number(offer.discount_value));

// Best offer for a product row ({ id, shop_id, category, price }):
// { price, originalPrice, offer: { id, label, endsAt, minQuantity,
// maxPerOrder } } or null.
// units: how many the customer buys (quote). Without it (product
// lists) only offers that need 1 unit count.
const bestOfferFor = (product, offers, { units = null } = {}) => {
  const shelfPrice = Number(product.price);

  if (!Number.isFinite(shelfPrice) || shelfPrice <= 0) {
    return null;
  }

  const enough = units == null ? 1 : units;
  let best = null;

  for (const offer of offers) {
    if (!appliesTo(offer, product)) continue;
    if (minQuantityOf(offer) > enough) continue;

    const price = offerPrice(offer, shelfPrice);

    // A "sale price" at or above the shelf price isn't an offer
    if (!(price > 0 && price < shelfPrice)) continue;

    if (!best || price < best.price) {
      best = {
        price,
        originalPrice: shelfPrice,
        offer: {
          id: Number(offer.id),
          label: offerLabel(offer),
          endsAt: offer.ends_at || null,
          minQuantity: minQuantityOf(offer),
          maxPerOrder: maxPerOrderOf(offer),
        },
      };
    }
  }

  return best;
};

// Best "buy N+" offer (min_quantity > 1) that beats `listPrice`, for
// the product lists: { id, label, minQuantity, maxPerOrder, price, endsAt } | null
const bulkOfferFor = (product, offers, listPrice) => {
  const shelfPrice = Number(product.price);
  let best = null;

  if (!Number.isFinite(shelfPrice) || shelfPrice <= 0) return null;

  for (const offer of offers) {
    if (!appliesTo(offer, product) || minQuantityOf(offer) <= 1) continue;

    const price = offerPrice(offer, shelfPrice);

    if (!(price > 0 && price < listPrice)) continue;

    if (!best || price < best.price) {
      best = {
        id: Number(offer.id),
        label: offerLabel(offer),
        minQuantity: minQuantityOf(offer),
        maxPerOrder: maxPerOrderOf(offer),
        price,
        endsAt: offer.ends_at || null,
      };
    }
  }

  return best;
};

// Lowest max_per_order of the live offers on this product (the
// customer's limit while they run), or null
const purchaseLimitFor = (product, offers) =>
  offers
    .filter((offer) => appliesTo(offer, product) && maxPerOrderOf(offer) != null)
    .reduce((limit, offer) => (limit == null ? maxPerOrderOf(offer) : Math.min(limit, maxPerOrderOf(offer))), null);

// Product rows -> same rows priced with their best offer:
// price = what the customer pays for 1 unit, original_price = shelf
// price (null when no offer), offer = { id, label, endsAt,
// minQuantity, maxPerOrder } | null, bulk_offer = a better "buy N+"
// offer | null, purchase_limit = most units per order | null
const applyOffersToProducts = async (products, options = {}) => {
  const rows = Array.isArray(products) ? products : [];
  const offers = await loadLiveOffers(rows.map((row) => row.shop_id), options);

  return rows.map((row) => {
    const best = offers.length ? bestOfferFor(row, offers) : null;
    const price = best ? best.price : row.price;

    return {
      ...row,
      price,
      original_price: best ? best.originalPrice : null,
      offer: best ? best.offer : null,
      bulk_offer: offers.length ? bulkOfferFor(row, offers, Number(price)) : null,
      purchase_limit: offers.length ? purchaseLimitFor(row, offers) : null,
    };
  });
};

// ----------------------------------------------------
// Validate a shop's offer (create / edit)
// product: the product row when scope = 'product'
// ----------------------------------------------------

const toTimestamp = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const validateOffer = (input, { product = null } = {}) => {
  const errors = [];

  const scope = String(input?.scope || '').trim();
  const discountType = String(input?.discountType || '').trim();
  const value = Number(input?.discountValue);
  const title = input?.title ? String(input.title).trim().slice(0, 80) : null;
  const category = input?.category ? String(input.category).trim().slice(0, 100) : null;
  const startsAt = toTimestamp(input?.startsAt) || new Date();
  const endsAt = toTimestamp(input?.endsAt);
  const minQuantity = input?.minQuantity == null || input.minQuantity === '' ? 1 : Number(input.minQuantity);
  const maxPerOrder = input?.maxPerOrder == null || input.maxPerOrder === '' ? null : Number(input.maxPerOrder);

  if (!OFFER_SCOPES.includes(scope)) {
    errors.push('Choose what the offer covers: a product, a category or the whole shop');
  }

  if (!OFFER_TYPES.includes(discountType)) {
    errors.push('Choose percent off or a sale price');
  }

  if (scope !== 'product' && discountType === 'sale_price') {
    errors.push('A sale price can only be set on one product');
  }

  if (scope === 'product' && !product) {
    errors.push('Choose one of your products');
  }

  if (scope === 'category' && !category) {
    errors.push('Choose a category');
  }

  if (discountType === 'percent' && !(Number.isFinite(value) && value >= 1 && value <= MAX_PERCENT)) {
    errors.push(`Percent off must be between 1 and ${MAX_PERCENT}`);
  }

  if (discountType === 'sale_price') {
    if (!(Number.isFinite(value) && value > 0)) {
      errors.push('Enter a sale price above 0');
    } else if (product && value >= Number(product.price)) {
      errors.push(`The sale price must be below the normal price (LKR ${Number(product.price).toFixed(2)})`);
    } else if (product && value < round2(Number(product.price) * (1 - MAX_PERCENT / 100))) {
      errors.push(`The sale price can be at most ${MAX_PERCENT}% below the normal price (at least LKR ${round2(Number(product.price) * (1 - MAX_PERCENT / 100)).toFixed(2)})`);
    }
  }

  if (!(Number.isInteger(minQuantity) && minQuantity >= 1 && minQuantity <= MAX_OFFER_QUANTITY)) {
    errors.push(`Minimum quantity must be a whole number from 1 to ${MAX_OFFER_QUANTITY}`);
  }

  if (maxPerOrder != null) {
    if (!(Number.isInteger(maxPerOrder) && maxPerOrder >= 1 && maxPerOrder <= MAX_OFFER_QUANTITY)) {
      errors.push(`The limit per order must be a whole number from 1 to ${MAX_OFFER_QUANTITY}`);
    } else if (Number.isInteger(minQuantity) && maxPerOrder < minQuantity) {
      errors.push("The limit per order can't be below the minimum quantity");
    }
  }

  if (endsAt === undefined || toTimestamp(input?.startsAt) === undefined) {
    errors.push('Enter valid start and end dates');
  } else if (endsAt && endsAt <= startsAt) {
    errors.push('The offer must end after it starts');
  }

  return {
    errors,
    value: {
      scope,
      productId: scope === 'product' ? Number(product?.id) || null : null,
      category: scope === 'category' ? category : null,
      discountType,
      discountValue: round2(value),
      title,
      startsAt,
      endsAt: endsAt || null,
      isActive: input?.isActive === undefined ? true : Boolean(input.isActive),
      minQuantity,
      maxPerOrder,
    },
  };
};

// Scheduled / ended / paused / live, for the shop + admin lists
const offerStatus = (offer, at = new Date()) => {
  if (offer.paused_by_admin) return 'paused_by_admin';
  if (!offer.is_active) return 'off';
  if (offer.ends_at && new Date(offer.ends_at) <= at) return 'ended';
  if (new Date(offer.starts_at) > at) return 'scheduled';
  return 'live';
};

module.exports = {
  OFFER_TYPES,
  OFFER_SCOPES,
  MAX_PERCENT,
  MAX_OFFER_QUANTITY,
  offerLabel,
  isLive,
  loadLiveOffers,
  bestOfferFor,
  bulkOfferFor,
  purchaseLimitFor,
  applyOffersToProducts,
  validateOffer,
  offerStatus,
};
