const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const loginRateLimit = require('../middleware/loginRateLimit');
const { allowRoles, auditAdminChanges } = require('../middleware/adminAccess');

const account = require('../controllers/admin/adminAccountController');
const { getDashboard } = require('../controllers/admin/adminDashboardController');
const orders = require('../controllers/admin/adminOrderController');
const people = require('../controllers/admin/adminPeopleController');
const catalog = require('../controllers/admin/adminCatalogController');
const finance = require('../controllers/admin/adminFinanceController');
const storePayments = require('../controllers/storePaymentController');
const settlements = require('../controllers/settlementController');
const settings = require('../controllers/admin/adminSettingsController');
const promos = require('../controllers/admin/adminPromoController');
const offers = require('../controllers/admin/adminOfferController');
const ops = require('../controllers/admin/adminOpsController');
const insights = require('../controllers/admin/adminInsightsController');

const router = express.Router();

// =====================================================
// PUBLIC: login only
// =====================================================

router.post('/auth/login', loginRateLimit, account.login);

// =====================================================
// EVERYTHING BELOW REQUIRES AN ADMIN TOKEN
// Roles (middleware/adminAccess.js): owner always passes;
//   OPS      operations staff (orders, shoppers, shops, catalog)
//   MONEY    finance staff (payments, refunds, payouts, ledger)
//   INSIGHT  reports for operations + finance
// Routes without a guard are read-only views every role may open.
// Every successful change is written to admin_audit_log.
// =====================================================

router.use(requireAdmin);
router.use(auditAdminChanges);

const OWNER = allowRoles();
const OPS = allowRoles('operations');
const MONEY = allowRoles('finance');
const INSIGHT = allowRoles('operations', 'finance');

// Account (own) + admin users (owner)
router.get('/auth/me', account.me);
router.put('/auth/password', account.changePassword);
router.get('/admins', OWNER, account.listAdmins);
router.post('/admins', OWNER, account.createAdmin);
router.patch('/admins/:id', OWNER, account.setAdminActive);
router.get('/audit-log', OWNER, ops.getAuditLog);

// Dashboard + operations
router.get('/dashboard', getDashboard);
router.get('/overview', ops.getOverview);
// Live map: customer addresses, shopper phones + positions
router.get('/operations/live', allowRoles('operations', 'support'), ops.getLiveOperations);
router.get('/issues', ops.getIssues);
router.get('/search', ops.search);

// Orders
router.get('/orders', orders.listOrders);
router.get('/orders/:id', orders.getOrder);
router.patch('/orders/:id/cancel', OPS, orders.cancelOrder);

// Customers
router.get('/customers', people.listCustomers);
router.get('/customers/:id', people.getCustomer);

// Shoppers
router.get('/shoppers', people.listShoppers);
router.get('/shoppers/:id', ops.getShopper);
router.patch('/shoppers/:id/approval', OPS, people.setShopperApproval);

// Shops + products
router.get('/shops', catalog.listShops);
router.get('/shops/:id', ops.getShop);
router.patch('/shops/:id/status', OPS, catalog.setShopStatus);
router.patch('/shops/:id/brand-color', OPS, catalog.setShopBrandColor);
router.get('/products', catalog.listProducts);
router.patch('/products/:id/availability', OPS, catalog.setProductAvailability);

// Shop offers (shops create them; admins can pause)
router.get('/offers', offers.listOffers);
router.patch('/offers/:id/pause', OPS, offers.setOfferPaused);

// Money + reports
router.get('/payments', MONEY, finance.listPayments);
router.patch('/orders/:id/refund', MONEY, orders.refundOrder);

// Shoppers' store bills: review differences, record reimbursements
router.get('/store-payments', MONEY, storePayments.listStorePayments);
router.patch('/store-payments/:id/review', MONEY, storePayments.reviewStorePayment);
router.patch('/store-payments/:id/reimburse', MONEY, storePayments.reimburseStorePayment);

// Shopper settlement: balances, payouts / cash deposits, disputes
router.get('/settlements', MONEY, settlements.listSettlements);
router.post('/settlements/shoppers/:shopperId/payouts', MONEY, settlements.recordPayout);
router.patch('/settlements/earnings/:orderId/dispute', MONEY, settlements.disputeEarning);
router.patch('/settlements/earnings/:orderId/resolve', MONEY, settlements.resolveEarning);
router.patch('/settlements/earnings/:orderId/adjust', MONEY, settlements.adjustEarning);

// Every money movement and accrual (finance_ledger view)
router.get('/ledger', MONEY, settlements.getLedger);
router.get('/finance/overview', MONEY, insights.getFinanceOverview);
router.get('/finance/reconciliation', MONEY, insights.getReconciliation);

// Reports + exports (the export checks its own dataset's roles)
router.get('/reports', INSIGHT, finance.getReports);
router.get('/analytics', INSIGHT, insights.getAnalytics);
router.get('/export/:dataset', INSIGHT, insights.exportDataset);

// Fees & pricing (owner changes them; finance + operations can read)
router.get('/settings/pricing', INSIGHT, settings.getPricing);
router.put('/settings/pricing', OWNER, settings.updatePricing);
router.post('/settings/pricing/preview', INSIGHT, settings.previewPricing);

// Promo codes (GetMe pays the discount)
router.get('/promos', promos.listPromos);
router.post('/promos', OPS, promos.createPromo);
router.patch('/promos/:id', OPS, promos.updatePromo);

module.exports = router;
