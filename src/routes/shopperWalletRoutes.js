const express = require('express');

const shopperAuthMiddleware = require('../middleware/shopperAuthMiddleware');
const wallet = require('../controllers/shopperWalletController');

const router = express.Router();

// =====================================================
// SHOPPER WALLET (/api/shopper/wallet)
// Earnings balance, bank accounts and withdrawal requests of the
// signed-in shopper only (controllers/shopperWalletController.js).
// =====================================================

const requireShopper = (req, res, next) =>
  shopperAuthMiddleware(req, res, () => {
    if (!req.shopper?.shopperId) {
      return res.status(401).json({ success: false, message: 'Invalid shopper token' });
    }

    next();
  });

router.get('/wallet', requireShopper, wallet.getWallet);
router.post('/wallet/withdrawals', requireShopper, wallet.requestWithdrawal);
router.patch('/wallet/withdrawals/:id/cancel', requireShopper, wallet.cancelWithdrawal);
router.post('/wallet/accounts', requireShopper, wallet.addAccount);
router.delete('/wallet/accounts/:id', requireShopper, wallet.removeAccount);
router.patch('/wallet/accounts/:id/default', requireShopper, wallet.makeDefaultAccount);

module.exports = router;
