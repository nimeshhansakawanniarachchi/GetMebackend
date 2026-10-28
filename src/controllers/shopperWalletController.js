const wallet = require('../wallet/shopperWallet');
const { emitToAdmins } = require('../realtime');

// =====================================================
// SHOPPER WALLET API (/api/shopper/wallet)
// The shopper's own earnings balance, bank accounts and withdrawal
// requests. Everything is scoped to the signed-in shopper; amounts
// and balances come from src/wallet/shopperWallet.js (never from the
// app). Payment is a manual bank transfer by GetMe finance.
// =====================================================

const shopperIdOf = (req) => Number(req.shopper?.shopperId);

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

// Admin pages + the shopper's other screens refresh
const announce = (req, shopperId, payload = {}) => {
  try {
    const io = req.app.get('io');
    if (!io) return;

    io.to(`shopper:${shopperId}`).emit('shopper-earnings-updated', { shopperId, ...payload });
    emitToAdmins(io, 'admin:withdrawal-updated', { shopperId, ...payload });
  } catch (error) {
    console.error('❌ WALLET SOCKET ERROR:', error.message);
  }
};

// GET /api/shopper/wallet
// -> { wallet, rules, accounts, withdrawals, activity, reimbursements, cashOrders, banks }
const getWallet = async (req, res) => {
  try {
    const shopperId = shopperIdOf(req);
    const [balances, rules, accounts, withdrawals, activity, reimbursements, cashOrders] = await Promise.all([
      wallet.walletFor(shopperId),
      wallet.withdrawalRules(),
      wallet.listAccounts(shopperId),
      wallet.listWithdrawals(shopperId, { limit: 50 }),
      wallet.walletActivity(shopperId, { limit: 30 }),
      // Grocery reimbursements, one per order + shop (not earnings)
      wallet.reimbursementHistory(shopperId, { limit: 50 }),
      // Cash orders: cash collected, GetMe fee (paid by the customer),
      // earnings, groceries, hand-over status (phase 33)
      wallet.cashOrders(shopperId, { limit: 50 }),
    ]);

    res.set('Cache-Control', 'no-store');

    return res.json({
      success: true,
      wallet: balances,
      rules,
      accounts,
      withdrawals,
      activity,
      reimbursements,
      cashOrders,
      banks: wallet.BANKS,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to load your wallet');
  }
};

// POST /api/shopper/wallet/withdrawals
//   { earningsAmount, reimbursementAmount, payoutAccountId, requestId }
//   (older apps: { amount, ... } = earnings first, then groceries)
const requestWithdrawal = async (req, res) => {
  try {
    const shopperId = shopperIdOf(req);
    const result = await wallet.requestWithdrawal(shopperId, req.body);

    if (!result.duplicate) {
      announce(req, shopperId, { withdrawalId: result.withdrawal.id, status: 'pending' });
    }

    return res.status(result.duplicate ? 200 : 201).json({
      success: true,
      duplicate: !!result.duplicate,
      message: result.duplicate ? 'Withdrawal already requested' : 'Withdrawal requested',
      withdrawal: result.withdrawal,
      wallet: result.wallet,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to request the withdrawal');
  }
};

// PATCH /api/shopper/wallet/withdrawals/:id/cancel (pending only)
const cancelWithdrawal = async (req, res) => {
  try {
    const shopperId = shopperIdOf(req);
    const result = await wallet.changeWithdrawal(Number(req.params.id), 'cancel', {
      actorType: 'shopper',
      actorId: shopperId,
      shopperId,
    });

    announce(req, shopperId, { withdrawalId: result.withdrawal.id, status: 'cancelled' });

    return res.json({ success: true, message: 'Withdrawal cancelled', withdrawal: result.withdrawal, wallet: result.wallet });
  } catch (error) {
    return sendError(res, error, 'Unable to cancel the withdrawal');
  }
};

// POST /api/shopper/wallet/accounts
//   { bankName, otherBankName?, branchName, accountHolderName, accountNumber, accountNumberConfirm }
const addAccount = async (req, res) => {
  try {
    const shopperId = shopperIdOf(req);
    const account = await wallet.addAccount(shopperId, req.body);

    announce(req, shopperId, { accountId: account.id, status: 'account_added' });

    return res.status(201).json({
      success: true,
      message: 'Bank account added. GetMe checks it before the first payment.',
      account,
      accounts: await wallet.listAccounts(shopperId),
    });
  } catch (error) {
    return sendError(res, error, 'Unable to add the bank account');
  }
};

// DELETE /api/shopper/wallet/accounts/:id
const removeAccount = async (req, res) => {
  try {
    const shopperId = shopperIdOf(req);
    await wallet.removeAccount(shopperId, Number(req.params.id));

    return res.json({ success: true, message: 'Bank account removed', accounts: await wallet.listAccounts(shopperId) });
  } catch (error) {
    return sendError(res, error, 'Unable to remove the bank account');
  }
};

// PATCH /api/shopper/wallet/accounts/:id/default
const makeDefaultAccount = async (req, res) => {
  try {
    const shopperId = shopperIdOf(req);
    await wallet.setDefaultAccount(shopperId, Number(req.params.id));

    return res.json({ success: true, accounts: await wallet.listAccounts(shopperId) });
  } catch (error) {
    return sendError(res, error, 'Unable to update the bank account');
  }
};

module.exports = {
  getWallet,
  requestWithdrawal,
  cancelWithdrawal,
  addAccount,
  removeAccount,
  makeDefaultAccount,
};
