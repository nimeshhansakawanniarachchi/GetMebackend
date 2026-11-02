// =====================================================
// CUSTOMER ACTIVITY: events, state, sign-in sessions (phase 51)
//
// Everything here is best effort: a failure is logged and never fails
// the sign-in, order or request that caused it.
// Never pass passwords, tokens, card numbers or addresses in `details`.
// =====================================================

const pool = require('../config/db');

const warn = (label, error) => console.error(`❌ CUSTOMER ACTIVITY ${label}:`, error.message);

// -----------------------------------------------------
// Settings (cached 30 s)
// -----------------------------------------------------

let settingsCache = null;
let settingsAt = 0;

const mapSettings = (row) => ({
  locationRetentionDays: Number(row.location_retention_days),
  sessionRetentionDays: Number(row.session_retention_days),
  eventRetentionDays: Number(row.event_retention_days),
  locationCollectionEnabled: Boolean(row.location_collection_enabled),
  consentVersion: row.consent_version,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

const getSettings = async ({ fresh = false } = {}) => {
  if (!fresh && settingsCache && Date.now() - settingsAt < 30_000) return settingsCache;
  const row = (await pool.query('SELECT * FROM customer_activity_settings WHERE id = 1')).rows[0];
  settingsCache = mapSettings(row || {
    location_retention_days: 90, session_retention_days: 365, event_retention_days: 365,
    location_collection_enabled: true, consent_version: '2026-10-30',
  });
  settingsAt = Date.now();
  return settingsCache;
};

const clearSettingsCache = () => {
  settingsCache = null;
};

// -----------------------------------------------------
// Timeline events
// -----------------------------------------------------

const CATEGORIES = ['account', 'session', 'location', 'browsing', 'cart', 'order', 'payment', 'support'];

const logEvent = async ({
  customerId, category, type, summary, details = null, source = 'server',
  orderId = null, sessionId = null, presenceId = null, occurredAt = null, dedupeKey = null,
}, db = pool) => {
  if (!customerId || !CATEGORIES.includes(category)) return null;
  try {
    const result = await db.query(
      `INSERT INTO customer_activity_events
         (customer_id, category, event_type, summary, details, source, order_id, session_id, presence_id, occurred_at, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, NOW()), $11)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        Number(customerId), category, String(type).slice(0, 60), String(summary).slice(0, 300),
        details ? JSON.stringify(details) : null, source, orderId || null, sessionId || null, presenceId || null,
        occurredAt || null, dedupeKey ? String(dedupeKey).slice(0, 200) : null,
      ]
    );
    return result.rows[0]?.id ?? null;
  } catch (error) {
    warn(`event ${type}`, error);
    return null;
  }
};

// -----------------------------------------------------
// State row (consent, permission, last location, last activity)
// -----------------------------------------------------

const ensureState = (customerId, db = pool) =>
  db.query('INSERT INTO customer_activity_state (customer_id) VALUES ($1) ON CONFLICT (customer_id) DO NOTHING', [Number(customerId)]);

// Last activity: at most one write per customer per minute
const TOUCH_MS = 60_000;
const lastTouch = new Map();

const touch = (customerId, sessionId = null) => {
  const id = Number(customerId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  const now = Date.now();
  if (now - (lastTouch.get(id) || 0) < TOUCH_MS) return;
  lastTouch.set(id, now);
  if (lastTouch.size > 50_000) lastTouch.clear();

  pool
    .query(
      `INSERT INTO customer_activity_state (customer_id, last_activity_at, updated_at) VALUES ($1, NOW(), NOW())
       ON CONFLICT (customer_id) DO UPDATE SET last_activity_at = NOW(), updated_at = NOW()`,
      [id]
    )
    .catch((error) => warn('touch', error));

  if (sessionId) {
    pool
      .query('UPDATE customer_sessions SET last_seen_at = NOW() WHERE id = $1 AND customer_id = $2 AND ended_at IS NULL', [Number(sessionId), id])
      .catch((error) => warn('session touch', error));
  }
};

// -----------------------------------------------------
// Sign-in sessions (the customer JWT carries sid)
// -----------------------------------------------------

const TOKEN_LIFETIME_SECONDS = 7 * 24 * 3600;

const clip = (value, length) => (value == null ? null : String(value).slice(0, length));

// -> session id, or null if it could not be written (the sign-in still works)
const createSession = async ({ customerId, method, ip, userAgent }) => {
  try {
    const result = await pool.query(
      `INSERT INTO customer_sessions (customer_id, login_method, expires_at, ip, user_agent)
       VALUES ($1, $2, NOW() + make_interval(secs => $3), $4, $5)
       RETURNING id`,
      [Number(customerId), method, TOKEN_LIFETIME_SECONDS, clip(ip, 64), clip(userAgent, 200)]
    );
    const sessionId = Number(result.rows[0].id);
    await pool.query(
      `INSERT INTO customer_activity_state (customer_id, last_login_at, last_activity_at) VALUES ($1, NOW(), NOW())
       ON CONFLICT (customer_id) DO UPDATE SET last_login_at = NOW(), last_activity_at = NOW(), updated_at = NOW()`,
      [Number(customerId)]
    );
    if (method !== 'register') {
      await logEvent({
        customerId, category: 'session', type: 'session.login',
        summary: `Signed in with ${method === 'mobile' ? 'mobile number' : 'email'}`,
        details: { method }, sessionId,
      });
    }
    return sessionId;
  } catch (error) {
    warn('create session', error);
    return null;
  }
};

const LOGIN_FAILED_MS = 10 * 60_000;
const failedNoted = new Map();

// Wrong password for an existing account (one event per 10 min per account)
const noteFailedLogin = (customerId) => {
  const id = Number(customerId);
  const now = Date.now();
  if (now - (failedNoted.get(id) || 0) < LOGIN_FAILED_MS) return;
  failedNoted.set(id, now);
  if (failedNoted.size > 10_000) failedNoted.clear();
  logEvent({
    customerId: id, category: 'session', type: 'session.login_failed',
    summary: 'Sign-in attempt with a wrong password',
  });
};

// reason: logout | blocked. -> true if this call ended it
const endSession = async ({ customerId, sessionId, reason }) => {
  if (!sessionId) return false;
  try {
    const result = await pool.query(
      `UPDATE customer_sessions SET ended_at = NOW(), end_reason = $3
       WHERE id = $1 AND customer_id = $2 AND ended_at IS NULL
       RETURNING id`,
      [Number(sessionId), Number(customerId), reason]
    );
    return result.rowCount > 0;
  } catch (error) {
    warn('end session', error);
    return false;
  }
};

module.exports = {
  CATEGORIES,
  TOKEN_LIFETIME_SECONDS,
  getSettings,
  clearSettingsCache,
  mapSettings,
  logEvent,
  ensureState,
  touch,
  createSession,
  noteFailedLogin,
  endSession,
};
