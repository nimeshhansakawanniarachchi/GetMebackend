
const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const itemRequests = require('../controllers/orderItemRequestsController');
const storePayments = require('../controllers/storePaymentController');

const router = express.Router();

// =====================================================
// NO DELIVERY PIN FOR SHOPPERS
// The PIN proves the customer was there: only the customer app
// may see it. Orders here are often SELECT o.* (delivery_pin) and
// confirm-arrival used to return it, so strip it from every reply.
// =====================================================

const PIN_KEYS = ['delivery_pin', 'deliveryPin'];

const withoutPins = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 8) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => withoutPins(item, depth + 1));
  }

  if (value instanceof Date) {
    return value;
  }

  const copy = {};

  for (const [key, item] of Object.entries(value)) {
    if (!PIN_KEYS.includes(key)) {
      copy[key] = withoutPins(item, depth + 1);
    }
  }

  return copy;
};

router.use((req, res, next) => {
  const json = res.json.bind(res);

  res.json = (body) => json(withoutPins(body));

  next();
});

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
  verifyItemBarcode,

  updateOrderPayment,
  uploadBill: uploadBillController,
} = require('../controllers/shopperOrderController');

const {
  uploadDeliveryPhoto,
} = require('../controllers/shopperDeliveryPhotoController');

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

// Photo of the order at the door (served at /uploads/deliveries)
const deliveryPhotoDir = path.join(
  __dirname,
  '..',
  'uploads',
  'deliveries'
);

// =====================================================
// CREATE DIRECTORIES
// =====================================================

[
  itemUploadDir,
  replacementUploadDir,
  billUploadDir,
  deliveryPhotoDir,
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

// One image per upload, except a bill: a long receipt is taken in
// up to BILL_MAX_PHOTOS parts
const BILL_MAX_PHOTOS = 5;

const createImageUpload = (storage, maxFiles = 1) => {
  return multer({
    storage,
    fileFilter: imageFilter,
    limits: {
      fileSize: 8 * 1024 * 1024,
      files: maxFiles,
    },
  });
};

const uploadItem = createImageUpload(itemStorage);

const uploadReplacement = createImageUpload(
  replacementStorage
);

const uploadBillFile = createImageUpload(
  billStorage,
  BILL_MAX_PHOTOS
);

const uploadDeliveryPhotoFile = createImageUpload(
  multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, deliveryPhotoDir);
    },

    filename: (req, file, cb) => {
      cb(
        null,
        `order-${req.params.orderId}-delivery-${Date.now()}${getSafeExtension(file)}`
      );
    },
  })
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
// VERIFY SCANNED BARCODE (read-only)
// POST /api/shopper/orders/:orderId/items/:itemId/verify-barcode
// =====================================================

router.post(
  '/orders/:orderId/items/:itemId/verify-barcode',
  authMiddleware,
  verifyItemBarcode
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
  // Up to 5 photos of one receipt (long receipts in parts)
  uploadBillFile.array('bill', BILL_MAX_PHOTOS),
  uploadBillController
);

// =====================================================
// DELIVERY PHOTO (the order at the door)
// POST /api/shopper/orders/:orderId/delivery-photo
//   photo -> image file
// =====================================================

router.post(
  '/orders/:orderId/delivery-photo',
  authMiddleware,
  uploadDeliveryPhotoFile.single('photo'),
  uploadDeliveryPhoto
);

// =====================================================
// EXTRA ITEMS WHILE SHOPPING
// The customer's requests (accept / reject) and items the shopper
// adds for the customer to approve
// =====================================================

router.get('/orders/:orderId/item-requests', authMiddleware, itemRequests.shopperListRequests);
router.post('/orders/:orderId/item-requests', authMiddleware, itemRequests.shopperProposeItem);
router.post('/orders/:orderId/item-requests/:requestId/accept', authMiddleware, itemRequests.shopperAcceptRequest);
router.post('/orders/:orderId/item-requests/:requestId/reject', authMiddleware, itemRequests.shopperRejectRequest);
router.post('/orders/:orderId/item-requests/:requestId/cancel', authMiddleware, itemRequests.shopperCancelRequest);

// =====================================================
// STORE PAYMENT (shopper paid the till; GetMe reimburses)
// One record per order + shop, recorded before the bill photo
// =====================================================

router.get('/orders/:orderId/store-payment', authMiddleware, storePayments.getStorePayment);
router.put('/orders/:orderId/store-payment', authMiddleware, storePayments.saveStorePayment);

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
        message: req.path.endsWith('/bill')
          ? `A receipt can have at most ${BILL_MAX_PHOTOS} photos.`
          : 'Only one image can be uploaded at a time.',
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
