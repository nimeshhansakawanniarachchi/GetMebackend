const pool = require('../config/db');
const { emitToAdmins } = require('../realtime');
const { readPage, pageMeta } = require('../utils/pagination');
const { statusLabel } = require('../utils/orderStatus');

// =====================================================
// SHOPPER "I NEED HELP" INCIDENTS (phase 46, 2026-10-29)
//
// Shopper App: POST /api/shopper/incidents { type, orderId?, note?,
// latitude?, longitude?, clientRequestId? } from the help button
// (active-order screens, Home while online). Staff with
// incidents.manage work the queue on the admin Incidents page:
// acknowledge, add notes, resolve (note required). Every change is
// audited, staff get an admin notification (category support,
// permission incidents.manage; critical for safety / accident, so it
// shows even in muted categories), the admin page refreshes on
// 'admin:incidents-updated' and the shopper app gets
// 'shopper-incident-updated' { incident } on acknowledge / resolve.
//
// Spam guard: one open incident per shopper + type + order (a repeat
// press returns it and adds the new note / position), the same
// clientRequestId returns the first result, and at most 6 new
// incidents per shopper in 10 minutes.
// =====================================================

const TYPES = {
  safety: { label: 'Safety / emergency', severity: 'critical' },
  accident: { label: 'Accident or vehicle problem', severity: 'critical' },
  customer: { label: 'Customer problem', severity: 'warning' },
  store: { label: 'Store problem', severity: 'warning' },
  app_payment: { label: 'App or payment problem', severity: 'warning' },
  other: { label: 'Other', severity: 'warning' },
};
const STATUS_LABELS = { open: 'Open', acknowledged: 'Acknowledged', resolved: 'Resolved' };
const NOTE_MAX = 500;
const RATE = { count: 6, minutes: 10 };

const error = (status, message, code) => Object.assign(new Error(message), { status, code });
const isId = (value) => /^\d{1,15}$/.test(String(value ?? ''));
const cleanNote = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const mapUrl = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;

const position = (row) =>
  row.latitude != null && row.longitude != null
    ? { latitude: Number(row.latitude), longitude: Number(row.longitude), at: row.location_at || null, mapUrl: mapUrl(row.latitude, row.longitude) }
    : null;

// What the shopper sees (no staff names)
const toShopper = (row) => ({
  id: Number(row.id),
  type: row.type,
  typeLabel: TYPES[row.type]?.label || row.type,
  severity: row.severity,
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
  orderId: row.order_id != null ? Number(row.order_id) : null,
  note: row.note || null,
  createdAt: row.created_at,
  acknowledgedAt: row.acknowledged_at || null,
  resolvedAt: row.resolved_at || null,
  resolutionNote: row.resolution_note || null,
});

const ADMIN_SELECT = `
  SELECT i.*, sh.full_name AS shopper_name, sh.mobile AS shopper_mobile, sh.shopper_code,
         COALESCE(admin_short_name(sh.full_name), 'Shopper #' || sh.id) AS shopper_short,
         o.status AS order_status,
         ack.full_name AS acknowledged_by_name, res.full_name AS resolved_by_name
  FROM shopper_incidents i
  JOIN shoppers sh ON sh.id = i.shopper_id
  LEFT JOIN orders o ON o.id = i.order_id
  LEFT JOIN admins ack ON ack.id = i.acknowledged_by
  LEFT JOIN admins res ON res.id = i.resolved_by`;

const toAdmin = (row) => ({
  ...toShopper(row),
  position: position(row),
  order: row.order_id != null ? { id: Number(row.order_id), status: row.order_status, statusLabel: statusLabel(row.order_status) } : null,
  shopper: {
    id: Number(row.shopper_id),
    name: row.shopper_name || `Shopper #${row.shopper_id}`,
    shortName: row.shopper_short,
    mobile: row.shopper_mobile || null,
    shopperCode: row.shopper_code || null,
  },
  acknowledgedBy: row.acknowledged_by ? { id: Number(row.acknowledged_by), name: row.acknowledged_by_name || `Admin #${row.acknowledged_by}` } : null,
  resolvedBy: row.resolved_by ? { id: Number(row.resolved_by), name: row.resolved_by_name || `Admin #${row.resolved_by}` } : null,
  updatedAt: row.updated_at,
});

