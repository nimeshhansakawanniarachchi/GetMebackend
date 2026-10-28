const { Client } = require('pg');

const pool = require('../config/db');
const { readPage, pageMeta } = require('../utils/pagination');

// =====================================================
// ADMIN NOTIFICATIONS (phase 41, 2026-10-29)
//
// Events are written by the database when the change commits
// (sql/platform_phase41_admin_notifications.sql: triggers call
// admin_notify(), which de-duplicates on dedupe_key and NOTIFYs
// 'admin_notification'). This module:
//   * LISTENs on that channel and pushes each new row over Socket.IO to
//     the admin sockets allowed to see it (one emit per socket, so an
//     admin with several permissions still gets it once);
//   * adds time-based alerts (late / unassigned orders, stuck payments,
//     failed refunds) from the existing Issues checks every minute, and
//     technical errors for the Developer role;
//   * serves the notification API (list, summary, read, dismiss,
//     preferences, Super Admin policy).
// Who sees a row: target_admin_id = me, or (no target) I hold one of
// row.permissions AND my role receives the category (policy) AND I
// didn't cause it myself. Critical rows ignore personal mutes.
// =====================================================

const CATEGORIES = [
  { key: 'orders', label: 'Orders', permissions: ['orders.view'] },
  { key: 'customers', label: 'Customers', permissions: ['customers.view'] },
  { key: 'shoppers', label: 'Shoppers', permissions: ['shoppers.view', 'shopper_applications.list', 'shoppers.manage', 'orders.view'] },
  { key: 'shops', label: 'Shops', permissions: ['shops.view'] },
  { key: 'products', label: 'Products & inventory', permissions: ['shops.view', 'pricing.view'] },
  {
    key: 'payments', label: 'Payments & payouts',
    permissions: ['finance.view', 'finance.store_bills', 'finance.withdrawals', 'grocery.view', 'approvals.decide'],
  },
  { key: 'support', label: 'Support & complaints', permissions: ['orders.view'] },
  { key: 'staff', label: 'Staff & security', permissions: ['admins.manage', 'audit.view'] },
  { key: 'system', label: 'System & integrations', permissions: ['system.logs', 'system.health'] },
];
const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
const SEVERITIES = ['info', 'warning', 'critical'];
const POPUPS = ['all', 'important', 'off'];
const ROLE_KEYS = ['operations', 'finance', 'support', 'developer'];

const isId = (value) => /^\d{1,18}$/.test(String(value ?? ''));
const asArray = (value) => (Array.isArray(value) ? value : []);
const warn = (label, error) => console.warn(`⚠️ notifications ${label}:`, error?.message || error);

// -----------------------------------------------------
// Policy (Super Admin) + personal preferences, cached
// -----------------------------------------------------

let settingsCache = null;
let settingsLoadedAt = 0;

const loadSettings = async (force = false) => {
  if (!force && settingsCache && Date.now() - settingsLoadedAt < 60_000) return settingsCache;
  const result = await pool.query('SELECT retention_days, role_categories, updated_at, updated_by FROM admin_notification_settings WHERE id = 1');
  const row = result.rows[0] || { retention_days: 90, role_categories: {} };
  settingsCache = {
    retentionDays: Number(row.retention_days) || 90,
    roleCategories: row.role_categories || {},
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by || null,
  };
  settingsLoadedAt = Date.now();
  return settingsCache;
};

// Categories a role receives (the Super Admin receives every category)
const roleCategories = (settings, role) =>
  role === 'owner' ? CATEGORY_KEYS : asArray(settings.roleCategories?.[role]).filter((c) => CATEGORY_KEYS.includes(c));

const DEFAULT_PREFS = { mutedCategories: [], importantOnlyCategories: [], popups: 'important' };
const prefsCache = new Map();

const loadPrefs = async (adminId, force = false) => {
  if (!force && prefsCache.has(adminId)) return prefsCache.get(adminId);
  const result = await pool.query(
    'SELECT muted_categories, important_only_categories, popups FROM admin_notification_preferences WHERE admin_id = $1',
    [adminId]
  );
  const row = result.rows[0];
  const prefs = row
    ? { mutedCategories: row.muted_categories || [], importantOnlyCategories: row.important_only_categories || [], popups: row.popups }
    : { ...DEFAULT_PREFS };
  prefsCache.set(adminId, prefs);
  return prefs;
};

