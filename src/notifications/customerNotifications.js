const { Client } = require('pg');

const pool = require('../config/db');
const { sendExpoPush } = require('./expoPush');
// Replacement / delivery photos are private uploads: links in socket
// payloads get the same signature REST responses get
const { signBillLinks } = require('../utils/billUrls');

// =====================================================
// CUSTOMER NOTIFICATIONS (phase 57)
// Rows are written by database triggers (sql/platform_phase57_
// customer_notifications.sql) whenever the shopper / payment flows
// change something the customer must know about. This module:
//   - LISTENs for new rows and sends each one live to the customer's
//     sockets (room customer:{id}) and as an Expo push (when wanted);
//   - retries failed / missed pushes on the minute clock (3 tries);
//   - serves the notification centre + order activity APIs, always
//     scoped to the signed-in customer.
// =====================================================

const CATEGORIES = ['replacements', 'refunds', 'messages', 'order_updates', 'delivery', 'payments'];
const MAX_PUSH_ATTEMPTS = 3;

const warn = (label, error) => console.error(`❌ CUSTOMER NOTIFICATIONS ${label}:`, error?.message || error);

const toPublic = (row) => ({
  id: Number(row.id),
  orderId: row.order_id != null ? Number(row.order_id) : null,
  itemId: row.order_item_id != null ? Number(row.order_item_id) : null,
  category: row.category,
  type: row.event_type,
  title: row.title,
  body: row.body,
  data: row.data || {},
  actionRequired: Boolean(row.action_required),
  actionState: row.action_state,
  read: Boolean(row.read_at),
  readAt: row.read_at,
  createdAt: row.created_at,
});

