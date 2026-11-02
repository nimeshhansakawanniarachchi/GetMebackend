// =====================================================
// ADMIN: CUSTOMER ACTIVITY (phase 51)
//
// customers.activity  online status, sign-ins, visits, timeline
// customers.location  last known location, GPS points, routes
//                     (every view is written to the audit log, at most
//                     once per admin / customer / kind per 10 minutes)
//
//   GET /customer-activity/summary
//   GET /customer-activity/customers?search=&presence=&sharing=&from=&to=&page=
//   GET /customer-activity/settings          PUT (security.settings)
//   GET /customers/:id/activity/overview
//   GET /customers/:id/activity/events?from=&to=&category=&page=
//   GET /customers/:id/activity/sessions?from=&to=&page=      sign-ins
//   GET /customers/:id/activity/visits?from=&to=&page=        online periods
//   GET /customers/:id/activity/routes?from=&to=&orderId=&page=
//   GET /customers/:id/activity/routes/:routeId               points + gaps for the map
//   GET /customers/:id/activity/locations?from=&to=&orderId=&page=
//
// from / to: YYYY-MM-DD (Sri Lanka days, inclusive) or YYYY-MM-DDTHH:mm
// (Sri Lanka time). Default: the last 7 days.
// =====================================================

const pool = require('../config/db');
const { readPage, pageMeta } = require('../utils/pagination');
const { adminCan, recordAdminAudit } = require('../middleware/adminAccess');
const { getSettings, clearSettingsCache, CATEGORIES } = require('./store');
const { findGaps, routeDistance } = require('./geo');
const { GRACE_MS } = require('./presence');

const DAY = 86400_000;
const MAX_RANGE_DAYS = 366;
const MAX_ROUTE_POINTS = 5000;

const fail = (res, status, message, code) => res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
const n = (value) => (value == null ? null : Number(value));

// -----------------------------------------------------
// Date range (process TZ is Asia/Colombo, src/config/db.js)
// -----------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

const parseBound = (value, end) => {
  if (typeof value !== 'string' || !value) return null;
  if (DATE_RE.test(value)) {
    const day = new Date(`${value}T00:00:00`);
    return Number.isFinite(day.getTime()) ? new Date(day.getTime() + (end ? DAY : 0)) : undefined;
  }
  if (DATETIME_RE.test(value)) {
    const at = new Date(value);
    return Number.isFinite(at.getTime()) ? at : undefined;
  }
  return undefined;
};

// -> { from, to } (to exclusive) or { error }
const readRange = (query) => {
  const from = parseBound(query.from, false);
  const to = parseBound(query.to, true);
  if (from === undefined || to === undefined) return { error: 'from / to must be YYYY-MM-DD or YYYY-MM-DDTHH:mm' };
  const end = to || new Date(Date.now() + 60_000);
  const start = from || new Date(end.getTime() - 7 * DAY);
  if (start >= end) return { error: 'from must be before to' };
  if (end - start > MAX_RANGE_DAYS * DAY) return { error: `The range can be at most ${MAX_RANGE_DAYS} days` };
  return { from: start, to: end };
};

