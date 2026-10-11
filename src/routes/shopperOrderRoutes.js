
const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// =====================================================
// CONTROLLERS
// =====================================================

const {
  getAvailableOrders,
  getMyOrders,
  getMyOrderById,
  getNearbyShoppersForOrder,

  acceptOrder,
  startShopping,
  startDelivery,
  confirmArrival,
  verifyDeliveryPin,

  uploadItemPhoto,
  uploadReplacementPhoto,
  updateItemShoppingStatus,

  updateOrderPayment,
  uploadBill: uploadBillController,
} = require('../controllers/shopperOrderController');

// =====================================================
// AUTH MIDDLEWARE
// =====================================================

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authorization header is required',
      });
    }

    const parts = authHeader.split(' ');

    if (
      parts.length !== 2 ||
      parts[0] !== 'Bearer' ||
      !parts[1]
    ) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authorization format',
      });
    }

    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not configured');

      return res.status(500).json({
        success: false,
        message: 'Authentication configuration error',
      });
    }

    const decoded = jwt.verify(
      parts[1],
      process.env.JWT_SECRET
    );

    if (
      !decoded ||
      !decoded.shopperId
    ) {
      return res.status(401).json({
        success: false,
        message: 'Invalid shopper token',
      });
    }

    req.shopper = decoded;

    next();
  } catch (error) {
    console.error(
      'Shopper auth error:',
      error.message
    );

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }
};

// =====================================================
// UPLOAD DIRECTORIES
// =====================================================

const itemUploadDir = path.join(
  __dirname,
  '..',
  'uploads',
  'items'
);

const replacementUploadDir = path.join(
  __dirname,
  '..',
  'uploads',
  'replacements'
);

const billUploadDir = path.join(
  __dirname,
  '..',
  'uploads',
  'bills'
);

// =====================================================
// CREATE DIRECTORIES
// =====================================================

[
  itemUploadDir,
  replacementUploadDir,
  billUploadDir,
].forEach((directory) => {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {
      recursive: true,
    });
  }
});

// =====================================================
// IMAGE FILTER
// =====================================================

const imageFilter = (req, file, cb) => {
  if (
    file &&
    file.mimetype &&
    file.mimetype.startsWith('image/')
  ) {
    return cb(null, true);
  }

  return cb(
    new Error('Only image files are allowed')
  );
};

// =====================================================
// SAFE FILE EXTENSION
// =====================================================

const getSafeExtension = (file) => {
  const ext = path.extname(
    file.originalname || ''
  ).toLowerCase();

  const allowedExtensions = [
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
    '.heic',
    '.heif',
  ];

  if (allowedExtensions.includes(ext)) {
    return ext;
  }

  return '.jpg';
};

// =====================================================
// ITEM PHOTO STORAGE
// =====================================================

const itemStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, itemUploadDir);
  },

  filename: (req, file, cb) => {
    const ext = getSafeExtension(file);

    cb(
      null,
      `order-${req.params.orderId}-item-${req.params.itemId}-${Date.now()}${ext}`
    );
  },
});

// =====================================================
// REPLACEMENT PHOTO STORAGE
// =====================================================

const replacementStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, replacementUploadDir);
  },

  filename: (req, file, cb) => {
    const ext = getSafeExtension(file);

    cb(
      null,
      `order-${req.params.orderId}-replacement-${req.params.itemId}-${Date.now()}${ext}`
    );
  },
});

// =====================================================
// BILL PHOTO STORAGE
// =====================================================

const billStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, billUploadDir);
  },

  filename: (req, file, cb) => {
    const ext = getSafeExtension(file);

    cb(
      null,
      `order-${req.params.orderId}-bill-${Date.now()}${ext}`
    );
  },
});

// =====================================================
// MULTER CONFIGURATION
// =====================================================

const createImageUpload = (storage) => {
  return multer({
    storage,
    fileFilter: imageFilter,
    limits: {
      fileSize: 8 * 1024 * 1024,
      files: 1,
    },
  });
};

const uploadItem = createImageUpload(itemStorage);

const uploadReplacement = createImageUpload(
  replacementStorage
);

const uploadBillFile = createImageUpload(
  billStorage
);

// =====================================================
// AVAILABLE ORDERS
// GET /api/shopper/orders
// =====================================================

