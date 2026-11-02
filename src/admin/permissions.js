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
  // Phase 42+
  'orders.dispatch': { group: 'Orders', label: 'Release an order from its shopper, offer it to a chosen shopper, re-dispatch' },
  'customers.view': { group: 'Customers', label: 'View customer details' },
  'customers.manage': { group: 'Customers', label: 'Block or restrict customers, set cash-on-delivery limits' },
  // Phase 51: customer activity history (location is the more sensitive one)
  'customers.activity': { group: 'Customers', label: 'Customer activity: online status, sign-in and online history, activity timeline' },
  'customers.location': { group: 'Customers', label: 'Customer location history, recorded routes and last known location (each view is recorded)' },
  'support.cases': { group: 'Customers', label: 'Work the support case queue (reply, assign, close)' },
  'support.credit': { group: 'Customers', label: 'Give customers GetMe credit (large amounts need Super Admin approval)' },
  'incidents.manage': { group: 'Operations', label: 'Handle shopper help requests (incidents)' },
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
  // Phase 55: money paid into GetMe's own LankaQR (HelaPOS has no API)
  'finance.received_qr': { group: 'Finance', label: "Record and verify payments received on GetMe's HelaPOS LankaQR (a second admin verifies)" },
  'grocery.view': { group: 'Finance', label: 'View supermarket payments, limits and methods' },
  'grocery.manage': { group: 'Finance', label: 'Reconcile supermarket payments, change limits and methods' },
  'grocery.cards': { group: 'Finance', label: 'GetMe company cards and their funds' },
  // Phase 54: fuel station payments (shopper expense records) + providers
  'fuel.view': { group: 'Finance', label: 'View fuel station payments, stations, prices and payment providers' },
  'fuel.manage': { group: 'Finance', label: 'Manage fuel stations, station QR codes and fuel prices; verify or reject fuel payments' },
  // Phase 50: GetMe's own bank accounts (records; masked numbers)
  'company_accounts.view': { group: 'Finance', label: 'View GetMe company bank accounts (masked numbers)' },
  'company_accounts.manage': { group: 'Finance', label: 'Add, edit and deactivate company bank accounts; ask the Super Admin to activate them or change defaults / funding' },

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
  'company_accounts.reveal': { group: 'Super Admin only', label: 'See a full company bank account number (with a reason; recorded)', ownerOnly: true },
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
    'orders.dispatch', 'customers.manage', 'support.cases', 'incidents.manage',
    // Phase 51
    'customers.activity', 'customers.location',
    // Phase 54
    'fuel.view', 'fuel.manage',
  ],
  finance: [
    'dashboard.view', 'orders.view', 'customers.view', 'shoppers.view', 'shops.view',
    'pricing.view', 'pricing.review', 'reports.view', 'exports.orders', 'exports.finance',
    'finance.view', 'finance.refund', 'finance.store_bills', 'finance.settlements', 'finance.adjust',
    'finance.withdrawals', 'grocery.view', 'grocery.manage', 'grocery.cards',
    'support.credit',
    // Phase 55
    'finance.received_qr',
    // Phase 50
    'company_accounts.view', 'company_accounts.manage',
    // Phase 54
    'fuel.view', 'fuel.manage',
  ],
  support: [
    'dashboard.view', 'orders.view', 'orders.notes', 'orders.chat', 'customers.view',
    'shoppers.view', 'shopper_applications.list', 'shops.view', 'pricing.view', 'liveops.view',
    'support.cases', 'support.credit', 'incidents.manage',
    // Phase 51: activity, not location (a Super Admin can grant it)
    'customers.activity',
    // Phase 54: read fuel payments (support questions)
    'fuel.view',
  ],
  // Technical work only: no customer data, money or staff
  developer: ['system.health', 'system.logs'],
};

const clean = (list) => [...new Set((Array.isArray(list) ? list : []).map(String))].filter((key) => GRANTABLE.includes(key));

// Effective permissions of an admin row ({ role, permission_grants, permission_revokes })
const effectivePermissions = (admin) => {
  // Security review B-26: an unknown or missing role gets nothing
  const role = admin?.role;
  if (!ROLES.includes(role)) return [];
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
