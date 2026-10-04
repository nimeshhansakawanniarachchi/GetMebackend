// const express = require('express');
// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');

// const db = require('../config/db');

// const router = express.Router();


// // ==================================================
// // SHOPPER REGISTER
// // ==================================================

// router.post('/register', async (req, res) => {
//   try {

//     const {
//       fullName,
//       mobile,
//       email,
//       password,
//       confirmPassword,
//     } = req.body;


//     // ================================================
//     // VALIDATION
//     // ================================================

//     if (
//       !fullName ||
//       !mobile ||
//       !email ||
//       !password ||
//       !confirmPassword
//     ) {
//       return res.status(400).json({
//         success: false,
//         message: 'All fields are required',
//       });
//     }


//     if (password !== confirmPassword) {
//       return res.status(400).json({
//         success: false,
//         message: 'Passwords do not match',
//       });
//     }


//     if (password.length < 6) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Password must be at least 6 characters',
//       });
//     }


//     const cleanName =
//       fullName.trim();

//     const cleanMobile =
//       mobile.trim();

//     const cleanEmail =
//       email.trim().toLowerCase();


//     // ================================================
//     // CHECK EXISTING SHOPPER
//     // ================================================

//     const existingShopper =
//       await db.query(
//         `
//         SELECT id
//         FROM shoppers
//         WHERE LOWER(email) = $1
//            OR mobile = $2
//         LIMIT 1
//         `,
//         [
//           cleanEmail,
//           cleanMobile,
//         ]
//       );


//     if (existingShopper.rows.length > 0) {

//       return res.status(409).json({
//         success: false,
//         message:
//           'Email or mobile number is already registered',
//       });

//     }


//     // ================================================
//     // HASH PASSWORD
//     // ================================================

//     const passwordHash =
//       await bcrypt.hash(
//         password,
//         10
//       );


//     // ================================================
//     // CREATE SHOPPER
//     // ================================================

//     const result =
//       await db.query(
//         `
//         INSERT INTO shoppers
//         (
//           full_name,
//           mobile,
//           email,
//           password_hash,
//           status
//         )
//         VALUES
//         ($1, $2, $3, $4, 'pending')
//         RETURNING
//           id,
//           full_name,
//           mobile,
//           email,
//           status,
//           created_at
//         `,
//         [
//           cleanName,
//           cleanMobile,
//           cleanEmail,
//           passwordHash,
//         ]
//       );


//     const shopper =
//       result.rows[0];


//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ SHOPPER REGISTERED'
//     );

//     console.log(
//       'SHOPPER ID:',
//       shopper.id
//     );

//     console.log(
//       'NAME:',
//       shopper.full_name
//     );

//     console.log(
//       'STATUS:',
//       shopper.status
//     );

//     console.log(
//       '===================================='
//     );


//     return res.status(201).json({

//       success: true,

//       message:
//         'Shopper registration successful',

//       shopper: {

//         id: shopper.id,

//         fullName:
//           shopper.full_name,

//         mobile:
//           shopper.mobile,

//         email:
//           shopper.email,

//         status:
//           shopper.status,

//         createdAt:
//           shopper.created_at,

//       },

//     });

//   } catch (error) {

//     console.error(
//       '❌ Shopper register error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Shopper registration failed',

//     });

//   }
// });


// // ==================================================
// // SHOPPER LOGIN
// // ==================================================

// router.post('/login', async (req, res) => {
//   try {

//     const {
//       email,
//       mobile,
//       password,
//     } = req.body;


//     // ================================================
//     // VALIDATION
//     // ================================================

//     if (!password) {

//       return res.status(400).json({
//         success: false,
//         message: 'Password is required',
//       });

//     }


//     if (!email && !mobile) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Email or mobile number is required',
//       });

//     }


//     let result;


//     // ================================================
//     // LOGIN WITH EMAIL
//     // ================================================

//     if (email) {

