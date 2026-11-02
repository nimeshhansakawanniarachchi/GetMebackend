const pool = require('../config/db');

// =====================================================
// MONEY PAID INTO GETME'S OWN LANKAQR (HelaPOS) - phase 55
//
// GetMe receives LankaQR payments through the HelaPOS app (Bhasha).
// HelaPOS has no API, webhook, transaction export or developer
// programme (research 2026-10-31), so GetMe can never learn about a
// payment automatically. This module is the manual reconciliation:
//
//   claim     a payer says "I paid Rs X, reference R" (customer for an
//             order, when switched on) or finance copies an entry from
//             the HelaPOS app (admin record). Status: manual_review.
//   evidence  a finance admin finds the payment in the HelaPOS app and
//             types its reference, amount, time and payer.
//   verify    a DIFFERENT finance admin (two people), with a note and a
//             recent two-step check, confirms it. The amount must equal
//             what was expected / claimed; one HelaPOS reference proves
//             one payment (unique). The database refuses 'verified'
//             without the evidence and decision fields.
//   reject    with a reason.
// A scan, a screenshot or a payer's word never makes a payment verified.
// Every status change is in payment_status_events (actor + reason).
// =====================================================

const STATUSES = ['manual_review', 'verified', 'rejected', 'cancelled', 'expired'];
const PURPOSES = ['order', 'cash_handover', 'other'];
const PAYER_APPS = ['helapay', 'bank_app', 'card', 'other'];

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const fail = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

const money = (value, field) => {
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text) || !(Number(text) > 0)) {
    throw fail(400, 'Enter the amount in rupees (e.g. 4520.50)', 'INVALID_AMOUNT', { field });
  }
  return round2(text);
};

const when = (value, field) => {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw fail(400, 'Enter the date and time of the payment', 'INVALID_TIME', { field });
  if (date.getTime() > Date.now() + 5 * 60 * 1000) throw fail(400, 'The payment time is in the future', 'INVALID_TIME', { field });
  return date;
};

const reference = (value, field) => {
  const text = clean(value, 60);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{3,59}$/.test(text)) {
    throw fail(400, 'Enter the transaction reference exactly as shown (4-60 letters / digits)', 'INVALID_REFERENCE', { field });
  }
  return text;
};

const setActor = (client, actor, reason) =>
  client.query("SELECT set_config('getme.actor', $1, true), set_config('getme.reason', $2, true)", [actor, reason ? clean(reason, 300) : '']);

const SELECT = `
  SELECT r.*, eb.full_name AS evidence_by_name, db.full_name AS decided_by_name,
         c.full_name AS customer_name, sh.full_name AS shopper_name
  FROM received_qr_payments r
  LEFT JOIN admins eb ON eb.id = r.evidence_by
  LEFT JOIN admins db ON db.id = r.decided_by
  LEFT JOIN customers c ON c.id = r.customer_id
  LEFT JOIN shoppers sh ON sh.id = r.shopper_id
`;

const toPublic = (row, { admin = false } = {}) =>
  row
    ? {
        id: Number(row.id),
        channel: row.channel,
        purpose: row.purpose,
        orderId: row.order_id != null ? Number(row.order_id) : null,
        status: row.status,
        expectedAmount: row.expected_amount != null ? round2(row.expected_amount) : null,
        claimedAmount: row.claimed_amount != null ? round2(row.claimed_amount) : null,
        claimedReference: row.claimed_reference,
        claimedPaidAt: row.claimed_paid_at,
        payerApp: row.payer_app,
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        // A customer sees the outcome, not who checked it
        ...(admin
          ? {
              customerId: row.customer_id != null ? Number(row.customer_id) : null,
              customerName: row.customer_name || null,
              shopperId: row.shopper_id != null ? Number(row.shopper_id) : null,
              shopperName: row.shopper_name || null,
              createdBy: { type: row.created_by_type, id: row.created_by_id != null ? Number(row.created_by_id) : null },
              evidence: row.helapos_reference
                ? {
                    helaposReference: row.helapos_reference,
                    amount: round2(row.helapos_amount),
                    paidAt: row.helapos_paid_at,
                    payer: row.helapos_payer,
                    by: { id: Number(row.evidence_by), name: row.evidence_by_name || null },
                    at: row.evidence_at,
                  }
                : null,
              decision: row.decided_by
                ? { by: { id: Number(row.decided_by), name: row.decided_by_name || null }, at: row.decided_at, note: row.decision_note }
                : null,
              updatedAt: row.updated_at,
            }
          : { note: row.status === 'rejected' ? row.decision_note : null }),
      }
    : null;

