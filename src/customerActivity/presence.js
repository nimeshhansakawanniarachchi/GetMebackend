// =====================================================
// CUSTOMER ONLINE / OFFLINE (phase 51)
//
// A "visit" is one foreground period of the customer app. The app sends
// in the socket handshake (auth): installId (random per install),
// appSessionId (per launch), visitId (new each time the app comes to the
// foreground), appState, platform, appVersion. Then:
//   presence:state { state: 'active' | 'background', visitId }
//   presence:ping  (every 60 s while in the foreground)
//
// What each end reason means (and what we can't tell apart):
//   background      the app told us it went to the background
//   logout          POST /api/auth/logout
//   connection_lost the socket dropped and didn't come back within the
//                   grace period - the app was closed / killed, the phone
//                   locked or the network went away. A server can't tell
//                   these apart, so they are NOT recorded as logouts.
//   app_restarted   the same install opened a new launch while the old
//                   one was still open / disconnected (old launch ended)
//   session_expired the sign-in token expired
//   server_restart  the server restarted while the visit was open
//   heartbeat_lost  the server lost track of the socket
// A drop followed by a reconnect inside the grace period is the same
// visit: reconnect_count and interrupted_seconds go up.
// =====================================================

const pool = require('../config/db');
const { logEvent, touch } = require('./store');

const GRACE_MS = Number(process.env.CUSTOMER_PRESENCE_GRACE_MS) || 120_000;
const SWEEP_MS = Number(process.env.CUSTOMER_PRESENCE_SWEEP_MS) || 30_000;
const STALE_TRACKING_MS = 15 * 60_000;
const PING_WRITE_MS = 30_000;
const ADMIN_ROOM = 'admins:customer-activity';

let io = null;

const warn = (label, error) => console.error(`❌ CUSTOMER PRESENCE ${label}:`, error.message);

const cleanId = (value) => (typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null);
const cleanPlatform = (value) => (['ios', 'android', 'web'].includes(value) ? value : null);
const cleanVersion = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 30) : null);

const END_SUMMARIES = {
  background: 'Went offline: app moved to the background',
  logout: 'Went offline: signed out',
  connection_lost: `Went offline: connection lost and not back within ${Math.round(GRACE_MS / 60000)} min (app closed, phone locked or network lost)`,
  app_restarted: 'Went offline: the app was opened again (the previous launch had ended)',
  session_expired: 'Went offline: sign-in expired',
  blocked: 'Went offline: account blocked',
  server_restart: 'Went offline: GetMe server restarted (end time = last contact)',
  heartbeat_lost: 'Went offline: no contact from the app',
};

const emitAdmins = (customerId, state, at = new Date()) => {
  io?.to(ADMIN_ROOM).emit('admin:customer-presence', { customerId: Number(customerId), state, at });
};

// Ended visits -> timeline + admin push
const afterEnded = (rows) => {
  rows.forEach((row) => {
    const seconds = Math.max(0, Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 1000));
    logEvent({
      customerId: row.customer_id,
      category: 'session',
      type: 'session.offline',
      summary: END_SUMMARIES[row.end_reason] || 'Went offline',
      details: { reason: row.end_reason, onlineSeconds: seconds, reconnects: row.reconnect_count },
      sessionId: row.session_id,
      presenceId: row.id,
      occurredAt: row.ended_at,
      dedupeKey: `presence.end:${row.id}`,
    });
    emitAdmins(row.customer_id, 'offline', row.ended_at);
  });
};

// Ends open visits matching `where` (SQL over customer_presence, params from $2)
const endWhere = async (where, params, reason, db = pool) => {
  const result = await db.query(
    `UPDATE customer_presence
        SET ended_at = CASE WHEN state = 'disconnected' THEN state_changed_at ELSE NOW() END,
            state = 'ended', state_changed_at = NOW(), end_reason = $1, socket_id = NULL
      WHERE state <> 'ended' AND ${where}
      RETURNING *`,
    [reason, ...params]
  );
  return result.rows;
};

