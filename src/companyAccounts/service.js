const pool = require('../config/db');
const vault = require('./vault');
const payoutVault = require('../wallet/accountVault');
const cat = require('./catalogue');
const integration = require('./integration');
const providers = require('../groceryPayments/providers');
const { recordAdminAudit } = require('../middleware/adminAccess');

const notifications = () => require('../admin/notifications');

// =====================================================
// COMPANY BANK ACCOUNTS (phase 50, sql/platform_phase50_company_bank_accounts.sql)
//
// GetMe's own bank accounts at one or more banks. RECORDS ONLY: nothing
// here connects to a bank, moves money, enables a payment method or
// initiates / authorises a payment. Account numbers are encrypted
// (vault.js, COMPANY_ACCOUNT_KEY); everything returned, logged or
// notified is masked (bank + last 4), except the Super Admin's audited
// reveal.
//
// Who (src/admin/permissions.js; routes in routes/adminRoutes.js):
//   company_accounts.view    list, details, history
//   company_accounts.manage  add, edit permitted fields, deactivate,
//                            archive; ASK for the changes below
//   Super Admin              activate, defaults per purpose, funding
//                            source, provider link, bank authorisation
//                            record: directly with a confirmation (last
//                            4 + reason) or by approving a Finance
//                            request (approval type company_account.change);
//                            test / production approval and revealing a
//                            full number: Super Admin only.
// Every change: company_bank_account_events (append-only, masked) +
// admin_audit_log (masked before / after). Critical admin notification
// on add, activation, funding source change and reveal.
// =====================================================

const { error, clean } = cat;

const REVEAL_LIMIT = 5;
const REVEAL_WINDOW_MINUTES = 15;

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const SELECT = `
  SELECT a.*, cb.full_name AS created_by_name, ub.full_name AS updated_by_name,
         ab.full_name AS approved_by_name, rb.full_name AS authorization_recorded_by_name
  FROM company_bank_accounts a
  LEFT JOIN admins cb ON cb.id = a.created_by
  LEFT JOIN admins ub ON ub.id = a.updated_by
  LEFT JOIN admins ab ON ab.id = a.approved_by
  LEFT JOIN admins rb ON rb.id = a.authorization_recorded_by
`;

const masked = (row) => `${row.bank_name} ••${row.account_last4}`;
const named = (row) => `${masked(row)} (${row.nickname})`;

// Masked snapshot for history + audit (no number, no hash). Key names
// avoid the audit sanitiser's secret patterns.
const snapshot = (row) =>
  row
    ? {
        label: row.nickname,
        bank: row.bank_name,
        last4: `••${row.account_last4}`,
        holder: row.account_holder_name,
        branch: row.branch_name,
        branchCode: row.branch_code,
        country: row.country,
        currency: row.currency,
        purposes: row.purposes,
        status: row.status,
        provider: row.integration_provider,
        providerReference: row.integration_reference,
        authorization: row.authorization_status,
        authorizationReference: row.authorization_reference,
        approval: row.approval_status,
      }
    : null;

// Only what changed
const diff = (before, after) => {
  const b = {};
  const a = {};
  Object.keys({ ...before, ...after }).forEach((key) => {
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) {
      b[key] = before?.[key] ?? null;
      a[key] = after?.[key] ?? null;
    }
  });
  return { before: b, after: a };
};

// ---------------------------------------------------
// Public shapes
// ---------------------------------------------------

const loadLinks = async (client = pool) => {
  // One query at a time (client may be a transaction client)
  const defaults = await client.query('SELECT purpose, account_id, set_at FROM company_bank_account_defaults');
  const funding = await client.query('SELECT method_key, account_id, set_at FROM company_bank_account_funding');
  return { defaults: defaults.rows, funding: funding.rows };
};

