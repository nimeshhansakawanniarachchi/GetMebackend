const pool = require('../config/db');

const {
  buildQuote,
  PAYMENT_METHODS,
} = require('../pricing/quote');

const { buildSlots } = require('../pricing/slots');
const { evaluatePromo } = require('../pricing/promos');
const { getPricingSettings } = require('../pricing/settings');

const { broadcastOrderChange } = require('../realtime');

const MAX_ADDRESS_LENGTH = 500;

const readQuoteInput = (body, customerId) => ({
  customerId,
  tipAmount: body?.tipAmount ?? 0,
  promoCode: body?.promoCode || null,
  deliveryLatitude: body?.deliveryLatitude,
  deliveryLongitude: body?.deliveryLongitude,
  deliveryOption: body?.deliveryOption,
  scheduledDate: body?.scheduledDate || null,
  scheduledStartTime: body?.scheduledStartTime || null,
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
//   deliveryOption ('fast'|'scheduled'), scheduledDate, scheduledStartTime,
//   paymentMethod, expectedTotal, tipAmount, promoCode, items[{ productId, shopId, quantity,
//   amount, selectedUnit } | { custom:true, shopId, itemName, quantity,
//   unit, details, image, voiceUrl }]
// Every amount is computed here — client prices and fees are ignored.
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

  const client = await pool.connect();

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
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'pending_shopper_search')
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
        quote.deliveryOption === 'fast' ? quote.estimatedMinutes.min : null,
        quote.deliveryOption === 'fast' ? quote.estimatedMinutes.max : null,
        quote.tipAmount,
        promo ? promo.code : null,
        quote.discount,
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
          replacement_product_price, replacement_note
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
        ]
      );
    }

    await client.query('COMMIT');

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
      tipAmount: Number(order.tip_amount),
      promoCode: order.promo_code,
      discountAmount: Number(order.discount_amount),
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

    const io = req.app.get('io');

    io?.to(`customer:${customerId}`).emit('order-update', { order: responseOrder });
    broadcastOrderChange(io, order.id, { event: 'order-created', status: order.status });

    return res.status(201).json({
      success: true,
      message: 'Order created successfully',
      order: responseOrder,
      quote,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

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
