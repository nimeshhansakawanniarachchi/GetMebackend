const express = require('express');
const multer = require('multer');
const path = require('path');

const {
  registerShop,
  loginShop,
  getShopProfile,
  updateShopProfile,
  setShopOpen,
} = require('../controllers/shop/shopAccountController');

const {
  getProducts,
  getProduct,
  addProduct,
  updateProduct,
  patchProduct,
  patchProductPrice,
  getProductPriceHistory,
  deleteProduct,
  lookupBarcode,
} = require('../controllers/shop/shopProductController');

const {
  importProducts,
  getImportTemplate,
} = require('../controllers/shop/shopProductImportController');

const {
  getDashboard,
  getOrders,
  getOrder,
} = require('../controllers/shop/shopOrderController');

const {
  getOffers,
  createOffer,
  updateOffer,
  deleteOffer,
} = require('../controllers/shop/shopOfferController');

const staffAccount = require('../controllers/shop/shopStaffController');
const insights = require('../controllers/shop/shopInsightsController');
const { allowShopRoles, auditShopChanges } = require('../middleware/shopAccess');

// Shop roles (middleware/shopAccess.js); owner always passes
const MANAGER = allowShopRoles('manager');
const STAFF = allowShopRoles('manager', 'staff');
const OWNER = allowShopRoles();

const shopAuthMiddleware = require('../middleware/shopAuthMiddleware');
const { broadcastCatalogChange } = require('../realtime');
const loginRateLimit = require('../middleware/loginRateLimit');

const router = express.Router();


// ==================================================
// REALTIME: any successful change to the shop's products,
// offers or profile/open state tells customer apps to refetch
// that shop (runs after the response, never delays it)
// ==================================================

const CATALOG_KINDS = [
  [/^\/products/, 'products'],
  [/^\/offers/, 'offers'],
  [/^\/(profile|open|settings)$/, 'shop'],
];

// Every successful change is written to shop_activity_log (who + what)
router.use(auditShopChanges);

router.use((req, res, next) => {
  if (req.method === 'GET') {
    return next();
  }

  const match = CATALOG_KINDS.find(([pattern]) => pattern.test(req.path));

  if (match) {
    res.on('finish', () => {
      if (res.statusCode < 400 && req.shop?.shopId) {
        broadcastCatalogChange(req.app.get('io'), req.shop.shopId, match[1]);
      }
    });
  }

  return next();
});


// ==================================================
// IMAGE UPLOADS (JPG / PNG / WEBP, max 5MB)
// ==================================================

const imageStorage = (folder, prefix) =>
  multer.diskStorage({
    destination: (req, file, cb) => cb(null, `uploads/${folder}`),
    filename: (req, file, cb) => {
      const extension = path.extname(file.originalname).toLowerCase();
      const uniqueName = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;

      cb(null, uniqueName);
    },
  });

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG and WEBP images are allowed'));
  }
};

const uploader = (folder, prefix) =>
  multer({
    storage: imageStorage(folder, prefix),
    fileFilter,
    limits: { fileSize: 5 * 1024 * 1024 },
  });

const uploadProduct = uploader('products', 'product');
const uploadShop = uploader('shops', 'shop');

// Product spreadsheets (.xlsx / .csv, max 20MB with photos) stay in memory
const uploadSheet = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (/\.(xlsx|csv)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Only .xlsx and .csv files can be imported. In Excel, use Save As > Excel Workbook (.xlsx)'));
    }
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});


// ==================================================
// ACCOUNT
// ==================================================

router.post('/register', loginRateLimit, registerShop);
router.post('/login', loginRateLimit, loginShop);

router.get('/me', shopAuthMiddleware, getShopProfile);
router.put('/profile', shopAuthMiddleware, OWNER, uploadShop.single('image'), updateShopProfile);
router.patch('/open', shopAuthMiddleware, MANAGER, setShopOpen);
router.put('/settings', shopAuthMiddleware, MANAGER, staffAccount.updateSettings);
router.put('/password', shopAuthMiddleware, staffAccount.changePassword);

// Staff accounts (owner) + activity log (owner / manager)
router.get('/staff', shopAuthMiddleware, OWNER, staffAccount.listStaff);
router.post('/staff', shopAuthMiddleware, OWNER, staffAccount.createStaff);
router.patch('/staff/:id', shopAuthMiddleware, OWNER, staffAccount.updateStaff);
router.get('/activity', shopAuthMiddleware, MANAGER, staffAccount.getActivity);


// ==================================================
// DASHBOARD + ORDERS + BILLS + NOTIFICATIONS
// ==================================================

router.get('/dashboard', shopAuthMiddleware, insights.getDashboard);
router.get('/orders', shopAuthMiddleware, getOrders);
router.get('/orders/:id', shopAuthMiddleware, getOrder);
router.get('/bills', shopAuthMiddleware, insights.getBills);
router.get('/notifications', shopAuthMiddleware, insights.getNotifications);


// ==================================================
// PRODUCTS + STOCK
// Staff: stock and availability only; managers: everything else
// ==================================================

router.get('/products', shopAuthMiddleware, getProducts);
router.get('/products/import/template', shopAuthMiddleware, MANAGER, getImportTemplate);
router.post('/products/import', shopAuthMiddleware, MANAGER, uploadSheet.single('file'), importProducts);
router.get('/products/export', shopAuthMiddleware, MANAGER, insights.exportProducts);
router.get('/stock/movements', shopAuthMiddleware, insights.getStockMovements);
router.get('/products/:id', shopAuthMiddleware, getProduct);
router.get('/products/:id/stock-history', shopAuthMiddleware, insights.getProductStockHistory);
router.get('/products/:id/price-history', shopAuthMiddleware, getProductPriceHistory);
router.patch('/products/:id/price', shopAuthMiddleware, MANAGER, patchProductPrice);
router.post('/products/:id/stock', shopAuthMiddleware, STAFF, insights.adjustProductStock);
router.post('/products', shopAuthMiddleware, MANAGER, uploadProduct.single('image'), addProduct);
router.put('/products/:id', shopAuthMiddleware, MANAGER, uploadProduct.single('image'), updateProduct);
router.patch('/products/:id', shopAuthMiddleware, STAFF, patchProduct);
router.delete('/products/:id', shopAuthMiddleware, MANAGER, deleteProduct);

// Offers (the shop's own discounts, pricing/offers.js)
router.get('/offers', shopAuthMiddleware, getOffers);
router.post('/offers', shopAuthMiddleware, MANAGER, createOffer);
router.patch('/offers/:id', shopAuthMiddleware, MANAGER, updateOffer);
router.delete('/offers/:id', shopAuthMiddleware, MANAGER, deleteOffer);
router.get('/catalog/:barcode', shopAuthMiddleware, lookupBarcode);


// ==================================================
// UPLOAD ERRORS -> clear 400 instead of a 500
// ==================================================

router.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? error.field === 'file'
            ? 'File is too large. Maximum size is 20MB. Use smaller photos or split the file.'
            : 'Image is too large. Maximum size is 5MB.'
          : error.message,
    });
  }

  if (error?.message?.startsWith('Only JPG') || error?.message?.startsWith('Only .xlsx')) {
    return res.status(400).json({ success: false, message: error.message });
  }

  return next(error);
});

module.exports = router;
