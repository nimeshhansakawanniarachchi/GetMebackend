// =====================================================
// CUSTOMER APP: activity + location endpoints (phase 51)
// Mounted at /api/customer (src/routes/customerActivityRoutes.js), all
// behind the customer authMiddleware.
//
//   GET  /activity/location-settings    consent, permission, collection on/off, retention
//   PUT  /activity/location-consent     { enabled, version }
//   POST /activity/location-permission  { status, precise }
//   POST /activity/locations            { points: [...] }  (max 100)
//   POST /activity/tracking/stop        { trackingId, reason, endedAt? }
//   POST /activity/events               { events: [...] }  (max 50, whitelisted)
//
// Points are accepted only with location sharing ON (consent to the
// current consent version) and only for fixes taken after that consent.
// =====================================================

const pool = require('../config/db');
const { getSettings, logEvent, ensureState, touch } = require('./store');
const { routeDistance } = require('./geo');

const MAX_POINTS = 100;
const MAX_EVENTS = 50;
const MAX_POINT_AGE_MS = 24 * 3600_000;
const MAX_FUTURE_MS = 2 * 60_000;
const MAX_ACCURACY_M = 5000;
const PERMISSIONS = ['granted', 'denied', 'undetermined', 'restricted'];
const STOP_REASONS = ['stopped', 'background', 'logout', 'permission_revoked', 'consent_withdrawn', 'order_finished', 'collection_disabled'];

const customerIdOf = (req) => Number(req.customer.customerId);
const sessionIdOf = (req) => (Number.isSafeInteger(Number(req.customer.sid)) ? Number(req.customer.sid) : null);
const cleanId = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null);
const num = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const fail = (res, status, code, message) => res.status(status).json({ success: false, code, message });

// Simple per-customer limiter for the upload endpoints (per minute)
const buckets = new Map();
const limited = (key, perMinute) => {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start > 60_000) {
    buckets.set(key, { start: now, count: 1 });
    if (buckets.size > 20_000) buckets.clear();
    return false;
  }
  bucket.count += 1;
  return bucket.count > perMinute;
};

const loadState = async (customerId) => {
  await ensureState(customerId);
  return (await pool.query('SELECT * FROM customer_activity_state WHERE customer_id = $1', [customerId])).rows[0];
};

const consentValid = (state, settings) =>
  Boolean(state?.location_consent) && state.consent_version === settings.consentVersion;

// =====================================================
// GET /activity/location-settings
// =====================================================

const getLocationSettings = async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const [settings, state] = await Promise.all([getSettings(), loadState(customerId)]);
    return res.json({
      success: true,
      collectionEnabled: settings.locationCollectionEnabled,
      consentVersion: settings.consentVersion,
      retentionDays: settings.locationRetentionDays,
      consent: {
        enabled: consentValid(state, settings),
        version: state.consent_version,
        changedAt: state.consent_changed_at,
        // Agreed to an older text: the app asks again
        outdated: Boolean(state.location_consent) && state.consent_version !== settings.consentVersion,
      },
      permission: state.location_permission,
    });
  } catch (error) {
    console.error('❌ LOCATION SETTINGS ERROR:', error.message);
    return fail(res, 500, 'SERVER_ERROR', 'Could not load your location settings');
  }
};

// =====================================================
// PUT /activity/location-consent
// =====================================================

