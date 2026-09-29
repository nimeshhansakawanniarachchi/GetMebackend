const jwt = require('jsonwebtoken');

const shopAuthMiddleware = (
  req,
  res,
  next
) => {
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

    const token = parts[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.shop = decoded;

    next();

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
};

module.exports =
  shopAuthMiddleware;