//       const cleanEmail =
//         email.trim().toLowerCase();


//       result =
//         await db.query(
//           `
//           SELECT
//             id,
//             full_name,
//             mobile,
//             email,
//             password_hash,
//             status,
//             latitude,
//             longitude,
//             created_at
//           FROM shoppers
//           WHERE LOWER(email) = $1
//           LIMIT 1
//           `,
//           [
//             cleanEmail,
//           ]
//         );

//     }

//     // ================================================
//     // LOGIN WITH MOBILE
//     // ================================================

//     else {

//       const cleanMobile =
//         mobile.trim();


//       result =
//         await db.query(
//           `
//           SELECT
//             id,
//             full_name,
//             mobile,
//             email,
//             password_hash,
//             status,
//             latitude,
//             longitude,
//             created_at
//           FROM shoppers
//           WHERE mobile = $1
//           LIMIT 1
//           `,
//           [
//             cleanMobile,
//           ]
//         );

//     }


//     // ================================================
//     // SHOPPER NOT FOUND
//     // ================================================

//     if (result.rows.length === 0) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid email/mobile or password',

//       });

//     }


//     const shopper =
//       result.rows[0];


//     // ================================================
//     // CHECK PASSWORD
//     // ================================================

//     const passwordMatch =
//       await bcrypt.compare(
//         password,
//         shopper.password_hash
//       );


//     if (!passwordMatch) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid email/mobile or password',

//       });

//     }


//     // ================================================
//     // REJECTED SHOPPER
//     // ================================================

//     if (
//       shopper.status === 'rejected'
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'Your shopper account has been rejected',

//       });

//     }


//     // ================================================
//     // CREATE JWT
//     // ================================================

//     const token =
//       jwt.sign(

//         {
//           shopperId:
//             shopper.id,

//           email:
//             shopper.email,

//         },

//         process.env.JWT_SECRET,

//         {
//           expiresIn:
//             '7d',
//         }

//       );


//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ SHOPPER LOGIN'
//     );

//     console.log(
//       'SHOPPER ID:',
//       shopper.id
//     );

//     console.log(
//       'EMAIL:',
//       shopper.email
//     );

//     console.log(
//       'STATUS:',
//       shopper.status
//     );

//     console.log(
//       '===================================='
//     );


//     // ================================================
//     // RESPONSE
//     // ================================================

//     return res.json({

//       success: true,

//       message:
//         'Login successful',

//       token,

//       shopper: {

//         id:
//           shopper.id,

//         fullName:
//           shopper.full_name,

//         mobile:
//           shopper.mobile,

//         email:
//           shopper.email,

//         status:
//           shopper.status,

//         latitude:
//           shopper.latitude,

//         longitude:
//           shopper.longitude,

//         createdAt:
//           shopper.created_at,

//       },

//     });

//   } catch (error) {

//     console.error(
//       '❌ Shopper login error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Shopper login failed',

//     });

//   }
// });


// module.exports =
//   router;










































// const express = require('express');

// const bcrypt = require('bcryptjs');

// const jwt = require('jsonwebtoken');

// const db = require('../config/db');

// const router = express.Router();


// // ==================================================
// // SHOPPER REGISTER
// // ==================================================

// router.post('/register', async (req, res) => {
//   try {

//     const {
//       fullName,
//       mobile,
//       email,
//       password,
//       confirmPassword,
//     } = req.body;


//     // ================================================
//     // VALIDATION
//     // ================================================

//     if (
//       !fullName ||
//       !mobile ||
//       !email ||
//       !password ||
//       !confirmPassword
//     ) {

//       return res.status(400).json({
//         success: false,
//         message: 'All fields are required',
//       });

//     }


//     if (password !== confirmPassword) {

//       return res.status(400).json({
//         success: false,
//         message: 'Passwords do not match',
//       });

//     }


//     if (password.length < 6) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Password must be at least 6 characters',
//       });

