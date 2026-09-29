// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');

// const db = require('../config/db');

// // ==================================================
// // REGISTER SHOP
// // ==================================================

// const registerShop = async (req, res) => {
//   try {
//     const {
//       shopName,
//       email,
//       mobile,
//       password,
//       address,
//     } = req.body;

//     if (!shopName || !email || !password) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Shop name, email and password are required',
//       });
//     }

//     if (password.length < 6) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Password must be at least 6 characters',
//       });
//     }

//     const existingShop = await db.query(
//       `
//       SELECT id
//       FROM shops
//       WHERE email = $1
//       `,
//       [email]
//     );

//     if (existingShop.rows.length > 0) {
//       return res.status(409).json({
//         success: false,
//         message:
//           'A shop with this email already exists',
//       });
//     }

//     const passwordHash = await bcrypt.hash(
//       password,
//       10
//     );

//     const result = await db.query(
//       `
//       INSERT INTO shops
//       (
//         shop_name,
//         email,
//         mobile,
//         password_hash,
//         address,
//         status
//       )
//       VALUES
//       (
//         $1,
//         $2,
//         $3,
//         $4,
//         $5,
//         'pending'
//       )
//       RETURNING
//         id,
//         shop_name,
//         email,
//         mobile,
//         address,
//         status,
//         created_at
//       `,
//       [
//         shopName,
//         email,
//         mobile || null,
//         passwordHash,
//         address || null,
//       ]
//     );

//     return res.status(201).json({
//       success: true,
//       message:
//         'Shop registration submitted successfully',
//       shop: result.rows[0],
//     });

//   } catch (error) {
//     console.error(
//       '❌ REGISTER SHOP ERROR:',
//       error.message
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error while registering shop',
//     });
//   }
// };

// // ==================================================
// // LOGIN SHOP
// // ==================================================

// const loginShop = async (req, res) => {
//   try {
//     const {
//       email,
//       password,
//     } = req.body;

//     console.log('=================================');
//     console.log('SHOP LOGIN REQUEST');
//     console.log('EMAIL:', email);
//     console.log('=================================');

//     if (!email || !password) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Email and password are required',
//       });
//     }

//     const result = await db.query(
//       `
//       SELECT
//         id,
//         shop_name,
//         email,
//         mobile,
//         password_hash,
//         address,
//         status
//       FROM shops
//       WHERE email = $1
//       `,
//       [email]
//     );

//     if (result.rows.length === 0) {
//       console.log(
//         '❌ SHOP NOT FOUND'
//       );

//       return res.status(401).json({
//         success: false,
//         message:
//           'Invalid email or password',
//       });
//     }

//     const shop = result.rows[0];

//     console.log(
//       'SHOP FOUND:',
//       shop.id,
//       shop.shop_name,
//       shop.status
//     );

//     const passwordMatch =
//       await bcrypt.compare(
//         password,
//         shop.password_hash
//       );

//     console.log(
//       'PASSWORD MATCH:',
//       passwordMatch
//     );

//     if (!passwordMatch) {
//       return res.status(401).json({
//         success: false,
//         message:
//           'Invalid email or password',
//       });
//     }

//     if (shop.status !== 'approved') {
//       return res.status(403).json({
//         success: false,
//         message:
//           'Your shop account is pending admin approval',
//         status: shop.status,
//       });
//     }

//     const token = jwt.sign(
//       {
//         shopId: shop.id,
//         email: shop.email,
//       },
//       process.env.JWT_SECRET,
//       {
//         expiresIn: '7d',
//       }
//     );

//     console.log(
//       '✅ SHOP LOGIN SUCCESS:',
//       shop.id
//     );

//     return res.status(200).json({
//       success: true,
//       message:
//         'Shop login successful',

//       token,

//       shop: {
//         id: shop.id,
//         shopName: shop.shop_name,
//         email: shop.email,
//         mobile: shop.mobile,
//         address: shop.address,
//         status: shop.status,
//       },
//     });

//   } catch (error) {
//     console.error(
//       '❌ SHOP LOGIN ERROR:',
//       error.message
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error while logging in',
//     });
//   }
// };

// // ==================================================
// // GET SHOP PROFILE
// // ==================================================

// const getShopProfile = async (req, res) => {
//   try {
//     const result = await db.query(
//       `
//       SELECT
//         id,
//         shop_name,
//         email,
//         mobile,
//         address,
//         status,
//         created_at
//       FROM shops
//       WHERE id = $1
//       `,
//       [req.shop.shopId]
//     );

//     if (result.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message:
//           'Shop not found',
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       shop: result.rows[0],
//     });

//   } catch (error) {
//     console.error(
//       '❌ GET SHOP ERROR:',
//       error.message
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error while getting shop profile',
//     });
//   }
// };

// // ==================================================
// // ADD PRODUCT
// // ==================================================

// const addProduct = async (req, res) => {
//   try {
//     const {
//       productName,
//       category,
//       price,
//       stockQuantity,
//       description,
//       imageUrl,
//       isAvailable,
//     } = req.body;

//     if (
//       !productName ||
//       !category ||
//       price === undefined ||
//       stockQuantity === undefined
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Product name, category, price and stock quantity are required',
//       });
//     }

//     const result = await db.query(
//       `
//       INSERT INTO products
//       (
//         shop_id,
//         product_name,
//         category,
//         price,
//         stock_quantity,
//         description,
//         image_url,
//         is_available
//       )
//       VALUES
//       (
//         $1,
//         $2,
//         $3,
//         $4,
//         $5,
//         $6,
//         $7,
//         $8
//       )
//       RETURNING *
//       `,
//       [
//         req.shop.shopId,
//         productName,
//         category,
//         price,
//         stockQuantity,
//         description || null,
//         imageUrl || null,
//         isAvailable !== undefined
//           ? isAvailable
//           : true,
//       ]
//     );

//     return res.status(201).json({
//       success: true,
//       message:
//         'Product added successfully',
//       product: result.rows[0],
//     });

//   } catch (error) {
//     console.error(
//       '❌ ADD PRODUCT ERROR:',
//       error.message
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error while adding product',
//     });
//   }
// };

// // ==================================================
// // GET PRODUCTS
// // ==================================================

