const jwt = require('jsonwebtoken');

// ==================================================
// SHOPPER JWT AUTH MIDDLEWARE
// ==================================================

const { isSessionCurrent, SESSION_ENDED } = require('../utils/shopperSession');

const shopperAuthMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // ==================================================
    // CHECK AUTHORIZATION HEADER
    // ==================================================

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Shopper authorization token is required',
      });
    }

    // ==================================================
    // CHECK BEARER FORMAT
    // ==================================================

    const parts = authHeader.split(' ');

    if (
      parts.length !== 2 ||
      parts[0] !== 'Bearer'
    ) {
      return res.status(401).json({
        success: false,
        message: 'Invalid shopper authorization format',
      });
    }

    const token = parts[1];

    // ==================================================
    // VERIFY JWT
    // ==================================================

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    // A token from before a phone change / recovery is no longer valid
    if (decoded?.shopperId != null && !(await isSessionCurrent(decoded))) {
      return res.status(401).json(SESSION_ENDED);
    }

    // ==================================================
    // SAVE SHOPPER DATA
    // ==================================================

    req.shopper = decoded;

    next();

  } catch (error) {
    console.error(
      '❌ SHOPPER JWT ERROR:',
      error.message
    );

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired shopper token',
    });
  }
};

module.exports = shopperAuthMiddleware;