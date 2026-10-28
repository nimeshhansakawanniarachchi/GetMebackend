const pool = require('../config/db');

const { buildQuote, DROPOFF_OPTIONS } = require('../pricing/quote');
const { customerTotals } = require('../pricing/fees');
const {
  BOOKABLE_VEHICLES,
  DEFAULT_VEHICLE,
  priceClass,
  hasFreeDeliveryPromo,
} = require('../pricing/vehicles');
const { broadcastOrderChange } = require('../realtime');
const { postChatEvent } = require('../utils/chatEvents');
const { publicBaseUrl } = require('../payments/payhere');
const {
  extraChargeFor,
  chargeApprovalNeeded,
  chargeApproved,
  chargeOrderExtra,
  syncOrderPaymentColumns,
  refundWholePayment,
  reconcileInBackground,
} = require('../payments/paymentService');

// =====================================================
// CUSTOMER ORDER CHANGES
// Changes a customer makes to an order after placing it
// (Instacart order page): delivery instructions, add items,
// reschedule.
// Each change is pushed to the customer's other screens, the
// shopper's app (shopper:{id}) and the admin / shop websites.
// =====================================================

const MAX_INSTRUCTIONS_LENGTH = 500;

// Instructions can change until the order is handed over
const INSTRUCTIONS_LOCKED_STATUSES = [
  'delivered',
  'completed',
  'cancelled',
  'shopper_search_cancelled',
];

// The customer's own order (null when it isn't theirs)
const findCustomerOrder = async (orderId, customerId) => {
  const result = await pool.query(
    `
    SELECT id, customer_id, shopper_id, status
    FROM orders
    WHERE id = $1 AND customer_id = $2
    LIMIT 1
    `,
    [orderId, customerId]
  );

  return result.rows[0] || null;
};

// Same change to every app that shows this order
const emitOrderChange = (req, order, event, payload) => {
  try {
    const io = req.app.get('io');

    if (!io) {
      return;
    }

    const data = { orderId: Number(order.id), ...payload };

    io.to(`customer:${order.customer_id}`).emit(event, data);
    io.to(`order:${order.id}`).emit(event, data);

    if (order.shopper_id) {
      io.to(`shopper:${order.shopper_id}`).emit(event, data);
    }

    broadcastOrderChange(io, Number(order.id), { event, ...data });
  } catch (error) {
    console.error('❌ ORDER CHANGE EMIT ERROR:', error.message);
  }
};

// =====================================================
// UPDATE DELIVERY INSTRUCTIONS
// PATCH /api/customer/orders/:orderId/delivery-instructions
// body: { deliveryDropoff: 'leave_at_door'|'meet_at_door',
//         deliveryInstructions: string }
// =====================================================

const updateDeliveryInstructions = async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const orderId = Number(req.params.orderId);

    if (!Number.isInteger(orderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID',
      });
    }

    const dropoff = req.body?.deliveryDropoff;

    if (dropoff != null && !DROPOFF_OPTIONS.includes(dropoff)) {
      return res.status(400).json({
        success: false,
        message: 'Choose leave at the door or meet at the door',
      });
    }

    const instructions =
      String(req.body?.deliveryInstructions || '')
        .trim()
        .slice(0, MAX_INSTRUCTIONS_LENGTH) || null;

    const order = await findCustomerOrder(orderId, customerId);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    if (INSTRUCTIONS_LOCKED_STATUSES.includes(order.status)) {
      return res.status(400).json({
        success: false,
        message: 'This order is finished, so its instructions can no longer change',
      });
    }

    const result = await pool.query(
      `
      UPDATE orders
      SET
        delivery_dropoff = COALESCE($1, delivery_dropoff),
        delivery_instructions = $2,
        updated_at = NOW()
      WHERE id = $3
      RETURNING delivery_dropoff, delivery_instructions
      `,
      [dropoff || null, instructions, orderId]
    );

    const saved = result.rows[0];

    const payload = {
      deliveryDropoff: saved.delivery_dropoff,
      delivery_dropoff: saved.delivery_dropoff,
      deliveryInstructions: saved.delivery_instructions,
      delivery_instructions: saved.delivery_instructions,
    };

    emitOrderChange(req, order, 'order-delivery-instructions-updated', payload);

    // A line in the order chat, so the shopper notices
    if (order.shopper_id) {
      await postChatEvent({
        io: req.app.get('io'),
        orderId,
        eventType: 'delivery_instructions_updated',
        data: {
          dropoff: saved.delivery_dropoff,
          instructions: saved.delivery_instructions,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Delivery instructions updated',
      ...payload,
    });
  } catch (error) {
    console.error('❌ UPDATE DELIVERY INSTRUCTIONS ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Could not update the delivery instructions',
    });
  }
};