// const getProducts = async (req, res) => {
//   try {
//     const result = await db.query(
//       `
//       SELECT
//         id,
//         shop_id,
//         product_name,
//         category,
//         price,
//         stock_quantity,
//         description,
//         image_url,
//         is_available,
//         created_at,
//         updated_at
//       FROM products
//       WHERE shop_id = $1
//       ORDER BY created_at DESC
//       `,
//       [req.shop.shopId]
//     );

//     return res.status(200).json({
//       success: true,
//       products: result.rows,
//     });

//   } catch (error) {
//     console.error(
//       '❌ GET PRODUCTS ERROR:',
//       error.message
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error while getting products',
//     });
//   }
// };

// // ==================================================
// // UPDATE PRODUCT
// // ==================================================

// const updateProduct = async (req, res) => {
//   try {
//     const productId = req.params.id;

//     const {
//       productName,
//       category,
//       price,
//       stockQuantity,
//       description,
//       imageUrl,
//       isAvailable,
//     } = req.body;

//     const result = await db.query(
//       `
//       UPDATE products
//       SET
//         product_name = $1,
//         category = $2,
//         price = $3,
//         stock_quantity = $4,
//         description = $5,
//         image_url = $6,
//         is_available = $7,
//         updated_at = CURRENT_TIMESTAMP
//       WHERE
//         id = $8
//         AND shop_id = $9
//       RETURNING *
//       `,
//       [
//         productName,
//         category,
//         price,
//         stockQuantity,
//         description || null,
//         imageUrl || null,
//         isAvailable !== undefined
//           ? isAvailable
//           : true,
//         productId,
//         req.shop.shopId,
//       ]
//     );

//     if (result.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message:
//           'Product not found',
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       message:
//         'Product updated successfully',
//       product: result.rows[0],
//     });

//   } catch (error) {
//     console.error(
//       '❌ UPDATE PRODUCT ERROR:',
//       error.message
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error while updating product',
//     });
//   }
// };

// // ==================================================
// // DELETE PRODUCT
// // ==================================================

// const deleteProduct = async (req, res) => {
//   try {
//     const productId = req.params.id;

//     const result = await db.query(
//       `
//       DELETE FROM products
//       WHERE
//         id = $1
//         AND shop_id = $2
//       RETURNING id
//       `,
//       [
//         productId,
//         req.shop.shopId,
//       ]
//     );

//     if (result.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message:
//           'Product not found',
//       });
//     }

//     return res.status(200).json({
//       success: true,
//       message:
//         'Product deleted successfully',
//     });

//   } catch (error) {
//     console.error(
//       '❌ DELETE PRODUCT ERROR:',
//       error.message
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error while deleting product',
//     });
//   }
// };

// // ==================================================
// // EXPORT
// // ==================================================

// module.exports = {
//   registerShop,
//   loginShop,
//   getShopProfile,
//   addProduct,
//   getProducts,
//   updateProduct,
//   deleteProduct,
// };


// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');

// const pool =
//   require('../config/db');


// // ==================================================
// // REGISTER SHOP
// // ==================================================

// const registerShop = async (
//   req,
//   res
// ) => {

//   try {

//     const {
//       shopName,
//       email,
//       mobile,
//       password,
//       address,
//     } = req.body;


//     if (
//       !shopName ||
//       !email ||
//       !password
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Shop name, email and password are required',
//       });

//     }


//     if (
//       password.length < 6
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Password must be at least 6 characters',
//       });

//     }


//     const existingShop =
//       await pool.query(
//         `
//         SELECT id
//         FROM shops
//         WHERE email = $1
//         `,
//         [email]
//       );


//     if (
//       existingShop.rows.length > 0
//     ) {

//       return res.status(409).json({
//         success: false,
//         message:
//           'Shop email already exists',
//       });

//     }


//     const passwordHash =
//       await bcrypt.hash(
//         password,
//         10
//       );


//     const result =
//       await pool.query(
//         `
//         INSERT INTO shops
//         (
//           shop_name,
//           email,
//           mobile,
//           password_hash,
//           address,
//           status
//         )
//         VALUES
//         ($1, $2, $3, $4, $5, $6)
//         RETURNING
//           id,
//           shop_name,
//           email,
//           mobile,
//           address,
//           status,
//           created_at
//         `,
//         [
//           shopName,
//           email,
//           mobile || null,
//           passwordHash,
//           address || null,
//           'pending',
//         ]
//       );


//     return res.status(201).json({
//       success: true,
//       message:
//         'Shop registered successfully',
//       shop: result.rows[0],
//     });


//   } catch (error) {

//     console.error(
//       'Register shop error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // LOGIN SHOP
// // ==================================================

// const loginShop = async (
//   req,
//   res
// ) => {

//   try {

//     const {
//       email,
//       password,
//     } = req.body;


//     if (
//       !email ||
//       !password
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Email and password are required',
//       });

//     }


//     const result =
//       await pool.query(
//         `
//         SELECT *
//         FROM shops
//         WHERE email = $1
//         `,
//         [email]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Invalid email or password',
//       });

//     }


//     const shop =
//       result.rows[0];


//     const passwordMatch =
//       await bcrypt.compare(
//         password,
//         shop.password_hash
//       );


//     if (!passwordMatch) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Invalid email or password',
//       });

//     }


//     if (
//       shop.status !== 'approved'
//     ) {

//       return res.status(403).json({
//         success: false,
//         message:
//           'Shop account is not approved yet',
//       });

//     }


//     const token =
//       jwt.sign(
//         {
//           shopId: shop.id,
//           email: shop.email,
//         },
//         process.env.JWT_SECRET,
//         {
//           expiresIn: '7d',
//         }
//       );


//     return res.json({
//       success: true,

//       token,

//       shop: {
//         id: shop.id,
//         shopName:
//           shop.shop_name,
//         email:
//           shop.email,
//         mobile:
//           shop.mobile,
//         address:
//           shop.address,
//         status:
//           shop.status,
//       },

//     });


//   } catch (error) {

//     console.error(
//       'Login shop error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // SHOP PROFILE
// // ==================================================

// const getShopProfile = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;


//     const result =
//       await pool.query(
//         `
//         SELECT
//           id,
//           shop_name,
//           email,
//           mobile,
//           address,
//           status,
//           created_at,
//           updated_at
//         FROM shops
//         WHERE id = $1
//         `,
//         [shopId]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Shop not found',
//       });

//     }


