
const express = require('express')
const multer = require('multer')
const path = require('path')

const {
  registerShop,
  loginShop,
  getShopProfile,
  updateShopProfile,
  addProduct,
  getProducts,
  updateProduct,
  deleteProduct,
} = require('../controllers/shopController')

const shopAuthMiddleware =
  require('../middleware/shopAuthMiddleware')

const router = express.Router()


// ==================================================
// PRODUCT IMAGE STORAGE
// ==================================================

const productStorage =
  multer.diskStorage({
    destination: (
      req,
      file,
      cb
    ) => {
      cb(
        null,
        'uploads/products'
      )
    },

    filename: (
      req,
      file,
      cb
    ) => {
      const extension =
        path.extname(
          file.originalname
        )

      const uniqueName =
        `product-${Date.now()}-${Math.round(
          Math.random() * 1e9
        )}${extension}`

      cb(
        null,
        uniqueName
      )
    },
  })


// ==================================================
// SHOP IMAGE STORAGE
// ==================================================

const shopStorage =
  multer.diskStorage({
    destination: (
      req,
      file,
      cb
    ) => {
      cb(
        null,
        'uploads/shops'
      )
    },

    filename: (
      req,
      file,
      cb
    ) => {
      const extension =
        path.extname(
          file.originalname
        )

      const uniqueName =
        `shop-${Date.now()}-${Math.round(
          Math.random() * 1e9
        )}${extension}`

      cb(
        null,
        uniqueName
      )
    },
  })


// ==================================================
// IMAGE FILTER
// ==================================================

const fileFilter = (
  req,
  file,
  cb
) => {
  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
  ]

  if (
    allowedTypes.includes(
      file.mimetype
    )
  ) {
    cb(
      null,
      true
    )
  } else {
    cb(
      new Error(
        'Only JPG, PNG and WEBP images are allowed'
      )
    )
  }
}


// ==================================================
// UPLOADERS
// ==================================================

const uploadProduct =
  multer({
    storage:
      productStorage,

    fileFilter,

    limits: {
      fileSize:
        5 * 1024 * 1024,
    },
  })

const uploadShop =
  multer({
    storage:
      shopStorage,

    fileFilter,

    limits: {
      fileSize:
        5 * 1024 * 1024,
    },
  })


// ==================================================
// SHOP AUTH
// ==================================================

router.post(
  '/register',
  registerShop
)

router.post(
  '/login',
  loginShop
)


// ==================================================
// SHOP PROFILE
// ==================================================

router.get(
  '/me',
  shopAuthMiddleware,
  getShopProfile
)

router.put(
  '/profile',
  shopAuthMiddleware,
  uploadShop.single('image'),
  updateShopProfile
)


// ==================================================
// PRODUCTS
// ==================================================

router.post(
  '/products',
  shopAuthMiddleware,
  uploadProduct.single('image'),
  addProduct
)

router.get(
  '/products',
  shopAuthMiddleware,
  getProducts
)

router.put(
  '/products/:id',
  shopAuthMiddleware,
  uploadProduct.single('image'),
  updateProduct
)

router.delete(
  '/products/:id',
  shopAuthMiddleware,
  deleteProduct
)


module.exports = router