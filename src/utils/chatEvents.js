const db = require('../config/db');

// =====================================================
// CHAT TIMELINE EVENTS
// System rows in chat_messages that the apps show as timeline
// lines ("Melanie was notified that you started shopping"):
// sender_type 'system', sender_id 0, event_type + event_data, and
// a neutral plain-text `message` for anything that can't word it.
//
// postChatEvent never throws - a failed timeline line must not
// break the shopping action that triggered it.
// =====================================================

const FALLBACK_TEXT = {
  shopping_started: () => 'Your shopper started shopping',
  item_unavailable: (data) => `${data.itemName || 'An item'} is unavailable`,
  item_replaced: (data) =>
    `${data.itemName || 'An item'} was replaced with ` +
    `${data.replacementName || 'a replacement'}`,
  replacement_approved: (data) =>
    `Replacement for ${data.itemName || 'an item'} approved`,
  delivery_instructions_updated: (data) =>
    `Delivery instructions updated: ${
      data.dropoff === 'meet_at_door' ? 'Meet at the door' : 'Leave at the door'
    }${data.instructions ? ` · "${data.instructions}"` : ''}`,
  items_added: (data) =>
    `The customer added ${data.count === 1 ? '1 item' : `${data.count || 'more'} items`} to the order`,
  item_requested: (data) =>
    data.count > 1
      ? `The customer asked for ${data.count} more items`
      : `The customer asked for ${data.itemName || 'another item'}`,
  item_proposed: (data) =>
    `Your shopper suggested adding ${data.itemName || 'an item'}`,
  item_request_accepted: (data) =>
    `${data.itemName || 'An item'} was added to the order`,
  item_request_rejected: (data) =>
    `${data.itemName || 'An item'} wasn't added${data.reason ? ` (${data.reason})` : ''}`,
  delivery_rescheduled: (data) =>
    `Delivery moved to ${data.date || 'a new day'}${data.label ? `, ${data.label}` : ''}`,
};

const postChatEvent = async ({ io, orderId, eventType, data = {}, onceKey = null }) => {
  try {
    const textFor = FALLBACK_TEXT[eventType];

    if (!textFor || !orderId) {
      return null;
    }

    const eventData = { ...data, ...(onceKey ? { onceKey } : {}) };

    // Same event for the same thing (e.g. this item) only once
    if (onceKey) {
      const existing = await db.query(
        `
        SELECT 1 FROM chat_messages
        WHERE order_id = $1
          AND event_type = $2
          AND event_data->>'onceKey' = $3
        LIMIT 1
        `,
        [orderId, eventType, onceKey]
      );

      if (existing.rows.length > 0) {
        return null;
      }
    }

    const result = await db.query(
      `
      INSERT INTO chat_messages
        (order_id, sender_type, sender_id, message, event_type, event_data)
      VALUES ($1, 'system', 0, $2, $3, $4)
      RETURNING id, order_id, sender_type, sender_id, message,
                event_type, event_data, created_at
      `,
      [orderId, textFor(eventData), eventType, eventData]
    );

    const saved = result.rows[0];

    // Live to both sides, like a normal chat message
    if (io) {
      const order = (
        await db.query(
          'SELECT customer_id, shopper_id FROM orders WHERE id = $1',
          [orderId]
        )
      ).rows[0];

      if (order?.customer_id) {
        io.to(`customer:${order.customer_id}`).emit('chat-message', saved);
      }

      if (order?.shopper_id) {
        io.to(`shopper:${order.shopper_id}`).emit('chat-message', saved);
      }
    }

    return saved;
  } catch (error) {
    console.error('❌ CHAT EVENT ERROR:', eventType, error.message);

    return null;
  }
};

module.exports = {
  postChatEvent,
};
