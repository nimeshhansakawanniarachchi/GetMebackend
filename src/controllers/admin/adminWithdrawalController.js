const pool = require('../../config/db');

const wallet = require('../../wallet/shopperWallet');
const { emitToAdmins } = require('../../realtime');
const { readPage, pageMeta } = require('../../utils/pagination');
const { createShopperNotification } = require('../shopperNotificationController');

// =====================================================
// ADMIN: SHOPPER WITHDRAWALS (/api/admin/withdrawals)
// Finance (and owner) review shoppers' withdrawal requests and
// record the bank transfer (no payout API - the transfer is made in
// the bank; "paid" only after it went through, with its reference).
//   GET   /withdrawals?status=&from=&to=&q=&page=
//   GET   /withdrawals/:id          request + full account number +
//                                   shopper balance + history + events
//   PATCH /withdrawals/:id          { action: approve | process | pay |
//                                     fail | reject, reference?, reason? }
//   GET   /payout-accounts?status=pending|verified|rejected
//   PATCH /payout-accounts/:id      { action: verify | reject, note? }
// Every change also lands in admin_audit_log (middleware/adminAccess).
// =====================================================

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const sendError = (res, error, fallback) => {
  const status = error?.status || 500;

  if (status >= 500) {
    console.error(`❌ ${fallback}:`, error?.message || error);
  }

  return res.status(status).json({
    success: false,
    code: error?.code,
    message: status >= 500 ? fallback : error.message,
  });
};

const announce = (req, shopperId, payload = {}) => {
  try {
    const io = req.app.get('io');
    if (!io) return;

    io.to(`shopper:${shopperId}`).emit('shopper-earnings-updated', { shopperId, ...payload });
    emitToAdmins(io, 'admin:withdrawal-updated', { shopperId, ...payload });
    emitToAdmins(io, 'admin:settlement-updated', { shopperId, ...payload });
  } catch (error) {
    console.error('❌ WITHDRAWAL SOCKET ERROR:', error.message);
  }

  // Phase 45: a paid withdrawal settles cash owed (cash limit)
  require('../../dispatch/cashLimit').refreshInBackground(shopperId, req.app.get('io'));
};

const money = (value) => `LKR ${Number(value || 0).toFixed(2)}`;

// What the shopper is told
const NOTICES = {
  approve: (w) => ['Withdrawal approved', `${money(w.amount)} will be sent to ${w.account?.bankName || 'your bank'} •••• ${w.account?.accountLast4 || ''}.`],
  process: (w) => ['Withdrawal being transferred', `${money(w.payoutAmount)} is being sent to your bank.`],
  pay: (w) => [
    'Withdrawal paid',
    `${money(w.payoutAmount)} was sent to ${w.account?.bankName || 'your bank'} •••• ${w.account?.accountLast4 || ''}${
      w.reimbursementAmount > 0 ? ` (earnings ${money(w.earningsAmount)} + grocery reimbursement ${money(w.reimbursementAmount)})` : ''
    }. Reference ${w.reference}.`,
  ],
  fail: (w) => ['Withdrawal failed', `${money(w.amount)} is back in your balance. ${w.reason || ''}`.trim()],
  reject: (w) => ['Withdrawal rejected', `${money(w.amount)} is back in your balance. ${w.reason || ''}`.trim()],
};

const LIST_SQL = `
  FROM shopper_withdrawals w
  JOIN shoppers sh ON sh.id = w.shopper_id
  LEFT JOIN shopper_payout_accounts a ON a.id = w.payout_account_id
`;

