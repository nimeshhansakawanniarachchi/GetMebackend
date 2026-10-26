const bcrypt = require('bcryptjs');

const pool = require('../../config/db');
const { toShop } = require('./shopFormat');
const { readPage } = require('../../utils/pagination');
const { normalizeSriLankanPhone } = require('../../utils/phone');
const { normalizeHours, isOpenAt } = require('../../utils/shopHours');
const { broadcastCatalogChange, emitToAdmins } = require('../../realtime');

// =====================================================
// SHOP STAFF, PASSWORD, SETTINGS, ACTIVITY (phase 27)
//   GET   /api/shop/staff                 owner
//   POST  /api/shop/staff                 owner { fullName, email, mobile?, password, role }
//   PATCH /api/shop/staff/:id             owner { role?, isActive?, password? }
//   PUT   /api/shop/password              any   { currentPassword, newPassword }
//   PUT   /api/shop/settings              owner / manager
//                                         { openingHours, autoOpen, lowStockThreshold }
//   GET   /api/shop/activity?page&type    owner / manager
// =====================================================

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STAFF_ROLES = ['manager', 'staff'];

const toStaff = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  mobile: row.mobile,
  role: row.role,
  isActive: row.is_active,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});

const emailTaken = async (email, exceptStaffId = 0) => {
  const [shop, staff] = await Promise.all([
    pool.query('SELECT 1 FROM shops WHERE LOWER(email) = $1', [email]),
    pool.query('SELECT 1 FROM shop_staff WHERE LOWER(email) = $1 AND id <> $2', [email, exceptStaffId]),
  ]);
  return shop.rows.length > 0 || staff.rows.length > 0;
};

const listStaff = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shop_staff WHERE shop_id = $1 ORDER BY is_active DESC, created_at', [req.shop.shopId]);
    return res.json({ success: true, roles: STAFF_ROLES, staff: result.rows.map(toStaff) });
  } catch (error) {
    console.error('❌ listStaff error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load staff' });
  }
};