const setLocationConsent = async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return fail(res, 400, 'INVALID', 'enabled must be true or false');

  try {
    const customerId = customerIdOf(req);
    const settings = await getSettings();
    if (enabled && String(req.body?.version || '') !== settings.consentVersion) {
      return fail(res, 409, 'CONSENT_VERSION', 'The location sharing text has changed. Please read it again.');
    }
    const state = await loadState(customerId);
    const before = consentValid(state, settings);

    await pool.query(
      `UPDATE customer_activity_state
          SET location_consent = $2, consent_version = CASE WHEN $2 THEN $3 ELSE consent_version END,
              consent_changed_at = NOW(), updated_at = NOW()
        WHERE customer_id = $1`,
      [customerId, enabled, settings.consentVersion]
    );

    if (before !== enabled) {
      await logEvent({
        customerId, category: 'location',
        type: enabled ? 'location.consent_given' : 'location.consent_withdrawn',
        summary: enabled ? `Turned on location sharing (terms ${settings.consentVersion})` : 'Turned off location sharing',
        details: { version: settings.consentVersion }, sessionId: sessionIdOf(req),
      });
    }

    if (!enabled) {
      await pool.query(
        `UPDATE customer_tracking_sessions SET ended_at = COALESCE(last_point_at, NOW()), end_reason = 'consent_withdrawn'
          WHERE customer_id = $1 AND ended_at IS NULL`,
        [customerId]
      );
    }

    return res.json({ success: true, consent: { enabled, version: settings.consentVersion } });
  } catch (error) {
    console.error('❌ LOCATION CONSENT ERROR:', error.message);
    return fail(res, 500, 'SERVER_ERROR', 'Could not save your choice');
  }
};

// =====================================================
// POST /activity/location-permission  (what the phone's OS reports)
// =====================================================

const reportLocationPermission = async (req, res) => {
  const status = req.body?.status;
  const precise = typeof req.body?.precise === 'boolean' ? req.body.precise : null;
  if (!PERMISSIONS.includes(status)) return fail(res, 400, 'INVALID', 'Unknown permission status');

  try {
    const customerId = customerIdOf(req);
    const state = await loadState(customerId);
    const changed = state.location_permission !== status || (precise !== null && state.permission_precise !== precise);

    if (changed) {
      await pool.query(
        `UPDATE customer_activity_state
            SET location_permission = $2, permission_precise = $3, permission_changed_at = NOW(), updated_at = NOW()
          WHERE customer_id = $1`,
        [customerId, status, precise]
      );
      await logEvent({
        customerId, category: 'location', type: 'location.permission_changed',
        summary: `Phone location permission: ${status}${precise === false ? ' (approximate only)' : precise ? ' (precise)' : ''}` +
          (state.location_permission ? ` (was ${state.location_permission})` : ''),
        details: { from: state.location_permission, to: status, precise },
        sessionId: sessionIdOf(req),
      });
      if (status !== 'granted') {
        await pool.query(
          `UPDATE customer_tracking_sessions SET ended_at = COALESCE(last_point_at, NOW()), end_reason = 'permission_revoked'
            WHERE customer_id = $1 AND ended_at IS NULL`,
          [customerId]
        );
      }
    }
    return res.json({ success: true, changed });
  } catch (error) {
    console.error('❌ LOCATION PERMISSION ERROR:', error.message);
    return fail(res, 500, 'SERVER_ERROR', 'Could not save the permission status');
  }
};

// =====================================================
// POST /activity/locations
// =====================================================

const validatePoint = (raw, consentAt, now) => {
  const id = cleanId(raw?.id);
  const trackingId = cleanId(raw?.trackingId);
  if (!id || !trackingId) return { error: 'missing_id' };

  const latitude = num(raw.latitude);
  const longitude = num(raw.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 ||
      (latitude === 0 && longitude === 0)) {
    return { id, error: 'bad_coordinates' };
  }

  const accuracy = num(raw.accuracy);
  if (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_ACCURACY_M)) {
    return { id, error: 'bad_accuracy' };
  }

  const recordedAt = new Date(raw.recordedAt);
  const t = recordedAt.getTime();
  if (!Number.isFinite(t)) return { id, error: 'bad_time' };
  if (t > now + MAX_FUTURE_MS) return { id, error: 'future_time' };
  if (t < now - MAX_POINT_AGE_MS) return { id, error: 'too_old' };
  // Fixes from before the customer turned sharing on are not kept
  if (consentAt && t < new Date(consentAt).getTime() - 5_000) return { id, error: 'before_consent' };

  const speed = num(raw.speed);
  const heading = num(raw.heading);
  const orderId = num(raw.orderId);

  return {
    point: {
      id,
      trackingId,
      purpose: raw.purpose === 'active_order' ? 'active_order' : 'app_in_use',
      orderId: Number.isSafeInteger(orderId) && orderId > 0 ? orderId : null,
      latitude,
      longitude,
      accuracy,
      speed: Number.isFinite(speed) && speed >= 0 && speed < 120 ? speed : null,
      heading: Number.isFinite(heading) && heading >= 0 && heading <= 360 ? heading : null,
      recordedAt: recordedAt.toISOString(),
    },
  };
};

