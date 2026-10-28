const rateLimit = require('express-rate-limit');

// =====================================================
// ACCOUNT CHANGE RATE LIMIT (phase 35)
// Phone change / codes / lost-phone recovery: 10 failed attempts per
// 15 minutes per account (the signed-in shopper, or the registered /
// new number on signed-out recovery) and IP. Keyed by the account so
// people behind one mobile-network IP don't share one allowance (the
// login limiter keys on email / mobile, which these requests don't
// send).
// =====================================================

const accountChangeRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const account = req.shopper?.shopperId
      ? `shopper:${req.shopper.shopperId}`
      : `number:${String(req.body?.registeredMobile || req.body?.newMobile || req.params?.id || '').replace(/\D/g, '')}`;

    return `${req.ip}|${account}`;
  },
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many attempts. Please wait 15 minutes and try again.',
    }),
});

module.exports = accountChangeRateLimit;