const addEvent = (client, incidentId, kind, note = null, admin = null) =>
  client.query(
    'INSERT INTO shopper_incident_events (incident_id, kind, note, admin_id, admin_name) VALUES ($1, $2, $3, $4, $5)',
    [incidentId, kind, note, admin?.adminId ?? null, admin?.fullName ?? null]
  );

const emitStaff = (io, row) =>
  emitToAdmins(io, 'admin:incidents-updated', { incidentId: Number(row.id), status: row.status, severity: row.severity });

const emitShopper = (io, row) => {
  try {
    io?.to(`shopper:${row.shopper_id}`).emit('shopper-incident-updated', { incident: toShopper(row) });
  } catch (err) {
    console.warn('⚠️ incident emit:', err.message);
  }
};

// Alerts tab row + live badge for the shopper
const notifyShopper = async (io, row, title, body) => {
  const { createShopperNotification } = require('../controllers/shopperNotificationController');
  await createShopperNotification({ io, shopperId: row.shopper_id, type: 'incident', title, body, orderId: row.order_id });
};

const sendError = (res, err, fallback) => {
  if (!err?.status) console.error(`❌ ${fallback}:`, err?.message || err);
  return res.status(err?.status || 500).json({ success: false, code: err?.code, message: err?.status ? err.message : fallback });
};

// -----------------------------------------------------
// Shopper API
// -----------------------------------------------------

const shopperIdOf = (req) => Number(req.shopper?.shopperId);

const coordinate = (value, max) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > max) throw error(400, 'Invalid position', 'INVALID_POSITION');
  return n;
};

