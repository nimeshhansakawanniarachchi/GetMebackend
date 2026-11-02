
// var createError = require('http-errors');
// var express = require('express');
// var path = require('path');
// var cookieParser = require('cookie-parser');
// var logger = require('morgan');
// var cors = require('cors');

// require('dotenv').config();

// // ==================================================
// // ROUTES
// // ==================================================

// var indexRouter = require('./routes/index');
// var usersRouter = require('./routes/users');

// var authRouter = require('./src/routes/auth');
// var shopRoutes = require('./src/routes/shopRoutes');
// var customerShopRoutes = require('./src/routes/customerShopRoutes');
// var customerOrderRoutes = require('./src/routes/customerOrderRoutes');
// var customerOrderMediaRoutes = require('./src/routes/customerOrderMediaRoutes');
// var adminRoutes = require('./src/routes/adminRoutes');
// var shopperAuthRoutes = require('./src/routes/shopperAuthRoutes');
// var shopperLocationRoutes = require('./src/routes/shopperLocationRoutes');
// var shopperOrderRoutes = require('./src/routes/shopperOrderRoutes');
// var chatRoutes = require('./src/routes/chatRoutes');

// var db = require('./src/config/db');

// // ==================================================
// // APP
// // ==================================================

// var app = express();

// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {
//     console.log('✅ Database test successful');
//   })
//   .catch((err) => {
//     console.error(
//       '❌ Database connection failed:',
//       err.message
//     );
//   });

// // ==================================================
// // APP SETTINGS
// // ==================================================

// app.set(
//   'views',
//   path.join(__dirname, 'views')
// );

// app.set('view engine', 'jade');

// // ==================================================
// // MIDDLEWARE
// // ==================================================

// app.use(logger('dev'));

// app.use(cors());

// app.use(express.json());

// app.use(
//   express.urlencoded({
//     extended: false,
//   })
// );

// app.use(cookieParser());

// // ==================================================
// // PUBLIC FILES
// // ==================================================

// app.use(
//   express.static(
//     path.join(__dirname, 'public')
//   )
// );

// // ==================================================
// // UPLOAD PATHS
// // ==================================================

// const rootUploadsPath = path.join(
//   __dirname,
//   'uploads'
// );

// const srcUploadsPath = path.join(
//   __dirname,
//   'src',
//   'uploads'
// );

// const rootProductsPath = path.join(
//   rootUploadsPath,
//   'products'
// );

// const rootShopsPath = path.join(
//   rootUploadsPath,
//   'shops'
// );

// // Shopper item photos may exist in either location.
// const rootShopperItemsPath = path.join(
//   rootUploadsPath,
//   'items'
// );

// const srcShopperItemsPath = path.join(
//   srcUploadsPath,
//   'items'
// );

// const srcReplacementsPath = path.join(
//   srcUploadsPath,
//   'replacements'
// );

// const shopperBillsPath = path.join(
//   srcUploadsPath,
//   'bills'
// );

// const orderMediaPath = path.join(
//   srcUploadsPath,
//   'order-media'
// );

// // ==================================================
// // UPLOAD PATH DEBUG
// // ==================================================

// console.log('==========================================');

// console.log('📁 ROOT UPLOADS:', rootUploadsPath);
// console.log('📁 ROOT PRODUCTS:', rootProductsPath);
// console.log('📁 ROOT SHOPS:', rootShopsPath);
// console.log('📁 ROOT SHOPPER ITEMS:', rootShopperItemsPath);
// console.log('📁 SRC SHOPPER ITEMS:', srcShopperItemsPath);
// console.log('📁 SRC REPLACEMENTS:', srcReplacementsPath);
// console.log('📁 SHOPPER BILLS:', shopperBillsPath);
// console.log('📁 CUSTOMER ORDER MEDIA:', orderMediaPath);

// console.log('==========================================');

