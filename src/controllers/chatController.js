const db = require('../config/db');

// ==================================================
// GET CHAT MESSAGES
// ==================================================

const getMessages = async (req, res) => {
  try {
    const { orderId } = req.params;

    // ==================================================
    // CUSTOMER ID
    // ==================================================

    const customerId =
      req.customer?.id ||
      req.customer?.customerId ||
      null;

    // ==================================================
    // SHOPPER ID
    // ==================================================

    const shopperId =
      req.shopper?.shopperId ||
      null;

    // ==================================================
    // CHECK AUTHENTICATED USER
    // ==================================================

    if (!customerId && !shopperId) {
      return res.status(401).json({
        success: false,
        message: 'Authenticated user not found',
      });
    }

    // ==================================================
    // CUSTOMER ORDER ACCESS
    // ==================================================

    if (customerId) {
      const orderCheck = await db.query(
        `
        SELECT
          id
        FROM orders
        WHERE id = $1
          AND customer_id = $2
        LIMIT 1
        `,
        [
          orderId,
          customerId,
        ]
      );

      if (orderCheck.rows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'You do not have access to this order',
        });
      }
    }

    // ==================================================
    // SHOPPER ORDER ACCESS
    // ==================================================

    else if (shopperId) {
      const orderCheck = await db.query(
        `
        SELECT
          id
        FROM orders
        WHERE id = $1
          AND shopper_id = $2
        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );

      if (orderCheck.rows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'You do not have access to this order',
        });
      }
    }

    // ==================================================
    // GET MESSAGES
    // ==================================================

    const result = await db.query(
      `
      SELECT
        id,
        order_id,
        sender_type,
        sender_id,
        message,
        created_at
      FROM chat_messages
      WHERE order_id = $1
      ORDER BY created_at ASC, id ASC
      `,
      [orderId]
    );

    return res.json({
      success: true,
      messages: result.rows,
    });

  } catch (error) {
    console.error(
      '❌ GET CHAT MESSAGES ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to load chat messages',
    });
  }
};


// ==================================================
// SEND CHAT MESSAGE
// ==================================================

const sendMessage = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { message } = req.body;

    // ==================================================
    // CUSTOMER ID
    // ==================================================

    const customerId =
      req.customer?.id ||
      req.customer?.customerId ||
      null;

    // ==================================================
    // SHOPPER ID
    // ==================================================

    const shopperId =
      req.shopper?.shopperId ||
      null;

    // ==================================================
    // CHECK AUTHENTICATED USER
    // ==================================================

    if (!customerId && !shopperId) {
      return res.status(401).json({
        success: false,
        message: 'Authenticated user not found',
      });
    }

    // ==================================================
    // VALIDATE MESSAGE
    // ==================================================

    if (
      typeof message !== 'string' ||
      !message.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: 'Message is required',
      });
    }

    // ==================================================
    // CUSTOMER ORDER ACCESS
    // ==================================================

    if (customerId) {
      const orderCheck = await db.query(
        `
        SELECT
          id
        FROM orders
        WHERE id = $1
          AND customer_id = $2
        LIMIT 1
        `,
        [
          orderId,
          customerId,
        ]
      );

      if (orderCheck.rows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'You do not have access to this order',
        });
      }
    }

    // ==================================================
    // SHOPPER ORDER ACCESS
    // ==================================================

    else if (shopperId) {
      const orderCheck = await db.query(
        `
        SELECT
          id
        FROM orders
        WHERE id = $1
          AND shopper_id = $2
        LIMIT 1
        `,
        [
          orderId,
          shopperId,
        ]
      );

      if (orderCheck.rows.length === 0) {
        return res.status(403).json({
          success: false,
          message: 'You do not have access to this order',
        });
      }
    }

    // ==================================================
    // DETERMINE SENDER
    // ==================================================

    const senderType = customerId
      ? 'customer'
      : 'shopper';

    const senderId = customerId || shopperId;

    // ==================================================
    // INSERT MESSAGE
    // ==================================================

    const result = await db.query(
      `
      INSERT INTO chat_messages
      (
        order_id,
        sender_type,
        sender_id,
        message
      )
      VALUES
      (
        $1,
        $2,
        $3,
        $4
      )
      RETURNING
        id,
        order_id,
        sender_type,
        sender_id,
        message,
        created_at
      `,
      [
        orderId,
        senderType,
        senderId,
        message.trim(),
      ]
    );

    const savedMessage = result.rows[0];

    // ==================================================
    // REALTIME: deliver to both sides of the order
    // ==================================================

    try {
      const io = req.app.get('io');

      if (io) {
        const orderResult = await db.query(
          'SELECT customer_id, shopper_id FROM orders WHERE id = $1',
          [orderId]
        );
        const order = orderResult.rows[0];

        if (order?.customer_id) {
          io.to(`customer:${order.customer_id}`).emit('chat-message', savedMessage);
        }

        if (order?.shopper_id) {
          io.to(`shopper:${order.shopper_id}`).emit('chat-message', savedMessage);
        }
      }
    } catch (emitError) {
      console.error('❌ CHAT EMIT ERROR:', emitError.message);
    }

    return res.status(201).json({
      success: true,
      message: savedMessage,
    });

  } catch (error) {
    console.error(
      '❌ SEND CHAT MESSAGE ERROR:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Failed to send message',
    });
  }
};


// ==================================================
// EXPORT
// ==================================================

module.exports = {
  getMessages,
  sendMessage,
};