// Everything the visibility check needs about one admin
const viewerOf = async (admin) => {
  const settings = await loadSettings();
  const permissions = [...(admin.permissions || [])];
  const permissionSet = new Set(permissions);
  return {
    id: Number(admin.adminId),
    role: admin.role,
    permissions,
    // Categories the admin can see at all: policy for the role AND a permission that opens it
    categories: roleCategories(settings, admin.role).filter((key) =>
      CATEGORIES.find((c) => c.key === key).permissions.some((p) => permissionSet.has(p))
    ),
    prefs: await loadPrefs(Number(admin.adminId)),
    retentionDays: settings.retentionDays,
  };
};

// SQL condition for "this admin may see n" ($1 id, $2 permissions, $3 categories, $4 muted, $5 important-only, $6 retention days)
const VISIBLE_SQL = `
  n.created_at >= NOW() - make_interval(days => $6::int)
  AND (
    n.target_admin_id = $1
    OR (n.target_admin_id IS NULL AND n.permissions && $2::text[] AND n.category = ANY($3::text[])
        AND n.actor_admin_id IS DISTINCT FROM $1)
  )
  AND (n.severity = 'critical' OR NOT (n.category = ANY($4::text[])))
  AND (n.severity <> 'info' OR NOT (n.category = ANY($5::text[])))
`;
const visibleParams = (viewer) => [
  viewer.id, viewer.permissions, viewer.categories,
  viewer.prefs.mutedCategories, viewer.prefs.importantOnlyCategories, viewer.retentionDays,
];

// Same rule in JS for the socket push
const canSee = (viewer, row) => {
  if (row.target_admin_id != null) return Number(row.target_admin_id) === viewer.id;
  if (row.actor_admin_id != null && Number(row.actor_admin_id) === viewer.id) return false;
  if (!viewer.categories.includes(row.category)) return false;
  if (!asArray(row.permissions).some((p) => viewer.permissions.includes(p))) return false;
  if (row.severity !== 'critical' && viewer.prefs.mutedCategories.includes(row.category)) return false;
  if (row.severity === 'info' && viewer.prefs.importantOnlyCategories.includes(row.category)) return false;
  return true;
};

// -----------------------------------------------------
// Links to existing pages
// -----------------------------------------------------

const linkFor = (row) => {
  const id = row.entity_id;
  switch (row.entity_type) {
    case 'order': return id ? `/orders/${id}` : '/orders';
    case 'customer': return `/customers/${id}`;
    case 'shopper': return `/shoppers/${id}`;
    case 'shop': return `/shops/${id}`;
    case 'shopper_application': return '/shopper-applications';
    case 'withdrawal': return '/withdrawals';
    case 'approval': return '/approvals';
    case 'admin': return '/staff';
    case 'audit': return '/audit-log';
    case 'system': return '/system';
    default: return null;
  }
};

