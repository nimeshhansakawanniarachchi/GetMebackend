const pool = require('../config/db');

// =====================================================
// ALL PAYMENTS, ONE STATUS VOCABULARY (phase 55, payment audit)
//
// Each payment table keeps its own statuses (they drive their own
// flows). This module maps every one of them onto the canonical
// statuses below, in SQL, so the admin panel can list and filter every
// kind of payment together. It reads only; nothing here changes money.
//
// Canonical statuses:
//   INITIATED      created, nothing sent to a provider yet
//   PENDING        waiting for the payer / the next step
//   PROCESSING     with the provider / bank, answer expected
//   SUCCESS        confirmed (how: verified_by)
//   FAILED         declined / refused / rejected after review
//   CANCELLED      stopped before money moved
//   EXPIRED        never finished in time
//   UNKNOWN        no clear answer from the provider: NOT paid, NOT failed
//   MANUAL_REVIEW  a person must check it before it counts
//   REFUNDED       given back in full
//   PARTIALLY_REFUNDED  part given back (card payments)
// UNKNOWN / PENDING / MANUAL_REVIEW are never SUCCESS.
//
// verified_by says what confirmed a SUCCESS:
//   provider        a signed / authenticated provider answer (PayHere)
//   bank_statement  an admin matched it to GetMe's bank statement
//   admin           an admin reviewed it (recorded with their id)
//   two_admins      HelaPOS evidence entered and verified by two admins
//   receipt_rules   shopper's own money: bill photo + amount within
//                   tolerance, nothing unusual (not bank-verified)
//   test_gateway    PAYHERE_MODE=test fake gateway (no money)
//   simulator       test simulator (no money)
// =====================================================

const STATUSES = [
  'INITIATED', 'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED',
  'EXPIRED', 'UNKNOWN', 'MANUAL_REVIEW', 'REFUNDED', 'PARTIALLY_REFUNDED',
];

const KINDS = {
  card: 'Customer card (PayHere)',
  cash: 'Customer cash on delivery',
  helapos: 'HelaPOS received (GetMe LankaQR)',
  supermarket: 'Supermarket payment',
  fuel: 'Fuel station payment',
  refund: 'Card refund',
  payout: 'Shopper withdrawal',
};