//     return res.json({
//       success: true,
//       shop: result.rows[0],
//     });


//   } catch (error) {

//     console.error(
//       'Get shop profile error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // ADD PRODUCT
// // ==================================================

// const addProduct = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;


//     const {
//       productName,
//       category,
//       price,
//       stockQuantity,
//       description,
//       imageUrl,
//       isAvailable,
//     } = req.body;


//     if (
//       !productName ||
//       !category ||
//       price === undefined ||
//       stockQuantity === undefined
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Product name, category, price and stock quantity are required',
//       });

//     }


//     let finalImageUrl =
//       imageUrl || null;


//     // If PC image was uploaded
//     if (req.file) {

//       finalImageUrl =
//         `/uploads/products/${req.file.filename}`;

//     }


//     const result =
//       await pool.query(
//         `
//         INSERT INTO products
//         (
//           shop_id,
//           product_name,
//           category,
//           price,
//           stock_quantity,
//           description,
//           image_url,
//           is_available
//         )
//         VALUES
//         ($1, $2, $3, $4, $5, $6, $7, $8)
//         RETURNING *
//         `,
//         [
//           shopId,
//           productName.trim(),
//           category.trim(),
//           Number(price),
//           Number(stockQuantity),
//           description
//             ? description.trim()
//             : null,
//           finalImageUrl,
//           isAvailable !== false,
//         ]
//       );


//     return res.status(201).json({
//       success: true,
//       message:
//         'Product added successfully',
//       product:
//         result.rows[0],
//     });


//   } catch (error) {

//     console.error(
//       'Add product error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         error.message ||
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // GET PRODUCTS
// // ==================================================

// const getProducts = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;


//     const result =
//       await pool.query(
//         `
//         SELECT
//           id,
//           shop_id,
//           product_name,
//           category,
//           price,
//           stock_quantity,
//           description,
//           image_url,
//           is_available,
//           created_at,
//           updated_at
//         FROM products
//         WHERE shop_id = $1
//         ORDER BY created_at DESC
//         `,
//         [shopId]
//       );


//     return res.json({
//       success: true,
//       products:
//         result.rows,
//     });


//   } catch (error) {

//     console.error(
//       'Get products error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // UPDATE PRODUCT
// // ==================================================

// const updateProduct = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;

//     const productId =
//       req.params.id;


//     const {
//       productName,
//       category,
//       price,
//       stockQuantity,
//       description,
//       imageUrl,
//       isAvailable,
//     } = req.body;


//     // First get current image
//     const currentProduct =
//       await pool.query(
//         `
//         SELECT image_url
//         FROM products
//         WHERE
//           id = $1
//           AND shop_id = $2
//         `,
//         [
//           productId,
//           shopId,
//         ]
//       );


//     if (
//       currentProduct.rows.length === 0
//     ) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Product not found',
//       });

//     }


//     let finalImageUrl =
//       currentProduct.rows[0].image_url;


//     // New PC image selected
//     if (req.file) {

//       finalImageUrl =
//         `/uploads/products/${req.file.filename}`;

//     }
//     // URL manually supplied
//     else if (
//       imageUrl !== undefined
//     ) {

//       finalImageUrl =
//         imageUrl || null;

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE products
//         SET
//           product_name = $1,
//           category = $2,
//           price = $3,
//           stock_quantity = $4,
//           description = $5,
//           image_url = $6,
//           is_available = $7,
//           updated_at = CURRENT_TIMESTAMP
//         WHERE
//           id = $8
//           AND shop_id = $9
//         RETURNING *
//         `,
//         [
//           productName.trim(),
//           category.trim(),
//           Number(price),
//           Number(stockQuantity),
//           description
//             ? description.trim()
//             : null,
//           finalImageUrl,
//           isAvailable !== false,
//           productId,
//           shopId,
//         ]
//       );


//     return res.json({
//       success: true,
//       message:
//         'Product updated successfully',
//       product:
//         result.rows[0],
//     });


//   } catch (error) {

//     console.error(
//       'Update product error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         error.message ||
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // DELETE PRODUCT
// // ==================================================

// const deleteProduct = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;

//     const productId =
//       req.params.id;


//     const result =
//       await pool.query(
//         `
//         DELETE FROM products
//         WHERE
//           id = $1
//           AND shop_id = $2
//         RETURNING id
//         `,
//         [
//           productId,
//           shopId,
//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Product not found',
//       });

//     }


//     return res.json({
//       success: true,
//       message:
//         'Product deleted successfully',
//     });


//   } catch (error) {

//     console.error(
//       'Delete product error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // EXPORTS
// // ==================================================

// module.exports = {
//   registerShop,
//   loginShop,
//   getShopProfile,
//   addProduct,
//   getProducts,
//   updateProduct,
//   deleteProduct,
// };




// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');

// const pool =
//   require('../config/db');


// // ==================================================
// // REGISTER SHOP
// // ==================================================

// const registerShop = async (
//   req,
//   res
// ) => {

//   try {

//     const {
//       shopName,
//       email,
//       mobile,
//       password,
//       address,
//     } = req.body;


//     if (
//       !shopName ||
//       !email ||
//       !password
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Shop name, email and password are required',
//       });

//     }


//     if (
//       password.length < 6
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Password must be at least 6 characters',
//       });

//     }


//     const existingShop =
//       await pool.query(
//         `
//         SELECT id
//         FROM shops
//         WHERE email = $1
//         `,
//         [email]
//       );


//     if (
//       existingShop.rows.length > 0
//     ) {

//       return res.status(409).json({
//         success: false,
//         message:
//           'Shop email already exists',
//       });

//     }


//     const passwordHash =
//       await bcrypt.hash(
//         password,
//         10
//       );


//     const result =
//       await pool.query(
//         `
//         INSERT INTO shops
//         (
//           shop_name,
//           email,
//           mobile,
//           password_hash,
//           address,
//           status
//         )
//         VALUES
//         ($1, $2, $3, $4, $5, $6)
//         RETURNING
//           id,
//           shop_name,
//           email,
//           mobile,
//           address,
//           status,
//           created_at
//         `,
//         [
//           shopName,
//           email,
//           mobile || null,
//           passwordHash,
//           address || null,
//           'pending',
//         ]
//       );


//     return res.status(201).json({
//       success: true,
//       message:
//         'Shop registered successfully',
//       shop:
//         result.rows[0],
//     });


