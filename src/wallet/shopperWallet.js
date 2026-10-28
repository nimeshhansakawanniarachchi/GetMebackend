const pool = require('../config/db');

const { getPricingSettings } = require('../pricing/settings');
const { encryptAccountNumber, decryptAccountNumber, hashAccountNumber } = require('./accountVault');

// =====================================================
// SHOPPER WALLET (sql/platform_phase31_withdrawals.sql)
// The earnings GetMe owes a shopper, withdrawn on request to their
// own bank account (paid by a finance admin by bank transfer - no
// payout API exists). Built on the settlement records, never on
// app state:
//   released   shopper_earnings payable / paid (delivery + priority
//              + service + tips + adjustments; bills approved)
//   paidOut    shopper_payouts kind 'earnings' (paid withdrawals,
//              cash settled from earnings, older admin payouts)
//   balance    released - paidOut            (GetMe owes the shopper)
//   reserved   withdrawals pending / approved / processing
//   cashDue    cash collected at the door, still owed to GetMe
//   available  balance - reserved - cashDue  (can be withdrawn)
// Grocery reimbursements (phase 32) are a second, separate balance
// built the same way from store_payments + shopper_payouts kind
// 'reimbursement': released = owed + reimbursed bills (delivered,
// bill approved, customer payment confirmed by the backend). They are
// never earnings; a withdrawal carries an earnings part and a
// reimbursement part, each paid out under its own payout kind.
// Owner's rules 2026-10-28: cash owed is deducted (from earnings
// first, then from the reimbursement); the minimum
// (settings.withdrawals.minAmount, LKR 500) applies to the withdrawal
// total; fee from settings (0); bank only; accounts verified by an
// admin first; reimbursements are paid only through withdrawals.
// Every change locks the shopper row, so two requests (or a request
// and an admin action) can't spend the same money.
// =====================================================

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

const OPEN_STATUSES = ['pending', 'approved', 'processing'];

