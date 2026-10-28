const pool = require('../../config/db');
const sc = require('../../support/supportCases');
const credit = require('../../support/credit');
const { effectivePermissions } = require('../../admin/permissions');
const { adminCan } = require('../../middleware/adminAccess');
const { heldForOrder, refundOrderAmount } = require('../../payments/paymentService');

// =====================================================
// ADMIN: SUPPORT CASES + GETME CREDIT (phase 43)
// Base /api/admin. Permissions in routes/adminRoutes.js:
//   support.cases   queue, detail, assign, status, reply, notes,
//                   resolve (declined | no_money)
//   support.credit  resolve with GetMe credit; give credit to a customer
//                   (over customer_controls_settings.credit_approval_limit
//                   -> Super Admin approval 'customer.credit')
//   finance.refund  resolve with a card refund (over refund_approval_limit
//                   -> Super Admin approval 'support.refund')
//   customers.view  a customer's credit balance + history
// A case is resolved once: the case row is locked and a closed case
// answers 409 CASE_CLOSED.
// =====================================================

const toId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const round2 = credit.round2;
const MAX_CREDIT = 100000;
const REQUEST_ID = /^[A-Za-z0-9_:-]{8,64}$/;

const fail = (res, status, message, code) => res.status(status).json({ success: false, code, message });

const loadStaffCase = async (caseId, client = pool) =>
  (await client.query(`${sc.STAFF_SELECT} WHERE c.id = $1`, [caseId])).rows[0] || null;

// -----------------------------------------------------
// Queue
// GET /support/cases?status=active|needs_action|open|in_progress|waiting_customer|resolved|declined|all
//   &category=&assigned=me|unassigned|any&overdue=1&orderId=&customerId=&page=&pageSize=
// -----------------------------------------------------

const STATUS_FILTERS = {
  active: "c.status NOT IN ('resolved', 'declined')",
  needs_action: "c.status IN ('open', 'in_progress')",
  all: null,
};
const OVERDUE_SQL = "(c.first_response_at IS NULL AND c.status NOT IN ('resolved', 'declined') AND c.first_response_due_at < NOW())";

const listCases = async (req, res) => {
  const q = req.query || {};
  const page = Math.max(1, Number.parseInt(q.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(q.pageSize, 10) || 20));
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.split('?').join(`$${params.length}`));
  };

  const status = String(q.status || 'active');
  if (sc.STATUSES.includes(status)) add('c.status = ?', status);
  else if (STATUS_FILTERS[status]) where.push(STATUS_FILTERS[status]);
  else if (status !== 'all') return fail(res, 400, 'Unknown status filter', 'INVALID_FILTER');

  if (q.category) {
    if (!sc.CATEGORIES.includes(String(q.category))) return fail(res, 400, 'Unknown category', 'INVALID_FILTER');
    add('c.category = ?', String(q.category));
  }
  if (q.assigned === 'me') add('c.assigned_admin_id = ?', Number(req.admin.adminId));
  else if (q.assigned === 'unassigned') where.push('c.assigned_admin_id IS NULL');
  else if (q.assigned && q.assigned !== 'any') return fail(res, 400, 'assigned must be me, unassigned or any', 'INVALID_FILTER');
  if (q.overdue === '1' || q.overdue === 'true') where.push(OVERDUE_SQL);
  if (q.orderId) {
    const id = toId(q.orderId);
    if (!id) return fail(res, 400, 'Invalid order id', 'INVALID_FILTER');
    add('c.order_id = ?', id);
  }
  if (q.customerId) {
    const id = toId(q.customerId);
    if (!id) return fail(res, 400, 'Invalid customer id', 'INVALID_FILTER');
    add('c.customer_id = ?', id);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const [rows, total, counts] = await Promise.all([
      pool.query(
        `${sc.STAFF_SELECT} ${whereSql}
         ORDER BY (c.status IN ('resolved', 'declined')), ${OVERDUE_SQL} DESC,
           CASE WHEN c.first_response_at IS NULL THEN c.first_response_due_at END ASC NULLS LAST,
           c.updated_at DESC, c.id DESC
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      ),
      pool.query(`SELECT COUNT(*)::int AS n FROM support_cases c ${whereSql}`, params),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'open')::int AS open,
           COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
           COUNT(*) FILTER (WHERE status = 'waiting_customer')::int AS waiting_customer,
           COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved,
           COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
           COUNT(*) FILTER (WHERE ${OVERDUE_SQL.split('c.').join('')})::int AS overdue,
           COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'declined') AND assigned_admin_id IS NULL)::int AS unassigned,
           COUNT(*) FILTER (WHERE status NOT IN ('resolved', 'declined') AND assigned_admin_id = $1)::int AS mine
         FROM support_cases`,
        [Number(req.admin.adminId)]
      ),
    ]);
    const c = counts.rows[0];
    return res.json({
      success: true,
      cases: rows.rows.map(sc.toStaffCase),
      page,
      pageSize,
      total: total.rows[0].n,
      totalPages: Math.max(1, Math.ceil(total.rows[0].n / pageSize)),
      counts: {
        ...c,
        needsAction: c.open + c.in_progress,
        active: c.open + c.in_progress + c.waiting_customer,
        all: c.open + c.in_progress + c.waiting_customer + c.resolved + c.declined,
      },
      categories: sc.CATEGORIES.map((key) => ({ key, label: sc.CATEGORY_LABELS[key] })),
      statuses: sc.STATUSES.map((key) => ({ key, label: sc.STATUS_LABELS[key] })),
    });
  } catch (error) {
    console.error('❌ support cases list error:', error.message);
    return fail(res, 500, 'Unable to load support cases');
  }
};