//   } catch (error) {

//     console.error(
//       'Register shop error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // LOGIN SHOP
// // ==================================================

// const loginShop = async (
//   req,
//   res
// ) => {

//   try {

//     const {
//       email,
//       password,
//     } = req.body;


//     if (
//       !email ||
//       !password
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Email and password are required',
//       });

//     }


//     const result =
//       await pool.query(
//         `
//         SELECT *
//         FROM shops
//         WHERE email = $1
//         `,
//         [email]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Invalid email or password',
//       });

//     }


//     const shop =
//       result.rows[0];


//     const passwordMatch =
//       await bcrypt.compare(
//         password,
//         shop.password_hash
//       );


//     if (!passwordMatch) {

//       return res.status(401).json({
//         success: false,
//         message:
//           'Invalid email or password',
//       });

//     }


//     if (
//       shop.status !== 'approved'
//     ) {

//       return res.status(403).json({
//         success: false,
//         message:
//           'Shop account is not approved yet',
//       });

//     }


//     const token =
//       jwt.sign(
//         {
//           shopId: shop.id,
//           email: shop.email,
//         },
//         process.env.JWT_SECRET,
//         {
//           expiresIn: '7d',
//         }
//       );


//     return res.json({
//       success: true,

//       token,

//       shop: {
//         id: shop.id,
//         shopName:
//           shop.shop_name,
//         email:
//           shop.email,
//         mobile:
//           shop.mobile,
//         address:
//           shop.address,
//         status:
//           shop.status,
//       },

//     });


//   } catch (error) {

//     console.error(
//       'Login shop error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // SHOP PROFILE
// // ==================================================

// const getShopProfile = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;


//     const result =
//       await pool.query(
//         `
//         SELECT
//           id,
//           shop_name,
//           email,
//           mobile,
//           address,
//           status,
//           created_at,
//           updated_at
//         FROM shops
//         WHERE id = $1
//         `,
//         [shopId]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Shop not found',
//       });

//     }


//     return res.json({
//       success: true,
//       shop: result.rows[0],
//     });


//   } catch (error) {

//     console.error(
//       'Get shop profile error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // UPDATE SHOP PROFILE
// // ==================================================

// const updateShopProfile = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;


//     const {
//       shopName,
//       mobile,
//       address,
//     } = req.body;


//     if (
//       !shopName ||
//       !shopName.trim()
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Shop name is required',
//       });

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE shops
//         SET
//           shop_name = $1,
//           mobile = $2,
//           address = $3,
//           updated_at = CURRENT_TIMESTAMP
//         WHERE
//           id = $4
//         RETURNING
//           id,
//           shop_name,
//           email,
//           mobile,
//           address,
//           status,
//           created_at,
//           updated_at
//         `,
//         [
//           shopName.trim(),

//           mobile
//             ? mobile.trim()
//             : null,

//           address
//             ? address.trim()
//             : null,

//           shopId,
//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Shop not found',
//       });

//     }


//     return res.json({
//       success: true,
//       message:
//         'Shop profile updated successfully',
//       shop:
//         result.rows[0],
//     });


//   } catch (error) {

//     console.error(
//       'Update shop profile error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // ADD PRODUCT
// // ==================================================

// const addProduct = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;


//     const {
//       productName,
//       category,
//       price,
//       stockQuantity,
//       description,
//       imageUrl,
//       isAvailable,
//     } = req.body;


//     if (
//       !productName ||
//       !category ||
//       price === undefined ||
//       stockQuantity === undefined
//     ) {

//       return res.status(400).json({
//         success: false,
//         message:
//           'Product name, category, price and stock quantity are required',
//       });

//     }


//     let finalImageUrl =
//       imageUrl || null;


//     // If PC image was uploaded
//     if (req.file) {

//       finalImageUrl =
//         `/uploads/products/${req.file.filename}`;

//     }


//     const result =
//       await pool.query(
//         `
//         INSERT INTO products
//         (
//           shop_id,
//           product_name,
//           category,
//           price,
//           stock_quantity,
//           description,
//           image_url,
//           is_available
//         )
//         VALUES
//         ($1, $2, $3, $4, $5, $6, $7, $8)
//         RETURNING *
//         `,
//         [
//           shopId,
//           productName.trim(),
//           category.trim(),
//           Number(price),
//           Number(stockQuantity),
//           description
//             ? description.trim()
//             : null,
//           finalImageUrl,
//           isAvailable !== false,
//         ]
//       );


//     return res.status(201).json({
//       success: true,
//       message:
//         'Product added successfully',
//       product:
//         result.rows[0],
//     });


//   } catch (error) {

//     console.error(
//       'Add product error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         error.message ||
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // GET PRODUCTS
// // ==================================================

// const getProducts = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;


//     const result =
//       await pool.query(
//         `
//         SELECT
//           id,
//           shop_id,
//           product_name,
//           category,
//           price,
//           stock_quantity,
//           description,
//           image_url,
//           is_available,
//           created_at,
//           updated_at
//         FROM products
//         WHERE shop_id = $1
//         ORDER BY created_at DESC
//         `,
//         [shopId]
//       );


//     return res.json({
//       success: true,
//       products:
//         result.rows,
//     });


//   } catch (error) {

//     console.error(
//       'Get products error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // UPDATE PRODUCT
// // ==================================================

// const updateProduct = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;

//     const productId =
//       req.params.id;


//     const {
//       productName,
//       category,
//       price,
//       stockQuantity,
//       description,
//       imageUrl,
//       isAvailable,
//     } = req.body;


//     const currentProduct =
//       await pool.query(
//         `
//         SELECT image_url
//         FROM products
//         WHERE
//           id = $1
//           AND shop_id = $2
//         `,
//         [
//           productId,
//           shopId,
//         ]
//       );


//     if (
//       currentProduct.rows.length === 0
//     ) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Product not found',
//       });

//     }


//     let finalImageUrl =
//       currentProduct.rows[0].image_url;


//     if (req.file) {

//       finalImageUrl =
//         `/uploads/products/${req.file.filename}`;

//     }

//     else if (
//       imageUrl !== undefined
//     ) {

//       finalImageUrl =
//         imageUrl || null;

//     }


