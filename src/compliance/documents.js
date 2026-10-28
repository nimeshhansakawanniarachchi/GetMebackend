const pool = require('../config/db');
const { FINISHED_STATUSES } = require('../utils/orderStatus');
const { emitToAdmins } = require('../realtime');

// =====================================================
// SHOPPER DOCUMENT EXPIRY (phase 46, 2026-10-29)
//
// Three dated documents on shoppers: driving licence (licence_expiry,
// since phase 34), vehicle revenue licence and vehicle insurance.
// Staff with shoppers.manage record / correct them on the Shopper
// detail page (audited + profile history). NULL = not recorded: never
// blocks, shown as "Not recorded" to staff.
//
// Rules
//   * Going online is refused (403 DOCUMENTS_EXPIRED) while a recorded
//     date is in the past (the existing LICENCE_EXPIRED check still
//     answers first for the driving licence). Dispatch skips these
//     shoppers (shopperDispatch.getEligibleShoppers).
//   * A minute check (admin notifications clock) sends each alert once
//     per shopper + document + threshold + expiry date
//     (shopper_compliance_alerts): 30 days (info), 14 days (warning),
//     3 days (warning), expired (critical) - to staff with
//     shoppers.view / shoppers.manage and to the shopper (Alerts tab).
//   * A shopper still online when a document expires is set offline at
//     the next check if they have no unfinished order; with one, staff
//     get a critical alert (and the shopper goes offline after it).
// Dates are compared in SQL (Asia/Colombo, see config/db.js).
// =====================================================

const DOCUMENTS = [
  { key: 'licence', column: 'licence_expiry', field: 'licenceExpiry', label: 'Driving licence', plain: 'driving licence' },
  { key: 'revenue_licence', column: 'revenue_licence_expiry', field: 'revenueLicenceExpiry', label: 'Revenue licence', plain: 'vehicle revenue licence' },
  { key: 'insurance', column: 'insurance_expiry', field: 'insuranceExpiry', label: 'Vehicle insurance', plain: 'vehicle insurance' },
];

const SEVERITY = { 30: 'info', 14: 'warning', 3: 'warning', expired: 'critical' };
const ADMIN_PERMISSIONS = ['shoppers.view', 'shoppers.manage'];

let ioRef = null;

// Columns for one shopper row: <key>_date ('YYYY-MM-DD') + <key>_days (days left)
const DOC_SQL = DOCUMENTS.map(
  (d) => `to_char(sh.${d.column}, 'YYYY-MM-DD') AS ${d.key}_date, (sh.${d.column} - CURRENT_DATE) AS ${d.key}_days`
).join(', ');

