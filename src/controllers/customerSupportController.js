const pool = require('../config/db');
const sc = require('../support/supportCases');
const photos = require('../support/supportPhotos');
const credit = require('../support/credit');

// =====================================================
// CUSTOMER SUPPORT CASES + GETME CREDIT (phase 43)
// Base /api/customer, customer token. Only the order's customer.
//   GET  /support/orders/:orderId/eligibility -> can this order be reported, items
//   POST /support/cases  (JSON or multipart with up to 3 'photos')
//        { orderId, category, description, items: [{ orderItemId, quantity }], clientRequestId }
//   GET  /support/cases?orderId=        own cases
//   GET  /support/cases/:id             detail, conversation (public only), photos
//   POST /support/cases/:id/messages    { message, clientRequestId }
//   GET  /credit                        { balance, entries }
// =====================================================

const getCustomerId = (req) => Number(req.customer?.customerId ?? req.customer?.id ?? req.user?.customerId ?? null);
const toId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_CASES_PER_ORDER = 5;

const fail = (res, status, message, code) => res.status(status).json({ success: false, code, message });

// Order + report window + reportable items (claimed quantities already
// taken by other open / resolved cases are subtracted)
const loadReportable = async (customerId, orderId, client = pool) => {
  const { windowHours } = await sc.settings(client);
  const order = (
    await client.query(
      `SELECT o.id, o.customer_id, o.status, o.payment_method, o.delivered_at,
         (o.delivered_at + make_interval(hours => $2::int))::timestamptz AS window_ends_at,
         (o.delivered_at IS NOT NULL AND NOW()::timestamp <= o.delivered_at + make_interval(hours => $2::int)) AS in_window
       FROM orders o WHERE o.id = $1`,
      [orderId, windowHours]
    )
  ).rows[0];

  if (!order || Number(order.customer_id) !== customerId) return { error: [404, 'Order not found', 'NOT_FOUND'] };

  let refusal = null;
  if (order.status !== 'delivered' || !order.delivered_at) {
    refusal = ['ORDER_NOT_DELIVERED', 'You can report a problem once your order has been delivered.'];
  } else if (!order.in_window) {
    refusal = ['REPORT_WINDOW_CLOSED', `Problems can be reported up to ${windowHours} hours after delivery. This order was delivered too long ago - please contact GetMe support.`];
  }

  const claimed = (
    await client.query(
      `SELECT (item->>'orderItemId')::int AS item_id, SUM((item->>'quantity')::numeric) AS qty
       FROM support_cases c, jsonb_array_elements(c.items) item
       WHERE c.order_id = $1 AND c.status <> 'declined'
       GROUP BY 1`,
      [orderId]
    )
  ).rows;
  const claimedBy = new Map(claimed.map((row) => [Number(row.item_id), Number(row.qty)]));

  const items = (
    await client.query(
      `SELECT id, item_name, image, price, quantity, found_quantity, shopping_status
       FROM order_items WHERE order_id = $1 ORDER BY id`,
      [orderId]
    )
  ).rows.map((row) => {
    // What the customer paid for: refunded lines are already settled
    const paidQty = row.shopping_status === 'refunded' ? 0 : Number(row.found_quantity) > 0 ? Number(row.found_quantity) : Number(row.quantity);
    return {
      orderItemId: Number(row.id),
      name: row.item_name,
      image: row.image || null,
      unitPrice: sc.round2(row.price),
      paidQuantity: paidQty,
      maxQuantity: Math.max(0, sc.round2(paidQty - (claimedBy.get(Number(row.id)) || 0))),
    };
  });

  const caseCount = Number((await client.query('SELECT COUNT(*) AS n FROM support_cases WHERE order_id = $1', [orderId])).rows[0].n);
  if (!refusal && caseCount >= MAX_CASES_PER_ORDER) {
    refusal = ['TOO_MANY_REPORTS', 'This order already has several reports. Reply on an existing one instead.'];
  }

  return { order, refusal, items, windowHours, windowEndsAt: order.window_ends_at };
};

