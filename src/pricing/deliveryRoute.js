// =====================================================
// DELIVERY ROUTE (prices the delivery fee)
// Road route of the delivery: the order's shop(s), then the
// customer. Never a straight line - when no road route can be
// found the quote says so and the order can't be placed.
//
// Providers, in order:
//   google - Routes API computeRoutes, TRAFFIC_AWARE (backend key
//            GOOGLE_MAPS_API_KEY; never sent to the apps). duration
//            = with current traffic, staticDuration = typical.
//   osrm   - OSRM route API (ROUTING_URL, same server as
//            utils/offerRoute.js): road distance + typical car
//            time, no traffic.
// DELIVERY_ROUTING=osrm skips Google.
//
// Shop order (multi-shop orders): the shop farthest from the
// customer first, then the nearest remaining shop each time, the
// customer last - the order a shopper would normally drive.
//
// Results are cached by exact stops (5 decimals ~ 1 m): a traffic
// route for TRAFFIC_TTL_MS, a typical-time route for ROAD_TTL_MS,
// so checkout's quote and the order placed a moment later price
// the same route. Concurrent requests for the same stops share
// one provider call.
// =====================================================

const GOOGLE_ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const osrmUrl = () =>
  (process.env.ROUTING_URL || 'https://router.project-osrm.org').replace(/\/+$/, '');

const TIMEOUT_MS = 6000;
const TRAFFIC_TTL_MS = 10 * 60 * 1000;
const ROAD_TTL_MS = 30 * 60 * 1000;
const FAILED_TTL_MS = 30 * 1000;
const MAX_CACHE = 500;

const cache = new Map(); // key -> { at, ttl, value }
const inFlight = new Map(); // key -> Promise<value>

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const validPoint = (point) =>
  point &&
  Number.isFinite(point.latitude) &&
  Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 &&
  Math.abs(point.longitude) <= 180 &&
  !(point.latitude === 0 && point.longitude === 0);

const metersBetween = (a, b) => {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;

  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

// Farthest shop from the customer first, then nearest-next.
// (Straight lines only choose the ORDER; distances are by road.)
const orderShops = (shops, destination) => {
  if (shops.length <= 1) {
    return shops.slice();
  }

  const left = shops.slice();
  left.sort((a, b) => metersBetween(b, destination) - metersBetween(a, destination) || a.id - b.id);

  const ordered = [left.shift()];

  while (left.length) {
    const last = ordered[ordered.length - 1];
    left.sort((a, b) => metersBetween(last, a) - metersBetween(last, b) || a.id - b.id);
    ordered.push(left.shift());
  }

  return ordered;
};

const seconds = (value) => {
  const number = Number(String(value ?? '').replace(/s$/, ''));
  return Number.isFinite(number) ? number : null;
};

const latLng = (point) => ({
  location: { latLng: { latitude: point.latitude, longitude: point.longitude } },
});

// -> { legs: [{ meters, seconds, typicalSeconds }], traffic: true }
//    or null (no route between these points)
const fromGoogle = async (points) => {
  const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();

  if (!key) {
    throw new Error('no Google key');
  }

  const response = await fetch(GOOGLE_ROUTES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'routes.distanceMeters,routes.duration,routes.staticDuration,' +
        'routes.legs.distanceMeters,routes.legs.duration,routes.legs.staticDuration',
    },
    body: JSON.stringify({
      origin: latLng(points[0]),
      destination: latLng(points[points.length - 1]),
      intermediates: points.slice(1, -1).map(latLng),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      units: 'METRIC',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`google ${response.status} ${data?.error?.status || ''}`.trim());
  }

  const route = data?.routes?.[0];

  // 200 with no routes = Google found no road between the points
  if (!route) {
    return null;
  }

  const legs = (route.legs || []).map((leg) => ({
    meters: Number(leg.distanceMeters) || 0,
    seconds: seconds(leg.duration) ?? 0,
    typicalSeconds: seconds(leg.staticDuration) ?? seconds(leg.duration) ?? 0,
  }));

  if (legs.length !== points.length - 1) {
    throw new Error('google: unexpected route shape');
  }

  return { legs, traffic: true };
};

const fromOsrm = async (points) => {
  const path = points.map((point) => `${point.longitude},${point.latitude}`).join(';');

  const response = await fetch(
    `${osrmUrl()}/route/v1/driving/${path}?overview=false&steps=false`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) }
  );

  const data = await response.json().catch(() => ({}));

  if (data?.code === 'NoRoute') {
    return null;
  }

  const route = data?.routes?.[0];

  if (data?.code !== 'Ok' || !route || !Array.isArray(route.legs)) {
    throw new Error(`osrm ${response.status} ${data?.code || ''}`.trim());
  }

  return {
    legs: route.legs.map((leg) => ({
      meters: Number(leg.distance) || 0,
      seconds: Number(leg.duration) || 0,
      typicalSeconds: Number(leg.duration) || 0,
    })),
    traffic: false,
  };
};

