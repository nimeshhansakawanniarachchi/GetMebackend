
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
var { requireSignedBill, signBillLinksInJson } = require('./src/utils/billUrls');

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

app.set(
  'views',
  path.join(__dirname, 'views')
);

app.set('view engine', 'jade');

// ==================================================
// MIDDLEWARE
// ==================================================

app.use(logger('dev'));

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

app.use(express.json());

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
  express.static(rootShopperItemsPath)
);

app.use(
  '/items',
  express.static(srcShopperItemsPath)
);

// Existing URL format: /uploads/items/example.jpg
app.use(
  '/uploads/items',
  express.static(rootShopperItemsPath)
);

app.use(
  '/uploads/items',
  express.static(srcShopperItemsPath)
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
  express.static(srcReplacementsPath)
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
// CUSTOMER ORDER MEDIA
// ==================================================

app.use(
  '/uploads/order-media',
  express.static(orderMediaPath)
);

// ==================================================
// DELIVERY PHOTOS (shopper's photo at the door)
// ==================================================

app.use(
  '/uploads/deliveries',
  express.static(path.join(srcUploadsPath, 'deliveries'))
);

// Shopper profile photos (customers see them on the map)
app.use(
  '/uploads/shoppers',
  express.static(path.join(srcUploadsPath, 'shoppers'))
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

// ==================================================
// CUSTOMER ORDER MEDIA API
// ==================================================

app.use('/api/customer', customerOrderMediaRoutes);

// ==================================================
// CUSTOMER SAVED ADDRESSES + ADDRESS SEARCH API
// ==================================================

app.use('/api/customer', customerAddressRoutes);

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

// ==================================================
// CHAT API
// ==================================================

app.use('/api/chat', chatRoutes);

// ==================================================
// PAYMENT API
// ==================================================

app.use('/api/payments', paymentRoutes);

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
        message:
          err.message ||
          'Internal server error',
      });
  }

  // NORMAL WEBSITE ERRORS
  res.locals.message = err.message;

  res.locals.error =
    req.app.get('env') === 'development'
      ? err
      : {};

  res.status(err.status || 500);

  res.render('error');
});

// ==================================================
// EXPORT
// ==================================================

module.exports = app;