// Threshold an expiry falls in today (only the current one is sent:
// a date recorded 2 days before expiry gets the 3-day alert only)
const bucketOf = (days) => {
  if (days == null) return null;
  if (days < 0) return 'expired';
  if (days <= 3) return '3';
  if (days <= 14) return '14';
  if (days <= 30) return '30';
  return null;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const statusOf = (date, days) => {
  if (!date) return { status: 'not_recorded', statusLabel: 'Not recorded' };
  if (days < 0) return { status: 'expired', statusLabel: `Expired ${plural(-days, 'day')} ago` };
  if (days === 0) return { status: 'expiring', statusLabel: 'Expires today' };
  if (days <= 30) return { status: 'expiring', statusLabel: `Expires in ${plural(days, 'day')}` };
  return { status: 'valid', statusLabel: 'Valid' };
};

const documentsOf = (row) =>
  DOCUMENTS.map((d) => {
    const expiry = row[`${d.key}_date`] || null;
    const daysLeft = expiry == null ? null : Number(row[`${d.key}_days`]);
    return { key: d.key, label: d.label, field: d.field, expiry, daysLeft, ...statusOf(expiry, daysLeft) };
  });

const loadRow = async (client, shopperId, lock = false) =>
  (
    await client.query(
      `SELECT sh.id, sh.status, sh.approval_status,
              COALESCE(admin_short_name(sh.full_name), 'Shopper #' || sh.id) AS short_name,
              ${DOC_SQL}
       FROM shoppers sh WHERE sh.id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [Number(shopperId)]
    )
  ).rows[0] || null;

const joinNames = (names) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// The go-online refusal for expired documents (null when fine)
const expiredBlock = (docs) => {
  const expired = docs.filter((d) => d.status === 'expired');
  if (!expired.length) return null;
  const meta = expired.map((d) => DOCUMENTS.find((x) => x.key === d.key));
  return {
    code: 'DOCUMENTS_EXPIRED',
    message: `Your ${joinNames(meta.map((m, i) => `${m.plain} (expired ${expired[i].expiry})`))} ${expired.length === 1 ? 'has' : 'have'} expired. You can't go online until GetMe records the renewed ${expired.length === 1 ? 'document' : 'documents'}. Contact GetMe support.`,
    expiredDocuments: expired.map((d) => ({ key: d.key, label: d.label, expiry: d.expiry })),
  };
};

// POST /api/shopper/status { online }: documents, then the training quiz
const goOnlineBlock = async (shopperId) => {
  const row = await loadRow(pool, shopperId);
  if (!row) return null;
  const block = expiredBlock(documentsOf(row));
  if (block) return block;
  return require('./training').gateBlock(shopperId);
};

// -----------------------------------------------------
// The check (one shopper, inside the caller's transaction)
// Socket emits are queued and sent after COMMIT.
// -----------------------------------------------------

const shopperNotification = async (client, emits, shopperId, title, body) => {
  const row = (
    await client.query(
      `INSERT INTO shopper_notifications (shopper_id, type, title, body) VALUES ($1, 'documents', $2, $3) RETURNING *`,
      [shopperId, title, body]
    )
  ).rows[0];
  emits.push({
    room: `shopper:${shopperId}`,
    event: 'shopper-notification',
    payload: { id: row.id, type: row.type, title: row.title, body: row.body, orderId: null, read: false, readAt: null, createdAt: row.created_at },
  });
};

const adminNotify = (client, { event, severity, title, body, shopperId, dedupe }) =>
  client.query('SELECT admin_notify($1, $2, $3, $4, $5, $6, $7, $8, $9)', [
    'shoppers', event, severity, title, body, 'shopper', String(shopperId), ADMIN_PERMISSIONS, dedupe,
  ]);

const checkShopperTx = async (client, shopperId, emits) => {
  const result = { alerts: 0, wentOffline: false, onlineWithOrder: null };
  const row = await loadRow(client, shopperId, true);
  if (!row || row.approval_status !== 'approved') return result;
  const id = Number(row.id);
  const name = row.short_name;
  const docs = documentsOf(row);

  for (const doc of docs) {
    const bucket = bucketOf(doc.daysLeft);
    if (!bucket) continue;
    const inserted = await client.query(
      `INSERT INTO shopper_compliance_alerts (shopper_id, document, threshold, expiry_date)
       VALUES ($1, $2, $3, $4::date) ON CONFLICT DO NOTHING RETURNING shopper_id`,
      [id, doc.key, bucket, doc.expiry]
    );
    if (!inserted.rowCount) continue;
    result.alerts += 1;
    const meta = DOCUMENTS.find((d) => d.key === doc.key);
    const expired = bucket === 'expired';
    const when = doc.daysLeft === 0 ? 'today' : `in ${plural(doc.daysLeft, 'day')}`;

    await adminNotify(client, {
      event: expired ? 'shopper.document_expired' : 'shopper.document_expiring',
      severity: SEVERITY[bucket],
      title: expired ? `${meta.label} expired · ${name}` : `${meta.label} expires ${when} · ${name}`,
      body: expired
        ? `Expired on ${doc.expiry}. The shopper can't go online or get new batches until a renewed date is recorded on the shopper page.`
        : `Expiry date ${doc.expiry}. Ask the shopper for the renewed document and record the new date; once it passes they can't go online.`,
      shopperId: id,
      dedupe: `compliance:${id}:${doc.key}:${bucket}:${doc.expiry}`,
    });

    await shopperNotification(
      client, emits, id,
      expired ? `Your ${meta.plain} has expired` : `Your ${meta.plain} expires ${when}`,
      expired
        ? `It expired on ${doc.expiry}. You can't go online until GetMe records your renewed ${meta.plain}. Contact GetMe support with the renewed document.`
        : `It expires on ${doc.expiry}. Renew it in time and send the renewed document to GetMe support, or you won't be able to go online after that date.`
    );
  }

  const block = expiredBlock(docs);
  if (block && row.status === 'online') {
    const active = (
      await client.query(
        'SELECT id FROM orders WHERE shopper_id = $1 AND status <> ALL($2::text[]) ORDER BY id LIMIT 1',
        [id, FINISHED_STATUSES]
      )
    ).rows[0];
    const labels = joinNames(block.expiredDocuments.map((d) => d.label.toLowerCase()));

    if (!active) {
      await client.query("UPDATE shoppers SET status = 'offline', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'online'", [id]);
      result.wentOffline = true;
      await shopperNotification(client, emits, id, "You're offline: a document has expired", block.message);
      emits.push({ room: `shopper:${id}`, event: 'shopper-status-changed', payload: { status: 'offline', code: block.code, message: block.message } });
      emits.push({ room: 'admins', event: 'admin:shoppers-updated', payload: { shopperId: id, reason: 'status', status: 'offline' } });
    } else {
      result.onlineWithOrder = Number(active.id);
      await adminNotify(client, {
        event: 'shopper.online_documents_expired',
        severity: 'critical',
        title: `${name} is on order #${active.id} with an expired ${labels}`,
        body: 'The shopper is online with an unfinished order, so they were not set offline. Check the order; they go offline at the next check after it finishes.',
        shopperId: id,
        dedupe: `compliance:online:${id}:${active.id}:${block.expiredDocuments.map((d) => `${d.key}=${d.expiry}`).join(',')}`,
      });
    }
  }

  return result;
};

const sendEmits = (io, emits) => {
  if (!io) return;
  emits.forEach(({ room, event, payload }) => {
    try {
      if (room === 'admins') emitToAdmins(io, event, payload);
      else io.to(room).emit(event, payload);
    } catch (error) {
      console.warn('⚠️ compliance emit:', error.message);
    }
  });
};

// One shopper, own transaction (or the caller's client: emits then go
// to `emits` and the caller sends them after its COMMIT)
const checkShopper = async (shopperId, { io = ioRef } = {}) => {
  const client = await pool.connect();
  const emits = [];
  try {
    await client.query('BEGIN');
    const result = await checkShopperTx(client, shopperId, emits);
    await client.query('COMMIT');
    sendEmits(io, emits);
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

// Every approved shopper with a document due within 30 days or expired
// (shopperIds: only these - tests)
const runCheck = async ({ io = ioRef, shopperIds = null } = {}) => {
  const params = [];
  let only = '';
  if (Array.isArray(shopperIds)) {
    params.push(shopperIds.map(Number));
    only = 'AND id = ANY($1::int[])';
  }
  const due = await pool.query(
    `SELECT id FROM shoppers
     WHERE approval_status = 'approved' ${only}
       AND (${DOCUMENTS.map((d) => `${d.column} <= CURRENT_DATE + 30`).join(' OR ')})
     ORDER BY id LIMIT 2000`,
    params
  );
  const summary = { checked: 0, alerts: 0, wentOffline: [], onlineWithOrder: [] };
  for (const { id } of due.rows) {
    try {
      const result = await checkShopper(id, { io });
      summary.checked += 1;
      summary.alerts += result.alerts;
      if (result.wentOffline) summary.wentOffline.push(Number(id));
      if (result.onlineWithOrder) summary.onlineWithOrder.push(Number(id));
    } catch (error) {
      console.warn(`⚠️ compliance check shopper ${id}:`, error.message);
    }
  }
  return summary;
};

// bin/www: runs on the admin notifications minute clock
const startComplianceCheck = (io) => {
  ioRef = io;
  require('../admin/notifications').addClockCheck('shopper documents', () => runCheck({ io }));
};

// -----------------------------------------------------
// Admin API
// -----------------------------------------------------

const isId = (value) => /^\d{1,9}$/.test(String(value ?? ''));

// 'YYYY-MM-DD' (a real date, 2000-2100) | null to clear | undefined = unchanged
const parseDate = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  if (y < 2000 || y > 2100) return false;
  return text;
};

const complianceOf = async (shopperId) => {
  const row = await loadRow(pool, shopperId);
  if (!row) return null;
  const docs = documentsOf(row);
  const alerts = await pool.query(
    `SELECT document, threshold, to_char(expiry_date, 'YYYY-MM-DD') AS expiry, created_at
     FROM shopper_compliance_alerts WHERE shopper_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [Number(shopperId)]
  );
  return {
    documents: docs.map(({ field, ...doc }) => doc),
    blocked: expiredBlock(docs),
    alerts: alerts.rows.map((a) => ({
      document: a.document,
      documentLabel: DOCUMENTS.find((d) => d.key === a.document)?.label || a.document,
      threshold: a.threshold,
      expiry: a.expiry,
      at: a.created_at,
    })),
  };
};

// GET /api/admin/shoppers/:id/compliance (shoppers.view)
const getCompliance = async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid shopper' });
  try {
    const compliance = await complianceOf(req.params.id);
    if (!compliance) return res.status(404).json({ success: false, message: 'Shopper not found' });
    const training = await require('./training').statusFor(req.params.id, { withAttempts: true });
    return res.json({ success: true, ...compliance, training });
  } catch (error) {
    console.error('❌ compliance:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the shopper documents' });
  }
};

// PATCH /api/admin/shoppers/:id/documents
//   { licenceExpiry?, revenueLicenceExpiry?, insuranceExpiry? } 'YYYY-MM-DD' | null (shoppers.manage)
const updateDocuments = async (req, res) => {
  if (!isId(req.params.id)) return res.status(400).json({ success: false, message: 'Invalid shopper' });
  const body = req.body || {};
  const changes = [];
  for (const doc of DOCUMENTS) {
    const value = parseDate(body[doc.field]);
    if (value === false) {
      return res.status(400).json({ success: false, code: 'INVALID_DATE', field: doc.field, message: `${doc.label}: enter a date as YYYY-MM-DD` });
    }
    if (value !== undefined) changes.push({ doc, value });
  }
  if (!changes.length) return res.status(400).json({ success: false, code: 'NOTHING_TO_SAVE', message: 'No document dates were sent' });

  const client = await pool.connect();
  const emits = [];
  try {
    await client.query('BEGIN');
    const before = await loadRow(client, req.params.id, true);
    if (!before) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Shopper not found' });
    }
    const changed = changes.filter(({ doc, value }) => (before[`${doc.key}_date`] || null) !== value);
    for (const { doc, value } of changed) {
      await client.query(`UPDATE shoppers SET ${doc.column} = $2::date, updated_at = NOW() WHERE id = $1`, [before.id, value]);
      await client.query(
        `INSERT INTO shopper_profile_history (shopper_id, field, old_value, new_value, changed_by_type, changed_by_id)
         VALUES ($1, $2, $3, $4, 'admin', $5)`,
        [before.id, doc.column, before[`${doc.key}_date`] || null, value, req.admin?.adminId ?? null]
      );
    }
    // Alerts / offline for the new dates straight away (same rules as the clock)
    const check = changed.length ? await checkShopperTx(client, before.id, emits) : null;
    await client.query('COMMIT');
    sendEmits(req.app.get('io'), emits);
    if (changed.length) emitToAdmins(req.app.get('io'), 'admin:shoppers-updated', { shopperId: Number(before.id), reason: 'documents' });

    const pick = (row) => Object.fromEntries(changed.map(({ doc }) => [doc.field, row ? row[`${doc.key}_date`] || null : null]));
    const afterRow = Object.fromEntries(changed.map(({ doc, value }) => [doc.field, value]));
    res.locals.audit = {
      summary: changed.length
        ? `Document dates: ${changed.map(({ doc, value }) => `${doc.label} ${before[`${doc.key}_date`] || 'not recorded'} -> ${value || 'not recorded'}`).join('; ')}`.slice(0, 300)
        : 'Document dates unchanged',
      before: pick(before),
      after: afterRow,
    };

    return res.json({
      success: true,
      message: changed.length ? 'Document dates saved' : 'Nothing changed',
      wentOffline: Boolean(check?.wentOffline),
      ...(await complianceOf(before.id)),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ update documents:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to save the document dates' });
  } finally {
    client.release();
  }
};

module.exports = {
  DOCUMENTS,
  bucketOf,
  documentsOf,
  expiredBlock,
  goOnlineBlock,
  checkShopper,
  runCheck,
  startComplianceCheck,
  getCompliance,
  updateDocuments,
};