//     }


//     const cleanName =
//       fullName.trim();

//     const cleanMobile =
//       mobile.trim();

//     const cleanEmail =
//       email.trim().toLowerCase();


//     // ================================================
//     // CHECK EXISTING SHOPPER
//     // ================================================

//     const existingShopper =
//       await db.query(
//         `
//         SELECT id
//         FROM shoppers
//         WHERE LOWER(email) = $1
//            OR mobile = $2
//         LIMIT 1
//         `,
//         [
//           cleanEmail,
//           cleanMobile,
//         ]
//       );


//     if (
//       existingShopper.rows.length > 0
//     ) {

//       return res.status(409).json({
//         success: false,
//         message:
//           'Email or mobile number is already registered',
//       });

//     }


//     // ================================================
//     // HASH PASSWORD
//     // ================================================

//     const passwordHash =
//       await bcrypt.hash(
//         password,
//         10
//       );


//     // ================================================
//     // CREATE SHOPPER
//     // ================================================

//     const result =
//       await db.query(
//         `
//         INSERT INTO shoppers
//         (
//           full_name,
//           mobile,
//           email,
//           password_hash,
//           status
//         )
//         VALUES
//         ($1, $2, $3, $4, 'pending')
//         RETURNING
//           id,
//           full_name,
//           mobile,
//           email,
//           status,
//           created_at
//         `,
//         [
//           cleanName,
//           cleanMobile,
//           cleanEmail,
//           passwordHash,
//         ]
//       );


//     const shopper =
//       result.rows[0];


//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ SHOPPER REGISTERED'
//     );

//     console.log(
//       'SHOPPER ID:',
//       shopper.id
//     );

//     console.log(
//       'NAME:',
//       shopper.full_name
//     );

//     console.log(
//       'STATUS:',
//       shopper.status
//     );

//     console.log(
//       '===================================='
//     );


//     return res.status(201).json({

//       success: true,

//       message:
//         'Shopper registration successful',

//       shopper: {

//         id:
//           shopper.id,

//         fullName:
//           shopper.full_name,

//         mobile:
//           shopper.mobile,

//         email:
//           shopper.email,

//         status:
//           shopper.status,

//         createdAt:
//           shopper.created_at,

//       },

//     });

//   } catch (error) {

//     console.error(
//       '❌ Shopper register error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Shopper registration failed',

//     });

//   }
// });


// // ==================================================
// // SHOPPER LOGIN
// // ==================================================

// router.post('/login', async (req, res) => {
//   try {

//     const {
//       email,
//       mobile,
//       password,
//     } = req.body;


//     // ================================================
//     // VALIDATION
//     // ================================================

//     if (!password) {

//       return res.status(400).json({
//         success: false,
//         message: 'Password is required',
//       });

//     }


//     if (!email && !mobile) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Email or mobile number is required',
//       });

//     }


//     let result;


//     // ================================================
//     // LOGIN WITH EMAIL
//     // ================================================

//     if (email) {

//       const cleanEmail =
//         email.trim().toLowerCase();


//       result =
//         await db.query(
//           `
//           SELECT
//             id,
//             full_name,
//             mobile,
//             email,
//             password_hash,
//             status,
//             latitude,
//             longitude,
//             created_at
//           FROM shoppers
//           WHERE LOWER(email) = $1
//           LIMIT 1
//           `,
//           [
//             cleanEmail,
//           ]
//         );

//     }


//     // ================================================
//     // LOGIN WITH MOBILE
//     // ================================================

//     else {

//       const cleanMobile =
//         mobile.trim();


//       result =
//         await db.query(
//           `
//           SELECT
//             id,
//             full_name,
//             mobile,
//             email,
//             password_hash,
//             status,
//             latitude,
//             longitude,
//             created_at
//           FROM shoppers
//           WHERE mobile = $1
//           LIMIT 1
//           `,
//           [
//             cleanMobile,
//           ]
//         );

