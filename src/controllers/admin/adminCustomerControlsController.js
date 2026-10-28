const pool = require('../../config/db');

const { adminCan } = require('../../middleware/adminAccess');
const controls = require('../../customers/accountControls');

// =====================================================
// CUSTOMER ACCOUNT CONTROLS (phase 44) - admin API
//   PATCH /customers/:id/status { status, reason }      customers.manage
//   PATCH /customers/:id/cod-limit { codLimit|null }    customers.manage
//   GET   /customers/:id/risk                           customers.view
//   GET   /customer-controls/settings                   customers.view
//   PUT   /customer-controls/settings                   customers.manage
//         (credit_approval_limit + support_report_window_hours: the
//          Super Admin only - security.settings)
// Every change is audited (adminAccess AUDITED + before / after).
// =====================================================

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const toControls = (row) => ({
  status: row.account_status,
  statusLabel: controls.STATUS_LABELS[row.account_status] || row.account_status,
  reason: row.status_reason || null,
  changedAt: row.status_changed_at || null,
  changedBy: row.status_changed_by != null ? { id: Number(row.status_changed_by), name: row.changed_by_name || null } : null,
  codLimit: row.cod_limit != null ? round2(row.cod_limit) : null,
});

const loadRow = async (client, id, lock = false) =>
  (
    await client.query(
      `SELECT c.id, c.full_name, c.account_status, c.status_reason, c.status_changed_at, c.status_changed_by, c.cod_limit,
              a.full_name AS changed_by_name
       FROM customers c LEFT JOIN admins a ON a.id = c.status_changed_by
       WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`,
      [id]
    )
  ).rows[0];

// Live effect on the customer's open sockets: a blocked account is
// told and disconnected (bin/www refuses new connections)
const pushToCustomer = (io, customerId, status) => {
  try {
    if (!io) return;
    io.to(`customer:${customerId}`).emit('account-status-changed', { status });
    if (status === 'blocked') {
      io.to(`customer:${customerId}`).emit('account-blocked', { code: 'ACCOUNT_BLOCKED', message: controls.BLOCKED_MESSAGE });
      setTimeout(() => io.in(`customer:${customerId}`).disconnectSockets(true), 300);
    }
  } catch (error) {
    console.error('❌ customer status push error:', error.message);
  }
};

// PATCH /customers/:id/status { status, reason }
const setStatus = async (req, res) => {
  const id = toId(req.params.id);
  const status = String(req.body?.status || '').trim();
  const reason = String(req.body?.reason || '').trim();

  if (!id) return res.status(400).json({ success: false, message: 'Invalid customer ID' });
  if (!controls.STATUSES.includes(status)) {
    return res.status(400).json({ success: false, code: 'INVALID_STATUS', message: 'Choose active, restricted or blocked' });
  }
  if (status !== 'active' && reason.length < 5) {
    return res.status(400).json({ success: false, code: 'REASON_REQUIRED', message: 'Enter a reason (at least 5 characters)' });
  }
  if (reason.length > 300) {
    return res.status(400).json({ success: false, code: 'REASON_TOO_LONG', message: 'Keep the reason under 300 characters' });
  }

  const client = await pool.connect();
  let before;
  let after;

  try {
    await client.query('BEGIN');
    before = await loadRow(client, id, true);

    if (!before) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }

    if (before.account_status === status) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'NO_CHANGE', message: `This customer is already ${controls.STATUS_LABELS[status].toLowerCase()}` });
    }

    await client.query(
      `UPDATE customers SET account_status = $2, status_reason = $3, status_changed_at = NOW(), status_changed_by = $4 WHERE id = $1`,
      [id, status, reason || null, req.admin?.adminId || null]
    );
    after = await loadRow(client, id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ admin setCustomerStatus error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to change the account status' });
  } finally {
    client.release();
  }

  res.locals.audit = {
    summary: `Account ${controls.STATUS_LABELS[before.account_status]} -> ${controls.STATUS_LABELS[status]}${reason ? `: ${reason.slice(0, 150)}` : ''}`,
    before: { status: before.account_status, reason: before.status_reason },
    after: { status: after.account_status, reason: after.status_reason },
  };

  pushToCustomer(req.app.get('io'), id, status);

  await controls.notifyStatusChange({
    customerId: id,
    fullName: before.full_name,
    from: before.account_status,
    to: status,
    adminId: req.admin?.adminId,
    adminName: req.admin?.fullName,
    logId: new Date(after.status_changed_at).getTime(),
  });

  return res.json({ success: true, message: `Account set to ${controls.STATUS_LABELS[status].toLowerCase()}`, controls: toControls(after) });
};

