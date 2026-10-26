const db = require('../config/db');

// =====================================================
// CHAT UNREAD COUNTS + NOTIFICATIONS
// (sql/platform_phase22_chat_unread.sql)
//
// Unread for a reader = messages on their orders from the OTHER
// person (customer <-> shopper; system timeline lines don't count)
// with an id above their chat_reads.last_read_message_id.
//
// Socket (own room customer:{id} / shopper:{id}):
//   chat-unread { orderId, count, total }  - after a new message to
//                 you, or after you read (count 0) on any device
//   chat-read   { orderId, readerType, lastReadMessageId } - to the
//                 other person when you read their messages
// Push: Expo push to the recipient's registered tokens (apps built
// with push support); the app hides it while that chat is open.
// =====================================================

const OTHER = { customer: 'shopper', shopper: 'customer' };
const ORDER_OWNER_COLUMN = { customer: 'customer_id', shopper: 'shopper_id' };

const readerOf = (req) =>
  req.customer
    ? { type: 'customer', id: Number(req.customer.customerId ?? req.customer.id) }
    : { type: 'shopper', id: Number(req.shopper?.shopperId ?? req.shopper?.id) };

// [{ orderId, count, lastMessageId }] for one reader (optionally one order)
const unreadByOrder = async (reader, orderId = null) => {
  const result = await db.query(
    `
    SELECT m.order_id, COUNT(*)::int AS count, MAX(m.id) AS last_message_id
    FROM chat_messages m
    JOIN orders o ON o.id = m.order_id
    LEFT JOIN chat_reads r
      ON r.order_id = m.order_id AND r.reader_type = $1 AND r.reader_id = $2
    WHERE o.${ORDER_OWNER_COLUMN[reader.type]} = $2
      AND m.sender_type = $3
      AND m.id > COALESCE(r.last_read_message_id, 0)
      AND ($4::int IS NULL OR m.order_id = $4::int)
    GROUP BY m.order_id
    `,
    [reader.type, reader.id, OTHER[reader.type], orderId]
  );

  return result.rows.map((row) => ({
    orderId: Number(row.order_id),
    count: row.count,
    lastMessageId: Number(row.last_message_id),
  }));
};

const summaryFor = async (reader) => {
  const orders = await unreadByOrder(reader);

  return { total: orders.reduce((sum, row) => sum + row.count, 0), orders };
};

const emitUnread = async (io, reader, orderId) => {
  try {
    if (!io || !reader?.id) return;

    const summary = await summaryFor(reader);
    const count = summary.orders.find((row) => row.orderId === Number(orderId))?.count || 0;

    io.to(`${reader.type}:${reader.id}`).emit('chat-unread', {
      orderId: Number(orderId),
      count,
      total: summary.total,
    });
  } catch (error) {
    console.error('❌ CHAT UNREAD EMIT ERROR:', error.message);
  }
};

// =====================================================
// EXPO PUSH (only devices that registered a token)
// =====================================================

const sendPush = async (owner, { title, body, data }) => {
  try {
    const tokens = (
      await db.query('SELECT token FROM push_tokens WHERE owner_type = $1 AND owner_id = $2', [
        owner.type,
        owner.id,
      ])
    ).rows.map((row) => row.token);

    if (tokens.length === 0) return;

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(
        tokens.map((to) => ({ to, title, body, data, sound: 'default', channelId: 'chat', priority: 'high' }))
      ),
      signal: AbortSignal.timeout(10000),
    });

    const result = await response.json().catch(() => ({}));

    // Forget tokens of uninstalled apps
    const dead = (result?.data || [])
      .map((ticket, index) => (ticket?.details?.error === 'DeviceNotRegistered' ? tokens[index] : null))
      .filter(Boolean);

    if (dead.length > 0) {
      await db.query('DELETE FROM push_tokens WHERE token = ANY($1)', [dead]);
    }
  } catch (error) {
    console.error('❌ CHAT PUSH ERROR:', error.message);
  }
};

