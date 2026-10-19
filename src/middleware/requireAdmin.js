const jwt = require('jsonwebtoken');

const db = require('../config/db');

// =====================================================
// ADMIN AUTH
// Token must carry adminId + role 'admin', and the admin
// account must still be active.
// =====================================================

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
      'SELECT id, full_name, email, is_active FROM admins WHERE id = $1',
      [decoded.adminId]
    );

    const admin = result.rows[0];

    if (!admin || !admin.is_active) {
      return res.status(401).json({
        success: false,
        message: 'Admin account is not active',
      });
    }

    req.admin = {
      adminId: admin.id,
      fullName: admin.full_name,
      email: admin.email,
    };

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
