const pool = require('../config/db');

const { distanceKm } = require('../controllers/shopperPay');

const { getPricingSettings } = require('./settings');
const { findSlot } = require('./slots');
const { evaluatePromo, normalizePromoCode } = require('./promos');
const { DEFAULT_VEHICLE, vehicleFeesFor } = require('./vehicles');
const { applyOffersToProducts } = require('./offers');
const {
  round2,
  deliveryFee,
  serviceFee,
  estimateMinutes,
} = require('./fees');

// =====================================================
// PACK UNITS
// products.unit is how the shop prices it: item | kg | L.
// The customer picks a pack: g/kg for kg, ml/L for L, pcs for item.
// =====================================================

const PACK_RULES = {
  kg: {
    g: { factor: 0.001, min: 50, max: 50000 },
    kg: { factor: 1, min: 0.05, max: 50 },
  },
  L: {
    ml: { factor: 0.001, min: 50, max: 20000 },
    L: { factor: 1, min: 0.05, max: 20 },
  },
  item: {
    pcs: { factor: 1, min: 1, max: 100, integer: true },
    item: { factor: 1, min: 1, max: 100, integer: true },
    pc: { factor: 1, min: 1, max: 100, integer: true },
  },
};

const DEFAULT_PACK_UNIT = { kg: 'kg', L: 'L', item: 'pcs' };

const CUSTOM_UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'item', 'pack'];

const MAX_PACKS_PER_LINE = 99;

// Payment methods accepted now (Phase 2 adds the real gateways)
const PAYMENT_METHODS = ['cash', 'card', 'wallet', 'payhere', 'lankaqr', 'card_on_delivery'];

const issue = (code, message, extra = {}) => ({ code, message, ...extra });

const DELIVERY_OPTIONS = ['fast', 'standard', 'scheduled'];

// "Leave at the door" / "Meet at the door"
const DROPOFF_OPTIONS = ['leave_at_door', 'meet_at_door'];

// Shopper tip: quick picks shown at checkout, and the most one order can carry
const TIP_OPTIONS = [0, 100, 200, 300, 500];
const MAX_TIP = 10000;

const REPLACEMENT_PREFERENCES = ['best_match', 'specific', 'refund'];

// =====================================================
// REPLACEMENT PREFERENCE
// What the customer wants if the item is out of stock.
// A "specific" backup must be an available product from
// the same shop; otherwise only the note is kept, and
// with no product and no note it falls back to best_match.
// =====================================================

const buildReplacement = (item, shopId, originalProductId, products) => {
  let preference = REPLACEMENT_PREFERENCES.includes(item?.replacementPreference)
    ? item.replacementPreference
    : 'best_match';

  const note = item?.replacementNote
    ? String(item.replacementNote).trim().slice(0, 300) || null
    : null;

  let product = null;

  if (preference === 'specific') {
    const candidate = products.get(Number(item?.replacementProductId));

    if (
      candidate &&
      candidate.shop_id === shopId &&
      candidate.id !== originalProductId &&
      candidate.is_available
    ) {
      product = candidate;
    }

    if (!product && !note) {
      preference = 'best_match';
    }
  }

  return {
    replacementPreference: preference,
    replacementProductId: product ? product.id : null,
    replacementProductName: product ? product.product_name : null,
    replacementProductImage: product ? product.image_url : null,
    replacementProductPrice: product ? Number(product.price) : null,
    replacementNote: preference === 'specific' ? note : null,
  };
};


// =====================================================
// BUILD QUOTE
// Prices everything from the database. Client prices/fees
// are never used.
// =====================================================

