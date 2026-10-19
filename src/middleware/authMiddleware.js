const jwt = require('jsonwebtoken');

// ==================================================
// JWT AUTH MIDDLEWARE
// ==================================================

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // ==================================================
    // CHECK AUTHORIZATION HEADER
    // ==================================================

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authorization token is required',
      });
    }

    // ==================================================
    // CHECK BEARER FORMAT
    // ==================================================

    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({
        success: false,
        message: 'Invalid authorization format',
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

    // ==================================================
    // MUST BE A CUSTOMER TOKEN
    // ==================================================

    if (!decoded?.customerId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid customer token',
      });
    }

    // ==================================================
    // SAVE CUSTOMER DATA
    // ==================================================

    req.customer = decoded;

    next();

  } catch (error) {
    console.error('❌ JWT ERROR:', error.message);

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }
};

module.exports = authMiddleware;