// GET /support/staff -> staff who can be assigned (active, support.cases)
const listAssignableStaff = async (req, res) => {
  try {
    const rows = (await pool.query('SELECT id, full_name, role, permission_grants, permission_revokes FROM admins WHERE is_active ORDER BY full_name')).rows;
    return res.json({
      success: true,
      staff: rows
        .filter((row) => effectivePermissions(row).includes('support.cases'))
        .map((row) => ({ id: Number(row.id), name: row.full_name, role: row.role, me: Number(row.id) === Number(req.admin.adminId) })),
    });
  } catch (error) {
    console.error('❌ support staff error:', error.message);
    return fail(res, 500, 'Unable to load staff');
  }
};

// GET /support/cases/:id
const getCase = async (req, res) => {
  const caseId = toId(req.params.id);
  if (!caseId) return fail(res, 400, 'Invalid case', 'INVALID_CASE');

  try {
    const row = await loadStaffCase(caseId);
    if (!row) return fail(res, 404, 'Support case not found', 'NOT_FOUND');

    const [order, items, photos, events, balance, held, limits, approvals, siblings] = await Promise.all([
      pool.query(
        `SELECT o.id, o.status, o.payment_method, o.payment_status, o.total_amount, o.items_total, o.delivery_fee,
           o.service_fee, o.getme_fee, o.tip_amount, o.discount_amount, o.credit_applied, o.delivered_at, o.created_at,
           (SELECT string_agg(os.shop_name, ', ' ORDER BY os.id) FROM order_shops os WHERE os.order_id = o.id) AS shops
         FROM orders o WHERE o.id = $1`,
        [row.order_id]
      ),
      pool.query('SELECT id, item_name, price, quantity, found_quantity, shopping_status, refund_amount FROM order_items WHERE order_id = $1 ORDER BY id', [row.order_id]),
      sc.loadPhotos(caseId),
      sc.loadEvents(caseId, { staff: true }),
      credit.balanceOf(row.customer_id),
      heldForOrder(pool, row.order_id),
      pool.query(
        `SELECT (SELECT refund_approval_limit FROM admin_security_settings WHERE id = 1) AS refund_limit,
                (SELECT credit_approval_limit FROM customer_controls_settings WHERE id = 1) AS credit_limit`
      ),
      pool.query(
        `SELECT id, action_type, amount, status, requested_at FROM admin_approval_requests
         WHERE entity_type = 'support_case' AND entity_id = $1 AND status = 'pending' ORDER BY id`,
        [String(caseId)]
      ),
      pool.query("SELECT id, status, category FROM support_cases WHERE order_id = $1 AND id <> $2 ORDER BY id", [row.order_id, caseId]),
    ]);

    const o = order.rows[0];
    const l = limits.rows[0] || {};
    return res.json({
      success: true,
      case: sc.toStaffCase(row),
      order: o
        ? {
            id: Number(o.id),
            status: o.status,
            paymentMethod: o.payment_method,
            paymentStatus: o.payment_status,
            totalAmount: round2(o.total_amount),
            itemsTotal: round2(o.items_total),
            deliveryFee: round2(o.delivery_fee),
            serviceFee: round2(o.service_fee),
            getmeFee: round2(o.getme_fee || 0),
            tip: round2(o.tip_amount || 0),
            discount: round2(o.discount_amount || 0),
            creditApplied: round2(o.credit_applied || 0),
            shops: o.shops,
            deliveredAt: o.delivered_at,
            createdAt: o.created_at,
            items: items.rows.map((it) => ({
              id: Number(it.id),
              name: it.item_name,
              unitPrice: round2(it.price),
              quantity: Number(it.quantity),
              foundQuantity: it.found_quantity != null ? Number(it.found_quantity) : null,
              status: it.shopping_status,
              refundAmount: it.refund_amount != null ? round2(it.refund_amount) : null,
            })),
          }
        : null,
      photos,
      events,
      otherCases: siblings.rows.map((s) => ({ id: Number(s.id), status: s.status, category: s.category })),
      money: {
        creditBalance: balance,
        cardRefundable: held.payments > 0 ? held.held : 0,
        paidByCard: held.payments > 0,
        refundApprovalLimit: round2(l.refund_limit ?? 0),
        creditApprovalLimit: round2(l.credit_limit ?? 0),
        maxCredit: o ? Math.min(MAX_CREDIT, round2(o.total_amount)) : 0,
        pendingApprovals: approvals.rows.map((a) => ({ id: Number(a.id), actionType: a.action_type, amount: round2(a.amount), requestedAt: a.requested_at })),
      },
      can: {
        work: adminCan(req, 'support.cases'),
        credit: adminCan(req, 'support.credit'),
        refund: adminCan(req, 'finance.refund'),
      },
    });
  } catch (error) {
    console.error('❌ support case detail error:', error.message);
    return fail(res, 500, 'Unable to load the support case');
  }
};

