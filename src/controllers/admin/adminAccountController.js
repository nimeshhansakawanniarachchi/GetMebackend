const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const pool = require('../../config/db');
const { recordAdminAudit } = require('../../middleware/adminAccess');
const perms = require('../../admin/permissions');

// =====================================================
// ADMIN ACCOUNTS (phase 26, extended phase 40)
// Every staff member has their own account; the Super Admin ('owner')
// creates them, assigns roles + extra permissions, deactivates them and
// resets passwords. A new account / a reset gets a one-time temporary
// password (shown once to the Super Admin) that must be changed at the
// first sign-in. Nobody changes their own role, permissions or status,
// and the last active Super Admin can't be removed.
// =====================================================

const ROLES = perms.ROLES;

const toAdmin = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  role: row.role || 'owner',
  roleLabel: perms.ROLE_LABELS[row.role || 'owner'],
  isActive: row.is_active,
  mustChangePassword: Boolean(row.must_change_password),
  lastLoginAt: row.last_login_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deactivatedAt: row.deactivated_at,
  createdBy: row.created_by_name || null,
  permissionGrants: perms.clean(row.permission_grants),
  permissionRevokes: perms.clean(row.permission_revokes),
  permissions: perms.effectivePermissions(row),
});

const signToken = (admin) =>
  jwt.sign({ adminId: admin.id, role: 'admin', av: Number(admin.auth_version || 0) }, process.env.JWT_SECRET, { expiresIn: '12h' });

// 12 characters, no look-alikes, always letters and digits
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const temporaryPassword = () => {
  for (;;) {
    const value = Array.from({ length: 12 }, () => TEMP_ALPHABET[crypto.randomInt(0, TEMP_ALPHABET.length)]).join('');
    if (/[A-Za-z]/.test(value) && /\d/.test(value)) return value;
  }
};

const passwordProblem = (password) => {
  if (password.length < 8) return 'Use at least 8 characters';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'Use letters and numbers';
  return null;
};

const adminRow = async (client, id) =>
  (
    await client.query(
      `SELECT a.*, c.full_name AS created_by_name FROM admins a LEFT JOIN admins c ON c.id = a.created_by WHERE a.id = $1`,
      [id]
    )
  ).rows[0];

// What an audit entry keeps about an account (no password data)
const snapshot = (row) =>
  row
    ? {
        fullName: row.full_name,
        role: row.role,
        isActive: row.is_active,
        permissionGrants: perms.clean(row.permission_grants),
        permissionRevokes: perms.clean(row.permission_revokes),
      }
    : null;


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
        summary: admin && passwordMatch && !admin.is_active ? `Sign-in refused: ${email} is deactivated` : `Failed sign-in for ${email}`,
        outcome: 'denied',
        ip: req.ip,
      });

      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    await pool.query(
      'UPDATE admins SET last_login_at = NOW() WHERE id = $1',
      [admin.id]
    );

    recordAdminAudit({
      admin: { adminId: admin.id, fullName: admin.full_name, role: admin.role },
      action: 'admin.login',
      entityType: 'admin',
      entityId: admin.id,
      summary: admin.must_change_password ? 'Signed in with a temporary password' : 'Signed in',
      ip: req.ip,
    });

    return res.json({ success: true, token: signToken(admin), admin: toAdmin(admin) });
  } catch (error) {
    console.error('❌ admin login error:', error.message);

    return res.status(500).json({ success: false, message: 'Login failed' });
  }
};


// =====================================================
// CURRENT ADMIN
// GET /api/admin/auth/me -> { admin (with permissions) }
// =====================================================

const me = async (req, res) => {
  try {
    const row = await adminRow(pool, req.admin.adminId);
    return res.json({ success: true, admin: toAdmin(row) });
  } catch (error) {
    console.error('❌ admin me error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load your account' });
  }
};


// =====================================================
// CHANGE OWN PASSWORD
// PUT /api/admin/auth/password { currentPassword, newPassword }
// Every other session is signed out; the reply carries a new token.
// =====================================================