// PATCH /customers/:id/cod-limit { codLimit: number | null }
const setCodLimit = async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid customer ID' });

  const raw = req.body?.codLimit;
  const value = raw === null || raw === '' ? null : Number(raw);

  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1000000)) {
    return res.status(400).json({ success: false, code: 'INVALID_LIMIT', message: 'Enter a limit between Rs 0 and Rs 1,000,000, or clear it to use the default' });
  }

  const before = (await pool.query('SELECT cod_limit FROM customers WHERE id = $1', [id])).rows[0];
  if (!before) return res.status(404).json({ success: false, message: 'Customer not found' });

  await pool.query('UPDATE customers SET cod_limit = $2 WHERE id = $1', [id, value === null ? null : round2(value)]);
  const row = await loadRow(pool, id);

  const show = (v) => (v == null ? 'platform default' : `Rs ${round2(v).toFixed(2)}`);
  res.locals.audit = {
    summary: `Cash-on-delivery limit ${show(before.cod_limit)} -> ${show(value)}`,
    before: { codLimit: before.cod_limit != null ? round2(before.cod_limit) : null },
    after: { codLimit: value === null ? null : round2(value) },
  };

  const effective = await controls.controlsFor(id);
  return res.json({ success: true, message: 'Cash-on-delivery limit saved', controls: toControls(row), effectiveCodLimit: effective.codLimit, codLimitSource: effective.codLimitSource });
};

// GET /customers/:id/risk
const getRisk = async (req, res) => {
  const id = toId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid customer ID' });

  try {
    const risk = await controls.riskFor(id);
    if (!risk) return res.status(404).json({ success: false, message: 'Customer not found' });
    return res.json({ success: true, risk });
  } catch (error) {
    console.error('❌ admin getCustomerRisk error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load risk indicators' });
  }
};

// GET /customer-controls/settings
const getSettings = async (req, res) => {
  const settings = await controls.getSettings();
  return res.json({
    success: true,
    settings,
    can: {
      editCodLimit: adminCan(req, 'customers.manage'),
      editSuperAdmin: adminCan(req, 'security.settings'),
    },
  });
};

// PUT /customer-controls/settings { defaultCodLimit?, creditApprovalLimit?, supportReportWindowHours? }
const updateSettings = async (req, res) => {
  const body = req.body || {};
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const superFields = ['creditApprovalLimit', 'supportReportWindowHours'].filter(has);

  if (superFields.length && !adminCan(req, 'security.settings')) {
    return res.status(403).json({
      success: false,
      code: 'PERMISSION_DENIED',
      permission: 'security.settings',
      message: 'Only the Super Admin can change the credit approval limit and the report window.',
    });
  }

  const sets = [];
  const values = [];
  const add = (column, value) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (has('defaultCodLimit')) {
    const value = body.defaultCodLimit === null || body.defaultCodLimit === '' ? null : Number(body.defaultCodLimit);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1000000)) {
      return res.status(400).json({ success: false, code: 'INVALID_LIMIT', message: 'Enter a default limit between Rs 0 and Rs 1,000,000, or clear it for no limit' });
    }
    add('default_cod_limit', value === null ? null : round2(value));
  }
  if (has('creditApprovalLimit')) {
    const value = Number(body.creditApprovalLimit);
    if (!Number.isFinite(value) || value < 0 || value > 1000000) {
      return res.status(400).json({ success: false, message: 'Enter a credit approval limit between Rs 0 and Rs 1,000,000' });
    }
    add('credit_approval_limit', round2(value));
  }
  if (has('supportReportWindowHours')) {
    const value = Number(body.supportReportWindowHours);
    if (!Number.isInteger(value) || value < 1 || value > 720) {
      return res.status(400).json({ success: false, message: 'The report window must be 1-720 hours' });
    }
    add('support_report_window_hours', value);
  }

  if (!sets.length) return res.status(400).json({ success: false, message: 'Nothing to change' });

  const before = await controls.getSettings();
  add('updated_by', req.admin?.adminId || null);
  await pool.query(`UPDATE customer_controls_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1`, values);
  const after = await controls.getSettings();

  const pick = (s) => ({ defaultCodLimit: s.defaultCodLimit, creditApprovalLimit: s.creditApprovalLimit, supportReportWindowHours: s.supportReportWindowHours });
  res.locals.audit = { before: pick(before), after: pick(after) };

  return res.json({ success: true, message: 'Customer settings saved', settings: after });
};

module.exports = { setStatus, setCodLimit, getRisk, getSettings, updateSettings, toControls };
