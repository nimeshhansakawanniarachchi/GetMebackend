
const express = require('express');

const {
  getCustomerShops,
  getCustomerShopProducts,
  placeAutocomplete,
  placeDetails,
} = require('../controllers/customerShopController');

const router = express.Router();


// ==================================================
// GET ALL APPROVED SHOPS
// ==================================================

router.get(
  '/shops',
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
// GOOGLE PLACES AUTOCOMPLETE
// ==================================================

router.post(
  '/place-autocomplete',
  placeAutocomplete
);


// ==================================================
// GOOGLE PLACE DETAILS
// ==================================================

router.get(
  '/place-details/:placeId',
  placeDetails
);


module.exports = router;