// -----------------------------------------------------
// Working a case
// -----------------------------------------------------

// Runs fn(client, row) with the case locked; fn returns { status, body, after }
const withCase = async (req, res, fn) => {
  const caseId = toId(req.params.id);
  if (!caseId) return fail(res, 400, 'Invalid case', 'INVALID_CASE');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM support_cases WHERE id = $1 FOR UPDATE', [caseId])).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Support case not found', 'NOT_FOUND');
    }
    const result = await fn(client, row);
    if (result.status >= 400) {
      await client.query('ROLLBACK');
      return res.status(result.status).json({ success: false, ...result.body });
    }
    await client.query('COMMIT');
    if (result.after) {
      try {
        await result.after();
      } catch (error) {
        console.error('❌ support after-commit error:', error.message);
      }
    }
    const fresh = await loadStaffCase(caseId);
    return res.status(result.status || 200).json({ success: true, ...result.body, case: sc.toStaffCase(fresh) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ support case action error:', error.message);
    return fail(res, 500, 'Unable to update the support case');
  } finally {
    client.release();
  }
};

const closedError = (row) => ({
  status: 409,
  body: { code: 'CASE_CLOSED', message: `This case is already ${sc.STATUS_LABELS[row.status].toLowerCase()}${row.resolution_type ? ` (${sc.RESOLUTION_LABELS[row.resolution_type].toLowerCase()})` : ''}.` },
});

const audit = (res, row, summary, before, after) => {
  res.locals.audit = { entityType: 'support_case', entityId: row.id, summary: String(summary).slice(0, 300), before, after };
};

