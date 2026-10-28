const pool = require('../config/db');
const notifications = require('../admin/notifications');
const { emitToAdmins } = require('../realtime');
const { toPhoto } = require('./supportPhotos');

// =====================================================
// SUPPORT CASES - shared pieces (phase 43)
// Customer API: controllers/customerSupportController.js
// Staff API:    controllers/admin/adminSupportCaseController.js
//
// Status: open -> in_progress / waiting_customer -> resolved | declined
//   open              new, nobody has answered yet
//   in_progress       staff are on it (a staff reply or the customer
//                     answering a question moves it here)
//   waiting_customer  staff asked the customer something
//   resolved          card_refund | credit | no_money
//   declined          with a reason the customer sees
// First response is due 2 hours after the report; a public staff reply
// (or the resolution) is the first response. Overdue cases notify the
// support queue once (minute clock, admin/notifications.js).
// =====================================================

const CATEGORIES = ['missing_item', 'wrong_item', 'damaged', 'quality', 'late_delivery', 'other'];
const CATEGORY_LABELS = {
  missing_item: 'Missing item',
  wrong_item: 'Wrong item',
  damaged: 'Damaged item',
  quality: 'Quality problem',
  late_delivery: 'Late delivery',
  other: 'Other problem',
};
const STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved', 'declined'];
const CLOSED = ['resolved', 'declined'];
const STATUS_LABELS = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_customer: 'Waiting on customer',
  resolved: 'Resolved',
  declined: 'Declined',
};
const CUSTOMER_STATUS_LABELS = { ...STATUS_LABELS, waiting_customer: 'Waiting for you' };
const RESOLUTION_LABELS = {
  card_refund: 'Refunded to card',
  credit: 'GetMe credit',
  no_money: 'Resolved without money',
  declined: 'Declined',
};
const FIRST_RESPONSE_HOURS = 2;

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const money = (value) => `Rs ${round2(value).toFixed(2)}`;

// "Nimali Perera" -> "Nimali P." (no full names in notifications)
const shortName = (fullName) => {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};

const settings = async (client = pool) => {
  const row = (await client.query('SELECT support_report_window_hours, credit_approval_limit FROM customer_controls_settings WHERE id = 1')).rows[0] || {};
  return {
    windowHours: Number(row.support_report_window_hours ?? 48),
    creditApprovalLimit: round2(row.credit_approval_limit ?? 5000),
  };
};

const toItems = (items) =>
  (Array.isArray(items) ? items : []).map((item) => ({
    orderItemId: Number(item.orderItemId),
    name: item.name,
    quantity: Number(item.quantity),
    unitPrice: round2(item.unitPrice),
    lineAmount: round2(item.lineAmount),
  }));

const isOverdue = (row) =>
  !row.first_response_at && !CLOSED.includes(row.status) && new Date(row.first_response_due_at).getTime() < Date.now();

// What the customer reads about the outcome
const resolutionText = (row) => {
  if (!row.resolution_type) return null;
  const amount = money(row.resolution_amount || 0);
  switch (row.resolution_type) {
    case 'card_refund': return `${amount} refunded to your card`;
    case 'credit': return `${amount} GetMe credit added`;
    case 'declined': return 'We could not approve this report';
    default: return 'Resolved';
  }
};