const customerIdParam = (req) => {
  const id = Number(req.params.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const loadCustomer = async (id) =>
  (await pool.query('SELECT id, full_name, mobile, email, created_at, account_status FROM customers WHERE id = $1', [id])).rows[0];

// -----------------------------------------------------
// Location access is audited (throttled)
// -----------------------------------------------------

const auditSeen = new Map();
const AUDIT_EVERY_MS = 10 * 60_000;

const auditLocationView = (req, customerId, kind, summary) => {
  const key = `${req.admin?.adminId}:${customerId}:${kind}`;
  const now = Date.now();
  if (now - (auditSeen.get(key) || 0) < AUDIT_EVERY_MS) return;
  auditSeen.set(key, now);
  if (auditSeen.size > 20_000) auditSeen.clear();
  recordAdminAudit({
    admin: req.admin,
    action: 'customer.location_viewed',
    entityType: 'customer',
    entityId: customerId,
    summary,
    details: { kind, from: req.query.from || null, to: req.query.to || null, routeId: req.params.routeId || null },
    ip: req.ip,
  });
};

// -----------------------------------------------------
// Presence helpers
// -----------------------------------------------------

// online | reconnecting | offline (+ since)
const presenceOf = (row) => {
  if (!row?.presence_state) return { status: 'offline', since: row?.last_visit_end || null };
  if (row.presence_state === 'online') return { status: 'online', since: row.presence_started_at };
  return { status: 'reconnecting', since: row.presence_changed_at };
};

const OPEN_PRESENCE_JOIN = `
  LEFT JOIN LATERAL (
    SELECT p.state AS presence_state, p.started_at AS presence_started_at, p.state_changed_at AS presence_changed_at,
           p.platform AS presence_platform
      FROM customer_presence p
     WHERE p.customer_id = c.id AND p.state <> 'ended'
     ORDER BY (p.state = 'online') DESC, p.started_at DESC
     LIMIT 1
  ) op ON TRUE
  LEFT JOIN LATERAL (
    SELECT MAX(p.ended_at) AS last_visit_end FROM customer_presence p WHERE p.customer_id = c.id AND p.state = 'ended'
  ) lv ON TRUE`;

const lastLocationOf = (row, allowed) =>
  allowed && row.last_location_at
    ? {
        latitude: n(row.last_latitude),
        longitude: n(row.last_longitude),
        accuracyM: n(row.last_accuracy_m),
        at: row.last_location_at,
        source: row.last_location_source,
      }
    : null;

// =====================================================
// GET /customer-activity/summary
// =====================================================

const getSummary = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(DISTINCT customer_id)::int FROM customer_presence WHERE state = 'online') AS online,
        (SELECT COUNT(DISTINCT customer_id)::int FROM customer_presence WHERE state = 'disconnected') AS reconnecting,
        (SELECT COUNT(*)::int FROM customer_activity_state WHERE last_activity_at >= date_trunc('day', NOW())) AS active_today,
        (SELECT COUNT(*)::int FROM customer_activity_state WHERE last_activity_at >= NOW() - INTERVAL '7 days') AS active_7d,
        (SELECT COUNT(*)::int FROM customer_activity_state s, customer_activity_settings cfg
           WHERE s.location_consent AND s.consent_version = cfg.consent_version) AS sharing_location,
        (SELECT COUNT(*)::int FROM customer_tracking_sessions WHERE ended_at IS NULL) AS open_routes,
        (SELECT COUNT(*)::int FROM customers) AS customers
    `);
    const settings = await getSettings();
    const r = result.rows[0];
    return res.json({
      success: true,
      summary: {
        online: r.online,
        reconnecting: r.reconnecting,
        activeToday: r.active_today,
        active7d: r.active_7d,
        sharingLocation: r.sharing_location,
        openRoutes: adminCan(req, 'customers.location') ? r.open_routes : null,
        customers: r.customers,
      },
      graceSeconds: Math.round(GRACE_MS / 1000),
      settings,
    });
  } catch (error) {
    console.error('❌ admin activity summary error:', error.message);
    return fail(res, 500, 'Unable to load the activity summary');
  }
};

// =====================================================
// GET /customer-activity/customers
// =====================================================

const listCustomers = async (req, res) => {
  try {
    const paging = readPage(req.query);
    const params = [];
    const where = [];
    const canLocation = adminCan(req, 'customers.location');

    const search = String(req.query.search || '').trim().toLowerCase();
    if (search) {
      params.push(`%${search}%`);
      const idMatch = /^#?\d+$/.test(search) ? ` OR c.id = ${Number(search.replace('#', ''))}` : '';
      where.push(`(LOWER(c.full_name) LIKE $${params.length} OR LOWER(c.email) LIKE $${params.length} OR c.mobile LIKE $${params.length}${idMatch})`);
    }
    if (req.query.presence === 'online') where.push(`op.presence_state = 'online'`);
    if (req.query.presence === 'reconnecting') where.push(`op.presence_state = 'disconnected'`);
    if (req.query.presence === 'offline') where.push(`op.presence_state IS NULL`);
    if (req.query.sharing === 'on') where.push(`s.location_consent AND s.consent_version = cfg.consent_version`);
    if (req.query.sharing === 'off') where.push(`NOT COALESCE(s.location_consent AND s.consent_version = cfg.consent_version, FALSE)`);
    if (['active', 'restricted', 'blocked'].includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`c.account_status = $${params.length}`);
    }
    // Last activity inside the range
    if (req.query.from || req.query.to) {
      const range = readRange(req.query);
      if (range.error) return fail(res, 400, range.error);
      params.push(range.from, range.to);
      where.push(`s.last_activity_at >= $${params.length - 1} AND s.last_activity_at < $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `
      FROM customers c
      CROSS JOIN customer_activity_settings cfg
      LEFT JOIN customer_activity_state s ON s.customer_id = c.id
      ${OPEN_PRESENCE_JOIN}
      ${whereSql}`;

    const total = (await pool.query(`SELECT COUNT(*)::int AS total ${from}`, params)).rows[0].total;
    const listParams = [...params, paging.pageSize, paging.offset];
    const rows = (
      await pool.query(
        `SELECT c.id, c.full_name, c.mobile, c.email, c.account_status, c.created_at,
                s.last_activity_at, s.last_login_at, s.last_logout_at, s.location_permission,
                (s.location_consent AND s.consent_version = cfg.consent_version) AS sharing,
                s.last_latitude, s.last_longitude, s.last_accuracy_m, s.last_location_at, s.last_location_source,
                op.*, lv.last_visit_end
         ${from}
         ORDER BY (op.presence_state = 'online') DESC NULLS LAST, s.last_activity_at DESC NULLS LAST, c.id DESC
         LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
        listParams
      )
    ).rows;

    if (canLocation && rows.some((r) => r.last_location_at)) {
      auditLocationView(req, 'list', 'list', 'Viewed last known locations on the Customer activity list');
    }

    return res.json({
      success: true,
      ...pageMeta(paging, total),
      canViewLocation: canLocation,
      customers: rows.map((r) => ({
        id: r.id,
        fullName: r.full_name,
        mobile: r.mobile,
        email: r.email,
        accountStatus: r.account_status,
        createdAt: r.created_at,
        presence: { ...presenceOf(r), platform: r.presence_platform || null },
        lastActivityAt: r.last_activity_at,
        lastLoginAt: r.last_login_at,
        lastLogoutAt: r.last_logout_at,
        locationSharing: Boolean(r.sharing),
        locationPermission: r.location_permission,
        lastLocationAt: canLocation ? r.last_location_at : null,
        lastLocation: lastLocationOf(r, canLocation),
      })),
    });
  } catch (error) {
    console.error('❌ admin activity customers error:', error.message);
    return fail(res, 500, 'Unable to load customer activity');
  }
};

// =====================================================
// GET /customers/:id/activity/overview
// =====================================================

const getOverview = async (req, res) => {
  const customerId = customerIdParam(req);
  if (!customerId) return fail(res, 400, 'Invalid customer id');

  try {
    const customer = await loadCustomer(customerId);
    if (!customer) return fail(res, 404, 'Customer not found');
    const canLocation = adminCan(req, 'customers.location');

    const row = (
      await pool.query(
        `SELECT s.*, (s.location_consent AND s.consent_version = cfg.consent_version) AS sharing, op.*, lv.last_visit_end
           FROM customers c
           CROSS JOIN customer_activity_settings cfg
           LEFT JOIN customer_activity_state s ON s.customer_id = c.id
           ${OPEN_PRESENCE_JOIN}
          WHERE c.id = $1`,
        [customerId]
      )
    ).rows[0];

    const [openVisit, openSession, counts, openRoute] = await Promise.all([
      pool.query(
        `SELECT id, started_at, state, state_changed_at, last_seen_at, platform, app_version, reconnect_count, interrupted_seconds
           FROM customer_presence WHERE customer_id = $1 AND state <> 'ended' ORDER BY started_at DESC LIMIT 1`,
        [customerId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS open, MAX(started_at) AS latest FROM customer_sessions WHERE customer_id = $1 AND ended_at IS NULL`,
        [customerId]
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM customer_activity_events WHERE customer_id = $1) AS events,
           (SELECT COUNT(*)::int FROM customer_sessions WHERE customer_id = $1) AS sign_ins,
           (SELECT COUNT(*)::int FROM customer_presence WHERE customer_id = $1) AS visits,
           (SELECT COUNT(*)::int FROM customer_tracking_sessions WHERE customer_id = $1) AS routes,
           (SELECT COUNT(*)::int FROM customer_location_points WHERE customer_id = $1) AS points`,
        [customerId]
      ),
      canLocation
        ? pool.query(
            `SELECT id, started_at, last_point_at, point_count, order_id, purpose FROM customer_tracking_sessions
              WHERE customer_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
            [customerId]
          )
        : { rows: [] },
    ]);

    if (canLocation && row.last_location_at) {
      auditLocationView(req, customerId, 'overview', 'Viewed the last known location');
    }

    const visit = openVisit.rows[0];
    const c = counts.rows[0];
    const settings = await getSettings();

    return res.json({
      success: true,
      canViewLocation: canLocation,
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        mobile: customer.mobile,
        email: customer.email,
        accountStatus: customer.account_status,
        createdAt: customer.created_at,
      },
      presence: {
        ...presenceOf(row),
        platform: visit?.platform || null,
        appVersion: visit?.app_version || null,
        visitStartedAt: visit?.started_at || null,
        lastSeenAt: visit?.last_seen_at || null,
        reconnects: visit?.reconnect_count ?? 0,
        graceSeconds: Math.round(GRACE_MS / 1000),
      },
      openSignIns: openSession.rows[0].open,
      lastActivityAt: row.last_activity_at || null,
      lastLoginAt: row.last_login_at || null,
      lastLogoutAt: row.last_logout_at || null,
      location: {
        sharing: Boolean(row.sharing),
        consentVersion: row.consent_version || null,
        consentChangedAt: row.consent_changed_at || null,
        currentConsentVersion: settings.consentVersion,
        permission: row.location_permission || null,
        precise: row.permission_precise ?? null,
        permissionChangedAt: row.permission_changed_at || null,
        last: lastLocationOf(row, canLocation),
        openRoute: canLocation && openRoute.rows[0]
          ? {
              id: Number(openRoute.rows[0].id),
              startedAt: openRoute.rows[0].started_at,
              lastPointAt: openRoute.rows[0].last_point_at,
              points: openRoute.rows[0].point_count,
              orderId: openRoute.rows[0].order_id,
              purpose: openRoute.rows[0].purpose,
            }
          : null,
      },
      counts: {
        events: c.events,
        signIns: c.sign_ins,
        visits: c.visits,
        routes: canLocation ? c.routes : null,
        points: canLocation ? c.points : null,
      },
      retention: {
        locationDays: settings.locationRetentionDays,
        sessionDays: settings.sessionRetentionDays,
        eventDays: settings.eventRetentionDays,
      },
    });
  } catch (error) {
    console.error('❌ admin activity overview error:', error.message);
    return fail(res, 500, 'Unable to load this customer\'s activity');
  }
};

