const pool = require('../config/db');

const { VEHICLES, toMinutes } = require('./deliveryFare');

// =====================================================
// PRICING SETTINGS
// Versions in pricing_settings_versions (phase 30): the settings
// in use are the newest version whose effective_from has passed;
// a version with a later effective_from is scheduled. Every save
// is a new version (who + when), so the history is never lost.
// platform_settings 'pricing' mirrors the version in effect when
// it was saved (read only as a fallback before phase 30).
// Cached for up to 60 s, and never past a scheduled start.
// =====================================================

// Delivery fare rules per bookable vehicle (pricing/deliveryFare.js).
// Before phase 30 there was one distance fee x a vehicle multiplier;
// settings saved then are converted by legacyVehicles, so fares
// stay the same until an admin changes them.
const LEGACY_DELIVERY = {
  baseFee: 100,
  baseKm: 2,
  tiers: [
    { uptoKm: 5, perKm: 30 },
    { uptoKm: 10, perKm: 35 },
    { uptoKm: null, perKm: 40 },
  ],
  extraShopFee: 50,
};

const LEGACY_MULTIPLIERS = { motorbike: 1, 'three-wheeler': 1.3, car: 1.6 };

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const legacyVehicles = (stored) => {
  const d = { ...LEGACY_DELIVERY, ...stored?.delivery };
  const multipliers = { ...LEGACY_MULTIPLIERS, ...stored?.vehicleMultipliers };

  return Object.fromEntries(
    VEHICLES.map((vehicle) => {
      const m = Number(multipliers[vehicle]) > 0 ? Number(multipliers[vehicle]) : 1;
      const baseFare = round2(Number(d.baseFee) * m);

      return [
        vehicle,
        {
          baseFare,
          includedKm: Number(d.baseKm),
          tiers: (d.tiers || []).map((tier) => ({
            uptoKm: tier.uptoKm == null ? null : Number(tier.uptoKm),
            perKm: round2(Number(tier.perKm) * m),
          })),
          minimumFee: baseFare,
          perMinute: 0,
          stopFee: round2(Number(d.extraShopFee) * m),
        },
      ];
    })
  );
};

const DEFAULT_PRICING = {
  // maxKm = longest ROAD distance GetMe delivers (route km)
  delivery: { maxKm: 10 },
  vehicles: legacyVehicles(null),
  // Peak / busy periods (Asia/Colombo). None until an admin adds one.
  timeRules: [],
  fastFee: 100,
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
  // Shopper withdrawals (src/wallet/shopperWallet.js): smallest amount
  // and the fee taken off each one (owner's choice 2026-10-28)
  withdrawals: { minAmount: 500, fee: 0 },
  // Vehicle photos a shopper uploads at registration / vehicle change
  // (phase 36, PickMe-style): Bike = front (number plate), side, rear
  // (number plate) - no interior; Tuk / Car = front, side, interior
  vehiclePhotos: {
    motorbike: ['vehicle_front', 'vehicle_side', 'vehicle_rear'],
    'three-wheeler': ['vehicle_front', 'vehicle_side', 'vehicle_interior'],
    car: ['vehicle_front', 'vehicle_side', 'vehicle_interior'],
  },
};

const VEHICLE_PHOTO_TYPES = ['vehicle_front', 'vehicle_side', 'vehicle_rear', 'vehicle_interior'];

// Settings saved before a key existed get its default
const withDefaults = (stored) => {
  const vehicles = stored?.vehicles || legacyVehicles(stored);

  return {
    ...DEFAULT_PRICING,
    ...stored,
    delivery: { maxKm: Number(stored?.delivery?.maxKm ?? DEFAULT_PRICING.delivery.maxKm) },
    vehicles: Object.fromEntries(VEHICLES.map((vehicle) => [vehicle, { ...DEFAULT_PRICING.vehicles[vehicle], ...vehicles[vehicle] }])),
    timeRules: Array.isArray(stored?.timeRules) ? stored.timeRules : [],
    serviceFee: { ...DEFAULT_PRICING.serviceFee, ...stored?.serviceFee },
    slots: { ...DEFAULT_PRICING.slots, ...stored?.slots },
    cancellation: { ...DEFAULT_PRICING.cancellation, ...stored?.cancellation },
    withdrawals: { ...DEFAULT_PRICING.withdrawals, ...stored?.withdrawals },
    vehiclePhotos: { ...DEFAULT_PRICING.vehiclePhotos, ...stored?.vehiclePhotos },
    // Old keys, replaced by vehicles
    vehicleMultipliers: undefined,
  };
};