//     const result =
//       await pool.query(
//         `
//         UPDATE products
//         SET
//           product_name = $1,
//           category = $2,
//           price = $3,
//           stock_quantity = $4,
//           description = $5,
//           image_url = $6,
//           is_available = $7,
//           updated_at = CURRENT_TIMESTAMP
//         WHERE
//           id = $8
//           AND shop_id = $9
//         RETURNING *
//         `,
//         [
//           productName.trim(),
//           category.trim(),
//           Number(price),
//           Number(stockQuantity),
//           description
//             ? description.trim()
//             : null,
//           finalImageUrl,
//           isAvailable !== false,
//           productId,
//           shopId,
//         ]
//       );


//     return res.json({
//       success: true,
//       message:
//         'Product updated successfully',
//       product:
//         result.rows[0],
//     });


//   } catch (error) {

//     console.error(
//       'Update product error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         error.message ||
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // DELETE PRODUCT
// // ==================================================

// const deleteProduct = async (
//   req,
//   res
// ) => {

//   try {

//     const shopId =
//       req.shop.shopId;

//     const productId =
//       req.params.id;


//     const result =
//       await pool.query(
//         `
//         DELETE FROM products
//         WHERE
//           id = $1
//           AND shop_id = $2
//         RETURNING id
//         `,
//         [
//           productId,
//           shopId,
//         ]
//       );


//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({
//         success: false,
//         message:
//           'Product not found',
//       });

//     }


//     return res.json({
//       success: true,
//       message:
//         'Product deleted successfully',
//     });


//   } catch (error) {

//     console.error(
//       'Delete product error:',
//       error
//     );

//     return res.status(500).json({
//       success: false,
//       message:
//         'Server error',
//     });

//   }

// };


// // ==================================================
// // EXPORTS
// // ==================================================

// module.exports = {
//   registerShop,
//   loginShop,
//   getShopProfile,
//   updateShopProfile,
//   addProduct,
//   getProducts,
//   updateProduct,
//   deleteProduct,
// };











// const bcrypt = require('bcryptjs')
// const jwt = require('jsonwebtoken')

// const pool = require('../config/db')


// // ==================================================
// // REGISTER SHOP
// // ==================================================

// const registerShop = async (req, res) => {
//   try {
//     const {
//       shopName,
//       email,
//       mobile,
//       address,
//       password,
//     } = req.body

//     if (!shopName || !email || !password) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Shop name, email and password are required',
//       })
//     }

//     const existingShop = await pool.query(
//       `
//       SELECT id
//       FROM shops
//       WHERE email = $1
//       `,
//       [email.trim().toLowerCase()]
//     )

//     if (existingShop.rows.length > 0) {
//       return res.status(409).json({
//         success: false,
//         message:
//           'Shop with this email already exists',
//       })
//     }

//     const passwordHash = await bcrypt.hash(
//       password,
//       10
//     )

//     const result = await pool.query(
//       `
//       INSERT INTO shops
//       (
//         shop_name,
//         email,
//         mobile,
//         address,
//         password_hash,
//         status
//       )
//       VALUES
//       ($1, $2, $3, $4, $5, 'pending')
//       RETURNING
//         id,
//         shop_name,
//         email,
//         mobile,
//         address,
//         status,
//         image_url,
//         created_at,
//         updated_at
//       `,
//       [
//         shopName.trim(),
//         email.trim().toLowerCase(),
//         mobile ? mobile.trim() : null,
//         address ? address.trim() : null,
//         passwordHash,
//       ]
//     )

//     const shop = result.rows[0]

//     const token = jwt.sign(
//       {
//         shopId: shop.id,
//         email: shop.email,
//       },
//       process.env.JWT_SECRET,
//       {
//         expiresIn: '7d',
//       }
//     )

//     return res.status(201).json({
//       success: true,
//       message: 'Shop registered successfully',
//       token,
//       shop,
//     })
//   } catch (error) {
//     console.error(
//       'Register shop error:',
//       error
//     )

//     return res.status(500).json({
//       success: false,
//       message: 'Server error',
//     })
//   }
// }


// // ==================================================
// // LOGIN SHOP
// // ==================================================

// const loginShop = async (req, res) => {
//   try {
//     const {
//       email,
//       password,
//     } = req.body

//     if (!email || !password) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Email and password are required',
//       })
//     }

//     const result = await pool.query(
//       `
//       SELECT *
//       FROM shops
//       WHERE email = $1
//       `,
//       [
//         email
//           .trim()
//           .toLowerCase(),
//       ]
//     )

//     if (result.rows.length === 0) {
//       return res.status(401).json({
//         success: false,
//         message:
//           'Invalid email or password',
//       })
//     }

//     const shop = result.rows[0]

//     const passwordMatch =
//       await bcrypt.compare(
//         password,
//         shop.password_hash
//       )

//     if (!passwordMatch) {
//       return res.status(401).json({
//         success: false,
//         message:
//           'Invalid email or password',
//       })
//     }

//     const token = jwt.sign(
//       {
//         shopId: shop.id,
//         email: shop.email,
//       },
//       process.env.JWT_SECRET,
//       {
//         expiresIn: '7d',
//       }
//     )

//     return res.json({
//       success: true,
//       message: 'Login successful',
//       token,
//       shop: {
//         id: shop.id,
//         shop_name: shop.shop_name,
//         email: shop.email,
//         mobile: shop.mobile,
//         address: shop.address,
//         status: shop.status,
//         image_url: shop.image_url || null,
//       },
//     })
//   } catch (error) {
//     console.error(
//       'Login shop error:',
//       error
//     )

//     return res.status(500).json({
//       success: false,
//       message: 'Server error',
//     })
//   }
// }


// // ==================================================
// // GET SHOP PROFILE
// // ==================================================

// const getShopProfile = async (
//   req,
//   res
// ) => {
//   try {
//     const shopId =
//       req.shop.shopId

//     const result = await pool.query(
//       `
//       SELECT
//         id,
//         shop_name,
//         email,
//         mobile,
//         address,
//         status,
//         image_url,
//         created_at,
//         updated_at
//       FROM shops
//       WHERE id = $1
//       `,
//       [shopId]
//     )

//     if (result.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shop not found',
//       })
//     }

//     return res.json({
//       success: true,
//       shop: result.rows[0],
//     })
//   } catch (error) {
//     console.error(
//       'Get shop profile error:',
//       error
//     )

//     return res.status(500).json({
//       success: false,
//       message: 'Server error',
//     })
//   }
// }


