// =====================================================
// PHASE 59: MERCHANT CHECKOUT (clothing shops + restaurants)
// POST /api/customer/merchant-orders/quote
// POST /api/customer/merchant-orders
//
// Everything is priced and checked here, never by the app:
//   - product belongs to the store, is available
//   - clothing: a size / colour variant with enough stock (stock is
//     taken when the order is placed, row-locked; put back by the
//     phase 59 trigger if the order is cancelled)
//   - restaurant: menu options valid for the item, required groups
//     answered, min / max respected; option prices added
//   - store approved, open, not paused, under its order capacity
//   - delivery: road route within GetMe's distance, fee from the
//     existing fare engine (every vehicle's fee saved so the existing
//     start-search vehicle choice works); pickup: no delivery fee
// One merchant order = one store. Card orders are charged by the
// existing start-search (402 approval), exactly like grocery.
// =====================================================

const {
  pool,
  MERCHANT_TYPES,
  round2,
  toId,
  fail,
  text,
  effectivePrice,
  variantLabelOf,
  activeMerchantOrders,
  availabilityOf,
  isRetail,
  allowedVehiclesFor,
  customerTypeBlock,
  customerTypeRules,
} = require('./common');
const { getPricingSettings } = require('../pricing/settings');
const { resolveDeliveryRoute } = require('../pricing/deliveryRoute');
const { deliveryFares } = require('../pricing/deliveryFare');
const { DEFAULT_VEHICLE } = require('../pricing/vehicles');
const { getOwnerCard, toPublicCard } = require('../payments/paymentService');
const accountControls = require('../customers/accountControls');
const { normalizeSriLankanMobile } = require('../utils/phone');
const { broadcastOrderChange } = require('../realtime');
const { resolveDistrict } = require('./district');
const { deliveryOptionsFor } = require('./deliveryOptions');

const MAX_LINES = 40;
const MAX_QTY = 50;
const MAX_TIP = 10000;
const DROPOFFS = ['leave_at_door', 'meet_at_door'];

const issue = (index, code, message, extra = {}) => ({ index, code, message, ...extra });

const readRequestId = (value) => {
  const t = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(t) ? t : null;
};

const loadShop = async (client, shopId, lock = false) =>
  (
    await client.query(`SELECT * FROM shops WHERE id = $1 ${lock ? 'FOR SHARE' : ''}`, [shopId])
  ).rows[0] || null;

// -----------------------------------------------------
// Lines
// -----------------------------------------------------