// Every source: the same columns, in the same order
const SOURCES = {
  card: `
    SELECT 'card'::text AS kind, cp.id::bigint AS id, 'card_payments'::text AS source_table,
      cp.ref::text AS reference, cp.gateway_payment_id::text AS provider_reference,
      'payhere'::text AS provider, cp.gateway::text AS environment, cp.purpose::text AS method,
      CASE WHEN cp.owner_type = 'customer' THEN cp.owner_id END AS customer_id,
      CASE WHEN cp.owner_type = 'shopper' THEN cp.owner_id END AS shopper_id,
      cp.order_id, 'getme'::text AS merchant_type, NULL::int AS merchant_id, 'GetMe (PayHere)'::text AS merchant_name,
      cp.amount AS expected_amount,
      CASE WHEN cp.status IN ('paid', 'partially_refunded', 'refunded') THEN cp.amount END AS actual_amount,
      cp.refunded_amount, cp.currency::text AS currency, cp.status::text AS source_status,
      CASE
        WHEN cp.chargeback_at IS NOT NULL THEN 'MANUAL_REVIEW'
        WHEN cp.status = 'pending' AND cp.abandoned_at IS NULL THEN 'PROCESSING'
        WHEN cp.status = 'pending' THEN 'UNKNOWN'
        WHEN cp.status = 'paid' THEN 'SUCCESS'
        WHEN cp.status = 'failed' THEN 'FAILED'
        WHEN cp.status = 'refunded' THEN 'REFUNDED'
        WHEN cp.status = 'partially_refunded' THEN 'PARTIALLY_REFUNDED'
        ELSE 'UNKNOWN' END AS status,
      CASE WHEN cp.status IN ('paid', 'partially_refunded', 'refunded')
           THEN CASE WHEN cp.gateway = 'test' THEN 'test_gateway' ELSE 'provider' END END AS verified_by,
      (cp.gateway <> 'live') AS is_test,
      cp.status_message::text AS note,
      cp.created_at::timestamptz AS created_at, cp.updated_at::timestamptz AS updated_at
    FROM card_payments cp`,

  cash: `
    SELECT 'cash'::text, o.id::bigint, 'orders'::text,
      ('ORDER-' || o.id)::text, NULL::text,
      'cash_on_delivery'::text, NULL::text, 'cash'::text,
      o.customer_id, o.shopper_id,
      o.id, 'getme'::text, NULL::int, 'GetMe (cash to shopper)'::text,
      o.total_amount, NULLIF(e.cash_collected, 0), 0::numeric, 'LKR'::text,
      COALESCE(e.cash_status, o.status)::text,
      CASE
        WHEN o.status = 'cancelled' THEN 'CANCELLED'
        WHEN e.cash_status IN ('deposited', 'netted') THEN 'SUCCESS'
        WHEN COALESCE(e.cash_collected, 0) > 0 THEN 'MANUAL_REVIEW'
        ELSE 'PENDING' END,
      CASE WHEN e.cash_status IN ('deposited', 'netted') THEN 'admin' END,
      FALSE,
      CASE WHEN COALESCE(e.cash_collected, 0) > 0 AND e.cash_status NOT IN ('deposited', 'netted')
           THEN 'Collected by the shopper; hand-over to GetMe not recorded yet' END::text,
      o.created_at::timestamptz, COALESCE(e.updated_at, o.created_at)::timestamptz
    FROM orders o
    LEFT JOIN shopper_earnings e ON e.order_id = o.id
    WHERE o.payment_method = 'cash'`,

  helapos: `
    SELECT 'helapos'::text, r.id::bigint, 'received_qr_payments'::text,
      COALESCE(r.helapos_reference, r.claimed_reference)::text, r.helapos_reference::text,
      'helapos'::text, 'live'::text, r.purpose::text,
      r.customer_id, r.shopper_id,
      r.order_id, 'getme'::text, NULL::int, 'GetMe (HelaPOS LankaQR)'::text,
      COALESCE(r.expected_amount, r.claimed_amount), CASE WHEN r.status = 'verified' THEN r.helapos_amount END, 0::numeric, 'LKR'::text,
      r.status::text,
      CASE r.status WHEN 'manual_review' THEN 'MANUAL_REVIEW' WHEN 'verified' THEN 'SUCCESS' WHEN 'rejected' THEN 'FAILED'
                    WHEN 'cancelled' THEN 'CANCELLED' WHEN 'expired' THEN 'EXPIRED' ELSE 'UNKNOWN' END,
      CASE WHEN r.status = 'verified' THEN 'two_admins' END,
      FALSE,
      r.decision_note::text,
      r.created_at, r.updated_at
    FROM received_qr_payments r`,

  supermarket: `
    SELECT 'supermarket'::text, a.id::bigint, 'grocery_payment_attempts'::text,
      COALESCE(a.reference, a.qr_reference)::text, a.provider_ref::text,
      CASE WHEN a.method IN ('getme_lankaqr', 'lankaqr_bank') THEN COALESCE(a.provider, 'none')
           WHEN a.method = 'getme_card' THEN 'company_card'
           ELSE 'shopper_own' END::text,
      CASE WHEN a.provider = 'simulator' THEN 'simulator' END::text,
      a.method::text,
      o.customer_id, a.shopper_id,
      a.order_id, 'supermarket'::text, a.shop_id, s.shop_name::text,
      a.expected_amount, a.amount, 0::numeric, a.currency::text,
      a.status::text,
      CASE
        -- phase 56: waiting for the shopper to approve at their bank
        WHEN a.status = 'pending' AND a.provider_status = 'action_required' THEN 'PENDING'
        WHEN a.status = 'cancelled' AND a.provider_status = 'expired' THEN 'EXPIRED'
        WHEN a.status = 'pending' AND a.provider IS NOT NULL AND a.initiated_at IS NULL THEN 'INITIATED'
        WHEN a.status = 'pending' AND a.provider IS NOT NULL THEN 'PROCESSING'
        WHEN a.status = 'pending' AND a.created_at < NOW() - INTERVAL '1 day' THEN 'EXPIRED'
        WHEN a.status = 'pending' THEN 'PENDING'
        WHEN a.status = 'unknown' THEN 'UNKNOWN'
        WHEN a.status = 'disputed' THEN 'MANUAL_REVIEW'
        WHEN a.status = 'succeeded' AND a.reconciliation_status = 'mismatch' THEN 'MANUAL_REVIEW'
        WHEN a.status = 'succeeded' AND a.funding = 'getme' AND a.reconciliation_status = 'unreconciled'
             AND a.verification NOT IN ('provider', 'simulator') THEN 'MANUAL_REVIEW'
        -- a bank / provider confirmation is enough; otherwise the bill photo comes first
        WHEN a.status = 'succeeded' AND a.reconciliation_status = 'unreconciled' AND a.verification NOT IN ('provider', 'simulator') THEN 'PENDING'
        WHEN a.status = 'succeeded' THEN 'SUCCESS'
        WHEN a.status IN ('failed', 'rejected') THEN 'FAILED'
        WHEN a.status = 'cancelled' THEN 'CANCELLED'
        WHEN a.status = 'reversed' THEN 'REFUNDED'
        ELSE 'UNKNOWN' END,
      CASE WHEN a.status = 'succeeded' THEN
        CASE WHEN a.verification = 'provider' THEN 'provider'
             WHEN a.verification = 'simulator' THEN 'simulator'
             WHEN a.verification = 'statement' THEN 'bank_statement'
             WHEN a.reconciled_by IS NOT NULL THEN 'admin'
             WHEN a.reconciliation_status = 'matched' THEN 'receipt_rules' END END,
      (a.provider = 'simulator'),
      COALESCE(a.reconciliation_note, a.failure_reason, a.provider_message,
        CASE WHEN a.status = 'succeeded' AND a.reconciliation_status = 'unreconciled' THEN 'Waiting for the bill photo' END)::text,
      a.created_at, a.updated_at
    FROM grocery_payment_attempts a
    LEFT JOIN shops s ON s.id = a.shop_id
    LEFT JOIN orders o ON o.id = a.order_id`,

  fuel: `
    SELECT 'fuel'::text, f.id::bigint, 'fuel_payments'::text,
      f.payer_reference::text, f.provider_ref::text,
      COALESCE(f.provider, 'shopper_own')::text, CASE WHEN f.provider = 'simulator' THEN 'simulator' END::text, (f.payment_method || ':' || f.fuel_type)::text,
      NULL::int, f.shopper_id,
      NULL::int, 'fuel_station'::text, f.station_id, st.name::text,
      f.amount, f.amount_paid, 0::numeric, 'LKR'::text,
      f.status::text,
      CASE
        -- phase 56: bank payments (provider)
        WHEN f.status = 'started' AND f.provider IS NOT NULL AND f.provider_status = 'action_required' THEN 'PENDING'
        WHEN f.status = 'started' AND f.provider IS NOT NULL AND f.provider_status = 'unknown' THEN 'UNKNOWN'
        WHEN f.status = 'started' AND f.provider IS NOT NULL AND f.initiated_at IS NOT NULL THEN 'PROCESSING'
        WHEN f.status = 'cancelled' AND f.provider_status = 'expired' THEN 'EXPIRED'
        WHEN f.status = 'started' AND f.created_at < NOW() - INTERVAL '1 day' THEN 'EXPIRED'
        WHEN f.status = 'started' THEN 'INITIATED'
        WHEN f.status = 'reported' THEN 'MANUAL_REVIEW'
        WHEN f.status = 'verified' THEN 'SUCCESS'
        WHEN f.status = 'rejected' THEN 'FAILED'
        WHEN f.status = 'cancelled' THEN 'CANCELLED'
        ELSE 'UNKNOWN' END,
      CASE WHEN f.status = 'verified' THEN CASE f.verification WHEN 'provider' THEN 'provider' WHEN 'simulator' THEN 'simulator' ELSE 'admin' END END,
      COALESCE(f.provider = 'simulator', FALSE),
      COALESCE(f.review_note, f.provider_message)::text,
      f.created_at, f.updated_at
    FROM fuel_payments f
    LEFT JOIN fuel_stations st ON st.id = f.station_id`,

  refund: `
    SELECT 'refund'::text, rr.id::bigint, 'card_payment_refund_requests'::text,
      cp.ref::text, rr.gateway_refund_id::text,
      'payhere'::text, cp.gateway::text, CASE WHEN rr.full_refund THEN 'full' ELSE 'partial' END::text,
      CASE WHEN cp.owner_type = 'customer' THEN cp.owner_id END, CASE WHEN cp.owner_type = 'shopper' THEN cp.owner_id END,
      cp.order_id, 'getme'::text, NULL::int, 'GetMe (PayHere)'::text,
      rr.amount, CASE WHEN rr.status = 'succeeded' THEN rr.amount END, 0::numeric, 'LKR'::text,
      rr.status::text,
      CASE rr.status WHEN 'requested' THEN 'PROCESSING' WHEN 'succeeded' THEN 'SUCCESS' WHEN 'refused' THEN 'FAILED'
                     WHEN 'unknown' THEN 'UNKNOWN' ELSE 'UNKNOWN' END,
      CASE WHEN rr.status = 'succeeded' THEN CASE WHEN rr.resolved_by IS NOT NULL THEN 'admin'
                                                  WHEN cp.gateway = 'test' THEN 'test_gateway' ELSE 'provider' END END,
      (cp.gateway <> 'live'),
      COALESCE(rr.resolved_note, rr.gateway_message, rr.reason)::text,
      rr.created_at, rr.updated_at
    FROM card_payment_refund_requests rr
    LEFT JOIN card_payments cp ON cp.id = rr.card_payment_id`,

  payout: `
    SELECT 'payout'::text, w.id::bigint, 'shopper_withdrawals'::text,
      w.reference::text, NULL::text,
      'bank_transfer_manual'::text, NULL::text, 'withdrawal'::text,
      NULL::int, w.shopper_id,
      NULL::int, 'shopper'::text, NULL::int, 'Shopper bank account'::text,
      w.payout_amount, CASE WHEN w.status = 'paid' THEN w.payout_amount END, 0::numeric, 'LKR'::text,
      w.status::text,
      CASE WHEN w.status IN ('pending', 'approved') THEN 'PENDING' WHEN w.status = 'processing' THEN 'PROCESSING'
           WHEN w.status = 'paid' THEN 'SUCCESS' WHEN w.status IN ('failed', 'rejected') THEN 'FAILED'
           WHEN w.status = 'cancelled' THEN 'CANCELLED' ELSE 'UNKNOWN' END,
      CASE WHEN w.status = 'paid' THEN 'admin' END,
      FALSE,
      w.reason::text,
      w.requested_at, w.updated_at
    FROM shopper_withdrawals w`,
};