const toPublic = (row, links = { defaults: [], funding: [] }) => ({
  id: Number(row.id),
  nickname: row.nickname,
  bankKey: row.bank_key,
  bankName: row.bank_name,
  accountHolderName: row.account_holder_name,
  last4: row.account_last4,
  maskedNumber: `••${row.account_last4}`,
  displayLabel: integration.sourceLabel(row),
  branchName: row.branch_name,
  branchCode: row.branch_code,
  country: row.country,
  currency: row.currency,
  purposes: row.purposes || [],
  status: row.status,
  defaultFor: links.defaults.filter((d) => Number(d.account_id) === Number(row.id)).map((d) => d.purpose),
  fundingFor: links.funding.filter((f) => Number(f.account_id) === Number(row.id)).map((f) => f.method_key),
  integration: integration.integrationOf(row),
  activatedAt: row.activated_at,
  deactivatedAt: row.deactivated_at,
  archivedAt: row.archived_at,
  createdBy: row.created_by != null ? { id: Number(row.created_by), name: row.created_by_name || null } : null,
  updatedBy: row.updated_by != null ? { id: Number(row.updated_by), name: row.updated_by_name || null } : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toEvent = (row) => ({
  id: Number(row.id),
  accountId: row.account_id != null ? Number(row.account_id) : null,
  action: row.action,
  actor: row.actor_admin_id != null ? { id: Number(row.actor_admin_id), name: row.actor_name, role: row.actor_role } : null,
  approvalRequestId: row.approval_request_id != null ? Number(row.approval_request_id) : null,
  approvedBy: row.approved_by != null ? { id: Number(row.approved_by), name: row.approved_by_name || null } : null,
  before: row.before_value,
  after: row.after_value,
  reason: row.reason,
  at: row.created_at,
});

// ---------------------------------------------------
// Plumbing
// ---------------------------------------------------

// ctx: { admin, ip, approval?: { id, approvedBy }, dryRun? }
const tx = async (ctx, fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query(ctx.dryRun ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    // Database guards (triggers) -> a plain refusal
    if (caught.code === 'P0001') throw error(409, caught.message, 'REFUSED_BY_DATABASE');
    if (caught.code === '23505') throw error(409, 'This account number is already registered as a GetMe company account', 'DUPLICATE_ACCOUNT', { field: 'accountNumber' });
    throw caught;
  } finally {
    client.release();
  }
};

const lock = async (client, id) => {
  const accountId = toId(id);
  if (!accountId) throw error(400, 'Invalid account', 'INVALID_ID');
  const row = (await client.query('SELECT * FROM company_bank_accounts WHERE id = $1 FOR UPDATE', [accountId])).rows[0];
  if (!row) throw error(404, 'Company bank account not found', 'NOT_FOUND');
  return row;
};

const addEvent = async (client, ctx, { accountId, action, before = null, after = null, reason = null }) =>
  Number(
    (
      await client.query(
        `INSERT INTO company_bank_account_events
           (account_id, action, actor_admin_id, actor_name, actor_role, approval_request_id, approved_by, before_value, after_value, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          accountId,
          action,
          ctx.admin?.adminId ?? null,
          ctx.admin?.fullName ?? null,
          ctx.admin?.role ?? null,
          ctx.approval?.id ?? null,
          ctx.approval?.approvedBy ?? null,
          before ? JSON.stringify(before) : null,
          after ? JSON.stringify(after) : null,
          reason ? clean(reason, 300) : null,
        ]
      )
    ).rows[0].id
  );

const audit = (ctx, { action, entityId, summary, before = null, after = null, details = null }) =>
  recordAdminAudit({
    admin: ctx.admin,
    action,
    entityType: 'company_bank_account',
    entityId,
    summary: String(summary).slice(0, 300),
    before,
    after,
    ip: ctx.ip,
    details: { ...(details || {}), ...(ctx.approval ? { approvalRequestId: ctx.approval.id, approvedBy: ctx.approval.approvedBy } : {}) },
  });

const notify = (ctx, { event, title, body, accountId, dedupe }) =>
  notifications().notify({
    category: 'payments',
    event,
    severity: 'critical',
    title: String(title).slice(0, 200),
    body,
    entityType: 'company_bank_account',
    entityId: accountId,
    permissions: ['company_accounts.view'],
    dedupe,
    actorAdminId: ctx.admin?.adminId ?? null,
  });

// Reason + (unless an approved request is being carried out) the last 4
// of the account the change is about
const confirmFor = (ctx, input, row) => {
  const reason = clean(input?.reason, 300);
  if (reason.length < 5) throw error(400, 'Give a reason (at least 5 characters)', 'REASON_REQUIRED', { field: 'reason' });
  if (ctx.approval) return reason;
  const typed = String(input?.confirmLast4 ?? '').trim().toUpperCase();
  if (!typed) {
    throw error(400, `Type the last 4 characters of the account number (••${row.account_last4}) to confirm`, 'CONFIRMATION_REQUIRED', { field: 'confirmLast4' });
  }
  if (typed !== row.account_last4) throw error(400, "The last 4 characters don't match this account", 'CONFIRMATION_MISMATCH', { field: 'confirmLast4' });
  return reason;
};

const reasonOf = (input) => {
  const reason = clean(input?.reason, 300);
  if (reason.length < 5) throw error(400, 'Give a reason (at least 5 characters)', 'REASON_REQUIRED', { field: 'reason' });
  return reason;
};

// Where the account is used (deactivation / archive / purpose guard)
const usage = async (client, id) => {
  const defaults = await client.query('SELECT purpose FROM company_bank_account_defaults WHERE account_id = $1', [id]);
  const funding = await client.query('SELECT method_key FROM company_bank_account_funding WHERE account_id = $1', [id]);
  const open = await client.query("SELECT COUNT(*)::int AS n FROM grocery_payment_attempts WHERE funding_account_id = $1 AND status IN ('pending', 'unknown')", [id]);
  return { defaults: defaults.rows.map((r) => r.purpose), funding: funding.rows.map((r) => r.method_key), openAttempts: open.rows[0].n };
};

const inUseMessage = (use) => {
  const parts = [];
  if (use.funding.length) parts.push(`it pays ${use.funding.map((m) => integration.FUNDED_METHODS[m]?.label || m).join(', ')}`);
  if (use.defaults.length) parts.push(`it is the default for ${use.defaults.map((p) => cat.PURPOSE_LABELS[p] || p).join(', ')}`);
  if (use.openAttempts) parts.push(`${use.openAttempts} supermarket payment(s) from it are still open`);
  return parts.join('; ');
};

const fresh = async (id, client = pool) => {
  const row = (await client.query(`${SELECT} WHERE a.id = $1`, [id])).rows[0];
  return toPublic(row, await loadLinks(client));
};

// ---------------------------------------------------
// Read
// ---------------------------------------------------

const environment = () => {
  const server = providers.current();
  return {
    production: integration.isProduction(),
    keySource: vault.keySource(),
    serverProvider: { key: server.key, label: server.label, configured: server.configured, usable: server.usable, simulator: server.simulator, live: server.live, reason: server.reason },
  };
};

const providerCatalogue = () => {
  const production = integration.isProduction();
  return providers.registry().map((entry) => {
    const described = providers.describeKey(entry.key);
    return {
      key: entry.key,
      label: entry.label,
      testOnly: entry.testOnly,
      bankKeys: entry.bankKeys,
      transactionTypes: entry.transactionTypes,
      note: entry.note,
      implemented: Boolean(entry.transactionTypes[integration.TX]),
      configuredOnServer: Boolean(described.configured),
      selectable: !(entry.testOnly && production),
    };
  });
};

// Read-only summary of the OTHER money accounts (not managed here)
const otherAccounts = async () => {
  const counts = (
    await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM shopper_payout_accounts WHERE deleted_at IS NULL) AS shopper_accounts,
         (SELECT COUNT(*)::int FROM shop_lankaqr_merchants WHERE status = 'approved') AS merchant_qrs,
         (SELECT COUNT(*)::int FROM saved_cards) AS saved_cards,
         (SELECT COUNT(*)::int FROM getme_cards WHERE status <> 'retired') AS getme_cards`
    )
  ).rows[0];
  let payhereMode = null;
  try {
    payhereMode = require('../payments/payhere').getMode();
  } catch {
    payhereMode = null;
  }
  return {
    shopperPayoutAccounts: counts.shopper_accounts,
    merchantQrs: counts.merchant_qrs,
    savedCards: counts.saved_cards,
    getmeCards: counts.getme_cards,
    payhere: { mode: payhereMode || 'not configured' },
  };
};

const fundingView = async (links) =>
  Promise.all(
    Object.entries(integration.FUNDED_METHODS).map(async ([methodKey, method]) => {
      const f = await integration.fundingFor(methodKey);
      return {
        methodKey,
        methodLabel: method.label,
        purpose: method.purpose,
        accountId: f.account ? Number(f.account.id) : null,
        paymentSource: f.label,
        eligible: f.eligible,
        code: f.code,
        reasons: f.reasons,
        setAt: links.funding.find((x) => x.method_key === methodKey)?.set_at || null,
      };
    })
  );

// GET /api/admin/company-accounts?status=active|inactive|archived|all
const list = async (query = {}) => {
  const status = String(query.status || '');
  const where = ['active', 'inactive', 'archived'].includes(status) ? 'WHERE a.status = $1' : status === 'all' ? '' : "WHERE a.status <> 'archived'";
  const params = ['active', 'inactive', 'archived'].includes(status) ? [status] : [];
  const [rows, links, counts] = await Promise.all([
    pool.query(`${SELECT} ${where} ORDER BY (a.status = 'active') DESC, (a.status = 'archived'), a.id LIMIT 500`, params),
    loadLinks(),
    pool.query('SELECT status, COUNT(*)::int AS n FROM company_bank_accounts GROUP BY status'),
  ]);
  const approvals = require('../admin/approvals');
  const pending = (
    await pool.query(
      `SELECT r.*, a.full_name AS requested_by_name, NULL::text AS decided_by_name
       FROM admin_approval_requests r LEFT JOIN admins a ON a.id = r.requested_by
       WHERE r.action_type = 'company_account.change' AND r.status = 'pending' ORDER BY r.requested_at DESC`
    )
  ).rows.map(approvals.toApproval);

  return {
    accounts: rows.rows.map((row) => toPublic(row, links)),
    counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])),
    defaults: cat.PURPOSES.map((p) => ({ purpose: p.key, label: p.label, accountId: links.defaults.find((d) => d.purpose === p.key)?.account_id ?? null })),
    funding: await fundingView(links),
    pendingApprovals: pending,
    catalogue: {
      banks: [...cat.BANK_CATALOGUE, { key: 'other', name: 'Other (type the name)', country: null }],
      purposes: cat.PURPOSES,
      currencies: cat.COMMON_CURRENCIES,
      countries: cat.COMMON_COUNTRIES.map(([code, name]) => ({ code, name })),
      providers: providerCatalogue(),
    },
    environment: environment(),
    otherAccounts: await otherAccounts(),
  };
};

