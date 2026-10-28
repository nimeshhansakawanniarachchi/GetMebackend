const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const loginRateLimit = require('../middleware/loginRateLimit');
const { requirePermission, auditAdminChanges } = require('../middleware/adminAccess');
const approvals = require('../admin/approvals');
const notifications = require('../admin/notifications');

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
const support = require('../controllers/admin/adminSupportController');
const applicationsAdmin = require('../controllers/admin/adminShopperApplicationController');
const changeAdmin = require('../controllers/admin/adminShopperChangeController');
const registerAdmin = require('../controllers/admin/adminShopperRegistrationController');
const grocery = require('../controllers/groceryPaymentController').admin;

const router = express.Router();

// =====================================================
// PUBLIC: login only
// =====================================================

router.post('/auth/login', loginRateLimit, account.login);

// =====================================================
// EVERYTHING BELOW REQUIRES AN ADMIN TOKEN (phase 40)
// Every route names the permission it needs (src/admin/permissions.js;
// least privilege - no permission, no access). The Super Admin
// ('owner') has all of them. Denied attempts and every change are in
// admin_audit_log. High-risk money actions over the limits wait for the
// Super Admin (src/admin/approvals.js).
// =====================================================

router.use(requireAdmin);
router.use(auditAdminChanges);

const can = requirePermission;

// Own account
router.get('/auth/me', account.me);
router.put('/auth/password', account.changePassword);

// Notifications (phase 41): every signed-in admin, filtered to what
// their permissions and the role's notification categories allow
// (src/admin/notifications.js checks ownership on every change)
router.get('/notifications', notifications.listNotifications);
router.get('/notifications/summary', notifications.getSummary);
router.post('/notifications/read-all', notifications.markAllRead);
router.get('/notifications/preferences', notifications.getPreferences);
router.put('/notifications/preferences', notifications.updatePreferences);
router.get('/notifications/settings', can('security.settings'), notifications.getPolicy);
router.put('/notifications/settings', can('security.settings'), notifications.updatePolicy);
router.post('/notifications/:id/read', notifications.markRead);
router.post('/notifications/:id/unread', notifications.markUnread);
router.post('/notifications/:id/dismiss', notifications.dismiss);

// Staff, permissions, security (Super Admin)
router.get('/admins', can('admins.manage'), account.listAdmins);
router.post('/admins', can('admins.manage'), account.createAdmin);
router.patch('/admins/:id', can('admins.manage'), account.updateAdmin);
router.post('/admins/:id/reset-password', can('admins.manage'), account.resetPassword);
router.get('/permissions', can('admins.manage'), account.permissionCatalogue);
router.get('/security-settings', can('security.settings', 'finance.refund', 'finance.adjust'), account.getSecuritySettings);
router.put('/security-settings', can('security.settings'), account.updateSecuritySettings);
router.get('/audit-log', can('audit.view'), ops.getAuditLog);

// Approvals of high-risk money actions
router.get('/approvals', can('approvals.decide', 'finance.refund', 'finance.adjust'), approvals.listApprovals);
router.patch('/approvals/:id', can('approvals.decide'), approvals.decide);
router.post('/approvals/:id/cancel', can('finance.refund', 'finance.adjust'), approvals.cancel);

// Technical (Developer)
router.get('/system/health', can('system.health'), support.systemStatus);
router.get('/system/errors', can('system.logs'), support.systemErrors);

// Dashboard + operations
router.get('/dashboard', can('dashboard.view'), getDashboard);
router.get('/overview', can('dashboard.view'), ops.getOverview);
// Live map: customer addresses, shopper phones + positions
router.get('/operations/live', can('liveops.view'), ops.getLiveOperations);
router.get('/issues', can('dashboard.view'), ops.getIssues);
router.get('/search', can('dashboard.view'), ops.search);

// Orders
router.get('/orders', can('orders.view'), orders.listOrders);
router.get('/orders/:id', can('orders.view'), orders.getOrder);
router.patch('/orders/:id/cancel', can('orders.cancel'), orders.cancelOrder);
router.get('/orders/:id/notes', can('orders.view'), support.listNotes);
router.post('/orders/:id/notes', can('orders.notes'), support.addNote);
router.get('/orders/:id/chat', can('orders.chat'), support.orderChat);

// Customers
router.get('/customers', can('customers.view'), people.listCustomers);
router.get('/customers/:id', can('customers.view'), people.getCustomer);

