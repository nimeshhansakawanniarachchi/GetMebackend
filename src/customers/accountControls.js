const pool = require('../config/db');

const notifications = require('../admin/notifications');

// =====================================================
// CUSTOMER ACCOUNT CONTROLS (phase 44; columns from phase 42)
//
// customers.account_status:
//   active      normal
//   restricted  card payments only: cash on delivery is refused at
//               quote / Place order (403 CARD_ONLY)
//   blocked     can't sign in (403 ACCOUNT_BLOCKED), every customer API
//               and socket connection is refused. Orders already in
//               progress keep running for shoppers / admins.
// Cash-on-delivery limit: a cash order whose total is above the limit is
// refused (409 CASH_LIMIT). Limit = customers.cod_limit, else
// customer_controls_settings.default_cod_limit, else no limit.
// =====================================================

const STATUSES = ['active', 'restricted', 'blocked'];

const STATUS_LABELS = {
  active: 'Active',
  restricted: 'Card payments only',
  blocked: 'Blocked',
};

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const money = (value) => `Rs ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const numOrNull = (value) => (value == null ? null : round2(value));

const BLOCKED_MESSAGE = 'Your GetMe account is blocked. Please contact GetMe support for help.';

const blockedBody = () => ({ success: false, code: 'ACCOUNT_BLOCKED', message: BLOCKED_MESSAGE });

// ---------------------------------------------------
// Settings (one row)
// ---------------------------------------------------

const getSettings = async (client = pool) => {
  const row = (await client.query('SELECT * FROM customer_controls_settings WHERE id = 1')).rows[0] || {};
  return {
    defaultCodLimit: numOrNull(row.default_cod_limit),
    creditApprovalLimit: round2(row.credit_approval_limit ?? 5000),
    supportReportWindowHours: Number(row.support_report_window_hours ?? 48),
    updatedAt: row.updated_at || null,
    updatedBy: row.updated_by != null ? Number(row.updated_by) : null,
  };
};

// The customer's controls (+ the platform default limit) in one query
const controlsFor = async (customerId, client = pool, { lock = false } = {}) => {
  const row = (
    await client.query(
      `SELECT c.id, c.account_status, c.status_reason, c.cod_limit, s.default_cod_limit
       FROM customers c LEFT JOIN customer_controls_settings s ON s.id = 1
       WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`,
      [customerId]
    )
  ).rows[0];

  if (!row) return null;

  const customerLimit = numOrNull(row.cod_limit);
  const defaultLimit = numOrNull(row.default_cod_limit);

  return {
    status: row.account_status || 'active',
    reason: row.status_reason || null,
    customerCodLimit: customerLimit,
    defaultCodLimit: defaultLimit,
    codLimit: customerLimit ?? defaultLimit,
    codLimitSource: customerLimit != null ? 'customer' : defaultLimit != null ? 'default' : 'none',
  };
};

// Can this order total be paid in cash? -> { allowed, code, reason, limit }
const cashOption = (controls, total) => {
  const limit = controls?.codLimit ?? null;

  if (!controls || controls.status === 'blocked') {
    return { allowed: false, code: 'ACCOUNT_BLOCKED', reason: BLOCKED_MESSAGE, limit };
  }

  if (controls.status === 'restricted') {
    return {
      allowed: false,
      code: 'CARD_ONLY',
      reason: 'Cash on delivery is not available on your account. Please pay by card.',
      limit,
    };
  }

  if (limit != null && Number(total) > limit + 0.009) {
    return {
      allowed: false,
      code: 'CASH_LIMIT',
      reason: `Cash on delivery is available for orders up to ${money(limit)}. Please pay by card.`,
      limit,
    };
  }

  return { allowed: true, code: null, reason: null, limit };
};

// Additive quote field: which payment methods are allowed and why
const paymentOptionsFor = (controls, total) => ({
  cash: cashOption(controls, total),
  card: { allowed: !controls || controls.status !== 'blocked', code: null, reason: null },
});

// HTTP status for a cash refusal code
const cashRefusalStatus = (code) => (code === 'CASH_LIMIT' ? 409 : 403);

// ---------------------------------------------------
// Notifications (customers category; first name + initial only)
// ---------------------------------------------------

const shortName = (fullName) => {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};

const notifyStatusChange = async ({ customerId, fullName, from, to, adminId, adminName, logId }) => {
  const who = shortName(fullName) || `Customer #${customerId}`;
  const titles = {
    blocked: `Customer blocked: ${who}`,
    restricted: `Customer restricted to card payments: ${who}`,
    active: `Customer back to active: ${who}`,
  };

  await notifications.notify({
    category: 'customers',
    event: `customer.${to}`,
    severity: to === 'blocked' ? 'warning' : 'info',
    title: titles[to],
    body: `${STATUS_LABELS[from] || from} -> ${STATUS_LABELS[to]}${adminName ? ` · by ${adminName}` : ''}`,
    entityType: 'customer',
    entityId: customerId,
    permissions: ['customers.view'],
    actorAdminId: adminId || null,
    dedupe: `customer.status:${customerId}:${logId}`,
  });
};