// GET /api/admin/company-accounts/:id
const get = async (id) => {
  const accountId = toId(id);
  if (!accountId) throw error(400, 'Invalid account', 'INVALID_ID');
  const row = (await pool.query(`${SELECT} WHERE a.id = $1`, [accountId])).rows[0];
  if (!row) throw error(404, 'Company bank account not found', 'NOT_FOUND');
  const events = (
    await pool.query(
      `SELECT e.*, ab.full_name AS approved_by_name FROM company_bank_account_events e
       LEFT JOIN admins ab ON ab.id = e.approved_by
       WHERE e.account_id = $1 ORDER BY e.id DESC LIMIT 200`,
      [accountId]
    )
  ).rows;
  const use = await usage(pool, accountId);
  return {
    account: toPublic(row, await loadLinks()),
    events: events.map(toEvent),
    usage: use,
    fundingEligibility: Object.keys(integration.FUNDED_METHODS).map((methodKey) => {
      const check = integration.eligibility(row, methodKey);
      return { methodKey, eligible: check.eligible, reasons: check.reasons };
    }),
  };
};

// ---------------------------------------------------
// Add / edit / deactivate / archive (company_accounts.manage)
// ---------------------------------------------------

// Shopper personal payout accounts never become company accounts
const matchesShopperAccount = async (client, number) => {
  let hash;
  try {
    hash = payoutVault.hashAccountNumber(number);
  } catch {
    const any = (await client.query('SELECT 1 FROM shopper_payout_accounts LIMIT 1')).rows.length > 0;
    if (any) throw error(503, "Can't check the number against shopper accounts (payout key missing)", 'PAYOUT_KEY_MISSING');
    return false;
  }
  return (await client.query('SELECT 1 FROM shopper_payout_accounts WHERE account_number_hash = $1 LIMIT 1', [hash])).rows.length > 0;
};