// Shoppers
router.get('/shoppers', can('shoppers.view'), people.listShoppers);
router.get('/shoppers/:id', can('shoppers.view'), ops.getShopper);
router.patch('/shoppers/:id/approval', can('shoppers.manage'), people.setShopperApproval);

// Shops + products
router.get('/shops', can('shops.view'), catalog.listShops);
router.get('/shops/:id', can('shops.view'), ops.getShop);
router.patch('/shops/:id/status', can('shops.manage'), catalog.setShopStatus);
router.patch('/shops/:id/brand-color', can('shops.manage'), catalog.setShopBrandColor);
router.get('/products', can('shops.view'), catalog.listProducts);
router.patch('/products/:id/availability', can('shops.manage'), catalog.setProductAvailability);

// Shop offers (shops create them; admins can pause)
router.get('/offers', can('shops.view'), offers.listOffers);
router.patch('/offers/:id/pause', can('shops.manage'), offers.setOfferPaused);

// Pricing: price history, suspicious changes, missing prices, expired
// offers, shopper shelf-price reports (admins review, never set prices)
router.get('/pricing/overview', can('pricing.view'), pricing.getOverview);
router.get('/pricing/reports', can('pricing.view'), pricing.listReports);
router.patch('/pricing/reports/:id', can('pricing.review'), pricing.reviewReport);
router.get('/pricing/changes', can('pricing.view'), pricing.listPriceChanges);
router.get('/pricing/expired-offers', can('pricing.view'), pricing.listExpiredOffers);
router.get('/products/:id/price-history', can('pricing.view'), pricing.getProductPriceHistory);

// Money + reports
router.get('/payments', can('finance.view'), finance.listPayments);
router.patch('/orders/:id/refund', can('finance.refund'), approvals.requireApproval('order.refund'), orders.refundOrder);
approvals.register('order.refund', orders.refundOrder);

// Shoppers' store bills: review differences, record reimbursements
router.get('/store-payments', can('finance.view', 'finance.store_bills'), storePayments.listStorePayments);
router.patch('/store-payments/:id/review', can('finance.store_bills'), storePayments.reviewStorePayment);
router.patch('/store-payments/:id/reimburse', can('finance.store_bills'), storePayments.reimburseStorePayment);

// Supermarket payments: attempts, reconciliation, limits, methods, GetMe cards (phase 38)
router.get('/grocery-payments', can('grocery.view'), grocery.listPayments);
router.get('/grocery-payments/orders/:orderId', can('grocery.view'), grocery.orderDetail);
router.patch('/grocery-payments/:id', can('grocery.manage'), grocery.paymentAction);
router.patch('/grocery-reservations/:id/limit', can('grocery.manage'), grocery.changeLimit);
router.get('/grocery-payment-methods', can('grocery.view'), grocery.methodsConfig);
router.patch('/grocery-payment-methods/:key', can('grocery.manage'), grocery.updateMethod);
router.put('/grocery-payment-methods/:key/shops/:shopId', can('grocery.manage'), grocery.setShopException);
router.patch('/grocery-payment-settings', can('grocery.manage'), grocery.updateSettings);
router.get('/getme-cards', can('grocery.cards'), grocery.listCards);
router.post('/getme-cards', can('grocery.cards'), grocery.createCard);
router.patch('/getme-cards/:id', can('grocery.cards'), grocery.updateCard);
router.post('/getme-cards/:id/funds', can('grocery.cards'), grocery.recordFunds);

// Shopper settlement: balances, payouts / cash deposits, disputes
router.get('/settlements', can('finance.view'), settlements.listSettlements);
router.post('/settlements/shoppers/:shopperId/payouts', can('finance.settlements'), settlements.recordPayout);
// COD cash hand-over, net of the shopper's balances (phase 33)
router.post('/settlements/shoppers/:shopperId/cash-settlements', can('finance.settlements'), settlements.recordCashHandover);
router.patch('/settlements/earnings/:orderId/dispute', can('finance.settlements'), settlements.disputeEarning);
router.patch('/settlements/earnings/:orderId/resolve', can('finance.settlements'), settlements.resolveEarning);
router.patch('/settlements/earnings/:orderId/adjust', can('finance.adjust'), approvals.requireApproval('earnings.adjust'), settlements.adjustEarning);
approvals.register('earnings.adjust', settlements.adjustEarning);