// Shared start for the per-customer lists
const prepare = async (req, res) => {
  const customerId = customerIdParam(req);
  if (!customerId) {
    fail(res, 400, 'Invalid customer id');
    return null;
  }
  const range = readRange(req.query);
  if (range.error) {
    fail(res, 400, range.error);
    return null;
  }
  const exists = (await pool.query('SELECT 1 FROM customers WHERE id = $1', [customerId])).rowCount > 0;
  if (!exists) {
    fail(res, 404, 'Customer not found');
    return null;
  }
  return { customerId, range, paging: readPage(req.query, 50) };
};

const rangeMeta = (range) => ({ from: range.from, to: range.to });

// =====================================================
// GET /customers/:id/activity/events
// =====================================================

const listEvents = async (req, res) => {
  try {
    const ctx = await prepare(req, res);
    if (!ctx) return undefined;
    const { customerId, range, paging } = ctx;

    const params = [customerId, range.from, range.to];
    const where = ['customer_id = $1', 'occurred_at >= $2', 'occurred_at < $3'];
    const categories = String(req.query.category || '')
      .split(',')
      .map((c) => c.trim())
      .filter((c) => CATEGORIES.includes(c));
    // Location events hold no coordinates (consent, permission, tracking start / stop)
    if (categories.length) {
      params.push(categories);
      where.push(`category = ANY($${params.length}::text[])`);
    }
    const orderId = Number(req.query.orderId);
    if (Number.isSafeInteger(orderId) && orderId > 0) {
      params.push(orderId);
      where.push(`order_id = $${params.length}`);
    }

    const whereSql = where.join(' AND ');
    const [total, rows, byCategory] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM customer_activity_events WHERE ${whereSql}`, params),
      pool.query(
        `SELECT id, category, event_type, summary, details, source, order_id, session_id, presence_id, occurred_at, recorded_at
           FROM customer_activity_events WHERE ${whereSql}
          ORDER BY occurred_at DESC, id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, paging.pageSize, paging.offset]
      ),
      pool.query(
        `SELECT category, COUNT(*)::int AS count FROM customer_activity_events
          WHERE customer_id = $1 AND occurred_at >= $2 AND occurred_at < $3 GROUP BY category`,
        [customerId, range.from, range.to]
      ),
    ]);

    return res.json({
      success: true,
      ...pageMeta(paging, total.rows[0].total),
      range: rangeMeta(range),
      byCategory: Object.fromEntries(byCategory.rows.map((r) => [r.category, r.count])),
      events: rows.rows.map((e) => ({
        id: Number(e.id),
        category: e.category,
        type: e.event_type,
        summary: e.summary,
        details: e.details,
        source: e.source,
        orderId: e.order_id,
        sessionId: e.session_id != null ? Number(e.session_id) : null,
        visitId: e.presence_id != null ? Number(e.presence_id) : null,
        occurredAt: e.occurred_at,
        recordedAt: e.recorded_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin activity events error:', error.message);
    return fail(res, 500, 'Unable to load the activity timeline');
  }
};

// =====================================================
// GET /customers/:id/activity/sessions  (sign-ins)
// =====================================================

const listSessions = async (req, res) => {
  try {
    const ctx = await prepare(req, res);
    if (!ctx) return undefined;
    const { customerId, range, paging } = ctx;
    // Sessions that overlap the range
    const params = [customerId, range.from, range.to];
    const where = `customer_id = $1 AND started_at < $3 AND COALESCE(ended_at, NOW()) >= $2`;

    const [total, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM customer_sessions WHERE ${where}`, params),
      pool.query(
        `SELECT s.*,
                (SELECT COUNT(*)::int FROM customer_presence p WHERE p.session_id = s.id) AS visits
           FROM customer_sessions s WHERE ${where}
          ORDER BY started_at DESC LIMIT $4 OFFSET $5`,
        [...params, paging.pageSize, paging.offset]
      ),
    ]);

    return res.json({
      success: true,
      ...pageMeta(paging, total.rows[0].total),
      range: rangeMeta(range),
      sessions: rows.rows.map((s) => ({
        id: Number(s.id),
        method: s.login_method,
        startedAt: s.started_at,
        expiresAt: s.expires_at,
        lastSeenAt: s.last_seen_at,
        endedAt: s.ended_at,
        endReason: s.end_reason,
        status: s.ended_at ? 'ended' : new Date(s.expires_at) < new Date() ? 'expired' : 'active',
        durationSeconds: Math.max(0, Math.round((new Date(s.ended_at || Date.now()) - new Date(s.started_at)) / 1000)),
        visits: s.visits,
        ip: s.ip,
        userAgent: s.user_agent,
      })),
    });
  } catch (error) {
    console.error('❌ admin activity sessions error:', error.message);
    return fail(res, 500, 'Unable to load sign-in history');
  }
};

// =====================================================
// GET /customers/:id/activity/visits  (online periods)
// =====================================================

const listVisits = async (req, res) => {
  try {
    const ctx = await prepare(req, res);
    if (!ctx) return undefined;
    const { customerId, range, paging } = ctx;
    const params = [customerId, range.from, range.to];
    const where = `customer_id = $1 AND started_at < $3 AND COALESCE(ended_at, NOW()) >= $2`;

    const [total, rows, totals] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM customer_presence WHERE ${where}`, params),
      pool.query(
        `SELECT * FROM customer_presence WHERE ${where} ORDER BY started_at DESC LIMIT $4 OFFSET $5`,
        [...params, paging.pageSize, paging.offset]
      ),
      pool.query(
        `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(ended_at, NOW()), $3) - GREATEST(started_at, $2)))), 0)::bigint AS seconds,
                COALESCE(SUM(reconnect_count), 0)::int AS reconnects,
                COUNT(*) FILTER (WHERE end_reason = 'connection_lost')::int AS lost,
                COUNT(*) FILTER (WHERE end_reason = 'background')::int AS background
           FROM customer_presence WHERE ${where}`,
        params
      ),
    ]);

    const t = totals.rows[0];
    return res.json({
      success: true,
      ...pageMeta(paging, total.rows[0].total),
      range: rangeMeta(range),
      totals: { onlineSeconds: Number(t.seconds), reconnects: t.reconnects, connectionLost: t.lost, background: t.background },
      visits: rows.rows.map((v) => ({
        id: Number(v.id),
        sessionId: v.session_id != null ? Number(v.session_id) : null,
        platform: v.platform,
        appVersion: v.app_version,
        startedAt: v.started_at,
        endedAt: v.ended_at,
        lastSeenAt: v.last_seen_at,
        state: v.state,
        endReason: v.end_reason,
        durationSeconds: Math.max(0, Math.round((new Date(v.ended_at || Date.now()) - new Date(v.started_at)) / 1000)),
        reconnects: v.reconnect_count,
        interruptedSeconds: v.interrupted_seconds,
      })),
    });
  } catch (error) {
    console.error('❌ admin activity visits error:', error.message);
    return fail(res, 500, 'Unable to load online history');
  }
};

// =====================================================
// GET /customers/:id/activity/routes
// =====================================================

const mapRoute = (r) => ({
  id: Number(r.id),
  purpose: r.purpose,
  orderId: r.order_id,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  endReason: r.end_reason,
  open: !r.ended_at,
  firstPointAt: r.first_point_at,
  lastPointAt: r.last_point_at,
  points: r.point_count,
  distanceM: Number(r.distance_m),
  start: r.start_latitude != null ? { latitude: n(r.start_latitude), longitude: n(r.start_longitude) } : null,
  end: r.end_latitude != null ? { latitude: n(r.end_latitude), longitude: n(r.end_longitude) } : null,
  destination: r.destination_latitude != null ? { latitude: n(r.destination_latitude), longitude: n(r.destination_longitude) } : null,
});

const listRoutes = async (req, res) => {
  try {
    const ctx = await prepare(req, res);
    if (!ctx) return undefined;
    const { customerId, range, paging } = ctx;
    const params = [customerId, range.from, range.to];
    let where = `customer_id = $1 AND started_at < $3 AND COALESCE(ended_at, last_point_at, NOW()) >= $2`;
    const orderId = Number(req.query.orderId);
    if (Number.isSafeInteger(orderId) && orderId > 0) {
      params.push(orderId);
      where += ` AND order_id = $${params.length}`;
    }

    const [total, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM customer_tracking_sessions WHERE ${where}`, params),
      pool.query(
        `SELECT * FROM customer_tracking_sessions WHERE ${where} ORDER BY started_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, paging.pageSize, paging.offset]
      ),
    ]);

    auditLocationView(req, customerId, 'routes', 'Viewed the list of recorded routes');
    return res.json({ success: true, ...pageMeta(paging, total.rows[0].total), range: rangeMeta(range), routes: rows.rows.map(mapRoute) });
  } catch (error) {
    console.error('❌ admin activity routes error:', error.message);
    return fail(res, 500, 'Unable to load recorded routes');
  }
};

