const pool = require('../../config/db');
const { recordAdminAudit } = require('../../middleware/adminAccess');
const systemHealth = require('../../admin/systemHealth');

// =====================================================
// SUPPORT NOTES + ORDER CHAT + TECHNICAL HEALTH (phase 40)
//   GET  /api/admin/orders/:id/notes            orders.view
//   POST /api/admin/orders/:id/notes { category, note }   orders.notes
//   GET  /api/admin/orders/:id/chat             orders.chat (each view is audited)
//   GET  /api/admin/system/health               system.health
//   GET  /api/admin/system/errors               system.logs
// Notes are append-only (no edit / delete), with the author's name.
// =====================================================

const CATEGORIES = ['general', 'complaint', 'missing_items', 'cancellation', 'delivery', 'payment', 'other'];

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const toNote = (row) => ({
  id: Number(row.id),
  orderId: Number(row.order_id),
  category: row.category,
  note: row.note,
  author: { id: Number(row.admin_id), name: row.admin_name || `Admin ${row.admin_id}`, role: row.admin_role || null },
  createdAt: row.created_at,
});

const listNotes = async (req, res) => {
  const orderId = toId(req.params.id);
  if (!orderId) return res.status(400).json({ success: false, message: 'Invalid order' });

  try {
    const rows = (
      await pool.query(
        `SELECT n.*, a.full_name AS admin_name, a.role AS admin_role
         FROM order_support_notes n LEFT JOIN admins a ON a.id = n.admin_id
         WHERE n.order_id = $1 ORDER BY n.created_at, n.id`,
        [orderId]
      )
    ).rows;
    return res.json({ success: true, categories: CATEGORIES, notes: rows.map(toNote) });
  } catch (error) {
    console.error('❌ admin list notes error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the notes' });
  }
};

const addNote = async (req, res) => {
  const orderId = toId(req.params.id);
  const category = CATEGORIES.includes(req.body?.category) ? req.body.category : 'general';
  const note = String(req.body?.note || '').trim().slice(0, 2000);

  if (!orderId) return res.status(400).json({ success: false, message: 'Invalid order' });
  if (note.length < 3) return res.status(400).json({ success: false, message: 'Write the note (at least 3 characters)' });

  try {
    const order = (await pool.query('SELECT id FROM orders WHERE id = $1', [orderId])).rows[0];
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const row = (
      await pool.query('INSERT INTO order_support_notes (order_id, admin_id, category, note) VALUES ($1, $2, $3, $4) RETURNING *', [
        orderId,
        req.admin.adminId,
        category,
        note,
      ])
    ).rows[0];

    res.locals.audit = { action: 'order.note', entityType: 'order', entityId: orderId, summary: `Support note (${category})`, after: { category } };
    return res.status(201).json({ success: true, note: toNote({ ...row, admin_name: req.admin.fullName, admin_role: req.admin.role }) });
  } catch (error) {
    console.error('❌ admin add note error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to save the note' });
  }
};

const orderChat = async (req, res) => {
  const orderId = toId(req.params.id);
  if (!orderId) return res.status(400).json({ success: false, message: 'Invalid order' });

  try {
    const order = (await pool.query('SELECT id FROM orders WHERE id = $1', [orderId])).rows[0];
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const rows = (
      await pool.query(
        `SELECT id, sender_type, message, event_type, created_at FROM chat_messages
         WHERE order_id = $1 ORDER BY created_at, id LIMIT 500`,
        [orderId]
      )
    ).rows;

    // Reading a private conversation is recorded
    recordAdminAudit({
      admin: req.admin,
      action: 'order.chat_viewed',
      entityType: 'order',
      entityId: orderId,
      summary: `Opened the customer-shopper chat (${rows.length} messages)`,
      ip: req.ip,
    });

    return res.json({
      success: true,
      messages: rows.map((row) => ({
        id: Number(row.id),
        from: row.sender_type,
        message: row.message,
        eventType: row.event_type || null,
        at: row.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin order chat error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the chat' });
  }
};

const systemStatus = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, health: await systemHealth.health(req.app) });
  } catch (error) {
    console.error('❌ admin system health error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to read the health' });
  }
};

const systemErrors = (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, ...systemHealth.errors() });
};

module.exports = { listNotes, addNote, orderChat, systemStatus, systemErrors };
