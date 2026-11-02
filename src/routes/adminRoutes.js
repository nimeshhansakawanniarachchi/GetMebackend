const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const loginRateLimit = require('../middleware/loginRateLimit');
const mfaRateLimit = require('../middleware/mfaRateLimit');
const { requirePermission, auditAdminChanges, requireRecentAuth } = require('../middleware/adminAccess');
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
const growthOps = require('../controllers/admin/adminGrowthOpsController');
const supportCases = require('../controllers/admin/adminSupportCaseController');
// Phase 46: shopper documents, training quiz, incidents
const compliance = require('../compliance/documents');
const training = require('../compliance/training');
const incidents = require('../compliance/incidents');

const router = express.Router();

// =====================================================
// PUBLIC: login only
// =====================================================

router.post('/auth/login', loginRateLimit, account.login);
// Two-step sign-in (security review B-13): the challenge token from login
router.post('/auth/mfa/verify', mfaRateLimit, account.mfaVerify);
router.post('/auth/mfa/setup', mfaRateLimit, account.mfaSetupStart);
router.post('/auth/mfa/setup/confirm', mfaRateLimit, account.mfaSetupConfirm);

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
// High-risk routes: a password / two-step check in the last 15 minutes
const recent = requireRecentAuth;

// Own account
router.get('/auth/me', account.me);
router.put('/auth/password', account.changePassword);
router.post('/auth/reauth', mfaRateLimit, account.reauth);
router.post('/account/mfa/setup', account.accountMfaSetup);
router.post('/account/mfa/confirm', mfaRateLimit, account.accountMfaConfirm);
router.post('/account/mfa/disable', mfaRateLimit, account.accountMfaDisable);

// Notifications (phase 41): every signed-in admin, filtered to what
// their permissions and the role's notification categories allow
// (src/admin/notifications.js checks ownership on every change)
router.get('/notifications', notifications.listNotifications);
router.get('/notifications/summary', notifications.getSummary);
router.post('/notifications/read-all', notifications.markAllRead);
router.get('/notifications/preferences', notifications.getPreferences);
router.put('/notifications/preferences', notifications.updatePreferences);
router.get('/notifications/settings', can('security.settings'), notifications.getPolicy);
router.put('/notifications/settings', can('security.settings'), recent, notifications.updatePolicy);
router.post('/notifications/:id/read', notifications.markRead);
router.post('/notifications/:id/unread', notifications.markUnread);
router.post('/notifications/:id/dismiss', notifications.dismiss);

// Staff, permissions, security (Super Admin)
router.get('/admins', can('admins.manage'), account.listAdmins);
router.post('/admins', can('admins.manage'), recent, account.createAdmin);
router.patch('/admins/:id', can('admins.manage'), recent, account.updateAdmin);
router.post('/admins/:id/reset-password', can('admins.manage'), recent, account.resetPassword);
router.post('/admins/:id/mfa/reset', can('admins.manage'), recent, account.resetAdminMfa);
router.get('/permissions', can('admins.manage'), account.permissionCatalogue);
router.get('/security-settings', can('security.settings', 'finance.refund', 'finance.adjust'), account.getSecuritySettings);
router.put('/security-settings', can('security.settings'), recent, account.updateSecuritySettings);
router.get('/audit-log', can('audit.view'), ops.getAuditLog);

// Approvals of high-risk money actions
// Phase 50: Finance also asks for company bank account changes
router.get('/approvals', can('approvals.decide', 'finance.refund', 'finance.adjust', 'support.credit', 'company_accounts.manage'), approvals.listApprovals);
router.patch('/approvals/:id', can('approvals.decide'), recent, approvals.decide);
router.post('/approvals/:id/cancel', can('finance.refund', 'finance.adjust', 'support.credit', 'company_accounts.manage'), approvals.cancel);

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
// Phase 45: staff control over shopper assignment (the shopper always
// accepts themselves) + shopper cash limit
const dispatchControl = require('../controllers/admin/adminDispatchController');
router.get('/orders/:id/dispatch', can('orders.view'), dispatchControl.getDispatch);
router.get('/orders/:id/dispatch-candidates', can('orders.dispatch'), dispatchControl.getCandidates);
router.post('/orders/:id/release-shopper', can('orders.dispatch'), dispatchControl.releaseShopper);
router.post('/orders/:id/offer-shopper', can('orders.dispatch'), dispatchControl.offerShopper);
router.post('/orders/:id/redispatch', can('orders.dispatch'), dispatchControl.redispatch);
router.get('/dispatch-settings', can('orders.dispatch', 'finance.view', 'shoppers.view'), dispatchControl.getSettings);
// Cash limit: finance.settlements; exclusive offer minutes: orders.dispatch (checked per field)
router.put('/dispatch-settings', can('finance.settlements', 'orders.dispatch'), dispatchControl.updateSettings);
router.get('/shoppers/:id/cash-limit', can('shoppers.view', 'finance.view'), dispatchControl.getShopperCashLimit);