// Live sockets of an admin whose role, permissions, status or password
// changed reconnect, so their rooms and notifications follow the change
// (phase 41; a deactivated or signed-out account can't reconnect)
const disconnectAdminSockets = (req, adminId) => {
  try {
    req.app.get('io')?.in(`admin:${adminId}`).disconnectSockets(true);
  } catch (error) {
    console.warn('⚠️ disconnectAdminSockets:', error.message);
  }
};

const changePassword = async (req, res) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    const problem = passwordProblem(newPassword);

    if (problem) {
      return res.status(400).json({ success: false, message: `New password: ${problem.toLowerCase()}` });
    }

    const result = await pool.query('SELECT password_hash FROM admins WHERE id = $1', [req.admin.adminId]);
    const matches = await bcrypt.compare(currentPassword, result.rows[0].password_hash);

    if (!matches) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    if (await bcrypt.compare(newPassword, result.rows[0].password_hash)) {
      return res.status(400).json({ success: false, message: 'Choose a password different from the current one' });
    }

    const updated = (
      await pool.query(
        `UPDATE admins SET password_hash = $1, must_change_password = FALSE, auth_version = auth_version + 1,
           password_changed_at = NOW(), updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [await bcrypt.hash(newPassword, 12), req.admin.adminId]
      )
    ).rows[0];

    disconnectAdminSockets(req, updated.id);

    return res.json({ success: true, message: 'Password changed. Other sessions were signed out.', token: signToken(updated), admin: toAdmin(updated) });
  } catch (error) {
    console.error('❌ admin changePassword error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to change password' });
  }
};


// =====================================================
// STAFF (Super Admin only - admins.manage / permissions.manage)
// GET   /api/admin/admins
// POST  /api/admin/admins { fullName, email, role, permissionGrants?, permissionRevokes? }
//         -> { admin, temporaryPassword (shown once) }
// PATCH /api/admin/admins/:id { fullName?, role?, isActive?, permissionGrants?, permissionRevokes? }
// POST  /api/admin/admins/:id/reset-password -> { temporaryPassword (shown once) }
// GET   /api/admin/permissions -> roles, labels, defaults, catalogue
// =====================================================

const listAdmins = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT a.*, c.full_name AS created_by_name FROM admins a LEFT JOIN admins c ON c.id = a.created_by ORDER BY a.is_active DESC, a.created_at ASC'
    );

    return res.json({ success: true, roles: ROLES, roleLabels: perms.ROLE_LABELS, admins: result.rows.map(toAdmin) });
  } catch (error) {
    console.error('❌ listAdmins error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load admins' });
  }
};

const permissionCatalogue = (req, res) =>
  res.json({
    success: true,
    roles: ROLES.map((role) => ({ role, label: perms.ROLE_LABELS[role], permissions: role === 'owner' ? perms.ALL : perms.ROLE_PERMISSIONS[role] })),
    permissions: perms.catalogue(),
    grantable: perms.GRANTABLE,
  });

// Grants / revokes: only grantable keys; anything else is refused (not
// silently dropped), so an escalation attempt is visible
const readPermissionLists = (body) => {
  const out = {};
  for (const [field, key] of [['permissionGrants', 'grants'], ['permissionRevokes', 'revokes']]) {
    if (body?.[field] === undefined) continue;
    if (!Array.isArray(body[field])) return { error: `${field} must be a list` };
    const bad = body[field].map(String).filter((k) => !perms.GRANTABLE.includes(k));
    if (bad.length) return { error: `These permissions can't be given to staff: ${bad.join(', ')}` };
    out[key] = [...new Set(body[field].map(String))];
  }
  return out;
};

