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
  serviceFee: { percent: 5, min: 50, max: 400 },
  slots: { days: 4, startHour: 8, endHour: 20, slotHours: 2, leadMinutes: 60 },
};

let cache = null;
let cachedAt = 0;

const getPricingSettings = async () => {
  if (cache && Date.now() - cachedAt < 60000) {
    return cache;
  }

  const result = await pool.query(
    "SELECT value FROM platform_settings WHERE key = 'pricing'"
  );

  cache = result.rows[0]?.value || DEFAULT_PRICING;
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
    serviceFee: {
      percent: money(input?.serviceFee?.percent, 100),
      min: money(input?.serviceFee?.min),
      max: money(input?.serviceFee?.max),
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

  if ([s.percent, s.min, s.max].includes(null) || s.min > s.max) {
    errors.push('Service fee: percent 0-100, and minimum must not be above maximum');
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
  const { value, errors } = validatePricing(input);

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