// PATCH /support/cases/:id/assign { adminId: number | 'me' | null }
const assignCase = (req, res) =>
  withCase(req, res, async (client, row) => {
    const raw = req.body?.adminId;
    const me = Number(req.admin.adminId);
    const target = raw === 'me' ? me : raw === null || raw === '' ? null : toId(raw);
    if (raw !== null && raw !== '' && raw !== undefined && !target) return { status: 400, body: { message: 'Choose a staff member' } };
    if (raw === undefined) return { status: 400, body: { message: 'Choose a staff member (or null to unassign)' } };

    let name = null;
    if (target) {
      const admin = (await client.query('SELECT id, full_name, role, is_active, permission_grants, permission_revokes FROM admins WHERE id = $1', [target])).rows[0];
      if (!admin?.is_active || !effectivePermissions(admin).includes('support.cases')) {
        return { status: 400, body: { code: 'NOT_ASSIGNABLE', message: 'This staff member can’t work support cases' } };
      }
      name = admin.full_name;
    }
    if (Number(row.assigned_admin_id || 0) === Number(target || 0)) return { status: 200, body: { message: 'No change' } };

    const updated = (
      await client.query(
        'UPDATE support_cases SET assigned_admin_id = $2, assigned_at = CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() END, updated_at = NOW() WHERE id = $1 RETURNING *',
        [row.id, target]
      )
    ).rows[0];
    const event = await sc.addEvent(client, {
      caseId: row.id, kind: 'assigned', authorType: 'staff', adminId: me, visibility: 'internal',
      body: target ? `Assigned to ${name}` : 'Unassigned', data: { from: row.assigned_admin_id, to: target },
    });
    audit(res, row, target ? `Assigned support case #${row.id} to ${name}` : `Unassigned support case #${row.id}`, { assignedAdminId: row.assigned_admin_id }, { assignedAdminId: target });
    return {
      status: 200,
      body: { message: target ? `Assigned to ${name}` : 'Unassigned' },
      after: async () => {
        sc.emitStaff(req.app.get('io'), updated);
        await sc.notifyAssigned(updated, me, event.id);
      },
    };
  });

