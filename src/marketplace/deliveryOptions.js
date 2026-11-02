// =====================================================
// PHASE 60: HOW CAN THIS SHOP GET AN ORDER TO THIS ADDRESS?
// Only methods that really exist:
//   getme  GetMe rider (existing shopper delivery). Limited to the
//          road distance in pricing settings (delivery.maxKm); fee and
//          time from the existing fare engine on the road route.
//   shop   The shop delivers itself / with its own courier to the
//          districts it lists, at the fee and days IT entered.
//   pickup The customer collects from the shop (if offered).
// No courier is priced or timed by GetMe (no courier API exists).
// =====================================================

const pool = require('../config/db');
const { round2 } = require('./common');
const { kmBetween } = require('./district');
const { getPricingSettings } = require('../pricing/settings');
const { resolveDeliveryRoute } = require('../pricing/deliveryRoute');
const { deliveryFares } = require('../pricing/deliveryFare');
const { DEFAULT_VEHICLE } = require('../pricing/vehicles');

const zonesFor = async (shopIds, client = pool) => {
  const ids = [...new Set(shopIds.map(Number).filter(Boolean))];
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = (
    await client.query('SELECT * FROM shop_delivery_zones WHERE shop_id = ANY($1) AND is_active ORDER BY district', [ids])
  ).rows;
  for (const row of rows) map.get(Number(row.shop_id))?.push(row);
  return map;
};

const daysLabel = (min, max) => {
  if (min === max) return min === 0 ? 'Same day' : `${min} day${min === 1 ? '' : 's'}`;
  return `${min}-${max} days`;
};

