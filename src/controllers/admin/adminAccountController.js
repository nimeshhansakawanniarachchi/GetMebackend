const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const pool = require('../../config/db');
const { ROLES, recordAdminAudit } = require('../../middleware/adminAccess');

const toAdmin = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  role: row.role || 'owner',
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
      recordAdminAudit({
        admin: admin ? { adminId: admin.id, fullName: admin.full_name, role: admin.role } : null,
        action: 'admin.login_failed',
        entityType: 'admin',
        entityId: admin?.id ?? null,
        summary: `Failed sign-in for ${email}`,
        ip: req.ip,
      });

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

    recordAdminAudit({
      admin: { adminId: admin.id, fullName: admin.full_name, role: admin.role },
      action: 'admin.login',
      entityType: 'admin',
      entityId: admin.id,
      summary: 'Signed in',
      ip: req.ip,
    });

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
  try {
    const result = await pool.query(
      'SELECT * FROM admins WHERE id = $1',
      [req.admin.adminId]
    );

    return res.json({ success: true, admin: toAdmin(result.rows[0]) });
  } catch (error) {
    console.error('❌ admin me error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load your account' });
  }
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
// POST /api/admin/admins { fullName, email, password, role }
// PATCH /api/admin/admins/:id { isActive?, role? }
// Owner only (adminRoutes). An owner can't lock themselves out, and
// the last active owner can't be demoted or deactivated.
// =====================================================

const listAdmins = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM admins ORDER BY created_at ASC');

    return res.json({ success: true, roles: ROLES, admins: result.rows.map(toAdmin) });
  } catch (error) {
    console.error('❌ listAdmins error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load admins' });
  }
};

const createAdmin = async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = req.body?.role == null ? 'support' : String(req.body.role);

    if (!ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: 'Choose a valid role' });
    }

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
      INSERT INTO admins (full_name, email, password_hash, role)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO NOTHING
      RETURNING *
      `,
      [fullName, email, await bcrypt.hash(password, 12), role]
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
  const { isActive } = req.body || {};
  const role = req.body?.role;

  if (!Number.isInteger(adminId) || (typeof isActive !== 'boolean' && role === undefined)) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }

  if (role !== undefined && !ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: 'Choose a valid role' });
  }

  if (adminId === req.admin.adminId && (isActive === false || (role && role !== 'owner'))) {
    return res.status(400).json({ success: false, message: "You can't deactivate or demote your own account" });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the owners so two changes can't remove the last one
    const owners = (
      await client.query("SELECT id FROM admins WHERE role = 'owner' AND is_active FOR UPDATE")
    ).rows.map((row) => Number(row.id));

    const losingOwner =
      owners.includes(adminId) && (isActive === false || (role && role !== 'owner'));

    if (losingOwner && owners.length <= 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'GetMe needs at least one active owner' });
    }

    const result = await client.query(
      `
      UPDATE admins
      SET is_active = COALESCE($1, is_active), role = COALESCE($2, role)
      WHERE id = $3
      RETURNING *
      `,
      [typeof isActive === 'boolean' ? isActive : null, role ?? null, adminId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    await client.query('COMMIT');

    return res.json({ success: true, admin: toAdmin(result.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ setAdminActive error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update the admin' });
  } finally {
    client.release();
  }
};

module.exports = {
  login,
  me,
  changePassword,
  listAdmins,
  createAdmin,
  setAdminActive,
};
