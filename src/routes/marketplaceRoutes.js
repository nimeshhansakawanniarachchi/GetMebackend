// =====================================================
// PHASE 59: MULTI-CATEGORY MARKETPLACE ROUTES
// customerRouter -> /api/customer, shopRouter -> /api/shop,
// adminRouter -> /api/admin, shopperRouter -> /api/shopper
// (mounted in app.js after the existing routers; no existing path
// is redefined). Contract: code-backups/reports/p59-marketplace-api-contract.md
// =====================================================

const express = require('express');
const path = require('path');
const multer = require('../middleware/verifiedMulter');

const authMiddleware = require('../middleware/authMiddleware');
const shopAuthMiddleware = require('../middleware/shopAuthMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const { requirePermission: can } = require('../middleware/adminAccess');
const { allowShopRoles } = require('../middleware/shopAccess');

const catalog = require('../marketplace/customerCatalog');
const checkout = require('../marketplace/merchantCheckout');
const orders = require('../marketplace/merchantOrders');
const products = require('../marketplace/merchantProducts');
const business = require('../marketplace/business');
const returns = require('../marketplace/returns');
const admin = require('../marketplace/adminMarketplace');
const nationwide = require('../marketplace/nationwideSearch');
const shopDelivery = require('../marketplace/shopDelivery');
const homeFeed = require('../marketplace/homeFeed');
const tools = require('../marketplace/merchantTools');

const OWNER = allowShopRoles();
const MANAGER = allowShopRoles('manager');
const STAFF = allowShopRoles('manager', 'staff');

// -----------------------------------------------------
// Uploads
// -----------------------------------------------------

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOC_TYPES = [...IMAGE_TYPES, 'application/pdf'];

const diskTo = (dir, prefix) =>
  multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6);
      cb(null, `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
  });

const onlyTypes = (types, message) => (req, file, cb) =>
  types.includes(file.mimetype) ? cb(null, true) : cb(Object.assign(new Error(message), { status: 400 }));

const productImages = multer({
  storage: diskTo('uploads/products', 'product'),
  fileFilter: onlyTypes(IMAGE_TYPES, 'Only JPG, PNG and WEBP photos are allowed'),
  limits: { fileSize: 5 * 1024 * 1024, files: 8 },
});

const coverImage = multer({
  storage: diskTo('uploads/shops', 'cover'),
  fileFilter: onlyTypes(IMAGE_TYPES, 'Only JPG, PNG and WEBP photos are allowed'),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

const documentUpload = multer({
  storage: diskTo(business.DOCS_DIR, 'doc'),
  fileFilter: onlyTypes(DOC_TYPES, 'Upload a PDF, JPG, PNG or WEBP file'),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

// Turns multer / verifier errors into a readable 400
const upload = (middleware) => (req, res, next) =>
  middleware(req, res, (error) => {
    if (!error) return next();
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'That file is too large' :
      error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE' ? 'Too many files' : error.message || 'Upload failed';
    return res.status(400).json({ success: false, code: 'BAD_UPLOAD', message });
  });

// -----------------------------------------------------
// Customer (/api/customer)
// -----------------------------------------------------

const customerRouter = express.Router();

customerRouter.get('/marketplace/shops/:shopId', catalog.getStorefront);
customerRouter.get('/marketplace/shops/:shopId/products', catalog.getStoreProducts);
// Phase 61: home feed (batch must come before :productId)
customerRouter.get('/marketplace/categories', homeFeed.getCategories);
customerRouter.get('/marketplace/home', homeFeed.getHome);
customerRouter.get('/marketplace/buy-again', authMiddleware, homeFeed.getBuyAgain);
customerRouter.get('/marketplace/products/batch', homeFeed.getProductsBatch);
customerRouter.get('/marketplace/products/:productId', catalog.getProductDetail);
customerRouter.get('/marketplace/search', catalog.searchMarketplace);

// Phase 60: nationwide search (all approved shops in Sri Lanka) + delivery checks
customerRouter.get('/marketplace/search/products', nationwide.searchProducts);
customerRouter.get('/marketplace/search/suggest', nationwide.suggest);
customerRouter.get('/marketplace/search/shops', nationwide.searchShops);
customerRouter.get('/marketplace/delivery-options', nationwide.getDeliveryOptions);
customerRouter.get('/marketplace/districts', nationwide.getDistricts);

customerRouter.post('/merchant-orders/quote', authMiddleware, checkout.getMerchantQuote);
customerRouter.post('/merchant-orders', authMiddleware, checkout.createMerchantOrder);
customerRouter.get('/merchant-orders', authMiddleware, orders.listCustomerOrders);
customerRouter.get('/merchant-orders/:orderId', authMiddleware, orders.getCustomerOrder);
customerRouter.post('/merchant-orders/:orderId/returns', authMiddleware, returns.createReturn);
customerRouter.post('/merchant-orders/:orderId/returns/:returnId/cancel', authMiddleware, returns.cancelReturn);
customerRouter.post('/merchant-orders/:orderId/received', authMiddleware, orders.confirmReceived);

// -----------------------------------------------------
// Shop portal (/api/shop)
// -----------------------------------------------------

const shopRouter = express.Router();

shopRouter.get('/register/options', business.registerOptions);

// Everything below needs a signed-in shop account
// (the existing /api/shop router already audits changes; these
// handlers write their own clearer activity entries instead)
const skipGenericAudit = (req, res, next) => {
  res.locals.skipShopAudit = true;
  next();
};
const shopAuth = [shopAuthMiddleware, skipGenericAudit];

shopRouter.get('/business', shopAuth, business.getBusiness);
shopRouter.put('/business', shopAuth, OWNER, business.putBusiness);
shopRouter.put('/business/cover', shopAuth, OWNER, upload(coverImage.single('image')), business.putCover);
shopRouter.post('/business/documents', shopAuth, OWNER, upload(documentUpload.single('file')), business.uploadDocument);
shopRouter.get('/business/documents/:id/file', shopAuth, OWNER, business.getDocumentFile);
shopRouter.delete('/business/documents/:id', shopAuth, OWNER, business.deleteDocument);
shopRouter.put('/business/bank-account', shopAuth, OWNER, business.putBankAccount);
shopRouter.post('/business/submit', shopAuth, OWNER, business.submitForReview);

shopRouter.get('/branches', shopAuth, OWNER, business.listBranches);
shopRouter.post('/branches', shopAuth, OWNER, business.createBranch);
shopRouter.post('/branches/:id/switch', shopAuth, OWNER, business.switchBranch);

shopRouter.get('/shop-delivery', shopAuth, shopDelivery.getShopDelivery);
shopRouter.put('/shop-delivery', shopAuth, MANAGER, shopDelivery.putShopDelivery);

shopRouter.get('/operations', shopAuth, business.getOperations);
shopRouter.put('/operations', shopAuth, MANAGER, business.putOperations);
shopRouter.post('/operations/pause', shopAuth, MANAGER, business.pauseOrders);
shopRouter.post('/operations/resume', shopAuth, MANAGER, business.resumeOrders);

shopRouter.get('/marketplace-categories', shopAuth, products.categoriesForShop);

const merchant = [...shopAuth, products.requireMerchant];
// Phase 61: sections, bulk discounts, sales report (before /merchant-products/:id)
shopRouter.get('/shop-categories', merchant, tools.getSections);
shopRouter.put('/shop-categories', merchant, MANAGER, tools.putSections);
shopRouter.post('/shop-categories/availability', merchant, STAFF, tools.setSectionAvailability);
shopRouter.post('/merchant-products/discounts', merchant, MANAGER, tools.bulkDiscount);
shopRouter.get('/merchant-reports', merchant, MANAGER, tools.getReport);
shopRouter.get('/merchant-products', merchant, products.listProducts);
shopRouter.post('/merchant-products', merchant, MANAGER, products.createProduct);
shopRouter.get('/merchant-products/:id', merchant, products.getProduct);
shopRouter.put('/merchant-products/:id', merchant, MANAGER, products.updateProduct);
shopRouter.patch('/merchant-products/:id', merchant, STAFF, products.patchProduct);
shopRouter.delete('/merchant-products/:id', merchant, MANAGER, products.deleteProduct);
shopRouter.put('/merchant-products/:id/variants', merchant, MANAGER, products.replaceVariants);
shopRouter.patch('/merchant-products/:id/variants/:variantId', merchant, STAFF, products.patchVariant);
shopRouter.post('/merchant-products/:id/images', merchant, MANAGER, upload(productImages.array('images', 8)), products.addImages);
shopRouter.put('/merchant-products/:id/images/order', merchant, MANAGER, products.orderImages);
shopRouter.delete('/merchant-products/:id/images/:imageId', merchant, MANAGER, products.deleteImage);
shopRouter.put('/merchant-products/:id/options', merchant, MANAGER, products.replaceOptions);

shopRouter.get('/merchant-orders', merchant, STAFF, orders.listShopOrders);
shopRouter.get('/merchant-orders/:orderId', merchant, STAFF, orders.getShopOrder);
shopRouter.patch('/merchant-orders/:orderId/accept', merchant, STAFF, orders.acceptOrder);
shopRouter.patch('/merchant-orders/:orderId/reject', merchant, STAFF, orders.rejectOrder);
shopRouter.patch('/merchant-orders/:orderId/preparing', merchant, STAFF, orders.markPreparing);
shopRouter.patch('/merchant-orders/:orderId/ready', merchant, STAFF, orders.markReady);
shopRouter.post('/merchant-orders/:orderId/collected', merchant, STAFF, orders.markCollected);
shopRouter.patch('/merchant-orders/:orderId/shipped', merchant, STAFF, orders.markShipped);
shopRouter.post('/merchant-orders/:orderId/delivered', merchant, STAFF, orders.markShopDelivered);

shopRouter.get('/merchant-returns', merchant, MANAGER, returns.listShopReturns);
shopRouter.patch('/merchant-returns/:id', merchant, MANAGER, returns.decideReturn);
shopRouter.get('/merchant-settlements', merchant, OWNER, returns.listShopSettlements);

// -----------------------------------------------------
// Admin (/api/admin)
// -----------------------------------------------------

const adminRouter = express.Router();
// requireAdmin again in case of mount-order changes; auditing is done
// by the existing /api/admin router (router.use(auditAdminChanges))
const adminAuth = [requireAdmin];

adminRouter.get('/shops/:id/business', adminAuth, can('shops.view'), admin.getBusiness);
adminRouter.get('/shops/:id/documents/:docId/file', adminAuth, can('shops.manage'), admin.getDocumentFile);
adminRouter.patch('/shops/:id/documents/:docId', adminAuth, can('shops.manage'), admin.reviewDocument);
adminRouter.patch('/shops/:id/bank-account/verify', adminAuth, can('finance.settlements'), admin.verifyBankAccount);

adminRouter.get('/marketplace/business-types', adminAuth, can('shops.view'), admin.listBusinessTypes);
adminRouter.patch('/marketplace/business-types/:key', adminAuth, can('shops.manage'), admin.updateBusinessType);
adminRouter.get('/marketplace/categories', adminAuth, can('shops.view'), admin.listCategories);
adminRouter.post('/marketplace/categories', adminAuth, can('shops.manage'), admin.createCategory);
adminRouter.patch('/marketplace/categories/:id', adminAuth, can('shops.manage'), admin.updateCategory);
adminRouter.get('/marketplace/document-types', adminAuth, can('shops.view'), admin.listDocumentTypes);
adminRouter.post('/marketplace/document-types', adminAuth, can('shops.manage'), admin.createDocumentType);
adminRouter.patch('/marketplace/document-types/:id', adminAuth, can('shops.manage'), admin.updateDocumentType);

adminRouter.get('/marketplace/products', adminAuth, can('shops.view'), admin.listProducts);
adminRouter.get('/marketplace/products/:id', adminAuth, can('shops.view'), admin.getProduct);
adminRouter.patch('/marketplace/products/:id', adminAuth, can('shops.manage'), admin.patchProduct);

adminRouter.get('/marketplace/orders', adminAuth, can('orders.view'), admin.listOrders);
adminRouter.get('/marketplace/returns', adminAuth, can('shops.view', 'orders.view', 'finance.refund'), admin.listReturns);
adminRouter.patch('/marketplace/returns/:id', adminAuth, can('finance.refund'), admin.actOnReturn);

adminRouter.get('/marketplace/settlements', adminAuth, can('finance.view'), admin.listSettlements);
adminRouter.post('/marketplace/settlements/pay', adminAuth, can('finance.settlements'), admin.paySettlements);
adminRouter.post('/marketplace/settlements/:id/hold', adminAuth, can('finance.settlements'), admin.holdSettlement);
adminRouter.post('/marketplace/settlements/:id/release', adminAuth, can('finance.settlements'), admin.releaseSettlement);

adminRouter.get('/marketplace/reports', adminAuth, can('reports.view', 'shops.view'), admin.reports);

// Shopper: POST /api/shopper/orders/:orderId/merchant-pickup lives in
// shopperOrderRoutes.js (it needs that file's shopper auth)

module.exports = { customerRouter, shopRouter, adminRouter };