// POST /api/shopper/incidents
const createIncident = async (req, res) => {
  const shopperId = shopperIdOf(req);
  const body = req.body || {};
  const client = await pool.connect();
  try {
    const type = String(body.type || '');
    if (!TYPES[type]) throw error(400, 'Choose what kind of help you need', 'INVALID_TYPE');
    const note = cleanNote(body.note);
    if (note.length > NOTE_MAX) throw error(400, `Keep the note under ${NOTE_MAX} characters`, 'NOTE_TOO_LONG');
    const orderId = body.orderId == null || body.orderId === '' ? null : Number(body.orderId);
    if (orderId != null && !isId(orderId)) throw error(400, 'Invalid order', 'INVALID_ORDER');
    let latitude = coordinate(body.latitude, 90);
    let longitude = coordinate(body.longitude, 180);
    if ((latitude == null) !== (longitude == null)) throw error(400, 'Send both latitude and longitude', 'INVALID_POSITION');
    const requestId = body.clientRequestId == null ? null : String(body.clientRequestId).trim().slice(0, 64) || null;

    await client.query('BEGIN');
    // One request per shopper at a time (double taps, retries)
    const shopper = (
      await client.query(
        `SELECT id, latitude, longitude, location_updated_at, COALESCE(admin_short_name(full_name), 'Shopper #' || id) AS short_name
         FROM shoppers WHERE id = $1 FOR UPDATE`,
        [shopperId]
      )
    ).rows[0];
    if (!shopper) throw error(404, 'Shopper not found', 'NOT_FOUND');

    // Retry of the same press: the first result
    if (requestId) {
      const same = (await client.query('SELECT * FROM shopper_incidents WHERE client_request_id = $1', [requestId])).rows[0];
      if (same) {
        await client.query('ROLLBACK');
        if (Number(same.shopper_id) !== shopperId) throw error(409, 'Send the request again', 'REQUEST_ID_IN_USE');
        return res.json({ success: true, duplicate: true, message: 'GetMe staff have been alerted', incident: toShopper(same) });
      }
    }

    if (orderId != null) {
      const order = (await client.query('SELECT shopper_id FROM orders WHERE id = $1', [orderId])).rows[0];
      if (!order || Number(order.shopper_id) !== shopperId) throw error(404, 'That order is not one of yours', 'ORDER_NOT_FOUND');
    }

    // No position from the phone: the last one the app sent
    let locationAt = new Date();
    if (latitude == null && shopper.latitude != null && shopper.longitude != null) {
      latitude = Number(shopper.latitude);
      longitude = Number(shopper.longitude);
      locationAt = shopper.location_updated_at || null;
    }

    // Already open for this type + order: same incident, newest note + position
    const open = (
      await client.query(
        `SELECT * FROM shopper_incidents
         WHERE shopper_id = $1 AND type = $2 AND COALESCE(order_id, 0) = COALESCE($3::int, 0) AND status <> 'resolved'`,
        [shopperId, type, orderId]
      )
    ).rows[0];
    if (open) {
      const updated = (
        await client.query(
          `UPDATE shopper_incidents
           SET latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude),
               location_at = CASE WHEN $2::float8 IS NULL THEN location_at ELSE $4 END, updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [open.id, latitude, longitude, locationAt]
        )
      ).rows[0];
      if (note) await addEvent(client, open.id, 'shopper_update', note);
      await client.query('COMMIT');
      emitStaff(req.app.get('io'), updated);
      return res.json({
        success: true,
        duplicate: true,
        message: 'GetMe staff already have your request. Your update was added.',
        incident: toShopper(updated),
      });
    }

    const recent = (
      await client.query(
        `SELECT COUNT(*)::int AS n FROM shopper_incidents WHERE shopper_id = $1 AND created_at > NOW() - make_interval(mins => $2)`,
        [shopperId, RATE.minutes]
      )
    ).rows[0].n;
    if (recent >= RATE.count) {
      throw error(429, 'You have sent several help requests. GetMe staff have them. In an emergency call 119 (police) or 1990 (ambulance).', 'TOO_MANY_REQUESTS');
    }

    const meta = TYPES[type];
    const row = (
      await client.query(
        `INSERT INTO shopper_incidents (shopper_id, order_id, type, severity, note, latitude, longitude, location_at, client_request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [shopperId, orderId, type, meta.severity, note || null, latitude, longitude, latitude == null ? null : locationAt, requestId]
      )
    ).rows[0];
    await addEvent(client, row.id, 'created', note || null);

    // Staff alert: no note text (may hold personal details), first name + initial only
    await client.query('SELECT admin_notify($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
      'support',
      'incident.created',
      meta.severity,
      `Shopper needs help: ${meta.label} · ${shopper.short_name}`,
      [
        orderId ? `Order #${orderId}` : 'No order',
        latitude != null ? 'position sent' : 'no position',
        note ? 'note added' : null,
        'Open the Incidents page to acknowledge.',
      ].filter(Boolean).join(' · '),
      'incident',
      String(row.id),
      ['incidents.manage'],
      `incident.created:${row.id}`,
    ]);
    await client.query('COMMIT');

    emitStaff(req.app.get('io'), row);
    return res.status(201).json({ success: true, message: 'GetMe staff have been alerted', incident: toShopper(row) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Two presses at the same moment: the unique index keeps one
    if (err?.code === '23505') {
      const open = (
        await pool.query(
          "SELECT * FROM shopper_incidents WHERE shopper_id = $1 AND type = $2 AND status <> 'resolved' ORDER BY id DESC LIMIT 1",
          [shopperId, String(body.type || '')]
        )
      ).rows[0];
      if (open) return res.json({ success: true, duplicate: true, message: 'GetMe staff have been alerted', incident: toShopper(open) });
    }
    return sendError(res, err, 'Unable to send your help request');
  } finally {
    client.release();
  }
};

// GET /api/shopper/incidents?active=1
const listMyIncidents = async (req, res) => {
  try {
    const active = req.query.active === '1' || req.query.active === 'true';
    const rows = await pool.query(
      `SELECT * FROM shopper_incidents WHERE shopper_id = $1 ${active ? "AND (status <> 'resolved' OR resolved_at > NOW() - INTERVAL '1 hour')" : ''}
       ORDER BY created_at DESC LIMIT 20`,
      [shopperIdOf(req)]
    );
    return res.json({
      success: true,
      types: Object.entries(TYPES).map(([key, t]) => ({ key, label: t.label, severity: t.severity })),
      incidents: rows.rows.map(toShopper),
    });
  } catch (err) {
    return sendError(res, err, 'Unable to load your help requests');
  }
};

// GET /api/shopper/incidents/:id (own only)
const getMyIncident = async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid request' });
  try {
    const row = (await pool.query('SELECT * FROM shopper_incidents WHERE id = $1 AND shopper_id = $2', [req.params.id, shopperIdOf(req)])).rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'Help request not found' });
    return res.json({ success: true, incident: toShopper(row) });
  } catch (err) {
    return sendError(res, err, 'Unable to load the help request');
  }
};

