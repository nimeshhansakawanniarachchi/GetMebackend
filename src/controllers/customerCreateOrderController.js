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

// Phase 44: account controls (card only / COD limit) + GetMe credit
const accountControls = require('../customers/accountControls');
const { balanceOf, spendCredit, round2 } = require('../support/credit');
const { spentRequestId, emitCreditBalance } = require('../payments/orderCredit');

// What checkout adds to a quote (additive fields only):
//   paymentOptions: { cash: { allowed, code, reason, limit }, card: { allowed } }
//   credit: { balance, applicable, applied }  applicable = min(balance, total)
//   amountToPay: total - credit applied (when useCredit)
const checkoutExtras = async (customerId, quote, useCredit, client = undefined) => {
  const [controls, balance] = await Promise.all([
    accountControls.controlsFor(customerId, client),
    balanceOf(customerId, client),
  ]);
  const total = Number(quote?.totalAmount) || 0;
  const applicable = round2(Math.max(0, Math.min(balance, total)));
  const applied = useCredit ? applicable : 0;

  return {
    controls,
    paymentOptions: accountControls.paymentOptionsFor(controls, total),
    credit: { balance, applicable, applied },
    amountToPay: round2(Math.max(0, total - applied)),
  };
};

const readUseCredit = (body) => body?.useCredit === true || body?.useCredit === 'true';

const MAX_ADDRESS_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 500;

// The app's id for one "Place order" attempt (e.g. a UUID)
const readRequestId = (value) => {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(text) ? text : null;
};