const STATUS_LABELS = {
  pending: 'Pending',
  approved: 'Approved',
  processing: 'Processing',
  paid: 'Paid',
  rejected: 'Rejected',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// Licensed commercial banks + main specialised banks in Sri Lanka
const BANKS = [
  'Bank of Ceylon',
  "People's Bank",
  'Commercial Bank of Ceylon',
  'Hatton National Bank',
  'Sampath Bank',
  'Seylan Bank',
  'National Development Bank',
  'DFCC Bank',
  'Nations Trust Bank',
  'Pan Asia Bank',
  'Union Bank of Colombo',
  'Cargills Bank',
  'Amana Bank',
  'National Savings Bank',
  'Regional Development Bank',
  'HSBC',
  'Standard Chartered Bank',
  'Sanasa Development Bank',
  'Other',
];

const MAX_ACCOUNTS = 3;

const error = (status, message, code) => Object.assign(new Error(message), { status, code });

const withdrawalRules = async () => {
  const settings = await getPricingSettings();
  const rules = settings.withdrawals || {};

  return {
    minAmount: Number.isFinite(Number(rules.minAmount)) ? Number(rules.minAmount) : 500,
    fee: Number.isFinite(Number(rules.fee)) ? Number(rules.fee) : 0,
    method: 'bank',
  };
};

// ---------------------------------------------------
// Balances
// ---------------------------------------------------

const WALLET_SQL = `
  SELECT
    COALESCE((SELECT SUM(net_amount) FROM shopper_earnings WHERE shopper_id = $1 AND status IN ('payable', 'paid')), 0)::float AS released,
    COALESCE((SELECT SUM(net_amount) FROM shopper_earnings WHERE shopper_id = $1 AND status = 'awaiting_bills'), 0)::float AS awaiting,
    COALESCE((SELECT SUM(net_amount) FROM shopper_earnings WHERE shopper_id = $1 AND status = 'held'), 0)::float AS held,
    COALESCE((SELECT SUM(net_amount) FROM shopper_earnings WHERE shopper_id = $1 AND status <> 'void'), 0)::float AS lifetime,
    COALESCE((SELECT SUM(amount) FROM shopper_payouts WHERE shopper_id = $1 AND kind = 'earnings'), 0)::float AS paid_out,
    COALESCE((SELECT SUM(earnings_amount) FROM shopper_withdrawals WHERE shopper_id = $1 AND status = ANY($2)), 0)::float AS reserved,
    COALESCE((SELECT SUM(reimbursement_amount) FROM shopper_withdrawals WHERE shopper_id = $1 AND status = ANY($2)), 0)::float AS reimb_reserved,
    COALESCE((SELECT SUM(earnings_amount) FROM shopper_withdrawals WHERE shopper_id = $1 AND status = 'paid'), 0)::float AS withdrawn,
    COALESCE((SELECT SUM(reimbursement_amount) FROM shopper_withdrawals WHERE shopper_id = $1 AND status = 'paid'), 0)::float AS reimb_withdrawn,
    COALESCE((SELECT SUM(cash_collected) FROM shopper_earnings WHERE shopper_id = $1 AND cash_status = 'due'), 0)::float AS cash_due,
    COALESCE((SELECT SUM(amount_paid) FROM store_payments WHERE shopper_id = $1 AND reimbursement_status IN ('owed', 'reimbursed')), 0)::float AS reimb_released,
    COALESCE((SELECT SUM(amount_paid) FROM store_payments WHERE shopper_id = $1 AND reimbursement_status = 'pending'), 0)::float AS reimb_pending,
    COALESCE((SELECT SUM(amount_paid) FROM store_payments WHERE shopper_id = $1 AND reimbursement_status = 'held'), 0)::float AS reimb_held,
    COALESCE((SELECT SUM(amount) FROM shopper_payouts WHERE shopper_id = $1 AND kind = 'reimbursement'), 0)::float AS reimb_paid_out
`;

// Cash owed comes out of the earnings first, then the reimbursement
const splitCash = (cashDue, earningsFree, reimbursementFree) => {
  const fromEarnings = Math.min(cashDue, Math.max(0, earningsFree));
  const fromReimbursement = Math.min(cashDue - fromEarnings, Math.max(0, reimbursementFree));

  return {
    fromEarnings: round2(fromEarnings),
    fromReimbursement: round2(fromReimbursement),
    shortfall: round2(Math.max(0, cashDue - fromEarnings - fromReimbursement)),
  };
};

const walletFor = async (shopperId, client = pool) => {
  const row = (await client.query(WALLET_SQL, [Number(shopperId), OPEN_STATUSES])).rows[0];
  const balance = round2(row.released - row.paid_out);
  const reimbursementBalance = round2(row.reimb_released - row.reimb_paid_out);
  const earningsFree = round2(balance - row.reserved);
  const reimbursementFree = round2(reimbursementBalance - row.reimb_reserved);
  const cash = splitCash(round2(row.cash_due), earningsFree, reimbursementFree);
  const availableEarnings = round2(Math.max(0, earningsFree - cash.fromEarnings));
  const availableReimbursement = round2(Math.max(0, reimbursementFree - cash.fromReimbursement));

  return {
    // Total that can be withdrawn now (earnings + grocery reimbursement)
    available: round2(availableEarnings + availableReimbursement),
    availableEarnings,
    availableReimbursement,
    // Cash owed to GetMe that neither balance covers (deposit it)
    cashShortfall: cash.shortfall,
    cashDue: round2(row.cash_due),
    cashFromEarnings: cash.fromEarnings,
    cashFromReimbursement: cash.fromReimbursement,

    // ---- Earnings ----
    // Released (bills approved) not yet paid out
    balance,
    // Earnings part of open withdrawals
    reserved: round2(row.reserved),
    // Delivered, waiting for the store bills to be approved
    pending: round2(row.awaiting),
    // On hold (dispute)
    held: round2(row.held),
    totalEarnings: round2(row.lifetime),
    // Earnings paid out: withdrawals, cash settled from them, older
    // admin payouts
    totalWithdrawn: round2(row.paid_out),
    // Earnings part of withdrawals paid to the bank
    withdrawalsPaid: round2(row.withdrawn),

    // ---- Grocery reimbursement (not earnings) ----
    reimbursementBalance,
    reimbursementReserved: round2(row.reimb_reserved),
    // Waiting for delivery, the bill or the customer payment check
    reimbursementPending: round2(row.reimb_pending),
    // Being checked by GetMe (bill difference, query, duplicate, payment)
    reimbursementHeld: round2(row.reimb_held),
    // Paid out: withdrawals, cash settled from it, older admin transfers
    reimbursementPaid: round2(row.reimb_paid_out),
    reimbursementWithdrawalsPaid: round2(row.reimb_withdrawn),

    // Both parts of open withdrawals / bank transfers
    pendingWithdrawals: round2(row.reserved + row.reimb_reserved),
    totalPaidToBank: round2(row.withdrawn + row.reimb_withdrawn),
    currency: 'LKR',
  };
};

// ---------------------------------------------------
// Payout accounts
// ---------------------------------------------------

const toPublicAccount = (row, { full = false } = {}) => ({
  id: Number(row.id),
  method: row.method,
  bankName: row.bank_name,
  branchName: row.branch_name,
  accountHolderName: row.account_holder_name,
  accountLast4: row.account_last4,
  accountNumberMasked: `•••• ${row.account_last4}`,
  // Finance admins only (to make the transfer)
  ...(full ? { accountNumber: decryptAccountNumber(row.account_number_encrypted) } : {}),
  status: row.status,
  statusNote: row.status_note || null,
  isDefault: !!row.is_default,
  createdAt: row.created_at,
  reviewedAt: row.reviewed_at || null,
});

const listAccounts = async (shopperId, client = pool) =>
  (
    await client.query(
      'SELECT * FROM shopper_payout_accounts WHERE shopper_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, id',
      [Number(shopperId)]
    )
  ).rows.map((row) => toPublicAccount(row));

const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// { bankName, otherBankName, branchName, accountHolderName, accountNumber, accountNumberConfirm }
const parseAccountInput = (input) => {
  const bankName = cleanText(input?.bankName, 80);
  const otherBank = cleanText(input?.otherBankName, 80);
  const branchName = cleanText(input?.branchName, 80);
  const holder = cleanText(input?.accountHolderName, 120);
  const number = String(input?.accountNumber ?? '').replace(/[\s-]/g, '');
  const confirm = String(input?.accountNumberConfirm ?? input?.accountNumber ?? '').replace(/[\s-]/g, '');

  if (!BANKS.includes(bankName)) throw error(400, 'Choose your bank');
  if (bankName === 'Other' && otherBank.length < 3) throw error(400, 'Enter the name of your bank');
  if (branchName.length < 2) throw error(400, 'Enter your branch');
  if (holder.length < 3) throw error(400, 'Enter the name on the account');
  if (!/^\d{6,20}$/.test(number)) throw error(400, 'The account number should be 6 to 20 digits');
  if (number !== confirm) throw error(400, "The account numbers don't match");

  return { bankName, otherBank, branchName, holder, number, hash: hashAccountNumber(number) };
};

// Corrects the bank / branch / holder of a saved account that is not
// verified yet (same account number). A verified account is never
// edited: a different account is added instead.
const updatePendingAccountDetails = async (shopperId, accountId, input) => {
  const { bankName, otherBank, branchName, holder, hash } = parseAccountInput(input);
  const row = (
    await pool.query(
      `
      UPDATE shopper_payout_accounts
      SET bank_name = $4, branch_name = $5, account_holder_name = $6, updated_at = NOW()
      WHERE id = $1 AND shopper_id = $2 AND account_number_hash = $3 AND status = 'pending' AND deleted_at IS NULL
      RETURNING *
      `,
      [Number(accountId), Number(shopperId), hash, bankName === 'Other' ? otherBank : bankName, branchName, holder]
    )
  ).rows[0];

  return row ? toPublicAccount(row) : null;
};

// { bankName, branchName, accountHolderName, accountNumber, accountNumberConfirm }
const addAccount = async (shopperId, input) => {
  const { bankName, otherBank, branchName, holder, number } = parseAccountInput(input);

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM shoppers WHERE id = $1 FOR UPDATE', [Number(shopperId)]);

    const existing = (
      await client.query('SELECT id, account_number_hash FROM shopper_payout_accounts WHERE shopper_id = $1 AND deleted_at IS NULL', [Number(shopperId)])
    ).rows;

    const hash = hashAccountNumber(number);

    if (existing.some((row) => row.account_number_hash === hash)) {
      throw error(409, 'This account is already saved');
    }

    if (existing.length >= MAX_ACCOUNTS) {
      throw error(400, `You can save up to ${MAX_ACCOUNTS} bank accounts. Remove one first.`);
    }

    const row = (
      await client.query(
        `
        INSERT INTO shopper_payout_accounts (
          shopper_id, method, bank_name, branch_name, account_holder_name,
          account_number_encrypted, account_last4, account_number_hash, status, is_default
        )
        VALUES ($1, 'bank', $2, $3, $4, $5, $6, $7, 'pending', $8)
        RETURNING *
        `,
        [
          Number(shopperId),
          bankName === 'Other' ? otherBank : bankName,
          branchName,
          holder,
          encryptAccountNumber(number),
          number.slice(-4),
          hash,
          existing.length === 0,
        ]
      )
    ).rows[0];

    await client.query('COMMIT');

    return toPublicAccount(row);
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }
};

