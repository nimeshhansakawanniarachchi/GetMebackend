const pool = require('../config/db');

// =====================================================
// PRICING SETTINGS (platform_settings.key = 'pricing')
// Cached for 60 s; admin updates clear the cache.
// =====================================================

const DEFAULT_PRICING = {
  delivery: {
    baseFee: 100,
    baseKm: 2,
    tiers: [
      { uptoKm: 5, perKm: 30 },
      { uptoKm: 10, perKm: 35 },
      { uptoKm: null, perKm: 40 },
    ],
    extraShopFee: 50,
    maxKm: 10,
  },
  fastFee: 100,
  // Delivery fee x this for the vehicle the customer books
  // (keys = bookable vehicle types, see pricing/vehicles.js)
  vehicleMultipliers: { motorbike: 1, 'three-wheeler': 1.3, car: 1.6 },
  // Standard (no priority fee) arrives this much later than Priority
  standardExtraMinutes: 45,
  // LKR off the order for a flexible window (one hour longer
  // than slotHours); 0 turns flexible windows off
  flexibleWindowDiscount: 100,
  // LKR per item unit (each pack / piece), paid to the shopper
  serviceFee: { perUnit: 50 },
  // GetMe fee charged to the customer: % of groceries + delivery +
  // priority + service fee - discounts (tip excluded)
  getmeFeePercent: 15,
  slots: { days: 4, startHour: 8, endHour: 20, slotHours: 2, leadMinutes: 60 },
  // Customer cancellation (src/orders/cancelPolicy.js). Before a
  // shopper accepts it is always free. Owner's choice 2026-10-27:
  //   afterAccept    - free cancel after a shopper accepts, until
  //                    they start shopping (full refund)
  //   whileShopping  - card orders may cancel during shopping and
  //                    pay for the items already bought (+ GetMe
  //                    fee); off = "contact support"
  // Out for delivery / arrived: never by the customer.
  cancellation: { afterAccept: true, whileShopping: false },
};

// Settings saved before a key existed get its default
const withDefaults = (stored) => ({
  ...DEFAULT_PRICING,
  ...stored,
  delivery: { ...DEFAULT_PRICING.delivery, ...stored?.delivery },
  serviceFee: { ...DEFAULT_PRICING.serviceFee, ...stored?.serviceFee },
  slots: { ...DEFAULT_PRICING.slots, ...stored?.slots },
  vehicleMultipliers: { ...DEFAULT_PRICING.vehicleMultipliers, ...stored?.vehicleMultipliers },
  cancellation: { ...DEFAULT_PRICING.cancellation, ...stored?.cancellation },
});

let cache = null;
let cachedAt = 0;

const getPricingSettings = async () => {
  if (cache && Date.now() - cachedAt < 60000) {
    return cache;
  }

  const result = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'pricing'"
  );

  cache = withDefaults(result.rows[0]?.value);
  cachedAt = Date.now();

  return cache;
};

// ----------------------------------------------------
// Validate an admin-submitted settings object
// ----------------------------------------------------

const money = (value, max = 100000) => {
  const number = Number(value);

  return Number.isFinite(number) && number >= 0 && number <= max
    ? Math.round(number * 100) / 100
    : null;
};

