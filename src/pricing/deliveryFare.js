// =====================================================
// DELIVERY FARE ENGINE (pure functions)
// The one formula for the delivery fee - quote, checkout, booking
// (via orders.vehicle_fees) and the admin preview all use it.
//
// Per vehicle (settings.vehicles[type]):
//   distanceCharge = per-km tiers on the road km beyond includedKm
//   timeCharge     = perMinute x that vehicle's travel minutes
//   stopCharge     = stopFee x (shops in the order - 1)
//   subtotal       = baseFare + distanceCharge + timeCharge + stopCharge
//   core           = max(subtotal, minimumFee)
//   timeSurcharge  = the ONE matching time rule (Asia/Colombo) that
//                    adds the most: multiplier -> core x (m - 1),
//                    fixed -> the amount. Rules never stack.
//   deliveryFee    = ceil(core + timeSurcharge)   (whole LKR)
// Travel minutes = the route's car minutes x the vehicle factor
// (same factors as utils/vehicleEta.js and the apps).
// =====================================================

const VEHICLES = ['motorbike', 'three-wheeler', 'car'];

const TRAVEL_FACTOR = { motorbike: 0.95, 'three-wheeler': 1.2, car: 1 };

const CURRENCY = 'LKR';

const TIME_ZONE = 'Asia/Colombo';

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const num = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

// Per-km tiers on the km beyond includedKm. tiers: [{ uptoKm, perKm }],
// the last with uptoKm null (no limit).
const distanceChargeFor = (rule, km) => {
  let charge = 0;
  let covered = num(rule.includedKm);

  for (const tier of rule.tiers || []) {
    if (km <= covered) {
      break;
    }

    const end = tier.uptoKm == null ? km : Math.min(km, num(tier.uptoKm));

    charge += Math.max(0, end - covered) * num(tier.perKm);
    covered = Math.max(covered, end);
  }

  return round2(charge);
};

// ---------------------------------------------------
// Time rules: { id, name, enabled, days: [0-6, 0 = Sunday],
//   start: 'HH:MM', end: 'HH:MM', kind: 'multiplier' | 'fixed', value }
// end before start = runs past midnight (that part belongs to the
// day the rule started on).
// ---------------------------------------------------

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const colomboClock = (date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIME_ZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );

  return { day: WEEKDAYS[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
};

const toMinutes = (hhmm) => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

const ruleMatches = (rule, clock) => {
  if (!rule || rule.enabled === false) {
    return false;
  }

  const start = toMinutes(rule.start);
  const end = toMinutes(rule.end);
  const days = Array.isArray(rule.days) ? rule.days : [];

  if (start === null || end === null || start === end) {
    return false;
  }

  if (start < end) {
    return days.includes(clock.day) && clock.minutes >= start && clock.minutes < end;
  }

  // Overnight: today from start, or yesterday's rule until end
  return (
    (days.includes(clock.day) && clock.minutes >= start) ||
    (days.includes((clock.day + 6) % 7) && clock.minutes < end)
  );
};

const matchingTimeRules = (rules, at) => {
  const clock = colomboClock(at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date());
  return (Array.isArray(rules) ? rules : []).filter((rule) => ruleMatches(rule, clock));
};

const surchargeOf = (rule, core) =>
  rule.kind === 'fixed' ? num(rule.value) : core * Math.max(0, num(rule.value, 1) - 1);

// ---------------------------------------------------
// One vehicle's fare
// route: { distanceKm, carMinutes }; shopCount; rules = matching time rules
// ---------------------------------------------------

const fareForVehicle = (settings, vehicleType, { route, shopCount = 1, rules = [] }) => {
  const rule = settings?.vehicles?.[vehicleType];

  if (!rule) {
    return null;
  }

  const km = Math.max(0, num(route?.distanceKm));
  const minutes = Math.max(1, Math.ceil(num(route?.carMinutes) * (TRAVEL_FACTOR[vehicleType] || 1)));

  const baseFare = round2(num(rule.baseFare));
  const distanceCharge = distanceChargeFor(rule, km);
  const timeCharge = round2(num(rule.perMinute) * minutes);
  const stopCharge = round2(num(rule.stopFee) * Math.max(0, num(shopCount, 1) - 1));
  const subtotal = round2(baseFare + distanceCharge + timeCharge + stopCharge);
  const core = Math.max(subtotal, round2(num(rule.minimumFee)));

  // The one rule that adds the most (never two at once)
  let applied = null;
  let timeSurcharge = 0;

  for (const timeRule of rules) {
    const amount = round2(surchargeOf(timeRule, core));

    if (amount > timeSurcharge) {
      applied = timeRule;
      timeSurcharge = amount;
    }
  }

  return {
    vehicleType,
    distanceKm: round2(km),
    estimatedTravelMinutes: minutes,
    baseFare,
    includedKm: num(rule.includedKm),
    distanceCharge,
    timeCharge,
    stopCharge,
    minimumFeeAdjustment: round2(core - subtotal),
    timeSurcharge,
    timeRule: applied
      ? { id: applied.id, name: applied.name, kind: applied.kind, value: num(applied.value) }
      : null,
    deliveryFee: Math.ceil(round2(core + timeSurcharge)),
    currency: CURRENCY,
  };
};

// Every bookable vehicle's fare for one route
// -> { vehicleFees: { motorbike: 236, ... }, fares: { motorbike: {...}, ... } }
const deliveryFares = (settings, { route, shopCount = 1, at = new Date() }) => {
  const rules = matchingTimeRules(settings?.timeRules, at);
  const fares = {};
  const vehicleFees = {};

  for (const vehicle of VEHICLES) {
    const fare = fareForVehicle(settings, vehicle, { route, shopCount, rules });

    if (fare) {
      fares[vehicle] = fare;
      vehicleFees[vehicle] = fare.deliveryFee;
    }
  }

  return { vehicleFees, fares };
};

module.exports = {
  VEHICLES,
  TRAVEL_FACTOR,
  CURRENCY,
  TIME_ZONE,
  colomboClock,
  toMinutes,
  matchingTimeRules,
  distanceChargeFor,
  fareForVehicle,
  deliveryFares,
};