const toPublic = (row) => {
  const count = row.item_count != null ? Number(row.item_count) : null;
  return {
    id: Number(row.id),
    category: row.category,
    eventType: row.event_type,
    severity: row.severity,
    title: row.title,
    body: row.body ? row.body.replace('{n}', String(count ?? 1)) : null,
    count,
    entity: row.entity_type ? { type: row.entity_type, id: row.entity_id } : null,
    link: linkFor(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readAt: row.read_at || null,
    read: Boolean(row.read_at),
  };
};

// -----------------------------------------------------
// API
// -----------------------------------------------------

const fail = (res, label, error, message) => {
  warn(label, error);
  return res.status(500).json({ success: false, message });
};

const categoryList = (viewer) =>
  CATEGORIES.filter((c) => viewer.categories.includes(c.key)).map(({ key, label }) => ({ key, label }));

// GET /notifications?category=&status=unread|read|all&severity=&from=&to=&page=&pageSize=
const listNotifications = async (req, res) => {
  try {
    const viewer = await viewerOf(req.admin);
    const params = visibleParams(viewer);
    const where = [VISIBLE_SQL, 'st.dismissed_at IS NULL'];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

    if (CATEGORY_KEYS.includes(req.query.category)) add('n.category = ?', req.query.category);
    if (SEVERITIES.includes(req.query.severity)) add('n.severity = ?', req.query.severity);
    if (req.query.status === 'unread') where.push('st.read_at IS NULL');
    if (req.query.status === 'read') where.push('st.read_at IS NOT NULL');
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) add('n.created_at >= ?::date', req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) add("n.created_at < (?::date + INTERVAL '1 day')", req.query.to);

    const page = readPage(req.query, 20);
    const from = `FROM admin_notifications n
      LEFT JOIN admin_notification_states st ON st.notification_id = n.id AND st.admin_id = $1
      WHERE ${where.join(' AND ')}`;
    const [rows, total] = await Promise.all([
      pool.query(`SELECT n.*, st.read_at ${from} ORDER BY n.created_at DESC, n.id DESC LIMIT ${page.pageSize} OFFSET ${page.offset}`, params),
      pool.query(`SELECT count(*)::int AS total ${from}`, params),
    ]);

    return res.json({
      success: true,
      notifications: rows.rows.map(toPublic),
      categories: categoryList(viewer),
      ...pageMeta(page, total.rows[0].total),
    });
  } catch (error) {
    return fail(res, 'list', error, 'Unable to load notifications');
  }
};

// Unread counts (total, important, per category) + the latest few
const summaryFor = async (viewer, latest = 8) => {
  const params = visibleParams(viewer);
  const from = `FROM admin_notifications n
    LEFT JOIN admin_notification_states st ON st.notification_id = n.id AND st.admin_id = $1
    WHERE ${VISIBLE_SQL} AND st.dismissed_at IS NULL`;
  const [counts, rows] = await Promise.all([
    pool.query(
      `SELECT n.category, count(*)::int AS unread,
              count(*) FILTER (WHERE n.severity <> 'info')::int AS important,
              count(*) FILTER (WHERE n.severity = 'critical')::int AS critical
       ${from} AND st.read_at IS NULL GROUP BY n.category`,
      params
    ),
    pool.query(`SELECT n.*, st.read_at ${from} ORDER BY n.created_at DESC, n.id DESC LIMIT ${latest}`, params),
  ]);
  const byCategory = Object.fromEntries(viewer.categories.map((key) => [key, 0]));
  let unread = 0;
  let important = 0;
  let critical = 0;
  counts.rows.forEach((row) => {
    byCategory[row.category] = row.unread;
    unread += row.unread;
    important += row.important;
    critical += row.critical;
  });
  return {
    unread, important, critical, byCategory,
    latest: rows.rows.map(toPublic),
    categories: categoryList(viewer),
    preferences: viewer.prefs,
  };
};

const getSummary = async (req, res) => {
  try {
    return res.json({ success: true, ...(await summaryFor(await viewerOf(req.admin))) });
  } catch (error) {
    return fail(res, 'summary', error, 'Unable to load notifications');
  }
};

// Marks / dismisses only rows this admin may see (ownership check)
const setState = async (viewer, ids, column) => {
  const params = visibleParams(viewer);
  params.push(ids);
  const result = await pool.query(
    `INSERT INTO admin_notification_states (admin_id, notification_id, ${column})
     SELECT $1, n.id, NOW() FROM admin_notifications n
     WHERE n.id = ANY($7::bigint[]) AND ${VISIBLE_SQL}
     ON CONFLICT (admin_id, notification_id) DO UPDATE
       SET ${column} = COALESCE(admin_notification_states.${column}, NOW())
     RETURNING notification_id`,
    params
  );
  return result.rows.map((r) => Number(r.notification_id));
};

const pushSummary = async (req, viewer) => {
  // Other tabs of the same admin refresh their badges
  try {
    req.app.get('io')?.to(`admin:${viewer.id}`).emit('admin:notifications-changed', { reason: 'state' });
  } catch (error) {
    warn('push state', error);
  }
};

