// =====================================================
// CUSTOMER ROUTES: distance + gaps from recorded GPS points (phase 51)
//
// A route is the customer's GPS points joined in time order. Nothing
// is snapped to roads. Distance counts only movement we can trust:
// * points with accuracy <= ACCURATE_M (unknown accuracy is not counted)
// * consecutive points at most GAP_SECONDS apart (a longer silence is a
//   gap: we don't know the path, so it adds no distance)
// * movement larger than the GPS noise (jitter while standing still
//   would otherwise add metres every minute)
// * no jumps faster than MAX_SPEED_MPS (a bad fix, not travel)
// =====================================================

const EARTH_RADIUS_M = 6371008.8;
const ACCURATE_M = 50;
const GAP_SECONDS = 300;
const GAP_JUMP_M = 2000;
const MIN_STEP_M = 10;
const MAX_SPEED_MPS = 55; // ~200 km/h

const toRad = (deg) => (deg * Math.PI) / 180;

const haversineMeters = (a, b) => {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

const timeOf = (p) => new Date(p.recordedAt ?? p.recorded_at).getTime();
const accuracyOf = (p) => {
  const value = p.accuracyM ?? p.accuracy_m;
  return value == null ? null : Number(value);
};

// points: [{ latitude, longitude, accuracyM, recordedAt }] in any order
// -> { distanceM, countedPoints, reliable }
const routeDistance = (points) => {
  const usable = points
    .filter((p) => {
      const accuracy = accuracyOf(p);
      return accuracy != null && accuracy <= ACCURATE_M;
    })
    .sort((a, b) => timeOf(a) - timeOf(b));

  let distanceM = 0;
  let counted = 0;
  let anchor = null;

  usable.forEach((point) => {
    if (!anchor) {
      anchor = point;
      counted += 1;
      return;
    }
    const seconds = (timeOf(point) - timeOf(anchor)) / 1000;
    const meters = haversineMeters(anchor, point);

    if (seconds > GAP_SECONDS) {
      // Unknown path: start again from here
      anchor = point;
      counted += 1;
      return;
    }
    if (seconds > 0 && meters / seconds > MAX_SPEED_MPS) return;

    const noise = Math.max(MIN_STEP_M, (accuracyOf(anchor) + accuracyOf(point)) / 2);
    if (meters < noise) return;

    distanceM += meters;
    anchor = point;
    counted += 1;
  });

  return {
    distanceM: Math.round(distanceM * 10) / 10,
    countedPoints: counted,
    reliable: counted >= 2,
  };
};

// Ordered points -> gaps the map must not draw as travel
// [{ afterIndex, seconds, meters }]
const findGaps = (ordered) => {
  const gaps = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const seconds = (timeOf(ordered[i]) - timeOf(ordered[i - 1])) / 1000;
    const meters = haversineMeters(ordered[i - 1], ordered[i]);
    if (seconds > GAP_SECONDS || meters > GAP_JUMP_M) {
      gaps.push({ afterIndex: i - 1, seconds: Math.round(seconds), meters: Math.round(meters) });
    }
  }
  return gaps;
};

module.exports = {
  ACCURATE_M,
  GAP_SECONDS,
  GAP_JUMP_M,
  haversineMeters,
  routeDistance,
  findGaps,
};