const PROVIDERS = { google: fromGoogle, osrm: fromOsrm };

const providerOrder = () =>
  String(process.env.DELIVERY_ROUTING || '').trim().toLowerCase() === 'osrm'
    ? ['osrm']
    : ['google', 'osrm'];

// -> value cached for these points (see resolveDeliveryRoute)
const routePoints = async (points) => {
  let noRoute = false;

  for (const name of providerOrder()) {
    try {
      const road = await PROVIDERS[name](points);

      if (!road) {
        noRoute = true;
        continue;
      }

      return { ok: true, source: name, ...road };
    } catch (error) {
      console.log(`⚠️ DELIVERY ROUTE (${name}) FAILED:`, error?.message);
    }
  }

  return noRoute
    ? { ok: false, code: 'no_route', message: "We couldn't find a road route to this address. Check the delivery pin." }
    : { ok: false, code: 'route_unavailable', message: "We couldn't work out the delivery route right now. Please try again in a moment." };
};

const remember = (key, value) => {
  if (cache.size >= MAX_CACHE) {
    cache.delete(cache.keys().next().value);
  }

  const ttl = !value.ok ? FAILED_TTL_MS : value.traffic ? TRAFFIC_TTL_MS : ROAD_TTL_MS;
  cache.set(key, { at: Date.now(), ttl, value });
};

// shops: [{ id, latitude, longitude }], destination: { latitude, longitude }
// -> { ok: true, source: 'google' | 'osrm', traffic, distanceKm,
//      carMinutes (with traffic when traffic), typicalCarMinutes,
//      shopOrder: [shop ids], legs: [{ distanceKm, carMinutes }],
//      computedAt }
//  | { ok: false, code: 'no_location' | 'no_route' | 'route_unavailable', message }
const resolveDeliveryRoute = async ({ shops, destination }) => {
  const target = {
    latitude: Number(destination?.latitude),
    longitude: Number(destination?.longitude),
  };

  const stops = (shops || []).map((shop) => ({
    id: Number(shop.id),
    latitude: Number(shop.latitude),
    longitude: Number(shop.longitude),
  }));

  if (!validPoint(target) || stops.length === 0 || !stops.every(validPoint)) {
    return { ok: false, code: 'no_location', message: 'The delivery route needs the shop and delivery locations' };
  }

  const ordered = orderShops(stops, target);
  const points = [...ordered, target];
  const key = points.map((point) => `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`).join('|');

  const cached = cache.get(key);
  let value;

  if (cached && Date.now() - cached.at < cached.ttl) {
    value = cached.value;
  } else {
    if (!inFlight.has(key)) {
      inFlight.set(
        key,
        routePoints(points)
          .then((result) => {
            remember(key, { ...result, computedAt: new Date().toISOString() });
            return cache.get(key).value;
          })
          .finally(() => inFlight.delete(key))
      );
    }

    value = await inFlight.get(key);
  }

  if (!value.ok) {
    return { ok: false, code: value.code, message: value.message };
  }

  const meters = value.legs.reduce((sum, leg) => sum + leg.meters, 0);
  const secs = value.legs.reduce((sum, leg) => sum + leg.seconds, 0);
  const typical = value.legs.reduce((sum, leg) => sum + leg.typicalSeconds, 0);

  return {
    ok: true,
    source: value.source,
    traffic: value.traffic,
    distanceKm: round2(meters / 1000),
    carMinutes: Math.max(1, Math.ceil(secs / 60)),
    typicalCarMinutes: Math.max(1, Math.ceil(typical / 60)),
    shopOrder: ordered.map((shop) => shop.id),
    legs: value.legs.map((leg) => ({
      distanceKm: round2(leg.meters / 1000),
      carMinutes: Math.max(1, Math.ceil(leg.seconds / 60)),
    })),
    computedAt: value.computedAt,
  };
};

// Tests only: forget cached routes
const clearRouteCache = () => cache.clear();

module.exports = {
  resolveDeliveryRoute,
  orderShops,
  clearRouteCache,
};