const priceLines = async (client, shop, rawItems, { lock = false } = {}) => {
  const issues = [];
  const lines = [];
  const items = Array.isArray(rawItems) ? rawItems.slice(0, MAX_LINES + 1) : [];

  if (!items.length) {
    return { lines, issues: [issue(null, 'EMPTY', 'Add at least one item')] };
  }
  if (items.length > MAX_LINES) {
    return { lines, issues: [issue(null, 'TOO_MANY_LINES', `An order can have at most ${MAX_LINES} lines`)] };
  }

  const productIds = [...new Set(items.map((item) => toId(item?.productId)).filter(Boolean))];
  const products = new Map(
    (
      await client.query(
        `SELECT * FROM products WHERE id = ANY($1) AND shop_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
        [productIds, shop.id]
      )
    ).rows.map((row) => [Number(row.id), row])
  );

  const variantRows = (
    await client.query(
      `SELECT * FROM product_variants WHERE product_id = ANY($1) ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
      [productIds]
    )
  ).rows;
  const variantsByProduct = new Map();
  const variants = new Map();
  for (const row of variantRows) {
    variants.set(Number(row.id), row);
    if (!variantsByProduct.has(Number(row.product_id))) variantsByProduct.set(Number(row.product_id), []);
    variantsByProduct.get(Number(row.product_id)).push(row);
  }

  const groups = new Map();
  const options = new Map();
  if (shop.business_type === 'restaurant' && productIds.length) {
    const [groupRows, optionRows] = await Promise.all([
      client.query('SELECT * FROM product_option_groups WHERE product_id = ANY($1) ORDER BY sort, id', [productIds]),
      client.query('SELECT * FROM product_options WHERE product_id = ANY($1) ORDER BY sort, id', [productIds]),
    ]);
    for (const g of groupRows.rows) {
      if (!groups.has(Number(g.product_id))) groups.set(Number(g.product_id), []);
      groups.get(Number(g.product_id)).push(g);
    }
    for (const o of optionRows.rows) options.set(Number(o.id), o);
  }

  // Stock asked for across lines (the same variant on two lines)
  const wanted = new Map();

  items.forEach((item, index) => {
    const productId = toId(item?.productId);
    const product = productId ? products.get(productId) : null;
    const quantity = Number(item?.quantity);
    const note = text(item?.note, 300);

    if (!product) {
      issues.push(issue(index, 'UNAVAILABLE', 'This item is no longer sold by this store'));
      return;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      issues.push(issue(index, 'BAD_QUANTITY', `Choose a quantity between 1 and ${MAX_QTY}`));
      return;
    }
    if (!product.is_available) {
      issues.push(issue(index, 'UNAVAILABLE', `${product.product_name} is not available right now`));
      return;
    }

    let unitPrice = effectivePrice(product.price, product.discount_price);
    let variant = null;
    const chosen = [];

    if (isRetail(shop.business_type)) {
      const productVariants = variantsByProduct.get(productId) || [];

      if (productVariants.length) {
        variant = variants.get(toId(item?.variantId));
        if (!variant || Number(variant.product_id) !== productId) {
          issues.push(issue(index, 'VARIANT_REQUIRED', `Choose a size and colour for ${product.product_name}`));
          return;
        }
        if (!variant.is_available || Number(variant.stock_quantity) <= 0) {
          issues.push(issue(index, 'OUT_OF_STOCK', `${product.product_name} (${variantLabelOf(variant)}) is out of stock`));
          return;
        }
        const price = variant.price != null ? variant.price : product.price;
        const discount = variant.price != null ? variant.discount_price : variant.discount_price ?? product.discount_price;
        unitPrice = effectivePrice(price, discount);
        const key = `v${variant.id}`;
        wanted.set(key, (wanted.get(key) || 0) + quantity);
        if (wanted.get(key) > Number(variant.stock_quantity)) {
          issues.push(issue(index, 'NOT_ENOUGH_STOCK',
            `Only ${variant.stock_quantity} of ${product.product_name} (${variantLabelOf(variant)}) left`,
            { available: Number(variant.stock_quantity) }));
          return;
        }
      } else {
        const key = `p${productId}`;
        wanted.set(key, (wanted.get(key) || 0) + quantity);
        if (Number(product.stock_quantity) <= 0) {
          issues.push(issue(index, 'OUT_OF_STOCK', `${product.product_name} is out of stock`));
          return;
        }
        if (wanted.get(key) > Number(product.stock_quantity)) {
          issues.push(issue(index, 'NOT_ENOUGH_STOCK', `Only ${product.stock_quantity} of ${product.product_name} left`,
            { available: Number(product.stock_quantity) }));
          return;
        }
      }
    }

    if (shop.business_type === 'restaurant') {
      const productGroups = groups.get(productId) || [];
      const ids = Array.isArray(item?.optionIds) ? item.optionIds.map(toId) : [];
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
        issues.push(issue(index, 'OPTION_UNAVAILABLE', 'Some choices for this item are not valid. Please choose again.'));
        return;
      }
      const picked = ids.map((id) => options.get(id));
      if (picked.some((option) => !option || Number(option.product_id) !== productId)) {
        issues.push(issue(index, 'OPTION_UNAVAILABLE', `Some choices for ${product.product_name} are no longer offered. Please choose again.`));
        return;
      }
      if (picked.some((option) => !option.is_available)) {
        const gone = picked.find((option) => !option.is_available);
        issues.push(issue(index, 'OPTION_UNAVAILABLE', `${gone.name} is not available right now`));
        return;
      }
      for (const group of productGroups) {
        const count = picked.filter((option) => Number(option.group_id) === Number(group.id)).length;
        if (count < Number(group.min_select)) {
          issues.push(issue(index, 'OPTION_REQUIRED',
            `${product.product_name}: choose ${group.min_select === group.max_select ? group.min_select : `at least ${group.min_select}`} in "${group.name}"`));
          return;
        }
        if (count > Number(group.max_select)) {
          issues.push(issue(index, 'TOO_MANY_OPTIONS', `${product.product_name}: choose up to ${group.max_select} in "${group.name}"`));
          return;
        }
      }
      for (const group of productGroups) {
        for (const option of picked.filter((o) => Number(o.group_id) === Number(group.id))) {
          chosen.push({
            groupId: Number(group.id),
            groupName: group.name,
            optionId: Number(option.id),
            name: option.name,
            priceDelta: round2(option.price_delta),
          });
        }
      }
      unitPrice = round2(unitPrice + chosen.reduce((sum, o) => sum + o.priceDelta, 0));
    }

    lines.push({
      index,
      productId,
      variantId: variant ? Number(variant.id) : null,
      name: product.product_name,
      variantLabel: variant ? variantLabelOf(variant) : null,
      options: chosen,
      unitPrice,
      quantity,
      lineTotal: round2(unitPrice * quantity),
      note,
      image: product.image_url || null,
      prepMinutes: product.prep_minutes != null ? Number(product.prep_minutes) : null,
      reserveStock: isRetail(shop.business_type),
      // Phase 62: the video it was bought from (checked in buildMerchantQuote)
      reelId: toId(item?.reelId),
    });
  });

  return { lines, issues };
};