const getEligibility = async (req, res) => {
  const customerId = getCustomerId(req);
  const orderId = toId(req.params.orderId);
  if (!orderId) return fail(res, 400, 'Invalid order', 'INVALID_ORDER');

  try {
    const result = await loadReportable(customerId, orderId);
    if (result.error) return fail(res, ...result.error);
    return res.json({
      success: true,
      canReport: !result.refusal,
      code: result.refusal?.[0] || null,
      message: result.refusal?.[1] || null,
      windowHours: result.windowHours,
      windowEndsAt: result.windowEndsAt,
      categories: sc.CATEGORIES.map((key) => ({ key, label: sc.CATEGORY_LABELS[key] })),
      items: result.items,
      maxPhotos: photos.MAX_PHOTOS,
    });
  } catch (error) {
    console.error('❌ support eligibility error:', error.message);
    return fail(res, 500, 'Unable to check this order');
  }
};

// items may arrive as a JSON string (multipart)
const readItems = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return value == null || value === '' ? [] : null;
};

const createCase = async (req, res) => {
  const customerId = getCustomerId(req);
  const body = req.body || {};
  const orderId = toId(body.orderId);
  const category = String(body.category || '');
  const description = String(body.description || '').replace(/\s+\n/g, '\n').trim();
  const clientRequestId = String(body.clientRequestId || '');
  const requested = readItems(body.items);

  if (!REQUEST_ID.test(clientRequestId)) return fail(res, 400, 'Missing request id (8-64 letters, numbers, - or _)', 'INVALID_REQUEST_ID');
  if (!orderId) return fail(res, 400, 'Choose the order', 'INVALID_ORDER');
  if (!sc.CATEGORIES.includes(category)) return fail(res, 400, 'Choose what went wrong', 'INVALID_CATEGORY');
  if (description.length < 10 || description.length > 1000) return fail(res, 400, 'Describe the problem in 10 to 1000 characters', 'INVALID_DESCRIPTION');
  if (!requested || requested.length > 50) return fail(res, 400, 'The items could not be read', 'INVALID_ITEMS');

  // Same request again -> the case it created (before any other check)
  const existing = (await pool.query('SELECT * FROM support_cases WHERE customer_id = $1 AND client_request_id = $2', [customerId, clientRequestId])).rows[0];
  if (existing) return res.status(200).json({ success: true, duplicate: true, case: sc.toCustomerCase(existing) });

  let checked;
  try {
    checked = photos.checkPhotos(req.files);
  } catch (error) {
    return fail(res, error.status || 400, error.message, 'INVALID_PHOTOS');
  }

  const client = await pool.connect();
  let written = [];

  try {
    await client.query('BEGIN');
    // One report at a time per customer (claimed quantities stay correct)
    await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId]);

    const again = (await client.query('SELECT * FROM support_cases WHERE customer_id = $1 AND client_request_id = $2', [customerId, clientRequestId])).rows[0];
    if (again) {
      await client.query('ROLLBACK');
      return res.status(200).json({ success: true, duplicate: true, case: sc.toCustomerCase(again) });
    }

    const result = await loadReportable(customerId, orderId, client);
    if (result.error) {
      await client.query('ROLLBACK');
      return fail(res, ...result.error);
    }
    if (result.refusal) {
      await client.query('ROLLBACK');
      return fail(res, 409, result.refusal[1], result.refusal[0]);
    }

    const byId = new Map(result.items.map((item) => [item.orderItemId, item]));
    const seen = new Set();
    const items = [];
    for (const entry of requested) {
      const item = byId.get(Number(entry?.orderItemId));
      const quantity = sc.round2(entry?.quantity);
      if (!item || seen.has(item.orderItemId)) {
        await client.query('ROLLBACK');
        return fail(res, 400, 'Choose items from this order', 'INVALID_ITEMS');
      }
      if (!(quantity > 0) || quantity > item.maxQuantity) {
        await client.query('ROLLBACK');
        return fail(res, 400, item.maxQuantity > 0 ? `${item.name}: choose 1 to ${item.maxQuantity}` : `${item.name} is already refunded or reported`, 'INVALID_QUANTITY');
      }
      seen.add(item.orderItemId);
      items.push({ orderItemId: item.orderItemId, name: item.name, quantity, unitPrice: item.unitPrice, lineAmount: sc.round2(item.unitPrice * quantity) });
    }

    if (['missing_item', 'wrong_item', 'damaged', 'quality'].includes(category) && items.length === 0) {
      await client.query('ROLLBACK');
      return fail(res, 400, 'Choose the items that had the problem', 'ITEMS_REQUIRED');
    }

    const suggested = sc.round2(items.reduce((sum, item) => sum + item.lineAmount, 0));
    const row = (
      await client.query(
        `INSERT INTO support_cases (order_id, customer_id, category, description, items, suggested_amount,
           first_response_due_at, client_request_id, last_customer_message_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(hours => $7::int), $8, NOW()) RETURNING *`,
        [orderId, customerId, category, description, JSON.stringify(items), suggested, sc.FIRST_RESPONSE_HOURS, clientRequestId]
      )
    ).rows[0];

    await sc.addEvent(client, { caseId: row.id, kind: 'created', authorType: 'customer', body: description, data: { category, items: items.length, photos: checked.length } });

    written = photos.writePhotos(row.id, checked);
    for (let i = 0; i < written.length; i += 1) {
      await client.query(
        'INSERT INTO support_case_photos (case_id, file_name, mime_type, size_bytes, sha256) VALUES ($1, $2, $3, $4, $5)',
        [row.id, written[i], checked[i].mime, checked[i].size, checked[i].sha256]
      );
    }

    await client.query('COMMIT');

    sc.notifyCaseCreated(row).catch(() => {});
    sc.emitStaff(req.app.get('io'), row);

    return res.status(201).json({
      success: true,
      message: 'Thanks - your report was sent. GetMe support will reply here.',
      case: { ...sc.toCustomerCase(row), photos: await sc.loadPhotos(row.id) },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    photos.removeFiles(written);
    if (error.code === '23505') {
      const dup = (await pool.query('SELECT * FROM support_cases WHERE customer_id = $1 AND client_request_id = $2', [customerId, clientRequestId])).rows[0];
      if (dup) return res.status(200).json({ success: true, duplicate: true, case: sc.toCustomerCase(dup) });
    }
    console.error('❌ support create error:', error.message);
    return fail(res, 500, 'Unable to send the report');
  } finally {
    client.release();
  }
};

