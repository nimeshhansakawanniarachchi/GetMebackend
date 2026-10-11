
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('../config/db');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

// ==================================================
// CUSTOMER REGISTER
// ==================================================

router.post('/register', async (req, res) => {
  console.log('====================================');
  console.log('REGISTER REQUEST RECEIVED');
  console.log('BODY:', {
    ...req.body,
    password: req.body?.password ? '******' : undefined,
  });
  console.log('CONTENT TYPE:', req.headers['content-type']);
  console.log('====================================');

  try {
    const fullName = req.body?.fullName;
    const mobile = req.body?.mobile;
    const email = req.body?.email;
    const password = req.body?.password;

    // ==================================================
    // VALIDATION
    // ==================================================

    if (!fullName || !mobile || !email || !password) {
      console.log('❌ Missing required field');

      return res.status(400).json({
        success: false,
        message: 'All fields are required',
        received: {
          fullName: !!fullName,
          mobile: !!mobile,
          email: !!email,
          password: !!password,
        },
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
       WHERE email = $1 OR mobile = $2`,
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
    console.error('❌ REGISTER ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message,
    });
  }
});

// ==================================================
// CUSTOMER LOGIN
// ==================================================

router.post('/login', async (req, res) => {
  console.log('====================================');
  console.log('LOGIN REQUEST RECEIVED');
  console.log('BODY:', {
    ...req.body,
    password: req.body?.password ? '******' : undefined,
  });
  console.log('====================================');

  try {
    const loginValue = req.body?.loginValue;
    const password = req.body?.password;

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
        created_at
       FROM customers
       WHERE email = $1 OR mobile = $1
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