let cache = null;
let cacheUntil = 0;

// The vehicle photo rules from the last settings load (sync use in
// onboarding/applications.js + changeRequests.js; callers load the
// settings first)
let lastVehiclePhotos = DEFAULT_PRICING.vehiclePhotos;
const vehiclePhotoRules = () => lastVehiclePhotos;

// -> settings + versionId / effectiveFrom of the version in use
const getPricingSettings = async () => {
  if (cache && Date.now() < cacheUntil) {
    return cache;
  }

  const [current, next] = await Promise.all([
    pool
      .query(
        `
        SELECT id, value, effective_from
        FROM pricing_settings_versions
        WHERE cancelled_at IS NULL AND effective_from <= NOW()
        ORDER BY effective_from DESC, id DESC
        LIMIT 1
        `
      )
      .catch(() => ({ rows: [] })),
    pool
      .query(
        `
        SELECT MIN(effective_from) AS at
        FROM pricing_settings_versions
        WHERE cancelled_at IS NULL AND effective_from > NOW()
        `
      )
      .catch(() => ({ rows: [] })),
  ]);

  let row = current.rows[0];

  if (!row) {
    const legacy = await pool.query("SELECT value FROM platform_settings WHERE key = 'pricing'");
    row = { id: null, value: legacy.rows[0]?.value, effective_from: null };
  }

  cache = {
    ...withDefaults(row.value),
    versionId: row.id,
    effectiveFrom: row.effective_from,
  };

  lastVehiclePhotos = cache.vehiclePhotos;

  const nextAt = next.rows[0]?.at ? new Date(next.rows[0].at).getTime() : Infinity;
  cacheUntil = Math.min(Date.now() + 60000, nextAt);

  return cache;
};

// ----------------------------------------------------
// Validate an admin-submitted settings object
// ----------------------------------------------------

const money = (value, max = 100000) => {
  const number = Number(value);

  return value !== '' && value !== null && Number.isFinite(number) && number >= 0 && number <= max
    ? Math.round(number * 100) / 100
    : null;
};

const VEHICLE_NAMES = { motorbike: 'Bike', 'three-wheeler': 'Tuk', car: 'Car' };

const MAX_TIME_RULES = 20;

const validateVehicle = (input, name, errors) => {
  const rule = {
    baseFare: money(input?.baseFare),
    includedKm: money(input?.includedKm, 100),
    minimumFee: money(input?.minimumFee),
    perMinute: money(input?.perMinute, 1000),
    stopFee: money(input?.stopFee),
    tiers: Array.isArray(input?.tiers)
      ? input.tiers.slice(0, 10).map((tier) => ({
          uptoKm: tier?.uptoKm === null || tier?.uptoKm === '' || tier?.uptoKm === undefined ? null : money(tier.uptoKm, 500),
          perKm: money(tier?.perKm, 10000),
        }))
      : [],
  };

  if ([rule.baseFare, rule.includedKm, rule.minimumFee, rule.perMinute, rule.stopFee].includes(null)) {
    errors.push(`${name}: base fare, included km, minimum fee, per-minute and extra shop fees must be numbers of 0 or more`);
  }

  if (rule.tiers.length === 0 || rule.tiers.some((tier) => tier.perKm === null)) {
    errors.push(`${name}: add at least one per-km rate with a valid price`);
  } else if (rule.tiers[rule.tiers.length - 1].uptoKm !== null) {
    errors.push(`${name}: the last per-km rate must have no upper limit (leave "up to" empty)`);
  } else {
    const limits = rule.tiers.slice(0, -1).map((tier) => tier.uptoKm);

    if (limits.some((limit, i) => limit === null || limit <= (i ? limits[i - 1] : rule.includedKm))) {
      errors.push(`${name}: per-km distances must increase and start above the included km`);
    }
  }

  return rule;
};