const buildQuote = async ({
  deliveryLatitude,
  deliveryLongitude,
  deliveryOption = 'fast',
  scheduledDate = null,
  scheduledStartTime = null,
  scheduledEndTime = null,
  items = [],
  tipAmount = 0,
  promoCode = null,
  customerId = null,
}) => {
  const settings = await getPricingSettings();
  const issues = [];

  const tip = tipAmount == null || tipAmount === '' ? 0 : Number(tipAmount);

  if (!Number.isFinite(tip) || tip < 0 || tip > MAX_TIP) {
    issues.push(issue('invalid_tip', `Tip must be between Rs 0 and Rs ${MAX_TIP}`));
  }

  const safeTip = Number.isFinite(tip) ? round2(Math.min(Math.max(tip, 0), MAX_TIP)) : 0;

  const latitude = Number(deliveryLatitude);
  const longitude = Number(deliveryLongitude);
  const hasLocation =
    Number.isFinite(latitude) && Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;

  if (!hasLocation) {
    issues.push(issue('no_location', 'Choose a delivery address'));
  }

  if (!Array.isArray(items) || items.length === 0) {
    issues.push(issue('empty_cart', 'Your cart is empty'));
  }

  // fast = Priority (extra fee, soonest), standard = ASAP at the
  // base delivery fee, scheduled = a chosen window
  const option = DELIVERY_OPTIONS.includes(deliveryOption) ? deliveryOption : 'fast';
  let slot = null;

  if (option === 'scheduled') {
    slot = findSlot(settings, scheduledDate, scheduledStartTime, scheduledEndTime);

    if (!slot) {
      issues.push(issue('invalid_slot', 'That delivery time is no longer available. Pick another slot.'));
    }
  }

  const safeItems = Array.isArray(items) ? items.slice(0, 200) : [];

  // ---------------------------------------------------
  // Load products and shops in two queries
  // ---------------------------------------------------

  // Includes chosen replacement products so they load in the same query
  const productIds = [
    ...new Set(
      safeItems
        .flatMap((item) => [
          item?.custom ? null : Number(item?.productId),
          item?.replacementPreference === 'specific'
            ? Number(item?.replacementProductId)
            : null,
        ])
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];

  const productsResult = productIds.length
    ? await pool.query(
        `SELECT id, shop_id, product_name, category, price, unit, stock_quantity, is_available, image_url
         FROM products WHERE id = ANY($1::int[])`,
        [productIds]
      )
    : { rows: [] };

  // Shop offers (pricing/offers.js): price = offer price,
  // original_price = shelf price. A scheduled order only gets an
  // offer that is still running when its slot starts.
  const slotStart =
    slot && scheduledDate && scheduledStartTime
      ? new Date(`${scheduledDate}T${String(scheduledStartTime).slice(0, 5)}:00`)
      : null;

  const pricedProducts = await applyOffersToProducts(productsResult.rows, {
    until: slotStart && !Number.isNaN(slotStart.getTime()) ? slotStart : null,
  });

  const products = new Map(pricedProducts.map((row) => [row.id, row]));

  const shopIds = [
    ...new Set(
      safeItems
        .map((item) =>
          item?.custom
            ? Number(item?.shopId)
            : products.get(Number(item?.productId))?.shop_id
        )
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];

  const shopsResult = shopIds.length
    ? await pool.query(
        `SELECT id, shop_name, image_url, latitude, longitude, status, is_open
         FROM shops WHERE id = ANY($1::int[])`,
        [shopIds]
      )
    : { rows: [] };

  const shops = new Map(shopsResult.rows.map((row) => [row.id, row]));

  // ---------------------------------------------------
  // Price each line
  // ---------------------------------------------------

  const lines = safeItems.map((item, index) => {
    const quantity = Number(item?.quantity);

    // Custom request: shopper finds it and charges shelf price later
    if (item?.custom) {
      const shopId = Number(item?.shopId);
      const name = String(item?.itemName || item?.name || '').trim().slice(0, 150);
      const unit = CUSTOM_UNITS.includes(item?.unit) ? item.unit : 'pcs';

      const line = {
        index,
        custom: true,
        shopId,
        name,
        quantity,
        unit,
        details: item?.details ? String(item.details).slice(0, 500) : null,
        image: item?.image || null,
        voiceUrl: item?.voiceUrl || item?.voice_url || null,
        unitPrice: 0,
        packPrice: 0,
        lineTotal: 0,
        ...buildReplacement(item, shopId, null, products),
      };

      if (!name) {
        issues.push(issue('invalid_item', 'Custom item needs a name', { index }));
      }

      if (!shops.has(shopId)) {
        issues.push(issue('shop_not_found', `Shop for "${name || 'custom item'}" was not found`, { index }));
      }

      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 50) {
        issues.push(issue('invalid_quantity', `Enter a quantity for "${name}" (up to 50)`, { index }));
      }

      return line;
    }

    const product = products.get(Number(item?.productId));

    if (!product) {
      issues.push(issue('product_not_found', 'An item in your cart is no longer sold', { index }));
      return { index, custom: false, productId: Number(item?.productId) || null, name: item?.itemName || 'Item', lineTotal: 0 };
    }

    const productUnit = PACK_RULES[product.unit] ? product.unit : 'item';
    const packUnit = item?.selectedUnit || item?.unit || DEFAULT_PACK_UNIT[productUnit];
    const rule = PACK_RULES[productUnit][packUnit];
    const amount = item?.amount == null ? 1 : Number(item.amount);

    const line = {
      index,
      custom: false,
      productId: product.id,
      shopId: product.shop_id,
      name: product.product_name,
      image: product.image_url,
      quantity,
      amount,
      unit: packUnit,
      productUnit,
      unitPrice: Number(product.price),
      // Shelf price + offer when one applies (else null)
      originalUnitPrice: product.original_price != null ? Number(product.original_price) : null,
      offerId: product.offer?.id || null,
      offerLabel: product.offer?.label || null,
      packPrice: 0,
      lineTotal: 0,
      savings: 0,
      ...buildReplacement(item, product.shop_id, product.id, products),
    };

    if (Number(item?.shopId) && Number(item.shopId) !== product.shop_id) {
      issues.push(issue('wrong_shop', `${product.product_name} is not sold by that shop`, { index }));
    }

    if (!product.is_available) {
      issues.push(issue('unavailable', `${product.product_name} is no longer available`, { index, productId: product.id }));
    } else if (Number(product.stock_quantity) <= 0) {
      issues.push(issue('out_of_stock', `${product.product_name} is out of stock`, { index, productId: product.id }));
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PACKS_PER_LINE) {
      issues.push(issue('invalid_quantity', `Quantity for ${product.product_name} must be 1-${MAX_PACKS_PER_LINE}`, { index }));
      return line;
    }

    if (
      !rule || !Number.isFinite(amount) ||
      amount < rule.min || amount > rule.max ||
      (rule.integer && !Number.isInteger(amount))
    ) {
      issues.push(issue('invalid_pack', `Choose a valid size for ${product.product_name}`, { index }));
      return line;
    }

    line.packPrice = round2(line.unitPrice * amount * rule.factor);
    line.lineTotal = round2(line.packPrice * quantity);

    if (line.originalUnitPrice != null) {
      line.savings = round2(
        round2(line.originalUnitPrice * amount * rule.factor) * quantity - line.lineTotal
      );
    }

    return line;
  });

  // ---------------------------------------------------
  // Shops: availability + distance
  // ---------------------------------------------------

  const shopSummaries = shopIds
    .filter((id) => shops.has(id))
    .map((id) => {
      const shop = shops.get(id);
      const km =
        hasLocation && shop.latitude != null && shop.longitude != null
          ? round2(distanceKm(latitude, longitude, Number(shop.latitude), Number(shop.longitude)))
          : null;

      if (shop.status !== 'approved' || shop.is_open === false) {
        issues.push(issue('shop_unavailable', `${shop.shop_name} is not taking orders right now`, { shopId: id }));
      }

      if (km != null && km > settings.delivery.maxKm) {
        issues.push(issue('too_far', `${shop.shop_name} doesn't deliver to this address (${km} km away)`, { shopId: id }));
      }

      return {
        id,
        name: shop.shop_name,
        image: shop.image_url,
        distanceKm: km,
        itemsTotal: round2(
          lines.filter((line) => line.shopId === id).reduce((sum, line) => sum + (line.lineTotal || 0), 0)
        ),
      };
    });

  // ---------------------------------------------------
  // Totals
  // ---------------------------------------------------

  const itemsTotal = round2(lines.reduce((sum, line) => sum + (line.lineTotal || 0), 0));

  // Saved through shop offers; itemsTotal already has it taken off
  const offerSavings = round2(lines.reduce((sum, line) => sum + (line.savings || 0), 0));

  const distances = shopSummaries.map((shop) => shop.distanceKm).filter(Number.isFinite);
  const farthestKm = distances.length ? Math.max(...distances) : null;

  // Priced for the default vehicle (Bike); the customer picks the
  // vehicle on Find a shopper, which re-prices from vehicleFees
  const baseDelivery = deliveryFee(settings, farthestKm, Math.max(1, shopSummaries.length)) ?? 0;
  const vehicleFees = vehicleFeesFor(settings, baseDelivery);
  const delivery = vehicleFees[DEFAULT_VEHICLE];
  const fast = option === 'fast' ? settings.fastFee : 0;
  const service = serviceFee(settings, itemsTotal);

  // Invalid codes don't block the quote; the app shows promo.message
  const promo = normalizePromoCode(promoCode)
    ? await evaluatePromo({
        code: promoCode,
        customerId,
        itemsTotal,
        deliveryFee: delivery,
        fastDeliveryFee: fast,
      })
    : null;

  const discount = promo?.applied ? promo.discount : 0;

  const beforeWindow = itemsTotal + delivery + fast + service + safeTip - discount;

  // Flexible scheduled window saving; separate from the promo
  // discount (order creation checks that one against the promo)
  const windowDiscount = round2(
    Math.min(Number(slot?.discount) || 0, Math.max(0, beforeWindow))
  );

  const totalPacks = lines.reduce(
    (sum, line) => sum + (Number.isFinite(line.quantity) ? Math.ceil(line.quantity) : 1),
    0
  );

  const priorityEta = estimateMinutes(farthestKm, totalPacks, Math.max(1, shopSummaries.length));
  const extraMinutes = Number(settings.standardExtraMinutes) || 0;
  const standardEta = { min: priorityEta.min + extraMinutes, max: priorityEta.max + extraMinutes };

  return {
    deliveryOption: option,
    slot: slot ? { date: scheduledDate, ...slot } : null,
    lines,
    shops: shopSummaries,
    itemsTotal,
    offerSavings,
    hasCustomItems: lines.some((line) => line.custom),
    deliveryFee: delivery,
    vehicleFees,
    fastDeliveryFee: fast,
    serviceFee: service,
    tipAmount: safeTip,
    tipOptions: TIP_OPTIONS,
    promo,
    discount,
    windowDiscount,
    savings: round2(discount + windowDiscount),
    totalAmount: round2(Math.max(0, beforeWindow - windowDiscount)),
    distanceKm: farthestKm,
    estimatedMinutes: option === 'standard' ? standardEta : priorityEta,
    // What the checkout shows on each option card
    options: {
      fast: { fee: settings.fastFee, estimatedMinutes: priorityEta },
      standard: { fee: 0, estimatedMinutes: standardEta },
      scheduled: { fee: 0, flexibleWindowDiscount: Number(settings.flexibleWindowDiscount) || 0 },
    },
    issues,
  };
};

module.exports = {
  buildQuote,
  DROPOFF_OPTIONS,
  PAYMENT_METHODS,
  PACK_RULES,
  MAX_TIP,
};