// Column names of every source (only the first SELECT names them)
const COLUMNS = [
  'kind', 'id', 'source_table', 'reference', 'provider_reference', 'provider', 'environment', 'method',
  'customer_id', 'shopper_id', 'order_id', 'merchant_type', 'merchant_id', 'merchant_name',
  'expected_amount', 'actual_amount', 'refunded_amount', 'currency', 'source_status', 'status',
  'verified_by', 'is_test', 'note', 'created_at', 'updated_at',
].join(', ');

const unionFor = (kinds) => kinds.map((kind) => SOURCES[kind]).join('\nUNION ALL\n');

const toPublic = (row) => ({
  kind: row.kind,
  kindLabel: KINDS[row.kind],
  id: Number(row.id),
  sourceTable: row.source_table,
  reference: row.reference,
  providerReference: row.provider_reference,
  provider: row.provider,
  environment: row.environment,
  method: row.method,
  customerId: row.customer_id != null ? Number(row.customer_id) : null,
  shopperId: row.shopper_id != null ? Number(row.shopper_id) : null,
  orderId: row.order_id != null ? Number(row.order_id) : null,
  merchant: { type: row.merchant_type, id: row.merchant_id != null ? Number(row.merchant_id) : null, name: row.merchant_name },
  expectedAmount: row.expected_amount != null ? Number(row.expected_amount) : null,
  actualAmount: row.actual_amount != null ? Number(row.actual_amount) : null,
  refundedAmount: Number(row.refunded_amount || 0),
  currency: row.currency,
  sourceStatus: row.source_status,
  status: row.status,
  verifiedBy: row.verified_by,
  isTest: Boolean(row.is_test),
  note: row.note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// GET /api/admin/payments/transactions
//   kind, status (canonical), provider, from, to (YYYY-MM-DD), orderId,
//   shopperId, customerId, merchantId, merchant (name), q (reference),
//   test=exclude|only, page, pageSize
const list = async (query = {}) => {
  const kinds = String(query.kind || '')
    .split(',')
    .filter((kind) => SOURCES[kind]);
  const union = unionFor(kinds.length ? kinds : Object.keys(SOURCES));
  const where = ['TRUE'];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.split('?').join(`$${params.length}`));
  };
  const id = (value) => (Number.parseInt(value, 10) > 0 ? Number.parseInt(value, 10) : null);

  const statuses = String(query.status || '').split(',').filter((s) => STATUSES.includes(s));
  if (statuses.length) add('t.status = ANY(?::text[])', statuses);
  if (query.provider) add('t.provider = ?', String(query.provider).slice(0, 30));
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.from || ''))) add("t.created_at >= (?::date AT TIME ZONE 'Asia/Colombo')", query.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to || ''))) add("t.created_at < ((?::date + 1) AT TIME ZONE 'Asia/Colombo')", query.to);
  if (id(query.orderId)) add('t.order_id = ?::int', id(query.orderId));
  if (id(query.shopperId)) add('t.shopper_id = ?::int', id(query.shopperId));
  if (id(query.customerId)) add('t.customer_id = ?::int', id(query.customerId));
  if (id(query.merchantId)) add('t.merchant_id = ?::int', id(query.merchantId));
  if (query.merchant) add('t.merchant_name ILIKE ?', `%${String(query.merchant).slice(0, 60)}%`);
  if (query.q) add('(t.reference ILIKE ? OR t.provider_reference ILIKE ?)', `%${String(query.q).slice(0, 60)}%`);
  if (query.test === 'exclude') where.push('NOT t.is_test');
  if (query.test === 'only') where.push('t.is_test');

  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(query.pageSize, 10) || 25));
  const base = `FROM (${union}) AS t(${COLUMNS}) WHERE ${where.join(' AND ')}`;

  const [rows, totals] = await Promise.all([
    pool.query(`SELECT t.* ${base} ORDER BY t.created_at DESC, t.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params),
    pool.query(`SELECT t.status, COUNT(*)::int AS n, COALESCE(SUM(t.expected_amount), 0)::numeric AS amount ${base} GROUP BY t.status`, params),
  ]);
  const total = totals.rows.reduce((sum, row) => sum + row.n, 0);

  return {
    transactions: rows.rows.map(toPublic),
    summary: Object.fromEntries(totals.rows.map((row) => [row.status, { count: row.n, amount: Number(row.amount) }])),
    statuses: STATUSES,
    kinds: KINDS,
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
};

// GET /api/admin/payments/transactions/:kind/:id - one payment, its
// status trail, and kind-specific detail
const detail = async (kind, rawId) => {
  if (!SOURCES[kind]) throw Object.assign(new Error('Unknown payment kind'), { status: 400 });
  const id = Number.parseInt(rawId, 10);
  const row = (await pool.query(`SELECT t.* FROM (${SOURCES[kind]}) AS t(${COLUMNS}) WHERE t.id = $1`, [id])).rows[0];
  if (!row) throw Object.assign(new Error('Payment not found'), { status: 404 });
  const transaction = toPublic(row);

  const trail = (
    await pool.query(
      `SELECT field, from_value, to_value, actor, reason, created_at FROM payment_status_events
       WHERE source = $1 AND source_id = $2 ORDER BY id`,
      [row.source_table, id]
    )
  ).rows.map((event) => ({
    field: event.field,
    from: event.from_value,
    to: event.to_value,
    actor: event.actor,
    reason: event.reason,
    at: event.created_at,
  }));

  const extra = {};
  if (kind === 'card') {
    extra.refunds = (
      await pool.query(
        `SELECT id, amount, full_refund, status, gateway_refund_id, gateway_message, reason, resolved_note, created_at, updated_at
         FROM card_payment_refund_requests WHERE card_payment_id = $1 ORDER BY id`,
        [id]
      )
    ).rows;
    const card = (await pool.query('SELECT chargeback_at, chargeback_note, late_success_at, abandoned_at, status_checks, last_checked_at, card_brand, card_last4 FROM card_payments WHERE id = $1', [id])).rows[0];
    extra.card = card;
  }
  if (kind === 'supermarket') {
    const attempt = (await pool.query('SELECT qr_check, payer_app, verification, reconciliation_status, statement_reference, reconciled_by, reconciled_at, over_limit, funding FROM grocery_payment_attempts WHERE id = $1', [id])).rows[0];
    extra.attempt = attempt;
  }
  if (kind === 'fuel') {
    extra.events = (
      await pool.query('SELECT event, from_status, to_status, actor_type, actor_id, note, created_at FROM fuel_payment_events WHERE payment_id = $1 ORDER BY id', [id])
    ).rows;
  }

  return { transaction, trail, ...extra };
};

module.exports = { STATUSES, KINDS, SOURCES, list, detail };