// =====================================================
// ADD ITEMS / RESCHEDULE: shared rules
// Allowed until shopping begins (Instacart: "You can add or edit
// items until shopping begins"). The whole order is re-priced with
// buildQuote - same prices and fees as checkout - except the promo
// discount, which stays what was redeemed at checkout (re-checking
// it would count this order's own redemption against it).
// =====================================================

const EDITABLE_STATUSES = [
  'pending_shopper_search',
  'waiting_for_shopper',
  'shopper_search_cancelled',
  'shopper_accepted',
];

const PAID_STATUSES = ['paid', 'completed', 'success'];

const MAX_NEW_ITEMS = 50;

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

// DATE column (a local-midnight Date from pg) -> "YYYY-MM-DD"
const toDateKey = (value) => {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');

    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }

  return String(value).slice(0, 10);
};

// Why the order can't change now (null = it can)
const editBlockReason = (order) => {
  if (order.shopping_started_at || !EDITABLE_STATUSES.includes(order.status)) {
    return 'Shopping has started, so this order can no longer be changed';
  }

  // Saved-card orders stay editable: a higher total is charged to
  // the card once the customer approves it, a lower one refunded
  if (
    PAID_STATUSES.includes(String(order.payment_status || '').toLowerCase()) &&
    order.payment_method !== 'card'
  ) {
    return 'This order is already paid, so it can no longer be changed';
  }

  return null;
};

// The order (row-locked) inside a transaction, or a 4xx reply
const lockEditableOrder = async (client, orderId, customerId) => {
  const result = await client.query(
    `
    SELECT *
    FROM orders
    WHERE id = $1 AND customer_id = $2
    FOR UPDATE
    `,
    [orderId, customerId]
  );

  const order = result.rows[0];

  if (!order) {
    return { error: { status: 404, message: 'Order not found' } };
  }

  const reason = editBlockReason(order);

  if (reason) {
    return { error: { status: 400, message: reason } };
  }

  return { order };
};

// Saved order lines -> buildQuote items (so they are re-priced too)
const orderItemsAsQuoteInput = (rows) =>
  rows.map((row) => {
    const replacement = {
      replacementPreference: row.replacement_preference,
      replacementProductId: row.replacement_product_id,
      replacementNote: row.replacement_note,
    };

    if (row.custom) {
      return {
        custom: true,
        shopId: row.shop_id,
        itemName: row.item_name,
        quantity: Number(row.quantity),
        unit: row.unit,
        details: row.details,
        image: row.image,
        voiceUrl: row.voice_url,
        ...replacement,
      };
    }

    return {
      productId: row.product_id,
      shopId: row.shop_id,
      quantity: Number(row.quantity),
      amount: row.pack_amount ?? row.amount,
      selectedUnit: row.unit,
      ...replacement,
    };
  });

// Price the order with these items and this slot. The delivery
// fee stays what the order was charged (its saved vehicle fees):
// same shops, same route, and old orders aren't re-priced with
// new delivery rates.
const quoteOrder = async (order, items, slot) =>
  buildQuote({
    savedDelivery: order.vehicle_fees
      ? { vehicleFees: order.vehicle_fees, pricing: order.delivery_pricing }
      : null,
    customerId: order.customer_id,
    deliveryLatitude: Number(order.delivery_latitude),
    deliveryLongitude: Number(order.delivery_longitude),
    deliveryOption: order.delivery_option,
    scheduledDate: slot.date,
    scheduledStartTime: slot.start,
    scheduledEndTime: slot.end,
    items,
    tipAmount: Number(order.tip_amount) || 0,
    promoCode: null,
  });