// =====================================================
// GET /customers/:id/activity/routes/:routeId
// =====================================================

const getRoute = async (req, res) => {
  const customerId = customerIdParam(req);
  const routeId = Number(req.params.routeId);
  if (!customerId || !Number.isSafeInteger(routeId) || routeId <= 0) return fail(res, 400, 'Invalid id');

  try {
    const route = (
      await pool.query('SELECT * FROM customer_tracking_sessions WHERE id = $1 AND customer_id = $2', [routeId, customerId])
    ).rows[0];
    if (!route) return fail(res, 404, 'Route not found');

    const all = (
      await pool.query(
        `SELECT id, latitude, longitude, accuracy_m, speed_mps, heading, recorded_at, received_at, order_id
           FROM customer_location_points WHERE tracking_session_id = $1 ORDER BY recorded_at, id`,
        [routeId]
      )
    ).rows.map((p) => ({
      id: Number(p.id),
      latitude: n(p.latitude),
      longitude: n(p.longitude),
      accuracyM: n(p.accuracy_m),
      speedMps: n(p.speed_mps),
      heading: n(p.heading),
      recordedAt: p.recorded_at,
      receivedAt: p.received_at,
      orderId: p.order_id,
    }));

    // Very long routes: every k-th point (first + last always kept)
    let points = all;
    if (all.length > MAX_ROUTE_POINTS) {
      const step = Math.ceil(all.length / MAX_ROUTE_POINTS);
      points = all.filter((_, i) => i % step === 0 || i === all.length - 1);
    }

    const order = route.order_id
      ? (await pool.query('SELECT id, status, delivery_address FROM orders WHERE id = $1', [route.order_id])).rows[0]
      : null;

    auditLocationView(req, customerId, `route:${routeId}`, `Viewed recorded route #${routeId} on the map`);

    const { reliable } = routeDistance(all);
    return res.json({
      success: true,
      route: mapRoute(route),
      distanceReliable: reliable,
      order: order ? { id: order.id, status: order.status, deliveryAddress: order.delivery_address } : null,
      totalPoints: all.length,
      sampled: points.length < all.length,
      points,
      gaps: findGaps(points),
    });
  } catch (error) {
    console.error('❌ admin activity route error:', error.message);
    return fail(res, 500, 'Unable to load this route');
  }
};