// Customers
router.get('/customers', can('customers.view'), people.listCustomers);
router.get('/customers/:id', can('customers.view'), people.getCustomer);
// Phase 44: account controls (block / card only), COD limit, risk indicators
const customerControls = require('../controllers/admin/adminCustomerControlsController');
router.patch('/customers/:id/status', can('customers.manage'), customerControls.setStatus);
router.patch('/customers/:id/cod-limit', can('customers.manage'), customerControls.setCodLimit);
router.get('/customers/:id/risk', can('customers.view'), customerControls.getRisk);
router.get('/customer-controls/settings', can('customers.view'), customerControls.getSettings);
router.put('/customer-controls/settings', can('customers.manage', 'security.settings'), customerControls.updateSettings);
// GetMe credit (phase 43): balance + history; giving credit over the
// limit waits for the Super Admin (approval type customer.credit)
const creditTarget = (target) => (req, res, next) => {
  req.body = { ...(req.body || {}), target };
  next();
};
router.get('/customers/:id/credit', can('customers.view'), supportCases.getCustomerCredit);

// Customer activity, sessions, location history (phase 51). Location
// endpoints need customers.location and every view is audited.
const customerActivity = require('../customerActivity/adminController');
router.get('/customer-activity/summary', can('customers.activity'), customerActivity.getSummary);
router.get('/customer-activity/customers', can('customers.activity'), customerActivity.listCustomers);
router.get('/customer-activity/settings', can('customers.activity'), customerActivity.getActivitySettings);
router.put('/customer-activity/settings', can('security.settings'), recent, customerActivity.updateActivitySettings);
router.get('/customers/:id/activity/overview', can('customers.activity'), customerActivity.getOverview);
router.get('/customers/:id/activity/events', can('customers.activity'), customerActivity.listEvents);
router.get('/customers/:id/activity/sessions', can('customers.activity'), customerActivity.listSessions);
router.get('/customers/:id/activity/visits', can('customers.activity'), customerActivity.listVisits);
router.get('/customers/:id/activity/routes', can('customers.location'), customerActivity.listRoutes);
router.get('/customers/:id/activity/routes/:routeId', can('customers.location'), customerActivity.getRoute);
router.get('/customers/:id/activity/locations', can('customers.location'), customerActivity.listLocations);

// Fuel station payments + payment providers (phase 54)
const fuelPayments = require('../fuel/fuelPayments');
const fuelSend = (handler) => async (req, res) => {
  try {
    return res.json({ success: true, ...(await handler(req)) });
  } catch (caught) {
    if (!caught.status) console.error('❌ admin fuel error:', caught.message);
    return res.status(caught.status || 500).json({ success: false, code: caught.code, message: caught.status ? caught.message : 'Unable to complete the request', ...(caught.extra || {}) });
  }
};
// Phase 55 (payment audit 2026-10-31): every payment in one list with
// one status vocabulary; HelaPOS received payments (two-admin manual
// verification); outcomes of card refunds PayHere didn't answer
const adminTransactions = require('../payments/adminTransactions');
const receivedQr = require('../payments/receivedQrPayments');
const paySend = (handler, okStatus = 200) => async (req, res) => {
  try {
    const result = await handler(req);
    if (result?.audit) {
      res.locals.audit = result.audit;
      delete result.audit;
    }
    if (result?.error) return res.status(result.error.status).json({ success: false, message: result.error.message });
    return res.status(okStatus).json({ success: true, ...result });
  } catch (caught) {
    if (!caught.status) console.error('❌ admin payments error:', caught.message);
    return res.status(caught.status || 500).json({ success: false, code: caught.code, field: caught.field, message: caught.status ? caught.message : 'Unable to complete the request' });
  }
};
router.get('/payments/transactions', can('finance.view'), paySend((req) => adminTransactions.list(req.query)));
router.get('/payments/transactions/:kind/:id', can('finance.view'), paySend((req) => adminTransactions.detail(req.params.kind, req.params.id)));
router.patch('/payments/refund-requests/:id', can('finance.refund'), recent, paySend((req) =>
  require('../payments/paymentService').resolveRefundRequest(req.params.id, req.body || {}, req.admin.adminId, req.app.get('io'))
));
router.get('/payments/received-qr', can('finance.view'), paySend((req) => receivedQr.adminList(req.query)));
router.get('/payments/received-qr/:id', can('finance.view'), paySend((req) => receivedQr.adminGet(req.params.id)));
router.post('/payments/received-qr', can('finance.received_qr'), recent, paySend((req) => receivedQr.adminRecord(req.body || {}, req.admin.adminId), 201));
router.patch('/payments/received-qr/:id', can('finance.received_qr'), recent, paySend((req) => receivedQr.adminAction(req.params.id, req.body || {}, req.admin.adminId)));