//     }


//     // ================================================
//     // SHOPPER NOT FOUND
//     // ================================================

//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid email/mobile or password',

//       });

//     }


//     const shopper =
//       result.rows[0];


//     // ================================================
//     // CHECK PASSWORD
//     // ================================================

//     const passwordMatch =
//       await bcrypt.compare(
//         password,
//         shopper.password_hash
//       );


//     if (!passwordMatch) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid email/mobile or password',

//       });

//     }


//     // ================================================
//     // REJECTED SHOPPER
//     // ================================================

//     if (
//       shopper.status === 'rejected'
//     ) {

//       return res.status(403).json({

//         success: false,

//         message:
//           'Your shopper account has been rejected',

//       });

//     }


//     // ================================================
//     // CREATE JWT
//     // ================================================

//     const token =
//       jwt.sign(

//         {
//           shopperId:
//             shopper.id,

//           email:
//             shopper.email,

//         },

//         process.env.JWT_SECRET,

//         {
//           expiresIn:
//             '7d',
//         }

//       );


//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ SHOPPER LOGIN'
//     );

//     console.log(
//       'SHOPPER ID:',
//       shopper.id
//     );

//     console.log(
//       'EMAIL:',
//       shopper.email
//     );

//     console.log(
//       'STATUS:',
//       shopper.status
//     );

//     console.log(
//       '===================================='
//     );


//     // ================================================
//     // RESPONSE
//     // ================================================

//     return res.json({

//       success: true,

//       message:
//         'Login successful',

//       token,

//       shopper: {

//         id:
//           shopper.id,

//         fullName:
//           shopper.full_name,

//         mobile:
//           shopper.mobile,

//         email:
//           shopper.email,

//         status:
//           shopper.status,

//         latitude:
//           shopper.latitude,

//         longitude:
//           shopper.longitude,

//         createdAt:
//           shopper.created_at,

//       },

//     });

//   } catch (error) {

//     console.error(
//       '❌ Shopper login error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Shopper login failed',

//     });

//   }
// });


// // ==================================================
// // ADMIN - GET ALL SHOPPERS
// // ==================================================

// router.get('/admin/all', async (req, res) => {
//   try {

//     const result =
//       await db.query(
//         `
//         SELECT
//           id,
//           full_name,
//           mobile,
//           email,
//           status,
//           latitude,
//           longitude,
//           created_at
//         FROM shoppers
//         ORDER BY created_at DESC
//         `
//       );


//     return res.json({

//       success: true,

//       shoppers:
//         result.rows.map(
//           (shopper) => ({

//             id:
//               shopper.id,

//             fullName:
//               shopper.full_name,

//             mobile:
//               shopper.mobile,

//             email:
//               shopper.email,

//             status:
//               shopper.status,

//             latitude:
//               shopper.latitude,

//             longitude:
//               shopper.longitude,

//             createdAt:
//               shopper.created_at,

//           })
//         ),

//     });

//   } catch (error) {

//     console.error(
//       '❌ Admin shoppers fetch error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to fetch shoppers',

//     });

//   }
// });


// // ==================================================
// // EXPORT
// // ==================================================

// module.exports =
//   router;











// const express = require('express');

// const bcrypt = require('bcryptjs');

// const jwt = require('jsonwebtoken');

// const db = require('../config/db');

// const router = express.Router();


// // ==================================================
// // SHOPPER REGISTER
// // ==================================================

// router.post('/register', async (req, res) => {
//   try {

//     const {
//       fullName,
//       mobile,
//       email,
//       password,
//       confirmPassword,
//     } = req.body;


//     // ================================================
//     // VALIDATION
//     // ================================================

//     if (
//       !fullName ||
//       !mobile ||
//       !email ||
//       !password ||
//       !confirmPassword
//     ) {

//       return res.status(400).json({
//         success: false,
//         message: 'All fields are required',
//       });

//     }


