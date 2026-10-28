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
const withdrawals = require('../controllers/admin/adminWithdrawalController');
const settings = require('../controllers/admin/adminSettingsController');
const promos = require('../controllers/admin/adminPromoController');
const offers = require('../controllers/admin/adminOfferController');
const pricing = require('../controllers/admin/adminPricingController');
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
const applicationsAdmin = require('../controllers/admin/adminShopperApplicationController');
const changeAdmin = require('../controllers/admin/adminShopperChangeController');
const registerAdmin = require('../controllers/admin/adminShopperRegistrationController');
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

// Pricing: price history, suspicious changes, missing prices, expired
// offers, shopper shelf-price reports (admins review, never set prices)
router.get('/pricing/overview', pricing.getOverview);
router.get('/pricing/reports', pricing.listReports);
router.patch('/pricing/reports/:id', INSIGHT, pricing.reviewReport);
router.get('/pricing/changes', pricing.listPriceChanges);
router.get('/pricing/expired-offers', pricing.listExpiredOffers);
router.get('/products/:id/price-history', pricing.getProductPriceHistory);

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
// COD cash hand-over, net of the shopper's balances (phase 33)
router.post('/settlements/shoppers/:shopperId/cash-settlements', MONEY, settlements.recordCashHandover);
// Shopper applications (phase 34): Support sees the list only;
// identity data + documents for Owner / Operations
router.get('/shopper-applications', allowRoles('operations', 'support'), applicationsAdmin.listApplications);
router.get('/shopper-applications/:id', OPS, applicationsAdmin.getApplication);
router.get('/shopper-applications/:id/documents/:docId', OPS, applicationsAdmin.getDocument);
router.patch('/shopper-applications/:id', OPS, applicationsAdmin.actOnApplication);
// Protected profile changes (phase 35): Owner / Operations only
router.get('/shopper-change-requests', OPS, changeAdmin.listRequests);
router.get('/shopper-change-requests/:id', OPS, changeAdmin.getRequest);
router.get('/shopper-change-requests/:id/documents/:docId', OPS, changeAdmin.getDocument);
router.patch('/shopper-change-requests/:id', OPS, changeAdmin.actOnRequest);
// Per-document review + verified vehicle history (phase 36)
router.patch('/shopper-applications/:id/documents/:docId', OPS, applicationsAdmin.reviewApplicationDocument);
router.patch('/shopper-change-requests/:id/documents/:docId', OPS, changeAdmin.reviewRequestDocument);
router.get('/shoppers/:id/vehicle-records', OPS, applicationsAdmin.getVehicleRecords);
// Admin-managed registration (phase 37)
router.post('/shopper-registrations', OPS, registerAdmin.registerShopper);
router.patch('/shopper-registrations/:applicationId/steps', OPS, registerAdmin.saveStep);
router.post('/shopper-registrations/:applicationId/documents', OPS, ...registerAdmin.uploadDocument);
router.post('/shopper-registrations/:applicationId/submit', OPS, registerAdmin.submit);
router.post('/shoppers/:id/activation-code', OPS, registerAdmin.activationCode);
router.patch('/shoppers/:id/vehicle-restriction', OPS, changeAdmin.setVehicleRestriction);
router.get('/shoppers/:id/profile-history', OPS, changeAdmin.getProfileHistory);
router.patch('/settlements/earnings/:orderId/dispute', MONEY, settlements.disputeEarning);
router.patch('/settlements/earnings/:orderId/resolve', MONEY, settlements.resolveEarning);
router.patch('/settlements/earnings/:orderId/adjust', MONEY, settlements.adjustEarning);

// Every money movement and accrual (finance_ledger view)
router.get('/ledger', MONEY, settlements.getLedger);

// Shopper withdrawals: requests, manual bank transfers, bank accounts
router.get('/withdrawals', MONEY, withdrawals.listWithdrawals);
router.get('/withdrawals/:id', MONEY, withdrawals.getWithdrawal);
router.patch('/withdrawals/:id', MONEY, withdrawals.changeWithdrawal);
router.get('/payout-accounts', MONEY, withdrawals.listPayoutAccounts);
router.patch('/payout-accounts/:id', MONEY, withdrawals.reviewPayoutAccount);
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
router.get('/settings/pricing/history', INSIGHT, settings.getPricingHistory);
router.delete('/settings/pricing/versions/:id', OWNER, settings.cancelScheduledPricing);

// Promo codes (GetMe pays the discount)
router.get('/promos', promos.listPromos);
router.post('/promos', OPS, promos.createPromo);
router.patch('/promos/:id', OPS, promos.updatePromo);

module.exports = router;