router.get('/payment-providers', can('fuel.view', 'grocery.view'), (req, res) => res.json({ success: true, providers: require('../payments/providerCatalogue').catalogue() }));
router.get('/fuel/stations', can('fuel.view'), fuelSend(() => fuelPayments.adminListStations()));
router.post('/fuel/stations', can('fuel.manage'), fuelSend((req) => fuelPayments.adminSaveStation({ body: req.body, adminId: req.admin.adminId })));
router.patch('/fuel/stations/:id', can('fuel.manage'), fuelSend((req) => fuelPayments.adminSaveStation({ id: req.params.id, body: req.body, adminId: req.admin.adminId })));
router.put('/fuel/stations/:id/qr', can('fuel.manage'), recent, fuelSend((req) => fuelPayments.adminSetStationQr({ id: req.params.id, body: req.body, adminId: req.admin.adminId })));
router.get('/fuel/prices', can('fuel.view'), fuelSend(() => fuelPayments.adminListPrices()));
router.post('/fuel/prices', can('fuel.manage'), fuelSend((req) => fuelPayments.adminAddPrice({ body: req.body, adminId: req.admin.adminId })));
router.get('/fuel/payments', can('fuel.view'), fuelSend((req) => fuelPayments.adminListPayments({ query: req.query })));
router.get('/fuel/payments/:id', can('fuel.view'), fuelSend((req) => fuelPayments.adminGetPayment({ id: req.params.id })));
router.patch('/fuel/payments/:id', can('fuel.manage'), recent, fuelSend((req) => fuelPayments.adminReview({ id: req.params.id, body: req.body, adminId: req.admin.adminId })));
router.post('/customers/:id/credit', can('support.credit'), recent, creditTarget('customer'), approvals.requireApproval('customer.credit'), supportCases.giveCustomerCredit);
approvals.register('customer.credit', supportCases.creditHandler);

// Support cases (phase 43): customers report a problem with a delivered
// order; staff reply, assign, and resolve (decline / no money with
// support.cases, GetMe credit with support.credit, card refund with
// finance.refund - both over their limits wait for the Super Admin)
router.get('/support/cases', can('support.cases'), supportCases.listCases);
router.get('/support/staff', can('support.cases'), supportCases.listAssignableStaff);
router.get('/support/cases/:id', can('support.cases', 'support.credit', 'finance.refund'), supportCases.getCase);
router.patch('/support/cases/:id/assign', can('support.cases'), supportCases.assignCase);
router.patch('/support/cases/:id/status', can('support.cases'), supportCases.setStatus);
router.post('/support/cases/:id/reply', can('support.cases'), supportCases.reply);
router.post('/support/cases/:id/notes', can('support.cases'), supportCases.addNote);
router.post('/support/cases/:id/resolve', can('support.cases'), supportCases.resolveCase);
router.post('/support/cases/:id/credit', can('support.credit'), recent, creditTarget('case'), approvals.requireApproval('customer.credit'), supportCases.resolveWithCredit);
router.post('/support/cases/:id/refund', can('finance.refund'), recent, approvals.requireApproval('support.refund'), supportCases.resolveWithRefund);
approvals.register('support.refund', supportCases.resolveWithRefund);

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
router.patch('/orders/:id/refund', can('finance.refund'), recent, approvals.requireApproval('order.refund'), orders.refundOrder);
approvals.register('order.refund', orders.refundOrder);