// POST /notifications/:id/read | /notifications/:id/dismiss
const stateHandler = (column) => async (req, res) => {
  res.locals.skipAudit = true;
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid notification' });
  try {
    const viewer = await viewerOf(req.admin);
    const changed = await setState(viewer, [req.params.id], column);
    if (!changed.length) return res.status(404).json({ success: false, message: 'Notification not found' });
    if (column === 'dismissed_at') {
      // Dismissed implies read
      await setState(viewer, changed, 'read_at');
    }
    pushSummary(req, viewer);
    return res.json({ success: true, id: changed[0], summary: await summaryFor(viewer) });
  } catch (error) {
    return fail(res, column, error, 'Unable to update the notification');
  }
};

// POST /notifications/:id/unread
const markUnread = async (req, res) => {
  res.locals.skipAudit = true;
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid notification' });
  try {
    const viewer = await viewerOf(req.admin);
    const result = await pool.query(
      'UPDATE admin_notification_states SET read_at = NULL WHERE admin_id = $1 AND notification_id = $2 AND dismissed_at IS NULL RETURNING notification_id',
      [viewer.id, req.params.id]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'Notification not found' });
    pushSummary(req, viewer);
    return res.json({ success: true, summary: await summaryFor(viewer) });
  } catch (error) {
    return fail(res, 'unread', error, 'Unable to update the notification');
  }
};

// POST /notifications/read-all { category? }
const markAllRead = async (req, res) => {
  res.locals.skipAudit = true;
  try {
    const viewer = await viewerOf(req.admin);
    const params = visibleParams(viewer);
    let extra = '';
    if (req.body?.category != null) {
      if (!CATEGORY_KEYS.includes(req.body.category)) return res.status(400).json({ success: false, message: 'Unknown category' });
      params.push(req.body.category);
      extra = `AND n.category = $${params.length}`;
    }
    const result = await pool.query(
      `INSERT INTO admin_notification_states (admin_id, notification_id, read_at)
       SELECT $1, n.id, NOW() FROM admin_notifications n
       LEFT JOIN admin_notification_states st ON st.notification_id = n.id AND st.admin_id = $1
       WHERE ${VISIBLE_SQL} ${extra} AND st.read_at IS NULL
       ON CONFLICT (admin_id, notification_id) DO UPDATE SET read_at = NOW()`,
      params
    );
    pushSummary(req, viewer);
    return res.json({ success: true, marked: result.rowCount, summary: await summaryFor(viewer) });
  } catch (error) {
    return fail(res, 'read-all', error, 'Unable to update notifications');
  }
};

// GET /notifications/preferences
const getPreferences = async (req, res) => {
  try {
    const viewer = await viewerOf(req.admin);
    return res.json({
      success: true,
      preferences: viewer.prefs,
      categories: categoryList(viewer),
      channels: { inApp: true, email: false, push: false },
      note: 'In-app only. E-mail and phone push for staff are not set up in GetMe yet. Critical alerts always show, even in muted categories.',
    });
  } catch (error) {
    return fail(res, 'preferences', error, 'Unable to load preferences');
  }
};

// PUT /notifications/preferences { mutedCategories, importantOnlyCategories, popups }
const updatePreferences = async (req, res) => {
  res.locals.skipAudit = true;
  const body = req.body || {};
  const cleanList = (value) => [...new Set(asArray(value).map(String))].filter((c) => CATEGORY_KEYS.includes(c));
  if (body.popups != null && !POPUPS.includes(body.popups)) {
    return res.status(400).json({ success: false, message: 'popups must be all, important or off' });
  }
  try {
    const adminId = Number(req.admin.adminId);
    const current = await loadPrefs(adminId);
    const next = {
      mutedCategories: body.mutedCategories !== undefined ? cleanList(body.mutedCategories) : current.mutedCategories,
      importantOnlyCategories: body.importantOnlyCategories !== undefined ? cleanList(body.importantOnlyCategories) : current.importantOnlyCategories,
      popups: body.popups || current.popups,
    };
    await pool.query(
      `INSERT INTO admin_notification_preferences (admin_id, muted_categories, important_only_categories, popups, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (admin_id) DO UPDATE SET muted_categories = $2, important_only_categories = $3, popups = $4, updated_at = NOW()`,
      [adminId, next.mutedCategories, next.importantOnlyCategories, next.popups]
    );
    prefsCache.set(adminId, next);
    refreshSockets(req.app.get('io'), adminId);
    const viewer = await viewerOf(req.admin);
    pushSummary(req, viewer);
    return res.json({ success: true, preferences: next, summary: await summaryFor(viewer) });
  } catch (error) {
    return fail(res, 'update preferences', error, 'Unable to save preferences');
  }
};