const validatePricing = (input) => {
  const errors = [];
  const delivery = input?.delivery || {};

  const value = {
    delivery: {
      baseFee: money(delivery.baseFee),
      baseKm: money(delivery.baseKm, 100),
      extraShopFee: money(delivery.extraShopFee),
      maxKm: money(delivery.maxKm, 100),
      tiers: Array.isArray(delivery.tiers)
        ? delivery.tiers.map((tier) => ({
            uptoKm: tier?.uptoKm === null || tier?.uptoKm === '' ? null : money(tier?.uptoKm, 100),
            perKm: money(tier?.perKm),
          }))
        : [],
    },
    fastFee: money(input?.fastFee),
    vehicleMultipliers: Object.fromEntries(
      Object.keys(DEFAULT_PRICING.vehicleMultipliers).map((vehicle) => {
        const multiplier = Number(input?.vehicleMultipliers?.[vehicle]);

        return [
          vehicle,
          Number.isFinite(multiplier) && multiplier >= 0.5 && multiplier <= 5
            ? Math.round(multiplier * 100) / 100
            : null,
        ];
      })
    ),
    standardExtraMinutes: Number(input?.standardExtraMinutes),
    flexibleWindowDiscount: money(input?.flexibleWindowDiscount, 5000),
    serviceFee: {
      perUnit: money(input?.serviceFee?.perUnit, 10000),
    },
    getmeFeePercent: money(input?.getmeFeePercent, 100),
    cancellation: {
      afterAccept: input?.cancellation?.afterAccept,
      whileShopping: input?.cancellation?.whileShopping,
    },
    slots: {
      days: Number(input?.slots?.days),
      startHour: Number(input?.slots?.startHour),
      endHour: Number(input?.slots?.endHour),
      slotHours: Number(input?.slots?.slotHours),
      leadMinutes: Number(input?.slots?.leadMinutes),
    },
  };

  const { delivery: d, serviceFee: s, slots } = value;

  if ([d.baseFee, d.baseKm, d.extraShopFee, d.maxKm, value.fastFee].includes(null)) {
    errors.push('Delivery fees, distances and fast fee must be numbers of 0 or more');
  }

  if (
    !Number.isInteger(value.standardExtraMinutes) ||
    value.standardExtraMinutes < 0 || value.standardExtraMinutes > 600
  ) {
    errors.push('Standard delivery: extra minutes must be a whole number from 0 to 600');
  }

  if (Object.values(value.vehicleMultipliers).includes(null)) {
    errors.push('Vehicle price multipliers must be between 0.5 and 5');
  }

  if (value.flexibleWindowDiscount === null) {
    errors.push('Flexible window discount must be between LKR 0 and LKR 5,000');
  }

  if (d.maxKm !== null && d.maxKm < 1) {
    errors.push('Maximum delivery distance must be at least 1 km');
  }

  if (d.tiers.length === 0 || d.tiers.some((tier) => tier.perKm === null)) {
    errors.push('Add at least one per-km tier with a valid price');
  }

  if (d.tiers.length && d.tiers[d.tiers.length - 1].uptoKm !== null) {
    errors.push('The last tier must have no upper limit (leave "up to" empty)');
  }

  const limits = d.tiers.slice(0, -1).map((tier) => tier.uptoKm);

  if (limits.some((limit, i) => limit === null || limit <= (i ? limits[i - 1] : d.baseKm))) {
    errors.push('Tier distances must increase and start above the base distance');
  }

  if (s.perUnit === null) {
    errors.push('Service fee per item must be between LKR 0 and LKR 10,000');
  }

  if (
    typeof value.cancellation.afterAccept !== 'boolean' ||
    typeof value.cancellation.whileShopping !== 'boolean'
  ) {
    errors.push('Cancellation rules must be on or off');
  }

  if (value.getmeFeePercent === null) {
    errors.push('GetMe fee must be between 0% and 100%');
  }

  if (
    !Number.isInteger(slots.days) || slots.days < 1 || slots.days > 14 ||
    !Number.isInteger(slots.startHour) || !Number.isInteger(slots.endHour) ||
    slots.startHour < 0 || slots.endHour > 24 || slots.startHour >= slots.endHour ||
    !Number.isInteger(slots.slotHours) || slots.slotHours < 1 || slots.slotHours > 6 ||
    !Number.isInteger(slots.leadMinutes) || slots.leadMinutes < 0 || slots.leadMinutes > 1440
  ) {
    errors.push('Delivery slots: 1-14 days, whole hours, start before end, 1-6 hour slots');
  }

  return { value, errors };
};

const updatePricingSettings = async (input, adminId) => {
  // A form that doesn't send the cancellation rules keeps the
  // current ones (older admin pages post only the fee fields)
  const current = await getPricingSettings();
  const { value, errors } = validatePricing({
    ...input,
    cancellation: { ...current.cancellation, ...input?.cancellation },
  });

  if (errors.length) {
    return { errors };
  }

  await pool.query(
    `
    INSERT INTO platform_settings (key, value, updated_at, updated_by)
    VALUES ('pricing', $1, NOW(), $2)
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by
    `,
    [value, adminId]
  );

  cache = null;

  return { value };
};

module.exports = {
  DEFAULT_PRICING,
  getPricingSettings,
  updatePricingSettings,
};