// Shoppers' store bills: review differences, record reimbursements
router.get('/store-payments', can('finance.view', 'finance.store_bills'), storePayments.listStorePayments);
router.patch('/store-payments/:id/review', can('finance.store_bills'), recent, storePayments.reviewStorePayment);
router.patch('/store-payments/:id/reimburse', can('finance.store_bills'), recent, storePayments.reimburseStorePayment);

// Supermarket payments: attempts, reconciliation, limits, methods, GetMe cards (phase 38)
router.get('/grocery-payments', can('grocery.view'), grocery.listPayments);
router.get('/grocery-payments/orders/:orderId', can('grocery.view'), grocery.orderDetail);
router.patch('/grocery-payments/:id', can('grocery.manage'), recent, grocery.paymentAction);
router.patch('/grocery-reservations/:id/limit', can('grocery.manage'), grocery.changeLimit);
router.get('/grocery-payment-methods', can('grocery.view'), grocery.methodsConfig);
router.patch('/grocery-payment-methods/:key', can('grocery.manage'), grocery.updateMethod);
router.put('/grocery-payment-methods/:key/shops/:shopId', can('grocery.manage'), grocery.setShopException);
router.patch('/grocery-payment-settings', can('grocery.manage'), grocery.updateSettings);
router.get('/getme-cards', can('grocery.cards'), grocery.listCards);
router.post('/getme-cards', can('grocery.cards'), recent, grocery.createCard);
router.patch('/getme-cards/:id', can('grocery.cards'), recent, grocery.updateCard);
router.post('/getme-cards/:id/funds', can('grocery.cards'), recent, approvals.requireApproval('card.funds'), grocery.recordFunds);
approvals.register('card.funds', grocery.recordFunds);
// LankaQR (GetMe pays, phase 49): provider status card + store QRs
// approved per shop (merchant substitution protection)
const lankaqrAdmin = require('../controllers/lankaqrController').admin;
router.get('/lankaqr/status', can('grocery.view'), lankaqrAdmin.status);
router.get('/lankaqr/merchants', can('grocery.view'), lankaqrAdmin.listMerchants);
router.post('/lankaqr/merchants', can('grocery.manage'), recent, lankaqrAdmin.createMerchant);
router.patch('/lankaqr/merchants/:id', can('grocery.manage'), recent, lankaqrAdmin.reviewMerchant);

// GetMe company bank accounts (phase 50, src/companyAccounts): records
// only - nothing connects to a bank or moves money. Masked everywhere;
// the full number only for the Super Admin (reveal, audited). Activate,
// defaults, funding source, provider link and bank authorisation need
// the Super Admin (Finance's requests go to Approvals).
const companyAccounts = require('../companyAccounts/controller');
router.get('/company-accounts', can('company_accounts.view'), companyAccounts.list);
router.post('/company-accounts', can('company_accounts.manage'), companyAccounts.create);
router.put('/company-accounts/defaults/:purpose', can('company_accounts.manage'), companyAccounts.setDefault);
router.put('/company-accounts/funding/:methodKey', can('company_accounts.manage'), companyAccounts.setFunding);
router.get('/company-accounts/:id', can('company_accounts.view'), companyAccounts.get);
router.patch('/company-accounts/:id', can('company_accounts.manage'), companyAccounts.update);
router.post('/company-accounts/:id/deactivate', can('company_accounts.manage'), companyAccounts.deactivate);
router.post('/company-accounts/:id/archive', can('company_accounts.manage'), companyAccounts.archive);
router.post('/company-accounts/:id/activate', can('company_accounts.manage'), companyAccounts.activate);
router.patch('/company-accounts/:id/integration', can('company_accounts.manage'), companyAccounts.setIntegration);
router.post('/company-accounts/:id/authorization', can('company_accounts.manage'), companyAccounts.recordAuthorization);
router.post('/company-accounts/:id/integration-approval', can('approvals.decide'), companyAccounts.approveIntegration);
router.post('/company-accounts/:id/reveal', can('company_accounts.reveal'), recent, companyAccounts.reveal);