// -----------------------------------------------------
// Admin API (incidents.manage)
// -----------------------------------------------------

const STATUS_FILTERS = {
  active: "i.status <> 'resolved'",
  open: "i.status = 'open'",
  acknowledged: "i.status = 'acknowledged'",
  resolved: "i.status = 'resolved'",
  all: 'TRUE',
};

// GET /incidents?status=active|open|acknowledged|resolved|all&type=&severity=&shopperId=&orderId=&page=&pageSize=
const listIncidents = async (req, res) => {
  try {
    const status = STATUS_FILTERS[req.query.status] ? req.query.status : 'active';
    const where = [STATUS_FILTERS[status]];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (TYPES[req.query.type]) add('i.type = ?', req.query.type);
    if (['warning', 'critical'].includes(req.query.severity)) add('i.severity = ?', req.query.severity);
    if (isId(req.query.shopperId)) add('i.shopper_id = ?', Number(req.query.shopperId));
    if (isId(req.query.orderId)) add('i.order_id = ?', Number(req.query.orderId));

    const page = readPage(req.query, 20);
    const [rows, total, counts] = await Promise.all([
      pool.query(
        `${ADMIN_SELECT} WHERE ${where.join(' AND ')}
         ORDER BY (i.status = 'resolved'), (i.severity = 'critical') DESC, i.created_at DESC, i.id DESC
         LIMIT ${page.pageSize} OFFSET ${page.offset}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM shopper_incidents i WHERE ${where.join(' AND ')}`, params),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open,
                COUNT(*) FILTER (WHERE status = 'acknowledged')::int AS acknowledged,
                COUNT(*) FILTER (WHERE status <> 'resolved')::int AS active,
                COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
                COUNT(*) FILTER (WHERE status = 'open' AND severity = 'critical')::int AS critical_open,
                COUNT(*) FILTER (WHERE status = 'resolved' AND resolved_at > NOW() - INTERVAL '24 hours')::int AS resolved_today
         FROM shopper_incidents`
      ),
    ]);
    const c = counts.rows[0];
    return res.json({
      success: true,
      incidents: rows.rows.map(toAdmin),
      counts: {
        open: c.open, acknowledged: c.acknowledged, active: c.active, resolved: c.resolved,
        criticalOpen: c.critical_open, resolvedToday: c.resolved_today,
      },
      types: Object.entries(TYPES).map(([key, t]) => ({ key, label: t.label, severity: t.severity })),
      ...pageMeta(page, total.rows[0].n),
    });
  } catch (err) {
    return sendError(res, err, 'Unable to load incidents');
  }
};

const loadAdmin = async (client, id) => (await client.query(`${ADMIN_SELECT} WHERE i.id = $1`, [id])).rows[0];

const detail = async (client, id) => {
  const row = await loadAdmin(client, id);
  if (!row) return null;
  const events = await client.query(
    'SELECT id, kind, note, admin_id, admin_name, created_at FROM shopper_incident_events WHERE incident_id = $1 ORDER BY created_at, id',
    [id]
  );
  return {
    incident: toAdmin(row),
    events: events.rows.map((e) => ({
      id: Number(e.id),
      kind: e.kind,
      note: e.note,
      by: e.admin_id ? { id: Number(e.admin_id), name: e.admin_name || `Admin #${e.admin_id}` } : null,
      at: e.created_at,
    })),
  };
};

