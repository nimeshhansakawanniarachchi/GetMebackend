
const express = require('express');

const router = express.Router();

// Payment routes will be added here.
// Payment verification must happen on the backend
// before an order is released for shopping.

router.get('/health', (req, res) => {
  return res.status(200).json({
    success: true,
    message: 'GetMe payment routes are working',
  });
});

module.exports = router;