const createStaff = async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = req.body?.role || 'staff';
    const mobile = req.body?.mobile ? normalizeSriLankanPhone(req.body.mobile) : null;

    if (fullName.length < 2 || fullName.length > 120) {
      return res.status(400).json({ success: false, message: 'Enter the staff member’s name' });
    }
    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }
    if (req.body?.mobile && !mobile) {
      return res.status(400).json({ success: false, message: 'Enter a valid Sri Lankan phone number' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }
    if (!STAFF_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: 'Choose Manager or Staff' });
    }
    if (await emailTaken(email)) {
      return res.status(409).json({ success: false, message: 'This email is already used by a GetMe shop account' });
    }

    const row = (
      await pool.query(
        `
        INSERT INTO shop_staff (shop_id, full_name, email, mobile, password_hash, role)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [req.shop.shopId, fullName, email, mobile, await bcrypt.hash(password, 10), role]
      )
    ).rows[0];

    return res.status(201).json({ success: true, message: `${fullName} can now sign in`, staff: toStaff(row) });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'This email is already used by a GetMe shop account' });
    }
    console.error('❌ createStaff error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to add the staff member' });
  }
};

const updateStaff = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { role, isActive } = req.body || {};
    const password = req.body?.password;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid staff member' });
    }
    if (role !== undefined && !STAFF_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: 'Choose Manager or Staff' });
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isActive must be true or false' });
    }
    if (password !== undefined && String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const row = (
      await pool.query(
        `
        UPDATE shop_staff
        SET role = COALESCE($3, role),
            is_active = COALESCE($4, is_active),
            password_hash = COALESCE($5, password_hash),
            updated_at = NOW()
        WHERE id = $1 AND shop_id = $2
        RETURNING *
        `,
        [id, req.shop.shopId, role ?? null, isActive ?? null, password ? await bcrypt.hash(String(password), 10) : null]
      )
    ).rows[0];

    if (!row) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    return res.json({ success: true, staff: toStaff(row) });
  } catch (error) {
    console.error('❌ updateStaff error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update the staff member' });
  }
};

const changePassword = async (req, res) => {
  try {
    const current = String(req.body?.currentPassword || '');
    const next = String(req.body?.newPassword || '');

    if (next.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }

    const staffId = req.shop.staffId;
    const row = staffId
      ? (await pool.query('SELECT password_hash FROM shop_staff WHERE id = $1 AND shop_id = $2', [staffId, req.shop.shopId])).rows[0]
      : (await pool.query('SELECT password_hash FROM shops WHERE id = $1', [req.shop.shopId])).rows[0];

    if (!row || !(await bcrypt.compare(current, row.password_hash))) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(next, 10);

    if (staffId) await pool.query('UPDATE shop_staff SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, staffId]);
    else await pool.query('UPDATE shops SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hash, req.shop.shopId]);

    return res.json({ success: true, message: 'Password changed' });
  } catch (error) {
    console.error('❌ shop changePassword error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to change the password' });
  }
};

const updateSettings = async (req, res) => {
  try {
    const autoOpen = req.body?.autoOpen === true;
    const threshold = req.body?.lowStockThreshold === undefined ? undefined : Number(req.body.lowStockThreshold);

    if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 0 || threshold > 1000)) {
      return res.status(400).json({ success: false, message: 'Low-stock level must be a whole number from 0 to 1000' });
    }

    let hours = null;
    if (req.body?.openingHours !== undefined && req.body.openingHours !== null) {
      const parsed = normalizeHours(req.body.openingHours);
      if (parsed.error) return res.status(400).json({ success: false, message: parsed.error });
      hours = parsed.hours;
    }

    if (autoOpen && !hours) {
      const existing = (await pool.query('SELECT opening_hours FROM shops WHERE id = $1', [req.shop.shopId])).rows[0];
      if (!existing?.opening_hours) {
        return res.status(400).json({ success: false, message: 'Set your opening hours before turning on automatic opening' });
      }
    }

    const row = (
      await pool.query(
        `
        UPDATE shops
        SET opening_hours = COALESCE($2::jsonb, opening_hours),
            auto_open = $3,
            low_stock_threshold = COALESCE($4, low_stock_threshold),
            open_override_until = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
        `,
        [req.shop.shopId, hours ? JSON.stringify(hours) : null, autoOpen, threshold ?? null]
      )
    ).rows[0];

    // Turning auto on applies the schedule straight away
    if (row.auto_open && row.status === 'approved' && row.opening_hours) {
      const shouldOpen = isOpenAt(row.opening_hours, new Date());
      if (shouldOpen !== null && shouldOpen !== row.is_open) {
        row.is_open = shouldOpen;
        await pool.query('UPDATE shops SET is_open = $2 WHERE id = $1', [row.id, shouldOpen]);
        broadcastCatalogChange(req.app.get('io'), row.id, 'shop');
        emitToAdmins(req.app.get('io'), 'admin:shops-updated', { shopId: row.id, reason: 'open-changed' });
      }
    }

    return res.json({ success: true, message: 'Settings saved', shop: toShop(row) });
  } catch (error) {
    console.error('❌ updateSettings error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to save settings' });
  }
};

const ACTIVITY_TYPES = {
  products: "action LIKE 'product.%'",
  stock: "action LIKE 'stock.%'",
  offers: "action LIKE 'offer.%'",
  shop: "(action LIKE 'shop.%' OR action LIKE 'account.%')",
  staff: "action LIKE 'staff.%'",
  system: "actor_type = 'system'",
};

const getActivity = async (req, res) => {
  try {
    const { page, pageSize } = readPage(req.query, 30);
    const filter = ACTIVITY_TYPES[req.query.type] || 'TRUE';
    const params = [req.shop.shopId];
    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM shop_activity_log WHERE shop_id = $1 AND ${filter}`, params),
      pool.query(
        `SELECT * FROM shop_activity_log WHERE shop_id = $1 AND ${filter} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [...params, pageSize, (page - 1) * pageSize]
      ),
    ]);
    const total = count.rows[0].total;
    return res.json({
      success: true,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      entries: rows.rows.map((row) => ({
        id: Number(row.id),
        at: row.created_at,
        actorType: row.actor_type,
        actorName: row.actor_name,
        actorRole: row.actor_role,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        summary: row.summary,
      })),
    });
  } catch (error) {
    console.error('❌ getActivity error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load activity' });
  }
};

module.exports = { listStaff, createStaff, updateStaff, changePassword, updateSettings, getActivity };