// GET /notifications/settings (Super Admin)
const getPolicy = async (req, res) => {
  try {
    const settings = await loadSettings(true);
    return res.json({
      success: true,
      settings: {
        retentionDays: settings.retentionDays,
        roleCategories: Object.fromEntries(ROLE_KEYS.map((role) => [role, roleCategories(settings, role)])),
        updatedAt: settings.updatedAt,
      },
      categories: CATEGORIES.map(({ key, label, permissions }) => ({ key, label, permissions })),
      roles: ROLE_KEYS,
      note: 'A role only receives a category when its staff also hold a permission that opens it. The Super Admin receives every category.',
    });
  } catch (error) {
    return fail(res, 'policy', error, 'Unable to load the notification policy');
  }
};

// PUT /notifications/settings { retentionDays, roleCategories: { operations: [...], ... } }
const updatePolicy = async (req, res) => {
  const body = req.body || {};
  const days = body.retentionDays === undefined ? undefined : Number(body.retentionDays);
  if (days !== undefined && (!Number.isInteger(days) || days < 7 || days > 730)) {
    return res.status(400).json({ success: false, message: 'Keep notifications for 7 to 730 days' });
  }
  try {
    const before = await loadSettings(true);
    const roleCats = { ...before.roleCategories };
    if (body.roleCategories && typeof body.roleCategories === 'object') {
      for (const role of Object.keys(body.roleCategories)) {
        if (!ROLE_KEYS.includes(role)) return res.status(400).json({ success: false, message: `Unknown role ${role}` });
        roleCats[role] = [...new Set(asArray(body.roleCategories[role]).map(String))].filter((c) => CATEGORY_KEYS.includes(c));
      }
    }
    await pool.query(
      `UPDATE admin_notification_settings SET retention_days = $1, role_categories = $2, updated_by = $3, updated_at = NOW() WHERE id = 1`,
      [days ?? before.retentionDays, JSON.stringify(roleCats), req.admin.adminId]
    );
    const after = await loadSettings(true);
    res.locals.audit = {
      summary: `Notification policy: keep ${after.retentionDays} days; ${ROLE_KEYS.map((r) => `${r}: ${roleCategories(after, r).join('/') || 'none'}`).join('; ')}`.slice(0, 300),
      before: { retentionDays: before.retentionDays, roleCategories: before.roleCategories },
      after: { retentionDays: after.retentionDays, roleCategories: after.roleCategories },
    };
    refreshSockets(req.app.get('io'));
    req.app.get('io')?.to('admins:notify').emit('admin:notifications-changed', { reason: 'policy' });
    return res.json({
      success: true,
      settings: {
        retentionDays: after.retentionDays,
        roleCategories: Object.fromEntries(ROLE_KEYS.map((role) => [role, roleCategories(after, role)])),
        updatedAt: after.updatedAt,
      },
    });
  } catch (error) {
    return fail(res, 'update policy', error, 'Unable to save the notification policy');
  }
};

// -----------------------------------------------------
// Creating notifications from Node (same SQL function as the triggers)
// -----------------------------------------------------

const notify = async ({ category, event, severity = 'info', title, body = null, entityType = null, entityId = null,
  permissions, dedupe, targetAdminId = null, actorAdminId = null, count = null }) => {
  try {
    const result = await pool.query(
      'SELECT admin_notify($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS id',
      [category, event, severity, title, body, entityType, entityId == null ? null : String(entityId),
        permissions || [], dedupe, targetAdminId, actorAdminId, count]
    );
    return result.rows[0]?.id ? Number(result.rows[0].id) : null;
  } catch (error) {
    warn(`notify ${event}`, error);
    return null;
  }
};

// -----------------------------------------------------
// Socket.IO push
// -----------------------------------------------------