// GET /incidents/:id
const getIncident = async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid incident' });
  try {
    const data = await detail(pool, Number(req.params.id));
    if (!data) return res.status(404).json({ success: false, message: 'Incident not found' });
    return res.json({ success: true, ...data });
  } catch (err) {
    return sendError(res, err, 'Unable to load the incident');
  }
};

// Shared body of acknowledge / resolve / note
const change = (action) => async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid incident' });
  const id = Number(req.params.id);
  const note = cleanNote(req.body?.note);
  const client = await pool.connect();
  try {
    if (note.length > NOTE_MAX) throw error(400, `Keep the note under ${NOTE_MAX} characters`, 'NOTE_TOO_LONG');
    if ((action === 'resolve' || action === 'note') && note.length < 3) {
      throw error(400, action === 'resolve' ? 'Write what was done to resolve it' : 'Write a note', 'NOTE_REQUIRED');
    }
    await client.query('BEGIN');
    const before = (await client.query('SELECT * FROM shopper_incidents WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) throw error(404, 'Incident not found', 'NOT_FOUND');
    const adminId = req.admin?.adminId ?? null;
    let row = before;

    if (action === 'acknowledge') {
      if (before.status !== 'open') throw error(409, `This incident is already ${STATUS_LABELS[before.status].toLowerCase()}`, 'ALREADY_HANDLED');
      row = (
        await client.query(
          "UPDATE shopper_incidents SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *",
          [id, adminId]
        )
      ).rows[0];
      await addEvent(client, id, 'acknowledged', note || null, req.admin);
    } else if (action === 'resolve') {
      if (before.status === 'resolved') throw error(409, 'This incident is already resolved', 'ALREADY_HANDLED');
      row = (
        await client.query(
          `UPDATE shopper_incidents
           SET status = 'resolved', resolved_by = $2, resolved_at = NOW(), resolution_note = $3,
               acknowledged_by = COALESCE(acknowledged_by, $2), acknowledged_at = COALESCE(acknowledged_at, NOW()), updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [id, adminId, note]
        )
      ).rows[0];
      await addEvent(client, id, 'resolved', note, req.admin);
    } else {
      await client.query('UPDATE shopper_incidents SET updated_at = NOW() WHERE id = $1', [id]);
      await addEvent(client, id, 'note', note, req.admin);
    }
    await client.query('COMMIT');

    const io = req.app.get('io');
    emitStaff(io, row);
    if (action !== 'note') {
      emitShopper(io, row);
      const label = TYPES[row.type]?.label || 'Help request';
      if (action === 'acknowledge') {
        notifyShopper(io, row, 'GetMe staff are on it', `Your help request (${label}) was seen by GetMe staff. Stay safe - they will contact you.`).catch(() => {});
      } else {
        notifyShopper(io, row, 'Help request resolved', `${label}: ${note}`.slice(0, 500)).catch(() => {});
      }
    }

    const typeLabel = TYPES[before.type]?.label || before.type;
    res.locals.audit = {
      summary: {
        acknowledge: `Acknowledged shopper incident #${id} (${typeLabel})`,
        resolve: `Resolved shopper incident #${id} (${typeLabel}): ${note}`,
        note: `Note on shopper incident #${id}: ${note}`,
      }[action].slice(0, 300),
      before: { status: before.status, resolutionNote: before.resolution_note || null },
      after: { status: row.status, resolutionNote: row.resolution_note || null },
    };
    return res.json({
      success: true,
      message: { acknowledge: 'Incident acknowledged - the shopper sees that staff are on it', resolve: 'Incident resolved', note: 'Note added' }[action],
      ...(await detail(pool, id)),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return sendError(res, err, 'Unable to update the incident');
  } finally {
    client.release();
  }
};

module.exports = {
  TYPES,
  createIncident,
  listMyIncidents,
  getMyIncident,
  listIncidents,
  getIncident,
  acknowledgeIncident: change('acknowledge'),
  resolveIncident: change('resolve'),
  addIncidentNote: change('note'),
};
