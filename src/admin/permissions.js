// =====================================================
// ADMIN PERMISSIONS (phase 40, 2026-10-29)
//
// Every admin route checks a permission (middleware/adminAccess.js
// requirePermission). A staff member's permissions = their role's
// defaults + permissions the Super Admin granted - ones revoked
// (admins.permission_grants / permission_revokes). The Super Admin
// ('owner' role, shown as "Super Admin") has every permission and is
// the only one who manages staff, permissions, approvals and security
// settings: those permissions can't be granted to anyone else.
// Least privilege: anything not listed for a role is denied.
// =====================================================

const PERMISSIONS = {
  // Operations / support basics
  'dashboard.view': { group: 'General', label: 'Dashboard, overview, issues and search' },
  'orders.view': { group: 'Orders', label: 'View orders and order status' },
  'orders.cancel': { group: 'Orders', label: 'Cancel orders / mark failed delivery' },
  'orders.notes': { group: 'Orders', label: 'Add support notes to orders' },
  'orders.chat': { group: 'Orders', label: 'Read customer-shopper chat of an order' },
  'customers.view': { group: 'Customers', label: 'View customer details' },
  'shoppers.view': { group: 'Shoppers', label: 'View shoppers' },
  'shoppers.manage': { group: 'Shoppers', label: 'Approve shoppers, review applications and change requests, register shoppers' },
  'shopper_applications.list': { group: 'Shoppers', label: 'See the shopper application list (no identity data)' },
  'shops.view': { group: 'Shops & products', label: 'View shops and products' },
  'shops.manage': { group: 'Shops & products', label: 'Change shop status, products, offers' },
  'promos.manage': { group: 'Shops & products', label: 'Create and change promo codes' },
  'pricing.view': { group: 'Shops & products', label: 'View prices, price history and price reports' },
  'pricing.review': { group: 'Shops & products', label: 'Resolve shelf price reports' },
  'liveops.view': { group: 'Operations', label: 'Live map (customer addresses, shopper phones and positions)' },
  'reports.view': { group: 'Reports', label: 'Reports, analytics and the fees & pricing settings (read)' },
  'exports.orders': { group: 'Reports', label: 'Export orders' },
  'exports.finance': { group: 'Reports', label: 'Export finance data' },

  // Finance
  'finance.view': { group: 'Finance', label: 'Payments, ledger, reconciliation, settlements, withdrawals (read)' },
  'finance.refund': { group: 'Finance', label: 'Refund customers (large refunds need Super Admin approval)' },
  'finance.store_bills': { group: 'Finance', label: 'Review store bills / reimbursements' },
  'finance.settlements': { group: 'Finance', label: 'Record payouts and cash hand-overs, hold / release earnings' },
  'finance.adjust': { group: 'Finance', label: 'Adjust shopper earnings (large adjustments need Super Admin approval)' },
  'finance.withdrawals': { group: 'Finance', label: 'Process shopper withdrawals and verify bank accounts' },
  'grocery.view': { group: 'Finance', label: 'View supermarket payments, limits and methods' },
  'grocery.manage': { group: 'Finance', label: 'Reconcile supermarket payments, change limits and methods' },
  'grocery.cards': { group: 'Finance', label: 'GetMe company cards and their funds' },

  // Developer
  'system.health': { group: 'Technical', label: 'Application health and integration status (no secrets)' },
  'system.logs': { group: 'Technical', label: 'Technical error log (no customer data)' },

  // Super Admin only (never grantable)
  'settings.pricing': { group: 'Super Admin only', label: 'Change fees & pricing', ownerOnly: true },
  'admins.manage': { group: 'Super Admin only', label: 'Create, edit, deactivate staff and reset passwords', ownerOnly: true },
  'permissions.manage': { group: 'Super Admin only', label: 'Assign roles and permissions', ownerOnly: true },
  'approvals.decide': { group: 'Super Admin only', label: 'Approve or reject high-risk financial actions', ownerOnly: true },
  'security.settings': { group: 'Super Admin only', label: 'Approval limits and security settings', ownerOnly: true },
  'audit.view': { group: 'Super Admin only', label: 'Audit log and security events', ownerOnly: true },
};

const ALL = Object.keys(PERMISSIONS);
const GRANTABLE = ALL.filter((key) => !PERMISSIONS[key].ownerOnly);

const ROLES = ['owner', 'operations', 'finance', 'support', 'developer'];

const ROLE_LABELS = {
  owner: 'Super Admin',
  operations: 'Operations Officer',
  finance: 'Finance Officer',
  support: 'Customer Support Officer',
  developer: 'Developer',
};

// Defaults keep what each existing role could already do (phase 26-38)
const ROLE_PERMISSIONS = {
  owner: ALL,
  operations: [
    'dashboard.view', 'orders.view', 'orders.cancel', 'orders.notes', 'customers.view',
    'shoppers.view', 'shoppers.manage', 'shopper_applications.list',
    'shops.view', 'shops.manage', 'promos.manage', 'pricing.view', 'pricing.review',
    'liveops.view', 'reports.view', 'exports.orders', 'grocery.view',
  ],
  finance: [
    'dashboard.view', 'orders.view', 'customers.view', 'shoppers.view', 'shops.view',
    'pricing.view', 'pricing.review', 'reports.view', 'exports.orders', 'exports.finance',
    'finance.view', 'finance.refund', 'finance.store_bills', 'finance.settlements', 'finance.adjust',
    'finance.withdrawals', 'grocery.view', 'grocery.manage', 'grocery.cards',
  ],
  support: [
    'dashboard.view', 'orders.view', 'orders.notes', 'orders.chat', 'customers.view',
    'shoppers.view', 'shopper_applications.list', 'shops.view', 'pricing.view', 'liveops.view',
  ],
  // Technical work only: no customer data, money or staff
  developer: ['system.health', 'system.logs'],
};

const clean = (list) => [...new Set((Array.isArray(list) ? list : []).map(String))].filter((key) => GRANTABLE.includes(key));

// Effective permissions of an admin row ({ role, permission_grants, permission_revokes })
const effectivePermissions = (admin) => {
  const role = admin?.role || 'owner';
  if (role === 'owner') return [...ALL];
  const base = new Set(ROLE_PERMISSIONS[role] || []);
  clean(admin.permission_grants).forEach((key) => base.add(key));
  clean(admin.permission_revokes).forEach((key) => base.delete(key));
  // Owner-only permissions never leak to other roles
  return ALL.filter((key) => base.has(key) && !PERMISSIONS[key].ownerOnly);
};

const catalogue = () =>
  ALL.map((key) => ({ key, ...PERMISSIONS[key], ownerOnly: Boolean(PERMISSIONS[key].ownerOnly) }));

module.exports = {
  PERMISSIONS,
  ALL,
  GRANTABLE,
  ROLES,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  clean,
  effectivePermissions,
  catalogue,
};