const createAdmin = async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || '').trim().slice(0, 120);
    const email = String(req.body?.email || '').trim().toLowerCase();
    const role = req.body?.role == null ? 'support' : String(req.body.role);
    const lists = readPermissionLists(req.body);

    if (!ROLES.includes(role)) return res.status(400).json({ success: false, message: 'Choose a valid role' });
    if (lists.error) return res.status(400).json({ success: false, code: 'INVALID_PERMISSIONS', message: lists.error });
    if (fullName.length < 2) return res.status(400).json({ success: false, message: 'Enter a name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'Enter a valid email' });

    // A password typed by the Super Admin is accepted but is still
    // temporary; otherwise one is generated
    const typed = req.body?.password ? String(req.body.password) : '';
    if (typed && passwordProblem(typed)) return res.status(400).json({ success: false, message: `Password: ${passwordProblem(typed).toLowerCase()}` });
    const temporary = typed || temporaryPassword();

    const result = await pool.query(
      `
      INSERT INTO admins (full_name, email, password_hash, role, must_change_password, created_by, permission_grants, permission_revokes)
      VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7)
      ON CONFLICT (email) DO NOTHING
      RETURNING *
      `,
      [fullName, email, await bcrypt.hash(temporary, 12), role, req.admin.adminId, lists.grants || [], lists.revokes || []]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ success: false, message: 'An admin with this email already exists' });
    }

    const row = await adminRow(pool, result.rows[0].id);
    res.locals.audit = {
      entityId: row.id,
      summary: `Created ${perms.ROLE_LABELS[role]} account for ${email}`,
      after: snapshot(row),
    };
    res.set('Cache-Control', 'no-store');

    return res.status(201).json({
      success: true,
      message: 'Account created. Give the temporary password to the staff member privately; they must change it when they first sign in.',
      admin: toAdmin(row),
      temporaryPassword: typed ? undefined : temporary,
    });
  } catch (error) {
    console.error('❌ createAdmin error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to create admin' });
  }
};

const updateAdmin = async (req, res) => {
  const adminId = Number(req.params.id);
  const body = req.body || {};
  const { isActive } = body;
  const role = body.role;
  const fullName = body.fullName !== undefined ? String(body.fullName).trim().slice(0, 120) : undefined;
  const lists = readPermissionLists(body);

  if (!Number.isInteger(adminId) || (typeof isActive !== 'boolean' && role === undefined && fullName === undefined && !lists.grants && !lists.revokes && !lists.error)) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }
  if (lists.error) return res.status(400).json({ success: false, code: 'INVALID_PERMISSIONS', message: lists.error });
  if (role !== undefined && !ROLES.includes(role)) return res.status(400).json({ success: false, message: 'Choose a valid role' });
  if (fullName !== undefined && fullName.length < 2) return res.status(400).json({ success: false, message: 'Enter a name' });

  // No one changes their own access (role, status, permissions)
  if (adminId === req.admin.adminId && (isActive !== undefined || role !== undefined || lists.grants || lists.revokes)) {
    return res.status(403).json({ success: false, code: 'SELF_CHANGE', message: "You can't change your own role, status or permissions" });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the Super Admins so two changes can't remove the last one
    const owners = (await client.query("SELECT id FROM admins WHERE role = 'owner' AND is_active FOR UPDATE")).rows.map((row) => Number(row.id));
    const before = (await client.query('SELECT * FROM admins WHERE id = $1 FOR UPDATE', [adminId])).rows[0];

    if (!before) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    const losingOwner = owners.includes(adminId) && (isActive === false || (role && role !== 'owner'));
    if (losingOwner && owners.length <= 1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'LAST_SUPER_ADMIN', message: 'GetMe needs at least one active Super Admin' });
    }

    const row = (
      await client.query(
        `
        UPDATE admins
        SET is_active = COALESCE($1, is_active),
            role = COALESCE($2, role),
            full_name = COALESCE($3, full_name),
            permission_grants = COALESCE($4, permission_grants),
            permission_revokes = COALESCE($5, permission_revokes),
            deactivated_at = CASE WHEN $1 IS FALSE THEN NOW() WHEN $1 IS TRUE THEN NULL ELSE deactivated_at END,
            updated_at = NOW()
        WHERE id = $6
        RETURNING *
        `,
        [typeof isActive === 'boolean' ? isActive : null, role ?? null, fullName ?? null, lists.grants ?? null, lists.revokes ?? null, adminId]
      )
    ).rows[0];

    await client.query('COMMIT');

    const changes = [];
    if (role !== undefined && role !== before.role) changes.push(`role ${perms.ROLE_LABELS[before.role]} -> ${perms.ROLE_LABELS[role]}`);
    if (typeof isActive === 'boolean' && isActive !== before.is_active) changes.push(isActive ? 'activated' : 'deactivated');
    if (lists.grants || lists.revokes) changes.push('permissions changed');
    if (fullName !== undefined && fullName !== before.full_name) changes.push('name changed');

    res.locals.audit = {
      action: lists.grants || lists.revokes ? 'admin.permissions' : role !== undefined ? 'admin.role' : typeof isActive === 'boolean' ? (isActive ? 'admin.activate' : 'admin.deactivate') : 'admin.update',
      entityId: adminId,
      summary: `${before.email}: ${changes.join(', ') || 'no change'}`,
      before: snapshot(before),
      after: snapshot(row),
    };

    disconnectAdminSockets(req, adminId);

    return res.json({ success: true, admin: toAdmin(await adminRow(pool, adminId)) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ updateAdmin error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update the admin' });
  } finally {
    client.release();
  }
};