// The vehicle the order is booked for: the one whose saved fee is
// the current delivery fee (pricing/vehicles.js: Bike until booked)
const bookedVehicleOf = (order) => {
  const fees = order.vehicle_fees || {};
  const booked = Number(order.delivery_fee);
  const preferred = priceClass(order.preferred_vehicle_type);

  if (order.preferred_vehicle_type && Number(fees[preferred]) === booked) {
    return preferred;
  }

  return BOOKABLE_VEHICLES.find((type) => Number(fees[type]) === booked) || DEFAULT_VEHICLE;
};

// New order totals from a quote (priced for a Bike). The booked
// vehicle's fee replaces the quote's; a free-delivery promo's discount
// moves with that fee. keepWindowDiscount: the slot isn't changing,
// so its flexible-window discount stays (the quote can't re-validate
// a slot that is now inside the lead time).
// The service fee and GetMe fee use the rates saved on the order.
const totalsFromQuote = (
  order,
  quote,
  { keepWindowDiscount = false, freeDelivery = false } = {}
) => {
  const deliveryFee = round2(
    quote.vehicleFees?.[bookedVehicleOf(order)] ?? quote.deliveryFee
  );

  const windowDiscount = keepWindowDiscount
    ? round2(order.window_discount)
    : quote.windowDiscount;

  const discount = round2(
    Math.max(
      0,
      Number(order.discount_amount) +
        (freeDelivery ? deliveryFee - Number(order.delivery_fee) : 0)
    )
  );

  const perUnit = Number(order.service_fee_per_unit ?? quote.serviceFeePerUnit);
  const serviceFee = round2(perUnit * (Number(quote.serviceUnits) || 0));
  const getmeFeePercent = Number(order.getme_fee_percent ?? quote.getmeFeePercent);

  const totals = customerTotals({
    itemsTotal: quote.itemsTotal,
    deliveryFee,
    fastFee: quote.fastDeliveryFee,
    serviceFee,
    discount,
    windowDiscount,
    tip: quote.tipAmount,
    percent: getmeFeePercent,
  });

  return {
    itemsTotal: quote.itemsTotal,
    deliveryFee,
    fastDeliveryFee: quote.fastDeliveryFee,
    serviceFee,
    serviceUnits: quote.serviceUnits,
    vehicleFees: quote.vehicleFees,
    offerSavings: quote.offerSavings || 0,
    windowDiscount,
    discount,
    tipAmount: quote.tipAmount,
    getmeFee: totals.getmeFee,
    getmeFeePercent,
    freeDelivery,
    totalAmount: totals.totalAmount,
  };
};

const saveTotals = async (client, orderId, totals, extraSql = '', extraValues = []) => {
  const result = await client.query(
    `
    UPDATE orders
    SET
      items_total = $1,
      delivery_fee = $2,
      fast_delivery_fee = $3,
      service_fee = $4,
      vehicle_fees = $5,
      offer_savings = $6,
      window_discount = $7,
      total_amount = $8,
      discount_amount = $9,
      getme_fee = $11,
      ${extraSql}
      updated_at = NOW()
    WHERE id = $10
    RETURNING *
    `,
    [
      totals.itemsTotal,
      totals.deliveryFee,
      totals.fastDeliveryFee,
      totals.serviceFee,
      JSON.stringify(totals.vehicleFees ?? null),
      totals.offerSavings,
      totals.windowDiscount,
      totals.totalAmount,
      totals.discount,
      orderId,
      totals.getmeFee,
      ...extraValues,
    ]
  );

  // A free-delivery code's redemption follows the fee
  if (totals.freeDelivery) {
    await client.query(
      'UPDATE promo_redemptions SET discount_amount = $2 WHERE order_id = $1',
      [orderId, totals.discount]
    );
  }

  return result;
};

