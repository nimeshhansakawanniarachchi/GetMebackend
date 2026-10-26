const pool = require('../config/db');

const {
  buildQuote,
  DROPOFF_OPTIONS,
  PAYMENT_METHODS,
} = require('../pricing/quote');

const { normalizeSriLankanMobile } = require('../utils/phone');

const { buildSlots } = require('../pricing/slots');
const { evaluatePromo } = require('../pricing/promos');
const { getPricingSettings } = require('../pricing/settings');

const { broadcastOrderChange } = require('../realtime');

const { getOwnerCard, toPublicCard } = require('../payments/paymentService');

const MAX_ADDRESS_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 500;

const readQuoteInput = (body, customerId) => ({
  customerId,
  tipAmount: body?.tipAmount ?? 0,
  promoCode: body?.promoCode || null,
  deliveryLatitude: body?.deliveryLatitude,
  deliveryLongitude: body?.deliveryLongitude,
  deliveryOption: body?.deliveryOption,
  scheduledDate: body?.scheduledDate || null,
  scheduledStartTime: body?.scheduledStartTime || null,
  scheduledEndTime: body?.scheduledEndTime || null,
  items: body?.items,
});


// =====================================================
// QUOTE
// POST /api/customer/orders/quote
// Same body as createOrder; returns server prices + fees.
// =====================================================

const getQuote = async (req, res) => {
  try {
    const quote = await buildQuote(readQuoteInput(req.body, req.customer.customerId));

    return res.json({ success: true, quote });
  } catch (error) {
    console.error('❌ getQuote error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to price your order' });
  }
};


// =====================================================
// DELIVERY SLOTS
// GET /api/customer/delivery-slots
// =====================================================

const getDeliverySlots = async (req, res) => {
  try {
    const settings = await getPricingSettings();

    return res.json({ success: true, days: buildSlots(settings) });
  } catch (error) {
    console.error('❌ getDeliverySlots error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load delivery times' });
  }
};


// =====================================================
// CREATE ORDER
// POST /api/customer/orders
// Body: deliveryAddress, deliveryLatitude, deliveryLongitude,
//   deliveryOption ('fast'|'standard'|'scheduled'), scheduledDate,
//   scheduledStartTime, scheduledEndTime,
//   deliveryDropoff ('leave_at_door'|'meet_at_door'), deliveryInstructions,
//   contactPhone (shopper calls it; empty = account mobile),
//   paymentMethod, cardId (saved card; required for 'card'),
//   expectedTotal, tipAmount, promoCode, items[{ productId, shopId, quantity,
//   amount, selectedUnit } | { custom:true, shopId, itemName, quantity,
//   unit, details, image, voiceUrl }]
// Every amount is computed here — client prices and fees are ignored.
// Card: the saved card is only checked and remembered here; it is
// charged when the customer books a vehicle (start-search).
// =====================================================

