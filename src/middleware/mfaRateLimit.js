const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

// =====================================================
// TWO-STEP SIGN-IN RATE LIMIT (security review B-13)
// 20 failed tries per 15 minutes per IP + staff account. Keyed on the
// account (the challenge token's admin, or the signed-in admin for a
// re-check) so staff behind one office IP don't lock each other out;
// each account also locks code entry after 5 wrong codes (src/admin/mfa.js).
// The token is only decoded here to pick the bucket; the handler
// verifies it.
// =====================================================

const accountOf = (req) => {
  try {
    const challenge = jwt.decode(String(req.body?.challengeToken || ''));
    if (challenge?.mfaAdminId) return `c${Number(challenge.mfaAdminId)}`;
  } catch {
    // not a token: shares the IP bucket
  }
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme === 'Bearer' && token) {
    const session = jwt.decode(token);
    if (session?.adminId) return `a${Number(session.adminId)}`;
  }
  return '';
};

const mfaRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}|${accountOf(req)}`,
  handler: (req, res) =>
    res.status(429).json({
      success: false,
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many tries. Please wait 15 minutes and try again.',
    }),
});

module.exports = mfaRateLimit;
