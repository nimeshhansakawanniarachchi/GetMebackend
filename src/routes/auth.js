
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

    // ==================================================
    // CREATE JWT TOKEN
    // ==================================================

    const token = jwt.sign(
      {
        customerId: customer.id,
        email: customer.email,
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
    // CREATE JWT TOKEN
    // ==================================================

    const token = jwt.sign(
      {
        customerId: customer.id,
        email: customer.email,
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