// ---------------------------------------------------
// Risk indicators (GET /customers/:id/risk)
// Simple, documented rules - indicators for staff to look at, not a
// fraud score. Each one says what triggered it.
// ---------------------------------------------------

const RULES = [
  {
    key: 'refund_share',
    label: 'Refunds on more than 30% of delivered orders',
    test: (r) => r.orders.delivered >= 3 && r.refunds.orderShare > 0.3,
  },
  {
    key: 'failed_cash_deliveries',
    label: '2 or more failed cash deliveries',
    test: (r) => r.orders.cashFailedDeliveries >= 2,
  },
  {
    key: 'failed_deliveries',
    label: '3 or more failed deliveries',
    test: (r) => r.orders.failedDeliveries >= 3,
  },
  {
    key: 'customer_cancellations',
    label: 'Cancelled more than half of their orders (5+ orders)',
    test: (r) => r.orders.total >= 5 && r.orders.cancelledByCustomer / r.orders.total > 0.5,
  },
  {
    key: 'card_failures',
    label: '3 or more declined card payments in the last 30 days',
    test: (r) => r.cardPayments.failedLast30Days >= 3,
  },
  {
    key: 'support_cases',
    label: '3 or more support cases in the last 30 days',
    test: (r) => r.support.casesLast30Days >= 3,
  },
  {
    key: 'credit_share',
    label: 'GetMe credit issued above 20% of delivered order value',
    test: (r) => r.orders.deliveredValue > 0 && r.support.creditIssued / r.orders.deliveredValue > 0.2,
  },
  {
    key: 'new_account_cash',
    label: 'Account under 7 days old with a failed cash delivery',
    test: (r) => r.account.ageDays < 7 && r.orders.cashFailedDeliveries >= 1,
  },
];