const rowById = async (client, id) => (await client.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0];

// -----------------------------------------------------
// Customer: "I paid GetMe's LankaQR for this order"
// Off unless CUSTOMER_LANKAQR_ENABLED=true (the order flow does not yet
// treat a verified QR payment as paid; see the phase 55 report).
// -----------------------------------------------------

const customerEnabled = () => String(process.env.CUSTOMER_LANKAQR_ENABLED || '').trim().toLowerCase() === 'true';

const customerClaim = async ({ customerId, orderId, body }) => {
  if (!customerEnabled()) {
    throw fail(409, 'Paying by LankaQR is not available yet. Pay by card or cash.', 'NOT_OFFERED');
  }
  const order = (
    await pool.query('SELECT id, customer_id, status, total_amount FROM orders WHERE id = $1 AND customer_id = $2', [Number(orderId), customerId])
  ).rows[0];
  if (!order) throw fail(404, 'Order not found', 'NOT_FOUND');
  if (order.status === 'cancelled') throw fail(409, 'This order was cancelled', 'ORDER_CANCELLED');

  const amount = money(body?.amount, 'amount');
  const ref = reference(body?.reference, 'reference');
  const paidAt = when(body?.paidAt || new Date().toISOString(), 'paidAt');
  const payerApp = PAYER_APPS.includes(body?.payerApp) ? body.payerApp : null;
  const requestId = clean(body?.requestId, 80) || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setActor(client, `customer:${customerId}`, 'Customer reported a LankaQR payment');
    const row = (
      await client.query(
        `INSERT INTO received_qr_payments (purpose, order_id, customer_id, expected_amount, claimed_amount, claimed_reference,
           claimed_paid_at, payer_app, request_id, created_by_type, created_by_id)
         VALUES ('order', $1, $2, $3, $4, $5, $6, $7, $8, 'customer', $2)
         ON CONFLICT (created_by_type, created_by_id, request_id) WHERE request_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [order.id, customerId, round2(order.total_amount) || null, amount, ref, paidAt, payerApp, requestId]
      )
    ).rows[0];
    const id =
      row?.id ||
      (await client.query("SELECT id FROM received_qr_payments WHERE created_by_type = 'customer' AND created_by_id = $1 AND request_id = $2", [customerId, requestId])).rows[0]?.id;
    await client.query('COMMIT');
    return { payment: toPublic(await rowById(pool, id)), duplicate: !row, message: 'Sent to GetMe. Your payment is checked in our LankaQR records before it counts.' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const customerList = async ({ customerId, orderId }) => {
  const rows = (
    await pool.query(`${SELECT} WHERE r.customer_id = $1 AND r.order_id = $2 ORDER BY r.id DESC LIMIT 20`, [customerId, Number(orderId)])
  ).rows;
  return { payments: rows.map((row) => toPublic(row)), enabled: customerEnabled() };
};

// -----------------------------------------------------
// Admin
// -----------------------------------------------------

const adminList = async (query = {}) => {
  const where = ['TRUE'];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (STATUSES.includes(query.status)) add('r.status = ?', query.status);
  if (PURPOSES.includes(query.purpose)) add('r.purpose = ?', query.purpose);
  if (Number(query.orderId) > 0) add('r.order_id = ?::int', Number(query.orderId));
  if (query.from) add('r.created_at >= ?::timestamptz', String(query.from));
  if (query.to) add("r.created_at < (?::date + INTERVAL '1 day')", String(query.to).slice(0, 10));
  if (query.q) add('(r.claimed_reference ILIKE ? OR r.helapos_reference ILIKE $' + (params.length + 1) + ')', `%${clean(query.q, 40)}%`);
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(query.pageSize, 10) || 25));
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM received_qr_payments r WHERE ${where.join(' AND ')}`, params)).rows[0].n);
  const rows = (
    await pool.query(
      `${SELECT} WHERE ${where.join(' AND ')} ORDER BY (r.status = 'manual_review') DESC, r.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    )
  ).rows;
  const counts = (await pool.query('SELECT status, COUNT(*)::int AS n FROM received_qr_payments GROUP BY status')).rows;
  return {
    payments: rows.map((row) => toPublic(row, { admin: true })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    customerFlowEnabled: customerEnabled(),
  };
};

const adminGet = async (id) => {
  const row = await rowById(pool, Number(id));
  if (!row) throw fail(404, 'Payment not found', 'NOT_FOUND');
  const trail = (
    await pool.query(
      "SELECT field, from_value, to_value, actor, reason, created_at FROM payment_status_events WHERE source = 'received_qr_payments' AND source_id = $1 ORDER BY id",
      [row.id]
    )
  ).rows;
  return { payment: toPublic(row, { admin: true }), trail };
};

// Finance copies a payment from the HelaPOS app (e.g. a shopper's cash
// hand-over or a payment nobody claimed). Evidence is typed now; a
// second admin verifies it.
const adminRecord = async (body = {}, adminId) => {
  const purpose = PURPOSES.includes(body.purpose) ? body.purpose : null;
  if (!purpose) throw fail(400, 'Choose what the payment is for', 'INVALID', { field: 'purpose' });
  const amount = money(body.amount, 'amount');
  const ref = reference(body.helaposReference, 'helaposReference');
  const paidAt = when(body.paidAt, 'paidAt');
  const note = clean(body.note, 300);
  if (note.length < 3) throw fail(400, 'Say where you found this payment', 'NOTE_REQUIRED', { field: 'note' });

  const orderId = Number(body.orderId) > 0 ? Number(body.orderId) : null;
  const shopperId = Number(body.shopperId) > 0 ? Number(body.shopperId) : null;
  let customerId = null;
  let expected = body.expectedAmount != null && body.expectedAmount !== '' ? money(body.expectedAmount, 'expectedAmount') : null;
  if (purpose === 'order') {
    const order = orderId && (await pool.query('SELECT id, customer_id, total_amount FROM orders WHERE id = $1', [orderId])).rows[0];
    if (!order) throw fail(404, 'Order not found', 'NOT_FOUND', { field: 'orderId' });
    customerId = Number(order.customer_id);
    expected = expected ?? round2(order.total_amount);
  }
  if (purpose === 'cash_handover' && !shopperId) throw fail(400, 'Choose the shopper who handed over cash', 'INVALID', { field: 'shopperId' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setActor(client, `admin:${adminId}`, note);
    const row = (
      await client.query(
        `INSERT INTO received_qr_payments (purpose, order_id, customer_id, shopper_id, expected_amount, claimed_amount,
           helapos_reference, helapos_amount, helapos_paid_at, helapos_payer, evidence_by, evidence_at,
           decision_note, created_by_type, created_by_id)
         VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, NOW(), NULL, 'admin', $10)
         RETURNING id`,
        [purpose, orderId, customerId, shopperId, expected, ref, amount, paidAt, clean(body.payer, 60) || null, adminId]
      )
    ).rows[0];
    await client.query('COMMIT');
    return {
      payment: toPublic(await rowById(pool, row.id), { admin: true }),
      message: 'Recorded. Another finance admin must verify it.',
      audit: { summary: `Recorded HelaPOS payment ${ref} Rs ${amount.toFixed(2)} (${purpose}${orderId ? ` order #${orderId}` : ''}): ${note}`.slice(0, 300) },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw fail(409, 'This HelaPOS reference is already recorded', 'DUPLICATE_REFERENCE', { field: 'helaposReference' });
    throw error;
  } finally {
    client.release();
  }
};

// PATCH /api/admin/payments/received-qr/:id { action, ... }
//   evidence { helaposReference, amount, paidAt, payer }
//   verify   { note }
//   reject   { note }
const adminAction = async (id, body = {}, adminId) => {
  const action = String(body.action || '');
  if (!['evidence', 'verify', 'reject'].includes(action)) throw fail(400, 'Choose evidence, verify or reject');
  const note = clean(body.note, 300);
  if (action !== 'evidence' && note.length < 3) throw fail(400, 'Say what you checked (at least 3 characters)', 'NOTE_REQUIRED', { field: 'note' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setActor(client, `admin:${adminId}`, note || `HelaPOS ${action}`);
    const row = (await client.query('SELECT * FROM received_qr_payments WHERE id = $1 FOR UPDATE', [Number(id)])).rows[0];
    if (!row) throw fail(404, 'Payment not found', 'NOT_FOUND');
    if (row.status !== 'manual_review') throw fail(409, `This payment is already ${row.status}`, 'WRONG_STATUS');

    let summary;
    if (action === 'evidence') {
      const ref = reference(body.helaposReference, 'helaposReference');
      const amount = money(body.amount, 'amount');
      const paidAt = when(body.paidAt, 'paidAt');
      await client.query(
        `UPDATE received_qr_payments SET helapos_reference = $2, helapos_amount = $3, helapos_paid_at = $4, helapos_payer = $5,
           evidence_by = $6, evidence_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [row.id, ref, amount, paidAt, clean(body.payer, 60) || null, adminId]
      );
      summary = `Added HelaPOS evidence ${ref} Rs ${amount.toFixed(2)} to received payment #${row.id}`;
    } else if (action === 'verify') {
      if (!row.helapos_reference) throw fail(409, 'Add the HelaPOS evidence first (reference, amount and time from the HelaPOS app)', 'NO_EVIDENCE');
      if (Number(row.evidence_by) === Number(adminId)) {
        throw fail(409, 'Another finance admin must verify evidence you entered', 'SAME_ADMIN');
      }
      const found = round2(row.helapos_amount);
      for (const [label, value] of [['expected', row.expected_amount], ['claimed', row.claimed_amount]]) {
        if (value != null && Math.abs(round2(value) - found) > 0.009) {
          throw fail(409, `The HelaPOS amount Rs ${found.toFixed(2)} is not the ${label} Rs ${round2(value).toFixed(2)}. Reject it or correct the evidence.`, 'AMOUNT_MISMATCH');
        }
      }
      if (row.claimed_paid_at && Math.abs(new Date(row.claimed_paid_at) - new Date(row.helapos_paid_at)) > 3 * 24 * 60 * 60 * 1000) {
        throw fail(409, 'The HelaPOS payment time is more than 3 days from the time the payer gave. Check it is the same payment.', 'TIME_MISMATCH');
      }
      await client.query(
        `UPDATE received_qr_payments SET status = 'verified', decided_by = $2, decided_at = NOW(), decision_note = $3, updated_at = NOW() WHERE id = $1`,
        [row.id, adminId, note]
      );
      summary = `Verified HelaPOS payment ${row.helapos_reference} Rs ${found.toFixed(2)} (received payment #${row.id}): ${note}`;
    } else {
      await client.query(
        `UPDATE received_qr_payments SET status = 'rejected', decided_by = $2, decided_at = NOW(), decision_note = $3, updated_at = NOW() WHERE id = $1`,
        [row.id, adminId, note]
      );
      summary = `Rejected received payment #${row.id}: ${note}`;
    }
    await client.query('COMMIT');
    return { payment: toPublic(await rowById(pool, row.id), { admin: true }), audit: { summary: summary.slice(0, 300) } };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw fail(409, 'This HelaPOS reference already proves another payment', 'DUPLICATE_REFERENCE', { field: 'helaposReference' });
    if (error.code === '23514') throw fail(409, 'A verified payment needs complete HelaPOS evidence and a second admin', 'EVIDENCE_REQUIRED');
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { STATUSES, customerEnabled, customerClaim, customerList, adminList, adminGet, adminRecord, adminAction, toPublic };