// =====================================================
// GET /customers/:id/activity/locations  (raw points)
// =====================================================

const listLocations = async (req, res) => {
  try {
    const ctx = await prepare(req, res);
    if (!ctx) return undefined;
    const { customerId, range, paging } = ctx;
    const params = [customerId, range.from, range.to];
    let where = `customer_id = $1 AND recorded_at >= $2 AND recorded_at < $3`;
    const orderId = Number(req.query.orderId);
    if (Number.isSafeInteger(orderId) && orderId > 0) {
      params.push(orderId);
      where += ` AND order_id = $${params.length}`;
    }

    const [total, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM customer_location_points WHERE ${where}`, params),
      pool.query(
        `SELECT id, tracking_session_id, order_id, latitude, longitude, accuracy_m, speed_mps, recorded_at, received_at, source
           FROM customer_location_points WHERE ${where}
          ORDER BY recorded_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, paging.pageSize, paging.offset]
      ),
    ]);

    auditLocationView(req, customerId, 'points', 'Viewed the location history (GPS points)');
    return res.json({
      success: true,
      ...pageMeta(paging, total.rows[0].total),
      range: rangeMeta(range),
      points: rows.rows.map((p) => ({
        id: Number(p.id),
        routeId: Number(p.tracking_session_id),
        orderId: p.order_id,
        latitude: n(p.latitude),
        longitude: n(p.longitude),
        accuracyM: n(p.accuracy_m),
        speedMps: n(p.speed_mps),
        recordedAt: p.recorded_at,
        receivedAt: p.received_at,
        source: p.source,
      })),
    });
  } catch (error) {
    console.error('❌ admin activity locations error:', error.message);
    return fail(res, 500, 'Unable to load location history');
  }
};