// Staff view of a case row (joined with customer + assignee names)
const toStaffCase = (row) => ({
  id: Number(row.id),
  orderId: Number(row.order_id),
  customer: { id: Number(row.customer_id), name: row.customer_name || null, shortName: shortName(row.customer_name) },
  category: row.category,
  categoryLabel: CATEGORY_LABELS[row.category] || row.category,
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
  description: row.description,
  items: toItems(row.items),
  suggestedAmount: round2(row.suggested_amount),
  assignedTo: row.assigned_admin_id ? { id: Number(row.assigned_admin_id), name: row.assigned_name || null } : null,
  assignedAt: row.assigned_at,
  firstResponseAt: row.first_response_at,
  firstResponseDueAt: row.first_response_due_at,
  overdue: isOverdue(row),
  lastCustomerMessageAt: row.last_customer_message_at,
  lastStaffMessageAt: row.last_staff_message_at,
  photoCount: row.photo_count != null ? Number(row.photo_count) : undefined,
  resolution: row.resolution_type
    ? {
        type: row.resolution_type,
        label: RESOLUTION_LABELS[row.resolution_type],
        amount: row.resolution_amount != null ? round2(row.resolution_amount) : null,
        note: row.resolution_note,
        customerText: resolutionText(row),
        by: row.resolved_by ? { id: Number(row.resolved_by), name: row.resolved_name || null } : null,
      }
    : null,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// Customer view (no staff names, no internal data)
const toCustomerCase = (row) => ({
  id: Number(row.id),
  orderId: Number(row.order_id),
  category: row.category,
  categoryLabel: CATEGORY_LABELS[row.category] || row.category,
  status: row.status,
  statusLabel: CUSTOMER_STATUS_LABELS[row.status] || row.status,
  description: row.description,
  items: toItems(row.items),
  resolution: row.resolution_type
    ? {
        type: row.resolution_type,
        amount: row.resolution_amount != null ? round2(row.resolution_amount) : null,
        text: resolutionText(row),
        note: row.resolution_note,
      }
    : null,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const STAFF_SELECT = `
  SELECT c.*, cu.full_name AS customer_name, a.full_name AS assigned_name, r.full_name AS resolved_name,
    (SELECT COUNT(*) FROM support_case_photos p WHERE p.case_id = c.id) AS photo_count
  FROM support_cases c
  JOIN customers cu ON cu.id = c.customer_id
  LEFT JOIN admins a ON a.id = c.assigned_admin_id
  LEFT JOIN admins r ON r.id = c.resolved_by
`;

const toEvent = (row, { staff }) => ({
  id: Number(row.id),
  kind: row.kind,
  from: row.author_type,
  visibility: row.visibility,
  body: row.body,
  data: staff ? row.data || null : undefined,
  // Status changes: the new status (each app shows its own label)
  toStatus: row.kind === 'status' ? row.data?.to || null : undefined,
  toStatusLabel: row.kind === 'status' && row.data?.to ? (staff ? STATUS_LABELS : CUSTOMER_STATUS_LABELS)[row.data.to] : undefined,
  author: row.author_type === 'staff' ? (staff ? { id: Number(row.admin_id), name: row.admin_name || null } : { name: 'GetMe Support' }) : null,
  createdAt: row.created_at,
});

const loadEvents = async (caseId, { staff }) => {
  const rows = (
    await pool.query(
      `SELECT e.*, a.full_name AS admin_name FROM support_case_events e LEFT JOIN admins a ON a.id = e.admin_id
       WHERE e.case_id = $1 ${staff ? '' : "AND e.visibility = 'public'"} ORDER BY e.id`,
      [caseId]
    )
  ).rows;
  return rows.map((row) => toEvent(row, { staff }));
};

const loadPhotos = async (caseId) =>
  (await pool.query('SELECT * FROM support_case_photos WHERE case_id = $1 ORDER BY id', [caseId])).rows.map(toPhoto);

const addEvent = async (client, { caseId, kind, authorType, adminId = null, visibility = 'public', body = null, data = null, clientRequestId = null }) =>
  (
    await client.query(
      `INSERT INTO support_case_events (case_id, kind, author_type, admin_id, visibility, body, data, client_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [caseId, kind, authorType, adminId, visibility, body, data ? JSON.stringify(data) : null, clientRequestId]
    )
  ).rows[0];

// -----------------------------------------------------
// Realtime + notifications (best effort; never break a request)
// -----------------------------------------------------

const emitStaff = (io, row) => {
  emitToAdmins(io, 'admin:support-cases-updated', { caseId: Number(row.id), orderId: Number(row.order_id), customerId: Number(row.customer_id), status: row.status });
};

// kind: message | status | resolved
const emitCustomer = (io, row, kind, event = null) => {
  try {
    io?.to(`customer:${row.customer_id}`).emit('support-case-updated', {
      caseId: Number(row.id),
      orderId: Number(row.order_id),
      kind,
      status: row.status,
      statusLabel: CUSTOMER_STATUS_LABELS[row.status] || row.status,
      message: event && event.visibility === 'public' && event.kind === 'message'
        ? { id: Number(event.id), body: event.body, from: event.author_type, createdAt: event.created_at }
        : null,
      resolutionText: resolutionText(row),
    });
  } catch (error) {
    console.error('❌ support emitCustomer error:', error.message);
  }
};

const customerShort = async (customerId) =>
  shortName((await pool.query('SELECT full_name FROM customers WHERE id = $1', [customerId])).rows[0]?.full_name) || `Customer #${customerId}`;

const notifyCaseCreated = async (row) => {
  const items = toItems(row.items);
  await notifications.notify({
    category: 'support',
    event: 'support.case_created',
    severity: 'warning',
    title: `New support case #${row.id}: ${CATEGORY_LABELS[row.category]}`,
    body: `${await customerShort(row.customer_id)} · order #${row.order_id}${items.length ? ` · ${items.length} item${items.length === 1 ? '' : 's'}, ${money(row.suggested_amount)}` : ''}. Reply within ${FIRST_RESPONSE_HOURS} hours.`,
    entityType: 'support_case',
    entityId: row.id,
    permissions: ['support.cases'],
    dedupe: `support.case_created:${row.id}`,
  });
};

const notifyCustomerReply = async (row, event) => {
  await notifications.notify({
    category: 'support',
    event: 'support.customer_reply',
    severity: 'info',
    title: `Customer replied on support case #${row.id}`,
    body: `${await customerShort(row.customer_id)} · order #${row.order_id} · ${CATEGORY_LABELS[row.category]}`,
    entityType: 'support_case',
    entityId: row.id,
    permissions: ['support.cases'],
    // The assignee gets it; an unassigned case goes to the whole queue
    targetAdminId: row.assigned_admin_id || null,
    dedupe: `support.customer_reply:${event.id}`,
  });
};

const notifyAssigned = async (row, actorId, eventId) => {
  if (!row.assigned_admin_id || Number(row.assigned_admin_id) === Number(actorId)) return;
  await notifications.notify({
    category: 'support',
    event: 'support.case_assigned',
    severity: 'info',
    title: `Support case #${row.id} was assigned to you`,
    body: `${CATEGORY_LABELS[row.category]} · order #${row.order_id}`,
    entityType: 'support_case',
    entityId: row.id,
    permissions: ['support.cases'],
    targetAdminId: row.assigned_admin_id,
    actorAdminId: actorId,
    dedupe: `support.case_assigned:${eventId}`,
  });
};

const notifyCreditIssued = async ({ entry, adminId, adminName, caseId = null }) => {
  await notifications.notify({
    category: 'payments',
    event: 'credit.issued',
    severity: 'info',
    title: `GetMe credit issued: ${money(entry.amount)}`,
    body: `${await customerShort(entry.customer_id)} · ${caseId ? `support case #${caseId}` : 'given from the customer page'}${adminName ? ` · by ${adminName}` : ''}`,
    entityType: 'customer',
    entityId: entry.customer_id,
    permissions: ['finance.view'],
    actorAdminId: adminId || null,
    dedupe: `credit.issued:${entry.id}`,
  });
};

// Minute check: first response overdue -> one warning per case
let ioRef = null;
const checkOverdue = async () => {
  const rows = (
    await pool.query(
      `UPDATE support_cases SET overdue_notified_at = NOW()
       WHERE first_response_at IS NULL AND status NOT IN ('resolved', 'declined')
         AND first_response_due_at < NOW() AND overdue_notified_at IS NULL
       RETURNING *`
    )
  ).rows;
  for (const row of rows) {
    await notifications.notify({
      category: 'support',
      event: 'support.first_response_overdue',
      severity: 'warning',
      title: `Support case #${row.id} has had no reply for ${FIRST_RESPONSE_HOURS} hours`,
      body: `${CATEGORY_LABELS[row.category]} · order #${row.order_id}${row.assigned_admin_id ? '' : ' · not assigned'}`,
      entityType: 'support_case',
      entityId: row.id,
      permissions: ['support.cases'],
      dedupe: `support.first_response_overdue:${row.id}`,
    });
    emitStaff(ioRef, row);
  }
  return rows.length;
};

// bin/www
const startOverdueCheck = (io) => {
  ioRef = io;
  notifications.addClockCheck('support overdue', checkOverdue);
};

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  STATUSES,
  CLOSED,
  STATUS_LABELS,
  CUSTOMER_STATUS_LABELS,
  RESOLUTION_LABELS,
  FIRST_RESPONSE_HOURS,
  round2,
  money,
  shortName,
  settings,
  toItems,
  isOverdue,
  resolutionText,
  toStaffCase,
  toCustomerCase,
  STAFF_SELECT,
  loadEvents,
  loadPhotos,
  addEvent,
  emitStaff,
  emitCustomer,
  notifyCaseCreated,
  notifyCustomerReply,
  notifyAssigned,
  notifyCreditIssued,
  checkOverdue,
  startOverdueCheck,
};
