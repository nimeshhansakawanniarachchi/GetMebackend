const { serviceUnits, servicePerUnit } = require('../pricing/fees');
const { splitShopperPay } = require('../controllers/shopperPay');
const { deliveryFeeForShopper } = require('../pricing/vehicles');

// =====================================================
// BATCH OFFER DETAILS (pure helpers for the Batches screen)
// Everything here is derived from stored order data; nothing is
// guessed. Estimates (shopping time) are labelled as such.
// =====================================================

// Shopping-time planning numbers (shown as an estimate only):
// time per store (park, find the counter, queue, pay) + per unit
const STORE_MINUTES = 8;
const MINUTES_PER_UNIT = 1;

// A line is "heavy" when one pack is >= 5 kg / 5 L, or the line
// adds up to >= 10 kg / 10 L (e.g. 6 x 2 L water)
const HEAVY_PACK_KG = 5;
const HEAVY_LINE_KG = 10;

const LOOSE_UNITS = ['kg', 'g', 'l', 'ml'];

// "5kg", "1.5 L", "500g", "Rice 10 Kg" -> kilograms (litres count
// as kilograms), or null when there is no size
const packKgOf = (text) => {
  const match = String(text || '')
    .toLowerCase()
    .match(/(\d+(?:\.\d+)?)\s*(kg|kilo(?:gram)?s?|g|grams?|l|ltr|litres?|liters?|ml)\b/);

  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  const unit = match[2];

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  if (unit === 'g' || unit.startsWith('gram') || unit === 'ml') {
    return amount / 1000;
  }

  return amount;
};

// item: { quantity, unit, custom, size, name } -> heavy line?
const isHeavyLine = (item) => {
  const quantity = Number(item?.quantity) || 1;
  const unit = String(item?.unit || '').toLowerCase();

  // Loose weighed line: the quantity is the weight
  if (item?.custom && LOOSE_UNITS.includes(unit)) {
    const kg = unit === 'g' || unit === 'ml' ? quantity / 1000 : quantity;
    return kg >= HEAVY_PACK_KG;
  }

  const pack = packKgOf(item?.size) ?? packKgOf(item?.name);

  if (pack === null) {
    return false;
  }

  return pack >= HEAVY_PACK_KG || pack * quantity >= HEAVY_LINE_KG;
};

const isWeighedLine = (item) =>
  !!item?.custom && LOOSE_UNITS.includes(String(item?.unit || '').toLowerCase());

// Service-fee units of a list (fees.serviceUnits: each pack /
// piece; a loose weighed line counts once)
const unitsOf = (items) =>
  serviceUnits(
    (items || []).map((item) => ({
      quantity: item.quantity,
      // fees.lineUnits compares with 'kg', 'g', 'L', 'ml'
      unit: String(item.unit || '').toLowerCase() === 'l' ? 'L' : item.unit,
      custom: !!item.custom,
    }))
  );

// "No 12, Galle Road, Wellawatte, Colombo 06, Sri Lanka" ->
// "Wellawatte, Colombo 06". Drops the country, Plus Codes and
// house-number / street parts; null when nothing is left.
const deliveryAreaOf = (address) => {
  const parts = String(address || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^sri lanka$/i.test(part))
    .filter((part) => !/^[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{0,3}$/i.test(part))
    .filter((part) => !/^(no\.?\s*)?\d+[a-z]?(\/\d+)?$/i.test(part))
    .filter((part) => !/^no\.?\s*\d/i.test(part));

  if (parts.length === 0) {
    return null;
  }

  // Street names ("... Road", "... Mawatha") aren't areas
  const areas = parts.filter((part) => !/\b(road|rd|street|st|mawatha|lane|avenue|ave|place)\.?$/i.test(part));
  const pick = (areas.length > 0 ? areas : parts).slice(-2);

  return pick.join(', ');
};

// The shopper's pay for this offer by category (backend formula,
// shopperPay.js). Grocery money is NOT earnings.
const earningsBreakdown = (order, vehicleType, items, settings) => {
  const deliveryFee = deliveryFeeForShopper(order, vehicleType);
  const split = splitShopperPay({
    deliveryFee: Number.isFinite(deliveryFee) ? deliveryFee : 0,
    fastFee: Number(order.fast_delivery_fee || 0),
    serviceFee: Number(order.service_fee || 0),
    tip: Number(order.tip_amount || 0),
  });

  const perUnit =
    order.service_fee_per_unit != null && Number.isFinite(Number(order.service_fee_per_unit))
      ? Number(order.service_fee_per_unit)
      : servicePerUnit(settings);

  return {
    deliveryFee: split.deliveryFee,
    priorityFee: split.priorityFee,
    serviceFee: split.serviceFee,
    serviceUnits: unitsOf(items),
    servicePerUnit: perUnit,
    tip: split.tip,
    // Same number as shopperEarnings
    total: split.net,
    // What the customer is charged on top (not the shopper's money)
    getmeFeePercent: order.getme_fee_percent != null ? Number(order.getme_fee_percent) : null,
  };
};

const shoppingMinutesFor = (units, shopCount) =>
  Math.round(Math.max(1, shopCount) * STORE_MINUTES + Math.max(0, units) * MINUTES_PER_UNIT);

module.exports = {
  STORE_MINUTES,
  MINUTES_PER_UNIT,
  packKgOf,
  isHeavyLine,
  isWeighedLine,
  unitsOf,
  deliveryAreaOf,
  earningsBreakdown,
  shoppingMinutesFor,
};