// Same columns createOrder writes
const insertOrderLine = (client, orderId, line) =>
  client.query(
    `
    INSERT INTO order_items (
      order_id, shop_id, product_id, item_name,
      quantity, amount, unit, price, unit_price, pack_amount,
      custom, details, image, voice_url,
      replacement_preference, replacement_product_id,
      replacement_product_name, replacement_product_image,
      replacement_product_price, replacement_note,
      original_unit_price, offer_id, offer_label
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
    RETURNING id
    `,
    [
      orderId,
      line.shopId,
      line.custom ? null : line.productId,
      line.name,
      line.quantity,
      line.custom ? 1 : line.amount,
      line.unit,
      line.packPrice,
      line.custom ? null : line.unitPrice,
      line.custom ? null : line.amount,
      line.custom,
      line.details || null,
      line.image || null,
      line.voiceUrl || null,
      line.replacementPreference || 'best_match',
      line.replacementProductId,
      line.replacementProductName,
      line.replacementProductImage,
      line.replacementProductPrice,
      line.replacementNote,
      line.custom ? null : line.originalUnitPrice ?? null,
      line.custom ? null : line.offerId ?? null,
      line.custom ? null : line.offerLabel ?? null,
    ]
  );

// A shopper who already accepted reloads their batch
const notifyAssignedShopper = (req, order, reason) => {
  try {
    const io = req.app.get('io');

    if (io && order.shopper_id) {
      io.to(`shopper:${order.shopper_id}`).emit('order-status-changed', {
        orderId: Number(order.id),
        order_id: Number(order.id),
        status: order.status,
        reason,
      });
    }
  } catch (error) {
    console.error('❌ NOTIFY SHOPPER ERROR:', error.message);
  }
};

const withTransaction = async (work) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await work(client);

    await client.query(result?.commit ? 'COMMIT' : 'ROLLBACK');

    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

// =====================================================
// ADD ITEMS
// POST /api/customer/orders/:orderId/add-items
// body: { items: [same shape as createOrder items],
//         confirm: false -> price only (nothing saved),
//         confirm: true  -> save; expectedTotal (from the preview)
//                           must still match;
//         authorizeCharge -> saved-card orders: the extra amount the
//                           customer approved (preview.cardCharge) }
// Items must come from a store already in the order.
// =====================================================