// =====================================================
// Settings: retention + collection switch
// =====================================================

const getActivitySettings = async (req, res) => {
  try {
    return res.json({ success: true, settings: await getSettings({ fresh: true }) });
  } catch (error) {
    console.error('❌ admin activity settings error:', error.message);
    return fail(res, 500, 'Unable to load the settings');
  }
};

const intIn = (value, min, max) => {
  const v = Number(value);
  return Number.isInteger(v) && v >= min && v <= max ? v : undefined;
};

const updateActivitySettings = async (req, res) => {
  const body = req.body || {};
  const changes = {};
  if (body.locationRetentionDays !== undefined) changes.location_retention_days = intIn(body.locationRetentionDays, 7, 730);
  if (body.sessionRetentionDays !== undefined) changes.session_retention_days = intIn(body.sessionRetentionDays, 30, 1095);
  if (body.eventRetentionDays !== undefined) changes.event_retention_days = intIn(body.eventRetentionDays, 30, 1095);
  if (body.locationCollectionEnabled !== undefined) {
    changes.location_collection_enabled = typeof body.locationCollectionEnabled === 'boolean' ? body.locationCollectionEnabled : undefined;
  }
  if (Object.values(changes).some((v) => v === undefined) || Object.keys(changes).length === 0) {
    return fail(res, 400, 'Retention: locations 7-730 days, sign-ins and timeline 30-1095 days; collection on/off');
  }

  try {
    const before = await getSettings({ fresh: true });
    const keys = Object.keys(changes);
    const sets = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
    await pool.query(
      `UPDATE customer_activity_settings SET ${sets}, updated_by = $${keys.length + 1}, updated_at = NOW() WHERE id = 1`,
      [...keys.map((k) => changes[k]), req.admin?.adminId ?? null]
    );
    clearSettingsCache();
    const after = await getSettings({ fresh: true });
    res.locals.audit = {
      summary: `Customer activity settings: locations ${after.locationRetentionDays} d, sign-ins ${after.sessionRetentionDays} d, timeline ${after.eventRetentionDays} d, collection ${after.locationCollectionEnabled ? 'on' : 'off'}`,
      before,
      after,
    };
    return res.json({ success: true, settings: after });
  } catch (error) {
    console.error('❌ admin activity settings update error:', error.message);
    return fail(res, 500, 'Unable to save the settings');
  }
};

module.exports = {
  readRange,
  getSummary,
  listCustomers,
  getOverview,
  listEvents,
  listSessions,
  listVisits,
  listRoutes,
  getRoute,
  listLocations,
  getActivitySettings,
  updateActivitySettings,
};
