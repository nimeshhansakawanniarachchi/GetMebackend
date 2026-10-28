const pool = require('../config/db');
const { recordAdminAudit, adminCan } = require('../middleware/adminAccess');
const { effectivePermissions } = require('./permissions');

// =====================================================
// SUPER ADMIN APPROVAL FOR HIGH-RISK MONEY ACTIONS (phase 40)
//
// requireApproval(type) sits in front of a money route. When the
// amount is above the limit (admin_security_settings) and the admin is
// not the Super Admin, nothing is done: an approval request is stored
// (202 APPROVAL_REQUIRED). When the Super Admin approves it, the SAME
// route handler runs with the stored request, acting for the staff
// member who asked (they must still be active and still hold the
// permission), so every normal check runs again. A request can't be
// approved by the person who made it, and one action + record can only
// have one open request.
//   GET   /api/admin/approvals?status=pending|mine|all
//   PATCH /api/admin/approvals/:id { decision: approve|reject, note }
//   POST  /api/admin/approvals/:id/cancel   (the requester)
// =====================================================

const round2 = (value) => Math.round(Number(value) * 100) / 100;

// action type -> what it is, the amount, the limit, the permission the
// requester needs, and the handler (set by adminRoutes via register)
const TYPES = {
  'order.refund': {
    label: 'Customer refund',
    entityType: 'order',
    permission: 'finance.refund',
    limitColumn: 'refund_approval_limit',
    amountOf: (req) => Math.abs(Number(req.body?.amount) || 0),
    entityOf: (req) => req.params.id,
    describe: (req) => `Refund Rs ${round2(req.body?.amount || 0).toFixed(2)} on order #${req.params.id}: ${String(req.body?.reason || '').slice(0, 120)}`,
    // Fields the handler reads (nothing else is stored)
    fields: ['amount', 'reason', 'reasonCode', 'note', 'requestId'],
  },
  'earnings.adjust': {
    label: 'Shopper earnings adjustment',
    entityType: 'order',
    permission: 'finance.adjust',
    limitColumn: 'earnings_adjust_approval_limit',
    amountOf: (req) => Math.abs(Number(req.body?.amount) || 0),
    entityOf: (req) => req.params.orderId,
    describe: (req) => `Adjust shopper earnings on order #${req.params.orderId} by Rs ${round2(req.body?.amount || 0).toFixed(2)}: ${String(req.body?.note || '').slice(0, 120)}`,
    fields: ['amount', 'note'],
  },
  // Phase 43: GetMe credit from a support case or straight to a customer.
  // The limit is customer_controls_settings.credit_approval_limit; the
  // route sets body.target ('case' | 'customer'), so the handler knows
  // which one it is when it runs after approval.
  'customer.credit': {
    label: 'GetMe credit',
    entityTypeOf: (req) => (req.body?.target === 'case' ? 'support_case' : 'customer'),
    permission: 'support.credit',
    limitOf: async () => {
      const row = (await pool.query('SELECT credit_approval_limit FROM customer_controls_settings WHERE id = 1')).rows[0];
      return Number(row?.credit_approval_limit ?? 5000);
    },
    amountOf: (req) => Math.abs(Number(req.body?.amount) || 0),
    entityOf: (req) => req.params.id,
    describe: (req) =>
      `GetMe credit Rs ${round2(req.body?.amount || 0).toFixed(2)} ${req.body?.target === 'case' ? `on support case #${req.params.id}` : `to customer #${req.params.id}`}: ${String(req.body?.note || req.body?.reason || '').slice(0, 120)}`,
    fields: ['amount', 'note', 'reason', 'requestId', 'target'],
  },
  // Phase 43: card refund that resolves a support case. Same limit and
  // permission as an order refund (refund_approval_limit, finance.refund);
  // a separate type so the approved request resolves the case too.
  'support.refund': {
    label: 'Customer refund (support case)',
    entityType: 'support_case',
    permission: 'finance.refund',
    limitColumn: 'refund_approval_limit',
    amountOf: (req) => Math.abs(Number(req.body?.amount) || 0),
    entityOf: (req) => req.params.id,
    describe: (req) => `Refund Rs ${round2(req.body?.amount || 0).toFixed(2)} to the card for support case #${req.params.id}: ${String(req.body?.note || '').slice(0, 120)}`,
    fields: ['amount', 'note'],
  },
};

const handlers = {};
const register = (type, handler) => {
  handlers[type] = handler;
};

const limits = async () => (await pool.query('SELECT * FROM admin_security_settings WHERE id = 1')).rows[0];

