const express = require('express');

const {
  getDashboard,
  getOrders,
  getOrderById,
  getCustomers,
  getShops,
  getProducts,
} = require('../controllers/adminController');

const router = express.Router();

router.get(
  '/dashboard',
  getDashboard
);

router.get(
  '/orders',
  getOrders
);

router.get(
  '/orders/:orderId',
  getOrderById
);

router.get(
  '/customers',
  getCustomers
);

router.get(
  '/shops',
  getShops
);

router.get(
  '/products',
  getProducts
);

module.exports = router;