const removeAccount = async (shopperId, accountId) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM shoppers WHERE id = $1 FOR UPDATE', [Number(shopperId)]);

    const open = (
      await client.query(
        'SELECT 1 FROM shopper_withdrawals WHERE shopper_id = $1 AND payout_account_id = $2 AND status = ANY($3) LIMIT 1',
        [Number(shopperId), Number(accountId), OPEN_STATUSES]
      )
    ).rows.length > 0;

    if (open) {
      throw error(409, 'A withdrawal to this account is still open. Wait until it is paid or cancel it first.');
    }

    const removed = (
      await client.query(
        'UPDATE shopper_payout_accounts SET deleted_at = NOW(), is_default = FALSE, updated_at = NOW() WHERE id = $1 AND shopper_id = $2 AND deleted_at IS NULL RETURNING id',
        [Number(accountId), Number(shopperId)]
      )
    ).rows[0];

    if (!removed) throw error(404, 'Account not found');

    // Keep one default
    await client.query(
      `
      UPDATE shopper_payout_accounts SET is_default = TRUE
      WHERE id = (
        SELECT id FROM shopper_payout_accounts
        WHERE shopper_id = $1 AND deleted_at IS NULL
        ORDER BY (status = 'verified') DESC, id LIMIT 1
      )
      AND NOT EXISTS (SELECT 1 FROM shopper_payout_accounts WHERE shopper_id = $1 AND deleted_at IS NULL AND is_default)
      `,
      [Number(shopperId)]
    );

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }
};

const setDefaultAccount = async (shopperId, accountId) => {
  const found = (
    await pool.query('SELECT id FROM shopper_payout_accounts WHERE id = $1 AND shopper_id = $2 AND deleted_at IS NULL', [Number(accountId), Number(shopperId)])
  ).rows[0];

  if (!found) throw error(404, 'Account not found');

  await pool.query(
    'UPDATE shopper_payout_accounts SET is_default = (id = $2), updated_at = NOW() WHERE shopper_id = $1 AND deleted_at IS NULL',
    [Number(shopperId), Number(accountId)]
  );
};

// Admin: verify / reject an account (holder name checked against the shopper)
const reviewAccount = async (accountId, adminId, { action, note }) => {
  if (!['verify', 'reject'].includes(action)) throw error(400, 'Choose verify or reject');

  const reason = cleanText(note, 300);

  if (action === 'reject' && reason.length < 3) throw error(400, 'Give a reason for rejecting the account');

  const row = (
    await pool.query(
      `
      UPDATE shopper_payout_accounts
      SET status = $2, status_note = $3, reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *
      `,
      [Number(accountId), action === 'verify' ? 'verified' : 'rejected', reason || null, Number(adminId)]
    )
  ).rows[0];

  if (!row) throw error(404, 'Account not found');

  return row;
};

// ---------------------------------------------------
// Withdrawals
// ---------------------------------------------------

const toPublicWithdrawal = (row) => ({
  id: Number(row.id),
  shopperId: Number(row.shopper_id),
  amount: round2(row.amount),
  // The two parts (accounted separately: reimbursements aren't earnings)
  earningsAmount: round2(row.earnings_amount),
  reimbursementAmount: round2(row.reimbursement_amount),
  fee: round2(row.fee),
  payoutAmount: round2(row.payout_amount),
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
  method: 'bank',
  account: row.account_snapshot || null,
  payoutAccountId: row.payout_account_id != null ? Number(row.payout_account_id) : null,
  cashNetted: round2(row.cash_netted),
  cashNettedReimbursement: round2(row.cash_netted_reimbursement),
  reference: row.reference || null,
  reason: row.reason || null,
  requestedAt: row.requested_at,
  approvedAt: row.approved_at || null,
  paidAt: row.paid_at || null,
  closedAt: row.closed_at || null,
  updatedAt: row.updated_at,
});