// // ==================================================
// // UPDATE SHOP PROFILE
// // ==================================================

// const updateShopProfile = async (
//   req,
//   res
// ) => {
//   try {
//     const shopId =
//       req.shop.shopId

//     const {
//       shopName,
//       mobile,
//       address,
//     } = req.body

//     if (
//       !shopName ||
//       !shopName.trim()
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Shop name is required',
//       })
//     }

//     let result

//     // ----------------------------------------------
//     // WITH NEW IMAGE
//     // ----------------------------------------------

//     if (req.file) {
//       const imageUrl =
//         `/uploads/shops/${req.file.filename}`

//       result = await pool.query(
//         `
//         UPDATE shops
//         SET
//           shop_name = $1,
//           mobile = $2,
//           address = $3,
//           image_url = $4,
//           updated_at = CURRENT_TIMESTAMP
//         WHERE id = $5
//         RETURNING
//           id,
//           shop_name,
//           email,
//           mobile,
//           address,
//           status,
//           image_url,
//           created_at,
//           updated_at
//         `,
//         [
//           shopName.trim(),
//           mobile
//             ? mobile.trim()
//             : null,
//           address
//             ? address.trim()
//             : null,
//           imageUrl,
//           shopId,
//         ]
//       )
//     }

//     // ----------------------------------------------
//     // WITHOUT NEW IMAGE
//     // ----------------------------------------------

//     else {
//       result = await pool.query(
//         `
//         UPDATE shops
//         SET
//           shop_name = $1,
//           mobile = $2,
//           address = $3,
//           updated_at = CURRENT_TIMESTAMP
//         WHERE id = $4
//         RETURNING
//           id,
//           shop_name,
//           email,
//           mobile,
//           address,
//           status,
//           image_url,
//           created_at,
//           updated_at
//         `,
//         [
//           shopName.trim(),
//           mobile
//             ? mobile.trim()
//             : null,
//           address
//             ? address.trim()
//             : null,
//           shopId,
//         ]
//       )
//     }

//     if (result.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message: 'Shop not found',
//       })
//     }

//     return res.json({
//       success: true,
//       message:
//         'Shop profile updated successfully',
//       shop: result.rows[0],
//     })
//   } catch (error) {
//     console.error(
//       'Update shop profile error:',
//       error
//     )

//     return res.status(500).json({
//       success: false,
//       message: 'Server error',
//     })
//   }
// }


// // ==================================================
// // ADD PRODUCT
// // ==================================================

// const addProduct = async (
//   req,
//   res
// ) => {
//   try {
//     const shopId =
//       req.shop.shopId

//     const {
//       productName,
//       category,
//       price,
//       stockQuantity,
//       description,
//       isAvailable,
//       imageUrl,
//     } = req.body

//     let finalImageUrl =
//       imageUrl || null

//     if (req.file) {
//       finalImageUrl =
//         `/uploads/products/${req.file.filename}`
//     }

//     if (
//       !productName ||
//       !category ||
//       price === undefined ||
//       stockQuantity === undefined
//     ) {
//       return res.status(400).json({
//         success: false,
//         message:
//           'Product name, category, price and stock quantity are required',
//       })
//     }

//     const result = await pool.query(
//       `
//       INSERT INTO products
//       (
//         shop_id,
//         product_name,
//         category,
//         price,
//         stock_quantity,
//         description,
//         is_available,
//         image_url
//       )
//       VALUES
//       ($1,$2,$3,$4,$5,$6,$7,$8)
//       RETURNING *
//       `,
//       [
//         shopId,
//         productName.trim(),
//         category.trim(),
//         Number(price),
//         Number(stockQuantity),
//         description
//           ? description.trim()
//           : null,
//         isAvailable !== false &&
//           isAvailable !== 'false',
//         finalImageUrl,
//       ]
//     )

//     return res.status(201).json({
//       success: true,
//       message:
//         'Product added successfully',
//       product: result.rows[0],
//     })
//   } catch (error) {
//     console.error(
//       'Add product error:',
//       error
//     )

//     return res.status(500).json({
//       success: false,
//       message: 'Server error',
//     })
//   }
// }


// // ==================================================
// // GET PRODUCTS
// // ==================================================

// const getProducts = async (
//   req,
//   res
// ) => {
//   try {
//     const shopId =
//       req.shop.shopId

//     const result = await pool.query(
//       `
//       SELECT *
//       FROM products
//       WHERE shop_id = $1
//       ORDER BY id DESC
//       `,
//       [shopId]
//     )

//     return res.json({
//       success: true,
//       products: result.rows,
//     })
//   } catch (error) {
//     console.error(
//       'Get products error:',
//       error
//     )

//     return res.status(500).json({
//       success: false,
//       message: 'Server error',
//     })
//   }
// }


// // ==================================================
// // UPDATE PRODUCT
// // ==================================================

// const updateProduct = async (
//   req,
//   res
// ) => {
//   try {
//     const shopId =
//       req.shop.shopId

//     const productId =
//       req.params.id

//     const {
//       productName,
//       category,
//       price,
//       stockQuantity,
//       description,
//       isAvailable,
//       imageUrl,
//     } = req.body

//     const currentProduct =
//       await pool.query(
//         `
//         SELECT image_url
//         FROM products
//         WHERE id = $1
//         AND shop_id = $2
//         `,
//         [
//           productId,
//           shopId,
//         ]
//       )

//     if (
//       currentProduct.rows.length === 0
//     ) {
//       return res.status(404).json({
//         success: false,
//         message:
//           'Product not found',
//       })
//     }

//     let finalImageUrl =
//       currentProduct.rows[0]
//         .image_url

//     if (req.file) {
//       finalImageUrl =
//         `/uploads/products/${req.file.filename}`
//     } else if (
//       imageUrl !== undefined
//     ) {
//       finalImageUrl =
//         imageUrl
//     }

//     const result = await pool.query(
//       `
//       UPDATE products
//       SET
//         product_name = $1,
//         category = $2,
//         price = $3,
//         stock_quantity = $4,
//         description = $5,
//         is_available = $6,
//         image_url = $7,
//         updated_at = CURRENT_TIMESTAMP
//       WHERE
//         id = $8
//         AND shop_id = $9
//       RETURNING *
//       `,
//       [
//         productName.trim(),
//         category.trim(),
//         Number(price),
//         Number(stockQuantity),
//         description
//           ? description.trim()
//           : null,
//         isAvailable === true ||
//           isAvailable === 'true',
//         finalImageUrl,
//         productId,
//         shopId,
//       ]
//     )