//     if (password !== confirmPassword) {

//       return res.status(400).json({
//         success: false,
//         message: 'Passwords do not match',
//       });

//     }


//     if (password.length < 6) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Password must be at least 6 characters',
//       });

//     }


//     const cleanName = fullName.trim();

//     const cleanMobile = mobile.trim();

//     const cleanEmail = email.trim().toLowerCase();


//     // ================================================
//     // CHECK EXISTING SHOPPER
//     // ================================================

//     const existingShopper = await db.query(
//       `
//       SELECT id
//       FROM shoppers
//       WHERE LOWER(email) = $1
//          OR mobile = $2
//       LIMIT 1
//       `,
//       [
//         cleanEmail,
//         cleanMobile,
//       ]
//     );


//     if (existingShopper.rows.length > 0) {

//       return res.status(409).json({
//         success: false,
//         message:
//           'Email or mobile number is already registered',
//       });

//     }


//     // ================================================
//     // HASH PASSWORD
//     // ================================================

//     const passwordHash = await bcrypt.hash(
//       password,
//       10
//     );


//     // ================================================
//     // CREATE SHOPPER
//     // ================================================

//     const result = await db.query(
//       `
//       INSERT INTO shoppers
//       (
//         full_name,
//         mobile,
//         email,
//         password_hash,
//         status
//       )
//       VALUES
//       ($1, $2, $3, $4, 'pending')
//       RETURNING
//         id,
//         full_name,
//         mobile,
//         email,
//         status,
//         created_at
//       `,
//       [
//         cleanName,
//         cleanMobile,
//         cleanEmail,
//         passwordHash,
//       ]
//     );


//     const shopper = result.rows[0];


//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ SHOPPER REGISTERED'
//     );

//     console.log(
//       'SHOPPER ID:',
//       shopper.id
//     );

//     console.log(
//       'NAME:',
//       shopper.full_name
//     );

//     console.log(
//       'STATUS:',
//       shopper.status
//     );

//     console.log(
//       '===================================='
//     );


//     // ================================================
//     // SOCKET.IO - SHOPPER CREATED
//     // ================================================

//     const io = req.app.get('io');

//     if (io) {

//       io.emit('shopper_registered', {
//         id: shopper.id,
//         fullName: shopper.full_name,
//         mobile: shopper.mobile,
//         email: shopper.email,
//         status: shopper.status,
//         createdAt: shopper.created_at,
//       });

//       io.emit('shoppers_updated');

//     }


//     // ================================================
//     // RESPONSE
//     // ================================================

//     return res.status(201).json({

//       success: true,

//       message:
//         'Shopper registration successful',

//       shopper: {

//         id:
//           shopper.id,

//         fullName:
//           shopper.full_name,

//         mobile:
//           shopper.mobile,

//         email:
//           shopper.email,

//         status:
//           shopper.status,

//         createdAt:
//           shopper.created_at,

//       },

//     });

//   } catch (error) {

//     console.error(
//       '❌ Shopper register error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Shopper registration failed',

//     });

//   }
// });


// // ==================================================
// // SHOPPER LOGIN
// // ==================================================

// router.post('/login', async (req, res) => {
//   try {

//     const {
//       email,
//       mobile,
//       password,
//     } = req.body;


//     // ================================================
//     // VALIDATION
//     // ================================================

//     if (!password) {

//       return res.status(400).json({
//         success: false,
//         message: 'Password is required',
//       });

//     }


//     if (!email && !mobile) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Email or mobile number is required',
//       });

//     }


//     let result;


//     // ================================================
//     // LOGIN WITH EMAIL
//     // ================================================

//     if (email) {

//       const cleanEmail =
//         email.trim().toLowerCase();


//       result = await db.query(
//         `
//         SELECT
//           id,
//           full_name,
//           mobile,
//           email,
//           password_hash,
//           status,
//           latitude,
//           longitude,
//           created_at
//         FROM shoppers
//         WHERE LOWER(email) = $1
//         LIMIT 1
//         `,
//         [
//           cleanEmail,
//         ]
//       );

