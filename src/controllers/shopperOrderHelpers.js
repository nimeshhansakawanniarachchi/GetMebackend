
// =====================================================
// SHOPPER ORDER SHARED HELPERS
// =====================================================

const getShopperId = (req) => {
  return (
    req.shopper?.shopperId ||
    req.shopper?.id ||
    req.shopperId ||
    req.user?.shopperId ||
    req.user?.id ||
    null
  );
};

// =====================================================
// SOCKET.IO ORDER EVENT HELPER
// =====================================================

const emitOrderSocketEvent = ({
  req,
  event,
  orderId,
  customerId,
  shopperId,
  payload = {},
}) => {
  try {
    const io = req.app.get('io');

    if (!io || !event) {
      return;
    }

    const numericOrderId = Number(orderId);
    const numericCustomerId = Number(customerId);
    const numericShopperId = Number(shopperId);

    const eventPayload = {
      ...payload,
      orderId: Number.isFinite(numericOrderId)
        ? numericOrderId
        : orderId,
      order_id: Number.isFinite(numericOrderId)
        ? numericOrderId
        : orderId,
      customerId: Number.isFinite(numericCustomerId)
        ? numericCustomerId
        : customerId,
      customer_id: Number.isFinite(numericCustomerId)
        ? numericCustomerId
        : customerId,
    };

    if (
      Number.isFinite(numericOrderId) &&
      numericOrderId > 0
    ) {
      io.to(`order:${numericOrderId}`).emit(
        event,
        eventPayload
      );
    }

    if (
      Number.isFinite(numericCustomerId) &&
      numericCustomerId > 0
    ) {
      io.to(`customer:${numericCustomerId}`).emit(
        event,
        eventPayload
      );
    }

    if (
      Number.isFinite(numericShopperId) &&
      numericShopperId > 0
    ) {
      io.to(`shopper:${numericShopperId}`).emit(
        event,
        eventPayload
      );
    }
  } catch (error) {
    console.error(
      '❌ emitOrderSocketEvent error:',
      error
    );
  }
};

module.exports = {
  getShopperId,
  emitOrderSocketEvent,
};