const createOrder = async (req, res) => {
  const customerId = req.customer.customerId;

  const deliveryAddress = String(req.body?.deliveryAddress || '').trim();
  const paymentMethod = String(req.body?.paymentMethod || 'cash').trim().toLowerCase();

  if (!deliveryAddress || deliveryAddress.length > MAX_ADDRESS_LENGTH) {
    return res.status(400).json({ success: false, message: 'Delivery address is required' });
  }

  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ success: false, message: 'Choose a valid payment method' });
  }

  const deliveryDropoff = DROPOFF_OPTIONS.includes(req.body?.deliveryDropoff)
    ? req.body.deliveryDropoff
    : 'leave_at_door';

  const deliveryInstructions =
    String(req.body?.deliveryInstructions || '').trim().slice(0, MAX_INSTRUCTIONS_LENGTH) || null;

  const rawContactPhone = String(req.body?.contactPhone || '').trim();
  const contactPhone = rawContactPhone ? normalizeSriLankanMobile(rawContactPhone) : null;

  if (rawContactPhone && !contactPhone) {
    return res.status(400).json({ success: false, message: 'Enter a valid Sri Lankan mobile number' });
  }

  let quote;

  try {
    quote = await buildQuote(readQuoteInput(req.body, customerId));
  } catch (error) {
    console.error('❌ createOrder quote error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to price your order' });
  }

  if (quote.issues.length > 0) {
    return res.status(400).json({
      success: false,
      code: 'ORDER_ISSUES',
      message: quote.issues[0].message,
      issues: quote.issues,
      quote,
    });
  }

  // A code the customer entered must still apply; never drop it silently
  if (quote.promo && !quote.promo.applied) {
    return res.status(400).json({
      success: false,
      code: 'PROMO_INVALID',
      message: quote.promo.message,
      quote,
    });
  }

  // The customer agreed to a total; if prices moved, ask again
  const expectedTotal = Number(req.body?.expectedTotal);

  if (
    Number.isFinite(expectedTotal) &&
    Math.abs(expectedTotal - quote.totalAmount) > 0.009
  ) {
    return res.status(409).json({
      success: false,
      code: 'PRICE_CHANGED',
      message: `Your total changed to Rs ${quote.totalAmount.toFixed(2)}. Please review and confirm.`,
      quote,
    });
  }

  const requestedPrimary = Number(req.body?.shopId);
  const primaryShop =
    quote.shops.find((shop) => shop.id === requestedPrimary) || quote.shops[0];

  const io = req.app.get('io');

  // ================================================
  // CARD: remember which saved card pays. Nothing is charged
  // here - the order total is charged when the customer books a
  // vehicle (start-search, paymentService.bookingChargeFor).
  // ================================================

  let paymentCardId = null;

  if (paymentMethod === 'card' && quote.totalAmount > 0) {
    const card = await getOwnerCard(
      { type: 'customer', id: Number(customerId) },
      Number(req.body?.cardId) || 0
    );

    if (!card) {
      return res.status(400).json({
        success: false,
        code: 'CARD_REQUIRED',
        message: 'Add or choose a card to pay with',
      });
    }

    if (toPublicCard(card).expired) {
      return res.status(400).json({
        success: false,
        code: 'CARD_EXPIRED',
        message: `${toPublicCard(card).label} has expired. Choose another card.`,
      });
    }

    paymentCardId = Number(card.id);
  }

  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    // Re-check the code with its row locked so a limited code
    // can't be used twice by orders placed at the same moment
    let promo = null;

    if (quote.promo) {
      promo = await evaluatePromo({
        code: quote.promo.code,
        customerId,
        itemsTotal: quote.itemsTotal,
        deliveryFee: quote.deliveryFee,
        fastDeliveryFee: quote.fastDeliveryFee,
        client,
        lock: true,
      });

      if (!promo?.applied || promo.discount !== quote.discount) {
        await client.query('ROLLBACK');

        return res.status(409).json({
          success: false,
          code: 'PROMO_INVALID',
          message: promo?.message || 'This promo code can no longer be used',
          quote,
        });
      }
    }

    const orderResult = await client.query(
      `
      INSERT INTO orders (
        customer_id, shop_id,
        delivery_address, delivery_latitude, delivery_longitude,
        delivery_option, payment_method,
        items_total, delivery_fee, fast_delivery_fee, service_fee, total_amount,
        distance_km,
        scheduled_date, scheduled_start_time, scheduled_end_time,
        estimated_delivery_minutes, estimated_delivery_max_minutes,
        tip_amount, promo_code, discount_amount,
        window_discount, delivery_dropoff, delivery_instructions, contact_phone,
        vehicle_fees, offer_savings,
        payment_card_id,
        getme_fee, getme_fee_percent, service_fee_per_unit,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,'pending_shopper_search')
      RETURNING *
      `,
      [
        customerId,
        primaryShop.id,
        deliveryAddress,
        Number(req.body.deliveryLatitude),
        Number(req.body.deliveryLongitude),
        quote.deliveryOption,
        paymentMethod,
        quote.itemsTotal,
        quote.deliveryFee,
        quote.fastDeliveryFee,
        quote.serviceFee,
        quote.totalAmount,
        primaryShop.distanceKm,
        quote.slot?.date || null,
        quote.slot?.start || null,
        quote.slot?.end || null,
        quote.deliveryOption !== 'scheduled' ? quote.estimatedMinutes.min : null,
        quote.deliveryOption !== 'scheduled' ? quote.estimatedMinutes.max : null,
        quote.tipAmount,
        promo ? promo.code : null,
        quote.discount,
        quote.windowDiscount,
        deliveryDropoff,
        deliveryInstructions,
        contactPhone,
        // Fee per vehicle, fixed now (pricing/vehicles.js)
        quote.vehicleFees,
        // Shop offers (pricing/offers.js)
        quote.offerSavings || 0,
        // Saved card charged at booking (null: cash / wallet)
        paymentCardId,
        // GetMe fee charged to the customer, and the rates it used
        quote.getmeFee,
        quote.getmeFeePercent,
        quote.serviceFeePerUnit,
      ]
    );

    const order = orderResult.rows[0];

    if (promo) {
      await client.query(
        `
        INSERT INTO promo_redemptions (promo_id, order_id, customer_id, discount_amount)
        VALUES ($1, $2, $3, $4)
        `,
        [promo.promoId, order.id, customerId, promo.discount]
      );
    }

    for (const shop of quote.shops) {
      await client.query(
        `
        INSERT INTO order_shops (order_id, shop_id, shop_name, shop_image)
        VALUES ($1, $2, $3, $4)
        `,
        [order.id, shop.id, shop.name, shop.image]
      );
    }

    for (const line of quote.lines) {
      await client.query(
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
        `,
        [
          order.id,
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
          // Shelf price + offer the line was priced with (else null)
          line.custom ? null : line.originalUnitPrice ?? null,
          line.custom ? null : line.offerId ?? null,
          line.custom ? null : line.offerLabel ?? null,
        ]
      );
    }

    await client.query('COMMIT');
    committed = true;

    // Response keeps the shape the customer app already reads
    const itemsResult = await pool.query(
      `
      SELECT oi.*, s.shop_name, s.image_url AS shop_image
      FROM order_items oi
      LEFT JOIN shops s ON s.id = oi.shop_id
      WHERE oi.order_id = $1
      ORDER BY oi.id
      `,
      [order.id]
    );

    const shopObjects = quote.shops.map((shop) => ({
      id: shop.id,
      shopId: shop.id,
      name: shop.name,
      shop_name: shop.name,
      image: shop.image,
      image_url: shop.image,
      distanceKm: shop.distanceKm,
    }));

    const responseOrder = {
      ...order,
      id: Number(order.id),
      orderId: Number(order.id),
      customerId: Number(customerId),
      total: Number(order.total_amount),
      totalAmount: Number(order.total_amount),
      itemsTotal: Number(order.items_total),
      deliveryFee: Number(order.delivery_fee),
      fastDeliveryFee: Number(order.fast_delivery_fee),
      serviceFee: Number(order.service_fee),
      getmeFee: Number(order.getme_fee),
      getmeFeePercent: Number(order.getme_fee_percent),
      tipAmount: Number(order.tip_amount),
      promoCode: order.promo_code,
      discountAmount: Number(order.discount_amount),
      windowDiscount: Number(order.window_discount),
      deliveryDropoff: order.delivery_dropoff,
      deliveryInstructions: order.delivery_instructions,
      contactPhone: order.contact_phone,
      distanceKm: order.distance_km != null ? Number(order.distance_km) : null,
      hasCustomItems: quote.hasCustomItems,
      shop: shopObjects.find((shop) => shop.id === primaryShop.id),
      shops: shopObjects,
      orderShops: shopObjects,
      order_shops: shopObjects,
      items: itemsResult.rows.map((item) => ({
        ...item,
        id: Number(item.id),
        order_id: Number(item.order_id),
        shop_id: item.shop_id != null ? Number(item.shop_id) : null,
        quantity: Number(item.quantity),
        amount: Number(item.amount),
        price: Number(item.price),
      })),
    };

    io?.to(`customer:${customerId}`).emit('order-update', { order: responseOrder });
    broadcastOrderChange(io, order.id, { event: 'order-created', status: order.status });

    return res.status(201).json({
      success: true,
      message: 'Order created successfully',
      order: responseOrder,
      quote,
    });
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error('❌ createOrder error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to place your order' });
  } finally {
    client.release();
  }
};

module.exports = {
  getQuote,
  getDeliverySlots,
  createOrder,
};
