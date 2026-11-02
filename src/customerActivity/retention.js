// =====================================================
// CUSTOMER ACTIVITY RETENTION (phase 51)
// Once a day: deletes GPS points / routes older than
// location_retention_days, ended sign-ins and online periods older than
// session_retention_days, timeline events older than event_retention_days
// (customer_activity_settings). Deletes in batches so a big backlog
// never holds long locks. Open sessions / routes are never deleted.
// =====================================================

const pool = require('../config/db');
const { getSettings } = require('./store');

const BATCH = 5000;
const CHECK_MS = 60 * 60_000;
const RUN_EVERY_MS = 23 * 60 * 60_000;

let lastRun = 0;

const deleteInBatches = async (sql, params) => {
  let total = 0;
  for (;;) {
    const result = await pool.query(sql, [...params, BATCH]);
    total += result.rowCount;
    if (result.rowCount < BATCH) return total;
  }
};

const purge = async () => {
  const s = await getSettings({ fresh: true });
  const days = (d) => `${Number(d)} days`;

  const points = await deleteInBatches(
    `DELETE FROM customer_location_points WHERE id IN (
       SELECT id FROM customer_location_points WHERE recorded_at < NOW() - $1::interval LIMIT $2)`,
    [days(s.locationRetentionDays)]
  );
  const routes = await deleteInBatches(
    `DELETE FROM customer_tracking_sessions WHERE id IN (
       SELECT t.id FROM customer_tracking_sessions t
        WHERE t.ended_at IS NOT NULL AND t.ended_at < NOW() - $1::interval
          AND NOT EXISTS (SELECT 1 FROM customer_location_points p WHERE p.tracking_session_id = t.id)
        LIMIT $2)`,
    [days(s.locationRetentionDays)]
  );
  // Last known location follows the location retention too
  const lastLocations = (
    await pool.query(
      `UPDATE customer_activity_state
          SET last_latitude = NULL, last_longitude = NULL, last_accuracy_m = NULL, last_location_at = NULL, last_location_source = NULL
        WHERE last_location_at < NOW() - $1::interval`,
      [days(s.locationRetentionDays)]
    )
  ).rowCount;
  const visits = await deleteInBatches(
    `DELETE FROM customer_presence WHERE id IN (
       SELECT id FROM customer_presence WHERE state = 'ended' AND ended_at < NOW() - $1::interval LIMIT $2)`,
    [days(s.sessionRetentionDays)]
  );
  const signIns = await deleteInBatches(
    `DELETE FROM customer_sessions WHERE id IN (
       SELECT id FROM customer_sessions WHERE ended_at IS NOT NULL AND ended_at < NOW() - $1::interval LIMIT $2)`,
    [days(s.sessionRetentionDays)]
  );
  const events = await deleteInBatches(
    `DELETE FROM customer_activity_events WHERE id IN (
       SELECT id FROM customer_activity_events WHERE occurred_at < NOW() - $1::interval LIMIT $2)`,
    [days(s.eventRetentionDays)]
  );

  const result = { points, routes, lastLocations, visits, signIns, events };
  if (Object.values(result).some((v) => v > 0)) console.log('🧹 Customer activity retention:', result);
  return result;
};

const start = () => {
  const tick = async () => {
    if (Date.now() - lastRun < RUN_EVERY_MS) return;
    lastRun = Date.now();
    try {
      await purge();
    } catch (error) {
      console.error('❌ CUSTOMER ACTIVITY RETENTION:', error.message);
    }
  };
  setTimeout(tick, 90_000);
  return setInterval(tick, CHECK_MS);
};

module.exports = { purge, start };