const resetPassword = async (req, res) => {
  const adminId = Number(req.params.id);

  if (!Number.isInteger(adminId)) return res.status(400).json({ success: false, message: 'Invalid admin' });
  if (adminId === req.admin.adminId) {
    return res.status(403).json({ success: false, code: 'SELF_CHANGE', message: 'Change your own password under Settings > Your account' });
  }

  try {
    const temporary = temporaryPassword();
    const row = (
      await pool.query(
        `UPDATE admins SET password_hash = $2, must_change_password = TRUE, auth_version = auth_version + 1, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [adminId, await bcrypt.hash(temporary, 12)]
      )
    ).rows[0];

    if (!row) return res.status(404).json({ success: false, message: 'Admin not found' });

    res.locals.audit = { entityId: adminId, summary: `Reset the password of ${row.email}; every session signed out` };
    disconnectAdminSockets(req, adminId);
    res.set('Cache-Control', 'no-store');

    return res.json({
      success: true,
      message: 'Password reset. Their sessions were signed out. Give the temporary password to them privately.',
      temporaryPassword: temporary,
      admin: toAdmin(row),
    });
  } catch (error) {
    console.error('❌ resetPassword error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to reset the password' });
  }
};

// =====================================================
// SECURITY SETTINGS (Super Admin): approval limits
// GET /api/admin/security-settings, PUT { refundApprovalLimit, earningsAdjustApprovalLimit }
// =====================================================

const toSettings = (row) => ({
  refundApprovalLimit: Number(row.refund_approval_limit),
  earningsAdjustApprovalLimit: Number(row.earnings_adjust_approval_limit),
  updatedAt: row.updated_at,
});

const getSecuritySettings = async (req, res) => {
  const row = (await pool.query('SELECT * FROM admin_security_settings WHERE id = 1')).rows[0];
  return res.json({ success: true, settings: toSettings(row) });
};

const updateSecuritySettings = async (req, res) => {
  const refund = Number(req.body?.refundApprovalLimit);
  const adjust = Number(req.body?.earningsAdjustApprovalLimit);

  if (!(refund >= 0 && refund <= 10000000) || !(adjust >= 0 && adjust <= 10000000)) {
    return res.status(400).json({ success: false, message: 'Enter limits from Rs 0 to Rs 10,000,000 (0 = every action needs approval)' });
  }

  try {
    const before = (await pool.query('SELECT * FROM admin_security_settings WHERE id = 1')).rows[0];
    const row = (
      await pool.query(
        `UPDATE admin_security_settings SET refund_approval_limit = $1, earnings_adjust_approval_limit = $2, updated_by = $3, updated_at = NOW()
         WHERE id = 1 RETURNING *`,
        [Math.round(refund * 100) / 100, Math.round(adjust * 100) / 100, req.admin.adminId]
      )
    ).rows[0];

    res.locals.audit = { entityId: 1, summary: 'Approval limits changed', before: toSettings(before), after: toSettings(row) };
    return res.json({ success: true, settings: toSettings(row) });
  } catch (error) {
    console.error('❌ updateSecuritySettings error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to save the settings' });
  }
};

module.exports = {
  login,
  me,
  changePassword,
  listAdmins,
  permissionCatalogue,
  createAdmin,
  updateAdmin,
  // older name kept for the routes / callers
  setAdminActive: updateAdmin,
  resetPassword,
  getSecuritySettings,
  updateSecuritySettings,
};
