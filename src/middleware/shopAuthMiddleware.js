const jwt = require('jsonwebtoken');

const db = require('../config/db');

// =====================================================
// SHOP AUTH
// Token must be a shop token, and the shop must not be
// rejected or suspended. Pending shops may set up their store
// (they stay hidden from customers until approved).
// =====================================================

const shopAuthMiddleware = async (
  req,
  res,
  next
) => {
  let decoded;

  try {
    const authHeader =
      req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message:
          'Authorization token is required',
      });
    }

    const parts =
      authHeader.split(' ');

    if (
      parts.length !== 2 ||
      parts[0] !== 'Bearer'
    ) {
      return res.status(401).json({
        success: false,
        message:
          'Invalid authorization format',
      });
    }

    decoded = jwt.verify(
      parts[1],
      process.env.JWT_SECRET
    );
  } catch (error) {
    console.error(
      '❌ SHOP JWT ERROR:',
      error.message
    );

    return res.status(401).json({
      success: false,
      message:
        'Invalid or expired token',
    });
  }

  if (!decoded?.shopId) {
    return res.status(401).json({
      success: false,
      message: 'Invalid shop token',
    });
  }

  try {
    const result = await db.query(
      'SELECT status, auth_version FROM shops WHERE id = $1',
      [decoded.shopId]
    );

    const status = result.rows[0]?.status;

    if (!status) {
      return res.status(401).json({
        success: false,
        message: 'Shop account not found',
      });
    }

    if (status === 'rejected' || status === 'suspended') {
      return res.status(403).json({
        success: false,
        shopStatus: status,
        message:
          status === 'rejected'
            ? 'Your shop application was not approved.'
            : 'Your shop is suspended. Please contact GetMe support.',
      });
    }

    // Staff login (phase 27): the account must still be active and
    // belong to this shop. The shop's own login is the Owner.
    if (decoded.staffId) {
      const staff = (
        await db.query(
          'SELECT id, full_name, role, is_active, auth_version FROM shop_staff WHERE id = $1 AND shop_id = $2',
          [decoded.staffId, decoded.shopId]
        )
      ).rows[0];

      if (!staff || !staff.is_active) {
        return res.status(401).json({
          success: false,
          message: 'Your staff account is not active. Ask the shop owner.',
        });
      }

      // A token from before this staff member's password changed
      if (Number(decoded.av || 0) !== Number(staff.auth_version || 0)) {
        return res.status(401).json({ success: false, code: 'SESSION_ENDED', message: 'Your password was changed. Please sign in again.' });
      }

      req.shop = { ...decoded, staffId: staff.id, role: staff.role, actorName: staff.full_name };
    } else {
      // A token from before the shop's password changed (B-11)
      if (Number(decoded.av || 0) !== Number(result.rows[0].auth_version || 0)) {
        return res.status(401).json({ success: false, code: 'SESSION_ENDED', message: 'Your password was changed. Please sign in again.' });
      }

      req.shop = { ...decoded, staffId: null, role: 'owner', actorName: 'Owner' };
    }

    req.shopStatus = status;

    next();
  } catch (error) {
    console.error('❌ SHOP AUTH ERROR:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
    });
  }
};

module.exports =
  shopAuthMiddleware;