// Shopper settlement: balances, payouts / cash deposits, disputes
router.get('/settlements', can('finance.view'), settlements.listSettlements);
router.post('/settlements/shoppers/:shopperId/payouts', can('finance.settlements'), recent, settlements.recordPayout);
// COD cash hand-over, net of the shopper's balances (phase 33)
router.post('/settlements/shoppers/:shopperId/cash-settlements', can('finance.settlements'), recent, settlements.recordCashHandover);
router.patch('/settlements/earnings/:orderId/dispute', can('finance.settlements'), settlements.disputeEarning);
router.patch('/settlements/earnings/:orderId/resolve', can('finance.settlements'), settlements.resolveEarning);
router.patch('/settlements/earnings/:orderId/adjust', can('finance.adjust'), recent, approvals.requireApproval('earnings.adjust'), settlements.adjustEarning);
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

// Phase 46: document expiry dates (shoppers.manage edits, audited),
// training quiz settings, shopper help requests (incidents.manage)
router.get('/shoppers/:id/compliance', can('shoppers.view', 'shoppers.manage'), compliance.getCompliance);
router.patch('/shoppers/:id/documents', can('shoppers.manage'), compliance.updateDocuments);
router.get('/shopper-training/settings', can('shoppers.view', 'shoppers.manage'), training.getSettings);
router.put('/shopper-training/settings', can('shoppers.manage'), training.updateSettings);
router.get('/incidents', can('incidents.manage'), incidents.listIncidents);
router.get('/incidents/:id', can('incidents.manage'), incidents.getIncident);
router.post('/incidents/:id/acknowledge', can('incidents.manage'), incidents.acknowledgeIncident);
router.post('/incidents/:id/resolve', can('incidents.manage'), incidents.resolveIncident);
router.post('/incidents/:id/notes', can('incidents.manage'), incidents.addIncidentNote);

// Every money movement and accrual (finance_ledger view)
router.get('/ledger', can('finance.view'), settlements.getLedger);

// Shopper withdrawals: requests, manual bank transfers, bank accounts
router.get('/withdrawals', can('finance.view', 'finance.withdrawals'), withdrawals.listWithdrawals);
router.get('/withdrawals/:id', can('finance.view', 'finance.withdrawals'), withdrawals.getWithdrawal);
router.patch('/withdrawals/:id', can('finance.withdrawals'), recent, withdrawals.changeWithdrawal);
router.get('/payout-accounts', can('finance.view', 'finance.withdrawals'), withdrawals.listPayoutAccounts);
router.patch('/payout-accounts/:id', can('finance.withdrawals'), recent, withdrawals.reviewPayoutAccount);
router.get('/finance/overview', can('finance.view'), insights.getFinanceOverview);
router.get('/finance/reconciliation', can('finance.view'), insights.getReconciliation);

// Reports + exports (the export checks its own dataset's permission)
router.get('/reports', can('reports.view'), finance.getReports);
router.get('/analytics', can('reports.view'), insights.getAnalytics);
router.get('/export/:dataset', can('exports.orders', 'exports.finance'), recent, insights.exportDataset);

// Fees & pricing (Super Admin changes them; report roles can read)
router.get('/settings/pricing', can('reports.view'), settings.getPricing);
router.put('/settings/pricing', can('settings.pricing'), recent, settings.updatePricing);
router.post('/settings/pricing/preview', can('reports.view'), settings.previewPricing);
router.get('/settings/pricing/history', can('reports.view'), settings.getPricingHistory);
router.delete('/settings/pricing/versions/:id', can('settings.pricing'), settings.cancelScheduledPricing);

// Promo codes (GetMe pays the discount)
router.get('/promos', can('shops.view'), promos.listPromos);
router.post('/promos', can('promos.manage'), promos.createPromo);
router.patch('/promos/:id', can('promos.manage'), promos.updatePromo);

// Phase 47: grocery operations report, shop onboarding + account
// manager, promotion results (controllers/admin/adminGrowthOpsController.js)
router.get('/reports/operations', can('reports.view'), growthOps.getOperationsReport);
router.get('/shops/:id/onboarding', can('shops.view'), growthOps.getShopOnboarding);
router.patch('/shops/:id/onboarding', can('shops.manage'), growthOps.updateShopOnboarding);
router.get('/staff-directory', can('shops.manage'), growthOps.getStaffDirectory);
router.get('/promos/:id/results', can('reports.view', 'promos.manage'), growthOps.getPromoResults);
router.get('/offers/:id/results', can('reports.view', 'shops.manage'), growthOps.getOfferResults);

module.exports = router;
