const jwt = require('jsonwebtoken');

const db = require('../config/db');
const { effectivePermissions } = require('../admin/permissions');

// =====================================================
// ADMIN AUTH
// Token must carry adminId + role 'admin', and the admin
// account must still be active. Phase 40: the account is read on every
// request, so deactivation, role and permission changes apply at once;
// the token's session version (av) must match admins.auth_version (a
// password reset signs every session out); an admin on a temporary
// password can only change it.
// =====================================================

// Routes an admin on a temporary password may still use
const PASSWORD_CHANGE_ALLOWED = ['GET /auth/me', 'PUT /auth/password'];

const requireAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      success: false,
      message: 'Admin login required',
    });
  }

  let decoded;

  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({
      success: false,
      message: 'Session expired. Please log in again.',
    });
  }

  if (!decoded?.adminId || decoded.role !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access only',
    });
  }

  try {
    const result = await db.query(
      `SELECT id, full_name, email, is_active, role, permission_grants, permission_revokes,
              auth_version, must_change_password
       FROM admins WHERE id = $1`,
      [decoded.adminId]
    );

    const admin = result.rows[0];

    if (!admin || !admin.is_active) {
      return res.status(401).json({
        success: false,
        code: 'ACCOUNT_DISABLED',
        message: 'Admin account is not active',
      });
    }

    // Tokens from before a password reset no longer work (tokens signed
    // before phase 40 carry no version and count as version 0)
    if (Number(decoded.av ?? 0) !== Number(admin.auth_version || 0)) {
      return res.status(401).json({
        success: false,
        code: 'SESSION_ENDED',
        message: 'Your session has ended. Please sign in again.',
      });
    }

    req.admin = {
      adminId: admin.id,
      fullName: admin.full_name,
      email: admin.email,
      // owner (Super Admin) | operations | finance | support | developer
      role: admin.role || 'owner',
      permissions: new Set(effectivePermissions(admin)),
      mustChangePassword: Boolean(admin.must_change_password),
    };

    if (req.admin.mustChangePassword) {
      const route = `${req.method} ${req.path}`;
      if (!PASSWORD_CHANGE_ALLOWED.includes(route)) {
        return res.status(403).json({
          success: false,
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'Set your own password before using the admin panel.',
        });
      }
    }

    next();
  } catch (error) {
    console.error('❌ requireAdmin error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
    });
  }
};

module.exports = requireAdmin;
