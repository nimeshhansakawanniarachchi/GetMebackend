const pool = require('../config/db');

// =====================================================
// GETME CREDIT (phase 43 issues it; ledger from phase 42)
//
// customer_credit_entries is append-only: balance = SUM(amount).
// Writers lock the customer row (SELECT ... FOR UPDATE) first, so two
// writes for one customer never interleave and the balance can't go
// below zero. client_request_id makes a retry return the first entry.
// =====================================================

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const KIND_LABELS = {
  issued: 'GetMe credit added',
  spent: 'Used at checkout',
  reversed: 'Reversed',
  adjusted: 'Adjusted',
};

const balanceOf = async (customerId, client = pool) =>
  round2((await client.query('SELECT COALESCE(SUM(amount), 0) AS balance FROM customer_credit_entries WHERE customer_id = $1', [customerId])).rows[0].balance);

// staff = true adds the admin name + internal reason
const toEntry = (row, { staff = false } = {}) => ({
  id: Number(row.id),
  amount: round2(row.amount),
  kind: row.kind,
  label: KIND_LABELS[row.kind] || row.kind,
  orderId: row.order_id != null ? Number(row.order_id) : null,
  supportCaseId: row.support_case_id != null ? Number(row.support_case_id) : null,
  createdAt: row.created_at,
  // Staff reasons can be internal: customers see the label only
  ...(staff ? { reason: row.reason || null, admin: row.admin_id ? { id: Number(row.admin_id), name: row.admin_name || null } : null } : {}),
});

const listEntries = async (customerId, { limit = 50, staff = false } = {}) => {
  const rows = (
    await pool.query(
      `SELECT e.*, a.full_name AS admin_name
       FROM customer_credit_entries e LEFT JOIN admins a ON a.id = e.admin_id
       WHERE e.customer_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT $2`,
      [customerId, limit]
    )
  ).rows;
  return rows.map((row) => toEntry(row, { staff }));
};

const approvalLimit = async (client = pool) =>
  round2((await client.query('SELECT credit_approval_limit FROM customer_controls_settings WHERE id = 1')).rows[0]?.credit_approval_limit ?? 5000);

// Inside the caller's transaction. -> { entry, created, balance }
const issueCredit = async (client, { customerId, amount, reason, orderId = null, supportCaseId = null, adminId = null, clientRequestId }) => {
  const value = round2(amount);
  if (!(value > 0)) throw Object.assign(new Error('Enter a credit amount above zero'), { status: 400 });

  const customer = (await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId])).rows[0];
  if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 });

  const existing = (await client.query('SELECT * FROM customer_credit_entries WHERE client_request_id = $1', [clientRequestId])).rows[0];
  if (existing) {
    if (Number(existing.customer_id) !== Number(customerId)) {
      throw Object.assign(new Error('This request id was already used'), { status: 409 });
    }
    return { entry: existing, created: false, balance: await balanceOf(customerId, client) };
  }

  const entry = (
    await client.query(
      `INSERT INTO customer_credit_entries (customer_id, amount, kind, reason, order_id, support_case_id, admin_id, client_request_id)
       VALUES ($1, $2, 'issued', $3, $4, $5, $6, $7) RETURNING *`,
      [customerId, value, String(reason || '').slice(0, 300) || null, orderId, supportCaseId, adminId, clientRequestId]
    )
  ).rows[0];

  return { entry, created: true, balance: await balanceOf(customerId, client) };
};

// Total unspent credit across customers (a GetMe liability)
const outstandingTotal = async () =>
  round2((await pool.query('SELECT COALESCE(SUM(amount), 0) AS total FROM customer_credit_entries')).rows[0].total);

// =====================================================
// PHASE 44: SPENDING + RETURNING CREDIT ON AN ORDER
// Same rules as issueCredit: inside the caller's transaction, the
// customer row locked first, client_request_id makes a retry return
// the first entry (never a second write).
// =====================================================

// Spends up to `wanted` (never more than the balance, so the balance
// can't go below zero). -> { entry, created, applied, balance }
const spendCredit = async (client, { customerId, wanted, orderId = null, reason = null, clientRequestId }) => {
  const customer = (await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId])).rows[0];
  if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 });

  const existing = (await client.query('SELECT * FROM customer_credit_entries WHERE client_request_id = $1', [clientRequestId])).rows[0];
  if (existing) {
    return { entry: existing, created: false, applied: round2(-Number(existing.amount)), balance: await balanceOf(customerId, client) };
  }

  const balance = await balanceOf(customerId, client);
  const applied = round2(Math.max(0, Math.min(balance, round2(wanted))));
  if (!(applied > 0)) return { entry: null, created: false, applied: 0, balance };

  const entry = (
    await client.query(
      `INSERT INTO customer_credit_entries (customer_id, amount, kind, reason, order_id, client_request_id)
       VALUES ($1, $2, 'spent', $3, $4, $5) RETURNING *`,
      [customerId, -applied, reason ? String(reason).slice(0, 300) : null, orderId, clientRequestId]
    )
  ).rows[0];

  return { entry, created: true, applied, balance: round2(balance - applied) };
};

// Gives credit back (kind 'reversed', amount > 0). -> { entry, created, balance }
const returnCredit = async (client, { customerId, amount, orderId = null, reason = null, clientRequestId }) => {
  const value = round2(amount);
  const customer = (await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId])).rows[0];
  if (!customer) throw Object.assign(new Error('Customer not found'), { status: 404 });

  const existing = (await client.query('SELECT * FROM customer_credit_entries WHERE client_request_id = $1', [clientRequestId])).rows[0];
  if (existing || !(value > 0)) {
    return { entry: existing || null, created: false, balance: await balanceOf(customerId, client) };
  }

  const entry = (
    await client.query(
      `INSERT INTO customer_credit_entries (customer_id, amount, kind, reason, order_id, client_request_id)
       VALUES ($1, $2, 'reversed', $3, $4, $5) RETURNING *`,
      [customerId, value, reason ? String(reason).slice(0, 300) : null, orderId, clientRequestId]
    )
  ).rows[0];

  return { entry, created: true, balance: await balanceOf(customerId, client) };
};

module.exports = { round2, balanceOf, listEntries, toEntry, approvalLimit, issueCredit, outstandingTotal, spendCredit, returnCredit, KIND_LABELS };