const ownCase = async (customerId, caseId) => {
  const row = (await pool.query('SELECT * FROM support_cases WHERE id = $1', [caseId])).rows[0];
  return row && Number(row.customer_id) === customerId ? row : null;
};

const listCases = async (req, res) => {
  const customerId = getCustomerId(req);
  const orderId = req.query.orderId != null && req.query.orderId !== '' ? toId(req.query.orderId) : null;
  if (req.query.orderId && !orderId) return fail(res, 400, 'Invalid order', 'INVALID_ORDER');

  try {
    const params = [customerId];
    let extra = '';
    if (orderId) {
      params.push(orderId);
      extra = 'AND c.order_id = $2';
    }
    const rows = (
      await pool.query(
        `SELECT c.*,
           (SELECT e.created_at FROM support_case_events e WHERE e.case_id = c.id AND e.visibility = 'public' ORDER BY e.id DESC LIMIT 1) AS last_activity_at
         FROM support_cases c WHERE c.customer_id = $1 ${extra}
         ORDER BY c.created_at DESC LIMIT 100`,
        params
      )
    ).rows;
    return res.json({
      success: true,
      cases: rows.map((row) => ({ ...sc.toCustomerCase(row), lastActivityAt: row.last_activity_at || row.updated_at })),
    });
  } catch (error) {
    console.error('❌ support list error:', error.message);
    return fail(res, 500, 'Unable to load your reports');
  }
};