//     return res.json({
//       success: true,
//       message:
//         'Product updated successfully',
//       product: result.rows[0],
//     })
//   } catch (error) {
//     console.error(
//       'Update product error:',
//       error
//     )

//     return res.status(500).json({
//       success: false,
//       message: 'Server error',
//     })
//   }
// }


// // ==================================================
// // DELETE PRODUCT
// // ==================================================

// const deleteProduct = async (
//   req,
//   res
// ) => {
//   try {
//     const shopId =
//       req.shop.shopId

//     const productId =
//       req.params.id

//     const result = await pool.query(
//       `
//       DELETE FROM products
//       WHERE
//         id = $1
//         AND shop_id = $2
//       RETURNING *
//       `,
//       [
//         productId,
//         shopId,
//       ]
//     )

//     if (result.rows.length === 0) {
//       return res.status(404).json({
//         success: false,
//         message:
//           'Product not found',
//       })
//     }

//     return res.json({
//       success: true,
//       message:
//         'Product deleted successfully',
//     })
//   } catch (error) {
//     console.error(
//       'Delete product error:',
//       error
//     )

//     return res.status(500).json({
//       success: false,
//       message: 'Server error',
//     })
//   }
// }


// // ==================================================
// // EXPORTS
// // ==================================================

// module.exports = {
//   registerShop,
//   loginShop,
//   getShopProfile,
//   updateShopProfile,
//   addProduct,
//   getProducts,
//   updateProduct,
//   deleteProduct,
// }



const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')

const pool = require('../config/db')


// ==================================================
// REGISTER SHOP
// ==================================================

const registerShop = async (req, res) => {
  try {
    const {
      shopName,
      email,
      mobile,
      address,
      latitude,
      longitude,
      password,
    } = req.body

    if (!shopName || !email || !password) {
      return res.status(400).json({
        success: false,
        message:
          'Shop name, email and password are required',
      })
    }

    const existingShop = await pool.query(
      `
      SELECT id
      FROM shops
      WHERE email = $1
      `,
      [email.trim().toLowerCase()]
    )

    if (existingShop.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message:
          'Shop with this email already exists',
      })
    }

    const passwordHash = await bcrypt.hash(
      password,
      10
    )

    const result = await pool.query(
      `
      INSERT INTO shops
      (
        shop_name,
        email,
        mobile,
        address,
        latitude,
        longitude,
        password_hash,
        status
      )
      VALUES
      ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING
        id,
        shop_name,
        email,
        mobile,
        address,
        latitude,
        longitude,
        status,
        image_url,
        created_at,
        updated_at
      `,
      [
        shopName.trim(),
        email.trim().toLowerCase(),
        mobile ? mobile.trim() : null,
        address ? address.trim() : null,
        latitude !== undefined &&
        latitude !== ''
          ? Number(latitude)
          : null,
        longitude !== undefined &&
        longitude !== ''
          ? Number(longitude)
          : null,
        passwordHash,
      ]
    )

    const shop = result.rows[0]

    const token = jwt.sign(
      {
        shopId: shop.id,
        email: shop.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d',
      }
    )

    return res.status(201).json({
      success: true,
      message: 'Shop registered successfully',
      token,
      shop,
    })
  } catch (error) {
    console.error(
      'Register shop error:',
      error
    )

    return res.status(500).json({
      success: false,
      message: 'Server error',
    })
  }
}


// ==================================================
// LOGIN SHOP
// ==================================================

const loginShop = async (req, res) => {
  try {
    const {
      email,
      password,
    } = req.body

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message:
          'Email and password are required',
      })
    }

    const result = await pool.query(
      `
      SELECT *
      FROM shops
      WHERE email = $1
      `,
      [
        email
          .trim()
          .toLowerCase(),
      ]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        message:
          'Invalid email or password',
      })
    }

    const shop = result.rows[0]

    const passwordMatch =
      await bcrypt.compare(
        password,
        shop.password_hash
      )

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message:
          'Invalid email or password',
      })
    }

    const token = jwt.sign(
      {
        shopId: shop.id,
        email: shop.email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: '7d',
      }
    )

    return res.json({
      success: true,
      message: 'Login successful',
      token,
      shop: {
        id: shop.id,
        shop_name: shop.shop_name,
        email: shop.email,
        mobile: shop.mobile,
        address: shop.address,
        latitude: shop.latitude,
        longitude: shop.longitude,
        status: shop.status,
        image_url: shop.image_url || null,
      },
    })
  } catch (error) {
    console.error(
      'Login shop error:',
      error
    )

    return res.status(500).json({
      success: false,
      message: 'Server error',
    })
  }
}


// ==================================================
// GET SHOP PROFILE
// ==================================================

const getShopProfile = async (
  req,
  res
) => {
  try {
    const shopId =
      req.shop.shopId

    const result = await pool.query(
      `
      SELECT
        id,
        shop_name,
        email,
        mobile,
        address,
        latitude,
        longitude,
        status,
        image_url,
        created_at,
        updated_at
      FROM shops
      WHERE id = $1
      `,
      [shopId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Shop not found',
      })
    }

    return res.json({
      success: true,
      shop: result.rows[0],
    })
  } catch (error) {
    console.error(
      'Get shop profile error:',
      error
    )

    return res.status(500).json({
      success: false,
      message: 'Server error',
    })
  }
}


// ==================================================
// UPDATE SHOP PROFILE
// ==================================================