// -----------------------------------------------------
// Quote
// -----------------------------------------------------

const buildMerchantQuote = async ({ client = pool, body, lock = false }) => {
  const shopId = toId(body?.shopId);
  const shop = shopId ? await loadShop(client, shopId, lock) : null;
  let deliveryFee = 0;

  if (!shop || !MERCHANT_TYPES.includes(shop.business_type)) {
    return { error: { status: 404, code: 'STORE_NOT_FOUND', message: 'This store is not available on GetMe' } };
  }
  // Phase 61: categories closed to customers (liquor until approved)
  const typeBlock = await customerTypeBlock(shop.business_type);
  if (typeBlock) return { error: typeBlock };
  const minAge = (await customerTypeRules()).get(shop.business_type)?.minAge || null;
  const ageConfirmed = body?.ageConfirmed === true;
  const allowedVehicles = allowedVehiclesFor(shop.business_type);

  const fulfilment = ['pickup', 'shop_delivery'].includes(body?.fulfilment) ? body.fulfilment : 'delivery';
  const tip = body?.tipAmount == null || body.tipAmount === '' ? 0 : Number(body.tipAmount);
  if (!Number.isFinite(tip) || tip < 0 || tip > MAX_TIP) {
    return { error: { status: 400, code: 'BAD_TIP', message: `A tip can be up to Rs ${MAX_TIP}` } };
  }
  // Tips go to GetMe riders only
  const tipAmount = fulfilment === 'delivery' ? round2(tip) : 0;

  const { lines, issues } = await priceLines(client, shop, body?.items, { lock });
  // Phase 62: credit a fashion video only when it is published, from this
  // shop, and the product is linked to it; otherwise the line just isn't
  // attributed (never blocks the order)
  if (lines.some((line) => line.reelId)) {
    const allowed = await require('../reels/customerReels').attributableReels(client, shop.id, lines.map((line) => line.reelId));
    for (const line of lines) {
      line.sourceReelId = line.reelId && allowed.get(line.reelId)?.has(line.productId) ? line.reelId : null;
    }
  }
  const itemsTotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));

  const availability = availabilityOf(shop, await activeMerchantOrders(shop.id, client));
  // Phase 60: a store that delivers itself can take orders while closed
  // (it packs them when it opens); pause / capacity still apply
  const closedButShips = fulfilment === 'shop_delivery' && availability.reason === 'closed';
  let blockReason = availability.acceptingOrders || closedButShips ? null : availability.reason;
  let blockMessage = availability.message;
  let shipMinDays = null;
  let shipMaxDays = null;
  // Phase 61: age-restricted category - the customer confirms their age
  if (minAge && !ageConfirmed && !blockReason) {
    blockReason = 'age_confirmation_required';
    blockMessage = `Confirm you are ${minAge} or older to order from this store. Your ID will be checked at hand-over.`;
  }

  // Where the order goes (district for store delivery)
  const deliveryLat = Number(body?.deliveryLatitude);
  const deliveryLng = Number(body?.deliveryLongitude);
  const hasLocation = Number.isFinite(deliveryLat) && Number.isFinite(deliveryLng) && Math.abs(deliveryLat) <= 90 && Math.abs(deliveryLng) <= 180;
  const where = await resolveDistrict({
    declared: body?.deliveryDistrict,
    placeId: body?.deliveryPlaceId,
    latitude: hasLocation ? deliveryLat : null,
    longitude: hasLocation ? deliveryLng : null,
  });
  const deliveryOptions = hasLocation || where.district
    ? await deliveryOptionsFor({ shop, latitude: hasLocation ? deliveryLat : null, longitude: hasLocation ? deliveryLng : null, district: where.district, route: false })
    : null;

  if (fulfilment === 'shop_delivery') {
    if (!hasLocation) {
      return { error: { status: 400, code: 'LOCATION_REQUIRED', message: 'Choose a delivery address first' } };
    }
    const own = deliveryOptions.find((o) => o.method === 'shop');
    if (!own.available) {
      blockReason = blockReason || (own.reason === 'district_not_served' ? 'district_not_served' : 'no_shop_delivery');
      blockMessage = blockReason === 'district_not_served' || blockReason === 'no_shop_delivery' ? own.message : blockMessage;
    } else {
      deliveryFee = own.fee;
      shipMinDays = own.minDays;
      shipMaxDays = own.maxDays;
    }
  }

  let vehicleFees = null;
  let deliveryPricing = null;
  let distanceKm = null;
  let travelMinutes = null;

  if (fulfilment === 'pickup' && !shop.offers_pickup) {
    blockReason = blockReason || 'no_pickup';
    blockMessage = blockReason === 'no_pickup' ? 'This store does not offer pickup.' : blockMessage;
  }

  if (fulfilment === 'delivery') {
    if (!shop.offers_delivery) {
      blockReason = blockReason || 'no_delivery';
      blockMessage = blockReason === 'no_delivery' ? 'This store does not offer delivery. Choose pickup instead.' : blockMessage;
    } else {
      const latitude = Number(body?.deliveryLatitude);
      const longitude = Number(body?.deliveryLongitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        return { error: { status: 400, code: 'LOCATION_REQUIRED', message: 'Choose a delivery address first' } };
      }
      const settings = await getPricingSettings();
      const resolved = await resolveDeliveryRoute({
        shops: [{ id: shop.id, latitude: shop.latitude, longitude: shop.longitude }],
        destination: { latitude, longitude },
      });

      if (!resolved?.ok) {
        blockReason = blockReason || 'route_unavailable';
        blockMessage = blockReason === 'route_unavailable'
          ? resolved?.message || "We couldn't work out the delivery route right now. Please try again in a moment."
          : blockMessage;
      } else {
        distanceKm = resolved.distanceKm;
        if (resolved.distanceKm > Number(settings.delivery.maxKm)) {
          blockReason = blockReason || 'too_far';
          blockMessage = blockReason === 'too_far'
            ? `This address is ${resolved.distanceKm} km from the store by road. GetMe delivers up to ${settings.delivery.maxKm} km.`
            : blockMessage;
        }
        const at = new Date();
        const priced = deliveryFares(settings, {
          route: { distanceKm: resolved.distanceKm, carMinutes: resolved.traffic ? resolved.carMinutes : resolved.typicalCarMinutes },
          shopCount: 1,
          at,
        });
        vehicleFees = priced.vehicleFees;
        // Phase 61: only the vehicles allowed for this type (restaurants: Bike)
        if (allowedVehicles) {
          vehicleFees = Object.fromEntries(Object.entries(vehicleFees || {}).filter(([key]) => allowedVehicles.includes(key)));
        }
        deliveryFee = round2(Number(vehicleFees[DEFAULT_VEHICLE]) || 0);
        travelMinutes = Number(priced.fares?.[DEFAULT_VEHICLE]?.estimatedTravelMinutes) || null;
        deliveryPricing = {
          route: {
            source: resolved.source,
            distanceKm: resolved.distanceKm,
            timeBasis: resolved.traffic ? 'live_traffic' : 'typical',
            carMinutes: resolved.traffic ? resolved.carMinutes : resolved.typicalCarMinutes,
            legs: resolved.legs,
            computedAt: resolved.computedAt,
          },
          shopCount: 1,
          pricedAt: at.toISOString(),
          fareTime: at.toISOString(),
          settingsVersionId: settings.versionId ?? null,
          fares: allowedVehicles
            ? Object.fromEntries(Object.entries(priced.fares || {}).filter(([key]) => allowedVehicles.includes(key)))
            : priced.fares,
          marketplace: true,
        };
      }
    }
  }

  const linePrep = Math.max(0, ...lines.map((line) => line.prepMinutes || 0));
  const prepMinutes = Math.max(Number(shop.default_prep_minutes) || 20, linePrep);
  const total = round2(itemsTotal + deliveryFee + tipAmount);

  return {
    shop,
    quote: {
      shopId: Number(shop.id),
      businessType: shop.business_type,
      fulfilment,
      lines: lines.map(({ reserveStock, prepMinutes: _p, image, reelId: _r, ...line }) => ({ ...line, image })),
      itemsTotal,
      deliveryFee,
      tipAmount,
      total,
      prepMinutes,
      estimatedReadyAt: new Date(Date.now() + prepMinutes * 60000).toISOString(),
      estimatedDeliveryMinutes: fulfilment === 'delivery' && travelMinutes ? prepMinutes + travelMinutes : null,
      distanceKm,
      // Phase 60: store-managed delivery days (set by the store)
      shipMinDays,
      shipMaxDays,
      delivery: { district: where.district, districtSource: where.source },
      deliveryOptions,
      cashAllowed: fulfilment !== 'shop_delivery' || !!shop.shop_delivery_cod,
      // Phase 61: restaurants deliver by Bike only; null = any vehicle
      allowedVehicles: fulfilment === 'delivery' ? allowedVehicles : null,
      ageCheck: minAge ? { minAge, confirmed: ageConfirmed } : null,
      issues,
      canOrder: issues.length === 0 && !blockReason && lines.length > 0,
      blockReason,
      blockMessage: blockReason ? blockMessage : null,
    },
    internal: { lines, vehicleFees, deliveryPricing, district: where.district, districtSource: where.source, minAge },
  };
};

