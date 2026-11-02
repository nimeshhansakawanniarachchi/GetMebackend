
const express = require('express');
const loginRateLimit = require('../middleware/loginRateLimit');

const {
  normalizeSriLankanMobile,
  isEmail,
} = require('../utils/phone');

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');
const { blockedBody } = require('../customers/accountControls');
// Phase 51: sign-in sessions + customer activity timeline
const activity = require('../customerActivity/store');
const presence = require('../customerActivity/presence');

const router = express.Router();

// ==================================================
// CUSTOMER REGISTER
// ==================================================

router.post('/register', loginRateLimit, async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const rawMobile = req.body?.mobile;
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password;

    // Stored as +94XXXXXXXXX so 077..., 77... and +9477... are one account
    const mobile = normalizeSriLankanMobile(rawMobile);

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!fullName || !rawMobile || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required',
      });
    }

    if (!mobile) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid Sri Lankan mobile number (e.g. 077 123 4567)',
      });
    }

    if (!isEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid email address',
      });
    }

    if (password.length < 6) {
      console.log('❌ Password too short');

      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
      });
    }

    // ==================================================
    // CHECK EXISTING CUSTOMER
    // ==================================================

    const existingCustomer = await db.query(
      `SELECT id
       FROM customers
       WHERE LOWER(email) = $1 OR mobile = $2`,
      [email, mobile]
    );

    if (existingCustomer.rows.length > 0) {
      console.log('❌ Customer already exists');

      return res.status(409).json({
        success: false,
        message: 'Email or mobile number already registered',
      });
    }

    // ==================================================
    // HASH PASSWORD
    // ==================================================

    const passwordHash = await bcrypt.hash(password, 10);

    // ==================================================
    // INSERT CUSTOMER
    // ==================================================

    const result = await db.query(
      `INSERT INTO customers
       (full_name, mobile, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, mobile, email, created_at`,
      [
        fullName,
        mobile,
        email,
        passwordHash,
      ]
    );

    const customer = result.rows[0];

    console.log('✅ CUSTOMER CREATED:', customer.id);

    // Phase 51: the token names its sign-in session (sid)
    const sessionId = await activity.createSession({
      customerId: customer.id,
      method: 'register',
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    // ==================================================
    // CREATE JWT TOKEN
    // ==================================================

    const token = jwt.sign(
      {
        customerId: customer.id,
        email: customer.email,
        ...(sessionId ? { sid: sessionId } : {}),
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d',
      }
    );

    // ==================================================
    // SUCCESS RESPONSE
    // ==================================================

    return res.status(201).json({
      success: true,
      message: 'Customer registered successfully',
      token,
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        mobile: customer.mobile,
        email: customer.email,
        createdAt: customer.created_at,
      },
    });

  } catch (error) {
    // Two sign-ups racing past the duplicate check
    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        message: 'Email or mobile number already registered',
      });
    }

    console.error('❌ REGISTER ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

// ==================================================
// CUSTOMER LOGIN
// ==================================================

router.post('/login', loginRateLimit, async (req, res) => {
  try {
    const rawLogin = String(req.body?.loginValue || '').trim();
    const password = req.body?.password;

    // Email (any case) or a Sri Lankan mobile in any format
    const loginValue = isEmail(rawLogin)
      ? rawLogin.toLowerCase()
      : normalizeSriLankanMobile(rawLogin) || rawLogin;

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!loginValue || !password) {
      console.log('❌ Missing login fields');

      return res.status(400).json({
        success: false,
        message: 'Email/mobile and password are required',
      });
    }

    // ==================================================
    // FIND CUSTOMER
    // ==================================================

    const result = await db.query(
      `SELECT
        id,
        full_name,
        mobile,
        email,
        password_hash,
        created_at,
        account_status
       FROM customers
       WHERE LOWER(email) = $1 OR mobile = $1
       LIMIT 1`,
      [loginValue]
    );

    if (result.rows.length === 0) {
      console.log('❌ Customer not found');

      return res.status(401).json({
        success: false,
        message: 'Invalid email/mobile or password',
      });
    }

    const customer = result.rows[0];

    // ==================================================
    // CHECK PASSWORD
    // ==================================================

    const passwordMatch = await bcrypt.compare(
      password,
      customer.password_hash
    );

    if (!passwordMatch) {
      console.log('❌ Incorrect password');

      activity.noteFailedLogin(customer.id);

      return res.status(401).json({
        success: false,
        message: 'Invalid email/mobile or password',
      });
    }

    // ==================================================
    // BLOCKED ACCOUNT (phase 44): no new session
    // ==================================================

    if (customer.account_status === 'blocked') {
      console.log('❌ Login refused: account blocked', customer.id);

      return res.status(403).json(blockedBody());
    }

    // ==================================================
    // CREATE JWT TOKEN (phase 51: with its sign-in session)
    // ==================================================

    const sessionId = await activity.createSession({
      customerId: customer.id,
      method: isEmail(rawLogin) ? 'email' : 'mobile',
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    const token = jwt.sign(
      {
        customerId: customer.id,
        email: customer.email,
        ...(sessionId ? { sid: sessionId } : {}),
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d',
      }
    );

    console.log('✅ LOGIN SUCCESS:', customer.id);

    // ==================================================
    // SUCCESS RESPONSE
    // ==================================================

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        mobile: customer.mobile,
        email: customer.email,
        createdAt: customer.created_at,
      },
    });

  } catch (error) {
    console.error('❌ LOGIN ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
});

// ==================================================
// CUSTOMER LOGOUT (phase 51)
// Ends this sign-in session and the app's open online period. Works
// with an expired or blocked account's token too (the token is still
// verified). Body: { installId? } - the app install signing out.
// Idempotent: a second call changes nothing.
// ==================================================

router.post('/logout', async (req, res) => {
  const parts = String(req.headers.authorization || '').split(' ');
  let decoded;

  try {
    if (parts.length !== 2 || parts[0] !== 'Bearer') throw new Error('missing');
    decoded = jwt.verify(parts[1], process.env.JWT_SECRET, { ignoreExpiration: true });
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  const customerId = Number(decoded?.customerId);
  if (!Number.isSafeInteger(customerId) || customerId <= 0) {
    return res.status(401).json({ success: false, message: 'Invalid customer token' });
  }

  const sessionId = Number.isSafeInteger(Number(decoded.sid)) ? Number(decoded.sid) : null;
  const installId = typeof req.body?.installId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(req.body.installId)
    ? req.body.installId
    : null;

  try {
    const ended = await activity.endSession({ customerId, sessionId, reason: 'logout' });

    // Security review B-11: this sign-in's open sockets close now
    const io = req.app.get('io');
    if (io && sessionId) {
      io.in(`customer:${customerId}`).fetchSockets()
        .then((sockets) => sockets.forEach((s) => {
          if (Number(s.data?.sid) === sessionId) s.disconnect(true);
        }))
        .catch(() => {});
    }
    await presence.endForSession({ customerId, sessionId, installId, reason: 'logout' });

    // Tokens from before phase 51 have no session: the event is still useful
    if (ended || !sessionId) {
      await db.query(
        `INSERT INTO customer_activity_state (customer_id, last_logout_at) VALUES ($1, NOW())
         ON CONFLICT (customer_id) DO UPDATE SET last_logout_at = NOW(), updated_at = NOW()`,
        [customerId]
      );
      await activity.logEvent({
        customerId,
        category: 'session',
        type: 'session.logout',
        summary: 'Signed out',
        sessionId,
        dedupeKey: sessionId ? `session.logout:${sessionId}` : null,
      });
    }

    return res.json({ success: true, ended: Boolean(ended) });
  } catch (error) {
    console.error('❌ LOGOUT ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================================================
// GET CURRENT CUSTOMER
// ==================================================

router.get('/me', authMiddleware, async (req, res) => {
  console.log('====================================');
  console.log('GET CURRENT CUSTOMER');
  console.log('CUSTOMER ID:', req.customer.customerId);
  console.log('====================================');

  try {

    // ==================================================
    // FIND CUSTOMER USING JWT CUSTOMER ID
    // ==================================================

    const result = await db.query(
      `SELECT
        id,
        full_name,
        mobile,
        email,
        created_at
       FROM customers
       WHERE id = $1
       LIMIT 1`,
      [req.customer.customerId]
    );

    // ==================================================
    // CUSTOMER NOT FOUND
    // ==================================================

    if (result.rows.length === 0) {
      console.log('❌ Customer not found');

      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    const customer = result.rows[0];

    console.log('✅ CUSTOMER FOUND:', customer.id);

    // ==================================================
    // SUCCESS RESPONSE
    // ==================================================

    return res.status(200).json({
      success: true,
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        mobile: customer.mobile,
        email: customer.email,
        createdAt: customer.created_at,
      },
    });

  } catch (error) {
    console.error('❌ ME ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
});

// ==================================================
// EXPORT ROUTER
// ==================================================

module.exports = router;