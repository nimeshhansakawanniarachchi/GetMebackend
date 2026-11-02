const pool = require('../config/db');
const providers = require('../groceryPayments/providers');

// =====================================================
// COMPANY BANK ACCOUNTS - integration status (phase 50)
// Three separate facts per account, NEVER inferred from the account
// number or the bank's name:
//   1. exists       the provider chosen for the account is implemented
//                   in this code for the transaction type (provider
//                   registry, groceryPayments/providers/index.js). Today:
//                   dfcc = stub (no), simulator = TEST SIMULATOR (tests
//                   only, never production).
//   2. credentials  the provider reports itself configured from the
//                   server environment (describe()) AND, for a real
//                   bank, the Super Admin recorded the bank's
//                   authorisation (mandate / agreement) as confirmed.
//                   Credentials themselves live only in .env.
//   3. approval     the Super Admin tested and approved it: production
//                   approval for a real provider, test approval for the
//                   simulator (non-production only; never reported as
//                   production-approved).
// A payment method may use an account only when all three hold AND the
// server runs that provider and it is usable right now.
// =====================================================

const TX = 'lankaqr_merchant_payment';
// GetMe-funded payment methods that pay from a company account
const FUNDED_METHODS = { getme_lankaqr: { label: 'Scan LankaQR (GetMe pays)', purpose: 'supermarket_payments', transactionType: TX, currency: 'LKR' } };
const NEUTRAL_SOURCE = 'GetMe company account';

const isProduction = (env = process.env) => String(env.NODE_ENV || '').trim().toLowerCase() === 'production';

const sourceLabel = (row) => (row ? `GetMe · ${row.bank_name} ••${row.account_last4}` : NEUTRAL_SOURCE);

const integrationOf = (row, env = process.env) => {
  const production = isProduction(env);
  const key = row.integration_provider || null;
  const entry = key ? providers.registryEntry(key) : null;
  const simulator = key === 'simulator';
  const server = providers.state(env);

  // 1. Does an integration exist in GetMe's code?
  let exists;
  if (!key) exists = { ok: false, reason: 'No payment provider is linked. GetMe has no bank integration for this account.' };
  else if (!entry) exists = { ok: false, reason: `Unknown provider "${String(key).slice(0, 20)}".` };
  else if (!entry.transactionTypes[TX]) exists = { ok: false, reason: `No integration exists in GetMe for ${entry.label}: ${entry.note}` };
  else if (entry.testOnly && production) exists = { ok: false, reason: 'The test simulator never runs in production.' };
  else if (entry.bankKeys && !entry.bankKeys.includes(row.bank_key)) exists = { ok: false, reason: `${entry.label} can't pay from a ${row.bank_name} account.` };
  else exists = { ok: true, reason: simulator ? 'TEST SIMULATOR only (automated tests, no money moves).' : `${entry.label} is implemented in GetMe.` };

  // 2. Credentials (environment) + bank authorisation (recorded)
  const described = key && entry ? providers.describeKey(key, env) : null;
  const configured = Boolean(described?.configured);
  const authorization = {
    status: row.authorization_status || 'none',
    reference: row.authorization_reference || null,
    date: row.authorization_date ? new Date(row.authorization_date).toISOString().slice(0, 10) : null,
    recordedBy: row.authorization_recorded_by != null ? Number(row.authorization_recorded_by) : null,
    recordedByName: row.authorization_recorded_by_name ?? undefined,
    recordedAt: row.authorization_recorded_at || null,
    required: Boolean(key) && !simulator,
  };
  let credentials;
  if (!key) credentials = { ok: false, configured: false, reason: 'No provider: there are no credentials to configure.' };
  else if (!configured) credentials = { ok: false, configured: false, reason: described?.reason || 'The provider is not configured on this server.' };
  else if (simulator) credentials = { ok: true, configured: true, reason: 'TEST SIMULATOR: no credentials and no bank authorisation (no bank involved).' };
  else if (authorization.status !== 'confirmed') credentials = { ok: false, configured: true, reason: "The bank's authorisation for this account is not recorded as confirmed." };
  else credentials = { ok: true, configured: true, reason: 'Configured on the server; bank authorisation confirmed.' };

  // 3. Tested + approved
  const level = row.approval_status || 'none';
  let approval;
  if (simulator) {
    if (level !== 'test_approved') approval = { ok: false, level, reason: 'Not approved for tests by the Super Admin.' };
    else if (production || server.liveFlag) approval = { ok: false, level, reason: 'Test approval does not count in production or live mode.' };
    else approval = { ok: true, level, reason: 'Approved for automated tests only (TEST SIMULATOR). Never production-approved.' };
  } else if (level === 'production_approved') {
    approval = { ok: true, level, reason: 'Tested and approved for production by the Super Admin.' };
  } else {
    approval = { ok: false, level, reason: 'Not tested and approved for production.' };
  }
  approval.by = row.approved_by != null ? Number(row.approved_by) : null;
  approval.byName = row.approved_by_name ?? undefined;
  approval.at = row.approved_at || null;
  approval.note = row.approval_note || null;

  const selectedOnServer = Boolean(key) && server.key === key;
  const usableNow = exists.ok && credentials.ok && approval.ok && selectedOnServer && server.usable;

  let summary;
  let tone;
  if (!key) {
    summary = 'Records only — no bank integration';
    tone = 'neutral';
  } else if (simulator) {
    summary = usableNow ? 'TEST SIMULATOR — approved for tests, no money moves' : 'TEST SIMULATOR — not usable now';
    tone = 'warning';
  } else if (!exists.ok) {
    summary = `Records only — no integration exists for ${entry?.label || key}`;
    tone = 'neutral';
  } else if (!credentials.ok) {
    summary = 'Integration exists — credentials / bank authorisation not complete';
    tone = 'warning';
  } else if (!approval.ok) {
    summary = 'Integration exists — not approved for production';
    tone = 'warning';
  } else if (!usableNow) {
    summary = 'Approved — not the provider this server runs';
    tone = 'info';
  } else {
    summary = 'Bank integration approved and running';
    tone = 'success';
  }

  return {
    transactionType: TX,
    provider: key,
    providerLabel: entry?.label || null,
    bankReference: row.integration_reference || null,
    simulator,
    exists,
    credentials,
    authorization,
    approval,
    selectedOnServer,
    serverProvider: server.key,
    usableNow,
    summary,
    tone,
  };
};