// After a message is saved (chatController.sendMessage): the other
// person's badge goes up at once, and a push goes out
const notifyChatMessage = async (io, order, message) => {
  if (!order || !['customer', 'shopper'].includes(message?.sender_type)) {
    return;
  }

  const recipientType = OTHER[message.sender_type];
  const recipientId = Number(order[ORDER_OWNER_COLUMN[recipientType]]);

  if (!recipientId) return;

  const recipient = { type: recipientType, id: recipientId };

  await emitUnread(io, recipient, order.id);

  const senderName = (
    await db.query(
      `SELECT full_name FROM ${message.sender_type === 'customer' ? 'customers' : 'shoppers'} WHERE id = $1`,
      [message.sender_id]
    )
  ).rows[0]?.full_name;

  const firstName = String(senderName || '').trim().split(/\s+/)[0];

  sendPush(recipient, {
    title:
      message.sender_type === 'shopper'
        ? `${firstName || 'Your shopper'} (your shopper)`
        : `${firstName || 'Customer'} · Order #${order.id}`,
    body: String(message.message || '').slice(0, 180),
    data: { type: 'chat', orderId: Number(order.id) },
  });
};

// =====================================================
// ROUTES
// =====================================================

// GET /api/chat/{customer|shopper}/unread -> { total, orders }
const getUnread = async (req, res) => {
  try {
    return res.json({ success: true, ...(await summaryFor(readerOf(req))) });
  } catch (error) {
    console.error('❌ GET CHAT UNREAD ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load unread messages' });
  }
};

// POST /api/chat/{customer|shopper}/orders/:orderId/read
// Marks everything in this order's chat as read (the chat is open)
const markRead = async (req, res) => {
  const reader = readerOf(req);
  const orderId = Number(req.params.orderId);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  try {
    const order = (
      await db.query(
        `SELECT id, customer_id, shopper_id FROM orders WHERE id = $1 AND ${ORDER_OWNER_COLUMN[reader.type]} = $2`,
        [orderId, reader.id]
      )
    ).rows[0];

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const lastId = Number(
      (await db.query('SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages WHERE order_id = $1', [orderId]))
        .rows[0].id
    );

    // Never moves backwards (two devices / late requests)
    await db.query(
      `
      INSERT INTO chat_reads (order_id, reader_type, reader_id, last_read_message_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (order_id, reader_type, reader_id) DO UPDATE SET
        last_read_message_id = GREATEST(chat_reads.last_read_message_id, EXCLUDED.last_read_message_id),
        updated_at = NOW()
      `,
      [orderId, reader.type, reader.id, lastId]
    );

    const io = req.app.get('io');

    await emitUnread(io, reader, orderId);

    const otherId = Number(order[ORDER_OWNER_COLUMN[OTHER[reader.type]]]);

    if (io && otherId) {
      io.to(`${OTHER[reader.type]}:${otherId}`).emit('chat-read', {
        orderId,
        readerType: reader.type,
        lastReadMessageId: lastId,
      });
    }

    const summary = await summaryFor(reader);

    return res.json({ success: true, orderId, count: 0, total: summary.total });
  } catch (error) {
    console.error('❌ MARK CHAT READ ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update read status' });
  }
};

// POST   /api/chat/{customer|shopper}/push-token { token, platform }
// DELETE /api/chat/{customer|shopper}/push-token { token } (log out)
const savePushToken = async (req, res) => {
  const owner = readerOf(req);
  const token = String(req.body?.token || '').trim();

  if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) {
    return res.status(400).json({ success: false, message: 'Invalid push token' });
  }

  try {
    await db.query(
      `
      INSERT INTO push_tokens (token, owner_type, owner_id, platform)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (token) DO UPDATE SET
        owner_type = EXCLUDED.owner_type,
        owner_id = EXCLUDED.owner_id,
        platform = EXCLUDED.platform,
        updated_at = NOW()
      `,
      [token, owner.type, owner.id, String(req.body?.platform || '').slice(0, 20) || null]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ SAVE PUSH TOKEN ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to save the push token' });
  }
};

const deletePushToken = async (req, res) => {
  const owner = readerOf(req);

  try {
    await db.query('DELETE FROM push_tokens WHERE token = $1 AND owner_type = $2 AND owner_id = $3', [
      String(req.body?.token || ''),
      owner.type,
      owner.id,
    ]);

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ DELETE PUSH TOKEN ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to remove the push token' });
  }
};

module.exports = {
  notifyChatMessage,
  getUnread,
  markRead,
  savePushToken,
  deletePushToken,
};