// -----------------------------------------------------
// Visit start / reconnect
// -----------------------------------------------------

const openVisit = async (socket) => {
  const p = socket.presence;
  const client = await pool.connect();
  let ended = [];
  let event = null;
  let row;

  try {
    await client.query('BEGIN');

    // Older visits of the same install: background (same launch) or
    // app restarted (a different launch)
    if (p.installId) {
      const old = await client.query(
        `UPDATE customer_presence
            SET ended_at = CASE WHEN state = 'disconnected' THEN state_changed_at ELSE NOW() END,
                end_reason = CASE WHEN app_session_id IS NOT DISTINCT FROM $4 THEN 'background' ELSE 'app_restarted' END,
                state = 'ended', state_changed_at = NOW(), socket_id = NULL
          WHERE customer_id = $1 AND install_id = $2 AND visit_id <> $3 AND state <> 'ended'
          RETURNING *`,
        [p.customerId, p.installId, p.visitId, p.appSessionId]
      );
      ended = old.rows;
    }

    const existing = (
      await client.query(
        `SELECT * FROM customer_presence WHERE customer_id = $1 AND visit_id = $2 AND state <> 'ended' FOR UPDATE`,
        [p.customerId, p.visitId]
      )
    ).rows[0];

    if (existing) {
      const wasDown = existing.state === 'disconnected';
      row = (
        await client.query(
          `UPDATE customer_presence
              SET state = 'online', last_seen_at = NOW(), socket_id = $2,
                  reconnect_count = reconnect_count + $3,
                  interrupted_seconds = interrupted_seconds + CASE WHEN $3 = 1 THEN GREATEST(0, EXTRACT(EPOCH FROM NOW() - state_changed_at))::int ELSE 0 END,
                  state_changed_at = CASE WHEN $3 = 1 THEN NOW() ELSE state_changed_at END,
                  session_id = COALESCE(session_id, $4)
            WHERE id = $1
            RETURNING *, $3::int AS reconnected,
                      CASE WHEN $3 = 1 THEN GREATEST(0, EXTRACT(EPOCH FROM NOW() - $5::timestamptz))::int END AS gap_seconds`,
          [existing.id, socket.id, wasDown ? 1 : 0, p.sessionId, existing.state_changed_at]
        )
      ).rows[0];
      if (wasDown) {
        event = {
          type: 'session.reconnected',
          summary: `Reconnected after ${row.gap_seconds} s offline`,
          details: { gapSeconds: row.gap_seconds, reconnects: row.reconnect_count },
        };
      }
    } else {
      row = (
        await client.query(
          `INSERT INTO customer_presence (customer_id, session_id, install_id, app_session_id, visit_id, platform, app_version, socket_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [p.customerId, p.sessionId, p.installId, p.appSessionId, p.visitId, p.platform, p.appVersion, socket.id]
        )
      ).rows[0];
      event = {
        type: 'session.online',
        summary: `Opened the app${p.platform ? ` (${p.platform === 'ios' ? 'iPhone' : p.platform === 'android' ? 'Android' : 'web'})` : ''}`,
        details: { platform: p.platform, appVersion: p.appVersion },
      };
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    warn('open visit', error);
    return;
  } finally {
    client.release();
  }

  p.presenceId = row.id;
  afterEnded(ended);
  if (event) {
    logEvent({ customerId: p.customerId, category: 'session', ...event, sessionId: p.sessionId, presenceId: row.id });
  }
  touch(p.customerId, p.sessionId);
  emitAdmins(p.customerId, 'online');
};

const endVisit = async (socket, reason) => {
  const p = socket.presence;
  if (!p?.presenceId) return;
  try {
    const rows = await endWhere('id = $2', [p.presenceId], reason);
    p.presenceId = null;
    afterEnded(rows);
  } catch (error) {
    warn('end visit', error);
  }
};

// -----------------------------------------------------
// Socket hooks (bin/www)
// -----------------------------------------------------

const onConnect = (socket, customerId) => {
  const auth = socket.handshake?.auth || {};
  const visitId = cleanId(auth.visitId);
  // Older app versions send no visit id: no presence records for them
  if (!visitId) return;

  socket.presence = {
    customerId: Number(customerId),
    sessionId: Number.isSafeInteger(Number(socket.customer?.sid)) ? Number(socket.customer.sid) : null,
    installId: cleanId(auth.installId),
    appSessionId: cleanId(auth.appSessionId),
    visitId,
    platform: cleanPlatform(auth.platform),
    appVersion: cleanVersion(auth.appVersion),
    presenceId: null,
    lastPingWrite: 0,
  };

  // A socket opened while the app is in the background is not "online"
  if (auth.appState && auth.appState !== 'active') return;
  openVisit(socket);
};

const onState = (socket, payload) => {
  const p = socket.presence;
  if (!p) return;
  const state = payload?.state;

  if (state === 'background') {
    endVisit(socket, 'background');
    return;
  }
  if (state === 'active') {
    const visitId = cleanId(payload?.visitId);
    // At most one new visit per 3 s per socket (security review B-25)
    if (visitId && visitId !== p.visitId && Date.now() - (p.lastVisitAt || 0) < 3000) return;
    if (visitId && visitId !== p.visitId) {
      p.lastVisitAt = Date.now();
      p.visitId = visitId;
      p.presenceId = null;
    }
    if (!p.presenceId) openVisit(socket);
  }
};

const onPing = (socket) => {
  const p = socket.presence;
  if (!p?.presenceId) return;
  const now = Date.now();
  if (now - p.lastPingWrite < PING_WRITE_MS) return;
  p.lastPingWrite = now;
  pool
    .query(`UPDATE customer_presence SET last_seen_at = NOW() WHERE id = $1 AND state = 'online'`, [p.presenceId])
    .catch((error) => warn('ping', error));
  touch(p.customerId, p.sessionId);
};

// Not the end of the visit yet: the sweeper ends it after the grace period
const onDisconnect = (socket) => {
  const p = socket.presence;
  if (!p?.presenceId) return;
  pool
    .query(
      `UPDATE customer_presence SET state = 'disconnected', state_changed_at = NOW(), last_seen_at = NOW(), socket_id = NULL
        WHERE id = $1 AND state = 'online' AND socket_id = $2
        RETURNING customer_id`,
      [p.presenceId, socket.id]
    )
    .then((result) => {
      if (result.rowCount > 0) emitAdmins(p.customerId, 'reconnecting');
    })
    .catch((error) => warn('disconnect', error));
};

// -----------------------------------------------------
// Logout / blocked / expiry
// -----------------------------------------------------

// Ends the visits of one sign-in session (and its open routes)
const endForSession = async ({ customerId, sessionId, installId = null, reason }) => {
  try {
    const rows = sessionId
      ? await endWhere('customer_id = $2 AND (session_id = $3 OR ($4::text IS NOT NULL AND install_id = $4))', [customerId, sessionId, installId], reason)
      : await endWhere('customer_id = $2 AND $3::text IS NOT NULL AND install_id = $3', [customerId, installId], reason);
    afterEnded(rows);
    await pool.query(
      `UPDATE customer_tracking_sessions SET ended_at = COALESCE(last_point_at, NOW()), end_reason = 'logout'
        WHERE customer_id = $1 AND ended_at IS NULL AND (session_id = $2 OR $2 IS NULL)`,
      [customerId, sessionId]
    );
  } catch (error) {
    warn('end for session', error);
  }
};

// Account blocked: every sign-in, visit and open route ends
const endAllForCustomer = async (customerId, reason) => {
  try {
    const sessions = await pool.query(
      `UPDATE customer_sessions SET ended_at = NOW(), end_reason = $2
        WHERE customer_id = $1 AND ended_at IS NULL RETURNING id`,
      [customerId, reason]
    );
    if (sessions.rowCount > 0) {
      logEvent({
        customerId, category: 'session', type: 'session.ended_by_staff',
        summary: `${sessions.rowCount} sign-in${sessions.rowCount === 1 ? '' : 's'} ended: account ${reason}`,
        details: { reason, sessions: sessions.rowCount },
      });
    }
    afterEnded(await endWhere('customer_id = $2', [customerId], reason));
    await pool.query(
      `UPDATE customer_tracking_sessions SET ended_at = COALESCE(last_point_at, NOW()), end_reason = 'stopped'
        WHERE customer_id = $1 AND ended_at IS NULL`,
      [customerId]
    );
  } catch (error) {
    warn('end all', error);
  }
};

// -----------------------------------------------------
// Sweeper: grace periods, lost sockets, expired sign-ins, stale routes
// -----------------------------------------------------

const sweep = async () => {
  try {
    const lost = await endWhere(
      `state = 'disconnected' AND state_changed_at < NOW() - make_interval(secs => $2)`,
      [GRACE_MS / 1000],
      'connection_lost'
    );
    afterEnded(lost);

    // "Online" rows whose socket this server no longer has
    if (io) {
      const open = (
        await pool.query(
          `SELECT id, socket_id FROM customer_presence
            WHERE state = 'online' AND last_seen_at < NOW() - make_interval(secs => $1)`,
          [GRACE_MS / 1000]
        )
      ).rows.filter((r) => !r.socket_id || !io.sockets.sockets.has(r.socket_id));
      if (open.length) {
        const rows = await endWhere('id = ANY($2::bigint[])', [open.map((r) => r.id)], 'heartbeat_lost');
        afterEnded(rows);
      }
    }

    const expired = (
      await pool.query(
        `UPDATE customer_sessions SET ended_at = expires_at, end_reason = 'expired'
          WHERE ended_at IS NULL AND expires_at < NOW()
          RETURNING id, customer_id, expires_at`
      )
    ).rows;
    for (const s of expired) {
      logEvent({
        customerId: s.customer_id, category: 'session', type: 'session.expired',
        summary: 'Sign-in expired (7 days); the app must sign in again',
        sessionId: s.id, occurredAt: s.expires_at, dedupeKey: `session.expired:${s.id}`,
      });
      afterEnded(await endWhere('session_id = $2', [s.id], 'session_expired'));
    }

    const stale = (
      await pool.query(
        `UPDATE customer_tracking_sessions
            SET ended_at = COALESCE(last_point_at, started_at), end_reason = 'stale'
          WHERE ended_at IS NULL AND COALESCE(last_point_at, started_at) < NOW() - make_interval(secs => $1)
          RETURNING id, customer_id, ended_at, point_count, distance_m`,
        [STALE_TRACKING_MS / 1000]
      )
    ).rows;
    stale.forEach((t) =>
      logEvent({
        customerId: t.customer_id, category: 'location', type: 'location.tracking_stopped',
        summary: `Location tracking ended: no points for ${STALE_TRACKING_MS / 60000} min (${t.point_count} points)`,
        details: { trackingSessionId: Number(t.id), reason: 'stale', points: t.point_count, distanceM: Number(t.distance_m) },
        occurredAt: t.ended_at, dedupeKey: `tracking.end:${t.id}`,
      })
    );
  } catch (error) {
    warn('sweep', error);
  }
};

// Visits left open by a previous server process end at their last contact
const closeAfterRestart = async () => {
  const result = await pool.query(
    `UPDATE customer_presence
        SET ended_at = CASE WHEN state = 'disconnected' THEN state_changed_at ELSE last_seen_at END,
            state = 'ended', state_changed_at = NOW(), end_reason = 'server_restart', socket_id = NULL
      WHERE state <> 'ended'
      RETURNING *`
  );
  afterEnded(result.rows);
};

const start = (socketServer) => {
  io = socketServer;
  closeAfterRestart()
    .catch((error) => warn('restart close', error))
    .finally(() => setInterval(sweep, SWEEP_MS));
};

module.exports = {
  ADMIN_ROOM,
  GRACE_MS,
  start,
  sweep,
  onConnect,
  onState,
  onPing,
  onDisconnect,
  endForSession,
  endAllForCustomer,
};