// The order an earlier request with this id placed, in the shape
// createOrder answers with, or null
const findOrderByRequest = async (customerId, requestId) => {
  if (!requestId) return null;

  const orderResult = await pool.query(
    'SELECT * FROM orders WHERE customer_id = $1 AND client_request_id = $2',
    [customerId, requestId]
  );
  const order = orderResult.rows[0];

  if (!order) return null;

  const [itemsResult, shopsResult] = await Promise.all([
    pool.query(
      `
      SELECT oi.*, s.shop_name, s.image_url AS shop_image
      FROM order_items oi
      LEFT JOIN shops s ON s.id = oi.shop_id
      WHERE oi.order_id = $1
      ORDER BY oi.id
      `,
      [order.id]
    ),
    pool.query('SELECT shop_id, shop_name, shop_image FROM order_shops WHERE order_id = $1 ORDER BY id', [order.id]),
  ]);

  const shops = shopsResult.rows.map((shop) => ({
    id: Number(shop.shop_id),
    shopId: Number(shop.shop_id),
    name: shop.shop_name,
    shop_name: shop.shop_name,
    image: shop.shop_image,
    image_url: shop.shop_image,
    distanceKm: Number(shop.shop_id) === Number(order.shop_id) && order.distance_km != null ? Number(order.distance_km) : null,
  }));

  return {
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
    // Phase 44: GetMe credit used, and what is left to pay (card / cash)
    creditApplied: Number(order.credit_applied) || 0,
    amountToPay: Math.max(0, Math.round((Number(order.total_amount) - (Number(order.credit_applied) || 0)) * 100) / 100),
    deliveryDropoff: order.delivery_dropoff,
    deliveryInstructions: order.delivery_instructions,
    contactPhone: order.contact_phone,
    distanceKm: order.distance_km != null ? Number(order.distance_km) : null,
    hasCustomItems: itemsResult.rows.some((item) => item.custom),
    shop: shops.find((shop) => shop.id === Number(order.shop_id)) || shops[0] || null,
    shops,
    orderShops: shops,
    order_shops: shops,
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
};

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

    // Phase 44: allowed payment methods (and why not) + GetMe credit
    const extras = await checkoutExtras(req.customer.customerId, quote, readUseCredit(req.body));
    quote.paymentOptions = extras.paymentOptions;
    quote.credit = extras.credit;
    quote.amountToPay = extras.amountToPay;

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

  // Same request id twice (double tap, retry after a timeout) = the
  // order the first request placed, never a second order
  const requestId = readRequestId(req.body?.requestId);

  if (req.body?.requestId != null && !requestId) {
    return res.status(400).json({ success: false, message: 'Invalid request id' });
  }

  if (requestId) {
    const existing = await findOrderByRequest(customerId, requestId);

    if (existing) {
      return res.status(200).json({ success: true, duplicate: true, message: 'Order already placed', order: existing });
    }
  }

  // The delivery route (Google / OSRM, can take seconds) is looked
  // up here, before the transaction: the priced-again quote inside
  // it then gets the same route from the cache (pricing/deliveryRoute.js)
  // without holding product locks while a routing API answers
  await buildQuote(readQuoteInput(req.body, customerId)).catch(() => null);

  const io = req.app.get('io');
  const client = await pool.connect();
  let committed = false;

  // Ends the transaction and answers (early refusals below)
  const refuse = async (status, body) => {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(status).json({ success: false, ...body });
  };

  try {
    await client.query('BEGIN');

    // Priced inside the transaction with the products share-locked:
    // a shop's price edit waits until this order is saved, so the
    // order keeps exactly the prices it was checked against
    let quote;

    try {
      quote = await buildQuote({ ...readQuoteInput(req.body, customerId), client, lockProducts: true });
    } catch (error) {
      console.error('❌ createOrder quote error:', error.message);

      return refuse(500, { message: 'Unable to price your order' });
    }

    if (quote.issues.length > 0) {
      return refuse(400, {
        code: 'ORDER_ISSUES',
        message: quote.issues[0].message,
        issues: quote.issues,
        quote,
      });
    }

    // A code the customer entered must still apply; never drop it silently
    if (quote.promo && !quote.promo.applied) {
      return refuse(400, { code: 'PROMO_INVALID', message: quote.promo.message, quote });
    }

    // An item's price moved since the customer saw it (cart / last
    // confirmation): show old -> new and ask before charging it
    if (quote.priceChanges.length > 0) {
      const [first] = quote.priceChanges;
      const more = quote.priceChanges.length - 1;

      return refuse(409, {
        code: 'PRICE_CHANGED',
        message: more > 0
          ? `Prices changed for ${quote.priceChanges.length} items. Please review and confirm.`
          : `${first.name} is now Rs ${first.newPackPrice.toFixed(2)} (was Rs ${first.oldPackPrice.toFixed(2)}). Please review and confirm.`,
        changes: quote.priceChanges,
        quote,
      });
    }

    // The customer agreed to a total; if it moved, ask again
    const expectedTotal = Number(req.body?.expectedTotal);

    if (
      Number.isFinite(expectedTotal) &&
      Math.abs(expectedTotal - quote.totalAmount) > 0.009
    ) {
      return refuse(409, {
        code: 'PRICE_CHANGED',
        message: `Your total changed to Rs ${quote.totalAmount.toFixed(2)}. Please review and confirm.`,
        changes: [],
        quote,
      });
    }

    // ================================================
    // PHASE 44: ACCOUNT CONTROLS + GETME CREDIT
    // The customer row is locked (FOR UPDATE) for the rest of this
    // transaction: two orders placed at once spend the credit one after
    // the other, so the balance can never go below zero.
    // ================================================

    const useCredit = readUseCredit(req.body);
    await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
    const locked = await checkoutExtras(customerId, quote, useCredit, client);

    quote.paymentOptions = locked.paymentOptions;
    quote.credit = locked.credit;
    quote.amountToPay = locked.amountToPay;

    if (locked.controls?.status === 'blocked') {
      return refuse(403, accountControls.blockedBody());
    }

    if (paymentMethod === 'cash' && !locked.paymentOptions.cash.allowed) {
      const cash = locked.paymentOptions.cash;

      return refuse(accountControls.cashRefusalStatus(cash.code), {
        code: cash.code,
        message: cash.reason,
        limit: cash.limit,
        quote,
      });
    }

    // The credit the customer saw at checkout changed (spent on another
    // order meanwhile): ask again before charging more
    const expectedCredit = Number(req.body?.expectedCredit);

    if (
      useCredit &&
      req.body?.expectedCredit != null && req.body.expectedCredit !== '' &&
      Number.isFinite(expectedCredit) &&
      Math.abs(expectedCredit - locked.credit.applied) > 0.009
    ) {
      return refuse(409, {
        code: 'CREDIT_CHANGED',
        message: `Your GetMe credit available for this order is now Rs ${locked.credit.applied.toFixed(2)}. Please review and confirm.`,
        credit: locked.credit,
        quote,
      });
    }

    const requestedPrimary = Number(req.body?.shopId);
    const primaryShop =
      quote.shops.find((shop) => shop.id === requestedPrimary) || quote.shops[0];

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
        return refuse(400, { code: 'CARD_REQUIRED', message: 'Add or choose a card to pay with' });
      }

      if (toPublicCard(card).expired) {
        return refuse(400, {
          code: 'CARD_EXPIRED',
          message: `${toPublicCard(card).label} has expired. Choose another card.`,
        });
      }

      paymentCardId = Number(card.id);
    }

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
        return refuse(409, {
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
        client_request_id,
        delivery_pricing,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,'pending_shopper_search')
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
        // Road km of the delivery route
        quote.distanceKm,
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
        requestId,
        // Route + every vehicle's fare breakdown as charged
        // (pricing/deliveryFare.js); never re-priced with new rates
        quote.delivery,
      ]
    );

    let order = orderResult.rows[0];

    // Phase 44: GetMe credit pays part of the order, in this same
    // transaction (customer row locked above). A retried request with
    // the same requestId never gets here (duplicate answered above, or
    // the unique request id rolls this whole transaction back).
    let creditSpent = false;

    if (useCredit && locked.credit.applicable > 0) {
      const spent = await spendCredit(client, {
        customerId,
        wanted: quote.totalAmount,
        orderId: order.id,
        reason: `Used on order #${order.id}`,
        clientRequestId: spentRequestId(order.id),
      });

      if (spent.applied > 0) {
        order = (
          await client.query('UPDATE orders SET credit_applied = $2 WHERE id = $1 RETURNING *', [order.id, spent.applied])
        ).rows[0];
        creditSpent = true;
      }
    }

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
          original_unit_price, offer_id, offer_label,
          regular_unit_price, line_total, offer_discount
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
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
          // Snapshot: normal price, what the line costs, what the offer saved
          line.custom ? null : line.regularUnitPrice ?? null,
          line.custom ? null : line.lineTotal,
          line.custom ? 0 : line.savings || 0,
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
      // Phase 44: GetMe credit used, and what is left to pay (card / cash)
      creditApplied: Number(order.credit_applied) || 0,
      amountToPay: round2(Math.max(0, Number(order.total_amount) - (Number(order.credit_applied) || 0))),
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

    if (creditSpent) emitCreditBalance(io, customerId);

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

    // The same request id won a race with this one: answer with its order
    if (error.code === '23505' && error.constraint === 'uq_orders_client_request') {
      const existing = await findOrderByRequest(customerId, requestId).catch(() => null);

      if (existing) {
        return res.status(200).json({ success: true, duplicate: true, message: 'Order already placed', order: existing });
      }
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