const addEvent = (client, withdrawal, { action, from, to, actorType, actorId, note }) =>
  client.query(
    `
    INSERT INTO shopper_withdrawal_events (withdrawal_id, action, from_status, to_status, actor_type, actor_id, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [withdrawal, action, from, to, actorType, actorId, note ? String(note).slice(0, 300) : null]
  );

const listWithdrawals = async (shopperId, { limit = 50 } = {}) =>
  (
    await pool.query(
      'SELECT * FROM shopper_withdrawals WHERE shopper_id = $1 ORDER BY requested_at DESC, id DESC LIMIT $2',
      [Number(shopperId), Math.max(1, Math.min(200, Number(limit) || 50))]
    )
  ).rows.map(toPublicWithdrawal);

// At most 2 decimals (with a float tolerance: 2601.3 * 100 is not
// exactly 260130 in JavaScript)
const validMoney = (value, { allowZero = false } = {}) =>
  Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) && Math.abs(Math.round(value * 100) - value * 100) <= 1e-6;

// { earningsAmount, reimbursementAmount, payoutAccountId, requestId }
// (or the older { amount }: earnings first, then the reimbursement)
// -> { withdrawal, wallet, duplicate? }
const requestWithdrawal = async (shopperId, input) => {
  const split = input?.earningsAmount != null || input?.reimbursementAmount != null;
  const amountIn = Number(input?.amount);
  const earningsIn = split ? Number(input?.earningsAmount ?? 0) : null;
  const reimbursementIn = split ? Number(input?.reimbursementAmount ?? 0) : null;
  const accountId = Number(input?.payoutAccountId);
  const requestId = input?.requestId ? String(input.requestId).trim().slice(0, 64) : null;
  const rules = await withdrawalRules();

  if (split) {
    if (!validMoney(earningsIn, { allowZero: true }) || !validMoney(reimbursementIn, { allowZero: true })) {
      throw error(400, 'Enter valid amounts');
    }
  } else if (!validMoney(amountIn)) {
    throw error(400, 'Enter a valid amount');
  }

  const amount = split ? round2(earningsIn + reimbursementIn) : round2(amountIn);

  if (!(amount > 0)) {
    throw error(400, 'Enter a valid amount');
  }

  // The minimum is on the total (owner's rule)
  if (amount < rules.minAmount) {
    throw error(400, `The minimum withdrawal is LKR ${rules.minAmount.toFixed(2)}`, 'BELOW_MINIMUM');
  }

  if (round2(amount - rules.fee) <= 0) {
    throw error(400, 'The amount must be more than the withdrawal fee');
  }

  if (!Number.isInteger(accountId) || accountId <= 0) {
    throw error(400, 'Choose the bank account to pay');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // One request at a time per shopper (also against admin actions)
    const me = (await client.query('SELECT id, approval_status FROM shoppers WHERE id = $1 FOR UPDATE', [Number(shopperId)])).rows[0];

    // Only approved shoppers can withdraw (phase 34)
    if (me?.approval_status !== 'approved') {
      throw error(403, 'Withdrawals open once your shopper account is approved', 'NOT_APPROVED');
    }

    if (requestId) {
      const existing = (
        await client.query('SELECT * FROM shopper_withdrawals WHERE shopper_id = $1 AND client_request_id = $2', [Number(shopperId), requestId])
      ).rows[0];

      if (existing) {
        await client.query('COMMIT');
        return { withdrawal: toPublicWithdrawal(existing), wallet: await walletFor(shopperId), duplicate: true };
      }
    }

    const account = (
      await client.query(
        "SELECT * FROM shopper_payout_accounts WHERE id = $1 AND shopper_id = $2 AND deleted_at IS NULL AND status <> 'rejected'",
        [accountId, Number(shopperId)]
      )
    ).rows[0];

    if (!account) throw error(404, 'That bank account is not available. Add it again.');

    const wallet = await walletFor(shopperId, client);

    // Older clients send one amount: earnings first, then groceries
    const earningsAmount = split ? round2(earningsIn) : round2(Math.min(amount, wallet.availableEarnings));
    const reimbursementAmount = split ? round2(reimbursementIn) : round2(amount - earningsAmount);

    const short = (part, available, label) => {
      if (part > available + 0.0001) {
        throw error(
          409,
          available > 0
            ? `You can withdraw up to LKR ${available.toFixed(2)} of ${label}`
            : wallet.cashShortfall > 0
              ? `You owe GetMe LKR ${wallet.cashShortfall.toFixed(2)} in cash collected. Deposit it to withdraw.`
              : `No ${label} to withdraw yet`,
          'INSUFFICIENT_BALANCE'
        );
      }
    };

    short(earningsAmount, wallet.availableEarnings, 'earnings');
    short(reimbursementAmount, wallet.availableReimbursement, 'grocery reimbursement');

    const row = (
      await client.query(
        `
        INSERT INTO shopper_withdrawals (
          shopper_id, amount, earnings_amount, reimbursement_amount, fee, payout_amount, status,
          payout_account_id, account_snapshot, client_request_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
        RETURNING *
        `,
        [
          Number(shopperId),
          round2(amount),
          earningsAmount,
          reimbursementAmount,
          round2(rules.fee),
          round2(amount - rules.fee),
          account.id,
          {
            bankName: account.bank_name,
            branchName: account.branch_name,
            accountHolderName: account.account_holder_name,
            accountLast4: account.account_last4,
            accountVerified: account.status === 'verified',
          },
          requestId,
        ]
      )
    ).rows[0];

    await addEvent(client, row.id, { action: 'requested', from: null, to: 'pending', actorType: 'shopper', actorId: Number(shopperId) });
    await client.query('COMMIT');

    return { withdrawal: toPublicWithdrawal(row), wallet: await walletFor(shopperId) };
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});

    // Same request id raced in: answer with the first one
    if (caught.code === '23505' && requestId) {
      const existing = (
        await pool.query('SELECT * FROM shopper_withdrawals WHERE shopper_id = $1 AND client_request_id = $2', [Number(shopperId), requestId])
      ).rows[0];

      if (existing) return { withdrawal: toPublicWithdrawal(existing), wallet: await walletFor(shopperId), duplicate: true };
    }

    throw caught;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------
// Cash collected on cash orders, settled against the shopper's
// balances (earnings first, then the grocery reimbursement; owner's
// rule 2026-10-28). Used by a withdrawal payout and by a cash
// hand-over (recordCashSettlement). Booked so nothing counts twice:
//   cash_deposit   = all the cash still due      (GetMe got it back)
//   earnings       = the part offset by earnings
//   reimbursement  = the part offset by groceries
// whatever is left (handedOver) is the cash the shopper handed over.
// Caller holds the shopper lock.
// -> { cashNetted, fromEarnings, fromReimbursement, handedOver,
//      depositId, offsetEarningsPayoutId, offsetReimbursementPayoutId,
//      orderIds }
// ---------------------------------------------------
const settleCashDue = async (client, shopper, { earningsFree, reimbursementFree, reference, label, actorId, withdrawalId = null, settlementId = null }) => {
  const cash = (
    await client.query(
      "SELECT id, order_id, cash_collected FROM shopper_earnings WHERE shopper_id = $1 AND cash_status = 'due' FOR UPDATE",
      [shopper]
    )
  ).rows;

  const cashNetted = round2(cash.reduce((sum, item) => sum + Number(item.cash_collected), 0));
  const result = {
    cashNetted,
    fromEarnings: 0,
    fromReimbursement: 0,
    handedOver: 0,
    depositId: null,
    offsetEarningsPayoutId: null,
    offsetReimbursementPayoutId: null,
    orderIds: cash.map((item) => Number(item.order_id)),
  };

  if (cashNetted <= 0) return result;

  const parts = splitCash(cashNetted, earningsFree, reimbursementFree);
  result.fromEarnings = parts.fromEarnings;
  result.fromReimbursement = parts.fromReimbursement;
  result.handedOver = parts.shortfall;

  result.depositId = (
    await client.query(
      `INSERT INTO shopper_payouts (shopper_id, kind, amount, reference, note, created_by)
       VALUES ($1, 'cash_deposit', $2, $3, $4, $5) RETURNING id`,
      [
        shopper,
        cashNetted,
        reference,
        parts.shortfall > 0
          ? `Cash collected settled (${label}): LKR ${parts.shortfall.toFixed(2)} handed over, rest from the shopper's balance`
          : `Cash collected settled from the shopper's balance (${label})`,
        actorId,
      ]
    )
  ).rows[0].id;

  if (parts.fromEarnings > 0) {
    result.offsetEarningsPayoutId = (
      await client.query(
        `INSERT INTO shopper_payouts (shopper_id, kind, amount, reference, note, created_by)
         VALUES ($1, 'earnings', $2, $3, $4, $5) RETURNING id`,
        [shopper, parts.fromEarnings, reference, `Earnings used for cash collected (${label})`, actorId]
      )
    ).rows[0].id;
  }

  if (parts.fromReimbursement > 0) {
    result.offsetReimbursementPayoutId = (
      await client.query(
        `INSERT INTO shopper_payouts (shopper_id, kind, amount, reference, note, created_by)
         VALUES ($1, 'reimbursement', $2, $3, $4, $5) RETURNING id`,
        [shopper, parts.fromReimbursement, reference, `Grocery reimbursement used for cash collected (${label})`, actorId]
      )
    ).rows[0].id;
  }

  await client.query(
    `UPDATE shopper_earnings
     SET cash_status = $4::varchar, cash_payout_id = $2,
         cash_withdrawal_id = COALESCE($3::int, cash_withdrawal_id),
         cash_settlement_id = COALESCE($5::int, cash_settlement_id), updated_at = NOW()
     WHERE id = ANY($1)`,
    [
      cash.map((item) => item.id),
      result.depositId,
      withdrawalId,
      parts.fromEarnings + parts.fromReimbursement > 0 ? 'netted' : 'deposited',
      settlementId,
    ]
  );

  return result;
};