// GET /api/admin/withdrawals
const listWithdrawals = async (req, res) => {
  try {
    const where = [];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };

    const status = String(req.query.status || '').trim();

    if (status === 'open') {
      add('w.status = ANY(?)', wallet.OPEN_STATUSES);
    } else if (wallet.STATUS_LABELS[status]) {
      add('w.status = ?', status);
    }

    if (req.query.from) add('w.requested_at >= ?::date', String(req.query.from));
    if (req.query.to) add("w.requested_at < (?::date + INTERVAL '1 day')", String(req.query.to));

    const q = String(req.query.q || '').trim();

    // Shopper name / mobile, bank reference or "#12" (withdrawal id)
    if (q) {
      params.push(`%${q}%`);
      const like = `$${params.length}`;
      params.push(q.replace(/^#/, ''));
      const exact = `$${params.length}`;
      where.push(`(sh.full_name ILIKE ${like} OR sh.mobile ILIKE ${like} OR COALESCE(w.reference, '') ILIKE ${like} OR w.id::text = ${exact})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const page = readPage(req.query, 20);

    const [rows, total, summary] = await Promise.all([
      pool.query(
        `
        SELECT w.*, sh.full_name AS shopper_name, sh.mobile AS shopper_mobile, a.status AS account_status
        ${LIST_SQL}
        ${whereSql}
        ORDER BY (w.status = ANY($${params.length + 1})) DESC, w.requested_at DESC, w.id DESC
        LIMIT $${params.length + 2} OFFSET $${params.length + 3}
        `,
        [...params, wallet.OPEN_STATUSES, page.pageSize, page.offset]
      ),
      pool.query(`SELECT COUNT(*)::int AS n ${LIST_SQL} ${whereSql}`, params),
      pool.query(
        `
        SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS amount
        FROM shopper_withdrawals GROUP BY status
        `
      ),
    ]);

    const byStatus = Object.fromEntries(summary.rows.map((row) => [row.status, { count: row.count, amount: row.amount }]));
    const pendingAccounts = (
      await pool.query("SELECT COUNT(*)::int AS n FROM shopper_payout_accounts WHERE status = 'pending' AND deleted_at IS NULL")
    ).rows[0].n;

    return res.json({
      success: true,
      withdrawals: rows.rows.map((row) => ({
        ...wallet.toPublicWithdrawal(row),
        shopperName: row.shopper_name,
        shopperMobile: row.shopper_mobile,
        accountStatus: row.account_status || null,
      })),
      summary: { byStatus, pendingAccounts },
      ...pageMeta(page, total.rows[0].n),
    });
  } catch (error) {
    return sendError(res, error, 'Unable to load withdrawals');
  }
};

// GET /api/admin/withdrawals/:id
const getWithdrawal = async (req, res) => {
  const id = toId(req.params.id);

  if (!id) return res.status(400).json({ success: false, message: 'Invalid withdrawal' });

  try {
    const row = (
      await pool.query(
        `SELECT w.*, sh.full_name AS shopper_name, sh.mobile AS shopper_mobile, sh.email AS shopper_email ${LIST_SQL} WHERE w.id = $1`,
        [id]
      )
    ).rows[0];

    if (!row) return res.status(404).json({ success: false, message: 'Withdrawal not found' });

    const shopperId = Number(row.shopper_id);
    const [accountRow, balances, history, events, activity] = await Promise.all([
      row.payout_account_id
        ? pool.query('SELECT * FROM shopper_payout_accounts WHERE id = $1', [row.payout_account_id]).then((r) => r.rows[0])
        : null,
      wallet.walletFor(shopperId),
      wallet.listWithdrawals(shopperId, { limit: 20 }),
      pool.query(
        `
        SELECT e.*, a.full_name AS admin_name
        FROM shopper_withdrawal_events e
        LEFT JOIN admins a ON e.actor_type = 'admin' AND a.id = e.actor_id
        WHERE e.withdrawal_id = $1
        ORDER BY e.id
        `,
        [id]
      ),
      wallet.walletActivity(shopperId, { limit: 20 }),
    ]);

    return res.json({
      success: true,
      withdrawal: wallet.toPublicWithdrawal(row),
      shopper: { id: shopperId, name: row.shopper_name, mobile: row.shopper_mobile, email: row.shopper_email || null },
      // Full number: to make the bank transfer
      account: accountRow ? { ...wallet.toPublicAccount(accountRow, { full: true }), removed: !!accountRow.deleted_at } : null,
      wallet: balances,
      history,
      activity,
      events: events.rows.map((event) => ({
        id: Number(event.id),
        action: event.action,
        from: event.from_status,
        to: event.to_status,
        actorType: event.actor_type,
        actorName: event.actor_type === 'admin' ? event.admin_name || 'Admin' : 'Shopper',
        note: event.note,
        at: event.created_at,
      })),
    });
  } catch (error) {
    return sendError(res, error, 'Unable to load the withdrawal');
  }
};

// PATCH /api/admin/withdrawals/:id
const changeWithdrawal = async (req, res) => {
  const id = toId(req.params.id);
  const action = String(req.body?.action || '');

  if (!id) return res.status(400).json({ success: false, message: 'Invalid withdrawal' });

  if (!['approve', 'process', 'pay', 'fail', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Choose approve, process, pay, fail or reject' });
  }

  try {
    const result = await wallet.changeWithdrawal(id, action, {
      actorType: 'admin',
      actorId: req.admin.adminId,
      reference: req.body?.reference,
      reason: req.body?.reason,
    });

    const w = result.withdrawal;
    const [title, body] = NOTICES[action](w);

    createShopperNotification({ io: req.app.get('io'), shopperId: w.shopperId, type: 'payout', title, body }).catch(() => {});
    announce(req, w.shopperId, { withdrawalId: w.id, status: w.status });

    return res.json({
      success: true,
      message: { approve: 'Withdrawal approved', process: 'Marked as processing', pay: 'Payout recorded', fail: 'Marked as failed - amount returned to the balance', reject: 'Withdrawal rejected - amount returned to the balance' }[action],
      withdrawal: w,
      wallet: result.wallet,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to update the withdrawal');
  }
};

// GET /api/admin/payout-accounts?status=pending
const listPayoutAccounts = async (req, res) => {
  try {
    const status = ['pending', 'verified', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = (
      await pool.query(
        `
        SELECT a.*, sh.full_name AS shopper_name, sh.mobile AS shopper_mobile
        FROM shopper_payout_accounts a
        JOIN shoppers sh ON sh.id = a.shopper_id
        WHERE a.status = $1 AND a.deleted_at IS NULL
        ORDER BY a.created_at
        LIMIT 200
        `,
        [status]
      )
    ).rows;

    return res.json({
      success: true,
      accounts: rows.map((row) => ({
        ...wallet.toPublicAccount(row, { full: true }),
        shopperId: Number(row.shopper_id),
        shopperName: row.shopper_name,
        shopperMobile: row.shopper_mobile,
      })),
    });
  } catch (error) {
    return sendError(res, error, 'Unable to load bank accounts');
  }
};

// PATCH /api/admin/payout-accounts/:id { action: verify | reject, note }
const reviewPayoutAccount = async (req, res) => {
  const id = toId(req.params.id);

  if (!id) return res.status(400).json({ success: false, message: 'Invalid account' });

  try {
    const row = await wallet.reviewAccount(id, req.admin.adminId, { action: req.body?.action, note: req.body?.note });
    const verified = row.status === 'verified';

    createShopperNotification({
      io: req.app.get('io'),
      shopperId: row.shopper_id,
      type: 'payout',
      title: verified ? 'Bank account verified' : 'Bank account not accepted',
      body: verified
        ? `${row.bank_name} •••• ${row.account_last4} can now receive your withdrawals.`
        : `${row.bank_name} •••• ${row.account_last4}: ${row.status_note || 'please add it again'}`,
    }).catch(() => {});
    announce(req, Number(row.shopper_id), { accountId: id, status: row.status });

    return res.json({
      success: true,
      message: verified ? 'Bank account verified' : 'Bank account rejected',
      account: wallet.toPublicAccount(row),
    });
  } catch (error) {
    return sendError(res, error, 'Unable to update the bank account');
  }
};

module.exports = {
  listWithdrawals,
  getWithdrawal,
  changeWithdrawal,
  listPayoutAccounts,
  reviewPayoutAccount,
};