// // ==================================================
// // SHOPPER ITEM PHOTOS
// // ==================================================
// //
// // Database path example:
// // /items/order-201-item-335-1791703358212.jpg
// //
// // Also supports:
// // /uploads/items/order-201-item-335-1791703358212.jpg
// //
// // Actual folders supported:
// // customer-backend/uploads/items
// // customer-backend/src/uploads/items
// // ==================================================

// // Original database URL format: /items/example.jpg
// app.use(
//   '/items',
//   express.static(rootShopperItemsPath)
// );

// app.use(
//   '/items',
//   express.static(srcShopperItemsPath)
// );

// // Existing URL format: /uploads/items/example.jpg
// app.use(
//   '/uploads/items',
//   express.static(rootShopperItemsPath)
// );

// app.use(
//   '/uploads/items',
//   express.static(srcShopperItemsPath)
// );

// // ==================================================
// // PRODUCT IMAGES
// // ==================================================

// app.use(
//   '/uploads/products',
//   express.static(rootProductsPath)
// );

// // ==================================================
// // SHOP IMAGES
// // ==================================================

// app.use(
//   '/uploads/shops',
//   express.static(rootShopsPath)
// );

// // ==================================================
// // REPLACEMENT ITEM PHOTOS
// // ==================================================

// app.use(
//   '/uploads/replacements',
//   express.static(srcReplacementsPath)
// );

// // ==================================================
// // SHOPPER BILL PHOTOS
// // ==================================================

// app.use(
//   '/uploads/bills',
//   express.static(shopperBillsPath)
// );

// // ==================================================
// // CUSTOMER ORDER MEDIA
// // ==================================================

// app.use(
//   '/uploads/order-media',
//   express.static(orderMediaPath)
// );

// // ==================================================
// // OTHER ROOT UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(rootUploadsPath)
// );

// // ==================================================
// // ROUTES
// // ==================================================

// app.use('/', indexRouter);

// app.use('/users', usersRouter);

// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use('/api/auth', authRouter);

// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use('/api/shop', shopRoutes);

// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use('/api/customer', customerShopRoutes);

// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use('/api/customer', customerOrderRoutes);

// // ==================================================
// // CUSTOMER ORDER MEDIA API
// // ==================================================

// app.use('/api/customer', customerOrderMediaRoutes);

// // ==================================================
// // ADMIN API
// // ==================================================

// app.use('/api/admin', adminRoutes);

// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use('/api/shopper/auth', shopperAuthRoutes);

// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use('/api/shopper', shopperLocationRoutes);

// // ==================================================
// // SHOPPER ORDERS
// // ==================================================

// app.use('/api/shopper', shopperOrderRoutes);

// // ==================================================
// // CHAT API
// // ==================================================

// app.use('/api/chat', chatRoutes);

// // ==================================================
// // 404
// // ==================================================

// app.use(function (req, res, next) {
//   next(createError(404));
// });

// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function (err, req, res, next) {
//   console.error('❌ SERVER ERROR:', err);

//   // MULTER FILE SIZE ERROR
//   if (err.code === 'LIMIT_FILE_SIZE') {
//     return res
//       .status(400)
//       .json({
//         success: false,
//         message: 'Image size must be less than 5 MB',
//       });
//   }

//   // MULTER FILE TYPE ERROR
//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {
//     return res
//       .status(400)
//       .json({
//         success: false,
//         message: err.message,
//       });
//   }

//   // API ERRORS
//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {
//     return res
//       .status(err.status || 500)
//       .json({
//         success: false,
//         message:
//           err.message ||
//           'Internal server error',
//       });
//   }

//   // NORMAL WEBSITE ERRORS
//   res.locals.message = err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(err.status || 500);

//   res.render('error');
// });

// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = app;



var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');
var { requireSignedBill, requireSignedMedia, signBillLinksInJson } = require('./src/utils/billUrls');
var supportPhotos = require('./src/support/supportPhotos');