// Earnings rows / owed store bills fully covered by everything paid out
// so far (oldest first) become paid / reimbursed (balances unchanged:
// both statuses count as released). -> order ids reimbursed
const markCoveredRows = async (client, shopper, { earningsPayoutId = null, reimbursementPayoutId = null, actorId = null, reference = null, withdrawalId = null }) => {
  await client.query(
    `
    WITH paid_out AS (
      SELECT COALESCE(SUM(amount), 0) AS total FROM shopper_payouts WHERE shopper_id = $1 AND kind = 'earnings'
    ),
    already AS (
      SELECT COALESCE(SUM(net_amount), 0) AS total FROM shopper_earnings WHERE shopper_id = $1 AND status = 'paid'
    ),
    open AS (
      SELECT id, SUM(net_amount) OVER (ORDER BY created_at, id) AS running
      FROM shopper_earnings
      WHERE shopper_id = $1 AND status = 'payable'
    )
    UPDATE shopper_earnings se
    SET status = 'paid', paid_at = NOW(), payout_id = $2, updated_at = NOW()
    FROM open, paid_out, already
    WHERE se.id = open.id AND open.running <= paid_out.total - already.total + 0.005
    `,
    [shopper, earningsPayoutId]
  );

  const reimbursedOrders = (
    await client.query(
      `
      WITH paid_out AS (
        SELECT COALESCE(SUM(amount), 0) AS total FROM shopper_payouts WHERE shopper_id = $1 AND kind = 'reimbursement'
      ),
      already AS (
        SELECT COALESCE(SUM(amount_paid), 0) AS total FROM store_payments WHERE shopper_id = $1 AND reimbursement_status = 'reimbursed'
      ),
      open AS (
        SELECT id, SUM(amount_paid) OVER (ORDER BY created_at, id) AS running
        FROM store_payments
        WHERE shopper_id = $1 AND reimbursement_status = 'owed'
      )
      UPDATE store_payments sp
      SET reimbursement_status = 'reimbursed', reimbursed_at = NOW(), reimbursed_by = $3,
          reimbursement_reference = $4, payout_id = $2, reimbursement_withdrawal_id = $5, updated_at = NOW()
      FROM open, paid_out, already
      WHERE sp.id = open.id AND open.running <= paid_out.total - already.total + 0.005
      RETURNING sp.order_id
      `,
      [shopper, reimbursementPayoutId, actorId, reference, withdrawalId]
    )
  ).rows.map((item) => Number(item.order_id));

  // Order-level reimbursement columns follow the bills
  const { syncOrderReimbursement } = require('../controllers/storePaymentController');

  for (const orderId of [...new Set(reimbursedOrders)]) {
    await syncOrderReimbursement(client, orderId);
  }

  return reimbursedOrders;
};

// ---------------------------------------------------
// Status changes
//   shopper: cancel   pending -> cancelled
//   admin:   approve  pending -> approved      (account verified)
//            process  approved -> processing  (transfer started)
//            pay      approved|processing -> paid  (bank reference)
//            fail     approved|processing -> failed (reason)
//            reject   pending|approved -> rejected  (reason)
// rejected / failed / cancelled give the amount back to available.
// ---------------------------------------------------

const TRANSITIONS = {
  cancel: { from: ['pending'], to: 'cancelled', actor: 'shopper' },
  approve: { from: ['pending'], to: 'approved', actor: 'admin' },
  process: { from: ['approved'], to: 'processing', actor: 'admin' },
  pay: { from: ['approved', 'processing'], to: 'paid', actor: 'admin' },
  fail: { from: ['approved', 'processing'], to: 'failed', actor: 'admin' },
  reject: { from: ['pending', 'approved'], to: 'rejected', actor: 'admin' },
};

