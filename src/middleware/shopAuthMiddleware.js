const jwt = require('jsonwebtoken');

const db = require('../config/db');

// =====================================================
// SHOP AUTH
// Token must be a shop token, and the shop must not be
// rejected or suspended. Pending shops may set up their store
// (they stay hidden from customers until approved).
// =====================================================

const shopAuthMiddleware = async (
  req,
  res,
  next
) => {
  let decoded;

  try {
    const authHeader =
      req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message:
          'Authorization token is required',
      });
    }

    const parts =
      authHeader.split(' ');

    if (
      parts.length !== 2 ||
      parts[0] !== 'Bearer'
    ) {
      return res.status(401).json({
        success: false,
        message:
          'Invalid authorization format',
      });
    }

    decoded = jwt.verify(
      parts[1],
      process.env.JWT_SECRET
    );
  } catch (error) {
    console.error(
      '❌ SHOP JWT ERROR:',
      error.message
    );

    return res.status(401).json({
      success: false,
      message:
        'Invalid or expired token',
    });
  }

  if (!decoded?.shopId) {
    return res.status(401).json({
      success: false,
      message: 'Invalid shop token',
    });
  }

  try {
    const result = await db.query(
      'SELECT status FROM shops WHERE id = $1',
      [decoded.shopId]
    );

    const status = result.rows[0]?.status;

    if (!status) {
      return res.status(401).json({
        success: false,
        message: 'Shop account not found',
      });
    }

    if (status === 'rejected' || status === 'suspended') {
      return res.status(403).json({
        success: false,
        shopStatus: status,
        message:
          status === 'rejected'
            ? 'Your shop application was not approved.'
            : 'Your shop is suspended. Please contact GetMe support.',
      });
    }

    req.shop = decoded;
    req.shopStatus = status;

    next();
  } catch (error) {
    console.error('❌ SHOP AUTH ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
    });
  }
};

module.exports =
  shopAuthMiddleware;
