// =====================================================
// PHASE 60: WHICH DISTRICT IS A DELIVERY ADDRESS IN?
// Shop-managed delivery is offered per district (the shop lists the
// districts it serves). Order of trust:
//   1. a district the customer confirmed in the app (validated)
//   2. the address's Google place (Places API "addressComponents":
//      administrative_area_level_2 = district), cached per place
//   3. the nearest district centre - marked 'approximate', so the app
//      asks the customer to confirm it
// (Google's Geocoding API is not enabled on GetMe's key, so a plain
//  map pin without a place has no exact district.)
// =====================================================

const pool = require('../config/db');
const { PROVINCES } = require('./common');

const DISTRICTS = PROVINCES.flatMap((p) => p.districts.map((name) => ({ name, province: p.name })));

// District capitals (approximate centres)
const CENTRES = {
  Colombo: [6.9271, 79.8612], Gampaha: [7.0873, 80.0144], Kalutara: [6.5854, 79.9607],
  Kandy: [7.2906, 80.6337], Matale: [7.4675, 80.6234], 'Nuwara Eliya': [6.9497, 80.7891],
  Galle: [6.0535, 80.221], Matara: [5.9549, 80.555], Hambantota: [6.1241, 81.1185],
  Jaffna: [9.6615, 80.0255], Kilinochchi: [9.3803, 80.377], Mannar: [8.981, 79.9044],
  Vavuniya: [8.7514, 80.4971], Mullaitivu: [9.2671, 80.8142], Batticaloa: [7.731, 81.6747],
  Ampara: [7.2975, 81.682], Trincomalee: [8.5874, 81.2152], Kurunegala: [7.4863, 80.3647],
  Puttalam: [8.0362, 79.8283], Anuradhapura: [8.3114, 80.4037], Polonnaruwa: [7.9403, 81.0188],
  Badulla: [6.9934, 81.055], Monaragala: [6.8728, 81.3507], Ratnapura: [6.6828, 80.3992],
  Kegalle: [7.2513, 80.3464],
};

const normalize = (value) => {
  const text = String(value || '').replace(/district/i, '').trim().toLowerCase();
  if (!text) return null;
  const hit = DISTRICTS.find((d) => d.name.toLowerCase() === text);
  return hit ? hit.name : null;
};

const kmBetween = (aLat, aLng, bLat, bLng) => {
  const r = (deg) => (deg * Math.PI) / 180;
  const dLat = r(bLat - aLat);
  const dLng = r(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};

const nearestDistrict = (latitude, longitude) => {
  let best = null;
  for (const [name, [lat, lng]] of Object.entries(CENTRES)) {
    const km = kmBetween(latitude, longitude, lat, lng);
    if (!best || km < best.km) best = { name, km };
  }
  return best?.name || null;
};

const fromPlace = async (placeId) => {
  const id = String(placeId || '').trim();
  if (!id || id.length > 300 || !/^[A-Za-z0-9_-]+$/.test(id)) return null;

  const cached = (await pool.query('SELECT district FROM place_districts WHERE place_id = $1', [id])).rows[0];
  if (cached) return cached.district ? normalize(cached.district) : null;

  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'addressComponents' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parts = data.addressComponents || [];
    const level2 = parts.find((c) => (c.types || []).includes('administrative_area_level_2'));
    const level1 = parts.find((c) => (c.types || []).includes('administrative_area_level_1'));
    const district = normalize(level2?.longText);
    await pool.query(
      `INSERT INTO place_districts (place_id, district, province) VALUES ($1, $2, $3)
       ON CONFLICT (place_id) DO UPDATE SET district = $2, province = $3, fetched_at = NOW()`,
      [id, district, level1?.longText ? String(level1.longText).slice(0, 40) : null]
    );
    return district;
  } catch (error) {
    console.error('❌ PLACE DISTRICT:', error.message);
    return null;
  }
};

// -> { district, source: 'customer'|'place'|'approximate'|null }
const resolveDistrict = async ({ declared, placeId, latitude, longitude } = {}) => {
  const confirmed = normalize(declared);
  if (confirmed) return { district: confirmed, source: 'customer' };

  const placed = await fromPlace(placeId);
  if (placed) return { district: placed, source: 'place' };

  // (null / '' must not become 0,0)
  const lat = latitude == null || latitude === '' ? NaN : Number(latitude);
  const lng = longitude == null || longitude === '' ? NaN : Number(longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { district: nearestDistrict(lat, lng), source: 'approximate' };
  }
  return { district: null, source: null };
};

module.exports = { DISTRICTS, CENTRES, normalize, resolveDistrict, nearestDistrict, kmBetween };
