const pool = require('../config/db');
const service = require('./service');
const approvals = require('../admin/approvals');
const { recordAdminAudit } = require('../middleware/adminAccess');

// =====================================================
// COMPANY BANK ACCOUNTS - HTTP layer (phase 50)
// Routes are registered in routes/adminRoutes.js (/api/admin/...):
//   GET   /company-accounts                         view
//   GET   /company-accounts/:id                     view (+ history)
//   POST  /company-accounts                         manage   add (inactive)
//   PATCH /company-accounts/:id                     manage   edit permitted fields
//   POST  /company-accounts/:id/deactivate          manage
//   POST  /company-accounts/:id/archive             manage
//   POST  /company-accounts/:id/activate            manage + Super Admin *
//   PUT   /company-accounts/defaults/:purpose       manage + Super Admin *
//   PUT   /company-accounts/funding/:methodKey      manage + Super Admin *
//   PATCH /company-accounts/:id/integration         manage + Super Admin *
//   POST  /company-accounts/:id/authorization       manage + Super Admin *
//   POST  /company-accounts/:id/integration-approval  approvals.decide (Super Admin)
//   POST  /company-accounts/:id/reveal              company_accounts.reveal (Super Admin)
// * The Super Admin does it directly with { confirmLast4, reason }.
//   Anyone else with company_accounts.manage gets every check run, then
//   202 APPROVAL_REQUIRED: an approval request (company_account.change)
//   the Super Admin approves in Approvals, which runs the same handler
//   for the requester. Nothing changes until then.
// Successful changes write their own masked audit rows (the generic
// audit middleware is skipped for them); refusals are still logged by it.
// =====================================================

const ACTION_TYPE = 'company_account.change';

const ctxOf = (req) => ({
  admin: req.admin,
  ip: req.ip || null,
  approval: req.approvalRequest ? { id: req.approvalRequest.id, approvedBy: req.approvalRequest.approvedBy } : null,
});

const sendError = (res, error, fallback) => {
  if (!error?.status) console.error(`❌ ${fallback}:`, error?.message || error);
  return res.status(error?.status || 500).json({
    success: false,
    code: error?.code,
    field: error?.field,
    reasons: error?.reasons,
    usage: error?.usage,
    message: error?.status ? error.message : fallback,
  });
};

const handle = (fallback, run, { status = 200 } = {}) => async (req, res) => {
  try {
    const result = await run(req, ctxOf(req));
    // The service wrote the audit row itself (masked)
    if (req.method !== 'GET') res.locals.skipAudit = true;
    return res.status(status).json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, fallback);
  }
};

// ---------------------------------------------------
// Super Admin gate for real-money-affecting changes
// ---------------------------------------------------

// What an approval request stores (no account number, no confirmation)
const PAYLOAD_FIELDS = ['accountId', 'provider', 'bankReference', 'status', 'reference', 'date', 'reason'];

const GATED = {
  activate: { params: (req) => ({ id: req.params.id }), run: (req, ctx) => service.activate(req.params.id, req.body || {}, ctx) },
  default: { params: (req) => ({ purpose: req.params.purpose }), run: (req, ctx) => service.setDefault(req.params.purpose, req.body || {}, ctx) },
  funding: { params: (req) => ({ methodKey: req.params.methodKey }), run: (req, ctx) => service.setFunding(req.params.methodKey, req.body || {}, ctx) },
  integration: { params: (req) => ({ id: req.params.id }), run: (req, ctx) => service.setIntegration(req.params.id, req.body || {}, ctx) },
  authorization: { params: (req) => ({ id: req.params.id }), run: (req, ctx) => service.recordAuthorization(req.params.id, req.body || {}, ctx) },
};