const getMerchantQuote = async (req, res) => {
  try {
    const built = await buildMerchantQuote({ body: req.body });
    if (built.error) return fail(res, built.error.status, built.error.message, built.error.code);
    return res.json({ success: true, quote: built.quote });
  } catch (error) {
    console.error('❌ MERCHANT QUOTE ERROR:', error.message);
    return fail(res, 500, "We couldn't price this order right now. Please try again.");
  }
};

// -----------------------------------------------------
// Place order
// -----------------------------------------------------

const BLOCK_CODES = {
  closed: [409, 'STORE_CLOSED'],
  paused: [409, 'STORE_PAUSED'],
  busy: [409, 'STORE_BUSY'],
  not_approved: [409, 'STORE_CLOSED'],
  no_delivery: [400, 'NO_DELIVERY'],
  no_pickup: [400, 'NO_PICKUP'],
  too_far: [400, 'TOO_FAR'],
  route_unavailable: [503, 'ROUTE_UNAVAILABLE'],
  no_shop_delivery: [400, 'NO_SHOP_DELIVERY'],
  district_not_served: [400, 'DISTRICT_NOT_SERVED'],
  age_confirmation_required: [400, 'AGE_CONFIRMATION_REQUIRED'],
};

const existingByRequest = async (customerId, requestId) =>
  requestId
    ? (
        await pool.query(
          `SELECT * FROM orders WHERE customer_id = $1 AND client_request_id = $2 AND business_type <> 'grocery'`,
          [customerId, requestId]
        )
      ).rows[0] || null
    : null;