const validateTimeRule = (input, index, errors) => {
  const label = `Time rule ${index + 1}`;
  const days = Array.isArray(input?.days)
    ? [...new Set(input.days.map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort()
    : [];
  const kind = input?.kind === 'fixed' ? 'fixed' : input?.kind === 'multiplier' ? 'multiplier' : null;
  const value = Number(input?.value);

  const rule = {
    id: /^[a-z0-9-]{1,40}$/i.test(String(input?.id || '')) ? String(input.id) : `rule-${Date.now().toString(36)}-${index}`,
    name: String(input?.name || '').trim().slice(0, 60),
    enabled: input?.enabled !== false,
    days,
    start: String(input?.start || ''),
    end: String(input?.end || ''),
    kind,
    value: Number.isFinite(value) ? Math.round(value * 100) / 100 : null,
  };

  if (!rule.name) {
    errors.push(`${label}: give it a name`);
  }

  if (days.length === 0) {
    errors.push(`${rule.name || label}: pick at least one day`);
  }

  if (toMinutes(rule.start) === null || toMinutes(rule.end) === null || toMinutes(rule.start) >= 1440 || toMinutes(rule.end) > 1440) {
    errors.push(`${rule.name || label}: times must be HH:MM (24-hour)`);
  } else if (rule.start === rule.end) {
    errors.push(`${rule.name || label}: start and end can't be the same`);
  }

  if (!kind) {
    errors.push(`${rule.name || label}: choose a multiplier or a fixed amount`);
  } else if (kind === 'multiplier' && !(rule.value >= 1 && rule.value <= 3)) {
    errors.push(`${rule.name || label}: the multiplier must be between 1 and 3`);
  } else if (kind === 'fixed' && !(rule.value >= 0 && rule.value <= 5000)) {
    errors.push(`${rule.name || label}: the surcharge must be between LKR 0 and LKR 5,000`);
  }

  return rule;
};

const validatePricing = (input) => {
  const errors = [];

  const vehicles = Object.fromEntries(
    VEHICLES.map((vehicle) => [vehicle, validateVehicle(input?.vehicles?.[vehicle], VEHICLE_NAMES[vehicle], errors)])
  );

  const rulesInput = Array.isArray(input?.timeRules) ? input.timeRules : [];

  if (rulesInput.length > MAX_TIME_RULES) {
    errors.push(`At most ${MAX_TIME_RULES} time rules`);
  }

  const timeRules = rulesInput.slice(0, MAX_TIME_RULES).map((rule, index) => validateTimeRule(rule, index, errors));

  if (new Set(timeRules.map((rule) => rule.id)).size !== timeRules.length) {
    errors.push('Two time rules have the same id');
  }

  const value = {
    delivery: { maxKm: money(input?.delivery?.maxKm, 200) },
    vehicles,
    timeRules,
    fastFee: money(input?.fastFee),
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
    withdrawals: {
      minAmount: money(input?.withdrawals?.minAmount, 100000),
      fee: money(input?.withdrawals?.fee, 5000),
    },
    vehiclePhotos: Object.fromEntries(
      Object.keys(DEFAULT_PRICING.vehiclePhotos).map((vehicle) => {
        const list = input?.vehiclePhotos?.[vehicle];
        return [vehicle, Array.isArray(list) ? [...new Set(list.map(String))] : DEFAULT_PRICING.vehiclePhotos[vehicle]];
      })
    ),
    slots: {
      days: Number(input?.slots?.days),
      startHour: Number(input?.slots?.startHour),
      endHour: Number(input?.slots?.endHour),
      slotHours: Number(input?.slots?.slotHours),
      leadMinutes: Number(input?.slots?.leadMinutes),
    },
  };

  const { delivery: d, serviceFee: s, slots } = value;

  if (d.maxKm === null || d.maxKm < 1) {
    errors.push('Maximum delivery distance must be between 1 and 200 km');
  }

  if (value.fastFee === null) {
    errors.push('Priority fee must be a number of 0 or more');
  }

  if (
    !Number.isInteger(value.standardExtraMinutes) ||
    value.standardExtraMinutes < 0 || value.standardExtraMinutes > 600
  ) {
    errors.push('Standard delivery: extra minutes must be a whole number from 0 to 600');
  }

  if (value.flexibleWindowDiscount === null) {
    errors.push('Flexible window discount must be between LKR 0 and LKR 5,000');
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

  for (const [vehicle, list] of Object.entries(value.vehiclePhotos)) {
    if (!list.every((type) => VEHICLE_PHOTO_TYPES.includes(type)) || !list.includes('vehicle_front') || list.length < 2) {
      errors.push(`${VEHICLE_NAMES[vehicle] || vehicle} photos: at least the front and one more view (front, side, rear, interior)`);
    }
  }

  if (value.withdrawals.minAmount === null || value.withdrawals.minAmount < 1) {
    errors.push('Minimum withdrawal must be between LKR 1 and LKR 100,000');
  }

  if (value.withdrawals.fee === null || (value.withdrawals.minAmount !== null && value.withdrawals.fee >= value.withdrawals.minAmount)) {
    errors.push('Withdrawal fee must be LKR 0 or more and less than the minimum withdrawal');
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

// effectiveFrom: empty = now; otherwise a time up to a year ahead
const readEffectiveFrom = (input) => {
  if (input === undefined || input === null || input === '') {
    return { at: null };
  }

  const at = new Date(input);

  if (Number.isNaN(at.getTime())) {
    return { error: 'Effective date is not a valid date' };
  }

  if (at.getTime() < Date.now() - 5 * 60 * 1000) {
    return { error: "Effective date can't be in the past" };
  }

  if (at.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) {
    return { error: 'Effective date must be within a year' };
  }

  return { at: at.getTime() <= Date.now() ? null : at };
};

// Saves a new version. Keys a form doesn't send keep their current
// values (older admin pages post only some fields).
// -> { value, version } | { errors }
const updatePricingSettings = async (input, adminId, { effectiveFrom, note } = {}) => {
  const when = readEffectiveFrom(effectiveFrom);

  if (when.error) {
    return { errors: [when.error] };
  }

  const current = await getPricingSettings();
  const merged = {
    ...current,
    ...input,
    delivery: { ...current.delivery, ...input?.delivery },
    vehicles: input?.vehicles
      ? Object.fromEntries(VEHICLES.map((vehicle) => [vehicle, { ...current.vehicles[vehicle], ...input.vehicles[vehicle] }]))
      : current.vehicles,
    timeRules: Array.isArray(input?.timeRules) ? input.timeRules : current.timeRules,
    cancellation: { ...current.cancellation, ...input?.cancellation },
    withdrawals: { ...current.withdrawals, ...input?.withdrawals },
    vehiclePhotos: { ...current.vehiclePhotos, ...input?.vehiclePhotos },
  };

  const { value, errors } = validatePricing(merged);

  if (errors.length) {
    return { errors };
  }

  const client = await pool.connect();
  let version;

  try {
    await client.query('BEGIN');

    version = (
      await client.query(
        `
        INSERT INTO pricing_settings_versions (value, effective_from, note, created_by)
        VALUES ($1, COALESCE($2::timestamptz, NOW()), $3, $4)
        RETURNING id, effective_from, created_at
        `,
        [value, when.at, note ? String(note).trim().slice(0, 300) || null : null, adminId]
      )
    ).rows[0];

    if (!when.at) {
      await client.query(
        `
        INSERT INTO platform_settings (key, value, updated_at, updated_by)
        VALUES ('pricing', $1, NOW(), $2)
        ON CONFLICT (key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by
        `,
        [value, adminId]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  cache = null;

  return { value, version: { id: version.id, effectiveFrom: version.effective_from, scheduled: !!when.at } };
};

// Saved versions, newest first, with who saved / cancelled them
const listPricingVersions = async ({ limit = 50 } = {}) => {
  const result = await pool.query(
    `
    SELECT
      v.id, v.value, v.effective_from, v.note, v.created_at, v.cancelled_at,
      a.full_name AS created_by_name, c.full_name AS cancelled_by_name
    FROM pricing_settings_versions v
    LEFT JOIN admins a ON a.id = v.created_by
    LEFT JOIN admins c ON c.id = v.cancelled_by
    ORDER BY v.effective_from DESC, v.id DESC
    LIMIT $1
    `,
    [Math.max(1, Math.min(200, Number(limit) || 50))]
  );

  return result.rows;
};

// Cancels a scheduled version (one already in effect can't be)
const cancelPricingVersion = async (id, adminId) => {
  const result = await pool.query(
    `
    UPDATE pricing_settings_versions
    SET cancelled_at = NOW(), cancelled_by = $2
    WHERE id = $1 AND cancelled_at IS NULL AND effective_from > NOW()
    RETURNING id
    `,
    [id, adminId]
  );

  cache = null;

  return result.rows.length > 0;
};

module.exports = {
  VEHICLE_PHOTO_TYPES,
  vehiclePhotoRules,
  DEFAULT_PRICING,
  VEHICLE_NAMES,
  withDefaults,
  validatePricing,
  getPricingSettings,
  updatePricingSettings,
  listPricingVersions,
  cancelPricingVersion,
};