// PATCH /support/cases/:id/status { status: open | in_progress | waiting_customer }
const setStatus = (req, res) =>
  withCase(req, res, async (client, row) => {
    const next = String(req.body?.status || '');
    if (!['open', 'in_progress', 'waiting_customer'].includes(next)) {
      return { status: 400, body: { message: 'Use the resolve actions to close a case; status can be open, in_progress or waiting_customer' } };
    }
    if (sc.CLOSED.includes(row.status)) return closedError(row);
    if (row.status === next) return { status: 200, body: { message: 'No change' } };

    const updated = (await client.query('UPDATE support_cases SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [row.id, next])).rows[0];
    await sc.addEvent(client, { caseId: row.id, kind: 'status', authorType: 'staff', adminId: req.admin.adminId, data: { from: row.status, to: next } });
    audit(res, row, `Support case #${row.id}: ${sc.STATUS_LABELS[row.status]} -> ${sc.STATUS_LABELS[next]}`, { status: row.status }, { status: next });
    return {
      status: 200,
      body: { message: `Status: ${sc.STATUS_LABELS[next]}` },
      after: async () => {
        sc.emitStaff(req.app.get('io'), updated);
        sc.emitCustomer(req.app.get('io'), updated, 'status');
      },
    };
  });

// POST /support/cases/:id/reply { message, waitingForCustomer?, clientRequestId? }
const reply = (req, res) =>
  withCase(req, res, async (client, row) => {
    const message = String(req.body?.message || '').trim();
    const requestId = req.body?.clientRequestId ? String(req.body.clientRequestId) : null;
    if (message.length < 2 || message.length > 2000) return { status: 400, body: { message: 'Write the reply (2-2000 characters)' } };
    if (requestId && !REQUEST_ID.test(requestId)) return { status: 400, body: { message: 'Invalid request id' } };
    if (requestId) {
      const dup = (await client.query('SELECT id FROM support_case_events WHERE case_id = $1 AND client_request_id = $2', [row.id, requestId])).rows[0];
      if (dup) return { status: 200, body: { duplicate: true, message: 'Already sent' } };
    }

    const me = Number(req.admin.adminId);
    const closed = sc.CLOSED.includes(row.status);
    const next = closed ? row.status : req.body?.waitingForCustomer === true ? 'waiting_customer' : 'in_progress';
    const event = await sc.addEvent(client, { caseId: row.id, kind: 'message', authorType: 'staff', adminId: me, body: message, clientRequestId: requestId });
    if (!row.assigned_admin_id && !closed) {
      await sc.addEvent(client, { caseId: row.id, kind: 'assigned', authorType: 'staff', adminId: me, visibility: 'internal', body: `Assigned to ${req.admin.fullName || 'me'} (replied)`, data: { from: null, to: me } });
    }
    const updated = (
      await client.query(
        `UPDATE support_cases SET status = $2, first_response_at = COALESCE(first_response_at, NOW()), last_staff_message_at = NOW(),
           assigned_admin_id = CASE WHEN assigned_admin_id IS NULL AND $4 THEN $3 ELSE assigned_admin_id END,
           assigned_at = CASE WHEN assigned_admin_id IS NULL AND $4 THEN NOW() ELSE assigned_at END,
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [row.id, next, me, !closed]
      )
    ).rows[0];
    if (next !== row.status) {
      await sc.addEvent(client, { caseId: row.id, kind: 'status', authorType: 'staff', adminId: me, data: { from: row.status, to: next } });
    }
    audit(res, row, `Replied to the customer on support case #${row.id}${next !== row.status ? ` (${sc.STATUS_LABELS[next]})` : ''}`, { status: row.status }, { status: next });
    return {
      status: 201,
      body: { message: 'Reply sent to the customer' },
      after: async () => {
        sc.emitStaff(req.app.get('io'), updated);
        sc.emitCustomer(req.app.get('io'), updated, 'message', event);
      },
    };
  });

// POST /support/cases/:id/notes { note } (internal: never shown to the customer)
const addNote = (req, res) =>
  withCase(req, res, async (client, row) => {
    const note = String(req.body?.note || '').trim();
    if (note.length < 2 || note.length > 2000) return { status: 400, body: { message: 'Write the note (2-2000 characters)' } };
    await sc.addEvent(client, { caseId: row.id, kind: 'note', authorType: 'staff', adminId: req.admin.adminId, visibility: 'internal', body: note });
    await client.query('UPDATE support_cases SET updated_at = NOW() WHERE id = $1', [row.id]);
    audit(res, row, `Internal note on support case #${row.id}`);
    return { status: 201, body: { message: 'Note added' }, after: async () => sc.emitStaff(req.app.get('io'), row) };
  });

// Marks the case resolved inside the transaction; -> updated row
const closeCase = async (client, row, { type, amount = null, note = null, adminId, approvedBy = null }) => {
  const status = type === 'declined' ? 'declined' : 'resolved';
  const updated = (
    await client.query(
      `UPDATE support_cases SET status = $2, resolution_type = $3, resolution_amount = $4, resolution_note = $5,
         resolved_at = NOW(), resolved_by = $6, first_response_at = COALESCE(first_response_at, NOW()), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [row.id, status, type, amount, note, adminId]
    )
  ).rows[0];
  await sc.addEvent(client, {
    caseId: row.id, kind: 'resolved', authorType: 'staff', adminId,
    body: [sc.resolutionText(updated), note].filter(Boolean).join('. ').slice(0, 2000),
    data: { type, amount, approvedBy },
  });
  return updated;
};

const afterClose = (req, updated) => async () => {
  sc.emitStaff(req.app.get('io'), updated);
  sc.emitCustomer(req.app.get('io'), updated, 'resolved');
};

// POST /support/cases/:id/resolve { type: declined | no_money, note }
const resolveCase = (req, res) =>
  withCase(req, res, async (client, row) => {
    const type = String(req.body?.type || '');
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!['declined', 'no_money'].includes(type)) {
      return { status: 400, body: { message: 'type must be declined or no_money (card refunds and credit have their own actions)' } };
    }
    if (sc.CLOSED.includes(row.status)) return closedError(row);
    if (type === 'declined' && note.length < 3) return { status: 400, body: { message: 'Say why the report is declined (the customer sees this)' } };

    const updated = await closeCase(client, row, { type, note: note || null, adminId: req.admin.adminId });
    audit(res, row, `${type === 'declined' ? 'Declined' : 'Resolved without money'} support case #${row.id}${note ? `: ${note}` : ''}`, { status: row.status }, { status: updated.status, resolution: type });
    return { status: 200, body: { message: type === 'declined' ? 'Report declined' : 'Case resolved' }, after: afterClose(req, updated) };
  });

const readAmount = (value) => {
  const amount = round2(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

// POST /support/cases/:id/credit { amount, note } (support.credit; approval over the limit)
const resolveWithCredit = (req, res) =>
  withCase(req, res, async (client, row) => {
    const amount = readAmount(req.body?.amount);
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!amount) return { status: 400, body: { message: 'Enter a credit amount above zero' } };
    if (sc.CLOSED.includes(row.status)) return closedError(row);

    const order = (await client.query('SELECT total_amount FROM orders WHERE id = $1', [row.order_id])).rows[0];
    const max = Math.min(MAX_CREDIT, round2(order?.total_amount || 0));
    if (amount > max) return { status: 400, body: { code: 'CREDIT_TOO_HIGH', message: `Credit for a case can be up to the order total (Rs ${max.toFixed(2)})` } };

    const adminId = Number(req.admin.adminId);
    const issued = await credit.issueCredit(client, {
      customerId: row.customer_id,
      amount,
      reason: `Support case #${row.id} (order #${row.order_id})${note ? `: ${note}` : ''}`,
      orderId: row.order_id,
      supportCaseId: row.id,
      adminId,
      clientRequestId: `case:${row.id}:credit`,
    });
    if (!issued.created) return closedError({ ...row, status: 'resolved', resolution_type: 'credit' });

    const updated = await closeCase(client, row, { type: 'credit', amount, note: note || null, adminId, approvedBy: req.approvalRequest?.approvedBy || null });
    audit(res, row, `GetMe credit Rs ${amount.toFixed(2)} on support case #${row.id}${req.approvalRequest ? ` (approval #${req.approvalRequest.id})` : ''}`, { status: row.status }, { status: 'resolved', resolution: 'credit', amount, creditEntryId: Number(issued.entry.id) });
    return {
      status: 200,
      body: { message: `Rs ${amount.toFixed(2)} GetMe credit added for the customer`, creditBalance: issued.balance },
      after: async () => {
        await afterClose(req, updated)();
        emitCredit(req, row.customer_id, issued.balance);
        await sc.notifyCreditIssued({ entry: issued.entry, adminId, adminName: req.admin.fullName, caseId: row.id });
      },
    };
  });

// POST /support/cases/:id/refund { amount, note } (finance.refund; approval over the refund limit)
const resolveWithRefund = (req, res) =>
  withCase(req, res, async (client, row) => {
    const amount = readAmount(req.body?.amount);
    const note = String(req.body?.note || '').trim().slice(0, 500);
    if (!amount) return { status: 400, body: { message: 'Enter an amount to refund' } };
    if (sc.CLOSED.includes(row.status)) return closedError(row);

    const { held, payments } = await heldForOrder(client, row.order_id);
    if (payments === 0) return { status: 409, body: { code: 'NOT_CARD_PAID', message: 'This order was not paid by card. Give GetMe credit instead.' } };
    if (amount > held + 0.009) return { status: 400, body: { code: 'OVER_REFUNDABLE', message: `Only Rs ${held.toFixed(2)} paid by card can still be refunded` } };

    // The same refund as PATCH /orders/:id/refund (the case stays locked,
    // so it can't be resolved twice while the gateway answers)
    const outcome = await refundOrderAmount(row.order_id, amount, `GetMe order #${row.order_id}: support case #${row.id}${note ? ` - ${note}` : ''}`.slice(0, 200), req.app.get('io'));
    if (outcome.error) return { status: outcome.error.status, body: { message: outcome.error.message } };

    const adminId = Number(req.admin.adminId);
    const updated = await closeCase(client, row, { type: 'card_refund', amount: outcome.refunded, note: note || null, adminId, approvedBy: req.approvalRequest?.approvedBy || null });
    audit(res, row, `Refunded Rs ${outcome.refunded.toFixed(2)} to the card for support case #${row.id} (order #${row.order_id})${req.approvalRequest ? ` (approval #${req.approvalRequest.id})` : ''}`, { status: row.status }, { status: 'resolved', resolution: 'card_refund', amount: outcome.refunded });
    return {
      status: 200,
      body: { message: `Rs ${outcome.refunded.toFixed(2)} refunded to the customer's card`, refunded: outcome.refunded },
      after: afterClose(req, updated),
    };
  });

// -----------------------------------------------------
// Customer credit (customer page)
// -----------------------------------------------------

const emitCredit = (req, customerId, balance) => {
  try {
    req.app.get('io')?.to(`customer:${customerId}`).emit('credit-updated', { balance });
  } catch {
    // best effort
  }
};

// GET /customers/:id/credit
const getCustomerCredit = async (req, res) => {
  const customerId = toId(req.params.id);
  if (!customerId) return fail(res, 400, 'Invalid customer', 'INVALID_CUSTOMER');
  try {
    const exists = (await pool.query('SELECT id FROM customers WHERE id = $1', [customerId])).rows[0];
    if (!exists) return fail(res, 404, 'Customer not found', 'NOT_FOUND');
    return res.json({
      success: true,
      balance: await credit.balanceOf(customerId),
      entries: await credit.listEntries(customerId, { limit: 100, staff: true }),
      approvalLimit: await credit.approvalLimit(),
      maxCredit: MAX_CREDIT,
    });
  } catch (error) {
    console.error('❌ customer credit error:', error.message);
    return fail(res, 500, 'Unable to load GetMe credit');
  }
};

// POST /customers/:id/credit { amount, reason, requestId } (support.credit; approval over the limit)
const giveCustomerCredit = async (req, res) => {
  const customerId = toId(req.params.id);
  const amount = readAmount(req.body?.amount);
  const reason = String(req.body?.reason || '').trim().slice(0, 250);
  const requestId = req.body?.requestId ? String(req.body.requestId) : null;

  if (!customerId) return fail(res, 400, 'Invalid customer', 'INVALID_CUSTOMER');
  if (!amount) return fail(res, 400, 'Enter a credit amount above zero');
  if (amount > MAX_CREDIT) return fail(res, 400, `GetMe credit can be up to Rs ${MAX_CREDIT.toFixed(2)} at a time`, 'CREDIT_TOO_HIGH');
  if (reason.length < 3) return fail(res, 400, 'Say why the credit is given');
  if (requestId && !REQUEST_ID.test(requestId)) return fail(res, 400, 'Invalid request id');

  const adminId = Number(req.admin.adminId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const issued = await credit.issueCredit(client, {
      customerId,
      amount,
      reason,
      adminId,
      clientRequestId: `manual:${requestId || `${adminId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`,
    });
    await client.query('COMMIT');

    res.locals.audit = {
      entityType: 'customer',
      entityId: customerId,
      summary: `${issued.created ? 'Gave' : 'Repeated request for'} GetMe credit Rs ${amount.toFixed(2)}: ${reason}${req.approvalRequest ? ` (approval #${req.approvalRequest.id})` : ''}`.slice(0, 300),
      after: { creditEntryId: Number(issued.entry.id), balance: issued.balance },
    };
    if (issued.created) {
      emitCredit(req, customerId, issued.balance);
      sc.notifyCreditIssued({ entry: issued.entry, adminId, adminName: req.admin.fullName }).catch(() => {});
    }
    return res.status(issued.created ? 201 : 200).json({
      success: true,
      duplicate: !issued.created,
      message: issued.created ? `Rs ${amount.toFixed(2)} GetMe credit added` : 'Already added',
      balance: issued.balance,
      entry: credit.toEntry(issued.entry, { staff: true }),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status) return fail(res, error.status, error.message);
    console.error('❌ give credit error:', error.message);
    return fail(res, 500, 'Unable to add GetMe credit');
  } finally {
    client.release();
  }
};

// Approval handler for 'customer.credit' (the route set body.target)
const creditHandler = (req, res) => (req.body?.target === 'case' ? resolveWithCredit(req, res) : giveCustomerCredit(req, res));

module.exports = {
  listCases,
  listAssignableStaff,
  getCase,
  assignCase,
  setStatus,
  reply,
  addNote,
  resolveCase,
  resolveWithCredit,
  resolveWithRefund,
  getCustomerCredit,
  giveCustomerCredit,
  creditHandler,
};