// -----------------------------------------------------
// Phase 65: place one merchant order inside the caller's open
// transaction (createMerchantOrder below, and a one-checkout parent
// order's restaurant / clothing children - src/orderGroups).
// -> { refusal: [status, body] } (caller rolls back and answers) or
//    { order }. Throws { stockRace } like before.
// -----------------------------------------------------

const placeMerchantOrderTx = async (client, {
  customerId,
  body,
  paymentMethod,
  deliveryAddress,
  dropoff,
  instructions,
  contactPhone,
  requestId,
  orderGroupId = null,
}) => {
  let order;
  let refusal = null;

    await client.query('SELECT id FROM customers WHERE id = $1 FOR UPDATE', [customerId]);

    const built = await buildMerchantQuote({ client, body: body, lock: true });
    if (built.error) {
      refusal = [built.error.status, { code: built.error.code, message: built.error.message }];
    } else {
      const { quote, shop, internal } = built;

      if (quote.issues.length) {
        refusal = [409, { code: 'ORDER_ISSUES', message: quote.issues[0].message, issues: quote.issues, quote }];
      } else if (quote.blockReason) {
        const [status, code] = BLOCK_CODES[quote.blockReason] || [409, 'STORE_UNAVAILABLE'];
        refusal = [status, { code, message: quote.blockMessage, quote }];
      } else {
        const expected = Number(body?.expectedTotal);
        if (body?.expectedTotal != null && body.expectedTotal !== '' && Number.isFinite(expected) &&
            Math.abs(expected - quote.total) > 0.009) {
          refusal = [409, { code: 'PRICE_CHANGED', message: `The total is now Rs ${quote.total.toFixed(2)}. Please review and confirm.`, quote }];
        }
      }

      if (!refusal) {
        const controls = await accountControls.controlsFor(customerId, client);
        if (controls?.status === 'blocked') {
          refusal = [403, accountControls.blockedBody()];
        } else if (paymentMethod === 'cash' && !quote.cashAllowed) {
          refusal = [400, { code: 'CASH_NOT_OFFERED', message: 'This store does not take cash on delivery. Pay by card.' }];
        } else if (paymentMethod === 'cash') {
          const cash = accountControls.paymentOptionsFor(controls, quote.total).cash;
          if (!cash.allowed) refusal = [accountControls.cashRefusalStatus(cash.code), { code: cash.code, message: cash.reason, limit: cash.limit }];
        }
      }

      let paymentCardId = null;
      if (!refusal && paymentMethod === 'card') {
        const card = await getOwnerCard({ type: 'customer', id: customerId }, Number(body?.cardId) || 0, client);
        if (!card) refusal = [400, { code: 'CARD_REQUIRED', message: 'Add or choose a card to pay with' }];
        else if (toPublicCard(card).expired) refusal = [400, { code: 'CARD_EXPIRED', message: `${toPublicCard(card).label} has expired. Choose another card.` }];
        else paymentCardId = Number(card.id);
      }

      if (!refusal) {
        const commission = (
          await client.query('SELECT commission_percent FROM business_types WHERE key = $1', [shop.business_type])
        ).rows[0]?.commission_percent ?? 0;

        order = (
          await client.query(
            `INSERT INTO orders (
               customer_id, shop_id, business_type, fulfilment_method, merchant_status,
               delivery_address, delivery_latitude, delivery_longitude, delivery_option, payment_method,
               items_total, delivery_fee, fast_delivery_fee, service_fee, total_amount, distance_km,
               estimated_delivery_minutes, tip_amount, discount_amount, window_discount,
               delivery_dropoff, delivery_instructions, contact_phone, vehicle_fees, offer_savings,
               payment_card_id, getme_fee, getme_fee_percent, service_fee_per_unit, client_request_id,
               delivery_pricing, merchant_prep_minutes, commission_percent, commission_amount,
               delivery_district, delivery_district_source, ship_min_days, ship_max_days,
               min_customer_age, age_confirmed_at, status)
             VALUES ($1,$2,$3,$4,'new',$5,$6,$7,'standard',$8,$9,$10,0,0,$11,$12,$13,$14,0,0,$15,$16,$17,$18,0,
                     $19,0,0,0,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,'pending_shopper_search')
             RETURNING *`,
            [
              customerId, shop.id, shop.business_type, quote.fulfilment,
              // Pickup: the order ends at the store (columns are NOT NULL)
              quote.fulfilment !== 'pickup' ? deliveryAddress : `Pickup at ${shop.shop_name}${shop.address ? `, ${shop.address}` : ''}`.slice(0, 500),
              quote.fulfilment !== 'pickup' ? Number(body.deliveryLatitude) : Number(shop.latitude),
              quote.fulfilment !== 'pickup' ? Number(body.deliveryLongitude) : Number(shop.longitude),
              paymentMethod,
              quote.itemsTotal, quote.deliveryFee, quote.total, quote.distanceKm,
              quote.estimatedDeliveryMinutes, quote.tipAmount,
              quote.fulfilment === 'delivery' ? dropoff : null,
              instructions, contactPhone, internal.vehicleFees, paymentCardId, requestId,
              internal.deliveryPricing, quote.prepMinutes, commission,
              round2((quote.itemsTotal * Number(commission)) / 100),
              quote.fulfilment !== 'pickup' ? internal.district : null,
              quote.fulfilment !== 'pickup' ? internal.districtSource : null,
              quote.shipMinDays, quote.shipMaxDays,
              internal.minAge, internal.minAge ? new Date() : null,
            ]
          )
        ).rows[0];

        await client.query(
          'INSERT INTO order_shops (order_id, shop_id, shop_name, shop_image) VALUES ($1, $2, $3, $4)',
          [order.id, shop.id, shop.shop_name, shop.image_url || null]
        );

        for (const line of internal.lines) {
          const inserted = (
            await client.query(
              `INSERT INTO order_items (
                 order_id, shop_id, product_id, item_name, quantity, amount, unit, price, unit_price,
                 regular_unit_price, line_total, custom, details, image, replacement_preference,
                 variant_id, variant_label, options, stock_reserved, source_reel_id)
               VALUES ($1,$2,$3,$4,$5,1,'item',$6,$6,$6,$7,false,$8,$9,'refund',$10,$11,$12,$13,$14)
               RETURNING id`,
              [
                order.id, shop.id, line.productId, line.name, line.quantity, line.unitPrice, line.lineTotal,
                line.note, line.image, line.variantId, line.variantLabel,
                line.options.length ? JSON.stringify(line.options) : null, line.reserveStock,
                line.sourceReelId || null,
              ]
            )
          ).rows[0];

          if (line.reserveStock) {
            const target = line.variantId
              ? await client.query(
                  `UPDATE product_variants SET stock_quantity = stock_quantity - $2, updated_at = NOW()
                   WHERE id = $1 AND stock_quantity >= $2 RETURNING stock_quantity`,
                  [line.variantId, line.quantity]
                )
              : await client.query(
                  `UPDATE products SET stock_quantity = stock_quantity - $2, updated_at = NOW()
                   WHERE id = $1 AND stock_quantity >= $2 RETURNING stock_quantity`,
                  [line.productId, line.quantity]
                );

            if (!target.rows.length) {
              throw Object.assign(new Error('stock changed'), { stockRace: true });
            }
            const after = Number(target.rows[0].stock_quantity);

            if (line.variantId) {
              await client.query(
                `UPDATE products p SET stock_quantity = COALESCE((SELECT SUM(stock_quantity) FROM product_variants WHERE product_id = p.id), 0),
                        updated_at = NOW() WHERE p.id = $1`,
                [line.productId]
              );
            }

            await client.query(
              `INSERT INTO product_stock_movements (shop_id, product_id, variant_id, change, stock_before, stock_after,
                 reason, note, order_id, order_item_id, actor_type, actor_name)
               VALUES ($1,$2,$3,$4,$5,$6,'sold_getme',$7,$8,$9,'system','GetMe')`,
              [shop.id, line.productId, line.variantId, -line.quantity, after + line.quantity, after,
               `Order #${order.id}${line.variantLabel ? ` (${line.variantLabel})` : ''}`, order.id, inserted.id]
            );
          }
        }
      }
    }


  if (refusal) return { refusal };

  // Phase 65: a child of a one-checkout parent order
  if (orderGroupId) {
    order = (
      await client.query('UPDATE orders SET order_group_id = $2 WHERE id = $1 RETURNING *', [order.id, orderGroupId])
    ).rows[0];
  }

  return { order, quote: null };
};

