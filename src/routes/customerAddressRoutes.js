const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');

const {
  getAddresses,
  createAddress,
  updateAddress,
  useAddress,
  deleteAddress,
  autocompletePlaces,
  getPlaceDetails,
} = require('../controllers/customerAddressController');

const router = express.Router();


// ==================================================
// SAVED ADDRESSES
// ==================================================

router.get('/addresses', authMiddleware, getAddresses);

router.post('/addresses', authMiddleware, createAddress);

router.put('/addresses/:addressId', authMiddleware, updateAddress);

router.post('/addresses/:addressId/use', authMiddleware, useAddress);

router.delete('/addresses/:addressId', authMiddleware, deleteAddress);


// ==================================================
// ADDRESS SEARCH (GOOGLE PLACES PROXY)
// ==================================================

router.get('/places/autocomplete', authMiddleware, autocompletePlaces);

router.get('/places/:placeId', authMiddleware, getPlaceDetails);

module.exports = router;