const toApproval = (row) =>
  row
    ? {
        id: Number(row.id),
        actionType: row.action_type,
        actionLabel: TYPES[row.action_type]?.label || row.action_type,
        entityType: row.entity_type,
        entityId: row.entity_id,
        amount: row.amount != null ? round2(row.amount) : null,
        summary: row.summary,
        payload: row.payload,
        status: row.status,
        requestedBy: { id: Number(row.requested_by), name: row.requested_by_name || null },
        requestedAt: row.requested_at,
        decidedBy: row.decided_by ? { id: Number(row.decided_by), name: row.decided_by_name || null } : null,
        decidedAt: row.decided_at,
        decisionNote: row.decision_note,
        resultStatus: row.result_status,
        resultMessage: row.result_message,
      }
    : null;

const SELECT = `
  SELECT r.*, a.full_name AS requested_by_name, d.full_name AS decided_by_name
  FROM admin_approval_requests r
  LEFT JOIN admins a ON a.id = r.requested_by
  LEFT JOIN admins d ON d.id = r.decided_by
`;

// Route middleware
const requireApproval = (type) => async (req, res, next) => {
  const spec = TYPES[type];
  // The Super Admin acts directly; an approved request being carried out
  // passes too
  if (req.admin?.role === 'owner' || req.approvalRequest) return next();

  try {
    const amount = spec.amountOf(req);
    const limit = spec.limitOf ? await spec.limitOf() : Number((await limits())[spec.limitColumn]);
    if (amount <= limit) return next();

    const payload = Object.fromEntries(spec.fields.filter((f) => req.body?.[f] !== undefined).map((f) => [f, req.body[f]]));
    let row;

    try {
      row = (
        await pool.query(
          `INSERT INTO admin_approval_requests (action_type, entity_type, entity_id, amount, summary, params, payload, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [type, spec.entityTypeOf ? spec.entityTypeOf(req) : spec.entityType, String(spec.entityOf(req)), round2(amount), spec.describe(req).slice(0, 300), JSON.stringify(req.params || {}), JSON.stringify(payload), req.admin.adminId]
        )
      ).rows[0];
    } catch (error) {
      if (error.code === '23505') {
        return res.status(409).json({ success: false, code: 'APPROVAL_PENDING', message: 'This is already waiting for the Super Admin. Wait for their decision.' });
      }
      throw error;
    }

    const approval = toApproval((await pool.query(`${SELECT} WHERE r.id = $1`, [row.id])).rows[0]);

    recordAdminAudit({
      admin: req.admin,
      action: 'approval.request',
      entityType: 'approval',
      entityId: approval.id,
      summary: `Asked for Super Admin approval: ${approval.summary} (limit Rs ${limit.toFixed(2)})`,
      details: payload,
      ip: req.ip,
    });

    try {
      require('../realtime').emitToAdmins(req.app.get('io'), 'admin:approvals-updated', { id: approval.id });
    } catch {
      // best effort
    }

    return res.status(202).json({
      success: true,
      code: 'APPROVAL_REQUIRED',
      message: `Rs ${round2(amount).toFixed(2)} is above the Rs ${limit.toFixed(2)} limit, so it was sent to the Super Admin for approval. Nothing has been done yet.`,
      approval,
    });
  } catch (error) {
    console.error('❌ approval gate error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to check the approval limit' });
  }
};

const listApprovals = async (req, res) => {
  const status = String(req.query.status || 'pending');
  const decider = adminCan(req, 'approvals.decide');
  const where = [];
  const params = [];

  if (status === 'pending') where.push("r.status = 'pending'");
  // Staff see only their own requests
  if (!decider || status === 'mine') {
    params.push(req.admin.adminId);
    where.push(`r.requested_by = $${params.length}`);
  }

  const rows = (await pool.query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.requested_at DESC LIMIT 200`, params)).rows;
  const pending = decider ? Number((await pool.query("SELECT COUNT(*) FROM admin_approval_requests WHERE status = 'pending'")).rows[0].count) : null;
  return res.json({ success: true, approvals: rows.map(toApproval), pendingCount: pending });
};

// Runs the stored request through the route handler, as the requester
const execute = async (row, decider, app) => {
  const handler = handlers[row.action_type];
  if (!handler) return { status: 500, body: { message: 'No handler for this action' } };

  const requester = (await pool.query('SELECT * FROM admins WHERE id = $1', [row.requested_by])).rows[0];
  if (!requester?.is_active) return { status: 409, body: { message: 'The staff member who asked is no longer active' } };

  const permissions = new Set(effectivePermissions(requester));
  if (!permissions.has(TYPES[row.action_type].permission)) {
    return { status: 409, body: { message: 'The staff member who asked no longer has this permission' } };
  }

  const req = {
    method: 'PATCH',
    params: row.params || {},
    body: row.payload || {},
    query: {},
    headers: {},
    ip: null,
    app,
    admin: { adminId: requester.id, fullName: requester.full_name, email: requester.email, role: requester.role, permissions },
    approvalRequest: { id: Number(row.id), approvedBy: decider.adminId },
  };

  const res = {
    statusCode: 200,
    body: null,
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    set() {
      return this;
    },
    setHeader() {},
  };

  await handler(req, res);
  return { status: res.statusCode, body: res.body || {} };
};

const decide = async (req, res) => {
  const id = Number(req.params.id);
  const decision = String(req.body?.decision || '');
  const note = String(req.body?.note || '').trim().slice(0, 300);

  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ success: false, message: 'Choose approve or reject' });
  if (decision === 'reject' && note.length < 3) return res.status(400).json({ success: false, message: 'Say why it is rejected' });

  const client = await pool.connect();
  let row;

  try {
    await client.query('BEGIN');
    row = (await client.query('SELECT * FROM admin_approval_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];

    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Approval request not found' });
    }
    if (row.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'ALREADY_DECIDED', message: `This request is already ${row.status}` });
    }
    if (Number(row.requested_by) === Number(req.admin.adminId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, code: 'SELF_APPROVAL', message: "You can't approve your own request" });
    }

    // Claim it first so a second click can't run it twice
    await client.query(
      "UPDATE admin_approval_requests SET status = $2, decided_by = $3, decided_at = NOW(), decision_note = $4 WHERE id = $1",
      [id, decision === 'approve' ? 'approved' : 'rejected', req.admin.adminId, note || null]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ approval decide error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to record the decision' });
  } finally {
    client.release();
  }

  let result = null;

  if (decision === 'approve') {
    try {
      result = await execute(row, req.admin, req.app);
    } catch (error) {
      console.error('❌ approval execute error:', error.message);
      result = { status: 500, body: { message: 'The action failed' } };
    }

    const ok = result.status < 400;
    await pool.query(
      'UPDATE admin_approval_requests SET status = $2, result_status = $3, result_message = $4 WHERE id = $1',
      [id, ok ? 'approved' : 'failed', result.status, String(result.body?.message || (ok ? 'Done' : 'Failed')).slice(0, 300)]
    );

    recordAdminAudit({
      admin: req.admin,
      action: ok ? 'approval.approved' : 'approval.failed',
      entityType: 'approval',
      entityId: id,
      summary: `${ok ? 'Approved and carried out' : 'Approved but it failed'}: ${row.summary}${ok ? '' : ` (${result.body?.message || result.status})`}`,
      outcome: ok ? 'success' : 'failed',
      before: { status: 'pending' },
      after: { status: ok ? 'approved' : 'failed', resultStatus: result.status },
      ip: req.ip,
    });
  }

  res.locals.audit = decision === 'reject' ? { action: 'approval.rejected', entityType: 'approval', entityId: id, summary: `Rejected: ${row.summary}`, before: { status: 'pending' }, after: { status: 'rejected' } } : { action: 'approval.decide', entityType: 'approval', entityId: id };

  const fresh = toApproval((await pool.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0]);
  return res.json({
    success: true,
    message: decision === 'reject' ? 'Rejected. Nothing was done.' : result.status < 400 ? 'Approved and carried out.' : `Approved, but the action failed: ${result.body?.message || result.status}`,
    approval: fresh,
    result: result ? { status: result.status, message: result.body?.message || null } : null,
  });
};

const cancel = async (req, res) => {
  const row = (
    await pool.query(
      "UPDATE admin_approval_requests SET status = 'cancelled', decided_at = NOW(), decision_note = 'Cancelled by the requester' WHERE id = $1 AND requested_by = $2 AND status = 'pending' RETURNING id",
      [Number(req.params.id), req.admin.adminId]
    )
  ).rows[0];

  if (!row) return res.status(409).json({ success: false, message: 'Only your own pending request can be cancelled' });
  res.locals.audit = { action: 'approval.cancel', entityType: 'approval', entityId: row.id, summary: 'Cancelled own approval request' };
  return res.json({ success: true, message: 'Cancelled' });
};

module.exports = { TYPES, register, requireApproval, listApprovals, decide, cancel, toApproval };
