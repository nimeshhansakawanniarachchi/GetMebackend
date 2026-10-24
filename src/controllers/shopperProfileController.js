const fs = require('fs');
const path = require('path');
const multer = require('multer');

const db = require('../config/db');

const { VEHICLE_TYPES } = require('../utils/vehicleTypes');

// =====================================================
// PROFILE PHOTO STORAGE
// src/uploads/shoppers, served at /uploads/shoppers (app.js)
// =====================================================

const photoDir = path.join(__dirname, '..', 'uploads', 'shoppers');

if (!fs.existsSync(photoDir)) {
  fs.mkdirSync(photoDir, { recursive: true });
}

const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, photoDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();

      cb(
        null,
        `shopper-${req.shopper?.shopperId}-${Date.now()}${
          PHOTO_EXTENSIONS.includes(ext) ? ext : '.jpg'
        }`
      );
    },
  }),
  fileFilter: (req, file, cb) => {
    if (String(file.mimetype || '').toLowerCase().startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  },
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

// The old photo file once it's replaced or removed (never throws)
const deletePhotoFile = (url) => {
  try {
    if (!url || !String(url).startsWith('/uploads/shoppers/')) {
      return;
    }

    fs.unlink(path.join(photoDir, path.basename(url)), () => {});
  } catch {
    // A leftover file is harmless
  }
};

const getShopperId = (req) =>
  req.shopper?.shopperId ||
  req.shopper?.id ||
  null;

const loadProfile = async (shopperId) => {
  const result = await db.query(
    `
    SELECT
      s.id,
      s.full_name,
      s.mobile,
      s.email,
      s.status,
      s.approval_status,
      s.vehicle_type,
      s.vehicle_number,
      s.profile_image_url,
      s.created_at,
      (
        SELECT COUNT(*)::int
        FROM orders o
        WHERE o.shopper_id = s.id
          AND o.status = 'delivered'
      ) AS deliveries
    FROM shoppers s
    WHERE s.id = $1
    LIMIT 1
    `,
    [shopperId]
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    fullName: row.full_name,
    mobile: row.mobile,
    email: row.email,
    status: row.status,
    approvalStatus: row.approval_status,
    vehicleType: row.vehicle_type,
    vehicleNumber: row.vehicle_number,
    profileImageUrl: row.profile_image_url,
    createdAt: row.created_at,
    deliveries: row.deliveries,
  };
};

// =====================================================
// GET PROFILE
// GET /api/shopper/me
// =====================================================

const getProfile = async (req, res) => {
  try {
    const profile = await loadProfile(getShopperId(req));

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: 'Shopper not found',
      });
    }

    return res.json({ success: true, shopper: profile });
  } catch (error) {
    console.error('❌ getProfile error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to load profile',
    });
  }
};

// =====================================================
// UPDATE PROFILE
// PUT /api/shopper/me
// =====================================================

const updateProfile = async (req, res) => {
  try {
    const shopperId = getShopperId(req);

    const fullName = String(req.body?.fullName || '').trim();

    const vehicleType = req.body?.vehicleType
      ? String(req.body.vehicleType).trim().toLowerCase()
      : null;

    const vehicleNumber = req.body?.vehicleNumber
      ? String(req.body.vehicleNumber).trim().toUpperCase()
      : null;

    if (fullName.length < 2 || fullName.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Enter your full name',
      });
    }

    if (vehicleType && !VEHICLE_TYPES.includes(vehicleType)) {
      return res.status(400).json({
        success: false,
        message: 'Choose a valid vehicle type',
      });
    }

    if (vehicleNumber && !/^[A-Z0-9 -]{2,20}$/.test(vehicleNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid vehicle number (letters, numbers, - and spaces)',
      });
    }

    await db.query(
      `
      UPDATE shoppers
      SET
        full_name = $1,
        vehicle_type = $2,
        vehicle_number = $3,
        updated_at = NOW()
      WHERE id = $4
      `,
      [fullName, vehicleType, vehicleNumber, shopperId]
    );

    const profile = await loadProfile(shopperId);

    return res.json({ success: true, shopper: profile });
  } catch (error) {
    console.error('❌ updateProfile error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to update profile',
    });
  }
};

// =====================================================
// PROFILE PHOTO
// POST   /api/shopper/me/photo   photo -> image file
// DELETE /api/shopper/me/photo
// Customers see it on the live map and the shopper card.
// =====================================================

// multer, with its errors as JSON (not the default HTML page)
const receivePhoto = (req, res, next) =>
  photoUpload.single('photo')(req, res, (error) => {
    if (!error) {
      return next();
    }

    return res.status(400).json({
      success: false,
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Photo is too large. Maximum size is 8MB.'
          : error.message || 'Photo upload failed',
    });
  });

// Saves the new photo URL (null = none); returns the one it replaced
const savePhotoUrl = async (shopperId, url) => {
  const previous = await db.query(
    'SELECT profile_image_url FROM shoppers WHERE id = $1',
    [shopperId]
  );

  await db.query(
    `
    UPDATE shoppers
    SET profile_image_url = $1, updated_at = NOW()
    WHERE id = $2
    `,
    [url, shopperId]
  );

  return previous.rows[0]?.profile_image_url || null;
};

const uploadProfilePhoto = async (req, res) => {
  try {
    const shopperId = getShopperId(req);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Choose a photo',
      });
    }

    const previousUrl = await savePhotoUrl(
      shopperId,
      `/uploads/shoppers/${req.file.filename}`
    );

    deletePhotoFile(previousUrl);

    const profile = await loadProfile(shopperId);

    return res.json({ success: true, shopper: profile });
  } catch (error) {
    console.error('❌ uploadProfilePhoto error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to save your photo',
    });
  }
};

const removeProfilePhoto = async (req, res) => {
  try {
    const shopperId = getShopperId(req);

    deletePhotoFile(await savePhotoUrl(shopperId, null));

    const profile = await loadProfile(shopperId);

    return res.json({ success: true, shopper: profile });
  } catch (error) {
    console.error('❌ removeProfilePhoto error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to remove your photo',
    });
  }
};

module.exports = {
  VEHICLE_TYPES,
  getProfile,
  updateProfile,
  receivePhoto,
  uploadProfilePhoto,
  removeProfilePhoto,
};
