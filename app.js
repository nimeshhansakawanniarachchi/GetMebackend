// var createError = require('http-errors');
// var express = require('express');
// var path = require('path');
// var cookieParser = require('cookie-parser');
// var logger = require('morgan');

// require('dotenv').config();

// var indexRouter = require('./routes/index');
// var usersRouter = require('./routes/users');
// var authRouter = require('./src/routes/auth');

// var db = require('./src/config/db');

// var app = express();

// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {
//     console.log('✅ Database test successful');
//   })
//   .catch((err) => {
//     console.error('❌ Database connection failed:', err.message);
//   });

// // ==================================================
// // VIEW ENGINE SETUP
// // ==================================================

// app.set('views', path.join(__dirname, 'views'));
// app.set('view engine', 'jade');

// app.use(logger('dev'));

// app.use(express.json());
// app.use(express.urlencoded({ extended: false }));
// app.use(cookieParser());

// app.use(express.static(path.join(__dirname, 'public')));

// // ==================================================
// // ROUTES
// // ==================================================

// app.use('/', indexRouter);

// app.use('/users', usersRouter);

// app.use('/api/auth', authRouter);

// // ==================================================
// // CATCH 404
// // ==================================================

// app.use(function(req, res, next) {
//   next(createError(404));
// });

// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(err, req, res, next) {
//   res.locals.message = err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(err.status || 500);

//   res.render('error');
// });

// module.exports = app;
















// var createError = require('http-errors');
// var express = require('express');
// var path = require('path');
// var cookieParser = require('cookie-parser');
// var logger = require('morgan');

// require('dotenv').config();

// var indexRouter = require('./routes/index');
// var usersRouter = require('./routes/users');
// var authRouter = require('./src/routes/auth');

// var db = require('./src/config/db');

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
// // VIEW ENGINE
// // ==================================================

// app.set(
//   'views',
//   path.join(__dirname, 'views')
// );

// app.set(
//   'view engine',
//   'jade'
// );

// // ==================================================
// // MIDDLEWARE
// // ==================================================

// app.use(logger('dev'));

// app.use(express.json());

// app.use(
//   express.urlencoded({
//     extended: false,
//   })
// );

// app.use(cookieParser());

// app.use(
//   express.static(
//     path.join(__dirname, 'public')
//   )
// );

// // ==================================================
// // ROUTES
// // ==================================================

// app.use('/', indexRouter);

// app.use('/users', usersRouter);

// app.use(
//   '/api/auth',
//   authRouter
// );

// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {
//   next(createError(404));
// });

// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(err, req, res, next) {

//   res.locals.message = err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');
// });

// // ==================================================
// // EXPORT APP
// // ==================================================

// module.exports = app;








// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter = require('./src/routes/auth');

// var shopRoutes = require('./src/routes/shopRoutes');

// var db = require('./src/config/db');

// var app = express();

// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {
//     console.log(
//       '✅ Database test successful'
//     );
//   })
//   .catch((err) => {
//     console.error(
//       '❌ Database connection failed:',
//       err.message
//     );
//   });

// // ==================================================
// // VIEW ENGINE
// // ==================================================

// app.set(
//   'views',
//   path.join(__dirname, 'views')
// );

// app.set(
//   'view engine',
//   'jade'
// );

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

// app.use(
//   express.static(
//     path.join(__dirname, 'public')
//   )
// );

// // ==================================================
// // ROUTES
// // ==================================================

// app.use('/', indexRouter);

// app.use('/users', usersRouter);

// // Customer API
// app.use(
//   '/api/auth',
//   authRouter
// );

// // Shop API
// app.use(
//   '/api/shop',
//   shopRoutes
// );

// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {
//   next(createError(404));
// });

// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(err, req, res, next) {

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');
// });

// // ==================================================
// // EXPORT APP
// // ==================================================

// module.exports = app;




// var createError = require('http-errors');
// var express = require('express');
// var path = require('path');
// var cookieParser = require('cookie-parser');
// var logger = require('morgan');
// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');
// var usersRouter = require('./routes/users');

// var authRouter = require('./src/routes/auth');
// var shopRoutes = require('./src/routes/shopRoutes');

// var db = require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {
//     console.log(
//       '✅ Database test successful'
//     );
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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );

// app.use(
//   '/api/auth',
//   authRouter
// );

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {
//   next(
//     createError(404)
//   );
// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {
//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );

//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {
//     return res.status(400).json({
//       success: false,
//       message:
//         'Image size must be less than 5 MB',
//     });
//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {
//     return res.status(400).json({
//       success: false,
//       message: err.message,
//     });
//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {
//     return res.status(
//       err.status || 500
//     ).json({
//       success: false,
//       message:
//         err.message ||
//         'Internal server error',
//     });
//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');
// });


// module.exports = app;


















// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter = require('./src/routes/auth');

// var shopRoutes = require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var db = require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT / SHOP IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;




// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter = require('./src/routes/auth');

// var shopRoutes = require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var db = require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT / SHOP IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;









// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter = require('./src/routes/auth');

// var shopRoutes = require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var db = require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT / SHOP IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;




// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');

// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT / SHOP IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;





// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');

// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT / SHOP IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;






// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');


// // ==================================================
// // SHOPPER LOCATION ROUTES
// // ==================================================

// var shopperLocationRoutes =
//   require('./src/routes/shopperLocationRoutes');


// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT / SHOP IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperLocationRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;









// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');


// // ==================================================
// // SHOPPER LOCATION ROUTES
// // ==================================================

// var shopperLocationRoutes =
//   require('./src/routes/shopperLocationRoutes');


// // ==================================================
// // SHOPPER ORDER ROUTES
// // ==================================================

// var shopperOrderRoutes =
//   require('./src/routes/shopperOrderRoutes');


// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT / SHOP IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperLocationRoutes
// );


// // ==================================================
// // SHOPPER ORDERS
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperOrderRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;


















// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');


// // ==================================================
// // SHOPPER LOCATION ROUTES
// // ==================================================

// var shopperLocationRoutes =
//   require('./src/routes/shopperLocationRoutes');


// // ==================================================
// // SHOPPER ORDER ROUTES
// // ==================================================

// var shopperOrderRoutes =
//   require('./src/routes/shopperOrderRoutes');


// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT / SHOP / SHOPPER IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperLocationRoutes
// );


// // ==================================================
// // SHOPPER ORDERS
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperOrderRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;






// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');


// // ==================================================
// // SHOPPER LOCATION ROUTES
// // ==================================================

// var shopperLocationRoutes =
//   require('./src/routes/shopperLocationRoutes');


// // ==================================================
// // SHOPPER ORDER ROUTES
// // ==================================================

// var shopperOrderRoutes =
//   require('./src/routes/shopperOrderRoutes');


// // ==================================================
// // CHAT ROUTES
// // ==================================================

// var chatRoutes =
//   require('./src/routes/chatRoutes');


// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// // PRODUCT / SHOP / SHOPPER IMAGE UPLOADS
// // ==================================================

// app.use(
//   '/uploads',
//   express.static(
//     path.join(__dirname, 'uploads')
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperLocationRoutes
// );


// // ==================================================
// // SHOPPER ORDERS
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperOrderRoutes
// );


// // ==================================================
// // CHAT API
// // ==================================================

// app.use(
//   '/api/chat',
//   chatRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;










// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');


// // ==================================================
// // SHOPPER LOCATION ROUTES
// // ==================================================

// var shopperLocationRoutes =
//   require('./src/routes/shopperLocationRoutes');


// // ==================================================
// // SHOPPER ORDER ROUTES
// // ==================================================

// var shopperOrderRoutes =
//   require('./src/routes/shopperOrderRoutes');


// // ==================================================
// // CHAT ROUTES
// // ==================================================

// var chatRoutes =
//   require('./src/routes/chatRoutes');


// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// //
// // IMPORTANT
// //
// // Product / shop images:
// //
// // customer-backend/uploads/
// //
// // Shopper item photos:
// //
// // customer-backend/src/uploads/items/
// //
// // Therefore we serve them separately.
// //

// const rootUploadsPath =
//   path.join(
//     __dirname,
//     'uploads'
//   );


// const srcUploadsPath =
//   path.join(
//     __dirname,
//     'src',
//     'uploads'
//   );


// const rootProductsPath =
//   path.join(
//     rootUploadsPath,
//     'products'
//   );


// const rootShopsPath =
//   path.join(
//     rootUploadsPath,
//     'shops'
//   );


// const shopperItemsPath =
//   path.join(
//     srcUploadsPath,
//     'items'
//   );


// // ==================================================
// // UPLOAD PATH DEBUG
// // ==================================================

// console.log(
//   '=========================================='
// );

// console.log(
//   '📁 ROOT UPLOADS:',
//   rootUploadsPath
// );

// console.log(
//   '📁 ROOT PRODUCTS:',
//   rootProductsPath
// );

// console.log(
//   '📁 ROOT SHOPS:',
//   rootShopsPath
// );

// console.log(
//   '📁 SHOPPER ITEMS:',
//   shopperItemsPath
// );

// console.log(
//   '=========================================='
// );


// // ==================================================
// // SHOPPER ITEM PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/items/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/items
// //

// app.use(
//   '/uploads/items',
//   express.static(
//     shopperItemsPath
//   )
// );


// // ==================================================
// // PRODUCT IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/products/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/products
// //

// app.use(
//   '/uploads/products',
//   express.static(
//     rootProductsPath
//   )
// );


// // ==================================================
// // SHOP IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/shops/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/shops
// //

// app.use(
//   '/uploads/shops',
//   express.static(
//     rootShopsPath
//   )
// );


// // ==================================================
// // OTHER UPLOADS
// // ==================================================
// //
// // Keep the original uploads folder available
// // for any other existing upload types.
// //

// app.use(
//   '/uploads',
//   express.static(
//     rootUploadsPath
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperLocationRoutes
// );


// // ==================================================
// // SHOPPER ORDERS
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperOrderRoutes
// );


// // ==================================================
// // CHAT API
// // ==================================================

// app.use(
//   '/api/chat',
//   chatRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;




































// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');


// // ==================================================
// // SHOPPER LOCATION ROUTES
// // ==================================================

// var shopperLocationRoutes =
//   require('./src/routes/shopperLocationRoutes');


// // ==================================================
// // SHOPPER ORDER ROUTES
// // ==================================================

// var shopperOrderRoutes =
//   require('./src/routes/shopperOrderRoutes');


// // ==================================================
// // CHAT ROUTES
// // ==================================================

// var chatRoutes =
//   require('./src/routes/chatRoutes');


// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// //
// // IMPORTANT
// //
// // Product / shop images:
// //
// // customer-backend/uploads/
// //
// // Shopper item photos:
// //
// // customer-backend/src/uploads/items/
// //
// // Replacement item photos:
// //
// // customer-backend/uploads/replacements/
// //
// // Therefore we serve them separately.
// //

// const rootUploadsPath =
//   path.join(
//     __dirname,
//     'uploads'
//   );


// const srcUploadsPath =
//   path.join(
//     __dirname,
//     'src',
//     'uploads'
//   );


// const rootProductsPath =
//   path.join(
//     rootUploadsPath,
//     'products'
//   );


// const rootShopsPath =
//   path.join(
//     rootUploadsPath,
//     'shops'
//   );


// const rootReplacementsPath =
//   path.join(
//     rootUploadsPath,
//     'replacements'
//   );


// const shopperItemsPath =
//   path.join(
//     srcUploadsPath,
//     'items'
//   );


// // ==================================================
// // UPLOAD PATH DEBUG
// // ==================================================

// console.log(
//   '=========================================='
// );

// console.log(
//   '📁 ROOT UPLOADS:',
//   rootUploadsPath
// );

// console.log(
//   '📁 ROOT PRODUCTS:',
//   rootProductsPath
// );

// console.log(
//   '📁 ROOT SHOPS:',
//   rootShopsPath
// );

// console.log(
//   '📁 ROOT REPLACEMENTS:',
//   rootReplacementsPath
// );

// console.log(
//   '📁 SHOPPER ITEMS:',
//   shopperItemsPath
// );

// console.log(
//   '=========================================='
// );


// // ==================================================
// // SHOPPER ITEM PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/items/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/items
// //

// app.use(
//   '/uploads/items',
//   express.static(
//     shopperItemsPath
//   )
// );


// // ==================================================
// // PRODUCT IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/products/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/products
// //

// app.use(
//   '/uploads/products',
//   express.static(
//     rootProductsPath
//   )
// );


// // ==================================================
// // SHOP IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/shops/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/shops
// //

// app.use(
//   '/uploads/shops',
//   express.static(
//     rootShopsPath
//   )
// );


// // ==================================================
// // REPLACEMENT ITEM PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/replacements/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/replacements
// //

// app.use(
//   '/uploads/replacements',
//   express.static(
//     rootReplacementsPath
//   )
// );


// // ==================================================
// // OTHER UPLOADS
// // ==================================================
// //
// // Keep the original uploads folder available
// // for any other existing upload types.
// //

// app.use(
//   '/uploads',
//   express.static(
//     rootUploadsPath
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperLocationRoutes
// );


// // ==================================================
// // SHOPPER ORDERS
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperOrderRoutes
// );


// // ==================================================
// // CHAT API
// // ==================================================

// app.use(
//   '/api/chat',
//   chatRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;




















































// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');


// // ==================================================
// // SHOPPER LOCATION ROUTES
// // ==================================================

// var shopperLocationRoutes =
//   require('./src/routes/shopperLocationRoutes');


// // ==================================================
// // SHOPPER ORDER ROUTES
// // ==================================================

// var shopperOrderRoutes =
//   require('./src/routes/shopperOrderRoutes');


// // ==================================================
// // CHAT ROUTES
// // ==================================================

// var chatRoutes =
//   require('./src/routes/chatRoutes');


// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// //
// // IMPORTANT
// //
// // Product / shop images:
// //
// // customer-backend/uploads/
// //
// // Shopper item photos:
// //
// // customer-backend/src/uploads/items/
// //
// // Replacement item photos:
// //
// // customer-backend/src/uploads/replacements/
// //
// // Therefore we serve them separately.
// //

// const rootUploadsPath =
//   path.join(
//     __dirname,
//     'uploads'
//   );


// const srcUploadsPath =
//   path.join(
//     __dirname,
//     'src',
//     'uploads'
//   );


// const rootProductsPath =
//   path.join(
//     rootUploadsPath,
//     'products'
//   );


// const rootShopsPath =
//   path.join(
//     rootUploadsPath,
//     'shops'
//   );


// const srcReplacementsPath =
//   path.join(
//     srcUploadsPath,
//     'replacements'
//   );


// const shopperItemsPath =
//   path.join(
//     srcUploadsPath,
//     'items'
//   );


// // ==================================================
// // UPLOAD PATH DEBUG
// // ==================================================

// console.log(
//   '=========================================='
// );

// console.log(
//   '📁 ROOT UPLOADS:',
//   rootUploadsPath
// );

// console.log(
//   '📁 ROOT PRODUCTS:',
//   rootProductsPath
// );

// console.log(
//   '📁 ROOT SHOPS:',
//   rootShopsPath
// );

// console.log(
//   '📁 SRC REPLACEMENTS:',
//   srcReplacementsPath
// );

// console.log(
//   '📁 SHOPPER ITEMS:',
//   shopperItemsPath
// );

// console.log(
//   '=========================================='
// );


// // ==================================================
// // SHOPPER ITEM PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/items/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/items
// //

// app.use(
//   '/uploads/items',
//   express.static(
//     shopperItemsPath
//   )
// );


// // ==================================================
// // PRODUCT IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/products/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/products
// //

// app.use(
//   '/uploads/products',
//   express.static(
//     rootProductsPath
//   )
// );


// // ==================================================
// // SHOP IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/shops/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/shops
// //

// app.use(
//   '/uploads/shops',
//   express.static(
//     rootShopsPath
//   )
// );


// // ==================================================
// // REPLACEMENT ITEM PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/replacements/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/replacements
// //

// app.use(
//   '/uploads/replacements',
//   express.static(
//     srcReplacementsPath
//   )
// );


// // ==================================================
// // OTHER UPLOADS
// // ==================================================
// //
// // Keep the original uploads folder available
// // for any other existing upload types.
// //

// app.use(
//   '/uploads',
//   express.static(
//     rootUploadsPath
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperLocationRoutes
// );


// // ==================================================
// // SHOPPER ORDERS
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperOrderRoutes
// );


// // ==================================================
// // CHAT API
// // ==================================================

// app.use(
//   '/api/chat',
//   chatRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;






















// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();

// var indexRouter = require('./routes/index');

// var usersRouter = require('./routes/users');

// var authRouter =
//   require('./src/routes/auth');

// var shopRoutes =
//   require('./src/routes/shopRoutes');

// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');

// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');

// var adminRoutes =
//   require('./src/routes/adminRoutes');

// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');


// // ==================================================
// // SHOPPER LOCATION ROUTES
// // ==================================================

// var shopperLocationRoutes =
//   require('./src/routes/shopperLocationRoutes');


// // ==================================================
// // SHOPPER ORDER ROUTES
// // ==================================================

// var shopperOrderRoutes =
//   require('./src/routes/shopperOrderRoutes');


// // ==================================================
// // CHAT ROUTES
// // ==================================================

// var chatRoutes =
//   require('./src/routes/chatRoutes');


// var db =
//   require('./src/config/db');

// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// //
// // IMPORTANT
// //
// // Product / shop images:
// //
// // customer-backend/uploads/
// //
// // Shopper item photos:
// //
// // customer-backend/src/uploads/items/
// //
// // Replacement item photos:
// //
// // customer-backend/src/uploads/replacements/
// //
// // Shopper bill photos:
// //
// // customer-backend/src/uploads/bills/
// //
// // Therefore we serve them separately.
// //

// const rootUploadsPath =
//   path.join(
//     __dirname,
//     'uploads'
//   );


// const srcUploadsPath =
//   path.join(
//     __dirname,
//     'src',
//     'uploads'
//   );


// const rootProductsPath =
//   path.join(
//     rootUploadsPath,
//     'products'
//   );


// const rootShopsPath =
//   path.join(
//     rootUploadsPath,
//     'shops'
//   );


// const srcReplacementsPath =
//   path.join(
//     srcUploadsPath,
//     'replacements'
//   );


// const shopperItemsPath =
//   path.join(
//     srcUploadsPath,
//     'items'
//   );


// const shopperBillsPath =
//   path.join(
//     srcUploadsPath,
//     'bills'
//   );


// // ==================================================
// // UPLOAD PATH DEBUG
// // ==================================================

// console.log(
//   '=========================================='
// );

// console.log(
//   '📁 ROOT UPLOADS:',
//   rootUploadsPath
// );

// console.log(
//   '📁 ROOT PRODUCTS:',
//   rootProductsPath
// );

// console.log(
//   '📁 ROOT SHOPS:',
//   rootShopsPath
// );

// console.log(
//   '📁 SRC REPLACEMENTS:',
//   srcReplacementsPath
// );

// console.log(
//   '📁 SHOPPER ITEMS:',
//   shopperItemsPath
// );

// console.log(
//   '📁 SHOPPER BILLS:',
//   shopperBillsPath
// );

// console.log(
//   '=========================================='
// );


// // ==================================================
// // SHOPPER ITEM PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/items/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/items
// //

// app.use(
//   '/uploads/items',
//   express.static(
//     shopperItemsPath
//   )
// );


// // ==================================================
// // PRODUCT IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/products/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/products
// //

// app.use(
//   '/uploads/products',
//   express.static(
//     rootProductsPath
//   )
// );


// // ==================================================
// // SHOP IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/shops/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/shops
// //

// app.use(
//   '/uploads/shops',
//   express.static(
//     rootShopsPath
//   )
// );


// // ==================================================
// // REPLACEMENT ITEM PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/replacements/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/replacements
// //

// app.use(
//   '/uploads/replacements',
//   express.static(
//     srcReplacementsPath
//   )
// );


// // ==================================================
// // SHOPPER BILL PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/bills/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/bills
// //

// app.use(
//   '/uploads/bills',
//   express.static(
//     shopperBillsPath
//   )
// );


// // ==================================================
// // OTHER UPLOADS
// // ==================================================
// //
// // Keep the original uploads folder available
// // for any other existing upload types.
// //

// app.use(
//   '/uploads',
//   express.static(
//     rootUploadsPath
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperLocationRoutes
// );


// // ==================================================
// // SHOPPER ORDERS
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperOrderRoutes
// );


// // ==================================================
// // CHAT API
// // ==================================================

// app.use(
//   '/api/chat',
//   chatRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(function(req, res, next) {

//   next(
//     createError(404)
//   );

// });


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(function(
//   err,
//   req,
//   res,
//   next
// ) {

//   console.error(
//     '❌ SERVER ERROR:',
//     err
//   );


//   // ================================================
//   // MULTER FILE SIZE ERROR
//   // ================================================

//   if (
//     err.code === 'LIMIT_FILE_SIZE'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message:
//         'Image size must be less than 5 MB',

//     });

//   }


//   // ================================================
//   // MULTER FILE TYPE ERROR
//   // ================================================

//   if (
//     err.message ===
//     'Only JPG, PNG and WEBP images are allowed'
//   ) {

//     return res.status(400).json({

//       success: false,

//       message: err.message,

//     });

//   }


//   // ================================================
//   // ALL API ERRORS
//   // ================================================

//   if (
//     req.originalUrl.startsWith('/api/')
//   ) {

//     return res.status(
//       err.status || 500
//     ).json({

//       success: false,

//       message:
//         err.message ||
//         'Internal server error',

//     });

//   }


//   // ================================================
//   // NORMAL WEBSITE ERRORS
//   // ================================================

//   res.locals.message =
//     err.message;

//   res.locals.error =
//     req.app.get('env') === 'development'
//       ? err
//       : {};

//   res.status(
//     err.status || 500
//   );

//   res.render('error');

// });


// module.exports = app;







// var createError = require('http-errors');

// var express = require('express');

// var path = require('path');

// var cookieParser = require('cookie-parser');

// var logger = require('morgan');

// var cors = require('cors');

// require('dotenv').config();


// var indexRouter =
//   require('./routes/index');

// var usersRouter =
//   require('./routes/users');


// var authRouter =
//   require('./src/routes/auth');


// var shopRoutes =
//   require('./src/routes/shopRoutes');


// var customerShopRoutes =
//   require('./src/routes/customerShopRoutes');


// var customerOrderRoutes =
//   require('./src/routes/customerOrderRoutes');


// // ==================================================
// // CUSTOMER ORDER MEDIA ROUTES
// // ==================================================

// var customerOrderMediaRoutes =
//   require('./src/routes/customerOrderMediaRoutes');


// var adminRoutes =
//   require('./src/routes/adminRoutes');


// var shopperAuthRoutes =
//   require('./src/routes/shopperAuthRoutes');


// // ==================================================
// // SHOPPER LOCATION ROUTES
// // ==================================================

// var shopperLocationRoutes =
//   require('./src/routes/shopperLocationRoutes');


// // ==================================================
// // SHOPPER ORDER ROUTES
// // ==================================================

// var shopperOrderRoutes =
//   require('./src/routes/shopperOrderRoutes');


// // ==================================================
// // CHAT ROUTES
// // ==================================================

// var chatRoutes =
//   require('./src/routes/chatRoutes');


// var db =
//   require('./src/config/db');


// var app = express();


// // ==================================================
// // DATABASE TEST
// // ==================================================

// db.query('SELECT NOW()')
//   .then(() => {

//     console.log(
//       '✅ Database test successful'
//     );

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

// app.set(
//   'view engine',
//   'jade'
// );


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
// //
// // Product / shop images:
// //
// // customer-backend/uploads/
// //
// // Shopper item photos:
// //
// // customer-backend/src/uploads/items/
// //
// // Replacement item photos:
// //
// // customer-backend/src/uploads/replacements/
// //
// // Shopper bill photos:
// //
// // customer-backend/src/uploads/bills/
// //
// // Customer order media:
// //
// // customer-backend/src/uploads/order-media/
// //
// // Therefore we serve them separately.
// //


// const rootUploadsPath =
//   path.join(
//     __dirname,
//     'uploads'
//   );


// const srcUploadsPath =
//   path.join(
//     __dirname,
//     'src',
//     'uploads'
//   );


// const rootProductsPath =
//   path.join(
//     rootUploadsPath,
//     'products'
//   );


// const rootShopsPath =
//   path.join(
//     rootUploadsPath,
//     'shops'
//   );


// const srcReplacementsPath =
//   path.join(
//     srcUploadsPath,
//     'replacements'
//   );


// const shopperItemsPath =
//   path.join(
//     srcUploadsPath,
//     'items'
//   );


// const shopperBillsPath =
//   path.join(
//     srcUploadsPath,
//     'bills'
//   );


// // ==================================================
// // CUSTOMER ORDER MEDIA PATH
// // ==================================================

// const orderMediaPath =
//   path.join(
//     srcUploadsPath,
//     'order-media'
//   );


// // ==================================================
// // UPLOAD PATH DEBUG
// // ==================================================

// console.log(
//   '=========================================='
// );

// console.log(
//   '📁 ROOT UPLOADS:',
//   rootUploadsPath
// );

// console.log(
//   '📁 ROOT PRODUCTS:',
//   rootProductsPath
// );

// console.log(
//   '📁 ROOT SHOPS:',
//   rootShopsPath
// );

// console.log(
//   '📁 SRC REPLACEMENTS:',
//   srcReplacementsPath
// );

// console.log(
//   '📁 SHOPPER ITEMS:',
//   shopperItemsPath
// );

// console.log(
//   '📁 SHOPPER BILLS:',
//   shopperBillsPath
// );

// console.log(
//   '📁 CUSTOMER ORDER MEDIA:',
//   orderMediaPath
// );

// console.log(
//   '=========================================='
// );


// // ==================================================
// // SHOPPER ITEM PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/items/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/items
// //

// app.use(
//   '/uploads/items',
//   express.static(
//     shopperItemsPath
//   )
// );


// // ==================================================
// // PRODUCT IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/products/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/products
// //

// app.use(
//   '/uploads/products',
//   express.static(
//     rootProductsPath
//   )
// );


// // ==================================================
// // SHOP IMAGES
// // ==================================================
// //
// // URL:
// //
// // /uploads/shops/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/uploads/shops
// //

// app.use(
//   '/uploads/shops',
//   express.static(
//     rootShopsPath
//   )
// );


// // ==================================================
// // REPLACEMENT ITEM PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/replacements/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/replacements
// //

// app.use(
//   '/uploads/replacements',
//   express.static(
//     srcReplacementsPath
//   )
// );


// // ==================================================
// // SHOPPER BILL PHOTOS
// // ==================================================
// //
// // URL:
// //
// // /uploads/bills/example.jpg
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/bills
// //

// app.use(
//   '/uploads/bills',
//   express.static(
//     shopperBillsPath
//   )
// );


// // ==================================================
// // CUSTOMER ORDER MEDIA
// // ==================================================
// //
// // URL:
// //
// // /uploads/order-media/example.m4a
// //
// // Actual folder:
// //
// // customer-backend/src/uploads/order-media
// //

// app.use(
//   '/uploads/order-media',
//   express.static(
//     orderMediaPath
//   )
// );


// // ==================================================
// // OTHER UPLOADS
// // ==================================================
// //
// // Keep the original uploads folder available
// // for any other existing upload types.
// //

// app.use(
//   '/uploads',
//   express.static(
//     rootUploadsPath
//   )
// );


// // ==================================================
// // ROUTES
// // ==================================================

// app.use(
//   '/',
//   indexRouter
// );

// app.use(
//   '/users',
//   usersRouter
// );


// // ==================================================
// // CUSTOMER AUTH
// // ==================================================

// app.use(
//   '/api/auth',
//   authRouter
// );


// // ==================================================
// // SHOP WEBSITE API
// // ==================================================

// app.use(
//   '/api/shop',
//   shopRoutes
// );


// // ==================================================
// // CUSTOMER SHOP API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerShopRoutes
// );


// // ==================================================
// // CUSTOMER ORDER API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderRoutes
// );


// // ==================================================
// // CUSTOMER ORDER MEDIA API
// // ==================================================

// app.use(
//   '/api/customer',
//   customerOrderMediaRoutes
// );


// // ==================================================
// // ADMIN API
// // ==================================================

// app.use(
//   '/api/admin',
//   adminRoutes
// );


// // ==================================================
// // SHOPPER AUTH
// // ==================================================

// app.use(
//   '/api/shopper/auth',
//   shopperAuthRoutes
// );


// // ==================================================
// // SHOPPER LOCATION
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperLocationRoutes
// );


// // ==================================================
// // SHOPPER ORDERS
// // ==================================================

// app.use(
//   '/api/shopper',
//   shopperOrderRoutes
// );


// // ==================================================
// // CHAT API
// // ==================================================

// app.use(
//   '/api/chat',
//   chatRoutes
// );


// // ==================================================
// // 404
// // ==================================================

// app.use(
//   function(
//     req,
//     res,
//     next
//   ) {

//     next(
//       createError(404)
//     );

//   }
// );


// // ==================================================
// // ERROR HANDLER
// // ==================================================

// app.use(
//   function(
//     err,
//     req,
//     res,
//     next
//   ) {

//     console.error(
//       '❌ SERVER ERROR:',
//       err
//     );


//     // ================================================
//     // MULTER FILE SIZE ERROR
//     // ================================================

//     if (
//       err.code ===
//       'LIMIT_FILE_SIZE'
//     ) {

//       return res
//         .status(400)
//         .json({

//           success: false,

//           message:
//             'Image size must be less than 5 MB',

//         });

//     }


//     // ================================================
//     // MULTER FILE TYPE ERROR
//     // ================================================

//     if (
//       err.message ===
//       'Only JPG, PNG and WEBP images are allowed'
//     ) {

//       return res
//         .status(400)
//         .json({

//           success: false,

//           message:
//             err.message,

//         });

//     }


//     // ================================================
//     // ALL API ERRORS
//     // ================================================

//     if (
//       req.originalUrl.startsWith(
//         '/api/'
//       )
//     ) {

//       return res
//         .status(
//           err.status || 500
//         )
//         .json({

//           success: false,

//           message:
//             err.message ||
//             'Internal server error',

//         });

//     }


//     // ================================================
//     // NORMAL WEBSITE ERRORS
//     // ================================================

//     res.locals.message =
//       err.message;


//     res.locals.error =
//       req.app.get('env') ===
//       'development'
//         ? err
//         : {};


//     res.status(
//       err.status || 500
//     );


//     res.render(
//       'error'
//     );

//   }
// );


// module.exports = app;








var createError = require('http-errors');

var express = require('express');

var path = require('path');

var cookieParser = require('cookie-parser');

var logger = require('morgan');

var cors = require('cors');

require('dotenv').config();


// ==================================================
// ROUTES
// ==================================================

var indexRouter =
  require('./routes/index');

var usersRouter =
  require('./routes/users');


var authRouter =
  require('./src/routes/auth');


var shopRoutes =
  require('./src/routes/shopRoutes');


var customerShopRoutes =
  require('./src/routes/customerShopRoutes');


var customerOrderRoutes =
  require('./src/routes/customerOrderRoutes');


// ==================================================
// CUSTOMER ORDER MEDIA ROUTES
// ==================================================

var customerOrderMediaRoutes =
  require('./src/routes/customerOrderMediaRoutes');


var adminRoutes =
  require('./src/routes/adminRoutes');


var shopperAuthRoutes =
  require('./src/routes/shopperAuthRoutes');


// ==================================================
// SHOPPER LOCATION ROUTES
// ==================================================

var shopperLocationRoutes =
  require('./src/routes/shopperLocationRoutes');


// ==================================================
// SHOPPER ORDER ROUTES
// ==================================================

var shopperOrderRoutes =
  require('./src/routes/shopperOrderRoutes');


// ==================================================
// CHAT ROUTES
// ==================================================

var chatRoutes =
  require('./src/routes/chatRoutes');


var db =
  require('./src/config/db');


// ==================================================
// APP
// ==================================================

var app = express();


// ==================================================
// DATABASE TEST
// ==================================================

db.query('SELECT NOW()')
  .then(() => {

    console.log(
      '✅ Database test successful'
    );

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

app.set(
  'view engine',
  'jade'
);


// ==================================================
// MIDDLEWARE
// ==================================================

app.use(logger('dev'));

app.use(cors());

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
//
// Product / shop images:
//
// customer-backend/uploads/
//
// Shopper item photos:
//
// customer-backend/src/uploads/items/
//
// Replacement item photos:
//
// customer-backend/src/uploads/replacements/
//
// Shopper bill photos:
//
// customer-backend/src/uploads/bills/
//
// Customer order media:
//
// customer-backend/src/uploads/order-media/
//
// Therefore we serve them separately.
//


// ==================================================
// ROOT UPLOADS
// ==================================================

const rootUploadsPath =
  path.join(
    __dirname,
    'uploads'
  );


const srcUploadsPath =
  path.join(
    __dirname,
    'src',
    'uploads'
  );


const rootProductsPath =
  path.join(
    rootUploadsPath,
    'products'
  );


const rootShopsPath =
  path.join(
    rootUploadsPath,
    'shops'
  );


const srcReplacementsPath =
  path.join(
    srcUploadsPath,
    'replacements'
  );


const shopperItemsPath =
  path.join(
    srcUploadsPath,
    'items'
  );


const shopperBillsPath =
  path.join(
    srcUploadsPath,
    'bills'
  );


// ==================================================
// CUSTOMER ORDER MEDIA PATH
// ==================================================

const orderMediaPath =
  path.join(
    srcUploadsPath,
    'order-media'
  );


// ==================================================
// UPLOAD PATH DEBUG
// ==================================================

console.log(
  '=========================================='
);

console.log(
  '📁 ROOT UPLOADS:',
  rootUploadsPath
);

console.log(
  '📁 ROOT PRODUCTS:',
  rootProductsPath
);

console.log(
  '📁 ROOT SHOPS:',
  rootShopsPath
);

console.log(
  '📁 SRC REPLACEMENTS:',
  srcReplacementsPath
);

console.log(
  '📁 SHOPPER ITEMS:',
  shopperItemsPath
);

console.log(
  '📁 SHOPPER BILLS:',
  shopperBillsPath
);

console.log(
  '📁 CUSTOMER ORDER MEDIA:',
  orderMediaPath
);

console.log(
  '=========================================='
);


// ==================================================
// SHOPPER ITEM PHOTOS
// ==================================================
//
// URL:
//
// /uploads/items/example.jpg
//
// Actual folder:
//
// customer-backend/src/uploads/items
//

app.use(
  '/uploads/items',
  express.static(
    shopperItemsPath
  )
);


// ==================================================
// PRODUCT IMAGES
// ==================================================
//
// URL:
//
// /uploads/products/example.jpg
//
// Actual folder:
//
// customer-backend/uploads/products
//

app.use(
  '/uploads/products',
  express.static(
    rootProductsPath
  )
);


// ==================================================
// SHOP IMAGES
// ==================================================
//
// URL:
//
// /uploads/shops/example.jpg
//
// Actual folder:
//
// customer-backend/uploads/shops
//

app.use(
  '/uploads/shops',
  express.static(
    rootShopsPath
  )
);


// ==================================================
// REPLACEMENT ITEM PHOTOS
// ==================================================
//
// URL:
//
// /uploads/replacements/example.jpg
//
// Actual folder:
//
// customer-backend/src/uploads/replacements
//

app.use(
  '/uploads/replacements',
  express.static(
    srcReplacementsPath
  )
);


// ==================================================
// SHOPPER BILL PHOTOS
// ==================================================
//
// URL:
//
// /uploads/bills/example.jpg
//
// Actual folder:
//
// customer-backend/src/uploads/bills
//

app.use(
  '/uploads/bills',
  express.static(
    shopperBillsPath
  )
);


// ==================================================
// CUSTOMER ORDER MEDIA
// ==================================================
//
// URL:
//
// /uploads/order-media/example.m4a
//
// Actual folder:
//
// customer-backend/src/uploads/order-media
//

app.use(
  '/uploads/order-media',
  express.static(
    orderMediaPath
  )
);


// ==================================================
// OTHER UPLOADS
// ==================================================
//
// Keep the original uploads folder available
// for any other existing upload types.
//

app.use(
  '/uploads',
  express.static(
    rootUploadsPath
  )
);


// ==================================================
// ROUTES
// ==================================================

app.use(
  '/',
  indexRouter
);

app.use(
  '/users',
  usersRouter
);


// ==================================================
// CUSTOMER AUTH
// ==================================================

app.use(
  '/api/auth',
  authRouter
);


// ==================================================
// SHOP WEBSITE API
// ==================================================

app.use(
  '/api/shop',
  shopRoutes
);


// ==================================================
// CUSTOMER SHOP API
// ==================================================

app.use(
  '/api/customer',
  customerShopRoutes
);


// ==================================================
// CUSTOMER ORDER API
// ==================================================

app.use(
  '/api/customer',
  customerOrderRoutes
);


// ==================================================
// CUSTOMER ORDER MEDIA API
// ==================================================

app.use(
  '/api/customer',
  customerOrderMediaRoutes
);


// ==================================================
// ADMIN API
// ==================================================

app.use(
  '/api/admin',
  adminRoutes
);


// ==================================================
// SHOPPER AUTH
// ==================================================

app.use(
  '/api/shopper/auth',
  shopperAuthRoutes
);


// ==================================================
// SHOPPER LOCATION
// ==================================================

app.use(
  '/api/shopper',
  shopperLocationRoutes
);


// ==================================================
// SHOPPER ORDERS
// ==================================================

app.use(
  '/api/shopper',
  shopperOrderRoutes
);


// ==================================================
// CHAT API
// ==================================================

app.use(
  '/api/chat',
  chatRoutes
);


// ==================================================
// 404
// ==================================================

app.use(
  function(
    req,
    res,
    next
  ) {

    next(
      createError(404)
    );

  }
);


// ==================================================
// ERROR HANDLER
// ==================================================

app.use(
  function(
    err,
    req,
    res,
    next
  ) {

    console.error(
      '❌ SERVER ERROR:',
      err
    );


    // ================================================
    // MULTER FILE SIZE ERROR
    // ================================================

    if (
      err.code ===
      'LIMIT_FILE_SIZE'
    ) {

      return res
        .status(400)
        .json({

          success: false,

          message:
            'Image size must be less than 5 MB',

        });

    }


    // ================================================
    // MULTER FILE TYPE ERROR
    // ================================================

    if (
      err.message ===
      'Only JPG, PNG and WEBP images are allowed'
    ) {

      return res
        .status(400)
        .json({

          success: false,

          message:
            err.message,

        });

    }


    // ================================================
    // ALL API ERRORS
    // ================================================

    if (
      req.originalUrl.startsWith(
        '/api/'
      )
    ) {

      return res
        .status(
          err.status || 500
        )
        .json({

          success: false,

          message:
            err.message ||
            'Internal server error',

        });

    }


    // ================================================
    // NORMAL WEBSITE ERRORS
    // ================================================

    res.locals.message =
      err.message;


    res.locals.error =
      req.app.get('env') ===
      'development'
        ? err
        : {};


    res.status(
      err.status || 500
    );


    res.render(
      'error'
    );

  }
);


// ==================================================
// EXPORT
// ==================================================

module.exports = app;