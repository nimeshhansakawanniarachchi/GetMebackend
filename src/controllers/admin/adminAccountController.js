const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const pool = require('../../config/db');

const toAdmin = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  isActive: row.is_active,
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
});


// =====================================================
// LOGIN
// POST /api/admin/auth/login
// =====================================================

const login = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT * FROM admins WHERE email = $1',
      [email]
    );

    const admin = result.rows[0];

    const passwordMatch =
      admin && (await bcrypt.compare(password, admin.password_hash));

    if (!passwordMatch || !admin.is_active) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    await pool.query(
      'UPDATE admins SET last_login_at = NOW() WHERE id = $1',
      [admin.id]
    );

    const token = jwt.sign(
      { adminId: admin.id, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.json({ success: true, token, admin: toAdmin(admin) });
  } catch (error) {
    console.error('❌ admin login error:', error.message);

    return res.status(500).json({ success: false, message: 'Login failed' });
  }
};


// =====================================================
// CURRENT ADMIN
// GET /api/admin/auth/me
// =====================================================

const me = async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM admins WHERE id = $1',
    [req.admin.adminId]
  );

  return res.json({ success: true, admin: toAdmin(result.rows[0]) });
};


// =====================================================
// CHANGE OWN PASSWORD
// PUT /api/admin/auth/password { currentPassword, newPassword }
// =====================================================

const changePassword = async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }

    const result = await pool.query(
      'SELECT password_hash FROM admins WHERE id = $1',
      [req.admin.adminId]
    );

    const matches = await bcrypt.compare(currentPassword, result.rows[0].password_hash);

    if (!matches) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    await pool.query(
      'UPDATE admins SET password_hash = $1 WHERE id = $2',
      [await bcrypt.hash(newPassword, 12), req.admin.adminId]
    );

    return res.json({ success: true, message: 'Password changed' });
  } catch (error) {
    console.error('❌ admin changePassword error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to change password' });
  }
};


// =====================================================
// ADMIN USERS
// GET /api/admin/admins
// POST /api/admin/admins { fullName, email, password }
// PATCH /api/admin/admins/:id { isActive }
// =====================================================

const listAdmins = async (req, res) => {
  const result = await pool.query('SELECT * FROM admins ORDER BY created_at ASC');

  return res.json({ success: true, admins: result.rows.map(toAdmin) });
};

const createAdmin = async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (fullName.length < 2) {
      return res.status(400).json({ success: false, message: 'Enter a name' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email' });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const result = await pool.query(
      `
      INSERT INTO admins (full_name, email, password_hash)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO NOTHING
      RETURNING *
      `,
      [fullName, email, await bcrypt.hash(password, 12)]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ success: false, message: 'An admin with this email already exists' });
    }

    return res.status(201).json({ success: true, admin: toAdmin(result.rows[0]) });
  } catch (error) {
    console.error('❌ createAdmin error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to create admin' });
  }
};

const setAdminActive = async (req, res) => {
  const adminId = Number(req.params.id);

  if (typeof req.body?.isActive !== 'boolean' || !Number.isInteger(adminId)) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }

  if (adminId === req.admin.adminId && req.body.isActive === false) {
    return res.status(400).json({ success: false, message: "You can't deactivate your own account" });
  }

  const result = await pool.query(
    'UPDATE admins SET is_active = $1 WHERE id = $2 RETURNING *',
    [req.body.isActive, adminId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ success: false, message: 'Admin not found' });
  }

  return res.json({ success: true, admin: toAdmin(result.rows[0]) });
};

module.exports = {
  login,
  me,
  changePassword,
  listAdmins,
  createAdmin,
  setAdminActive,
};