const requestApproval = async (req, op, preview) => {
  const payload = { op, ...Object.fromEntries(PAYLOAD_FIELDS.filter((f) => req.body?.[f] !== undefined).map((f) => [f, req.body[f]])) };
  const summary = `${preview.summary}: ${String(req.body?.reason || '').trim()}`.slice(0, 300);
  let row;
  try {
    row = (
      await pool.query(
        `INSERT INTO admin_approval_requests (action_type, entity_type, entity_id, amount, summary, params, payload, requested_by)
         VALUES ($1, 'company_bank_account', $2, NULL, $3, $4, $5, $6) RETURNING id`,
        [ACTION_TYPE, String(preview.entityKey).slice(0, 40), summary, JSON.stringify(GATED[op].params(req)), JSON.stringify(payload), req.admin.adminId]
      )
    ).rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw Object.assign(new Error('This change is already waiting for the Super Admin. Wait for their decision.'), { status: 409, code: 'APPROVAL_PENDING' });
    }
    throw error;
  }

  // History on the account (append-only) + audit
  await pool.query(
    `INSERT INTO company_bank_account_events (account_id, action, actor_admin_id, actor_name, actor_role, approval_request_id, after_value, reason)
     VALUES ($1, 'approval.requested', $2, $3, $4, $5, $6, $7)`,
    [preview.accountId, req.admin.adminId, req.admin.fullName || null, req.admin.role || null, row.id, JSON.stringify({ request: op }), String(req.body?.reason || '').slice(0, 300)]
  );
  recordAdminAudit({
    admin: req.admin,
    action: 'approval.request',
    entityType: 'approval',
    entityId: row.id,
    summary: `Asked for Super Admin approval: ${summary}`,
    details: payload,
    ip: req.ip,
  });
  try {
    require('../realtime').emitToAdmins(req.app.get('io'), 'admin:approvals-updated', { id: Number(row.id) });
  } catch {
    // best effort
  }
  const approval = approvals.toApproval(
    (
      await pool.query(
        `SELECT r.*, a.full_name AS requested_by_name, NULL::text AS decided_by_name FROM admin_approval_requests r
         LEFT JOIN admins a ON a.id = r.requested_by WHERE r.id = $1`,
        [row.id]
      )
    ).rows[0]
  );
  return approval;
};

const gated = (op, fallback) => async (req, res) => {
  const ctx = ctxOf(req);
  try {
    // The Super Admin (with confirmation) or an approved request
    if (req.approvalRequest || req.admin?.role === 'owner') {
      const result = await GATED[op].run(req, ctx);
      res.locals.skipAudit = true;
      return res.json({ success: true, ...result });
    }
    // Everyone else: every check now (nothing is kept), then a request
    const preview = await GATED[op].run(req, { ...ctx, dryRun: true });
    const approval = await requestApproval(req, op, preview);
    res.locals.skipAudit = true;
    return res.status(202).json({
      success: true,
      code: 'APPROVAL_REQUIRED',
      message: 'Sent to the Super Admin for approval. Nothing has changed yet.',
      approval,
    });
  } catch (error) {
    return sendError(res, error, fallback);
  }
};

// Runs an approved company_account.change request (src/admin/approvals.js)
const approvedHandler = async (req, res) => {
  const op = String(req.body?.op || '');
  if (!GATED[op]) return res.status(400).json({ success: false, message: 'Unknown company account change' });
  return gated(op, 'Unable to make the company account change')(req, res);
};

approvals.register(ACTION_TYPE, approvedHandler);

module.exports = {
  ACTION_TYPE,
  list: handle('Unable to load company bank accounts', (req) => service.list(req.query || {})),
  get: handle('Unable to load the company bank account', (req) => service.get(req.params.id)),
  create: handle('Unable to add the company bank account', (req, ctx) => service.create(req.body || {}, ctx), { status: 201 }),
  update: handle('Unable to save the company bank account', (req, ctx) => service.update(req.params.id, req.body || {}, ctx)),
  deactivate: handle('Unable to deactivate the account', (req, ctx) => service.deactivate(req.params.id, req.body || {}, ctx)),
  archive: handle('Unable to archive the account', (req, ctx) => service.archive(req.params.id, req.body || {}, ctx)),
  activate: gated('activate', 'Unable to activate the account'),
  setDefault: gated('default', 'Unable to change the default account'),
  setFunding: gated('funding', 'Unable to change the funding account'),
  setIntegration: gated('integration', 'Unable to change the provider link'),
  recordAuthorization: gated('authorization', 'Unable to record the bank authorisation'),
  approveIntegration: handle('Unable to record the approval', (req, ctx) => service.approveIntegration(req.params.id, req.body || {}, ctx)),
  reveal: async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return handle('Unable to show the account number', (r, ctx) => service.reveal(r.params.id, r.body || {}, ctx))(req, res);
  },
};