const countsFor = async (customerId, client = pool) => {
  const result = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread,
       COUNT(*) FILTER (WHERE action_state = 'pending')::int AS actions
     FROM customer_notifications
     WHERE customer_id = $1`,
    [customerId]
  );
  return { unreadCount: result.rows[0].unread, actionCount: result.rows[0].actions };
};

const emitCounts = async (io, customerId) => {
  if (!io || !customerId) return;
  io.to(`customer:${customerId}`).emit('customer-notifications-changed', await countsFor(customerId));
};

// -----------------------------------------------------
// Push (claimed atomically so the listener and the retry clock
// can never send the same notification twice)
// -----------------------------------------------------

const pushOne = async (id) => {
  const claimed = await pool.query(
    `UPDATE customer_notifications
        SET push_attempts = push_attempts + 1
      WHERE id = $1 AND push_wanted AND push_status IN ('pending', 'failed') AND push_attempts < $2
      RETURNING *`,
    [id, MAX_PUSH_ATTEMPTS]
  );
  const row = claimed.rows[0];
  if (!row) return;

  const data = row.data || {};
  const result = await sendExpoPush(
    { type: 'customer', id: Number(row.customer_id) },
    {
      title: row.title,
      body: row.body || '',
      channelId: 'orders',
      data: {
        type: 'notification',
        notificationId: Number(row.id),
        category: row.category,
        eventType: row.event_type,
        orderId: row.order_id != null ? Number(row.order_id) : null,
        itemId: row.order_item_id != null ? Number(row.order_item_id) : null,
        replacementId: data.replacementId ?? null,
        requestId: data.requestId ?? null,
        reportId: data.reportId ?? null,
      },
    }
  );

  await pool.query(
    `UPDATE customer_notifications
        SET push_status = $2::varchar, push_error = $3::varchar,
            push_sent_at = CASE WHEN $2::varchar = 'sent' THEN NOW() ELSE push_sent_at END
      WHERE id = $1`,
    [id, result.status, result.error || null]
  );
};

// One new notification: live to the customer's open apps, then push
const deliver = async (io, id) => {
  const row = (await pool.query('SELECT * FROM customer_notifications WHERE id = $1', [id])).rows[0];
  if (!row) return;

  if (io) {
    io.to(`customer:${row.customer_id}`).emit('customer-notification', signBillLinks({
      notification: toPublic(row),
      ...(await countsFor(row.customer_id)),
    }));
  }

  if (row.push_wanted && row.push_status === 'pending') {
    await pushOne(Number(row.id));
  }
};

// -----------------------------------------------------
// LISTEN (one connection per process; reconnects, catches up)
// -----------------------------------------------------

let listener = null;
let lastDeliveredId = 0;
let ioRef = null;

const startListener = (io) => {
  ioRef = io;
  let stopped = false;
  let retryMs = 2000;

  const connect = async () => {
    const client = new Client({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    });
    const retry = () => {
      if (stopped || listener !== client) return;
      listener = null;
      client.end().catch(() => {});
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 60_000);
    };
    client.on('error', (error) => { warn('listener', error); retry(); });
    client.on('end', retry);
    client.on('notification', (msg) => {
      const payload = String(msg.payload || '');
      if (payload.startsWith('changed:')) {
        const customerId = Number(payload.slice(8));
        if (Number.isInteger(customerId) && customerId > 0) emitCounts(io, customerId).catch((error) => warn('counts', error));
        return;
      }
      const id = Number(payload);
      if (!Number.isInteger(id) || id <= 0) return;
      lastDeliveredId = Math.max(lastDeliveredId, id);
      deliver(io, id).catch((error) => warn('deliver', error));
    });
    try {
      listener = client;
      await client.connect();
      await client.query('LISTEN customer_notification');
      retryMs = 2000;
      if (lastDeliveredId) {
        const missed = await pool.query('SELECT id FROM customer_notifications WHERE id > $1 ORDER BY id LIMIT 200', [lastDeliveredId]);
        for (const row of missed.rows) {
          lastDeliveredId = Math.max(lastDeliveredId, Number(row.id));
          await deliver(io, Number(row.id));
        }
      } else {
        const latest = await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM customer_notifications');
        lastDeliveredId = Math.max(lastDeliveredId, Number(latest.rows[0].id));
      }
    } catch (error) {
      warn('listener connect', error);
      retry();
    }
  };

  connect();
  return () => {
    stopped = true;
    listener?.end().catch(() => {});
  };
};

// Minute clock: pushes that failed (network, Expo down) or were never
// tried (server restarted between commit and send), for up to 2 hours
const retryPushes = async () => {
  const due = await pool.query(
    `SELECT id FROM customer_notifications
      WHERE push_wanted AND push_status IN ('pending', 'failed') AND push_attempts < $1
        AND created_at < NOW() - INTERVAL '30 seconds'
        AND created_at > NOW() - INTERVAL '2 hours'
      ORDER BY id
      LIMIT 50`,
    [MAX_PUSH_ATTEMPTS]
  );
  for (const row of due.rows) {
    await pushOne(Number(row.id)).catch((error) => warn('retry push', error));
  }
};

// -----------------------------------------------------
// API: notification centre (signed-in customer only)
// -----------------------------------------------------

const customerIdOf = (req) => Number(req.customer?.customerId);

const fail = (res, status, message) => res.status(status).json({ success: false, message });

// GET /api/customer/notifications?category=&filter=unread|action&before=<id>&limit=
const listNotifications = async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const before = Number(req.query.before) || null;
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const filter = ['unread', 'action'].includes(req.query.filter) ? req.query.filter : null;

    const result = await pool.query(
      `SELECT * FROM customer_notifications
        WHERE customer_id = $1
          AND ($2::bigint IS NULL OR id < $2)
          AND ($3::text IS NULL OR category = $3)
          AND ($4::text IS NULL
               OR ($4 = 'unread' AND read_at IS NULL)
               OR ($4 = 'action' AND action_state = 'pending'))
        ORDER BY id DESC
        LIMIT $5`,
      [customerId, before, category, filter, limit + 1]
    );

    const rows = result.rows.slice(0, limit);
    return res.json({
      success: true,
      notifications: rows.map(toPublic),
      nextBefore: result.rows.length > limit ? Number(rows[rows.length - 1].id) : null,
      ...(await countsFor(customerId)),
    });
  } catch (error) {
    warn('list', error);
    return fail(res, 500, 'Unable to load notifications');
  }
};

// GET /api/customer/notifications/summary
const notificationSummary = async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const byCategory = await pool.query(
      `SELECT category, COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM customer_notifications WHERE customer_id = $1 GROUP BY category`,
      [customerId]
    );
    return res.json({
      success: true,
      ...(await countsFor(customerId)),
      unreadByCategory: Object.fromEntries(byCategory.rows.map((row) => [row.category, row.unread])),
    });
  } catch (error) {
    warn('summary', error);
    return fail(res, 500, 'Unable to load notifications');
  }
};

// POST /api/customer/notifications/:id/read
const markNotificationRead = async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'Invalid notification');

    const result = await pool.query(
      `UPDATE customer_notifications SET read_at = COALESCE(read_at, NOW())
        WHERE id = $1 AND customer_id = $2
        RETURNING *`,
      [id, customerId]
    );
    if (!result.rows[0]) return fail(res, 404, 'Notification not found');

    const counts = await countsFor(customerId);
    req.app.get('io')?.to(`customer:${customerId}`).emit('customer-notifications-changed', counts);
    return res.json({ success: true, notification: toPublic(result.rows[0]), ...counts });
  } catch (error) {
    warn('read', error);
    return fail(res, 500, 'Unable to update the notification');
  }
};

// POST /api/customer/notifications/read-all { category?, orderId? }
const markAllNotificationsRead = async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const category = CATEGORIES.includes(req.body?.category) ? req.body.category : null;
    const orderId = Number(req.body?.orderId) || null;

    const result = await pool.query(
      `UPDATE customer_notifications SET read_at = NOW()
        WHERE customer_id = $1 AND read_at IS NULL
          AND ($2::text IS NULL OR category = $2)
          AND ($3::int IS NULL OR order_id = $3)`,
      [customerId, category, orderId]
    );

    const counts = await countsFor(customerId);
    req.app.get('io')?.to(`customer:${customerId}`).emit('customer-notifications-changed', counts);
    return res.json({ success: true, updated: result.rowCount, ...counts });
  } catch (error) {
    warn('read all', error);
    return fail(res, 500, 'Unable to update notifications');
  }
};

// -----------------------------------------------------
// API: order activity (one timeline, oldest first)
// GET /api/customer/orders/:orderId/activity
// -----------------------------------------------------

const money = (value) => `Rs ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const orderActivity = async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const orderId = Number(req.params.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) return fail(res, 400, 'Invalid order ID');

    const order = (
      await pool.query(
        `SELECT o.*, sh.full_name AS shopper_name
           FROM orders o LEFT JOIN shoppers sh ON sh.id = o.shopper_id
          WHERE o.id = $1 AND o.customer_id = $2`,
        [orderId, customerId]
      )
    ).rows[0];
    if (!order) return fail(res, 404, 'Order not found');

    const shopper = String(order.shopper_name || '').trim().split(/\s+/)[0] || 'Your shopper';

    const [items, replacements, requests, reports, messages, bills, payments, refunds] = await Promise.all([
      pool.query('SELECT id, item_name, image, shopping_status, completed_at, refunded_at, refund_amount, replacement_product_name FROM order_items WHERE order_id = $1', [orderId]),
      pool.query('SELECT r.*, i.item_name FROM replacement_items r LEFT JOIN order_items i ON i.id = r.original_item_id WHERE r.order_id = $1 ORDER BY r.id', [orderId]),
      pool.query('SELECT * FROM order_item_requests WHERE order_id = $1', [orderId]),
      pool.query('SELECT * FROM order_item_price_reports WHERE order_id = $1', [orderId]),
      pool.query("SELECT id, sender_type, message, created_at FROM chat_messages WHERE order_id = $1 AND sender_type IN ('customer', 'shopper') ORDER BY id", [orderId]),
      pool.query('SELECT b.shop_id, b.bill_uploaded_at, s.shop_name FROM order_shop_bills b LEFT JOIN shops s ON s.id = b.shop_id WHERE b.order_id = $1 AND b.bill_uploaded_at IS NOT NULL', [orderId]),
      pool.query("SELECT id, amount, status, paid_at, purpose FROM card_payments WHERE order_id = $1 AND owner_type = 'customer' AND paid_at IS NOT NULL", [orderId]),
      pool.query("SELECT r.id, r.amount, r.created_at FROM card_payment_refunds r JOIN card_payments cp ON cp.id = r.card_payment_id WHERE cp.order_id = $1 AND cp.owner_type = 'customer'", [orderId]),
    ]);

    const entries = [];
    const add = (at, type, title, body = null, link = null, icon = null) => {
      if (at) entries.push({ at, type, title, body, link: link || { type: 'order', orderId }, icon });
    };

    add(order.created_at, 'order.placed', 'Order placed', `Order #${orderId}`, null, 'receipt');
    add(order.accepted_at, 'order.shopper_accepted', `${shopper} accepted your order`, null, null, 'person');
    add(order.shopping_started_at, 'order.shopping_started', 'Shopping started', null, null, 'basket');
    add(order.out_for_delivery_at, 'order.out_for_delivery', 'On the way to you', null, null, 'bicycle');
    add(order.arrival_confirmed_at, 'order.arrived', `${shopper} arrived`, 'Delivery PIN requested', null, 'location');
    add(order.delivery_photo_at, 'order.delivery_photo', 'Delivery photo added', null, null, 'camera');
    add(order.delivered_at, 'order.delivered', 'Delivered', null, null, 'checkmark-circle');
    add(order.cancelled_at, 'order.cancelled', 'Order cancelled', order.cancel_reason || null, null, 'close-circle');

    // Latest replacement decision per item: a 'done' item was replaced
    // (approved) or not bought (refund chosen), not 'found'
    const decisionByItem = new Map();
    for (const r of replacements.rows) decisionByItem.set(Number(r.original_item_id), r.status);

    for (const item of items.rows) {
      const link = { type: 'item', orderId, itemId: Number(item.id) };
      const decision = decisionByItem.get(Number(item.id));
      if (item.shopping_status === 'done' && decision === 'customer_accepted') {
        add(item.completed_at, 'item.replaced', `Replaced: ${item.item_name}`, 'With the option you approved', link, 'swap-horizontal');
      } else if (item.shopping_status === 'done' && decision === 'customer_rejected') {
        // The replacement entry already says the customer chose a refund
      } else if (item.shopping_status === 'found' || item.shopping_status === 'done') {
        add(item.completed_at, 'item.found', `Found: ${item.item_name}`, null, link, 'checkmark');
      } else if (item.shopping_status === 'replaced') {
        add(item.completed_at, 'item.replaced', `Replaced: ${item.item_name}`, item.replacement_product_name ? `With ${item.replacement_product_name}` : null, link, 'swap-horizontal');
      } else if (item.shopping_status === 'refunded') {
        add(item.refunded_at || item.completed_at, 'item.refunded', `Unavailable: ${item.item_name}`,
          Number(item.refund_amount) > 0 ? `Refund of ${money(item.refund_amount)}` : 'Removed from your order', link, 'return-down-back');
      }
    }

    for (const r of replacements.rows) {
      const link = { type: 'replacement', orderId, itemId: Number(r.original_item_id), replacementId: Number(r.id) };
      add(r.created_at, 'replacement.requested', `Replacement suggested for ${r.item_name || 'an item'}`,
        Number(r.option_number) > 1 ? `Option ${r.option_number}` : null, link, 'swap-horizontal');
      const decided = {
        customer_accepted: 'You approved the replacement',
        customer_rejected: 'You chose a refund instead',
        customer_requested_another: 'You asked for another option',
      }[r.status];
      if (decided) add(r.updated_at, `replacement.${r.status}`, decided, r.item_name, link, 'chatbox-ellipses');
    }

    for (const q of requests.rows) {
      const link = { type: 'item_request', orderId, requestId: Number(q.id) };
      add(q.created_at, 'item_request.created',
        q.requested_by === 'shopper' ? `${shopper} suggested ${q.item_name}` : `You asked for ${q.item_name}`,
        q.line_total != null ? money(q.line_total) : null, link, 'add-circle');
      if (q.resolved_at && q.status !== 'pending') {
        add(q.resolved_at, `item_request.${q.status}`, `${q.item_name}: ${q.status === 'accepted' ? 'added' : q.status}`, null, link, 'add-circle');
      }
    }

    for (const p of reports.rows) {
      const link = { type: 'price_report', orderId, itemId: Number(p.order_item_id), reportId: Number(p.id) };
      add(p.created_at, 'price_report.created', `Shelf price checked: ${p.item_name}`,
        `${money(p.shelf_unit_price)} in store (ordered at ${money(p.order_unit_price)})`, link, 'pricetag');
      if (p.responded_at) add(p.responded_at, `price_report.${p.status}`, `New price ${p.status}: ${p.item_name}`, null, link, 'pricetag');
    }

    for (const m of messages.rows) {
      add(m.created_at, 'chat.message', m.sender_type === 'shopper' ? `Message from ${shopper}` : 'You sent a message',
        String(m.message || '').slice(0, 160), { type: 'chat', orderId, messageId: Number(m.id) }, 'chatbubble');
    }

    for (const b of bills.rows) {
      add(b.bill_uploaded_at, 'order.checkout_done', `Checkout complete${b.shop_name ? ` at ${b.shop_name}` : ''}`, 'Receipt added', null, 'document-text');
    }

    for (const p of payments.rows) {
      add(p.paid_at, 'payment.paid', `Payment ${money(p.amount)}`, p.purpose === 'order_extra' ? 'Extra charge approved' : 'Card charged', null, 'card');
    }

    for (const r of refunds.rows) {
      add(r.created_at, 'refund.completed', `Refund completed: ${money(r.amount)}`, 'Back to your card', null, 'return-down-back');
    }

    entries.sort((a, b) => new Date(a.at) - new Date(b.at));

    return res.json({ success: true, orderId, status: order.status, activity: entries });
  } catch (error) {
    warn('activity', error);
    return fail(res, 500, 'Unable to load the order activity');
  }
};

module.exports = {
  CATEGORIES,
  toPublic,
  countsFor,
  startListener,
  retryPushes,
  listNotifications,
  notificationSummary,
  markNotificationRead,
  markAllNotificationsRead,
  orderActivity,
};
