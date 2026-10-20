const db = require('../config/db');

const { VEHICLE_TYPES } = require('../utils/vehicleTypes');

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

module.exports = {
  VEHICLE_TYPES,
  getProfile,
  updateProfile,
};
