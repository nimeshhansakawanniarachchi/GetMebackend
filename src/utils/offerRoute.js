// =====================================================
// BATCH OFFER ROUTE (Batches screen)
// Road route for one offer: shopper -> shop 1 -> shop 2 ... ->
// customer, from the OSRM "route" API (same server as
// utils/vehicleEta.js). Distances are road distances and times
// are car times scaled to the shopper's vehicle.
//
// The offer list is polled every few seconds, so:
//  - results are cached per offer + shopper position (~100 m grid)
//  - a request that takes longer than WAIT_MS is answered with
//    the straight-line fallback and finishes in the background;
//    the next poll gets the road route from the cache
//  - when routing fails the fallback is marked
//    source: 'straight_line' so the app never shows it as a road
// =====================================================

const ROUTING_URL = (
  process.env.ROUTING_URL || 'https://router.project-osrm.org'
).replace(/\/+$/, '');

const TIMEOUT_MS = 6000;
const WAIT_MS = 2500;

// Road results stay valid this long; a failure is retried sooner
const ROAD_TTL_MS = 10 * 60 * 1000;
const FAILED_TTL_MS = 60 * 1000;
const MAX_CACHE = 300;

// Same per-vehicle factors as utils/vehicleEta.js and the apps
const ETA_FACTOR_BY_VEHICLE = {
  bicycle: 2.5,
  motorbike: 0.95,
  scooter: 1.1,
  'three-wheeler': 1.2,
  car: 1,
};

// Straight-line fallback (as in utils/vehicleEta.js)
const ROAD_FACTOR = 1.3;
const FALLBACK_KMH = 25;

const cache = new Map(); // key -> { at, ttl, route }
const inFlight = new Map(); // key -> Promise<route | null>

const round1 = (value) => Math.round(value * 10) / 10;

const metersBetween = (a, b) => {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;

  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

const factorFor = (vehicleType) =>
  ETA_FACTOR_BY_VEHICLE[String(vehicleType || '').toLowerCase()] || 1;

// legs: [{ meters, carSeconds }] -> the route the app gets
const buildRoute = ({ source, legs, polyline, vehicleType }) => {
  const factor = factorFor(vehicleType);

  const shaped = legs.map((leg) => ({
    distanceKm: round1(leg.meters / 1000),
    driveMinutes: Math.max(1, Math.ceil((leg.carSeconds * factor) / 60)),
  }));

  const meters = legs.reduce((sum, leg) => sum + leg.meters, 0);
  const carSeconds = legs.reduce((sum, leg) => sum + leg.carSeconds, 0);

  return {
    source,
    vehicleType: vehicleType || null,
    totalKm: round1(meters / 1000),
    driveMinutes: Math.max(1, Math.ceil((carSeconds * factor) / 60)),
    legs: shaped,
    // OSRM encoded polyline (precision 5), road routes only
    polyline: polyline || null,
  };
};

const straightLineRoute = (points, vehicleType) =>
  buildRoute({
    source: 'straight_line',
    vehicleType,
    legs: points.slice(1).map((point, index) => {
      const meters = metersBetween(points[index], point) * ROAD_FACTOR;

      return { meters, carSeconds: meters / ((FALLBACK_KMH * 1000) / 3600) };
    }),
  });

const fetchRoadLegs = async (points) => {
  const path = points.map((point) => `${point.longitude},${point.latitude}`).join(';');

  const response = await fetch(
    `${ROUTING_URL}/route/v1/driving/${path}?overview=full&geometries=polyline&steps=false`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) }
  );

  const data = await response.json();
  const route = data?.routes?.[0];

  if (data?.code !== 'Ok' || !route || !Array.isArray(route.legs)) {
    throw new Error(data?.message || `routing ${response.status}`);
  }

  return {
    legs: route.legs.map((leg) => ({
      meters: Number(leg.distance) || 0,
      carSeconds: Number(leg.duration) || 0,
    })),
    polyline: typeof route.geometry === 'string' ? route.geometry : null,
  };
};

const remember = (key, value, ttl) => {
  if (cache.size >= MAX_CACHE) {
    cache.delete(cache.keys().next().value);
  }

  cache.set(key, { at: Date.now(), ttl, value });
};

// stops: [{ latitude, longitude }] in visiting order, the shopper first
// -> route (see buildRoute), or null when fewer than 2 valid stops
const offerRoute = async ({ cacheId, stops, vehicleType }) => {
  const points = (stops || [])
    .map((stop) => ({ latitude: Number(stop?.latitude), longitude: Number(stop?.longitude) }))
    .filter(
      (point) =>
        Number.isFinite(point.latitude) &&
        Number.isFinite(point.longitude) &&
        !(point.latitude === 0 && point.longitude === 0)
    );

  if (points.length < 2 || points.length !== (stops || []).length) {
    return null;
  }

  // Shopper rounded to ~100 m so GPS jitter doesn't re-route
  const key = [
    cacheId,
    ...points.map((point, index) =>
      index === 0
        ? `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`
        : `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`
    ),
  ].join('|');

  const cached = cache.get(key);

  if (cached && Date.now() - cached.at < cached.ttl) {
    return cached.value
      ? buildRoute({ source: 'road', vehicleType, ...cached.value })
      : { ...straightLineRoute(points, vehicleType), pending: false };
  }

  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      fetchRoadLegs(points)
        .then((road) => {
          remember(key, road, ROAD_TTL_MS);
          return road;
        })
        .catch((error) => {
          console.log('⚠️ OFFER ROUTE FAILED, using straight line:', error?.message);
          remember(key, null, FAILED_TTL_MS);
          return null;
        })
        .finally(() => inFlight.delete(key))
    );
  }

  let timer;
  const road = await Promise.race([
    inFlight.get(key),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('pending'), WAIT_MS);
    }),
  ]);
  clearTimeout(timer);

  if (road && road !== 'pending') {
    return buildRoute({ source: 'road', vehicleType, ...road });
  }

  // pending: the road route is still loading (next refresh has it)
  return { ...straightLineRoute(points, vehicleType), pending: road === 'pending' };
};

module.exports = {
  offerRoute,
};
