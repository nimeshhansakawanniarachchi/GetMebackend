const pool = require('../config/db');

// =====================================================
// ADMIN ROLES + AUDIT LOG (sql/platform_phase26_admin_ops.sql)
//
// Roles (admins.role):
//   owner       everything, incl. admin accounts and pricing
//   operations  orders (cancel), shoppers, shops, products, offers,
//               promos, live operations
//   finance     payments, refunds, store bills, settlements, payouts,
//               ledger, reconciliation
//   support     read-only: orders, customers, shoppers, shops
//
// allowRoles(...roles) guards a route (owner always passes).
// auditAdminChanges records every successful admin change (POST /
// PUT / PATCH / DELETE that answered < 400) in admin_audit_log.
// recordAdminAudit() writes one entry directly (login, etc.).
// =====================================================

const ROLES = ['owner', 'operations', 'finance', 'support'];

const ROLE_LABELS = {
  owner: 'Owner',
  operations: 'Operations',
  finance: 'Finance',
  support: 'Support',
};

const allowRoles = (...roles) => (req, res, next) => {
  const role = req.admin?.role;

  if (role === 'owner' || roles.includes(role)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    code: 'ROLE_FORBIDDEN',
    message: `Your role (${ROLE_LABELS[role] || role || 'unknown'}) can't do this. Ask an owner for access.`,
  });
};

// Never store secrets or PINs in the log
const SECRET_KEY = /pass|token|secret|pin|cvv|card_?number/i;

const sanitize = (value, depth = 0) => {
  if (value == null || depth > 3) return value ?? null;

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SECRET_KEY.test(key))
        .slice(0, 40)
        .map(([key, item]) => [key, sanitize(item, depth + 1)])
    );
  }

  return typeof value === 'string' ? value.slice(0, 300) : value;
};

const recordAdminAudit = async ({ admin, action, entityType = null, entityId = null, summary = null, details = null, ip = null }) => {
  try {
    await pool.query(
      `
      INSERT INTO admin_audit_log (admin_id, admin_name, admin_role, action, entity_type, entity_id, summary, details, ip)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        admin?.adminId ?? null,
        admin?.fullName ?? null,
        admin?.role ?? null,
        String(action).slice(0, 80),
        entityType,
        entityId != null ? String(entityId).slice(0, 40) : null,
        summary ? String(summary).slice(0, 300) : null,
        details ? JSON.stringify(sanitize(details)) : null,
        ip ? String(ip).slice(0, 64) : null,
      ]
    );
  } catch (error) {
    console.error('❌ ADMIN AUDIT ERROR:', action, error.message);
  }
};

// Route (as written in adminRoutes.js) -> what the change was
const money = (value) => `Rs ${Number(value || 0).toFixed(2)}`;

const AUDITED = {
  'PATCH /orders/:id/cancel': ['order.cancel', 'order', (req) =>
    req.body?.failedDelivery === true ? `Marked failed delivery: ${req.body?.reason || ''}` : `Cancelled: ${req.body?.reason || ''}`],
  'PATCH /orders/:id/refund': ['order.refund', 'order', (req) => `Refunded ${money(req.body?.amount)}: ${req.body?.reason || ''}`],
  'PATCH /shoppers/:id/approval': ['shopper.approval', 'shopper', (req) => `Set approval to ${req.body?.status || req.body?.approvalStatus || ''}`],
  'PATCH /shops/:id/status': ['shop.status', 'shop', (req) => `Set status to ${req.body?.status || ''}`],
  'PATCH /shops/:id/brand-color': ['shop.brand_color', 'shop', (req) => `Brand colour ${req.body?.brandColor || req.body?.color || 'reset'}`],
  'PATCH /products/:id/availability': ['product.availability', 'product', (req) =>
    req.body?.isAvailable === false ? 'Marked unavailable' : 'Marked available'],
  'PATCH /offers/:id/pause': ['offer.pause', 'offer', (req) => (req.body?.paused === false ? 'Resumed offer' : 'Paused offer')],
  'PATCH /store-payments/:id/review': ['store_payment.review', 'store_payment', (req) =>
    `${req.body?.action === 'approve' ? 'Approved' : 'Queried'} store bill${req.body?.note ? `: ${req.body.note}` : ''}`],
  'PATCH /store-payments/:id/reimburse': ['store_payment.reimburse', 'store_payment', (req) => `Reimbursed (ref ${req.body?.reference || ''})`],
  'POST /settlements/shoppers/:shopperId/payouts': ['shopper.payout', 'shopper', (req) =>
    `Recorded ${req.body?.kind || 'payout'} ${money(req.body?.amount)} (ref ${req.body?.reference || ''})`],
  'PATCH /settlements/earnings/:orderId/dispute': ['earning.hold', 'order', (req) => `Earnings on hold: ${req.body?.note || ''}`],
  'PATCH /settlements/earnings/:orderId/resolve': ['earning.resolve', 'order', (req) => `Earnings ${req.body?.action === 'void' ? 'voided' : 'released'}`],
  'PATCH /settlements/earnings/:orderId/adjust': ['earning.adjust', 'order', (req) => `Adjustment ${money(req.body?.amount)}: ${req.body?.note || ''}`],
  'PUT /settings/pricing': ['settings.pricing', 'settings', () => 'Updated fees & pricing'],
  'POST /promos': ['promo.create', 'promo', (req) => `Created promo ${req.body?.code || ''}`],
  'PATCH /promos/:id': ['promo.update', 'promo', () => 'Updated promo'],
  'POST /admins': ['admin.create', 'admin', (req) => `Created ${req.body?.role || 'owner'} admin ${req.body?.email || ''}`],
  'PATCH /admins/:id': ['admin.update', 'admin', (req) => {
    const parts = [];
    if (typeof req.body?.isActive === 'boolean') parts.push(req.body.isActive ? 'activated' : 'deactivated');
    if (req.body?.role) parts.push(`role ${req.body.role}`);
    return `Admin ${parts.join(', ') || 'updated'}`;
  }],
  'PUT /auth/password': ['admin.password', 'admin', () => 'Changed own password'],
};

const auditAdminChanges = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.route) return;

    const key = `${req.method} ${req.route.path}`;
    const [action, entityType, describe] = AUDITED[key] || [
      `${req.method.toLowerCase()} ${req.route.path}`, null, null,
    ];

    const entityId =
      req.params?.id ?? req.params?.orderId ?? req.params?.shopperId ??
      (key === 'PUT /auth/password' ? req.admin?.adminId : null);

    let summary = null;
    try {
      summary = describe ? describe(req) : null;
    } catch {
      summary = null;
    }

    recordAdminAudit({
      admin: req.admin,
      action,
      entityType,
      entityId,
      summary,
      details: req.body,
      ip: req.ip,
    });
  });

  return next();
};

module.exports = {
  ROLES,
  ROLE_LABELS,
  allowRoles,
  auditAdminChanges,
  recordAdminAudit,
};
