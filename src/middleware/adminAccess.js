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

// Phase 40: roles + granular permissions live in src/admin/permissions.js
// ('owner' = Super Admin). Routes are guarded with requirePermission;
// allowRoles stays for older callers.
const { ROLES, ROLE_LABELS, PERMISSIONS } = require('../admin/permissions');

const allowRoles = (...roles) => (req, res, next) => {
  const role = req.admin?.role;

  if (role === 'owner' || roles.includes(role)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    code: 'ROLE_FORBIDDEN',
    message: `Your role (${ROLE_LABELS[role] || role || 'unknown'}) can't do this. Ask the Super Admin for access.`,
  });
};

const adminCan = (req, permission) => Boolean(req.admin?.permissions?.has(permission));

// Route guard: the admin needs at least one of the permissions. A
// denied attempt is written to the audit log as a security event.
const requirePermission = (...permissions) => (req, res, next) => {
  if (permissions.some((permission) => adminCan(req, permission))) {
    return next();
  }

  recordAdminAudit({
    admin: req.admin,
    action: 'security.denied',
    entityType: 'route',
    entityId: null,
    summary: `${req.method} ${req.baseUrl}${req.route?.path || req.path} needs ${permissions.join(' or ')}`,
    outcome: 'denied',
    ip: req.ip,
  });

  return res.status(403).json({
    success: false,
    code: 'PERMISSION_DENIED',
    permission: permissions[0],
    message: `You don't have permission for this (${PERMISSIONS[permissions[0]]?.label || permissions[0]}). Ask the Super Admin for access.`,
  });
};

// Never store secrets or PINs in the log
// Never kept in the audit log: credentials and (phase 37) identity /
// bank numbers an admin may send when registering a shopper
const SECRET_KEY = /pass|token|secret|pin|cvv|card_?number|account_?number|nic|licen[cs]e_?number|otp|proof/i;

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

  // Phase 40: a card-number-like run of digits (12-19, spaces / dashes
  // allowed) is masked wherever it appears, whatever the field is called
  // (refused requests are logged too, with what was sent)
  if (typeof value === 'string') return maskCardNumbers(value).slice(0, 300);
  if (typeof value === 'number' && Number.isInteger(value) && String(Math.abs(value)).length >= 12) return maskCardNumbers(String(value));
  return value;
};

const maskCardNumbers = (text) =>
  String(text).replace(/\d(?:[ -]?\d){11,18}/g, (match) => `••••${match.replace(/\D/g, '').slice(-4)}`);

