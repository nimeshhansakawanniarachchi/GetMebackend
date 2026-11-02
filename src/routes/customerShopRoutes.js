
const express = require('express');

const {
  getCustomerShops,
  getCustomerShopProducts,
  getOftenBoughtWith,
} = require('../controllers/customerShopController');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Public shop list (it costs Google Routes calls on a cache miss):
// 60 requests a minute per IP is far above what the app needs
const shopsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).json({ success: false, message: 'Too many requests. Please try again in a minute.' }),
});


// ==================================================
// GET ALL APPROVED SHOPS
// ==================================================

router.get(
  '/shops',
  shopsRateLimit,
  getCustomerShops
);


// ==================================================
// GET PRODUCTS OF ONE SHOP
// ==================================================

router.get(
  '/shops/:shopId/products',
  getCustomerShopProducts
);


// ==================================================
// PRODUCTS OFTEN BOUGHT WITH ONE PRODUCT
// ==================================================

router.get(
  '/shops/:shopId/products/:productId/often-bought-with',
  getOftenBoughtWith
);


// Phase 52: the unauthenticated /place-autocomplete and
// /place-details/:placeId routes were removed (no app used them; they
// spent the Google key for anyone). The apps use the signed-in
// /api/customer/places/* routes in customerAddressRoutes.js.


module.exports = router;