const createMerchantOrder = async (req, res) => {
  const customerId = Number(req.customer.customerId);
  const requestId = readRequestId(req.body?.requestId);
  const { summarizeForCustomer } = require('./merchantOrders');

  try {
    const earlier = await existingByRequest(customerId, requestId);
    if (earlier) {
      return res.status(200).json({ success: true, duplicate: true, order: await summarizeForCustomer(earlier.id, customerId) });
    }

    const fulfilmentRequested = ['pickup', 'shop_delivery'].includes(req.body?.fulfilment) ? req.body.fulfilment : 'delivery';
    const paymentMethod = req.body?.paymentMethod === 'card' ? 'card' : req.body?.paymentMethod === 'cash' || req.body?.paymentMethod == null ? 'cash' : null;
    if (!paymentMethod) return fail(res, 400, 'Choose cash or card', 'BAD_PAYMENT_METHOD');

    const deliveryAddress = text(req.body?.deliveryAddress, 500);
    if (fulfilmentRequested !== 'pickup' && !deliveryAddress) {
      return fail(res, 400, 'Choose a delivery address first', 'ADDRESS_REQUIRED');
    }
    const dropoff = DROPOFFS.includes(req.body?.deliveryDropoff) ? req.body.deliveryDropoff : 'meet_at_door';
    const instructions = text(req.body?.deliveryInstructions, 500);
    let contactPhone = null;
    if (req.body?.contactPhone) {
      contactPhone = normalizeSriLankanMobile(req.body.contactPhone);
      if (!contactPhone) return fail(res, 400, 'Enter a valid Sri Lankan mobile number', 'BAD_PHONE');
    }

    const client = await pool.connect();
    let order;
    let refusal = null;

    try {
      await client.query('BEGIN');
      const placed = await placeMerchantOrderTx(client, {
        customerId,
        body: req.body,
        paymentMethod,
        deliveryAddress,
        dropoff,
        instructions,
        contactPhone,
        requestId,
      });
      if (placed.refusal) refusal = placed.refusal;
      else order = placed.order;

      await client.query(refusal ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.stockRace) {
        return fail(res, 409, 'Someone just bought the last one. Please check your bag again.', 'ORDER_ISSUES');
      }
      if (error.code === '23505' && requestId) {
        const again = await existingByRequest(customerId, requestId);
        if (again) return res.status(200).json({ success: true, duplicate: true, order: await summarizeForCustomer(again.id, customerId) });
      }
      throw error;
    } finally {
      client.release();
    }

    if (refusal) {
      return res.status(refusal[0]).json({ success: false, ...refusal[1] });
    }

    broadcastOrderChange(req.app.get('io'), order.id, { event: 'order-created', status: order.status });

    return res.status(201).json({ success: true, order: await summarizeForCustomer(order.id, customerId) });
  } catch (error) {
    console.error('❌ CREATE MERCHANT ORDER ERROR:', error.message);
    return fail(res, 500, "We couldn't place this order. Please try again.");
  }
};

module.exports = {
  buildMerchantQuote,
  getMerchantQuote,
  createMerchantOrder,
  priceLines,
  // Phase 65
  placeMerchantOrderTx,
  BLOCK_CODES,
  readRequestId,
};