// Recompute a route's totals from its points (handles late / queued points)
const refreshTrackingSession = async (client, trackingSessionId) => {
  const points = (
    await client.query(
      `SELECT latitude, longitude, accuracy_m, recorded_at FROM customer_location_points
        WHERE tracking_session_id = $1 ORDER BY recorded_at, id`,
      [trackingSessionId]
    )
  ).rows;
  if (points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const { distanceM } = routeDistance(points);
  const result = await client.query(
    `UPDATE customer_tracking_sessions
        SET point_count = $2, distance_m = $3, first_point_at = $4, last_point_at = $5,
            start_latitude = $6, start_longitude = $7, end_latitude = $8, end_longitude = $9,
            started_at = LEAST(started_at, $4)
      WHERE id = $1
      RETURNING *`,
    [trackingSessionId, points.length, distanceM, first.recorded_at, last.recorded_at,
     first.latitude, first.longitude, last.latitude, last.longitude]
  );
  return result.rows[0];
};

const recordLocations = async (req, res) => {
  const customerId = customerIdOf(req);
  const raw = req.body?.points;
  if (!Array.isArray(raw) || raw.length === 0) return fail(res, 400, 'INVALID', 'points must be a non-empty list');
  if (raw.length > MAX_POINTS) return fail(res, 413, 'TOO_MANY', `At most ${MAX_POINTS} points per request`);
  if (limited(`loc:${customerId}`, 30)) return fail(res, 429, 'RATE_LIMITED', 'Too many location uploads. Try again shortly.');

  try {
    const settings = await getSettings();
    if (!settings.locationCollectionEnabled) {
      return fail(res, 403, 'LOCATION_COLLECTION_OFF', 'GetMe is not collecting location history right now');
    }
    const state = await loadState(customerId);
    if (!consentValid(state, settings)) {
      return fail(res, 403, 'LOCATION_CONSENT_REQUIRED', 'Location sharing is off');
    }

    const now = Date.now();
    const rejected = [];
    const points = [];
    const seen = new Set();
    raw.forEach((item) => {
      const checked = validatePoint(item, state.consent_changed_at, now);
      if (checked.error) {
        rejected.push({ id: checked.id || null, reason: checked.error });
      } else if (!seen.has(checked.point.id)) {
        seen.add(checked.point.id);
        points.push(checked.point);
      }
    });

    if (points.length === 0) return res.json({ success: true, accepted: 0, duplicates: 0, rejected });

    // Orders named by the app must be this customer's
    const orderIds = [...new Set(points.map((p) => p.orderId).filter(Boolean))];
    const orders = new Map();
    if (orderIds.length) {
      const result = await pool.query(
        `SELECT id, status, delivery_latitude, delivery_longitude FROM orders WHERE customer_id = $1 AND id = ANY($2::int[])`,
        [customerId, orderIds]
      );
      result.rows.forEach((o) => orders.set(Number(o.id), o));
    }
    points.forEach((p) => {
      if (p.orderId && !orders.has(p.orderId)) p.orderId = null;
      if (!p.orderId) p.purpose = 'app_in_use';
    });

    const client = await pool.connect();
    let accepted = 0;
    const started = [];
    const touched = new Set();

    try {
      await client.query('BEGIN');

      const byTracking = new Map();
      points.forEach((p) => {
        if (!byTracking.has(p.trackingId)) byTracking.set(p.trackingId, []);
        byTracking.get(p.trackingId).push(p);
      });

      for (const [trackingId, group] of byTracking) {
        const firstPoint = group.reduce((a, b) => (a.recordedAt <= b.recordedAt ? a : b));
        const order = group.find((p) => p.orderId) ? orders.get(group.find((p) => p.orderId).orderId) : null;

        const session = (
          await client.query(
            `INSERT INTO customer_tracking_sessions
               (customer_id, client_tracking_id, session_id, order_id, purpose, started_at, destination_latitude, destination_longitude)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (customer_id, client_tracking_id) DO UPDATE
               SET order_id = COALESCE(customer_tracking_sessions.order_id, EXCLUDED.order_id),
                   destination_latitude = COALESCE(customer_tracking_sessions.destination_latitude, EXCLUDED.destination_latitude),
                   destination_longitude = COALESCE(customer_tracking_sessions.destination_longitude, EXCLUDED.destination_longitude)
             RETURNING id, (xmax = 0) AS inserted, ended_at, end_reason, purpose, order_id`,
            [customerId, trackingId, sessionIdOf(req), order ? Number(order.id) : null, order ? 'active_order' : 'app_in_use',
             firstPoint.recordedAt, order?.delivery_latitude ?? null, order?.delivery_longitude ?? null]
          )
        ).rows[0];

        // Queued points of a route the server had closed as stale reopen it
        if (session.ended_at && session.end_reason === 'stale' &&
            group.some((p) => new Date(p.recordedAt) > new Date(session.ended_at))) {
          await client.query(`UPDATE customer_tracking_sessions SET ended_at = NULL, end_reason = NULL WHERE id = $1`, [session.id]);
        }

        const inserted = await client.query(
          `INSERT INTO customer_location_points
             (customer_id, tracking_session_id, order_id, latitude, longitude, accuracy_m, speed_mps, heading, recorded_at, source, client_point_id)
           SELECT $1, $2, x.order_id, x.latitude, x.longitude, x.accuracy, x.speed, x.heading, x.recorded_at, x.source, x.client_point_id
             FROM unnest($3::int[], $4::float8[], $5::float8[], $6::real[], $7::real[], $8::real[], $9::timestamptz[], $10::text[], $11::text[])
                  AS x(order_id, latitude, longitude, accuracy, speed, heading, recorded_at, source, client_point_id)
           ON CONFLICT (customer_id, client_point_id) DO NOTHING`,
          [
            customerId, session.id,
            group.map((p) => p.orderId), group.map((p) => p.latitude), group.map((p) => p.longitude),
            group.map((p) => p.accuracy), group.map((p) => p.speed), group.map((p) => p.heading),
            group.map((p) => p.recordedAt), group.map((p) => p.purpose), group.map((p) => p.id),
          ]
        );
        accepted += inserted.rowCount;
        if (inserted.rowCount > 0) touched.add(session.id);
        if (session.inserted) started.push({ id: session.id, purpose: session.purpose, orderId: session.order_id, at: firstPoint.recordedAt });
      }

      for (const id of touched) await refreshTrackingSession(client, id);

      // Last known location: only a newer fix replaces it
      const newest = points.reduce((a, b) => (a.recordedAt >= b.recordedAt ? a : b));
      await client.query(
        `UPDATE customer_activity_state
            SET last_latitude = $2, last_longitude = $3, last_accuracy_m = $4, last_location_at = $5,
                last_location_source = $6,
                -- A phone clock running fast must not put last activity in the future
                last_activity_at = GREATEST(COALESCE(last_activity_at, LEAST($5::timestamptz, NOW())), LEAST($5::timestamptz, NOW())),
                updated_at = NOW()
          WHERE customer_id = $1 AND (last_location_at IS NULL OR last_location_at < $5)`,
        [customerId, newest.latitude, newest.longitude, newest.accuracy, newest.recordedAt, newest.purpose]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    started.forEach((s) =>
      logEvent({
        customerId, category: 'location', type: 'location.tracking_started',
        summary: s.orderId ? `Location tracking started (order #${s.orderId} active)` : 'Location tracking started (app in use)',
        details: { trackingSessionId: Number(s.id), purpose: s.purpose }, orderId: s.orderId,
        sessionId: sessionIdOf(req), occurredAt: s.at, dedupeKey: `tracking.start:${s.id}`,
      })
    );
    touch(customerId, sessionIdOf(req));

    return res.json({ success: true, accepted, duplicates: points.length - accepted, rejected });
  } catch (error) {
    console.error('❌ RECORD LOCATIONS ERROR:', error.message);
    return fail(res, 500, 'SERVER_ERROR', 'Could not save location points');
  }
};

// =====================================================
// POST /activity/tracking/stop
// =====================================================

const stopTracking = async (req, res) => {
  const trackingId = cleanId(req.body?.trackingId);
  const reason = STOP_REASONS.includes(req.body?.reason) ? req.body.reason : 'stopped';
  if (!trackingId) return fail(res, 400, 'INVALID', 'trackingId is required');

  try {
    const customerId = customerIdOf(req);
    const endedAt = new Date(req.body?.endedAt);
    const endTime = Number.isFinite(endedAt.getTime()) && endedAt.getTime() <= Date.now() + MAX_FUTURE_MS ? endedAt.toISOString() : null;

    const row = (
      await pool.query(
        `UPDATE customer_tracking_sessions
            SET ended_at = GREATEST(started_at, LEAST(NOW(), COALESCE($3::timestamptz, NOW()))), end_reason = $4
          WHERE customer_id = $1 AND client_tracking_id = $2 AND ended_at IS NULL
          RETURNING id, ended_at, point_count, distance_m, order_id`,
        [customerId, trackingId, endTime, reason]
      )
    ).rows[0];

    if (row) {
      const km = Number(row.distance_m) / 1000;
      await logEvent({
        customerId, category: 'location', type: 'location.tracking_stopped',
        summary: `Location tracking stopped (${reason.replace('_', ' ')}) · ${row.point_count} points` +
          (Number(row.distance_m) > 0 ? ` · ${km >= 1 ? `${km.toFixed(1)} km` : `${Math.round(Number(row.distance_m))} m`} moved` : ''),
        details: { trackingSessionId: Number(row.id), reason, points: row.point_count, distanceM: Number(row.distance_m) },
        orderId: row.order_id, sessionId: sessionIdOf(req), occurredAt: row.ended_at, dedupeKey: `tracking.end:${row.id}`,
      });
    }
    return res.json({ success: true, stopped: Boolean(row) });
  } catch (error) {
    console.error('❌ STOP TRACKING ERROR:', error.message);
    return fail(res, 500, 'SERVER_ERROR', 'Could not stop tracking');
  }
};

// =====================================================
// POST /activity/events  (browsing + cart events from the app)
// Names come from the database, never from the app's text.
// =====================================================

const APP_EVENTS = {
  'browsing.shop_opened': { category: 'browsing', needs: ['shopId'] },
  'cart.item_added': { category: 'cart', needs: ['productId'] },
  'cart.item_removed': { category: 'cart', needs: ['productId'] },
  'cart.quantity_changed': { category: 'cart', needs: ['productId'] },
  'cart.cleared': { category: 'cart', needs: [] },
};

const positiveInt = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const recordEvents = async (req, res) => {
  const customerId = customerIdOf(req);
  const raw = req.body?.events;
  if (!Array.isArray(raw) || raw.length === 0) return fail(res, 400, 'INVALID', 'events must be a non-empty list');
  if (raw.length > MAX_EVENTS) return fail(res, 413, 'TOO_MANY', `At most ${MAX_EVENTS} events per request`);
  if (limited(`ev:${customerId}`, 30)) return fail(res, 429, 'RATE_LIMITED', 'Too many events. Try again shortly.');

  try {
    const now = Date.now();
    const events = [];
    let rejected = 0;

    raw.forEach((e) => {
      const spec = APP_EVENTS[e?.type];
      const id = cleanId(e?.id);
      const at = new Date(e?.occurredAt);
      const t = at.getTime();
      const d = e?.details || {};
      const details = {
        shopId: positiveInt(d.shopId),
        productId: positiveInt(d.productId),
        quantity: positiveInt(d.quantity),
        itemCount: Number.isSafeInteger(Number(d.itemCount)) && Number(d.itemCount) >= 0 ? Number(d.itemCount) : null,
      };
      if (!spec || !id || !Number.isFinite(t) || t > now + MAX_FUTURE_MS || t < now - MAX_POINT_AGE_MS ||
          spec.needs.some((key) => !details[key])) {
        rejected += 1;
        return;
      }
      events.push({ id, type: e.type, spec, at: at.toISOString(), details });
    });

    const productIds = [...new Set(events.map((e) => e.details.productId).filter(Boolean))];
    const shopIds = [...new Set(events.map((e) => e.details.shopId).filter(Boolean))];
    const [products, shops] = await Promise.all([
      productIds.length
        ? pool.query('SELECT id, product_name AS name, shop_id FROM products WHERE id = ANY($1::int[])', [productIds])
        : { rows: [] },
      shopIds.length ? pool.query('SELECT id, shop_name FROM shops WHERE id = ANY($1::int[])', [shopIds]) : { rows: [] },
    ]);
    const productMap = new Map(products.rows.map((p) => [Number(p.id), p]));
    const shopMap = new Map(shops.rows.map((s) => [Number(s.id), s.shop_name]));

    let saved = 0;
    let unknown = 0;
    for (const e of events) {
      const product = e.details.productId ? productMap.get(e.details.productId) : null;
      if (e.details.productId && !product) {
        unknown += 1;
        continue;
      }
      const shopId = e.details.shopId || (product ? Number(product.shop_id) : null);
      if (e.type === 'browsing.shop_opened' && !shopMap.has(shopId)) {
        unknown += 1;
        continue;
      }
      const name = product?.name ? String(product.name).slice(0, 80) : null;
      const shopName = shopMap.get(shopId) || null;
      const summary = {
        'browsing.shop_opened': `Opened ${shopName}`,
        'cart.item_added': `Added ${e.details.quantity || 1} × ${name} to the cart`,
        'cart.item_removed': `Removed ${name} from the cart`,
        'cart.quantity_changed': `Changed ${name} to ${e.details.quantity || '?'} in the cart`,
        'cart.cleared': `Emptied the cart${e.details.itemCount != null ? ` (${e.details.itemCount} items)` : ''}`,
      }[e.type];

      const id = await logEvent({
        customerId, category: e.spec.category, type: e.type, summary, source: 'app',
        details: Object.fromEntries(Object.entries({ ...e.details, shopId, productName: name, shopName }).filter(([, v]) => v != null)),
        sessionId: sessionIdOf(req), occurredAt: e.at, dedupeKey: `app:${customerId}:${e.id}`,
      });
      if (id) saved += 1;
    }

    touch(customerId, sessionIdOf(req));
    return res.json({ success: true, saved, duplicates: events.length - unknown - saved, rejected: rejected + unknown });
  } catch (error) {
    console.error('❌ ACTIVITY EVENTS ERROR:', error.message);
    return fail(res, 500, 'SERVER_ERROR', 'Could not save activity');
  }
};

module.exports = {
  getLocationSettings,
  setLocationConsent,
  reportLocationPermission,
  recordLocations,
  stopTracking,
  recordEvents,
};
