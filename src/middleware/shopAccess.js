const pool = require('../config/db');

// =====================================================
// SHOP ROLES + ACTIVITY LOG (sql/platform_phase27_shop_portal.sql)
//
// Who is signed in (set by shopAuthMiddleware on req.shop):
//   owner    the shop's own login: everything
//   manager  products, prices, offers, stock, orders, open / closed
//   staff    stock, availability, orders; products read-only
//
// allowShopRoles(...roles) guards a route (owner always passes).
// auditShopChanges logs every successful change to shop_activity_log.
// recordShopActivity() writes one entry (logins, system events).
// =====================================================

const SHOP_ROLES = ['owner', 'manager', 'staff'];

const ROLE_LABELS = { owner: 'Owner', manager: 'Manager', staff: 'Staff' };

// capability -> roles (owner always allowed); the portal mirrors this
const SHOP_CAPABILITIES = {
  manageProducts: ['manager'],
  managePrices: ['manager'],
  manageOffers: ['manager'],
  manageStock: ['manager', 'staff'],
  manageAvailability: ['manager', 'staff'],
  importProducts: ['manager'],
  exportProducts: ['manager'],
  setOpen: ['manager'],
  manageHours: ['manager'],
  editProfile: [],
  manageStaff: [],
  viewActivity: ['manager'],
  viewSales: ['manager'],
};

const shopCan = (role, capability) =>
  role === 'owner' || (SHOP_CAPABILITIES[capability] || []).includes(role);

const permissionsFor = (role) =>
  Object.fromEntries(Object.keys(SHOP_CAPABILITIES).map((key) => [key, shopCan(role, key)]));

const allowShopRoles = (...roles) => (req, res, next) => {
  const role = req.shop?.role || 'owner';

  if (role === 'owner' || roles.includes(role)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    code: 'ROLE_FORBIDDEN',
    message: `Your ${ROLE_LABELS[role] || role} account can't do this. Ask the shop owner.`,
  });
};

// Who did it, for logs and stock history
const actorOf = (req) => ({
  type: req.shop?.staffId ? 'staff' : 'owner',
  id: req.shop?.staffId || null,
  name: req.shop?.actorName || (req.shop?.staffId ? 'Staff' : 'Owner'),
  role: req.shop?.role || 'owner',
});

const SECRET_KEY = /pass|token|secret/i;

const sanitize = (value, depth = 0) => {
  if (value == null || depth > 3) return value ?? null;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
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

const recordShopActivity = async ({ shopId, actor, action, entityType = null, entityId = null, summary = null, details = null }) => {
  try {
    await pool.query(
      `
      INSERT INTO shop_activity_log (shop_id, actor_type, actor_id, actor_name, actor_role, action, entity_type, entity_id, summary, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        shopId,
        actor?.type || 'system',
        actor?.id ?? null,
        actor?.name ? String(actor.name).slice(0, 120) : null,
        actor?.role || null,
        String(action).slice(0, 80),
        entityType,
        entityId != null ? String(entityId).slice(0, 40) : null,
        summary ? String(summary).slice(0, 300) : null,
        details ? JSON.stringify(sanitize(details)) : null,
      ]
    );
  } catch (error) {
    console.error('❌ SHOP ACTIVITY ERROR:', action, error.message);
  }
};

const money = (value) => `Rs ${Number(value || 0).toFixed(2)}`;
const yesNo = (value) => (value === true || value === 'true' ? 'on' : 'off');

// Route (as written in shopRoutes.js) -> what the change was.
// Stock changes are described by the stock endpoint itself.
const AUDITED = {
  'POST /products': ['product.create', 'product', (req) => `Added ${req.body?.productName || 'a product'} at ${money(req.body?.price)}`],
  'PUT /products/:id': ['product.update', 'product', (req) => `Edited ${req.body?.productName || 'a product'} (price ${money(req.body?.price)})`],
  'PATCH /products/:id': ['product.quick_update', 'product', (req) => {
    const parts = [];
    if (typeof req.body?.isAvailable === 'boolean') parts.push(req.body.isAvailable ? 'made available' : 'made unavailable');
    if (req.body?.stockQuantity !== undefined) parts.push(`stock set to ${req.body.stockQuantity}`);
    return `Product ${parts.join(', ') || 'updated'}`;
  }],
  'DELETE /products/:id': ['product.delete', 'product', () => 'Deleted (or hid) a product'],
  'POST /products/:id/stock': ['stock.adjust', 'product', (req) => `Stock ${req.body?.mode || 'change'} ${req.body?.quantity ?? ''} (${req.body?.reason || 'no reason'})`],
  'POST /products/import': ['product.import', 'import', (req) => `Product import (${req.body?.mode || 'import'})`],
  'POST /offers': ['offer.create', 'offer', (req) => `Created offer ${req.body?.title || ''}`],
  'PATCH /offers/:id': ['offer.update', 'offer', (req) => (typeof req.body?.isActive === 'boolean' ? `Offer turned ${yesNo(req.body.isActive)}` : 'Edited an offer')],
  'DELETE /offers/:id': ['offer.delete', 'offer', () => 'Deleted an offer'],
  'PUT /profile': ['shop.profile', 'shop', () => 'Updated the shop profile'],
  'PATCH /open': ['shop.open', 'shop', (req) => (req.body?.isOpen ? 'Opened the shop' : 'Closed the shop')],
  'PUT /settings': ['shop.settings', 'shop', (req) => `Updated opening hours (auto open/close ${yesNo(req.body?.autoOpen)})`],
  'POST /staff': ['staff.create', 'staff', (req) => `Added ${req.body?.role || 'staff'} ${req.body?.fullName || ''}`],
  'PATCH /staff/:id': ['staff.update', 'staff', (req) => {
    const parts = [];
    if (typeof req.body?.isActive === 'boolean') parts.push(req.body.isActive ? 'reactivated' : 'deactivated');
    if (req.body?.role) parts.push(`role ${req.body.role}`);
    if (req.body?.password) parts.push('password reset');
    return `Staff ${parts.join(', ') || 'updated'}`;
  }],
  'PUT /password': ['account.password', 'account', () => 'Changed own password'],
};

const auditShopChanges = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.route || !req.shop?.shopId) return;
    const key = `${req.method} ${req.route.path}`;
    const [action, entityType, describe] = AUDITED[key] || [`${req.method.toLowerCase()} ${req.route.path}`, null, null];
    // Import previews change nothing
    if (key === 'POST /products/import' && req.body?.mode !== 'import') return;
    let summary = null;
    try {
      summary = describe ? describe(req) : null;
    } catch {
      summary = null;
    }
    recordShopActivity({
      shopId: req.shop.shopId,
      actor: actorOf(req),
      action,
      entityType,
      entityId: req.params?.id ?? null,
      summary,
      details: req.body,
    });
  });

  return next();
};

module.exports = {
  SHOP_ROLES,
  ROLE_LABELS,
  SHOP_CAPABILITIES,
  shopCan,
  permissionsFor,
  allowShopRoles,
  actorOf,
  recordShopActivity,
  auditShopChanges,
};
