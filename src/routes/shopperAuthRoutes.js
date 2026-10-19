
const express = require('express');
const loginRateLimit = require('../middleware/loginRateLimit');


const bcrypt = require('bcryptjs');

const jwt = require('jsonwebtoken');

const db = require('../config/db');

const { emitToAdmins } = require('../realtime');

const { normalizeSriLankanMobile } = require('../utils/phone');

const router = express.Router();


// ==================================================
// SHOPPER REGISTER
// ==================================================

router.post('/register', loginRateLimit, async (req, res) => {
  try {

    const {
      fullName,
      mobile,
      email,
      password,
      confirmPassword,
    } = req.body;


    // ================================================
    // VALIDATION
    // ================================================

    if (
      !fullName ||
      !mobile ||
      !email ||
      !password ||
      !confirmPassword
    ) {

      return res.status(400).json({
        success: false,
        message: 'All fields are required',
      });

    }


    if (password !== confirmPassword) {

      return res.status(400).json({
        success: false,
        message: 'Passwords do not match',
      });

    }


    if (password.length < 6) {

      return res.status(400).json({
        success: false,
        message:
          'Password must be at least 6 characters',
      });

    }


    const cleanName = fullName.trim();

    // Stored as +94XXXXXXXXX
    const cleanMobile = normalizeSriLankanMobile(mobile);

    const cleanEmail = email.trim().toLowerCase();

    if (!cleanMobile) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid Sri Lankan mobile number (e.g. 077 123 4567)',
      });
    }


    // ================================================
    // CHECK EXISTING SHOPPER
    // ================================================

    const existingShopper = await db.query(
      `
      SELECT id
      FROM shoppers
      WHERE LOWER(email) = $1
         OR mobile = $2
      LIMIT 1
      `,
      [
        cleanEmail,
        cleanMobile,
      ]
    );


    if (existingShopper.rows.length > 0) {

      return res.status(409).json({
        success: false,
        message:
          'Email or mobile number is already registered',
      });

    }


    // ================================================
    // HASH PASSWORD
    // ================================================

    const passwordHash = await bcrypt.hash(
      password,
      10
    );


    // ================================================
    // CREATE SHOPPER
    // ================================================

    const result = await db.query(
      `
      INSERT INTO shoppers
      (
        full_name,
        mobile,
        email,
        password_hash,
        status,
        approval_status
      )
      VALUES
      ($1, $2, $3, $4, 'offline', 'pending')
      RETURNING
        id,
        full_name,
        mobile,
        email,
        status,
        approval_status,
        created_at
      `,
      [
        cleanName,
        cleanMobile,
        cleanEmail,
        passwordHash,
      ]
    );


    const shopper = result.rows[0];


    console.log(
      '===================================='
    );

    console.log(
      '✅ SHOPPER REGISTERED'
    );

    console.log(
      'SHOPPER ID:',
      shopper.id
    );

    console.log(
      'NAME:',
      shopper.full_name
    );

    console.log(
      'STATUS:',
      shopper.status
    );

    console.log(
      '===================================='
    );


    // ================================================
    // SOCKET.IO - SHOPPER CREATED
    // ================================================

    // Only admins hear about new shoppers (no PII broadcast)
    emitToAdmins(req.app.get('io'), 'admin:shoppers-updated', {
      shopperId: shopper.id,
      reason: 'registered',
    });


    // ================================================
    // RESPONSE
    // ================================================

    return res.status(201).json({

      success: true,

      message:
        'Shopper registration successful',

      shopper: {

        id:
          shopper.id,

        fullName:
          shopper.full_name,

        mobile:
          shopper.mobile,

        email:
          shopper.email,

        status:
          shopper.status,

        approvalStatus:
          shopper.approval_status,

        createdAt:
          shopper.created_at,

      },

    });

  } catch (error) {

    console.error(
      '❌ Shopper register error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Shopper registration failed',

    });

  }
});


// ==================================================
// SHOPPER LOGIN
// ==================================================