const updateShopProfile = async (
  req,
  res
) => {
  try {
    const shopId =
      req.shop.shopId

    const {
      shopName,
      mobile,
      address,
      latitude,
      longitude,
    } = req.body

    if (
      !shopName ||
      !shopName.trim()
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Shop name is required',
      })
    }

    const parsedLatitude =
      latitude !== undefined &&
      latitude !== ''
        ? Number(latitude)
        : null

    const parsedLongitude =
      longitude !== undefined &&
      longitude !== ''
        ? Number(longitude)
        : null

    let result

    // ----------------------------------------------
    // WITH NEW IMAGE
    // ----------------------------------------------

    if (req.file) {
      const imageUrl =
        `/uploads/shops/${req.file.filename}`

      result = await pool.query(
        `
        UPDATE shops
        SET
          shop_name = $1,
          mobile = $2,
          address = $3,
          latitude = $4,
          longitude = $5,
          image_url = $6,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $7
        RETURNING
          id,
          shop_name,
          email,
          mobile,
          address,
          latitude,
          longitude,
          status,
          image_url,
          created_at,
          updated_at
        `,
        [
          shopName.trim(),
          mobile
            ? mobile.trim()
            : null,
          address
            ? address.trim()
            : null,
          parsedLatitude,
          parsedLongitude,
          imageUrl,
          shopId,
        ]
      )
    }

    // ----------------------------------------------
    // WITHOUT NEW IMAGE
    // ----------------------------------------------

    else {
      result = await pool.query(
        `
        UPDATE shops
        SET
          shop_name = $1,
          mobile = $2,
          address = $3,
          latitude = $4,
          longitude = $5,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $6
        RETURNING
          id,
          shop_name,
          email,
          mobile,
          address,
          latitude,
          longitude,
          status,
          image_url,
          created_at,
          updated_at
        `,
        [
          shopName.trim(),
          mobile
            ? mobile.trim()
            : null,
          address
            ? address.trim()
            : null,
          parsedLatitude,
          parsedLongitude,
          shopId,
        ]
      )
    }

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Shop not found',
      })
    }

    return res.json({
      success: true,
      message:
        'Shop profile updated successfully',
      shop: result.rows[0],
    })
  } catch (error) {
    console.error(
      'Update shop profile error:',
      error
    )

    return res.status(500).json({
      success: false,
      message: 'Server error',
    })
  }
}


// ==================================================
// ADD PRODUCT
// ==================================================

const addProduct = async (
  req,
  res
) => {
  try {
    const shopId =
      req.shop.shopId

    const {
      productName,
      category,
      price,
      stockQuantity,
      description,
      isAvailable,
      imageUrl,
    } = req.body

    let finalImageUrl =
      imageUrl || null

    if (req.file) {
      finalImageUrl =
        `/uploads/products/${req.file.filename}`
    }

    if (
      !productName ||
      !category ||
      price === undefined ||
      stockQuantity === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Product name, category, price and stock quantity are required',
      })
    }

    const result = await pool.query(
      `
      INSERT INTO products
      (
        shop_id,
        product_name,
        category,
        price,
        stock_quantity,
        description,
        is_available,
        image_url
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        shopId,
        productName.trim(),
        category.trim(),
        Number(price),
        Number(stockQuantity),
        description
          ? description.trim()
          : null,
        isAvailable !== false &&
          isAvailable !== 'false',
        finalImageUrl,
      ]
    )

    return res.status(201).json({
      success: true,
      message:
        'Product added successfully',
      product: result.rows[0],
    })
  } catch (error) {
    console.error(
      'Add product error:',
      error
    )

    return res.status(500).json({
      success: false,
      message: 'Server error',
    })
  }
}


// ==================================================
// GET PRODUCTS
// ==================================================

const getProducts = async (
  req,
  res
) => {
  try {
    const shopId =
      req.shop.shopId

    const result = await pool.query(
      `
      SELECT *
      FROM products
      WHERE shop_id = $1
      ORDER BY id DESC
      `,
      [shopId]
    )

    return res.json({
      success: true,
      products: result.rows,
    })
  } catch (error) {
    console.error(
      'Get products error:',
      error
    )

    return res.status(500).json({
      success: false,
      message: 'Server error',
    })
  }
}


// ==================================================
// UPDATE PRODUCT
// ==================================================

const updateProduct = async (
  req,
  res
) => {
  try {
    const shopId =
      req.shop.shopId

    const productId =
      req.params.id

    const {
      productName,
      category,
      price,
      stockQuantity,
      description,
      isAvailable,
      imageUrl,
    } = req.body

    const currentProduct =
      await pool.query(
        `
        SELECT image_url
        FROM products
        WHERE id = $1
        AND shop_id = $2
        `,
        [
          productId,
          shopId,
        ]
      )

    if (
      currentProduct.rows.length === 0
    ) {
      return res.status(404).json({
        success: false,
        message:
          'Product not found',
      })
    }

    let finalImageUrl =
      currentProduct.rows[0]
        .image_url

    if (req.file) {
      finalImageUrl =
        `/uploads/products/${req.file.filename}`
    } else if (
      imageUrl !== undefined
    ) {
      finalImageUrl =
        imageUrl
    }

    const result = await pool.query(
      `
      UPDATE products
      SET
        product_name = $1,
        category = $2,
        price = $3,
        stock_quantity = $4,
        description = $5,
        is_available = $6,
        image_url = $7,
        updated_at = CURRENT_TIMESTAMP
      WHERE
        id = $8
        AND shop_id = $9
      RETURNING *
      `,
      [
        productName.trim(),
        category.trim(),
        Number(price),
        Number(stockQuantity),
        description
          ? description.trim()
          : null,
        isAvailable === true ||
          isAvailable === 'true',
        finalImageUrl,
        productId,
        shopId,
      ]
    )

    return res.json({
      success: true,
      message:
        'Product updated successfully',
      product: result.rows[0],
    })
  } catch (error) {
    console.error(
      'Update product error:',
      error
    )

    return res.status(500).json({
      success: false,
      message: 'Server error',
    })
  }
}


// ==================================================
// DELETE PRODUCT
// ==================================================

const deleteProduct = async (
  req,
  res
) => {
  try {
    const shopId =
      req.shop.shopId

    const productId =
      req.params.id

    const result = await pool.query(
      `
      DELETE FROM products
      WHERE
        id = $1
        AND shop_id = $2
      RETURNING *
      `,
      [
        productId,
        shopId,
      ]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          'Product not found',
      })
    }

    return res.json({
      success: true,
      message:
        'Product deleted successfully',
    })
  } catch (error) {
    console.error(
      'Delete product error:',
      error
    )

    return res.status(500).json({
      success: false,
      message: 'Server error',
    })
  }
}


// ==================================================
// EXPORTS
// ==================================================

module.exports = {
  registerShop,
  loginShop,
  getShopProfile,
  updateShopProfile,
  addProduct,
  getProducts,
  updateProduct,
  deleteProduct,
}