router.get(
  '/orders',
  authMiddleware,
  getAvailableOrders
);

// =====================================================
// MY ORDERS
// GET /api/shopper/orders/my
// =====================================================

router.get(
  '/orders/my',
  authMiddleware,
  getMyOrders
);

// =====================================================
// GET MY ORDER BY ID
// GET /api/shopper/orders/:orderId
// =====================================================

router.get(
  '/orders/:orderId',
  authMiddleware,
  getMyOrderById
);

// =====================================================
// ACCEPT ORDER
// PATCH /api/shopper/orders/:orderId/accept
// =====================================================

router.patch(
  '/orders/:orderId/accept',
  authMiddleware,
  acceptOrder
);

// =====================================================
// START SHOPPING
// PATCH /api/shopper/orders/:orderId/start-shopping
// =====================================================

router.patch(
  '/orders/:orderId/start-shopping',
  authMiddleware,
  startShopping
);

// =====================================================
// START DELIVERY
// PATCH /api/shopper/orders/:orderId/start-delivery
// =====================================================

router.patch(
  '/orders/:orderId/start-delivery',
  authMiddleware,
  startDelivery
);

// =====================================================
// CONFIRM CUSTOMER ARRIVAL
// POST /api/shopper/orders/:orderId/confirm-arrival
// =====================================================

router.post(
  '/orders/:orderId/confirm-arrival',
  authMiddleware,
  confirmArrival
);

// =====================================================
// VERIFY CUSTOMER DELIVERY PIN
// POST /api/shopper/orders/:orderId/verify-delivery-pin
// =====================================================

router.post(
  '/orders/:orderId/verify-delivery-pin',
  authMiddleware,
  verifyDeliveryPin
);

// =====================================================
// NEARBY SHOPPERS
// GET /api/shopper/orders/:orderId/nearby-shoppers
// =====================================================

router.get(
  '/orders/:orderId/nearby-shoppers',
  authMiddleware,
  getNearbyShoppersForOrder
);

// =====================================================
// UPDATE ITEM SHOPPING STATUS
// PATCH /api/shopper/orders/:orderId/items/:itemId/status
// =====================================================

router.patch(
  '/orders/:orderId/items/:itemId/status',
  authMiddleware,
  updateItemShoppingStatus
);

// =====================================================
// UPLOAD ITEM PHOTO
// POST /api/shopper/orders/:orderId/items/:itemId/photo
// FormData field: photo
// =====================================================

router.post(
  '/orders/:orderId/items/:itemId/photo',
  authMiddleware,
  uploadItem.single('photo'),
  uploadItemPhoto
);

// =====================================================
// UPLOAD REPLACEMENT PHOTO
// POST /api/shopper/orders/:orderId/items/:itemId/replacement-photo
// FormData field: photo
// =====================================================

router.post(
  '/orders/:orderId/items/:itemId/replacement-photo',
  authMiddleware,
  uploadReplacement.single('photo'),
  uploadReplacementPhoto
);

// =====================================================
// UPDATE PAYMENT
// PATCH /api/shopper/orders/:orderId/payment
// =====================================================

router.patch(
  '/orders/:orderId/payment',
  authMiddleware,
  updateOrderPayment
);

// =====================================================
// UPLOAD SUPERMARKET BILL
// POST /api/shopper/orders/:orderId/bill
// FormData fields:
//   bill    -> image file
//   shop_id -> actual shops.id
// =====================================================

router.post(
  '/orders/:orderId/bill',
  authMiddleware,
  uploadBillFile.single('bill'),
  uploadBillController
);

// =====================================================
// MULTER AND UPLOAD ERROR HANDLER
// =====================================================

router.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof multer.MulterError) {
    console.error('Multer error:', error);

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message:
          'Image file is too large. Maximum size is 8MB.',
      });
    }

    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Only one image can be uploaded at a time.',
      });
    }

    return res.status(400).json({
      success: false,
      message: error.message || 'File upload failed',
    });
  }

  if (
    error &&
    error.message === 'Only image files are allowed'
  ) {
    return res.status(400).json({
      success: false,
      message: 'Only image files are allowed',
    });
  }

  return next(error);
});

// =====================================================
// EXPORT
// =====================================================

module.exports = router;