// -> [{ method, fulfilment, available, fee, minDays, maxDays, etaMinutes, label, detail, reason, message, approximate }]
const deliveryOptionsFor = async ({ shop, zones = null, latitude, longitude, district, route = false, settings = null }) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
  const shopLat = Number(shop.latitude);
  const shopLng = Number(shop.longitude);
  const straightKm = hasLocation && Number.isFinite(shopLat) && Number.isFinite(shopLng)
    ? round2(kmBetween(lat, lng, shopLat, shopLng)) : null;
  const pricing = settings || (await getPricingSettings());
  const maxKm = Number(pricing.delivery.maxKm);
  const options = [];

  // ---- GetMe rider
  // Phase 61c: grocery = a GetMe shopper shops and delivers (same
  // distance limit); the store must be open right now
  const grocery = shop.business_type === 'grocery';
  const getme = { method: 'getme', fulfilment: 'delivery', label: grocery ? 'GetMe shopper' : 'GetMe rider', available: false, fee: null, etaMinutes: null, distanceKm: straightKm };
  if (grocery && !shop.is_open) {
    getme.reason = 'closed';
    getme.message = 'This store is closed right now.';
  } else if (!shop.offers_delivery) {
    getme.reason = 'not_offered';
    getme.message = 'This store does not use GetMe riders.';
  } else if (!hasLocation) {
    getme.reason = 'no_location';
    getme.message = 'Choose a delivery address to check GetMe delivery.';
  } else if (straightKm != null && straightKm > maxKm) {
    getme.reason = 'too_far';
    getme.message = `GetMe riders deliver up to ${maxKm} km. This store is about ${Math.round(straightKm)} km away.`;
  } else if (!route) {
    getme.available = true;
    getme.approximate = true;
    getme.detail = 'Fee shown at checkout';
  } else {
    const resolved = await resolveDeliveryRoute({
      shops: [{ id: shop.id, latitude: shopLat, longitude: shopLng }],
      destination: { latitude: lat, longitude: lng },
    });
    if (!resolved?.ok) {
      getme.reason = 'route_unavailable';
      getme.message = resolved?.message || "We couldn't work out the delivery route right now.";
    } else if (resolved.distanceKm > maxKm) {
      getme.reason = 'too_far';
      getme.distanceKm = resolved.distanceKm;
      getme.message = `GetMe riders deliver up to ${maxKm} km by road. This address is ${resolved.distanceKm} km away.`;
    } else {
      const priced = deliveryFares(pricing, {
        route: { distanceKm: resolved.distanceKm, carMinutes: resolved.traffic ? resolved.carMinutes : resolved.typicalCarMinutes },
        shopCount: 1,
        at: new Date(),
      });
      getme.available = true;
      getme.distanceKm = resolved.distanceKm;
      getme.fee = round2(Number(priced.vehicleFees[DEFAULT_VEHICLE]) || 0);
      getme.etaMinutes = Number(priced.fares?.[DEFAULT_VEHICLE]?.estimatedTravelMinutes) || null;
      getme.detail = getme.etaMinutes ? `About ${getme.etaMinutes} min ride after it's ready` : null;
    }
  }
  options.push(getme);

  // ---- Shop-managed delivery
  const own = { method: 'shop', fulfilment: 'shop_delivery', label: 'Store delivery', available: false, fee: null, minDays: null, maxDays: null };
  const list = zones || (await zonesFor([shop.id])).get(Number(shop.id)) || [];
  if (shop.business_type !== 'clothing' || !shop.shop_delivery_enabled || !list.length) {
    own.reason = 'not_offered';
    own.message = 'This store does not deliver itself.';
  } else if (!district) {
    own.reason = 'no_district';
    own.message = 'Choose your delivery address to check store delivery.';
    own.districtsServed = list.length;
  } else {
    const zone = list.find((z) => z.district === district);
    if (!zone) {
      own.reason = 'district_not_served';
      own.message = `This store delivers to ${list.length} district${list.length === 1 ? '' : 's'}, not ${district}.`;
      own.districtsServed = list.length;
    } else {
      own.available = true;
      own.fee = round2(zone.fee);
      own.minDays = Number(zone.min_days);
      own.maxDays = Number(zone.max_days);
      own.detail = `${daysLabel(own.minDays, own.maxDays)}${shop.shop_delivery_courier ? ` · ${shop.shop_delivery_courier}` : ''}`;
      own.cashOnDelivery = !!shop.shop_delivery_cod;
    }
  }
  if (shop.shop_delivery_note) own.note = shop.shop_delivery_note;
  options.push(own);

  // ---- Pickup
  options.push({
    method: 'pickup',
    fulfilment: 'pickup',
    label: 'Pickup from store',
    available: !!shop.offers_pickup,
    fee: shop.offers_pickup ? 0 : null,
    distanceKm: straightKm,
    reason: shop.offers_pickup ? null : 'not_offered',
    message: shop.offers_pickup ? null : 'This store does not offer pickup.',
    detail: shop.offers_pickup && straightKm != null ? `${straightKm < 10 ? straightKm.toFixed(1) : Math.round(straightKm)} km from you` : null,
  });

  return options;
};

// One line for cards: { deliverable, summary, cheapestFee }
const deliverySummary = (options) => {
  const delivery = options.filter((o) => o.available && o.method !== 'pickup');
  const pickup = options.find((o) => o.method === 'pickup' && o.available);
  if (!delivery.length) {
    return { deliverable: false, summary: pickup ? 'Pickup only' : 'No delivery to your area', cheapestFee: null, pickup: !!pickup };
  }
  const priced = delivery.filter((o) => o.fee != null).sort((a, b) => a.fee - b.fee);
  const best = delivery.find((o) => o.method === 'getme') || delivery[0];
  const summary = best.method === 'getme'
    ? 'GetMe delivery'
    : `Store delivery ${best.detail ? `· ${best.detail.split(' · ')[0]}` : ''}`.trim();
  return { deliverable: true, summary, cheapestFee: priced[0]?.fee ?? null, pickup: !!pickup, methods: delivery.map((o) => o.method) };
};

module.exports = { deliveryOptionsFor, deliverySummary, zonesFor, daysLabel };