require('dotenv').config();

// ==================================================
// ROUTES
// ==================================================

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var authRouter = require('./src/routes/auth');
var shopRoutes = require('./src/routes/shopRoutes');
var customerShopRoutes = require('./src/routes/customerShopRoutes');
var customerOrderRoutes = require('./src/routes/customerOrderRoutes');
// Phase 57: notification centre + order activity
var customerNotificationRoutes = require('./src/routes/customerNotificationRoutes');
// Phase 58: saved shopping lists
var shoppingListRoutes = require('./src/routes/shoppingListRoutes');
var customerOrderMediaRoutes = require('./src/routes/customerOrderMediaRoutes');
var customerAddressRoutes = require('./src/routes/customerAddressRoutes');
var adminRoutes = require('./src/routes/adminRoutes');
var shopperAuthRoutes = require('./src/routes/shopperAuthRoutes');
var shopperLocationRoutes = require('./src/routes/shopperLocationRoutes');
var shopperOrderRoutes = require('./src/routes/shopperOrderRoutes');
var shopperAccountRoutes = require('./src/routes/shopperAccountRoutes');
var chatRoutes = require('./src/routes/chatRoutes');

// NEW: PAYMENT ROUTES
var paymentRoutes = require('./src/routes/paymentRoutes');

var db = require('./src/config/db');

// ==================================================
// APP
// ==================================================

var app = express();

// Behind a reverse proxy / load balancer set TRUST_PROXY (e.g. 1 = one
// proxy hop) so req.ip is the customer's address, not the proxy's.
// Off by default: without a proxy, X-Forwarded-For could be forged.
if (process.env.TRUST_PROXY) {
  var trustProxy = process.env.TRUST_PROXY;
  app.set('trust proxy', /^[0-9]+$/.test(trustProxy) ? Number(trustProxy) : trustProxy === 'true' ? true : trustProxy);
}

// ==================================================
// DATABASE TEST
// ==================================================

db.query('SELECT NOW()')
  .then(() => {
    console.log('✅ Database test successful');
  })
  .catch((err) => {
    console.error(
      '❌ Database connection failed:',
      err.message
    );
  });

// ==================================================
// APP SETTINGS
// ==================================================

// No template engine: the old jade views (unmaintained package with
// known advisories) were replaced by plain responses (security review B-06)

// ==================================================
// MIDDLEWARE
// ==================================================

app.use(logger('dev'));

// Technical error log for the admin Developer role (phase 40): 5xx
// answers (route patterns only) + server error labels, kept in memory
const systemHealth = require('./src/admin/systemHealth');
systemHealth.hookConsole();
app.use(systemHealth.trackResponses);

