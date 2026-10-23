const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const loginRateLimit = require('../middleware/loginRateLimit');

const account = require('../controllers/admin/adminAccountController');
const { getDashboard } = require('../controllers/admin/adminDashboardController');
const orders = require('../controllers/admin/adminOrderController');
const people = require('../controllers/admin/adminPeopleController');
const catalog = require('../controllers/admin/adminCatalogController');
const finance = require('../controllers/admin/adminFinanceController');
const settings = require('../controllers/admin/adminSettingsController');
const promos = require('../controllers/admin/adminPromoController');
const offers = require('../controllers/admin/adminOfferController');

const router = express.Router();

// =====================================================
// PUBLIC: login only
// =====================================================

router.post('/auth/login', loginRateLimit, account.login);

// =====================================================
// EVERYTHING BELOW REQUIRES AN ADMIN TOKEN
// =====================================================

router.use(requireAdmin);

// Account
router.get('/auth/me', account.me);
router.put('/auth/password', account.changePassword);
router.get('/admins', account.listAdmins);
router.post('/admins', account.createAdmin);
router.patch('/admins/:id', account.setAdminActive);

// Dashboard
router.get('/dashboard', getDashboard);

// Orders
router.get('/orders', orders.listOrders);
router.get('/orders/:id', orders.getOrder);
router.patch('/orders/:id/cancel', orders.cancelOrder);

// Customers
router.get('/customers', people.listCustomers);
router.get('/customers/:id', people.getCustomer);

// Shoppers
router.get('/shoppers', people.listShoppers);
router.patch('/shoppers/:id/approval', people.setShopperApproval);

// Shops + products
router.get('/shops', catalog.listShops);
router.patch('/shops/:id/status', catalog.setShopStatus);
router.patch('/shops/:id/brand-color', catalog.setShopBrandColor);
router.get('/products', catalog.listProducts);
router.patch('/products/:id/availability', catalog.setProductAvailability);

// Shop offers (shops create them; admins can pause)
router.get('/offers', offers.listOffers);
router.patch('/offers/:id/pause', offers.setOfferPaused);

// Money + reports
router.get('/payments', finance.listPayments);
router.get('/reports', finance.getReports);

// Fees & pricing (GetMe earns the service fee; shoppers earn delivery + fast fee)
router.get('/settings/pricing', settings.getPricing);
router.put('/settings/pricing', settings.updatePricing);
router.post('/settings/pricing/preview', settings.previewPricing);

// Promo codes (GetMe pays the discount)
router.get('/promos', promos.listPromos);
router.post('/promos', promos.createPromo);
router.patch('/promos/:id', promos.updatePromo);

module.exports = router;