const changeWithdrawal = async (withdrawalId, action, { actorType, actorId, shopperId = null, reference, reason }) => {
  const rule = TRANSITIONS[action];

  if (!rule || rule.actor !== actorType) throw error(400, 'Unknown action');

  const cleanReason = cleanText(reason, 300);
  // shopper_payouts.reference is VARCHAR(60)
  const cleanReference = cleanText(reference, 60);

  if (['reject', 'fail'].includes(action) && cleanReason.length < 3) {
    throw error(400, action === 'reject' ? 'Give a reason for rejecting it' : 'Give the reason the payment failed');
  }

  if (action === 'pay' && cleanReference.length < 4) {
    throw error(400, 'Enter the bank transfer reference');
  }

  // A money amount ("1,000.00", "1000.50", "12,500") is not a bank reference
  if (action === 'pay' && /^(\d[\d\s,]*\.\d{1,2}|\d{1,3}(,\d{3})+)$/.test(cleanReference)) {
    throw error(400, 'That looks like the amount. Enter the reference from the bank transfer receipt', 'REFERENCE_LOOKS_LIKE_AMOUNT');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const peek = (await client.query('SELECT shopper_id FROM shopper_withdrawals WHERE id = $1', [Number(withdrawalId)])).rows[0];

    if (!peek || (shopperId != null && Number(peek.shopper_id) !== Number(shopperId))) {
      throw error(404, 'Withdrawal not found');
    }

    // Shopper row first (same lock order as requests), then the withdrawal
    await client.query('SELECT id FROM shoppers WHERE id = $1 FOR UPDATE', [peek.shopper_id]);
    const row = (await client.query('SELECT * FROM shopper_withdrawals WHERE id = $1 FOR UPDATE', [Number(withdrawalId)])).rows[0];

    if (!rule.from.includes(row.status)) {
      throw error(409, `This withdrawal is ${STATUS_LABELS[row.status].toLowerCase()} - it can't be ${{ cancel: 'cancelled', approve: 'approved', process: 'marked processing', pay: 'marked paid', fail: 'marked failed', reject: 'rejected' }[action]}`, 'WRONG_STATUS');
    }

    if (['approve', 'pay'].includes(action)) {
      const account = row.payout_account_id
        ? (await client.query('SELECT status, deleted_at FROM shopper_payout_accounts WHERE id = $1', [row.payout_account_id])).rows[0]
        : null;

      if (!account || account.status !== 'verified') {
        throw error(409, 'Verify the bank account before approving or paying this withdrawal', 'ACCOUNT_NOT_VERIFIED');
      }
    }

    let cashNetted = 0;
    let cashNettedReimbursement = 0;
    let reimbursedOrders = [];
    const shopper = Number(row.shopper_id);

    if (action === 'pay') {
      const earningsPart = round2(row.earnings_amount);
      const reimbursementPart = round2(row.reimbursement_amount);

      // Still covered? (a dispute or a queried bill could have taken
      // money back). Reserved includes this withdrawal.
      const wallet = await walletFor(shopper, client);
      const earningsFree = round2(wallet.balance - wallet.reserved);
      const reimbursementFree = round2(wallet.reimbursementBalance - wallet.reimbursementReserved);
      const free = round2(earningsFree + reimbursementFree - wallet.cashDue);

      if (earningsFree < -0.009 || reimbursementFree < -0.009 || free < -0.009) {
        const shortBy = Math.max(-earningsFree, -reimbursementFree, -free);
        throw error(409, `The shopper's balance no longer covers this (short by LKR ${shortBy.toFixed(2)}). Reject it or wait.`, 'BALANCE_CHANGED');
      }

      const taken = (
        await client.query("SELECT 1 FROM shopper_payouts WHERE kind IN ('earnings', 'reimbursement') AND reference = $1", [cleanReference])
      ).rows.length > 0;

      if (taken) throw error(409, 'That bank reference is already recorded', 'REFERENCE_USED');

      // The transfer itself: one bank transfer, booked as two payouts
      // (earnings / grocery reimbursement) with the same bank reference
      const destination = `Withdrawal #${row.id} to ${row.account_snapshot?.bankName || 'bank'} •••• ${row.account_snapshot?.accountLast4 || ''}`;
      let earningsPayoutId = null;
      let reimbursementPayoutId = null;

      if (earningsPart > 0) {
        earningsPayoutId = (
          await client.query(
            `INSERT INTO shopper_payouts (shopper_id, kind, amount, reference, note, created_by)
             VALUES ($1, 'earnings', $2, $3, $4, $5) RETURNING id`,
            [shopper, earningsPart, cleanReference, destination, actorId]
          )
        ).rows[0].id;
      }

      if (reimbursementPart > 0) {
        reimbursementPayoutId = (
          await client.query(
            `INSERT INTO shopper_payouts (shopper_id, kind, amount, reference, note, created_by)
             VALUES ($1, 'reimbursement', $2, $3, $4, $5) RETURNING id`,
            [shopper, reimbursementPart, cleanReference, `${destination} (grocery reimbursement)`, actorId]
          )
        ).rows[0].id;
      }

      // Cash still owed to GetMe is settled out of what is left:
      // earnings first, then the grocery reimbursement
      const cash = await settleCashDue(client, shopper, {
        earningsFree,
        reimbursementFree,
        reference: `NETTED-W${row.id}`,
        label: `withdrawal #${row.id}`,
        actorId,
        withdrawalId: row.id,
      });

      cashNetted = cash.cashNetted;
      cashNettedReimbursement = cash.fromReimbursement;

      // Earnings rows / store bills fully covered by everything paid out
      // so far (oldest first) are marked paid / reimbursed
      reimbursedOrders = await markCoveredRows(client, shopper, {
        earningsPayoutId,
        reimbursementPayoutId,
        actorId,
        reference: cleanReference,
        withdrawalId: row.id,
      });
    }

    const updated = (
      await client.query(
        `
        UPDATE shopper_withdrawals
        SET status = $2::varchar,
            reference = CASE WHEN $2::varchar = 'paid' THEN $3::varchar ELSE reference END,
            reason = CASE WHEN $2::varchar IN ('rejected', 'failed') THEN $4::varchar ELSE reason END,
            cash_netted = CASE WHEN $2::varchar = 'paid' THEN $5::numeric ELSE cash_netted END,
            cash_netted_reimbursement = CASE WHEN $2::varchar = 'paid' THEN $7::numeric ELSE cash_netted_reimbursement END,
            approved_at = CASE WHEN $2::varchar = 'approved' THEN NOW() ELSE approved_at END,
            approved_by = CASE WHEN $2::varchar = 'approved' THEN $6::int ELSE approved_by END,
            paid_at = CASE WHEN $2::varchar = 'paid' THEN NOW() ELSE paid_at END,
            paid_by = CASE WHEN $2::varchar = 'paid' THEN $6::int ELSE paid_by END,
            closed_at = CASE WHEN $2::varchar IN ('rejected', 'failed', 'cancelled') THEN NOW() ELSE closed_at END,
            closed_by = CASE WHEN $2::varchar IN ('rejected', 'failed') THEN $6::int ELSE closed_by END,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
        `,
        [row.id, rule.to, cleanReference || null, cleanReason || null, cashNetted, actorType === 'admin' ? actorId : null, cashNettedReimbursement]
      )
    ).rows[0];

    await addEvent(client, row.id, {
      action,
      from: row.status,
      to: rule.to,
      actorType,
      actorId,
      note:
        action === 'pay'
          ? `Reference ${cleanReference}; earnings LKR ${round2(row.earnings_amount).toFixed(2)} + groceries LKR ${round2(row.reimbursement_amount).toFixed(2)}${cashNetted > 0 ? `; cash owed settled LKR ${cashNetted.toFixed(2)}` : ''}`
          : cleanReason || null,
    });

    await client.query('COMMIT');

    return { withdrawal: toPublicWithdrawal(updated), wallet: await walletFor(shopper), from: row.status, reimbursedOrders };
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});

    if (caught.code === '23505') {
      throw error(409, 'That bank reference is already recorded', 'REFERENCE_USED');
    }

    throw caught;
  } finally {
    client.release();
  }
};

// Recent wallet activity: released earnings + withdrawals
const walletActivity = async (shopperId, { limit = 30 } = {}) => {
  const rows = (
    await pool.query(
      `
      SELECT * FROM (
        SELECT 'earning' AS type, se.order_id AS ref_id, se.net_amount::float AS amount, se.status,
               COALESCE(se.paid_at, se.updated_at, se.created_at) AS at,
               se.delivery_fee::float AS delivery_fee, se.priority_fee::float AS priority_fee,
               se.service_fee::float AS service_fee, se.tip::float AS tip, se.adjustment::float AS adjustment
        FROM shopper_earnings se
        WHERE se.shopper_id = $1 AND se.status <> 'void'
        UNION ALL
        SELECT 'withdrawal', w.id, -w.amount::float, w.status, w.requested_at,
               NULL, NULL, NULL, NULL, NULL
        FROM shopper_withdrawals w
        WHERE w.shopper_id = $1
      ) activity
      ORDER BY at DESC
      LIMIT $2
      `,
      [Number(shopperId), Math.max(1, Math.min(100, Number(limit) || 30))]
    )
  ).rows;

  return rows.map((row) => ({
    type: row.type,
    orderId: row.type === 'earning' ? Number(row.ref_id) : null,
    withdrawalId: row.type === 'withdrawal' ? Number(row.ref_id) : null,
    amount: round2(row.amount),
    status: row.status,
    at: row.at,
    breakdown:
      row.type === 'earning'
        ? { delivery: round2(row.delivery_fee), priority: round2(row.priority_fee), service: round2(row.service_fee), tip: round2(row.tip), adjustment: round2(row.adjustment) }
        : null,
  }));
};