//     }


//     // ================================================
//     // LOGIN WITH MOBILE
//     // ================================================

//     else {

//       const cleanMobile =
//         mobile.trim();


//       result = await db.query(
//         `
//         SELECT
//           id,
//           full_name,
//           mobile,
//           email,
//           password_hash,
//           status,
//           latitude,
//           longitude,
//           created_at
//         FROM shoppers
//         WHERE mobile = $1
//         LIMIT 1
//         `,
//         [
//           cleanMobile,
//         ]
//       );

//     }


//     // ================================================
//     // SHOPPER NOT FOUND
//     // ================================================

//     if (result.rows.length === 0) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid email/mobile or password',

//       });

//     }


//     const shopper =
//       result.rows[0];


//     // ================================================
//     // CHECK PASSWORD
//     // ================================================

//     const passwordMatch =
//       await bcrypt.compare(
//         password,
//         shopper.password_hash
//       );


//     if (!passwordMatch) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid email/mobile or password',

//       });

//     }


//     // ================================================
//     // REJECTED SHOPPER
//     // ================================================

//     if (shopper.status === 'rejected') {

//       return res.status(403).json({

//         success: false,

//         message:
//           'Your shopper account has been rejected',

//       });

//     }


//     // ================================================
//     // CREATE JWT
//     // ================================================

//     const token =
//       jwt.sign(

//         {
//           shopperId:
//             shopper.id,

//           email:
//             shopper.email,

//         },

//         process.env.JWT_SECRET,

//         {
//           expiresIn:
//             '7d',
//         }

//       );


//     console.log(
//       '===================================='
//     );

//     console.log(
//       '✅ SHOPPER LOGIN'
//     );

//     console.log(
//       'SHOPPER ID:',
//       shopper.id
//     );

//     console.log(
//       'EMAIL:',
//       shopper.email
//     );

//     console.log(
//       'STATUS:',
//       shopper.status
//     );

//     console.log(
//       '===================================='
//     );


//     // ================================================
//     // RESPONSE
//     // ================================================

//     return res.json({

//       success: true,

//       message:
//         'Login successful',

//       token,

//       shopper: {

//         id:
//           shopper.id,

//         fullName:
//           shopper.full_name,

//         mobile:
//           shopper.mobile,

//         email:
//           shopper.email,

//         status:
//           shopper.status,

//         latitude:
//           shopper.latitude,

//         longitude:
//           shopper.longitude,

//         createdAt:
//           shopper.created_at,

//       },

//     });

//   } catch (error) {

//     console.error(
//       '❌ Shopper login error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Shopper login failed',

//     });

//   }
// });


// // ==================================================
// // ADMIN - GET ALL SHOPPERS
// // ==================================================

// router.get('/admin/all', async (req, res) => {
//   try {

//     const result = await db.query(
//       `
//       SELECT
//         id,
//         full_name,
//         mobile,
//         email,
//         status,
//         latitude,
//         longitude,
//         created_at
//       FROM shoppers
//       ORDER BY created_at DESC
//       `
//     );


//     return res.json({

//       success: true,

//       shoppers:
//         result.rows.map(
//           (shopper) => ({

//             id:
//               shopper.id,

//             fullName:
//               shopper.full_name,

//             mobile:
//               shopper.mobile,

//             email:
//               shopper.email,

//             status:
//               shopper.status,

//             latitude:
//               shopper.latitude,

//             longitude:
//               shopper.longitude,

//             createdAt:
//               shopper.created_at,

//           })
//         ),

//     });

//   } catch (error) {

//     console.error(
//       '❌ Admin shoppers fetch error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to fetch shoppers',

//     });

//   }
// });


// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = router;



















const express = require('express');

const bcrypt = require('bcryptjs');

