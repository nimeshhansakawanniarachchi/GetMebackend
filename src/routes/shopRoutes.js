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
  [/^\/(profile|open)$/, 'shop'],
];

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
router.put('/profile', shopAuthMiddleware, uploadShop.single('image'), updateShopProfile);
router.patch('/open', shopAuthMiddleware, setShopOpen);


// ==================================================
// DASHBOARD + ORDERS
// ==================================================

router.get('/dashboard', shopAuthMiddleware, getDashboard);
router.get('/orders', shopAuthMiddleware, getOrders);
router.get('/orders/:id', shopAuthMiddleware, getOrder);


// ==================================================
// PRODUCTS
// ==================================================

router.get('/products', shopAuthMiddleware, getProducts);
router.get('/products/import/template', shopAuthMiddleware, getImportTemplate);
router.post('/products/import', shopAuthMiddleware, uploadSheet.single('file'), importProducts);
router.get('/products/:id', shopAuthMiddleware, getProduct);
router.post('/products', shopAuthMiddleware, uploadProduct.single('image'), addProduct);
router.put('/products/:id', shopAuthMiddleware, uploadProduct.single('image'), updateProduct);
router.patch('/products/:id', shopAuthMiddleware, patchProduct);
router.delete('/products/:id', shopAuthMiddleware, deleteProduct);

// Offers (the shop's own discounts, pricing/offers.js)
router.get('/offers', shopAuthMiddleware, getOffers);
router.post('/offers', shopAuthMiddleware, createOffer);
router.patch('/offers/:id', shopAuthMiddleware, updateOffer);
router.delete('/offers/:id', shopAuthMiddleware, deleteOffer);
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