// bin/www: an admin socket is ready (active account, current session)
const attachSocket = async (socket, { adminId, role, permissions }) => {
  socket.notifyViewer = null;
  try {
    socket.notifyViewer = await viewerOf({ adminId, role, permissions });
    socket.join(`admin:${adminId}`);
    socket.join('admins:notify');
  } catch (error) {
    warn('attach socket', error);
  }
};

// Re-read policy / preferences for open sockets (all, or one admin's)
const refreshSockets = async (io, adminId = null) => {
  if (!io) return;
  try {
    const sockets = await io.in(adminId ? `admin:${adminId}` : 'admins:notify').fetchSockets();
    for (const socket of sockets) {
      const viewer = socket.notifyViewer;
      if (!viewer) continue;
      socket.notifyViewer = await viewerOf({ adminId: viewer.id, role: viewer.role, permissions: viewer.permissions });
    }
  } catch (error) {
    warn('refresh sockets', error);
  }
};

const deliver = async (io, id, countOnly) => {
  const result = await pool.query('SELECT * FROM admin_notifications WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) return;
  const payload = toPublic(row);
  const sockets = await io.in('admins:notify').fetchSockets();
  sockets.forEach((socket) => {
    if (socket.notifyViewer && canSee(socket.notifyViewer, row)) {
      socket.emit(countOnly ? 'admin:notification-updated' : 'admin:notification', payload);
    }
  });
};

let listener = null;
let lastDeliveredId = 0;

// One LISTEN connection per server process; reconnects and catches up
// on rows created while it was down
const startListener = (io) => {
  let stopped = false;
  let retryMs = 2000;

  const connect = async () => {
    const client = new Client({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    const retry = () => {
      if (stopped || listener !== client) return;
      listener = null;
      client.end().catch(() => {});
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 60_000);
    };
    client.on('error', (error) => { warn('listener', error); retry(); });
    client.on('end', retry);
    client.on('notification', (msg) => {
      const [id, kind] = String(msg.payload || '').split(':');
      if (!isId(id)) return;
      lastDeliveredId = Math.max(lastDeliveredId, Number(id));
      deliver(io, Number(id), kind === 'count').catch((error) => warn('deliver', error));
    });
    try {
      listener = client;
      await client.connect();
      await client.query('LISTEN admin_notification');
      retryMs = 2000;
      // Catch up on anything created while the listener was down
      if (lastDeliveredId) {
        const missed = await pool.query('SELECT id FROM admin_notifications WHERE id > $1 ORDER BY id LIMIT 200', [lastDeliveredId]);
        for (const row of missed.rows) {
          lastDeliveredId = Math.max(lastDeliveredId, Number(row.id));
          await deliver(io, Number(row.id), false);
        }
      } else {
        const latest = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM admin_notifications');
        lastDeliveredId = Math.max(lastDeliveredId, Number(latest.rows[0].id));
      }
    } catch (error) {
      warn('listener connect', error);
      retry();
    }
  };

  connect();
  return () => {
    stopped = true;
    listener?.end().catch(() => {});
  };
};

// -----------------------------------------------------
// Time-based alerts from the existing Issues checks + retention
// -----------------------------------------------------

const ISSUE_RULES = {
  unassigned: { category: 'orders', event: 'order.unassigned', permissions: ['orders.view'] },
  delayed: { category: 'orders', event: 'order.delayed', permissions: ['orders.view'] },
  location_stale: { category: 'shoppers', event: 'shopper.location_stale', permissions: ['liveops.view', 'shoppers.view'], daily: true },
  refund_failed: { category: 'payments', event: 'payment.refund_failed', permissions: ['finance.view'] },
  payment_mismatch: { category: 'payments', event: 'payment.mismatch', permissions: ['finance.view'] },
  insufficient_funds: { category: 'payments', event: 'finance.order_loss', permissions: ['finance.view'], severity: 'warning' },
  cash_overdue: { category: 'payments', event: 'payout.cash_overdue', permissions: ['finance.view'], daily: true },
};
const ISSUE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const ISSUE_SEVERITY = { critical: 'critical', high: 'critical', medium: 'warning', low: 'info' };

const checkIssues = async () => {
  const { computeIssues } = require('../controllers/admin/adminOpsController');
  const issues = await computeIssues();
  const today = new Date().toISOString().slice(0, 10);
  // Only fresh problems become notifications; older ones stay on the Issues page
  const freshSince = Date.now() - ISSUE_MAX_AGE_MS;
  for (const issue of issues) {
    const rule = ISSUE_RULES[issue.type];
    if (!rule) continue;
    if (issue.at && new Date(issue.at).getTime() < freshSince) continue;
    await notify({
      category: rule.category,
      event: rule.event,
      severity: rule.severity || ISSUE_SEVERITY[issue.severity] || 'warning',
      title: issue.title,
      body: issue.detail,
      entityType: issue.entity?.type || null,
      entityId: issue.entity?.id ?? null,
      permissions: rule.permissions,
      dedupe: `issue:${issue.key}${rule.daily ? `:${today}` : ''}`,
    });
  }

  // Customer card payments still pending after 15 minutes
  const pending = await pool.query(
    `SELECT id, ref, order_id, amount FROM card_payments
     WHERE status = 'pending' AND owner_type = 'customer' AND purpose IN ('order', 'order_extra')
       AND abandoned_at IS NULL
       AND created_at < NOW() - INTERVAL '15 minutes' AND created_at > NOW() - INTERVAL '1 day'
     LIMIT 50`
  );
  for (const row of pending.rows) {
    await notify({
      category: 'payments', event: 'payment.pending', severity: 'warning',
      title: `Card payment still pending${row.order_id ? ` for order #${row.order_id}` : ''}`,
      body: `Rs ${Number(row.amount).toLocaleString('en-LK', { minimumFractionDigits: 2 })} · ${row.ref} · no answer from the gateway for 15 minutes.`,
      entityType: row.order_id ? 'order' : null, entityId: row.order_id, permissions: ['finance.view'],
      dedupe: `payment.pending:${row.id}`,
    });
  }
};

let lastCleanup = 0;
const cleanup = async () => {
  if (Date.now() - lastCleanup < 60 * 60 * 1000) return;
  lastCleanup = Date.now();
  const settings = await loadSettings(true);
  await pool.query('DELETE FROM admin_notifications WHERE created_at < NOW() - make_interval(days => $1::int)', [settings.retentionDays]);
};

const startClock = () => {
  const tick = async () => {
    try {
      await checkIssues();
      await cleanup();
    } catch (error) {
      warn('clock', error);
    }
  };
  setTimeout(tick, 15_000);
  return setInterval(tick, Number(process.env.NOTIFY_CHECK_MS) || 60_000);
};

// -----------------------------------------------------
// Technical errors for the Developer role (systemHealth hooks).
// Grouped per route / label per hour; written at most every 10 s.
// -----------------------------------------------------

const pendingSystem = new Map();
let systemTimer = null;

const flushSystem = async () => {
  systemTimer = null;
  const batch = [...pendingSystem.values()];
  pendingSystem.clear();
  for (const item of batch) {
    await notify(item);
  }
};

const systemEvent = ({ event, severity, title, body, key }) => {
  const hour = new Date().toISOString().slice(0, 13);
  const dedupe = `${event}:${key}:${hour}`.slice(0, 200);
  const item = pendingSystem.get(dedupe) || {
    category: 'system', event, severity, title, body, entityType: 'system', entityId: null,
    permissions: ['system.logs'], dedupe, count: 0,
  };
  item.count += 1;
  pendingSystem.set(dedupe, item);
  if (!systemTimer) systemTimer = setTimeout(() => flushSystem().catch((e) => warn('system flush', e)), 10_000);
};

module.exports = {
  CATEGORIES,
  CATEGORY_KEYS,
  listNotifications,
  getSummary,
  markRead: stateHandler('read_at'),
  dismiss: stateHandler('dismissed_at'),
  markUnread,
  markAllRead,
  getPreferences,
  updatePreferences,
  getPolicy,
  updatePolicy,
  notify,
  attachSocket,
  refreshSockets,
  startListener,
  startClock,
  systemEvent,
  checkIssues,
  // tests
  canSee,
  viewerOf,
};
