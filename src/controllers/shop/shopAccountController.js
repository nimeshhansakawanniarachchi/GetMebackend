const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const pool = require('../../config/db');

const { toShop } = require('./shopFormat');

const { emitToAdmins } = require('../../realtime');

const { permissionsFor, recordShopActivity, ROLE_LABELS } = require('../../middleware/shopAccess');

const { nextChange } = require('../../utils/shopHours');

const { normalizeSriLankanPhone } = require('../../utils/phone');

const {
  MIN_WHITE_CONTRAST,
  normalizeBrandColor,
  whiteContrast,
} = require('../../utils/brandColor');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const signShopToken = (shop) =>
  jwt.sign(
    { shopId: shop.id, email: shop.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

// Staff log in on the same page; their token carries staffId
const signStaffToken = (staff) =>
  jwt.sign(
    { shopId: staff.shop_id, staffId: staff.id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

// Who is signed in (owner = the shop's own login)
const userOf = (req) => ({
  type: req.shop?.staffId ? 'staff' : 'owner',
  id: req.shop?.staffId || null,
  name: req.shop?.actorName || 'Owner',
  role: req.shop?.role || 'owner',
  roleLabel: ROLE_LABELS[req.shop?.role || 'owner'],
});

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

    // Not a shop's own login: maybe a staff account (phase 27)
    if (!shop) {
      const staff = (
        await pool.query(
          `
          SELECT st.*, s.status AS shop_status
          FROM shop_staff st JOIN shops s ON s.id = st.shop_id
          WHERE LOWER(st.email) = $1
          `,
          [email]
        )
      ).rows[0];

      const staffMatch = staff && (await bcrypt.compare(password, staff.password_hash));

      if (!staffMatch || !staff.is_active) {
        return res.status(401).json({ success: false, message: 'Invalid email or password' });
      }

      if (staff.shop_status === 'rejected' || staff.shop_status === 'suspended') {
        return res.status(403).json({
          success: false,
          message: staff.shop_status === 'rejected'
            ? 'This shop\'s application was not approved.'
            : 'This shop is suspended. Please contact GetMe support.',
        });
      }

      await pool.query('UPDATE shop_staff SET last_login_at = NOW() WHERE id = $1', [staff.id]);
      const staffShop = (await pool.query('SELECT * FROM shops WHERE id = $1', [staff.shop_id])).rows[0];

      recordShopActivity({
        shopId: staff.shop_id,
        actor: { type: 'staff', id: staff.id, name: staff.full_name, role: staff.role },
        action: 'account.login',
        entityType: 'staff',
        entityId: staff.id,
        summary: 'Signed in',
      });

      return res.json({
        success: true,
        token: signStaffToken(staff),
        shop: toShop(staffShop),
        user: { type: 'staff', id: staff.id, name: staff.full_name, role: staff.role, roleLabel: ROLE_LABELS[staff.role] },
        permissions: permissionsFor(staff.role),
      });
    }

    const passwordMatch = await bcrypt.compare(password, shop.password_hash);

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

    recordShopActivity({
      shopId: shop.id,
      actor: { type: 'owner', name: 'Owner', role: 'owner' },
      action: 'account.login',
      entityType: 'shop',
      entityId: shop.id,
      summary: 'Signed in',
    });

    return res.json({
      success: true,
      token: signShopToken(shop),
      shop: toShop(shop),
      user: { type: 'owner', id: null, name: 'Owner', role: 'owner', roleLabel: ROLE_LABELS.owner },
      permissions: permissionsFor('owner'),
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

    const user = userOf(req);

    return res.json({
      success: true,
      shop: toShop(result.rows[0]),
      // Who is signed in and what they may do (phase 27)
      user,
      permissions: permissionsFor(user.role),
    });
  } catch (error) {
    console.error('❌ getShopProfile error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load profile' });
  }
};


// =====================================================
// UPDATE PROFILE
// PUT /api/shop/profile (multipart, optional `image`)
// Optional `brandColor`: "#RRGGBB" sets it, "" clears it
// (automatic), left out keeps the current one.
// =====================================================

const updateShopProfile = async (req, res) => {
  try {
    const shopName = clean(req.body?.shopName);
    const mobile = req.body?.mobile ? normalizeSriLankanPhone(req.body.mobile) : null;
    const address = clean(req.body?.address);
    const latitude = parseCoordinate(req.body?.latitude, 90);
    const longitude = parseCoordinate(req.body?.longitude, 180);

    const hasBrandColor = req.body?.brandColor !== undefined;
    const brandColorText = String(req.body?.brandColor ?? '').trim();
    const brandColor = brandColorText ? normalizeBrandColor(brandColorText) : null;

    if (hasBrandColor && brandColorText && !brandColor) {
      return res.status(400).json({ success: false, message: 'Enter a brand color like #0060A9.' });
    }

    if (brandColor && whiteContrast(brandColor) < MIN_WHITE_CONTRAST) {
      return res.status(400).json({
        success: false,
        message: 'That brand color is too light for white text. Pick a darker shade.',
      });
    }

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
        brand_color = CASE WHEN $8::boolean THEN $9::varchar ELSE brand_color END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $7
      RETURNING *
      `,
      [shopName, mobile, address, latitude, longitude, imageUrl, req.shop.shopId, hasBrandColor, brandColor]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    // Admin panel shop cards show the brand color
    emitToAdmins(req.app.get('io'), 'admin:shops-updated', {
      shopId: req.shop.shopId,
      reason: 'profile',
    });

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

    const current = (
      await pool.query('SELECT auto_open, opening_hours FROM shops WHERE id = $1', [req.shop.shopId])
    ).rows[0];

    const holdUntil = current?.auto_open && current.opening_hours
      ? nextChange(current.opening_hours, new Date())
      : null;

    const result = await pool.query(
      `
      UPDATE shops
      SET is_open = $1, open_override_until = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [req.body.isOpen, req.shop.shopId, holdUntil]
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