const addItemsToOrder = async (req, res) => {
  const customerId = req.customer.customerId;
  const orderId = Number(req.params.orderId);
  const newItems = Array.isArray(req.body?.items) ? req.body.items : [];
  const confirm = req.body?.confirm === true;

  if (!Number.isInteger(orderId)) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  if (newItems.length === 0 || newItems.length > MAX_NEW_ITEMS) {
    return res.status(400).json({
      success: false,
      message: `Choose between 1 and ${MAX_NEW_ITEMS} items to add`,
    });
  }

  // Extra card charge taken inside the transaction (refunded if
  // the change is not saved after all)
  let extraPayment = null;

  try {
    const outcome = await withTransaction(async (client) => {
      const { order, error } = await lockEditableOrder(client, orderId, customerId);

      if (error) {
        return { status: error.status, body: { success: false, message: error.message } };
      }

      const [itemsResult, shopsResult] = await Promise.all([
        client.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [orderId]),
        client.query('SELECT shop_id, shop_name FROM order_shops WHERE order_id = $1', [orderId]),
      ]);

      const existing = orderItemsAsQuoteInput(itemsResult.rows);

      const quote = await quoteOrder(order, [...existing, ...newItems], {
        date: toDateKey(order.scheduled_date),
        start: order.scheduled_start_time,
        end: order.scheduled_end_time,
      });

      // The slot isn't changing: one that's now inside the lead time
      // still stands
      const issues = quote.issues.filter((item) => item.code !== 'invalid_slot');

      if (issues.length > 0) {
        return {
          status: 400,
          body: { success: false, code: 'ORDER_ISSUES', message: issues[0].message, issues },
        };
      }

      const orderShopIds = shopsResult.rows.map((row) => Number(row.shop_id));
      const addedLines = quote.lines.slice(existing.length);

      if (addedLines.some((line) => !orderShopIds.includes(Number(line.shopId)))) {
        const names = shopsResult.rows.map((row) => row.shop_name).filter(Boolean);

        return {
          status: 400,
          body: {
            success: false,
            message: `You can only add items from ${names.join(' or ') || 'the same store'} to this order`,
          },
        };
      }

      const totals = totalsFromQuote(order, quote, {
        keepWindowDiscount: true,
        freeDelivery: await hasFreeDeliveryPromo(client, order),
      });

      const charge = await extraChargeFor(client, order, totals.totalAmount);

      const preview = {
        currentTotal: round2(order.total_amount),
        addedItemsTotal: round2(
          addedLines.reduce((sum, line) => sum + (Number(line.lineTotal) || 0), 0)
        ),
        addedCount: addedLines.length,
        hasCustomItems: addedLines.some((line) => line.custom),
        ...totals,
        // Saved-card orders: charged to this card when confirmed
        cardCharge: charge.extra,
        card: charge.cardPaid ? charge.card : null,
      };

      if (!confirm) {
        return { status: 200, body: { success: true, preview } };
      }

      const expectedTotal = Number(req.body?.expectedTotal);

      if (
        Number.isFinite(expectedTotal) &&
        Math.abs(expectedTotal - totals.totalAmount) > 0.009
      ) {
        return {
          status: 409,
          body: {
            success: false,
            code: 'PRICE_CHANGED',
            message: `Your new total is Rs ${totals.totalAmount.toFixed(2)}. Please review and confirm.`,
            preview,
          },
        };
      }

      if (charge.extra > 0) {
        if (!chargeApproved(req.body, charge)) {
          return { reply: (res) => chargeApprovalNeeded(res, charge, 'Adding these items') };
        }

        const paid = await chargeOrderExtra({
          order,
          charge,
          items: `GetMe order #${orderId} - added items`,
          baseUrl: publicBaseUrl(req),
          io: req.app.get('io'),
        });

        if (paid.error) {
          return {
            status: paid.error.status,
            body: { success: false, code: paid.error.code, message: paid.error.message },
          };
        }

        extraPayment = paid.row;
      }

      for (const line of addedLines) {
        await insertOrderLine(client, orderId, line);
      }

      const saved = await saveTotals(client, orderId, totals);

      if (charge.cardPaid) {
        await syncOrderPaymentColumns(client, orderId);
      }

      return {
        commit: true,
        order: saved.rows[0],
        status: 200,
        body: {
          success: true,
          message: addedLines.length === 1 ? '1 item added' : `${addedLines.length} items added`,
          preview,
          addedCount: addedLines.length,
          totalAmount: totals.totalAmount,
          cardCharged: extraPayment ? Number(extraPayment.amount) : 0,
        },
      };
    });

    if (outcome.reply) {
      return outcome.reply(res);
    }

    if (outcome.commit) {
      const order = outcome.order;

      emitOrderChange(req, order, 'order-items-added', {
        addedCount: outcome.body.addedCount,
        totalAmount: outcome.body.totalAmount,
      });

      notifyAssignedShopper(req, order, 'items_added');

      if (order.shopper_id) {
        await postChatEvent({
          io: req.app.get('io'),
          orderId,
          eventType: 'items_added',
          data: { count: outcome.body.addedCount },
        });
      }
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    console.error('❌ ADD ITEMS ERROR:', error);

    if (extraPayment) {
      await refundWholePayment(extraPayment.id, 'Items were not added', req.app.get('io'));
    }

    return res.status(500).json({ success: false, message: 'Could not add the items' });
  }
};

// =====================================================
// RESCHEDULE
// POST /api/customer/orders/:orderId/reschedule
// body: { scheduledDate, scheduledStartTime, scheduledEndTime }
// Scheduled orders only; the new slot must be bookable now
// (same slots as GET /delivery-slots). A flexible window's
// discount follows the new slot.
// Saved-card orders: a dearer slot answers 402 CARD_CHARGE_REQUIRED
// until the request carries authorizeCharge; a cheaper one is
// refunded.
// =====================================================

