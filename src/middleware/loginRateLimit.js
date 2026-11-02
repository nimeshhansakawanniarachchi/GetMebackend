const rateLimit = require('express-rate-limit');

// =====================================================
// LOGIN RATE LIMIT
// 10 attempts per 15 minutes per IP + account identifier,
// so one person can't brute-force passwords.
// =====================================================

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    // Customers sign in with loginValue (email or mobile); without it
    // every customer behind one mobile-carrier IP shared one counter
    const account = String(
      req.body?.loginValue || req.body?.email || req.body?.mobile || ''
    )
      .trim()
      .toLowerCase();

    return `${req.ip}|${account}`;
  },
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      message: 'Too many login attempts. Please wait 15 minutes and try again.',
    }),
});

module.exports = loginRateLimit;