// Browsers may only call the API from the admin panel / shop website.
// Mobile apps send no Origin header, so they are always allowed.
const allowedOrigins = String(
  process.env.CORS_ORIGINS ||
    'http://localhost:5173,http://localhost:5174'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.set('allowedOrigins', allowedOrigins);

app.use(
  cors({
    origin: (origin, callback) =>
      callback(null, !origin || allowedOrigins.includes(origin)),
  })
);

// ==================================================
// SECURITY HEADERS (security review 2026-10-30, B-23)
// HSTS belongs on the TLS proxy in front of this server.
// ==================================================

app.disable('x-powered-by');

app.use(function (req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Uploaded files are data, never pages: a file that passed as an
// "image" but holds HTML / SVG script can't run on this origin (B-02)
app.use(['/uploads', '/items'], function (req, res, next) {
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// Phase 55: signed bank callbacks are verified over the exact bytes sent
app.use(
  express.json({
    verify: (req, res, buf) => {
      if (req.originalUrl.startsWith('/api/payments/lankaqr/callback')) req.rawBody = buf.toString('utf8');
    },
  })
);

app.use(
  express.urlencoded({
    extended: false,
  })
);

app.use(cookieParser());

// ==================================================
// PUBLIC FILES
// ==================================================

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

// ==================================================
// UPLOAD PATHS
// ==================================================

const rootUploadsPath = path.join(
  __dirname,
  'uploads'
);

const srcUploadsPath = path.join(
  __dirname,
  'src',
  'uploads'
);

const rootProductsPath = path.join(
  rootUploadsPath,
  'products'
);

const rootShopsPath = path.join(
  rootUploadsPath,
  'shops'
);

// Shopper item photos may exist in either location.
const rootShopperItemsPath = path.join(
  rootUploadsPath,
  'items'
);

const srcShopperItemsPath = path.join(
  srcUploadsPath,
  'items'
);

const srcReplacementsPath = path.join(
  srcUploadsPath,
  'replacements'
);

const shopperBillsPath = path.join(
  srcUploadsPath,
  'bills'
);

const orderMediaPath = path.join(
  srcUploadsPath,
  'order-media'
);

// ==================================================
// UPLOAD PATH DEBUG
// ==================================================

console.log('==========================================');

console.log('📁 ROOT UPLOADS:', rootUploadsPath);
console.log('📁 ROOT PRODUCTS:', rootProductsPath);
console.log('📁 ROOT SHOPS:', rootShopsPath);
console.log('📁 ROOT SHOPPER ITEMS:', rootShopperItemsPath);
console.log('📁 SRC SHOPPER ITEMS:', srcShopperItemsPath);
console.log('📁 SRC REPLACEMENTS:', srcReplacementsPath);
console.log('📁 SHOPPER BILLS:', shopperBillsPath);
console.log('📁 CUSTOMER ORDER MEDIA:', orderMediaPath);

console.log('==========================================');

// ==================================================
// SHOPPER ITEM PHOTOS
// ==================================================

// Original database URL format: /items/example.jpg
app.use(
  '/items',
  requireSignedMedia('items'),
  express.static(rootShopperItemsPath, { cacheControl: false })
);

app.use(
  '/items',
  requireSignedMedia('items'),
  express.static(srcShopperItemsPath, { cacheControl: false })
);

// Existing URL format: /uploads/items/example.jpg
// Private since the security review (B-03): signed links only
app.use(
  '/uploads/items',
  requireSignedMedia('items'),
  express.static(rootShopperItemsPath, { cacheControl: false })
);

app.use(
  '/uploads/items',
  requireSignedMedia('items'),
  express.static(srcShopperItemsPath, { cacheControl: false })
);

// ==================================================
// PRODUCT IMAGES
// ==================================================

app.use(
  '/uploads/products',
  express.static(rootProductsPath)
);

// ==================================================
// SHOP IMAGES
// ==================================================

app.use(
  '/uploads/shops',
  express.static(rootShopsPath)
);

// ==================================================
// REPLACEMENT ITEM PHOTOS
// ==================================================

app.use(
  '/uploads/replacements',
  requireSignedMedia('replacements'),
  express.static(srcReplacementsPath, { cacheControl: false })
);

// ==================================================
// SHOPPER BILL PHOTOS
// Not public: only signed links work (src/utils/billUrls.js). API
// responses sign the bill links they return to callers allowed to
// see that order.
// ==================================================

app.use(
  '/uploads/bills',
  requireSignedBill,
  express.static(shopperBillsPath, { cacheControl: false })
);

// ==================================================
// SUPPORT CASE PHOTOS (phase 43)
// Private like bill photos: signed, expiring links only
// (src/support/supportPhotos.js)
// ==================================================

app.use(
  '/uploads/support-cases',
  supportPhotos.requireSignedPhoto,
  express.static(supportPhotos.STORAGE_DIR, { cacheControl: false })
);

// ==================================================
// CUSTOMER ORDER MEDIA
// ==================================================

app.use(
  '/uploads/order-media',
  requireSignedMedia('order-media'),
  express.static(orderMediaPath, { cacheControl: false })
);

// ==================================================
// DELIVERY PHOTOS (shopper's photo at the door)
// ==================================================

app.use(
  '/uploads/deliveries',
  requireSignedMedia('deliveries'),
  express.static(path.join(srcUploadsPath, 'deliveries'), { cacheControl: false })
);

// Shopper profile photos (customers see them on the map)
// Fuel receipts (phase 54): private, signed links only
app.use(
  '/uploads/fuel-receipts',
  requireSignedMedia('fuel-receipts'),
  express.static(path.join(srcUploadsPath, 'fuel-receipts'), { cacheControl: false })
);

app.use(
  '/uploads/shoppers',
  requireSignedMedia('shoppers'),
  express.static(path.join(srcUploadsPath, 'shoppers'), { cacheControl: false })
);

// ==================================================
// OTHER ROOT UPLOADS
// ==================================================

app.use(
  '/uploads',
  express.static(rootUploadsPath)
);

// ==================================================
// ROUTES
// ==================================================

// Bill photo links in API answers are signed (see SHOPPER BILL PHOTOS)
app.use('/api', signBillLinksInJson);

// No password fields in any reply; no internal error text on 5xx (B-01 / B-18)
app.use('/api', require('./src/middleware/safeJson'));

app.use('/', indexRouter);

app.use('/users', usersRouter);

// ==================================================
// CUSTOMER AUTH
// ==================================================

app.use('/api/auth', authRouter);

// ==================================================
// SHOP WEBSITE API
// ==================================================

app.use('/api/shop', shopRoutes);

// ==================================================
// CUSTOMER SHOP API
// ==================================================

app.use('/api/customer', customerShopRoutes);

// ==================================================
// CUSTOMER ORDER API
// ==================================================

app.use('/api/customer', customerOrderRoutes);
app.use('/api/customer', customerNotificationRoutes);
app.use('/api/customer', shoppingListRoutes);

// ==================================================
// CUSTOMER ORDER MEDIA API
// ==================================================

app.use('/api/customer', customerOrderMediaRoutes);

// ==================================================
// CUSTOMER SAVED ADDRESSES + ADDRESS SEARCH API
// ==================================================

app.use('/api/customer', customerAddressRoutes);

// ==================================================
// CUSTOMER SUPPORT CASES + GETME CREDIT (phase 43)
// ==================================================

app.use('/api/customer', require('./src/routes/customerSupportRoutes'));

// ==================================================
// CUSTOMER ACTIVITY + LOCATION SHARING (phase 51)
// ==================================================

app.use('/api/customer', require('./src/routes/customerActivityRoutes'));

// ==================================================
// ADMIN API
// ==================================================

app.use('/api/admin', adminRoutes);

// ==================================================
// SHOPPER AUTH
// ==================================================

// Step-by-step registration + application (phase 34)
app.use('/api/shopper', require('./src/routes/shopperApplicationRoutes'));

// Protected profile: change requests, phone change, lost-phone recovery (phase 35)
app.use('/api/shopper', require('./src/routes/shopperProfileProtectionRoutes'));

app.use('/api/shopper/auth', shopperAuthRoutes);

// Applicant documents: rejected / idle drafts deleted after 90 days
{
  const runRetention = () =>
    require('./src/onboarding/applications')
      .retentionSweep()
      .then((r) => {
        if (r.documents) console.log(`🧹 Application documents deleted: ${r.documents} (${r.applications} applications)`);
      })
      .catch((error) => console.error('❌ APPLICATION RETENTION:', error.message));
  setTimeout(runRetention, 60 * 1000).unref();
  setInterval(runRetention, 24 * 60 * 60 * 1000).unref();
}

// ==================================================
// SHOPPER LOCATION
// ==================================================

app.use('/api/shopper', shopperLocationRoutes);

// ==================================================
// SHOPPER ORDERS
// ==================================================

app.use('/api/shopper', shopperOrderRoutes);

// ==================================================
// SHOPPER EARNINGS, NOTIFICATIONS, PROFILE, BATCH HIDE
// ==================================================

app.use('/api/shopper', shopperAccountRoutes);

// Shopper wallet: earnings balance, bank accounts, withdrawals
app.use('/api/shopper', require('./src/routes/shopperWalletRoutes'));

// Training quiz + 'I need help' incidents (phase 46)
app.use('/api/shopper', require('./src/routes/shopperSafetyRoutes'));

// Fuel station payments (phase 54): the shopper's own expense, record + receipt
app.use('/api/shopper', require('./src/routes/shopperFuelRoutes'));

// ==================================================
// CHAT API
// ==================================================

app.use('/api/chat', chatRoutes);

// ==================================================
// PAYMENT API
// ==================================================

app.use('/api/payments', paymentRoutes);

// ==================================================
// PHASE 59: MULTI-CATEGORY MARKETPLACE (clothing shops,
// restaurants). Mounted after the existing routers; it adds new
// paths only (code-backups/reports/p59-marketplace-api-contract.md).
// ==================================================

{
  const marketplace = require('./src/routes/marketplaceRoutes');
  app.use('/api/customer', marketplace.customerRouter);
  app.use('/api/shop', marketplace.shopRouter);
  app.use('/api/admin', marketplace.adminRouter);
}

// ==================================================
// PHASE 62: FASHION REELS (shoppable videos, clothing shops)
// ==================================================

{
  const reels = require('./src/routes/reelRoutes');
  app.use('/api/media', reels.mediaRouter);
  app.use('/api/customer', reels.customerRouter);
  app.use('/api/shop', reels.shopRouter);
  app.use('/api/admin', reels.adminRouter);
}

// ==================================================
// PHASE 65: ONE CHECKOUT FOR EVERY CATEGORY (parent orders:
// one Place Order, one reference, child orders per store / grocery)
// ==================================================

{
  const orderGroups = require('./src/routes/orderGroupRoutes');
  app.use('/api/customer', orderGroups.customerRouter);
  app.use('/api/admin', orderGroups.adminRouter);
}

// ==================================================
// 404
// ==================================================

app.use(function (req, res, next) {
  next(createError(404));
});

// ==================================================
// ERROR HANDLER
// ==================================================

app.use(function (err, req, res, next) {
  console.error('❌ SERVER ERROR:', err);

  // MULTER FILE SIZE ERROR
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res
      .status(400)
      .json({
        success: false,
        message: 'Image size must be less than 5 MB',
      });
  }

  // MULTER FILE TYPE ERROR
  if (
    err.message ===
    'Only JPG, PNG and WEBP images are allowed'
  ) {
    return res
      .status(400)
      .json({
        success: false,
        message: err.message,
      });
  }

  // API ERRORS
  if (
    req.originalUrl.startsWith('/api/')
  ) {
    return res
      .status(err.status || 500)
      .json({
        success: false,
        // 4xx messages are meant for the client; a 5xx message is internal (B-18)
        message:
          (err.status || 500) < 500 && err.message
            ? err.message
            : 'Internal server error',
      });
  }

  // NORMAL WEBSITE ERRORS: a short page; details (stack trace) only when
  // NODE_ENV is explicitly 'development' (B-18)
  var status = err.status || 500;
  var escape = function (text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var title = status === 404 ? 'Not found' : status < 500 ? escape(err.message || 'Request error') : 'Server error';
  var details = process.env.NODE_ENV === 'development' && err.stack ? '<pre>' + escape(err.stack) + '</pre>' : '';

  res
    .status(status)
    .type('html')
    .send('<!doctype html><meta charset="utf-8"><title>' + title + '</title><h1>' + title + '</h1>' + details);
});

// ==================================================
// EXPORT
// ==================================================

module.exports = app;