const rescheduleOrder = async (req, res) => {
  const customerId = req.customer.customerId;
  const orderId = Number(req.params.orderId);

  const slot = {
    date: String(req.body?.scheduledDate || '').slice(0, 10),
    start: String(req.body?.scheduledStartTime || '').slice(0, 5),
    end: String(req.body?.scheduledEndTime || '').slice(0, 5) || null,
  };

  if (!Number.isInteger(orderId)) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  if (!slot.date || !slot.start) {
    return res.status(400).json({ success: false, message: 'Choose a delivery time' });
  }

  let extraPayment = null;

  try {
    const outcome = await withTransaction(async (client) => {
      const { order, error } = await lockEditableOrder(client, orderId, customerId);

      if (error) {
        return { status: error.status, body: { success: false, message: error.message } };
      }

      if (order.delivery_option !== 'scheduled') {
        return {
          status: 400,
          body: { success: false, message: 'Only scheduled orders can be rescheduled' },
        };
      }

      const itemsResult = await client.query(
        'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id',
        [orderId]
      );

      const quote = await quoteOrder(order, orderItemsAsQuoteInput(itemsResult.rows), slot);

      if (quote.issues.length > 0 || !quote.slot) {
        return {
          status: 400,
          body: {
            success: false,
            code: 'ORDER_ISSUES',
            message: quote.issues[0]?.message || 'That delivery time is not available',
            issues: quote.issues,
          },
        };
      }

      const totals = totalsFromQuote(order, quote, {
        freeDelivery: await hasFreeDeliveryPromo(client, order),
      });

      const charge = await extraChargeFor(client, order, totals.totalAmount);

      if (charge.extra > 0) {
        if (!chargeApproved(req.body, charge)) {
          return { reply: (res) => chargeApprovalNeeded(res, charge, 'This delivery time') };
        }

        const paid = await chargeOrderExtra({
          order,
          charge,
          items: `GetMe order #${orderId} - new delivery time`,
          baseUrl: publicBaseUrl(req),
          io: req.app.get('io'),
        });

        if (paid.error) {
          return {
            status: paid.error.status,
            body: { success: false, code: paid.error.code, message: paid.error.message },
          };
        }

        extraPayment = paid.row;
      }

      const saved = await saveTotals(
        client,
        orderId,
        totals,
        'scheduled_date = $12, scheduled_start_time = $13, scheduled_end_time = $14,',
        [quote.slot.date, quote.slot.start, quote.slot.end]
      );

      if (charge.cardPaid) {
        await syncOrderPaymentColumns(client, orderId);
      }

      return {
        commit: true,
        order: saved.rows[0],
        status: 200,
        body: {
          success: true,
          message: 'Delivery time changed',
          scheduledDate: quote.slot.date,
          scheduledStartTime: quote.slot.start,
          scheduledEndTime: quote.slot.end,
          slotLabel: quote.slot.label,
          totalAmount: totals.totalAmount,
          windowDiscount: totals.windowDiscount,
          cardCharged: extraPayment ? Number(extraPayment.amount) : 0,
        },
      };
    });

    if (outcome.reply) {
      return outcome.reply(res);
    }

    if (outcome.commit) {
      const order = outcome.order;

      // A cheaper slot: the difference goes back to the card
      reconcileInBackground(orderId, { io: req.app.get('io'), reason: 'Delivery time changed' });

      emitOrderChange(req, order, 'order-rescheduled', {
        scheduledDate: outcome.body.scheduledDate,
        scheduledStartTime: outcome.body.scheduledStartTime,
        scheduledEndTime: outcome.body.scheduledEndTime,
        totalAmount: outcome.body.totalAmount,
      });

      notifyAssignedShopper(req, order, 'rescheduled');

      if (order.shopper_id) {
        await postChatEvent({
          io: req.app.get('io'),
          orderId,
          eventType: 'delivery_rescheduled',
          data: {
            date: outcome.body.scheduledDate,
            label: outcome.body.slotLabel,
          },
        });
      }
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    console.error('❌ RESCHEDULE ERROR:', error);

    if (extraPayment) {
      await refundWholePayment(extraPayment.id, 'Delivery time was not changed', req.app.get('io'));
    }

    return res.status(500).json({ success: false, message: 'Could not change the delivery time' });
  }
};

module.exports = {
  updateDeliveryInstructions,
  addItemsToOrder,
  rescheduleOrder,
  // Shared with orderItemRequestsController (extra items while shopping)
  insertOrderLine,
};