// ---------------------------------------------------
// Earnings changes by admins (hold / adjust) must not take back money the
// shopper already withdrew or has requested. Runs `change(client)` with
// the shopper locked, then checks the wallet still covers what was paid
// out + open requests; rolls back with 409 ALREADY_WITHDRAWN if not.
// ---------------------------------------------------
const changeEarningsSafely = async (shopperId, change) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM shoppers WHERE id = $1 FOR UPDATE', [Number(shopperId)]);

    const before = await walletFor(shopperId, client);
    const result = await change(client);

    if (result) {
      const after = await walletFor(shopperId, client);

      if (after.balance < after.reserved - 0.005) {
        const room = round2(Math.max(0, before.balance - before.reserved));
        throw error(
          409,
          `The shopper has already withdrawn or requested part of these earnings. Only LKR ${room.toFixed(2)} of their released earnings can still be held or taken off.`,
          'ALREADY_WITHDRAWN'
        );
      }
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------
// COD cash hand-over (phase 33, owner's choice 2026-10-28): the shopper
// hands over only what they owe after their released earnings and
// approved grocery reimbursements (wallet.cashShortfall); a finance
// admin records that amount, and all the cash still due is settled
// (settleCashDue books the offsets as separate payouts).
// { amount, reference, note, requestId } -> { settlement, wallet, duplicate? }
// amount must equal what is owed now (409 AMOUNT_CHANGED otherwise),
// so a stale screen can't settle the wrong amount.
// ---------------------------------------------------
const toPublicCashSettlement = (row) => ({
  id: Number(row.id),
  shopperId: Number(row.shopper_id),
  cashDue: round2(row.cash_due),
  handedOver: round2(row.handed_over),
  offsetEarnings: round2(row.offset_earnings),
  offsetReimbursement: round2(row.offset_reimbursement),
  reference: row.reference || null,
  note: row.note || null,
  createdBy: row.created_by != null ? Number(row.created_by) : null,
  createdAt: row.created_at,
});

const recordCashSettlement = async (shopperId, input, adminId) => {
  const amount = Number(input?.amount);
  const reference = cleanText(input?.reference, 60);
  const note = cleanText(input?.note, 300) || null;
  const requestId = input?.requestId ? String(input.requestId).trim().slice(0, 64) : null;

  if (!validMoney(amount, { allowZero: true })) {
    throw error(400, 'Enter the amount of cash handed over');
  }

  if (amount > 0 && reference.length < 3) {
    throw error(400, 'Enter the cash receipt or deposit slip number');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM shoppers WHERE id = $1 FOR UPDATE', [Number(shopperId)]);

    if (requestId) {
      const existing = (
        await client.query('SELECT * FROM cash_settlements WHERE shopper_id = $1 AND client_request_id = $2', [Number(shopperId), requestId])
      ).rows[0];

      if (existing) {
        await client.query('COMMIT');
        return { settlement: toPublicCashSettlement(existing), wallet: await walletFor(shopperId), duplicate: true };
      }
    }

    const wallet = await walletFor(shopperId, client);

    if (!(wallet.cashDue > 0)) {
      throw error(409, 'This shopper has no cash to hand over', 'NOTHING_DUE');
    }

    if (Math.abs(amount - wallet.cashShortfall) > 0.009) {
      throw error(
        409,
        `The shopper should hand over LKR ${wallet.cashShortfall.toFixed(2)} now (their balances changed). Check and record that amount.`,
        'AMOUNT_CHANGED'
      );
    }

    const earningsFree = round2(wallet.balance - wallet.reserved);
    const reimbursementFree = round2(wallet.reimbursementBalance - wallet.reimbursementReserved);
    const parts = splitCash(wallet.cashDue, earningsFree, reimbursementFree);

    const row = (
      await client.query(
        `
        INSERT INTO cash_settlements (
          shopper_id, cash_due, handed_over, offset_earnings, offset_reimbursement,
          reference, note, client_request_id, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        `,
        [
          Number(shopperId),
          wallet.cashDue,
          parts.shortfall,
          parts.fromEarnings,
          parts.fromReimbursement,
          amount > 0 ? reference : null,
          note,
          requestId,
          adminId,
        ]
      )
    ).rows[0];

    const cash = await settleCashDue(client, Number(shopperId), {
      earningsFree,
      reimbursementFree,
      reference: `CS${row.id}`,
      label: `cash hand-over #${row.id}${amount > 0 ? `, receipt ${reference}` : ''}`,
      actorId: adminId,
      settlementId: row.id,
    });

    // Same amounts as recorded above (same lock, same balances)
    if (Math.abs(cash.cashNetted - wallet.cashDue) > 0.009 || Math.abs(cash.handedOver - amount) > 0.009) {
      throw error(409, 'The cash owed changed while recording. Try again.', 'AMOUNT_CHANGED');
    }

    await markCoveredRows(client, Number(shopperId), {
      earningsPayoutId: cash.offsetEarningsPayoutId,
      reimbursementPayoutId: cash.offsetReimbursementPayoutId,
      actorId: adminId,
      reference: `CS${row.id}`,
    });

    await client.query('COMMIT');

    return { settlement: toPublicCashSettlement(row), wallet: await walletFor(shopperId), orderIds: cash.orderIds };
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});

    if (caught.code === '23505') {
      if (requestId) {
        const existing = (
          await pool.query('SELECT * FROM cash_settlements WHERE shopper_id = $1 AND client_request_id = $2', [Number(shopperId), requestId])
        ).rows[0];

        if (existing) return { settlement: toPublicCashSettlement(existing), wallet: await walletFor(shopperId), duplicate: true };
      }

      throw error(409, 'That receipt number is already recorded', 'REFERENCE_USED');
    }

    throw caught;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------
// Cash orders, one row per order (shopper app + admin): what the
// customer paid at the door and who it belongs to. The GetMe fee is
// paid by the customer (inside the cash), never taken from earnings:
//   cash collected = groceries + fees + GetMe fee + tip (less refunds)
//   shopper's share = earnings (fees + 100% tip) + groceries paid
//   for GetMe = cash collected - shopper's share (mostly the GetMe fee)
// shopperId null = every shopper (admin).
// ---------------------------------------------------
const CASH_STATUS = {
  due: 'To hand over',
  netted: 'Settled',
  deposited: 'Handed over',
};

const cashOrders = async (shopperId = null, { limit = 50 } = {}) =>
  (
    await pool.query(
      `
      SELECT
        se.order_id, se.shopper_id, sh.full_name AS shopper_name,
        se.cash_collected, se.cash_status, se.net_amount, se.status AS earnings_status, se.tip,
        se.cash_withdrawal_id, se.cash_settlement_id,
        o.getme_fee_kept, o.getme_fee_percent, o.total_amount, o.delivered_at, o.status AS order_status,
        COALESCE(sp.paid, 0)::float AS groceries,
        COALESCE(sp.released, 0)::float AS groceries_released,
        cs.created_at AS handed_over_at, cs.reference AS handover_reference,
        w.paid_at AS withdrawal_paid_at
      FROM shopper_earnings se
      JOIN orders o ON o.id = se.order_id
      LEFT JOIN shoppers sh ON sh.id = se.shopper_id
      LEFT JOIN LATERAL (
        SELECT SUM(amount_paid) AS paid,
               SUM(amount_paid) FILTER (WHERE reimbursement_status IN ('owed', 'reimbursed')) AS released
        FROM store_payments WHERE order_id = se.order_id
      ) sp ON TRUE
      LEFT JOIN cash_settlements cs ON cs.id = se.cash_settlement_id
      LEFT JOIN shopper_withdrawals w ON w.id = se.cash_withdrawal_id
      WHERE se.cash_collected > 0 AND ($1::int IS NULL OR se.shopper_id = $1::int)
      ORDER BY (se.cash_status = 'due') DESC, o.delivered_at DESC NULLS LAST, se.order_id DESC
      LIMIT $2
      `,
      [shopperId == null ? null : Number(shopperId), Math.max(1, Math.min(200, Number(limit) || 50))]
    )
  ).rows.map((row) => {
    const cash = round2(row.cash_collected);
    const earnings = round2(row.net_amount);
    const groceries = round2(row.groceries);

    return {
      orderId: Number(row.order_id),
      shopperId: Number(row.shopper_id),
      shopperName: row.shopper_name || null,
      deliveredAt: row.delivered_at,
      cashCollected: cash,
      // GetMe's fee on this order (paid by the customer, in the cash)
      getmeFee: round2(row.getme_fee_kept),
      getmeFeePercent: Number(row.getme_fee_percent ?? 0),
      earnings,
      tip: round2(row.tip),
      earningsStatus: row.earnings_status,
      groceries,
      groceriesReleased: round2(row.groceries_released),
      // What this order leaves for GetMe once the shopper keeps their
      // earnings and groceries (the GetMe fee +/- any till difference)
      forGetme: round2(cash - earnings - groceries),
      status: row.cash_status,
      statusLabel: CASH_STATUS[row.cash_status] || row.cash_status,
      settledBy: row.cash_settlement_id
        ? { type: 'handover', id: Number(row.cash_settlement_id), at: row.handed_over_at, reference: row.handover_reference || null }
        : row.cash_withdrawal_id
          ? { type: 'withdrawal', id: Number(row.cash_withdrawal_id), at: row.withdrawal_paid_at }
          : null,
    };
  });

const listCashSettlements = async (shopperId = null, { limit = 30 } = {}) =>
  (
    await pool.query(
      'SELECT * FROM cash_settlements WHERE ($1::int IS NULL OR shopper_id = $1::int) ORDER BY created_at DESC, id DESC LIMIT $2',
      [shopperId == null ? null : Number(shopperId), Math.max(1, Math.min(200, Number(limit) || 30))]
    )
  ).rows.map(toPublicCashSettlement);

// Grocery reimbursement not yet withdrawn or requested (an admin can't
// query / hold more than this once it is released)
const reimbursementRoom = async (shopperId, client = pool) => {
  const wallet = await walletFor(shopperId, client);

  return round2(wallet.reimbursementBalance - wallet.reimbursementReserved);
};

// ---------------------------------------------------
// Reimbursement history (one row per order + shop the shopper paid)
// ---------------------------------------------------

const reimbursementStatus = (row) => {
  if (row.reimbursement_status === 'reimbursed') {
    return { status: 'paid', label: 'Paid to your bank' };
  }

  if (row.reimbursement_status === 'owed') {
    return { status: 'available', label: 'Approved · ready to withdraw' };
  }

  if (row.reimbursement_status === 'held') {
    if (row.review_status === 'queried') return { status: 'rejected', label: 'Queried · check the note' };
    if (row.customer_payment_check === 'unconfirmed') return { status: 'held', label: 'Waiting for GetMe (customer payment)' };

    return { status: 'held', label: 'Being checked by GetMe' };
  }

  // pending
  if (!row.locked_at) return { status: 'pending', label: 'Upload the bill' };
  if (!['delivered', 'cancelled'].includes(row.order_status)) return { status: 'pending', label: 'Waiting for delivery' };

  return { status: 'pending', label: 'Being verified' };
};

const reimbursementHistory = async (shopperId, { limit = 50 } = {}) =>
  (
    await pool.query(
      `
      SELECT sp.*, s.shop_name, o.status AS order_status
      FROM store_payments sp
      LEFT JOIN shops s ON s.id = sp.shop_id
      LEFT JOIN orders o ON o.id = sp.order_id
      WHERE sp.shopper_id = $1
      ORDER BY sp.created_at DESC, sp.id DESC
      LIMIT $2
      `,
      [Number(shopperId), Math.max(1, Math.min(200, Number(limit) || 50))]
    )
  ).rows.map((row) => {
    const state = reimbursementStatus(row);
    const approved = ['owed', 'reimbursed'].includes(row.reimbursement_status);

    return {
      id: Number(row.id),
      orderId: Number(row.order_id),
      shopId: Number(row.shop_id),
      shopName: row.shop_name || null,
      method: row.method,
      // What the till charged (from the receipt the shopper recorded)
      receiptAmount: round2(row.amount_paid),
      expectedAmount: round2(row.expected_amount),
      // Approved = the receipt amount once verified (null until then)
      approvedAmount: approved ? round2(row.amount_paid) : null,
      status: state.status,
      statusLabel: state.label,
      note: row.review_status === 'queried' ? row.review_note : null,
      reference: row.reimbursement_reference || null,
      reimbursedAt: row.reimbursed_at || null,
      withdrawalId: row.reimbursement_withdrawal_id != null ? Number(row.reimbursement_withdrawal_id) : null,
      recordedAt: row.created_at,
    };
  });

module.exports = {
  recordCashSettlement,
  cashOrders,
  listCashSettlements,
  changeEarningsSafely,
  reimbursementRoom,
  reimbursementHistory,
  BANKS,
  STATUS_LABELS,
  OPEN_STATUSES,
  withdrawalRules,
  walletFor,
  walletActivity,
  listAccounts,
  addAccount,
  updatePendingAccountDetails,
  removeAccount,
  setDefaultAccount,
  reviewAccount,
  toPublicAccount,
  toPublicWithdrawal,
  listWithdrawals,
  requestWithdrawal,
  changeWithdrawal,
};