// Shopper applications (phase 34): the list without identity data for
// Support; identity data + documents for shoppers.manage
router.get('/shopper-applications', can('shopper_applications.list', 'shoppers.manage'), applicationsAdmin.listApplications);
router.get('/shopper-applications/:id', can('shoppers.manage'), applicationsAdmin.getApplication);
router.get('/shopper-applications/:id/documents/:docId', can('shoppers.manage'), applicationsAdmin.getDocument);
router.patch('/shopper-applications/:id', can('shoppers.manage'), applicationsAdmin.actOnApplication);
// Protected profile changes (phase 35)
router.get('/shopper-change-requests', can('shoppers.manage'), changeAdmin.listRequests);
router.get('/shopper-change-requests/:id', can('shoppers.manage'), changeAdmin.getRequest);
router.get('/shopper-change-requests/:id/documents/:docId', can('shoppers.manage'), changeAdmin.getDocument);
router.patch('/shopper-change-requests/:id', can('shoppers.manage'), changeAdmin.actOnRequest);
// Per-document review + verified vehicle history (phase 36)
router.patch('/shopper-applications/:id/documents/:docId', can('shoppers.manage'), applicationsAdmin.reviewApplicationDocument);
router.patch('/shopper-change-requests/:id/documents/:docId', can('shoppers.manage'), changeAdmin.reviewRequestDocument);
router.get('/shoppers/:id/vehicle-records', can('shoppers.manage'), applicationsAdmin.getVehicleRecords);
// Admin-managed registration (phase 37)
router.post('/shopper-registrations', can('shoppers.manage'), registerAdmin.registerShopper);
router.patch('/shopper-registrations/:applicationId/steps', can('shoppers.manage'), registerAdmin.saveStep);
router.post('/shopper-registrations/:applicationId/documents', can('shoppers.manage'), ...registerAdmin.uploadDocument);
router.post('/shopper-registrations/:applicationId/submit', can('shoppers.manage'), registerAdmin.submit);
router.post('/shoppers/:id/activation-code', can('shoppers.manage'), registerAdmin.activationCode);
router.patch('/shoppers/:id/vehicle-restriction', can('shoppers.manage'), changeAdmin.setVehicleRestriction);
router.get('/shoppers/:id/profile-history', can('shoppers.manage'), changeAdmin.getProfileHistory);

// Every money movement and accrual (finance_ledger view)
router.get('/ledger', can('finance.view'), settlements.getLedger);

// Shopper withdrawals: requests, manual bank transfers, bank accounts
router.get('/withdrawals', can('finance.view', 'finance.withdrawals'), withdrawals.listWithdrawals);
router.get('/withdrawals/:id', can('finance.view', 'finance.withdrawals'), withdrawals.getWithdrawal);
router.patch('/withdrawals/:id', can('finance.withdrawals'), withdrawals.changeWithdrawal);
router.get('/payout-accounts', can('finance.view', 'finance.withdrawals'), withdrawals.listPayoutAccounts);
router.patch('/payout-accounts/:id', can('finance.withdrawals'), withdrawals.reviewPayoutAccount);
router.get('/finance/overview', can('finance.view'), insights.getFinanceOverview);
router.get('/finance/reconciliation', can('finance.view'), insights.getReconciliation);

// Reports + exports (the export checks its own dataset's permission)
router.get('/reports', can('reports.view'), finance.getReports);
router.get('/analytics', can('reports.view'), insights.getAnalytics);
router.get('/export/:dataset', can('exports.orders', 'exports.finance'), insights.exportDataset);

// Fees & pricing (Super Admin changes them; report roles can read)
router.get('/settings/pricing', can('reports.view'), settings.getPricing);
router.put('/settings/pricing', can('settings.pricing'), settings.updatePricing);
router.post('/settings/pricing/preview', can('reports.view'), settings.previewPricing);
router.get('/settings/pricing/history', can('reports.view'), settings.getPricingHistory);
router.delete('/settings/pricing/versions/:id', can('settings.pricing'), settings.cancelScheduledPricing);

// Promo codes (GetMe pays the discount)
router.get('/promos', can('shops.view'), promos.listPromos);
router.post('/promos', can('promos.manage'), promos.createPromo);
router.patch('/promos/:id', can('promos.manage'), promos.updatePromo);

module.exports = router;
