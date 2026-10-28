const pool = require('../config/db');

const { distanceKm } = require('../controllers/shopperPay');

const { getPricingSettings } = require('./settings');
const { findSlot } = require('./slots');
const { evaluatePromo, normalizePromoCode } = require('./promos');
const { DEFAULT_VEHICLE } = require('./vehicles');
const { resolveDeliveryRoute } = require('./deliveryRoute');
const { deliveryFares } = require('./deliveryFare');
const { loadLiveOffers, bestOfferFor, purchaseLimitFor } = require('./offers');
const {
  round2,
  serviceUnits,
  servicePerUnit,
  serviceFee,
  getmeFeePercentOf,
  customerTotals,
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

// Payment methods that collect the money: a saved card is charged at
// booking (paymentService.bookingChargeFor), cash is collected at the
// door and owed by the shopper (settlement cash due). Any other value
// would deliver the order with nothing charged, so it is refused.
const PAYMENT_METHODS = ['cash', 'card'];

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


// Units an offer counts on a line: pieces for products sold each,
// packs for kg / L products (offers.js)
const offerUnitsOf = (productUnit, quantity, amount) =>
  productUnit === 'item' ? quantity * amount : quantity;

// =====================================================
// BUILD QUOTE
// Prices everything from the database. Client prices/fees
// are never used.
// items[].seenPackPrice (optional): the pack price the customer was
// shown (cart). Lines whose price moved since are listed in
// quote.priceChanges, so checkout can ask before charging more.
// client + lockProducts: price inside the caller's transaction with
// the product rows share-locked, so a price edit can't land between
// pricing and saving the order.
// Delivery fee: pricing/deliveryFare.js on the ROAD route of the
// order's shops -> the customer (pricing/deliveryRoute.js).
//   route: an already resolved route (deliveryRouteFor) - order
//          creation resolves it before opening its transaction
//   savedDelivery: { vehicleFees, pricing } of a placed order -
//          changes to that order keep the fee it was charged
//          (no new route, no new rates)
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
  client = pool,
  lockProducts = false,
  route = undefined,
  savedDelivery = null,
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
    ? await client.query(
        `SELECT id, shop_id, product_name, category, price, unit, stock_quantity, is_available, image_url
         FROM products WHERE id = ANY($1::int[])
         ORDER BY id
         ${lockProducts ? 'FOR SHARE' : ''}`,
        [productIds]
      )
    : { rows: [] };

  // Shop offers (pricing/offers.js). A scheduled order only gets an
  // offer that is still running when its slot starts.
  const slotStart =
    slot && scheduledDate && scheduledStartTime
      ? new Date(`${scheduledDate}T${String(scheduledStartTime).slice(0, 5)}:00`)
      : null;

  const offers = await loadLiveOffers(productsResult.rows.map((row) => row.shop_id), {
    until: slotStart && !Number.isNaN(slotStart.getTime()) ? slotStart : null,
    client,
  });

  // price = the price for one unit, as the product lists show it
  // (replacements use it too); shelf_price = the shop's normal price
  const products = new Map(
    productsResult.rows.map((row) => {
      const best = offers.length ? bestOfferFor(row, offers) : null;

      return [row.id, { ...row, shelf_price: Number(row.price), price: best ? best.price : Number(row.price) }];
    })
  );

  // Offer limits ("Limit 4 per order") count every line of a product
  const unitsByProduct = new Map();

  safeItems.forEach((item) => {
    const product = item?.custom ? null : products.get(Number(item?.productId));
    if (!product) return;

    const productUnit = PACK_RULES[product.unit] ? product.unit : 'item';
    const units = offerUnitsOf(productUnit, Number(item?.quantity) || 0, item?.amount == null ? 1 : Number(item.amount) || 0);

    unitsByProduct.set(product.id, (unitsByProduct.get(product.id) || 0) + units);
  });

  const priceChanges = [];

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
    ? await client.query(
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
      // Shop's normal price; unitPrice below is what this line pays
      regularUnitPrice: product.shelf_price,
      unitPrice: product.shelf_price,
      // Shelf price + offer when one applies (else null)
      originalUnitPrice: null,
      offerId: null,
      offerLabel: null,
      // Pack price as the product lists show it (the cart's price)
      listPackPrice: 0,
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

    // Best offer for this many units (a "buy 3+" offer needs 3 here)
    // (from the shop's normal price: product.price is already the list price)
    const best = offers.length
      ? bestOfferFor({ ...product, price: product.shelf_price }, offers, { units: offerUnitsOf(productUnit, quantity, amount) })
      : null;

    if (best) {
      line.unitPrice = best.price;
      line.originalUnitPrice = best.originalPrice;
      line.offerId = best.offer.id;
      line.offerLabel = best.offer.label;
    }

    // While an offer with a limit runs, the customer can't buy more
    const limit = offers.length ? purchaseLimitFor(product, offers) : null;

    if (limit != null && unitsByProduct.get(product.id) > limit && !issues.some((i) => i.code === 'purchase_limit' && i.productId === product.id)) {
      issues.push(issue('purchase_limit', `Limit ${limit} of ${product.product_name} per order while the offer runs`, { index, productId: product.id, limit }));
    }

    line.listPackPrice = round2(Number(product.price) * amount * rule.factor);
    line.packPrice = round2(line.unitPrice * amount * rule.factor);
    line.lineTotal = round2(line.packPrice * quantity);

    if (line.originalUnitPrice != null) {
      line.savings = round2(
        round2(line.originalUnitPrice * amount * rule.factor) * quantity - line.lineTotal
      );
    }

    // The customer saw a different price for this pack: list it
    const seen = Number(item?.seenPackPrice);

    if (item?.seenPackPrice != null && item.seenPackPrice !== '' && Number.isFinite(seen) && Math.abs(seen - line.listPackPrice) > 0.009) {
      priceChanges.push({
        index,
        productId: product.id,
        name: product.product_name,
        oldPackPrice: round2(seen),
        newPackPrice: line.listPackPrice,
        direction: line.listPackPrice > seen ? 'up' : 'down',
      });
    }

    return line;
  });

  // ---------------------------------------------------
  // Shops: availability (+ distance as the crow flies, for
  // display only - the fee uses the road route below)
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

  // ---------------------------------------------------
  // Delivery fee (road route; every vehicle's fare)
  // Priced for the default vehicle (Bike); the customer picks the
  // vehicle on Find a shopper, which re-prices from vehicleFees.
  // Time rules use the delivery time: the slot start for a
  // scheduled order, now otherwise.
  // ---------------------------------------------------

  const fareAt = slotStart && !Number.isNaN(slotStart.getTime()) ? slotStart : new Date();
  let vehicleFees = {};
  let deliveryInfo = null;

  if (savedDelivery?.vehicleFees) {
    vehicleFees = savedDelivery.vehicleFees;
    deliveryInfo = savedDelivery.pricing || null;
  } else if (hasLocation && shopSummaries.length > 0) {
    const resolved =
      route !== undefined
        ? route
        : await resolveDeliveryRoute({
            shops: shopSummaries.map((shop) => shops.get(shop.id)).map((shop) => ({ id: shop.id, latitude: shop.latitude, longitude: shop.longitude })),
            destination: { latitude, longitude },
          });

    if (!resolved?.ok) {
      issues.push(issue(resolved?.code || 'route_unavailable', resolved?.message || "We couldn't work out the delivery route right now. Please try again in a moment."));
    } else {
      if (resolved.distanceKm > Number(settings.delivery.maxKm)) {
        issues.push(issue('too_far', `This address is ${resolved.distanceKm} km from the store by road. GetMe delivers up to ${settings.delivery.maxKm} km.`, { distanceKm: resolved.distanceKm }));
      }

      // Live traffic only for a delivery starting now
      const live = resolved.traffic && option !== 'scheduled';
      const priced = deliveryFares(settings, {
        route: { distanceKm: resolved.distanceKm, carMinutes: live ? resolved.carMinutes : resolved.typicalCarMinutes },
        shopCount: shopSummaries.length,
        at: fareAt,
      });

      vehicleFees = priced.vehicleFees;
      deliveryInfo = {
        route: {
          source: resolved.source,
          distanceKm: resolved.distanceKm,
          // 'live_traffic' = Google with current traffic;
          // 'typical' = usual travel time (no live traffic)
          timeBasis: live ? 'live_traffic' : 'typical',
          carMinutes: live ? resolved.carMinutes : resolved.typicalCarMinutes,
          shopOrder: resolved.shopOrder,
          legs: resolved.legs,
          computedAt: resolved.computedAt,
        },
        shopCount: shopSummaries.length,
        pricedAt: new Date().toISOString(),
        fareTime: fareAt.toISOString(),
        settingsVersionId: settings.versionId ?? null,
        fares: priced.fares,
      };
    }
  }

  const delivery = Number(vehicleFees[DEFAULT_VEHICLE]) || 0;
  const roadKm = deliveryInfo?.route?.distanceKm ?? null;
  const bikeMinutes = deliveryInfo?.fares?.[DEFAULT_VEHICLE]?.estimatedTravelMinutes;
  const fast = option === 'fast' ? settings.fastFee : 0;
  // LKR 50 (settings) per item unit, paid to the shopper
  const units = serviceUnits(lines);
  const service = serviceFee(settings, units);

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

  // Customer total: fee base (no tip) + GetMe fee + tip
  const getmeFeePercent = getmeFeePercentOf(settings);
  const totals = customerTotals({
    itemsTotal,
    deliveryFee: delivery,
    fastFee: fast,
    serviceFee: service,
    discount,
    windowDiscount,
    tip: safeTip,
    percent: getmeFeePercent,
  });

  const totalPacks = lines.reduce(
    (sum, line) => sum + (Number.isFinite(line.quantity) ? Math.ceil(line.quantity) : 1),
    0
  );

  const priorityEta = estimateMinutes(roadKm, totalPacks, Math.max(1, shopSummaries.length), bikeMinutes);
  const extraMinutes = Number(settings.standardExtraMinutes) || 0;
  const standardEta = { min: priorityEta.min + extraMinutes, max: priorityEta.max + extraMinutes };

  return {
    deliveryOption: option,
    slot: slot ? { date: scheduledDate, ...slot } : null,
    lines,
    shops: shopSummaries,
    itemsTotal,
    offerSavings,
    // Lines priced differently from what the customer last saw
    priceChanges,
    hasCustomItems: lines.some((line) => line.custom),
    deliveryFee: delivery,
    vehicleFees,
    // Route, travel time and every vehicle's fare breakdown
    // (saved on the order as orders.delivery_pricing)
    delivery: deliveryInfo,
    fastDeliveryFee: fast,
    serviceFee: service,
    serviceUnits: units,
    serviceFeePerUnit: servicePerUnit(settings),
    // GetMe fee (tip excluded) - see totals below
    getmeFee: totals.getmeFee,
    getmeFeePercent,
    tipAmount: safeTip,
    tipOptions: TIP_OPTIONS,
    promo,
    discount,
    windowDiscount,
    savings: round2(discount + windowDiscount),
    totalAmount: totals.totalAmount,
    // Road km of the delivery route (null until it's known)
    distanceKm: roadKm,
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
