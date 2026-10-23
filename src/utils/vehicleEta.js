// =====================================================
// VEHICLE ETA TO THE SHOP (Find a shopper cards)
// For each vehicle type: how long the nearest free shopper with
// that vehicle needs to reach the shop BY ROAD. Uses the exact
// shopper positions (the customer only ever gets the result, not
// who or where). One OSRM "table" request times every candidate
// at once; results are reused until a candidate moves.
// =====================================================

const ROUTING_URL = (
  process.env.ROUTING_URL || 'https://router.project-osrm.org'
).replace(/\/+$/, '');

const TIMEOUT_MS = 6000;

// OSRM gives CAR times; same per-vehicle factors as the Customer
// App (CustomerApp/utils/roadRoute.js ETA_FACTOR_BY_VEHICLE)
const ETA_FACTOR_BY_VEHICLE = {
  bicycle: 2.5,
  motorbike: 0.95,
  scooter: 1.1,
  'three-wheeler': 1.2,
  car: 1,
};

// Straight-line fallback when routing fails (as in the app)
const ROAD_FACTOR = 1.3;
const FALLBACK_KMH = 25;

// Nearest few by straight line are routed; the road winner is
// almost always among them
const CANDIDATES_PER_TYPE = 3;

// Re-route at most this often per order, even while shoppers move
const MIN_REFRESH_MS = 10000;
const MAX_CACHE = 500;

const cache = new Map(); // cacheId -> { key, at, etas }

const metersBetween = (a, b) => {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;

  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

const straightLineSeconds = (from, to) =>
  (metersBetween(from, to) * ROAD_FACTOR) / ((FALLBACK_KMH * 1000) / 3600);

// [carSeconds | null] for each source -> the shop
const routeTable = async (sources, shop) => {
  const points = [...sources, shop]
    .map((point) => `${point.longitude},${point.latitude}`)
    .join(';');

  const sourceIndexes = sources.map((_, index) => index).join(';');

  const response = await fetch(
    `${ROUTING_URL}/table/v1/driving/${points}?sources=${sourceIndexes}&destinations=${sources.length}&annotations=duration`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) }
  );

  const data = await response.json();

  if (data?.code !== 'Ok' || !Array.isArray(data.durations)) {
    throw new Error(data?.message || `routing ${response.status}`);
  }

  return data.durations.map((row) => {
    const seconds = Number(row?.[0]);
    return Number.isFinite(seconds) ? seconds : null;
  });
};

// shoppers: [{ vehicle_type, latitude, longitude }] (exact)
// -> { [type]: { seconds, estimated } } for types with a shopper
const vehicleEtasToShop = async ({ cacheId, shoppers, shop, types }) => {
  if (!shop || !Number.isFinite(Number(shop.latitude)) || !Number.isFinite(Number(shop.longitude))) {
    return {};
  }

  const target = { latitude: Number(shop.latitude), longitude: Number(shop.longitude) };

  const candidates = types.flatMap((type) =>
    shoppers
      .filter((shopper) => shopper.vehicle_type === type)
      .map((shopper) => ({
        type,
        latitude: Number(shopper.latitude),
        longitude: Number(shopper.longitude),
      }))
      .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
      .sort((a, b) => metersBetween(a, target) - metersBetween(b, target))
      .slice(0, CANDIDATES_PER_TYPE)
  );

  if (candidates.length === 0) {
    return {};
  }

  // ~11 m grid: a real move changes the key, GPS jitter doesn't
  const key = JSON.stringify([
    target.latitude.toFixed(4),
    target.longitude.toFixed(4),
    ...candidates.map((c) => `${c.type}:${c.latitude.toFixed(4)},${c.longitude.toFixed(4)}`),
  ]);

  const cached = cache.get(cacheId);

  if (cached && (cached.key === key || Date.now() - cached.at < MIN_REFRESH_MS)) {
    return cached.etas;
  }

  let carSeconds = null;

  try {
    carSeconds = await routeTable(candidates, target);
  } catch (error) {
    console.log('⚠️ VEHICLE ETA ROUTING FAILED, using straight line:', error?.message);
  }

  const etas = {};

  candidates.forEach((candidate, index) => {
    const routed = carSeconds?.[index];
    const estimated = !Number.isFinite(routed);
    const seconds =
      (estimated ? straightLineSeconds(candidate, target) : routed) *
      (ETA_FACTOR_BY_VEHICLE[candidate.type] || 1);

    const best = etas[candidate.type];

    if (!best || seconds < best.seconds) {
      etas[candidate.type] = { seconds: Math.round(seconds), estimated };
    }
  });

  if (cache.size >= MAX_CACHE) {
    cache.delete(cache.keys().next().value);
  }

  cache.set(cacheId, { key, at: Date.now(), etas });

  return etas;
};

module.exports = {
  vehicleEtasToShop,
};