// outcome: success | failed | denied; before / after: the record's
// relevant values around the change (sanitised like details)
const recordAdminAudit = async ({ admin, action, entityType = null, entityId = null, summary = null, details = null, ip = null, outcome = 'success', before = null, after = null }) => {
  try {
    await pool.query(
      `
      INSERT INTO admin_audit_log (admin_id, admin_name, admin_role, action, entity_type, entity_id, summary, details, ip, outcome, before_value, after_value)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `,
      [
        admin?.adminId ?? null,
        admin?.fullName ?? null,
        admin?.role ?? null,
        String(action).slice(0, 80),
        entityType,
        entityId != null ? String(entityId).slice(0, 40) : null,
        summary ? maskCardNumbers(String(summary)).slice(0, 300) : null,
        details ? JSON.stringify(sanitize(details)) : null,
        ip ? String(ip).slice(0, 64) : null,
        ['success', 'failed', 'denied'].includes(outcome) ? outcome : 'success',
        before != null ? JSON.stringify(sanitize(before)) : null,
        after != null ? JSON.stringify(sanitize(after)) : null,
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
  'PATCH /pricing/reports/:id': ['pricing.report_review', 'price_report', (req) => (req.body?.adminStatus === 'open' ? 'Reopened a shelf price report' : 'Resolved a shelf price report')],
  'PATCH /store-payments/:id/review': ['store_payment.review', 'store_payment', (req) =>
    `${{ approve: 'Approved', query: 'Queried', release: 'Released without customer payment' }[req.body?.action] || 'Reviewed'} store bill${req.body?.note ? `: ${req.body.note}` : ''}`],
  'PATCH /store-payments/:id/reimburse': ['store_payment.reimburse', 'store_payment', (req) => `Reimbursed (ref ${req.body?.reference || ''})`],
  // Supermarket payments (phase 38)
  'PATCH /grocery-payments/:id': ['grocery_payment.update', 'grocery_payment', (req) =>
    `${req.body?.action || 'Updated'}${req.body?.result ? ` ${req.body.result}` : ''}${req.body?.outcome ? ` ${req.body.outcome}` : ''}${req.body?.statementReference ? ` (statement ${String(req.body.statementReference).slice(0, 60)})` : ''}`],
  'PATCH /grocery-reservations/:id/limit': ['grocery_limit.change', 'grocery_reservation', (req) => `Spending limit ${req.body?.limit === null ? 'back to computed' : `set to Rs ${req.body?.limit}`}: ${String(req.body?.note || '').slice(0, 120)}`],
  'PATCH /grocery-payment-methods/:key': ['grocery_method.update', 'grocery_payment_method', (req) => `${req.params.key}: ${req.body?.enabled === true ? 'switched on' : req.body?.enabled === false ? 'switched off' : 'instructions edited'}`],
  'PUT /grocery-payment-methods/:key/shops/:shopId': ['grocery_method.shop', 'grocery_payment_method', (req) => `${req.params.key} at shop ${req.params.shopId}: ${req.body?.enabled === null ? 'default' : req.body?.enabled ? 'on' : 'off'}`],
  'PATCH /grocery-payment-settings': ['grocery_settings.update', 'grocery_payment_settings', (req) => `Limit buffer ${req.body?.limitBufferPercent}% / at least Rs ${req.body?.limitBufferMin}`],
  'POST /getme-cards': ['getme_card.create', 'getme_card', (req) => `Registered ${String(req.body?.issuer || '').slice(0, 60)} card ••${String(req.body?.last4 || '').slice(-4)}`],
  'PATCH /getme-cards/:id': ['getme_card.update', 'getme_card', (req) => `Card updated${req.body?.status ? `: ${req.body.status}` : ''}${req.body?.shopperId !== undefined ? ` (shopper ${req.body.shopperId ?? 'none'})` : ''}`],
  'POST /getme-cards/:id/funds': ['getme_card.funds', 'getme_card', (req) => `${req.body?.kind === 'unload' ? 'Removed' : 'Added'} Rs ${req.body?.amount} (bank ref ${String(req.body?.reference || '').slice(0, 60)})`],
  'POST /shopper-registrations': ['shopper.register', 'shopper', (req) => `Registered a shopper: ${String(req.body?.fullName || '').slice(0, 80)}`],
  'PATCH /shopper-registrations/:applicationId/steps': ['shopper.register_edit', 'shopper_application', (req) => `Edited the ${req.body?.step || ''} step of a registration`],
  'POST /shopper-registrations/:applicationId/documents': ['shopper.register_document', 'shopper_application', (req) => `Uploaded ${req.body?.docType || 'a document'} for a registration`],
  'POST /shopper-registrations/:applicationId/submit': ['shopper.register_submit', 'shopper_application', () => 'Submitted a registration for review (consent recorded)'],
  'POST /shoppers/:id/activation-code': ['shopper.activation_code', 'shopper', () => 'Issued an activation code'],
  'PATCH /shopper-applications/:id/documents/:docId': ['shopper_application.document_review', 'shopper_application', (req) =>
    `${req.body?.decision === 'reject' ? 'Rejected' : 'Accepted'} an application document${req.body?.note ? `: ${String(req.body.note).slice(0, 120)}` : ''}`],
  'PATCH /shopper-change-requests/:id/documents/:docId': ['shopper_change.document_review', 'shopper_change_request', (req) =>
    `${req.body?.decision === 'reject' ? 'Rejected' : 'Accepted'} a change request document${req.body?.note ? `: ${String(req.body.note).slice(0, 120)}` : ''}`],
  'PATCH /shopper-change-requests/:id': ['shopper_change.review', 'shopper_change_request', (req) =>
    `${{ approve: 'Approved', reject: 'Rejected', request_info: 'Requested more information on' }[req.body?.action] || 'Updated'} a shopper change request${req.body?.reason ? `: ${String(req.body.reason).slice(0, 120)}` : ''}`],
  'PATCH /shoppers/:id/vehicle-restriction': ['shopper.vehicle_restriction', 'shopper', (req) =>
    req.body?.restricted === false ? 'Lifted the vehicle restriction' : `Restricted the vehicle: ${String(req.body?.reason || '').slice(0, 120)}`],
  'PATCH /shopper-applications/:id': ['shopper_application.review', 'shopper_application', (req) =>
    `${{ start_review: 'Started review of', request_info: 'Requested more information on', approve: 'Approved', reject: 'Rejected', confirm_phone: 'Confirmed the phone number on', delete_documents: 'Deleted the documents of' }[req.body?.action] || 'Updated'} shopper application${req.body?.reason ? `: ${String(req.body.reason).slice(0, 120)}` : ''}`],
  'POST /settlements/shoppers/:shopperId/cash-settlements': ['shopper.cash_handover', 'shopper', (req) =>
    `Recorded cash hand-over of Rs ${Number(req.body?.amount || 0).toFixed(2)}${req.body?.reference ? ` (receipt ${req.body.reference})` : ''}`],
  'POST /settlements/shoppers/:shopperId/payouts': ['shopper.payout', 'shopper', (req) =>
    `Recorded ${req.body?.kind || 'payout'} ${money(req.body?.amount)} (ref ${req.body?.reference || ''})`],
  'PATCH /settlements/earnings/:orderId/dispute': ['earning.hold', 'order', (req) => `Earnings on hold: ${req.body?.note || ''}`],
  'PATCH /settlements/earnings/:orderId/resolve': ['earning.resolve', 'order', (req) => `Earnings ${req.body?.action === 'void' ? 'voided' : 'released'}`],
  'PATCH /settlements/earnings/:orderId/adjust': ['earning.adjust', 'order', (req) => `Adjustment ${money(req.body?.amount)}: ${req.body?.note || ''}`],
  'PATCH /withdrawals/:id': ['withdrawal.update', 'withdrawal', (req) => {
    const what = { approve: 'Approved', process: 'Marked processing', pay: 'Recorded payout', fail: 'Marked failed', reject: 'Rejected' }[req.body?.action] || 'Updated';
    return `${what} withdrawal #${req.params.id}${req.body?.reference ? ` (ref ${String(req.body.reference).slice(0, 60)})` : ''}${req.body?.reason ? `: ${String(req.body.reason).slice(0, 200)}` : ''}`;
  }],
  'PATCH /payout-accounts/:id': ['payout_account.review', 'payout_account', (req) =>
    `${req.body?.action === 'verify' ? 'Verified' : 'Rejected'} bank account #${req.params.id}${req.body?.note ? `: ${String(req.body.note).slice(0, 200)}` : ''}`],
  'PUT /settings/pricing': ['settings.pricing', 'settings', (req) =>
    req.body?.effectiveFrom ? `Scheduled fees & pricing from ${String(req.body.effectiveFrom).slice(0, 25)}` : 'Updated fees & pricing'],
  'DELETE /settings/pricing/versions/:id': ['settings.pricing_cancel', 'pricing_version', (req) => `Cancelled scheduled pricing #${req.params.id}`],
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
  // Phase 40
  'POST /admins/:id/reset-password': ['admin.password_reset', 'admin', () => 'Reset a staff password (temporary password issued)'],
  'PUT /security-settings': ['security.settings', 'security', (req) => `Approval limits: refunds Rs ${req.body?.refundApprovalLimit}, earnings adjustments Rs ${req.body?.earningsAdjustApprovalLimit}`],
  'PATCH /approvals/:id': ['approval.decide', 'approval', (req) => `${req.body?.decision || 'decided'}: ${String(req.body?.note || '').slice(0, 120)}`],
  'POST /approvals/:id/cancel': ['approval.cancel', 'approval', () => 'Cancelled own approval request'],
  'POST /orders/:id/notes': ['order.note', 'order', (req) => `Support note (${req.body?.category || 'general'})`],
  // Phase 41
  'PUT /notifications/settings': ['notifications.policy', 'notifications', () => 'Changed the notification policy'],
  // Phase 47: shop onboarding checklist (controller adds before / after)
  'PATCH /shops/:id/onboarding': ['shop.onboarding', 'shop', () => 'Updated the shop onboarding checklist'],
  // Phase 43: support cases + GetMe credit
  'PATCH /support/cases/:id/assign': ['support_case.assign', 'support_case', (req) => (req.body?.adminId == null ? 'Unassigned a support case' : `Assigned a support case to ${req.body.adminId === 'me' ? 'self' : `admin #${req.body.adminId}`}`)],
  'PATCH /support/cases/:id/status': ['support_case.status', 'support_case', (req) => `Support case status: ${req.body?.status || ''}`],
  'POST /support/cases/:id/reply': ['support_case.reply', 'support_case', (req) => `Replied to the customer${req.body?.waitingForCustomer ? ' (waiting for customer)' : ''}`],
  'POST /support/cases/:id/notes': ['support_case.note', 'support_case', () => 'Internal note on a support case'],
  'POST /support/cases/:id/resolve': ['support_case.resolve', 'support_case', (req) => `${req.body?.type === 'declined' ? 'Declined' : 'Resolved without money'}: ${String(req.body?.note || '').slice(0, 150)}`],
  'POST /support/cases/:id/credit': ['support_case.credit', 'support_case', (req) => `Resolved with GetMe credit ${money(req.body?.amount)}`],
  'POST /support/cases/:id/refund': ['support_case.refund', 'support_case', (req) => `Resolved with a card refund of ${money(req.body?.amount)}`],
  'POST /customers/:id/credit': ['customer.credit', 'customer', (req) => `Gave GetMe credit ${money(req.body?.amount)}: ${String(req.body?.reason || '').slice(0, 150)}`],
  // Phase 44: customer account controls (controllers add before / after)
  'PATCH /customers/:id/status': ['customer.status', 'customer', (req) => `Account status -> ${req.body?.status || ''}${req.body?.reason ? `: ${String(req.body.reason).slice(0, 150)}` : ''}`],
  'PATCH /customers/:id/cod-limit': ['customer.cod_limit', 'customer', (req) => `Cash-on-delivery limit -> ${req.body?.codLimit == null || req.body?.codLimit === '' ? 'platform default' : money(req.body.codLimit)}`],
  'PUT /customer-controls/settings': ['customer.settings', 'settings', () => 'Changed the customer control settings'],
  // Phase 46: shopper documents, training quiz, incidents (controllers add before / after)
  'PATCH /shoppers/:id/documents': ['shopper.documents', 'shopper', () => 'Changed document expiry dates'],
  'PUT /shopper-training/settings': ['shopper_training.settings', 'shopper_training', (req) =>
    `Shopper training ${req.body?.trainingRequired === true ? 'required' : req.body?.trainingRequired === false ? 'not required' : 'settings changed'}`],
  'POST /incidents/:id/acknowledge': ['incident.acknowledge', 'incident', () => 'Acknowledged a shopper incident'],
  'POST /incidents/:id/resolve': ['incident.resolve', 'incident', (req) => `Resolved a shopper incident: ${String(req.body?.note || '').slice(0, 150)}`],
  'POST /incidents/:id/notes': ['incident.note', 'incident', () => 'Note on a shopper incident'],
  // Phase 45: dispatch control + shopper cash limit (controllers add before / after)
  'POST /orders/:id/release-shopper': ['order.dispatch_release', 'order', (req) =>
    `Released the shopper${req.body?.confirmShopping ? ' (while shopping)' : ''}: ${String(req.body?.reason || '').slice(0, 200)}`],
  'POST /orders/:id/offer-shopper': ['order.dispatch_offer', 'order', (req) =>
    `Offered to shopper #${req.body?.shopperId || ''}${req.body?.exclusive ? ' (exclusive)' : ''}: ${String(req.body?.reason || '').slice(0, 200)}`],
  'POST /orders/:id/redispatch': ['order.redispatch', 'order', (req) => `Re-dispatched: ${String(req.body?.reason || '').slice(0, 200)}`],
  'PUT /dispatch-settings': ['dispatch.settings', 'settings', (req) =>
    `Dispatch settings${req.body?.shopperCashLimit !== undefined ? `: shopper cash limit Rs ${req.body.shopperCashLimit}` : ''}${req.body?.exclusiveOfferMinutes !== undefined ? `, exclusive offers ${req.body.exclusiveOfferMinutes} min` : ''}`],
};

const auditAdminChanges = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }

  res.on('finish', () => {
    // Denied (401/403) attempts are logged by requirePermission; a
    // refused change (other 4xx / 5xx) is logged with outcome 'failed'
    if (!req.route || res.statusCode === 401 || res.statusCode === 403) return;
    // Reading / dismissing own notifications and own preferences are not audited (phase 41)
    if (res.locals?.skipAudit) return;
    const failed = res.statusCode >= 400;
    // Controllers can add before / after values (res.locals.audit)
    const extra = res.locals?.audit || {};

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
      action: extra.action || action,
      entityType: extra.entityType || entityType,
      entityId: extra.entityId ?? entityId,
      summary: failed ? `Refused (${res.statusCode}): ${summary || action}`.slice(0, 300) : extra.summary || summary,
      details: failed ? { status: res.statusCode, request: req.body } : req.body,
      ip: req.ip,
      outcome: failed ? 'failed' : 'success',
      before: failed ? null : extra.before ?? null,
      after: failed ? null : extra.after ?? null,
    });
  });

  return next();
};

module.exports = {
  ROLES,
  ROLE_LABELS,
  allowRoles,
  adminCan,
  requirePermission,
  auditAdminChanges,
  recordAdminAudit,
};