const jwt = require('jsonwebtoken');

const db = require('../config/db');

const router = express.Router();


// ==================================================
// SHOPPER REGISTER
// ==================================================

router.post('/register', async (req, res) => {
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

    const cleanMobile = mobile.trim();

    const cleanEmail = email.trim().toLowerCase();


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
        status
      )
      VALUES
      ($1, $2, $3, $4, 'pending')
      RETURNING
        id,
        full_name,
        mobile,
        email,
        status,
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

    const io = req.app.get('io');

    if (io) {

      io.emit('shopper_registered', {
        id: shopper.id,
        fullName: shopper.full_name,
        mobile: shopper.mobile,
        email: shopper.email,
        status: shopper.status,
        createdAt: shopper.created_at,
      });

      io.emit('shoppers_updated');

    }


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

router.post('/login', async (req, res) => {
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
        mobile.trim();


      result = await db.query(
        `
        SELECT
          id,
          full_name,
          mobile,
          email,
          password_hash,
          status,
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
    // REJECTED SHOPPER
    // ================================================

    if (shopper.status === 'rejected') {

      return res.status(403).json({

        success: false,

        message:
          'Your shopper account has been rejected',

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
// SHOPPER STATUS UPDATE
// ==================================================

router.post('/status', async (req, res) => {
  try {

    const {
      shopperId,
      status,
    } = req.body;


    // ================================================
    // VALIDATION
    // ================================================

    if (!shopperId || !status) {

      return res.status(400).json({

        success: false,

        message:
          'Shopper ID and status are required',

      });

    }


    // ================================================
    // ALLOWED STATUS VALUES
    // ================================================

    const allowedStatuses = [
      'pending',
      'approved',
      'online',
      'offline',
      'rejected',
    ];


    if (!allowedStatuses.includes(status)) {

      return res.status(400).json({

        success: false,

        message:
          'Invalid shopper status',

      });

    }


    // ================================================
    // UPDATE DATABASE
    // ================================================

    const result = await db.query(
      `
      UPDATE shoppers
      SET status = $1
      WHERE id = $2
      RETURNING
        id,
        full_name,
        mobile,
        email,
        status,
        latitude,
        longitude,
        created_at
      `,
      [
        status,
        shopperId,
      ]
    );


    if (result.rows.length === 0) {

      return res.status(404).json({

        success: false,

        message:
          'Shopper not found',

      });

    }


    const shopper =
      result.rows[0];


    console.log(
      '===================================='
    );

    console.log(
      '🔄 SHOPPER STATUS UPDATED'
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
    // SOCKET.IO - STATUS UPDATED
    // ================================================

    const io = req.app.get('io');

    if (io) {

      io.emit('shopper_status_updated', {

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

        latitude:
          shopper.latitude,

        longitude:
          shopper.longitude,

      });

      io.emit('shoppers_updated');

    }


    // ================================================
    // RESPONSE
    // ================================================

    return res.json({

      success: true,

      message:
        'Shopper status updated successfully',

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
      '❌ Shopper status update error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to update shopper status',

    });

  }
});


// ==================================================
// ADMIN - GET ALL SHOPPERS
// ==================================================

router.get('/admin/all', async (req, res) => {
  try {

    const result = await db.query(
      `
      SELECT
        id,
        full_name,
        mobile,
        email,
        status,
        latitude,
        longitude,
        created_at
      FROM shoppers
      ORDER BY created_at DESC
      `
    );


    return res.json({

      success: true,

      shoppers:
        result.rows.map(
          (shopper) => ({

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

            latitude:
              shopper.latitude,

            longitude:
              shopper.longitude,

            createdAt:
              shopper.created_at,

          })
        ),

    });

  } catch (error) {

    console.error(
      '❌ Admin shoppers fetch error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to fetch shoppers',

    });

  }
});


// ==================================================
// EXPORT
// ==================================================

module.exports = router;