const getCase = async (req, res) => {
  const customerId = getCustomerId(req);
  const caseId = toId(req.params.id);
  if (!caseId) return fail(res, 400, 'Invalid report', 'INVALID_CASE');

  try {
    const row = await ownCase(customerId, caseId);
    if (!row) return fail(res, 404, 'Report not found', 'NOT_FOUND');
    return res.json({
      success: true,
      case: {
        ...sc.toCustomerCase(row),
        photos: await sc.loadPhotos(caseId),
        messages: await sc.loadEvents(caseId, { staff: false }),
        canReply: !sc.CLOSED.includes(row.status),
      },
    });
  } catch (error) {
    console.error('❌ support detail error:', error.message);
    return fail(res, 500, 'Unable to load the report');
  }
};

const addMessage = async (req, res) => {
  const customerId = getCustomerId(req);
  const caseId = toId(req.params.id);
  const message = String(req.body?.message || '').trim();
  const clientRequestId = req.body?.clientRequestId ? String(req.body.clientRequestId) : null;

  if (!caseId) return fail(res, 400, 'Invalid report', 'INVALID_CASE');
  if (message.length < 1 || message.length > 1000) return fail(res, 400, 'Write a message (up to 1000 characters)', 'INVALID_MESSAGE');
  if (clientRequestId && !REQUEST_ID.test(clientRequestId)) return fail(res, 400, 'Invalid request id', 'INVALID_REQUEST_ID');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM support_cases WHERE id = $1 FOR UPDATE', [caseId])).rows[0];
    if (!row || Number(row.customer_id) !== customerId) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Report not found', 'NOT_FOUND');
    }
    if (clientRequestId) {
      const dup = (await client.query('SELECT * FROM support_case_events WHERE case_id = $1 AND client_request_id = $2', [caseId, clientRequestId])).rows[0];
      if (dup) {
        await client.query('ROLLBACK');
        return res.json({ success: true, duplicate: true, message: { id: Number(dup.id), body: dup.body, from: dup.author_type, createdAt: dup.created_at } });
      }
    }
    if (sc.CLOSED.includes(row.status)) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'This report is closed. If something else is wrong, send a new report.', 'CASE_CLOSED');
    }

    const event = await sc.addEvent(client, { caseId, kind: 'message', authorType: 'customer', body: message, clientRequestId });
    // The customer answered: back to staff (open until someone has replied)
    const nextStatus = row.status === 'waiting_customer' ? (row.first_response_at ? 'in_progress' : 'open') : row.status;
    const updated = (
      await client.query(
        'UPDATE support_cases SET status = $2, last_customer_message_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *',
        [caseId, nextStatus]
      )
    ).rows[0];
    await client.query('COMMIT');

    sc.notifyCustomerReply(updated, event).catch(() => {});
    sc.emitStaff(req.app.get('io'), updated);

    return res.status(201).json({
      success: true,
      status: updated.status,
      statusLabel: sc.CUSTOMER_STATUS_LABELS[updated.status],
      message: { id: Number(event.id), body: event.body, from: 'customer', createdAt: event.created_at },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ support message error:', error.message);
    return fail(res, 500, 'Unable to send the message');
  } finally {
    client.release();
  }
};

const getCredit = async (req, res) => {
  const customerId = getCustomerId(req);
  try {
    return res.json({
      success: true,
      balance: await credit.balanceOf(customerId),
      currency: 'LKR',
      entries: await credit.listEntries(customerId, { limit: 50 }),
    });
  } catch (error) {
    console.error('❌ customer credit error:', error.message);
    return fail(res, 500, 'Unable to load your GetMe credit');
  }
};

module.exports = { getEligibility, createCase, listCases, getCase, addMessage, getCredit, getCustomerId };