const riskFor = async (customerId) => {
  const row = (
    await pool.query(
      `
      SELECT
        c.id, c.created_at, c.account_status,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id)::int AS orders,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'delivered')::int AS delivered,
        (SELECT COALESCE(SUM(o.total_amount), 0) FROM orders o WHERE o.customer_id = c.id AND o.status = 'delivered')::float AS delivered_value,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'cancelled' AND o.cancelled_by = 'customer')::int AS cancelled_by_customer,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.failed_delivery_at IS NOT NULL)::int AS failed,
        (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.failed_delivery_at IS NOT NULL AND o.payment_method = 'cash')::int AS cash_failed,
        (SELECT COUNT(*) FROM card_payments cp WHERE cp.owner_type = 'customer' AND cp.owner_id = c.id
           AND cp.purpose IN ('order', 'order_extra') AND cp.status = 'failed')::int AS card_failed,
        (SELECT COUNT(*) FROM card_payments cp WHERE cp.owner_type = 'customer' AND cp.owner_id = c.id
           AND cp.purpose IN ('order', 'order_extra') AND cp.status = 'failed' AND cp.created_at >= NOW() - INTERVAL '30 days')::int AS card_failed_30,
        (SELECT COUNT(*) FROM support_cases sc WHERE sc.customer_id = c.id)::int AS cases,
        (SELECT COUNT(*) FROM support_cases sc WHERE sc.customer_id = c.id AND sc.created_at >= NOW() - INTERVAL '30 days')::int AS cases_30,
        (SELECT COALESCE(SUM(ce.amount), 0) FROM customer_credit_entries ce WHERE ce.customer_id = c.id AND ce.kind = 'issued')::float AS credit_issued,
        (SELECT COALESCE(SUM(ce.amount), 0) FROM customer_credit_entries ce WHERE ce.customer_id = c.id)::float AS credit_balance
      FROM customers c WHERE c.id = $1
      `,
      [customerId]
    )
  ).rows[0];

  if (!row) return null;

  // Refunds staff gave (not automatic ones for unavailable items or a
  // cancellation): admin refunds (order.refund, audited) + support cases
  // resolved with a card refund
  const refunds = (
    await pool.query(
      `
      WITH given AS (
        SELECT a.entity_id::int AS order_id, (a.details->>'amount')::numeric AS amount
        FROM admin_audit_log a
        JOIN orders o ON o.id::text = a.entity_id AND o.customer_id = $1
        WHERE a.action = 'order.refund' AND a.entity_type = 'order' AND a.outcome = 'success'
          AND (a.details->>'amount') ~ '^[0-9]+(\\.[0-9]+)?$'
        UNION ALL
        SELECT sc.order_id, sc.resolution_amount
        FROM support_cases sc
        WHERE sc.customer_id = $1 AND sc.resolution_type = 'card_refund' AND sc.resolution_amount > 0
      )
      SELECT COUNT(*)::int AS refunds, COUNT(DISTINCT order_id)::int AS orders, COALESCE(SUM(amount), 0)::float AS amount FROM given
      `,
      [customerId]
    )
  ).rows[0];

  const ageDays = Math.max(0, Math.floor((Date.now() - new Date(row.created_at).getTime()) / 86400000));
  const deliveredValue = round2(row.delivered_value);

  const report = {
    customerId: Number(row.id),
    accountStatus: row.account_status,
    account: { createdAt: row.created_at, ageDays },
    orders: {
      total: row.orders,
      delivered: row.delivered,
      deliveredValue,
      cancelledByCustomer: row.cancelled_by_customer,
      failedDeliveries: row.failed,
      cashFailedDeliveries: row.cash_failed,
    },
    cardPayments: { failed: row.card_failed, failedLast30Days: row.card_failed_30 },
    refunds: {
      count: refunds.refunds,
      orders: refunds.orders,
      amount: round2(refunds.amount),
      // Orders refunded / delivered orders; amount / delivered value
      orderShare: row.delivered > 0 ? round2(refunds.orders / row.delivered) : 0,
      valueShare: deliveredValue > 0 ? round2(refunds.amount / deliveredValue) : 0,
    },
    support: {
      cases: row.cases,
      casesLast30Days: row.cases_30,
      creditIssued: round2(row.credit_issued),
      creditBalance: round2(row.credit_balance),
    },
  };

  report.indicators = RULES.filter((rule) => rule.test(report)).map(({ key, label }) => ({ key, label }));
  report.rules = RULES.map(({ key, label }) => ({ key, label }));
  report.note = 'Indicators are simple rules to help staff look closer. They are not a fraud score.';

  return report;
};

module.exports = {
  STATUSES,
  STATUS_LABELS,
  BLOCKED_MESSAGE,
  blockedBody,
  getSettings,
  controlsFor,
  cashOption,
  paymentOptionsFor,
  cashRefusalStatus,
  notifyStatusChange,
  shortName,
  riskFor,
  RULES,
};
