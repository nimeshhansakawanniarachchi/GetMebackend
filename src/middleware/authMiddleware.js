const jwt = require('jsonwebtoken');

const pool = require('../config/db');
const { blockedBody } = require('../customers/accountControls');
const { touch } = require('../customerActivity/store');

// ==================================================
// JWT AUTH MIDDLEWARE
// Phase 44: one primary-key lookup per request checks the account
// status. A blocked customer gets 403 ACCOUNT_BLOCKED on every customer
// API (orders already in progress keep running for shoppers / admins).
// req.customerAccount = { status, codLimit } for the controllers.
// ==================================================

const authMiddleware = async (req, res, next) => {
  let decoded;

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

    decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );
  } catch (error) {
    console.error('❌ JWT ERROR:', error.message);

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }

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
  // ACCOUNT STATUS (phase 44)
  // ==================================================

  try {
    // Security review B-11: a token whose sign-in session ended (logout,
    // block) is refused. Tokens from before sessions existed have no sid.
    const sid = Number.isSafeInteger(Number(decoded.sid)) ? Number(decoded.sid) : null;
    const account = (
      await pool.query(
        `SELECT c.account_status, c.cod_limit, s.ended_at AS session_ended_at
           FROM customers c
           LEFT JOIN customer_sessions s ON s.id = $2 AND s.customer_id = c.id
          WHERE c.id = $1`,
        [Number(decoded.customerId), sid]
      )
    ).rows[0];

    if (account && sid && account.session_ended_at) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_ENDED',
        message: 'You were signed out. Please sign in again.',
      });
    }

    if (account?.account_status === 'blocked') {
      return res.status(403).json(blockedBody());
    }

    req.customerAccount = account
      ? { status: account.account_status, codLimit: account.cod_limit != null ? Number(account.cod_limit) : null }
      : null;
  } catch (error) {
    console.error('❌ CUSTOMER STATUS CHECK ERROR:', error.message);

    return res.status(503).json({
      success: false,
      message: 'Unable to check your account right now. Please try again.',
    });
  }

  // ==================================================
  // SAVE CUSTOMER DATA
  // ==================================================

  req.customer = decoded;

  // Phase 51: last activity (at most one write per customer per minute)
  touch(decoded.customerId, decoded.sid);

  return next();
};

module.exports = authMiddleware;