// Can this account fund the method now? -> { eligible, code, reasons }
const eligibility = (row, methodKey = 'getme_lankaqr', env = process.env) => {
  const method = FUNDED_METHODS[methodKey];
  if (!row) return { eligible: false, code: 'FUNDING_ACCOUNT_NOT_SET', reasons: ['No company account is set to pay from.'] };

  const reasons = [];
  if (row.status !== 'active') reasons.push('The account is not active.');
  if (!(row.purposes || []).includes(method.purpose)) reasons.push("The account isn't marked for supermarket payments.");
  if (row.currency !== method.currency) reasons.push(`LankaQR payments are in ${method.currency}; this account is in ${row.currency}.`);

  const integration = integrationOf(row, env);
  const server = providers.state(env);
  if (!integration.provider) {
    reasons.push('No payment provider is linked to this account: GetMe has no bank integration for it.');
  } else {
    if (!integration.exists.ok) reasons.push(integration.exists.reason);
    if (integration.exists.ok && !integration.credentials.ok) reasons.push(integration.credentials.reason);
    if (integration.exists.ok && integration.credentials.ok && !integration.approval.ok) reasons.push(integration.approval.reason);
    if (!integration.selectedOnServer) reasons.push(`This server runs provider "${server.key}", not "${integration.provider}".`);
    else if (!server.usable) reasons.push(`The provider is not usable on this server: ${server.reason}`);
  }

  return { eligible: reasons.length === 0, code: reasons.length ? 'FUNDING_ACCOUNT_NOT_ELIGIBLE' : null, reasons: [...new Set(reasons)], integration };
};

// The funding account of a method + whether it can pay now
const fundingFor = async (methodKey = 'getme_lankaqr', client = pool) => {
  const row = (
    await client.query(
      `SELECT a.* FROM company_bank_account_funding f JOIN company_bank_accounts a ON a.id = f.account_id WHERE f.method_key = $1`,
      [methodKey]
    )
  ).rows[0];
  const check = eligibility(row || null, methodKey);
  return { account: row || null, label: sourceLabel(row || null), eligible: check.eligible, code: check.code, reasons: check.reasons };
};

// What the provider gets (never the account number: a real provider
// integration would read it from the vault on the server side)
const providerAccount = (row) =>
  row
    ? {
        id: Number(row.id),
        bankKey: row.bank_key,
        bankName: row.bank_name,
        last4: row.account_last4,
        currency: row.currency,
        bankReference: row.integration_reference || null,
      }
    : null;

module.exports = {
  TX,
  FUNDED_METHODS,
  NEUTRAL_SOURCE,
  isProduction,
  sourceLabel,
  integrationOf,
  eligibility,
  fundingFor,
  providerAccount,
};