router.post('/login', loginRateLimit, async (req, res) => {
  try {

    const {
      email,
      mobile,
      password,
    } = req.body;


    // ================================================
    // VALIDATION
    // ================================================

    if (!password) {

      return res.status(400).json({
        success: false,
        message: 'Password is required',
      });

    }


    if (!email && !mobile) {

      return res.status(400).json({
        success: false,
        message:
          'Email or mobile number is required',
      });

    }


    let result;


    // ================================================
    // LOGIN WITH EMAIL
    // ================================================

    if (email) {

      const cleanEmail =
        email.trim().toLowerCase();


      result = await db.query(
        `
        SELECT
          id,
          full_name,
          mobile,
          email,
          password_hash,
          status,
          approval_status,
          latitude,
          longitude,
          created_at
        FROM shoppers
        WHERE LOWER(email) = $1
        LIMIT 1
        `,
        [
          cleanEmail,
        ]
      );

    }


    // ================================================
    // LOGIN WITH MOBILE
    // ================================================

    else {

      const cleanMobile =
        normalizeSriLankanMobile(mobile) ||
        String(mobile).trim();


      result = await db.query(
        `
        SELECT
          id,
          full_name,
          mobile,
          email,
          password_hash,
          status,
          approval_status,
          latitude,
          longitude,
          created_at
        FROM shoppers
        WHERE mobile = $1
        LIMIT 1
        `,
        [
          cleanMobile,
        ]
      );

    }


    // ================================================
    // SHOPPER NOT FOUND
    // ================================================

    if (result.rows.length === 0) {

      return res.status(401).json({

        success: false,

        message:
          'Invalid email/mobile or password',

      });

    }


    const shopper =
      result.rows[0];


    // ================================================
    // CHECK PASSWORD
    // ================================================

    const passwordMatch =
      await bcrypt.compare(
        password,
        shopper.password_hash
      );


    if (!passwordMatch) {

      return res.status(401).json({

        success: false,

        message:
          'Invalid email/mobile or password',

      });

    }


    // ================================================
    // REJECTED / SUSPENDED SHOPPER
    // Pending shoppers may log in but can't go online
    // ================================================

    if (
      shopper.approval_status === 'rejected' ||
      shopper.approval_status === 'suspended'
    ) {

      return res.status(403).json({

        success: false,

        message:
          shopper.approval_status === 'rejected'
            ? 'Your shopper account has been rejected'
            : 'Your shopper account is suspended. Please contact GetMe support.',

      });

    }


    // ================================================
    // CREATE JWT
    // ================================================

    const token =
      jwt.sign(

        {
          shopperId:
            shopper.id,

          email:
            shopper.email,

        },

        process.env.JWT_SECRET,

        {
          expiresIn:
            '7d',
        }

      );


    console.log(
      '===================================='
    );

    console.log(
      '✅ SHOPPER LOGIN'
    );

    console.log(
      'SHOPPER ID:',
      shopper.id
    );

    console.log(
      'EMAIL:',
      shopper.email
    );

    console.log(
      'STATUS:',
      shopper.status
    );

    console.log(
      '===================================='
    );


    // ================================================
    // RESPONSE
    // ================================================

    return res.json({

      success: true,

      message:
        'Login successful',

      token,

      shopper: {

        id:
          shopper.id,

        fullName:
          shopper.full_name,

        mobile:
          shopper.mobile,

        email:
          shopper.email,

        status:
          shopper.status,

        approvalStatus:
          shopper.approval_status,

        latitude:
          shopper.latitude,

        longitude:
          shopper.longitude,

        createdAt:
          shopper.created_at,

      },

    });

  } catch (error) {

    console.error(
      '❌ Shopper login error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Shopper login failed',

    });

  }
});


// ==================================================
// Shopper approval/status changes and the admin shopper list
// moved to the admin API (requireAdmin): /api/admin/shoppers
// ==================================================

// ==================================================
// EXPORT
// ==================================================

module.exports = router;