// POST /api/admin/company-accounts
const create = async (input = {}, ctx) => {
  const country = cat.parseCountry(input.country);
  const currency = cat.parseCurrency(input.currency);
  const { bankKey, bankName } = cat.parseBank(input.bankKey, input.bankName);
  if (bankKey !== 'other' && country !== 'LK') throw error(400, "That bank is in Sri Lanka: choose 'Other' for a bank in another country", 'INVALID_BANK', { field: 'bankKey' });
  const nickname = cat.parseNickname(input.nickname);
  const holder = cat.parseHolder(input.accountHolderName);
  const number = cat.normaliseNumber(input.accountNumber, country);
  const confirm = String(input.accountNumberConfirm ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (confirm !== number) throw error(400, "The account numbers don't match", 'ACCOUNT_NUMBER_MISMATCH', { field: 'accountNumberConfirm' });
  const branchName = cat.parseBranch(input.branchName, { required: country === 'LK' });
  const branchCode = cat.parseBranchCode(input.branchCode);
  const purposes = cat.parsePurposes(input.purposes);
  const hash = vault.hashAccountNumber(number);

  const result = await tx(ctx, async (client) => {
    // Serialise adds so two requests can't race past the duplicate check
    await client.query("SELECT pg_advisory_xact_lock(hashtext('company_bank_accounts.create'))");
    const existing = (await client.query("SELECT id, status FROM company_bank_accounts WHERE account_number_hash = $1 AND status <> 'archived'", [hash])).rows[0];
    if (existing) throw error(409, `This account number is already registered as a GetMe company account (#${existing.id})`, 'DUPLICATE_ACCOUNT', { field: 'accountNumber' });
    if (await matchesShopperAccount(client, number)) {
      throw error(409, "This number is a shopper's personal payout account. Company accounts must be GetMe's own accounts.", 'SHOPPER_ACCOUNT_NUMBER', { field: 'accountNumber' });
    }
    const archived = (await client.query("SELECT id FROM company_bank_accounts WHERE account_number_hash = $1 AND status = 'archived' ORDER BY id DESC LIMIT 1", [hash])).rows[0];

    const row = (
      await client.query(
        `INSERT INTO company_bank_accounts (
           nickname, bank_key, bank_name, account_holder_name, account_number_encrypted, account_last4, account_number_hash,
           branch_name, branch_code, country, currency, purposes, status, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'inactive', $13, $13)
         RETURNING *`,
        [nickname, bankKey, bankName, holder, vault.encryptAccountNumber(number), number.slice(-4), hash, branchName, branchCode, country, currency, purposes, ctx.admin?.adminId ?? null]
      )
    ).rows[0];
    await addEvent(client, ctx, {
      accountId: row.id,
      action: 'create',
      after: { ...snapshot(row), ...(archived ? { sameNumberAsArchived: Number(archived.id) } : {}) },
      reason: clean(input.reason, 300) || null,
    });
    return { row, archived };
  });

  const { row } = result;
  audit(ctx, { action: 'company_account.create', entityId: row.id, summary: `Added company bank account ${named(row)} · ${row.currency} · inactive`, after: snapshot(row) });
  notify(ctx, {
    event: 'company_account.created',
    title: `Company bank account added: ${masked(row)}`,
    body: `${row.nickname} · ${row.currency} · added by ${ctx.admin?.fullName || 'staff'}. Inactive until the Super Admin activates it. Nothing is connected to a bank.`,
    accountId: row.id,
    dedupe: `company_account.created:${row.id}`,
  });

  return {
    account: await fresh(row.id),
    message: `Added ${masked(row)} (inactive). It is a record only: nothing is connected to a bank, and activating it needs the Super Admin.${result.archived ? ` The same number was used by archived account #${result.archived.id}.` : ''}`,
  };
};

const IMMUTABLE = { accountNumber: 'account number', accountNumberConfirm: 'account number', bankKey: 'bank', currency: 'currency', country: 'country' };

// PATCH /api/admin/company-accounts/:id { nickname, accountHolderName, branchName, branchCode, purposes, bankName (other banks) }
const update = async (id, input = {}, ctx) => {
  const blocked = Object.keys(IMMUTABLE).find((key) => input[key] !== undefined);
  if (blocked) {
    throw error(400, `The ${IMMUTABLE[blocked]} of a company account can't be changed. Add a new account instead.`, 'IMMUTABLE_FIELD', { field: blocked });
  }

  const result = await tx(ctx, async (client) => {
    const before = await lock(client, id);
    if (before.status === 'archived') throw error(409, 'An archived account can no longer change', 'ARCHIVED');

    const next = {
      nickname: input.nickname !== undefined ? cat.parseNickname(input.nickname) : before.nickname,
      holder: input.accountHolderName !== undefined ? cat.parseHolder(input.accountHolderName) : before.account_holder_name,
      branchName: input.branchName !== undefined ? cat.parseBranch(input.branchName, { required: before.country === 'LK' }) : before.branch_name,
      branchCode: input.branchCode !== undefined ? cat.parseBranchCode(input.branchCode) : before.branch_code,
      purposes: input.purposes !== undefined ? cat.parsePurposes(input.purposes) : before.purposes,
      bankName: before.bank_name,
    };
    if (input.bankName !== undefined && clean(input.bankName, 80) !== before.bank_name) {
      if (before.bank_key !== 'other') throw error(400, 'Only the name of an "Other" bank can be edited', 'IMMUTABLE_FIELD', { field: 'bankName' });
      next.bankName = cat.parseBank('other', input.bankName).bankName;
    }

    const removed = (before.purposes || []).filter((p) => !next.purposes.includes(p));
    if (removed.length) {
      const use = await usage(client, before.id);
      const inUse = removed.filter((p) => use.defaults.includes(p) || (p === 'supermarket_payments' && use.funding.length));
      if (inUse.length) {
        throw error(409, `This account is still used for ${inUse.map((p) => cat.PURPOSE_LABELS[p]).join(', ')}. Change the default / funding account first.`, 'PURPOSE_IN_USE', { field: 'purposes' });
      }
    }

    const after = (
      await client.query(
        `UPDATE company_bank_accounts SET nickname = $2, account_holder_name = $3, branch_name = $4, branch_code = $5, purposes = $6,
           bank_name = $7, updated_by = $8, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [before.id, next.nickname, next.holder, next.branchName, next.branchCode, next.purposes, next.bankName, ctx.admin?.adminId ?? null]
      )
    ).rows[0];
    const change = diff(snapshot(before), snapshot(after));
    if (!Object.keys(change.after).length) throw error(400, 'Nothing changed', 'NO_CHANGES');
    await addEvent(client, ctx, { accountId: before.id, action: 'update', ...change, reason: clean(input.reason, 300) || null });
    return { before, after, change };
  });

  audit(ctx, { action: 'company_account.update', entityId: result.after.id, summary: `Edited ${named(result.after)}: ${Object.keys(result.change.after).join(', ')}`, ...result.change });
  return { account: await fresh(result.after.id), message: 'Saved' };
};

// POST /api/admin/company-accounts/:id/deactivate { reason }
const deactivate = async (id, input = {}, ctx) => {
  const reason = reasonOf(input);
  const result = await tx(ctx, async (client) => {
    const before = await lock(client, id);
    if (before.status !== 'active') throw error(409, `Only an active account can be deactivated (this one is ${before.status})`, 'WRONG_STATUS');
    const use = await usage(client, before.id);
    if (use.defaults.length || use.funding.length || use.openAttempts) {
      throw error(409, `This account can't be deactivated yet: ${inUseMessage(use)}.`, 'ACCOUNT_IN_USE', { usage: use });
    }
    const after = (
      await client.query(
        "UPDATE company_bank_accounts SET status = 'inactive', deactivated_by = $2, deactivated_at = NOW(), updated_by = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
        [before.id, ctx.admin?.adminId ?? null]
      )
    ).rows[0];
    await addEvent(client, ctx, { accountId: before.id, action: 'deactivate', before: { status: before.status }, after: { status: after.status }, reason });
    return { before, after };
  });
  audit(ctx, { action: 'company_account.deactivate', entityId: result.after.id, summary: `Deactivated ${named(result.after)}: ${reason}`, before: { status: 'active' }, after: { status: 'inactive' } });
  return { account: await fresh(result.after.id), message: `${masked(result.after)} deactivated` };
};

// POST /api/admin/company-accounts/:id/archive { reason } (inactive only; permanent)
const archive = async (id, input = {}, ctx) => {
  const reason = reasonOf(input);
  const result = await tx(ctx, async (client) => {
    const before = await lock(client, id);
    if (before.status !== 'inactive') throw error(409, before.status === 'archived' ? 'This account is already archived' : 'Deactivate the account before archiving it', 'WRONG_STATUS');
    const use = await usage(client, before.id);
    if (use.defaults.length || use.funding.length || use.openAttempts) {
      throw error(409, `This account can't be archived yet: ${inUseMessage(use)}.`, 'ACCOUNT_IN_USE', { usage: use });
    }
    const after = (
      await client.query(
        "UPDATE company_bank_accounts SET status = 'archived', archived_by = $2, archived_at = NOW(), updated_by = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
        [before.id, ctx.admin?.adminId ?? null]
      )
    ).rows[0];
    await addEvent(client, ctx, { accountId: before.id, action: 'archive', before: { status: before.status }, after: { status: 'archived' }, reason });
    return { after };
  });
  audit(ctx, { action: 'company_account.archive', entityId: result.after.id, summary: `Archived ${named(result.after)}: ${reason}`, before: { status: 'inactive' }, after: { status: 'archived' } });
  return { account: await fresh(result.after.id), message: `${masked(result.after)} archived (kept for history)` };
};

// ---------------------------------------------------
// Super Admin changes (direct with confirmation, or an approved
// Finance request). With ctx.dryRun every check runs and nothing is
// kept: the result describes the request.
// ---------------------------------------------------

// POST /api/admin/company-accounts/:id/activate { confirmLast4, reason }
const activate = async (id, input = {}, ctx) => {
  const result = await tx(ctx, async (client) => {
    const before = await lock(client, id);
    if (before.status === 'archived') throw error(409, 'An archived account can not be used again', 'ARCHIVED');
    if (before.status === 'active') throw error(409, 'This account is already active', 'WRONG_STATUS');
    if (!(before.purposes || []).length) throw error(409, 'Choose what the account is used for first', 'NO_PURPOSES');
    const reason = confirmFor(ctx, input, before);
    const summary = `Activate company bank account ${named(before)}`;
    if (ctx.dryRun) return { summary, accountId: before.id, entityKey: `activate:${before.id}` };

    const after = (
      await client.query(
        "UPDATE company_bank_accounts SET status = 'active', activated_by = $2, activated_at = NOW(), updated_by = $2, updated_at = NOW() WHERE id = $1 RETURNING *",
        [before.id, ctx.admin?.adminId ?? null]
      )
    ).rows[0];
    await addEvent(client, ctx, { accountId: before.id, action: 'activate', before: { status: before.status }, after: { status: 'active' }, reason });
    return { after, reason };
  });
  if (ctx.dryRun) return result;

  const { after, reason } = result;
  audit(ctx, { action: 'company_account.activate', entityId: after.id, summary: `Activated ${named(after)}: ${reason}`, before: { status: 'inactive' }, after: { status: 'active' } });
  notify(ctx, {
    event: 'company_account.activated',
    title: `Company bank account activated: ${masked(after)}`,
    body: `${after.nickname} · by ${ctx.admin?.fullName || 'staff'}${ctx.approval ? ' (approved by the Super Admin)' : ''}. Activating records that GetMe uses this account; it connects no bank and switches on no payment.`,
    accountId: after.id,
    dedupe: `company_account.activated:${after.id}:${Date.now()}`,
  });
  return { account: await fresh(after.id), message: `${masked(after)} is active. No bank is connected and no payment method changed.` };
};

const parseTarget = (input) => {
  if (input?.accountId === null) return null;
  const id = toId(input?.accountId);
  if (!id) throw error(400, 'Choose an account (or null to clear)', 'INVALID_ID', { field: 'accountId' });
  return id;
};

// PUT /api/admin/company-accounts/defaults/:purpose { accountId | null, confirmLast4, reason }
const setDefault = async (purpose, input = {}, ctx) => {
  const key = String(purpose || '');
  if (!cat.PURPOSE_KEYS.includes(key)) throw error(400, 'Unknown purpose', 'INVALID_PURPOSE');
  const targetId = parseTarget(input);

  const result = await tx(ctx, async (client) => {
    const current = (await client.query('SELECT * FROM company_bank_account_defaults WHERE purpose = $1 FOR UPDATE', [key])).rows[0];
    const currentRow = current ? await lock(client, current.account_id) : null;
    let target = null;
    if (targetId) {
      target = await lock(client, targetId);
      if (target.status !== 'active') throw error(409, 'Only an active account can be a default', 'NOT_ACTIVE');
      if (!(target.purposes || []).includes(key)) throw error(409, `This account isn't marked for ${cat.PURPOSE_LABELS[key]}`, 'PURPOSE_MISSING');
      if (currentRow && Number(currentRow.id) === Number(target.id)) throw error(409, 'This account is already the default', 'NO_CHANGE');
    } else if (!currentRow) {
      throw error(409, `There is no default for ${cat.PURPOSE_LABELS[key]}`, 'NO_CHANGE');
    }
    const reason = confirmFor(ctx, input, target || currentRow);
    const summary = target ? `Make ${named(target)} the default for ${cat.PURPOSE_LABELS[key]}` : `Clear the default for ${cat.PURPOSE_LABELS[key]} (${named(currentRow)})`;
    if (ctx.dryRun) return { summary, accountId: (target || currentRow).id, entityKey: `default:${key}` };

    if (target) {
      await client.query(
        `INSERT INTO company_bank_account_defaults (purpose, account_id, set_by, set_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (purpose) DO UPDATE SET account_id = EXCLUDED.account_id, set_by = EXCLUDED.set_by, set_at = NOW()`,
        [key, target.id, ctx.admin?.adminId ?? null]
      );
      await addEvent(client, ctx, { accountId: target.id, action: 'default.set', before: { defaultFor: currentRow ? `••${currentRow.account_last4}` : null }, after: { defaultFor: key }, reason });
    } else {
      await client.query('DELETE FROM company_bank_account_defaults WHERE purpose = $1', [key]);
    }
    if (currentRow) await addEvent(client, ctx, { accountId: currentRow.id, action: 'default.cleared', before: { defaultFor: key }, after: { defaultFor: null, replacedBy: target ? `••${target.account_last4}` : null }, reason });
    return { target, currentRow, reason, summary };
  });
  if (ctx.dryRun) return result;

  const { target, currentRow, reason } = result;
  audit(ctx, {
    action: 'company_account.default',
    entityId: (target || currentRow).id,
    summary: `${result.summary}: ${reason}`,
    before: { purpose: key, account: currentRow ? masked(currentRow) : null },
    after: { purpose: key, account: target ? masked(target) : null },
  });
  return { defaults: (await loadLinks()).defaults, account: await fresh((target || currentRow).id), message: target ? `${masked(target)} is now the default for ${cat.PURPOSE_LABELS[key]}` : `No default for ${cat.PURPOSE_LABELS[key]} now` };
};

// PUT /api/admin/company-accounts/funding/:methodKey { accountId | null, confirmLast4, reason }
const setFunding = async (methodKey, input = {}, ctx) => {
  const key = String(methodKey || '');
  const method = integration.FUNDED_METHODS[key];
  if (!method) throw error(404, 'This payment method is not paid from a company account', 'UNKNOWN_METHOD');
  const targetId = parseTarget(input);

  const result = await tx(ctx, async (client) => {
    const current = (await client.query('SELECT * FROM company_bank_account_funding WHERE method_key = $1 FOR UPDATE', [key])).rows[0];
    const currentRow = current ? await lock(client, current.account_id) : null;
    let target = null;
    if (targetId) {
      target = await lock(client, targetId);
      if (currentRow && Number(currentRow.id) === Number(target.id)) throw error(409, 'This account is already the funding account', 'NO_CHANGE');
      const check = integration.eligibility(target, key);
      if (!check.eligible) {
        throw error(409, `${masked(target)} can't pay ${method.label}: ${check.reasons.join(' ')}`, 'FUNDING_ACCOUNT_NOT_ELIGIBLE', { reasons: check.reasons });
      }
    } else if (!currentRow) {
      throw error(409, `No account is set for ${method.label}`, 'NO_CHANGE');
    }
    const reason = confirmFor(ctx, input, target || currentRow);
    const summary = target ? `Pay ${method.label} from ${named(target)}` : `Stop paying ${method.label} from ${named(currentRow)} (no funding account)`;
    if (ctx.dryRun) return { summary, accountId: (target || currentRow).id, entityKey: `funding:${key}` };

    if (target) {
      await client.query(
        `INSERT INTO company_bank_account_funding (method_key, account_id, set_by, set_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (method_key) DO UPDATE SET account_id = EXCLUDED.account_id, set_by = EXCLUDED.set_by, set_at = NOW()`,
        [key, target.id, ctx.admin?.adminId ?? null]
      );
      await addEvent(client, ctx, { accountId: target.id, action: 'funding.set', before: { fundingFor: null }, after: { fundingFor: key, replaced: currentRow ? `••${currentRow.account_last4}` : null }, reason });
    } else {
      await client.query('DELETE FROM company_bank_account_funding WHERE method_key = $1', [key]);
    }
    if (currentRow) await addEvent(client, ctx, { accountId: currentRow.id, action: 'funding.cleared', before: { fundingFor: key }, after: { fundingFor: null, replacedBy: target ? `••${target.account_last4}` : null }, reason });
    return { target, currentRow, reason, summary };
  });
  if (ctx.dryRun) return result;

  const { target, currentRow, reason } = result;
  audit(ctx, {
    action: 'company_account.funding',
    entityId: (target || currentRow).id,
    summary: `${result.summary}: ${reason}`,
    before: { method: key, account: currentRow ? masked(currentRow) : null },
    after: { method: key, account: target ? masked(target) : null },
  });
  notify(ctx, {
    event: 'company_account.funding_changed',
    title: target ? `${method.label} now pays from ${masked(target)}` : `${method.label} has no funding account now`,
    body: `${currentRow ? `Was ${masked(currentRow)}. ` : ''}Changed by ${ctx.admin?.fullName || 'staff'}${ctx.approval ? ' (approved by the Super Admin)' : ''}: ${reason}`.slice(0, 300),
    accountId: (target || currentRow).id,
    dedupe: `company_account.funding:${key}:${Date.now()}`,
  });
  return { funding: await fundingView(await loadLinks()), account: await fresh((target || currentRow).id), message: target ? `${method.label} pays from ${masked(target)}` : `${method.label} has no funding account: those payments are refused` };
};

// PATCH /api/admin/company-accounts/:id/integration { provider | null, bankReference, confirmLast4, reason }
const setIntegration = async (id, input = {}, ctx) => {
  const keys = providers.registry().map((p) => p.key);
  const provider = input.provider === null || input.provider === '' ? null : String(input.provider ?? '').trim().toLowerCase();
  if (input.provider === undefined) throw error(400, 'Choose a provider (or none)', 'INVALID_PROVIDER', { field: 'provider' });
  if (provider && !keys.includes(provider)) throw error(400, 'Unknown provider', 'INVALID_PROVIDER', { field: 'provider' });
  if (provider && providers.registryEntry(provider).testOnly && integration.isProduction()) {
    throw error(409, 'The test simulator can never be linked in production', 'SIMULATOR_NOT_ALLOWED', { field: 'provider' });
  }
  const bankReference = input.bankReference !== undefined ? clean(input.bankReference, 80) || null : undefined;

  const result = await tx(ctx, async (client) => {
    const before = await lock(client, id);
    if (before.status === 'archived') throw error(409, 'An archived account can no longer change', 'ARCHIVED');
    const nextRef = bankReference !== undefined ? bankReference : before.integration_reference;
    if ((before.integration_provider || null) === provider && (before.integration_reference || null) === (nextRef || null)) throw error(400, 'Nothing changed', 'NO_CHANGES');
    const reason = confirmFor(ctx, input, before);
    const summary = `Link ${named(before)} to provider ${provider || 'none'}${nextRef ? ` (bank ref ${nextRef})` : ''}`;
    if (ctx.dryRun) return { summary, accountId: before.id, entityKey: `integration:${before.id}` };

    const providerChanged = (before.integration_provider || null) !== provider;
    const after = (
      await client.query(
        `UPDATE company_bank_accounts SET integration_provider = $2, integration_reference = $3,
           authorization_status = CASE WHEN $4 THEN 'none' ELSE authorization_status END,
           authorization_reference = CASE WHEN $4 THEN NULL ELSE authorization_reference END,
           authorization_date = CASE WHEN $4 THEN NULL ELSE authorization_date END,
           authorization_recorded_by = CASE WHEN $4 THEN NULL ELSE authorization_recorded_by END,
           authorization_recorded_at = CASE WHEN $4 THEN NULL ELSE authorization_recorded_at END,
           approval_status = CASE WHEN $4 THEN 'none' ELSE approval_status END,
           approval_note = CASE WHEN $4 THEN NULL ELSE approval_note END,
           approved_by = CASE WHEN $4 THEN NULL ELSE approved_by END,
           approved_at = CASE WHEN $4 THEN NULL ELSE approved_at END,
           updated_by = $5, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [before.id, provider, nextRef, providerChanged, ctx.admin?.adminId ?? null]
      )
    ).rows[0];
    const change = diff(snapshot(before), snapshot(after));
    await addEvent(client, ctx, { accountId: before.id, action: 'integration.update', ...change, reason });
    return { after, change, reason };
  });
  if (ctx.dryRun) return result;

  audit(ctx, { action: 'company_account.integration', entityId: result.after.id, summary: `Provider link of ${named(result.after)} -> ${provider || 'none'}: ${result.reason}`, ...result.change });
  return { account: await fresh(result.after.id), message: provider ? `Linked to ${provider}. This records a link only: ${integration.integrationOf(result.after).summary}.` : 'Provider link removed' };
};

const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

// POST /api/admin/company-accounts/:id/authorization { status: none|requested|confirmed, reference, date, confirmLast4, reason }
const recordAuthorization = async (id, input = {}, ctx) => {
  const status = String(input.status || '');
  if (!['none', 'requested', 'confirmed'].includes(status)) throw error(400, 'Choose none, requested or confirmed', 'INVALID_STATUS', { field: 'status' });
  const reference = clean(input.reference, 80) || null;
  const date = input.date ? String(input.date).slice(0, 10) : null;
  if (date && !isDate(date)) throw error(400, 'Enter the date as YYYY-MM-DD', 'INVALID_DATE', { field: 'date' });
  if (date && new Date(`${date}T00:00:00Z`).getTime() > Date.now() + 86400000) throw error(400, "The date can't be in the future", 'INVALID_DATE', { field: 'date' });
  if (status === 'confirmed' && (!reference || reference.length < 3)) throw error(400, "Enter the bank's reference for the authorisation (mandate / agreement)", 'REFERENCE_REQUIRED', { field: 'reference' });
  if (status === 'confirmed' && !date) throw error(400, 'Enter the date the bank confirmed it', 'INVALID_DATE', { field: 'date' });

  const result = await tx(ctx, async (client) => {
    const before = await lock(client, id);
    if (before.status === 'archived') throw error(409, 'An archived account can no longer change', 'ARCHIVED');
    if (!before.integration_provider) throw error(409, 'Link a provider first: there is nothing to authorise', 'NO_PROVIDER');
    if (before.integration_provider === 'simulator') throw error(409, 'The TEST SIMULATOR involves no bank: there is no bank authorisation to record', 'NOT_APPLICABLE');
    const reason = confirmFor(ctx, input, before);
    const summary = `Record bank authorisation "${status}" for ${named(before)}${reference ? ` (ref ${reference})` : ''}`;
    if (ctx.dryRun) return { summary, accountId: before.id, entityKey: `authorization:${before.id}` };

    const after = (
      await client.query(
        `UPDATE company_bank_accounts SET authorization_status = $2, authorization_reference = $3, authorization_date = $4,
           authorization_recorded_by = $5, authorization_recorded_at = NOW(),
           approval_status = 'none', approval_note = NULL, approved_by = NULL, approved_at = NULL,
           updated_by = $5, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [before.id, status, reference, date, ctx.admin?.adminId ?? null]
      )
    ).rows[0];
    const change = diff(snapshot(before), snapshot(after));
    await addEvent(client, ctx, { accountId: before.id, action: 'authorization.update', ...change, reason });
    return { after, change, reason };
  });
  if (ctx.dryRun) return result;

  audit(ctx, { action: 'company_account.authorization', entityId: result.after.id, summary: `Bank authorisation of ${named(result.after)} -> ${status}: ${result.reason}`, ...result.change });
  return { account: await fresh(result.after.id), message: `Bank authorisation recorded as ${status}. Any earlier approval was reset.` };
};

// POST /api/admin/company-accounts/:id/integration-approval { decision: approve|revoke, confirmLast4, reason } (Super Admin only)
const approveIntegration = async (id, input = {}, ctx) => {
  const decision = String(input.decision || '');
  if (!['approve', 'revoke'].includes(decision)) throw error(400, 'Choose approve or revoke', 'INVALID_DECISION');
  if (ctx.admin?.role !== 'owner') throw error(403, 'Only the Super Admin can approve a bank integration', 'SUPER_ADMIN_ONLY');

  const result = await tx(ctx, async (client) => {
    const before = await lock(client, id);
    if (before.status === 'archived') throw error(409, 'An archived account can no longer change', 'ARCHIVED');
    const reason = confirmFor({ ...ctx, approval: null }, input, before);
    const facts = integration.integrationOf(before);
    let level = 'none';
    if (decision === 'approve') {
      const missing = [!facts.exists.ok && facts.exists.reason, facts.exists.ok && !facts.credentials.ok && facts.credentials.reason].filter(Boolean);
      if (missing.length) throw error(409, `Not ready to approve: ${missing.join(' ')}`, 'INTEGRATION_NOT_READY', { reasons: missing });
      if (facts.simulator && integration.isProduction()) throw error(409, 'The test simulator is never approved in production', 'SIMULATOR_NOT_ALLOWED');
      level = facts.simulator ? 'test_approved' : 'production_approved';
      if (before.approval_status === level) throw error(409, 'Already approved', 'NO_CHANGE');
    } else if (before.approval_status === 'none') {
      throw error(409, 'There is no approval to revoke', 'NO_CHANGE');
    }

    const after = (
      await client.query(
        `UPDATE company_bank_accounts SET approval_status = $2, approval_note = $3, approved_by = $4, approved_at = CASE WHEN $5 THEN NULL ELSE NOW() END,
           updated_by = $4, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [before.id, level, level === 'none' ? null : reason, ctx.admin?.adminId ?? null, level === 'none']
      )
    ).rows[0];
    await addEvent(client, ctx, { accountId: before.id, action: decision === 'approve' ? 'integration.approve' : 'integration.revoke', before: { approval: before.approval_status }, after: { approval: level }, reason });
    return { after, level, reason, before };
  });

  audit(ctx, {
    action: decision === 'approve' ? 'company_account.integration_approve' : 'company_account.integration_revoke',
    entityId: result.after.id,
    summary: `${decision === 'approve' ? (result.level === 'test_approved' ? 'Approved for TESTS ONLY (simulator)' : 'Approved for production') : 'Revoked the approval of'} ${named(result.after)}: ${result.reason}`,
    before: { approval: result.before.approval_status },
    after: { approval: result.level },
  });
  return {
    account: await fresh(result.after.id),
    message: decision === 'revoke' ? 'Approval revoked' : result.level === 'test_approved' ? 'Approved for automated tests only (TEST SIMULATOR — no money moves)' : 'Approved for production',
  };
};

// POST /api/admin/company-accounts/:id/reveal { reason } (Super Admin only, rate limited, audited)
const reveal = async (id, input = {}, ctx) => {
  if (ctx.admin?.role !== 'owner') throw error(403, 'Only the Super Admin can see a full company account number', 'SUPER_ADMIN_ONLY');
  const reason = reasonOf(input);
  const accountId = toId(id);
  if (!accountId) throw error(400, 'Invalid account', 'INVALID_ID');

  const recent = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM company_bank_account_events
       WHERE action = 'reveal' AND actor_admin_id = $1 AND created_at > NOW() - make_interval(mins => $2)`,
      [ctx.admin.adminId, REVEAL_WINDOW_MINUTES]
    )
  ).rows[0].n;
  if (recent >= REVEAL_LIMIT) throw error(429, `At most ${REVEAL_LIMIT} full numbers every ${REVEAL_WINDOW_MINUTES} minutes. Try again later.`, 'RATE_LIMITED');

  const row = (await pool.query('SELECT * FROM company_bank_accounts WHERE id = $1', [accountId])).rows[0];
  if (!row) throw error(404, 'Company bank account not found', 'NOT_FOUND');
  let number;
  try {
    number = vault.decryptAccountNumber(row.account_number_encrypted);
  } catch {
    throw error(500, 'The saved number could not be read', 'UNREADABLE');
  }

  const eventId = await addEvent(pool, ctx, { accountId: row.id, action: 'reveal', after: { revealed: `••${row.account_last4}` }, reason });
  audit(ctx, { action: 'company_account.reveal', entityId: row.id, summary: `Revealed the full number of ${named(row)}: ${reason}` });
  notify(ctx, {
    event: 'company_account.revealed',
    title: `Full company account number viewed: ${masked(row)}`,
    body: `${ctx.admin?.fullName || 'The Super Admin'} viewed the full number. Reason: ${reason}`.slice(0, 300),
    accountId: row.id,
    dedupe: `company_account.reveal:${eventId}`,
  });
  return { accountNumber: number, maskedNumber: `••${row.account_last4}`, revealedAt: new Date().toISOString(), message: 'Shown once. This view was recorded.' };
};

module.exports = {
  list,
  get,
  create,
  update,
  deactivate,
  archive,
  activate,
  setDefault,
  setFunding,
  setIntegration,
  recordAuthorization,
  approveIntegration,
  reveal,
  // tests / other modules
  snapshot,
  toPublic,
  REVEAL_LIMIT,
};
