const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const pool = require('../../config/db');

const { toShop } = require('./shopFormat');

const { emitToAdmins } = require('../../realtime');

const { normalizeSriLankanPhone } = require('../../utils/phone');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const signShopToken = (shop) =>
  jwt.sign(
    { shopId: shop.id, email: shop.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

const parseCoordinate = (value, max) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) && Math.abs(number) <= max
    ? number
    : undefined;
};

const clean = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;


// =====================================================
// REGISTER SHOP
// POST /api/shop/register
// New shops start as 'pending' and are hidden from customers
// until a GetMe admin approves them.
// =====================================================

const registerShop = async (req, res) => {
  try {
    const shopName = clean(req.body?.shopName);
    const email = clean(req.body?.email)?.toLowerCase();
    const mobile = normalizeSriLankanPhone(req.body?.mobile);
    const address = clean(req.body?.address);
    const password = String(req.body?.password || '');
    const latitude = parseCoordinate(req.body?.latitude, 90);
    const longitude = parseCoordinate(req.body?.longitude, 180);

    if (!shopName || shopName.length < 2) {
      return res.status(400).json({ success: false, message: 'Enter your shop name' });
    }

    if (!email || !EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }

    if (!mobile) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid Sri Lankan phone number (e.g. 077 123 4567 or 034 226 1511)',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: 'Invalid shop location' });
    }

    const existing = await pool.query(
      'SELECT id FROM shops WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'A shop with this email already exists',
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO shops
        (shop_name, email, mobile, address, latitude, longitude, password_hash, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      RETURNING *
      `,
      [shopName, email, mobile, address, latitude, longitude, passwordHash]
    );

    const shop = result.rows[0];

    emitToAdmins(req.app.get('io'), 'admin:shops-updated', {
      shopId: shop.id,
      reason: 'registered',
    });

    return res.status(201).json({
      success: true,
      message: 'Application received. GetMe will review your shop shortly.',
      token: signShopToken(shop),
      shop: toShop(shop),
    });
  } catch (error) {
    console.error('❌ registerShop error:', error.message);

    return res.status(500).json({ success: false, message: 'Registration failed' });
  }
};


// =====================================================
// LOGIN SHOP
// POST /api/shop/login
// =====================================================

const loginShop = async (req, res) => {
  try {
    const email = clean(req.body?.email)?.toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    const result = await pool.query(
      'SELECT * FROM shops WHERE email = $1',
      [email]
    );

    const shop = result.rows[0];

    const passwordMatch =
      shop && (await bcrypt.compare(password, shop.password_hash));

    if (!passwordMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    if (shop.status === 'rejected' || shop.status === 'suspended') {
      return res.status(403).json({
        success: false,
        message:
          shop.status === 'rejected'
            ? 'Your shop application was not approved.'
            : 'Your shop is suspended. Please contact GetMe support.',
      });
    }

    return res.json({
      success: true,
      token: signShopToken(shop),
      shop: toShop(shop),
    });
  } catch (error) {
    console.error('❌ loginShop error:', error.message);

    return res.status(500).json({ success: false, message: 'Login failed' });
  }
};


// =====================================================
// GET PROFILE
// GET /api/shop/me
// =====================================================

const getShopProfile = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM shops WHERE id = $1',
      [req.shop.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    return res.json({ success: true, shop: toShop(result.rows[0]) });
  } catch (error) {
    console.error('❌ getShopProfile error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load profile' });
  }
};


// =====================================================
// UPDATE PROFILE
// PUT /api/shop/profile (multipart, optional `image`)
// =====================================================

const updateShopProfile = async (req, res) => {
  try {
    const shopName = clean(req.body?.shopName);
    const mobile = req.body?.mobile ? normalizeSriLankanPhone(req.body.mobile) : null;
    const address = clean(req.body?.address);
    const latitude = parseCoordinate(req.body?.latitude, 90);
    const longitude = parseCoordinate(req.body?.longitude, 180);

    if (!shopName || shopName.length < 2) {
      return res.status(400).json({ success: false, message: 'Shop name is required' });
    }

    if (req.body?.mobile && !mobile) {
      return res.status(400).json({ success: false, message: 'Enter a valid Sri Lankan phone number' });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: 'Invalid shop location' });
    }

    const imageUrl = req.file
      ? `/uploads/shops/${req.file.filename}`
      : null;

    const result = await pool.query(
      `
      UPDATE shops
      SET
        shop_name = $1,
        mobile = $2,
        address = $3,
        latitude = $4,
        longitude = $5,
        image_url = COALESCE($6, image_url),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
      `,
      [shopName, mobile, address, latitude, longitude, imageUrl, req.shop.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    return res.json({
      success: true,
      message: 'Profile updated',
      shop: toShop(result.rows[0]),
    });
  } catch (error) {
    console.error('❌ updateShopProfile error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update profile' });
  }
};


// =====================================================
// OPEN / CLOSED
// PATCH /api/shop/open { isOpen: boolean }
// Closed shops don't appear to customers or take new orders.
// =====================================================

const setShopOpen = async (req, res) => {
  try {
    if (typeof req.body?.isOpen !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isOpen must be true or false' });
    }

    const result = await pool.query(
      `
      UPDATE shops
      SET is_open = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [req.body.isOpen, req.shop.shopId]
    );

    emitToAdmins(req.app.get('io'), 'admin:shops-updated', {
      shopId: req.shop.shopId,
      reason: 'open-changed',
    });

    return res.json({ success: true, shop: toShop(result.rows[0]) });
  } catch (error) {
    console.error('❌ setShopOpen error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update shop' });
  }
};

module.exports = {
  registerShop,
  loginShop,
  getShopProfile,
  updateShopProfile,
  setShopOpen,
};
