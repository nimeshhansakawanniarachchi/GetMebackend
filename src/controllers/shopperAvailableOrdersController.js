
const db = require('../config/db');

const {
  OFFER_RADIUS_KM,
  shopperPayForOrder,
} = require('./shopperPay');
const { deliveryFeeForShopper } = require('../pricing/vehicles');
const { getPricingSettings } = require('../pricing/settings');
const { offerRoute } = require('../utils/offerRoute');
const {
  STORE_MINUTES,
  MINUTES_PER_UNIT,
  isHeavyLine,
  isWeighedLine,
  unitsOf,
  deliveryAreaOf,
  earningsBreakdown,
  shoppingMinutesFor,
} = require('../utils/offerDetails');

const {
  VEHICLE_FALLBACK_SECONDS,
  dispatchOrder,
  dispatchWaitingOrders,
} = require('./shopperDispatch');

// =====================================================
// GET SHOPPER ID
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
// GET AVAILABLE ORDERS
// =====================================================

const getAvailableOrders = async (req, res) => {
  try {
    const shopperId = getShopperId(req);

    if (!shopperId) {
      return res.status(401).json({
        success: false,
        message: 'Shopper authentication required',
      });
    }

    // ===================================================
    // SHOPPER LOCATION
    // ===================================================

    const shopperResult = await db.query(
      `
      SELECT
        id,
        latitude,
        longitude,
        status,
        approval_status,
        vehicle_type
      FROM shoppers
      WHERE id = $1
      LIMIT 1
      `,
      [shopperId]
    );

    if (shopperResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Shopper not found',
      });
    }

    const shopper = shopperResult.rows[0];

    if (shopper.approval_status !== 'approved') {
      return res.status(403).json({
        success: false,
        approvalStatus: shopper.approval_status,
        message: 'Your account is waiting for GetMe approval.',
      });
    }

    const shopperLatitude = Number(shopper.latitude);
    const shopperLongitude = Number(shopper.longitude);

    if (
      !Number.isFinite(shopperLatitude) ||
      !Number.isFinite(shopperLongitude)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Shopper location is not available',
      });
    }

    // ===================================================
    // MOVE EXPIRED / HIDDEN OFFERS ON TO THE NEXT SHOPPER
    // Each waiting order is offered to one shopper at a time,
    // closest to the shop first (see shopperDispatch.js).
    // ===================================================

    await dispatchWaitingOrders({ io: req.app.get('io') });

    // ===================================================
    // GET AVAILABLE ORDERS + SHOPS
    // ===================================================

    const ordersResult = await db.query(
      `
      SELECT
        o.id,
        o.customer_id,

        c.full_name AS customer_name,
        COALESCE(o.contact_phone, c.mobile) AS customer_phone,

        os.shop_id,

        o.delivery_address,
        o.delivery_latitude,
        o.delivery_longitude,

        o.delivery_option,
        o.payment_method,

        -- Preferred vehicle, unless the search has fallen back to any
        CASE
          WHEN o.shopper_search_started_at <= NOW() - make_interval(secs => $4)
            THEN NULL
          ELSE o.preferred_vehicle_type
        END AS preferred_vehicle_type,

        o.items_total,
        o.delivery_fee,
        o.vehicle_fees,
        o.fast_delivery_fee,
        o.service_fee,
        o.total_amount,
        o.tip_amount,
        o.estimated_delivery_minutes,
        o.service_fee_per_unit,
        o.getme_fee_percent,

        o.delivery_dropoff,
        o.delivery_instructions,
        o.scheduled_date::text AS scheduled_date,
        o.scheduled_start_time,
        o.scheduled_end_time,

        o.distance_km AS customer_distance_km,

        o.status,
        o.created_at,
        o.updated_at,
        o.shopper_id,
        o.shopper_search_started_at,

        so.first_seen_at AS offer_started_at,

        s.shop_name,
        s.image_url AS shop_image,
        s.status AS shop_status,
        s.address AS shop_address,
        s.area AS shop_area,

        s.latitude AS shop_latitude,
        s.longitude AS shop_longitude,

        (
          6371 * acos(
            LEAST(
              1,
              GREATEST(
                -1,
                cos(radians($1))
                *
                cos(radians(s.latitude))
                *
                cos(
                  radians(s.longitude)
                  -
                  radians($2)
                )
                +
                sin(radians($1))
                *
                sin(radians(s.latitude))
              )
            )
          )
        ) AS shop_distance_km

      FROM orders o

      INNER JOIN order_shops os
        ON os.order_id = o.id

      LEFT JOIN customers c
        ON c.id = o.customer_id

      INNER JOIN shops s
        ON s.id = os.shop_id

      -- Only batches currently offered to THIS shopper. Offers don't
      -- expire: they stay until the batch is accepted (by anyone) or
      -- this shopper hides it
      INNER JOIN shopper_order_offers so
        ON so.order_id = o.id
        AND so.shopper_id = $3
        AND so.dismissed_at IS NULL

      WHERE
        o.status = 'waiting_for_shopper'
        AND o.shopper_id IS NULL
        AND s.status = 'approved'
        AND s.is_open = true
        AND s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL

      -- Shops in the order the shopper visits them after accepting
      -- (accept + the shopping flow go by shop id), so the numbered
      -- stops on the offer match the real trip
      ORDER BY
        o.created_at ASC,
        os.shop_id ASC
      `,
      [
        shopperLatitude,
        shopperLongitude,
        shopperId,
        VEHICLE_FALLBACK_SECONDS,
      ]
    );

    console.log('🟢 SHOPPER ID:', shopperId);

    console.log('🟢 SHOPPER LOCATION:', {
      latitude: shopperLatitude,
      longitude: shopperLongitude,
      status: shopper.status,
    });

    // ===================================================
    // GROUP ORDERS
    // ===================================================

    const groupedOrders = new Map();

    // Service fee per unit fallback for older orders (no snapshot)
    const pricingSettings = await getPricingSettings().catch(() => null);

    // Every offered order's items in one query (this endpoint is
    // polled every few seconds), keyed by order + shop
    const offeredOrderIds = [...new Set(ordersResult.rows.map((row) => row.id))];

    const itemRows = offeredOrderIds.length
      ? (
          await db.query(
            `
            SELECT
              oi.id,
              oi.order_id,
              oi.product_id,
              oi.item_name,
              oi.quantity,
              oi.amount,
              oi.unit,
              oi.price,
              oi.custom,
              oi.details,
              oi.image,
              oi.voice_url,
              oi.shopper_photo_url,
              oi.shopping_status,
              oi.found_quantity,
              oi.found_weight,
              oi.found_weight_unit,
              oi.barcode_scanned,
              oi.completed_at,
              oi.shop_id,
              oi.replacement_preference,
              oi.replacement_product_id,
              oi.replacement_product_name,
              oi.replacement_product_image,
              oi.replacement_product_price,
              oi.replacement_note,
              p.size AS product_size,
              p.category AS product_category

            FROM order_items oi
            LEFT JOIN products p ON p.id = oi.product_id

            WHERE oi.order_id = ANY($1::int[])

            ORDER BY oi.id ASC
            `,
            [offeredOrderIds]
          )
        ).rows
      : [];

    const itemsByOrderShop = new Map();

    itemRows.forEach((item) => {
      const key = `${item.order_id}-${item.shop_id}`;

      if (!itemsByOrderShop.has(key)) {
        itemsByOrderShop.set(key, []);
      }

      itemsByOrderShop.get(key).push(item);
    });

    for (const order of ordersResult.rows) {
      const orderKey = String(order.id);

      if (!groupedOrders.has(orderKey)) {
        groupedOrders.set(orderKey, {
          baseOrder: order,
          shops: [],
          shopNames: [],
          orderItems: [],
          batchOrders: [],
          shopDistances: [],
        });
      }

      const group = groupedOrders.get(orderKey);

      // =================================================
      // GET ITEMS FOR THIS ORDER AND SHOP
      // =================================================

      const shopItemRows = itemsByOrderShop.get(`${order.id}-${order.shop_id}`) || [];

      const orderItems = shopItemRows.map((item) => ({
        id: item.id,
        orderId: item.order_id,
        productId: item.product_id,

        name: item.item_name,
        productName: item.item_name,

        quantity: item.quantity,
        amount: item.amount,
        unit: item.unit,
        price: item.price,

        custom: item.custom,
        details: item.details,
        image: item.image,

        voiceUrl: item.voice_url || null,
        shopperPhotoUrl: item.shopper_photo_url || null,

        shoppingStatus: item.shopping_status || 'pending',

        foundQuantity: item.found_quantity,
        foundWeight: item.found_weight,
        foundWeightUnit: item.found_weight_unit,

        barcodeScanned: item.barcode_scanned || false,
        completedAt: item.completed_at,

        shopId: item.shop_id,
        shop_id: item.shop_id,

        replacementPreference: item.replacement_preference || 'best_match',
        replacementProductId: item.replacement_product_id,
        replacementProductName: item.replacement_product_name,
        replacementProductImage: item.replacement_product_image,
        replacementProductPrice: item.replacement_product_price,
        replacementNote: item.replacement_note,

        // Pack size from the product ("5kg") + handling flags
        size: item.product_size || null,
        category: item.product_category || null,
        heavy: isHeavyLine({
          quantity: item.quantity,
          unit: item.unit,
          custom: item.custom,
          size: item.product_size,
          name: item.item_name,
        }),
        weighed: isWeighedLine(item),
      }));

      if (orderItems.length === 0) {
        continue;
      }

      const shopDistanceKm = Number(order.shop_distance_km);
      const customerDistanceKm = Number(order.customer_distance_km);

      // =================================================
      // SHOP OBJECT
      // =================================================

      const shopObject = {
        shopId: order.shop_id,
        shopName: order.shop_name,
        shopImage: order.shop_image || null,
        shopAddress: order.shop_address || null,
        address: order.shop_address || null,
        area: order.shop_area || null,

        pickupLatitude:
          order.shop_latitude !== null
            ? Number(order.shop_latitude)
            : null,

        pickupLongitude:
          order.shop_longitude !== null
            ? Number(order.shop_longitude)
            : null,

        distanceKm: Number.isFinite(shopDistanceKm)
          ? shopDistanceKm
          : 0,

        shopDistanceKm: Number.isFinite(shopDistanceKm)
          ? shopDistanceKm
          : 0,

        customerDistanceKm: Number.isFinite(customerDistanceKm)
          ? customerDistanceKm
          : 0,

        // Stop number in the trip (1 = first shop)
        sequence: group.shops.length + 1,

        // Different products / service-fee units from this shop
        uniqueItems: orderItems.length,
        totalUnits: unitsOf(orderItems),

        items: orderItems,
        orderItems,
        shoppingList: orderItems,

        itemCount: orderItems.length,

        totalItems: orderItems.reduce((total, item) => {
          const quantity = Number(item.quantity || 1);

          return (
            total +
            (Number.isFinite(quantity) ? quantity : 1)
          );
        }, 0),
      };

      // =================================================
      // SHOP BATCH ORDER
      // =================================================

      const shopBatchId = `${order.id}-${order.shop_id}`;

      const batchOrder = {
        id: order.id,
        orderId: order.id,
        batchId: shopBatchId,
        customerOrderId: order.id,

        customerId: order.customer_id,

        customerName:
          order.customer_name ||
          `Customer #${order.customer_id}`,

        customerPhone: order.customer_phone || null,
        phone: order.customer_phone || null,

        shopId: order.shop_id,

        store: order.shop_name,
        storeName: order.shop_name,
        shop: order.shop_name,

        shopImage: order.shop_image || null,

        pickupLatitude:
          order.shop_latitude !== null
            ? Number(order.shop_latitude)
            : null,

        pickupLongitude:
          order.shop_longitude !== null
            ? Number(order.shop_longitude)
            : null,

        distanceKm: Number.isFinite(shopDistanceKm)
          ? shopDistanceKm
          : 0,

        distance: Number.isFinite(shopDistanceKm)
          ? `${shopDistanceKm.toFixed(2)} km`
          : 'Nearby',

        shopDistanceKm: Number.isFinite(shopDistanceKm)
          ? shopDistanceKm
          : 0,

        customerDistanceKm: Number.isFinite(customerDistanceKm)
          ? customerDistanceKm
          : 0,

        customerDistance: Number.isFinite(customerDistanceKm)
          ? `${customerDistanceKm.toFixed(2)} km`
          : 'Unknown',

        itemsTotal: Number(order.items_total || 0),
        deliveryFee: deliveryFeeForShopper(order, shopper.vehicle_type),
        serviceFee: Number(order.service_fee || 0),
        totalAmount: Number(order.total_amount || 0),

        status: order.status,

        items: orderItems.length,
        shoppingList: orderItems,
        orderItems,
      };

      group.shops.push(shopObject);
      group.shopNames.push(order.shop_name);
      group.orderItems.push(...orderItems);
      group.batchOrders.push(batchOrder);

      if (Number.isFinite(shopDistanceKm)) {
        group.shopDistances.push(shopDistanceKm);
      }
    }

    // ===================================================
    // BUILD FINAL ORDERS
    // ===================================================

    const orders = [];

    for (const group of groupedOrders.values()) {
      const order = group.baseOrder;

      if (group.shops.length === 0) {
        continue;
      }

      const shopDistances = group.shopDistances;

      const allShopsInRange =
        shopDistances.length === group.shops.length &&
        shopDistances.every(
          (distance) =>
            Number.isFinite(distance) &&
            distance <= OFFER_RADIUS_KM
        );

      if (!allShopsInRange) {
        console.log(
          `⚠️ ORDER SKIPPED - SHOP OUTSIDE ${OFFER_RADIUS_KM} KM:`,
          order.id
        );

        continue;
      }

      const nearestShopDistanceKm =
        shopDistances.length > 0
          ? Math.min(...shopDistances)
          : 0;

      const customerDistanceKm = Number(order.customer_distance_km);
      const allOrderItems = group.orderItems;

      const totalItems = allOrderItems.reduce((total, item) => {
        const quantity = Number(item.quantity || 1);

        return (
          total +
          (Number.isFinite(quantity) ? quantity : 1)
        );
      }, 0);

      const primaryShop = group.shops[0] || null;

      // For this shopper's vehicle (pricing/vehicles.js)
      const shopperEarnings = shopperPayForOrder(order, shopper.vehicle_type);

      // -------------------------------------------------
      // OFFER SUMMARY (Batches screen): counts, pay by
      // category, delivery, handling. The route is added below.
      // -------------------------------------------------

      const totalUnits = unitsOf(allOrderItems);
      const heavyItems = allOrderItems
        .filter((item) => item.heavy)
        .map((item) => ({
          name: item.name,
          quantity: Number(item.quantity) || 1,
          unit: item.unit || null,
          size: item.size,
          shopId: item.shopId,
        }));
      const weighedCount = allOrderItems.filter((item) => item.weighed).length;
      const customCount = allOrderItems.filter((item) => item.custom && !item.productId).length;
      const isScheduled = !!order.scheduled_date;
      const isPriority =
        order.delivery_option === 'fast' || Number(order.fast_delivery_fee || 0) > 0;
      const isCash = order.payment_method === 'cash';

      const placedAt = new Date(order.created_at).getTime();
      const deliveryMinutes = Number(order.estimated_delivery_minutes);
      const deliverBy =
        !isScheduled && Number.isFinite(placedAt) && deliveryMinutes > 0
          ? new Date(placedAt + deliveryMinutes * 60 * 1000).toISOString()
          : null;

      const offer = {
        // One batch = one customer order today (see hasMultipleOrders)
        orderCount: 1,
        shopCount: group.shops.length,
        uniqueItems: allOrderItems.length,
        totalUnits,

        earnings: earningsBreakdown(
          order,
          shopper.vehicle_type,
          allOrderItems,
          pricingSettings
        ),

        // Paid at the store's till by the shopper and reimbursed by
        // GetMe (store_payments) - not earnings
        groceryEstimate: Number(order.items_total || 0),

        payment: {
          method: order.payment_method || null,
          // Cash orders: the customer pays the shopper at the door.
          // The final amount can change after shopping.
          cashToCollect: isCash ? Number(order.total_amount || 0) : null,
        },

        delivery: {
          area: deliveryAreaOf(order.delivery_address),
          address: order.delivery_address || null,
          latitude: Number.isFinite(Number(order.delivery_latitude))
            ? Number(order.delivery_latitude)
            : null,
          longitude: Number.isFinite(Number(order.delivery_longitude))
            ? Number(order.delivery_longitude)
            : null,
          dropoff: order.delivery_dropoff || null,
          instructions: order.delivery_instructions || null,
          option: order.delivery_option || null,
          priority: isPriority,
          scheduled: isScheduled
            ? {
                date: order.scheduled_date,
                start: order.scheduled_start_time || null,
                end: order.scheduled_end_time || null,
              }
            : null,
          deliverBy,
        },

        handling: {
          heavyItems,
          weighedCount,
          customCount,
          flags: [
            heavyItems.length > 0 && 'heavy',
            weighedCount > 0 && 'weighed',
            customCount > 0 && 'custom',
            isPriority && 'priority',
            isScheduled && 'scheduled',
            isCash && 'cash',
            order.delivery_instructions && 'instructions',
          ].filter(Boolean),
        },

        // Filled in after the loop (needs a routing request)
        route: null,
        time: null,
      };

      const finalOrder = {
        id: order.id,
        orderId: order.id,

        batchId: order.id,
        orderGroupId: order.id,
        customerOrderId: order.id,

        customerId: order.customer_id,

        // PRIMARY SHOP
        shopId: primaryShop?.shopId || null,
        store: primaryShop?.shopName || null,
        storeName: primaryShop?.shopName || null,
        shop: primaryShop?.shopName || null,
        shopImage: primaryShop?.shopImage || null,

        pickupLatitude: primaryShop?.pickupLatitude ?? null,
        pickupLongitude: primaryShop?.pickupLongitude ?? null,

        // CUSTOMER
        customer: order.delivery_address,

        customerName:
          order.customer_name ||
          `Customer #${order.customer_id}`,

        phone: order.customer_phone || null,
        customerPhone: order.customer_phone || null,

        customerLatitude: Number(order.delivery_latitude),
        customerLongitude: Number(order.delivery_longitude),

        latitude: Number(order.delivery_latitude),
        longitude: Number(order.delivery_longitude),

        deliveryAddress: order.delivery_address,

        // MONEY
        itemsTotal: Number(order.items_total || 0),
        deliveryFee: deliveryFeeForShopper(order, shopper.vehicle_type),
        serviceFee: Number(order.service_fee || 0),
        totalAmount: Number(order.total_amount || 0),

        // DISTANCE
        distance: Number.isFinite(nearestShopDistanceKm)
          ? `${nearestShopDistanceKm.toFixed(2)} km`
          : 'Nearby',

        distanceKm: Number.isFinite(nearestShopDistanceKm)
          ? nearestShopDistanceKm
          : 0,

        shopDistanceKm: Number.isFinite(nearestShopDistanceKm)
          ? nearestShopDistanceKm
          : 0,

        customerDistance: Number.isFinite(customerDistanceKm)
          ? `${customerDistanceKm.toFixed(2)} km`
          : 'Unknown',

        customerDistanceKm: Number.isFinite(customerDistanceKm)
          ? customerDistanceKm
          : 0,

        // ORDER INFO
        deliveryOption: order.delivery_option,
        paymentMethod: order.payment_method,

        // Customer's preferred vehicle (null = any). Batches are only
        // offered to shoppers with this vehicle.
        preferredVehicleType: order.preferred_vehicle_type || null,

        status: order.status,
        createdAt: order.created_at,
        updatedAt: order.updated_at,

        // ITEMS
        items: allOrderItems.length,
        shoppingList: allOrderItems,
        orderItems: allOrderItems,

        // MULTI SHOP
        isBatch: true,
        hasMultipleOrders: false,
        batchOrder: true,

        shopCount: group.shops.length,
        shopNames: group.shopNames,
        shops: group.shops,

        // SHOPPER PAY (delivery fee for their vehicle + priority fee
        // + service fee + 100% tip; breakdown in offer.earnings)
        shopperEarnings,
        fastDeliveryFee: Number(order.fast_delivery_fee || 0),
        // Part of shopperEarnings, for "Includes LKR X tip"
        tipAmount: Number(order.tip_amount || 0),

        // Customer's delivery estimate (minutes after the order was
        // placed), for "Deliver by 3:45 PM"
        estimatedDeliveryMinutes:
          order.estimated_delivery_minutes != null
            ? Number(order.estimated_delivery_minutes)
            : null,

        // Identifies this offer: a batch the shopper hid can be
        // offered to them again in a later round (shown again)
        offerStartedAt: order.offer_started_at,
        waitingSince:
          order.shopper_search_started_at ||
          order.created_at,

        // TOTALS
        batchFee: shopperEarnings,
        totalFee: shopperEarnings,
        batchTotalAmount: Number(order.total_amount || 0),

        batchDistanceKm: Number.isFinite(nearestShopDistanceKm)
          ? nearestShopDistanceKm
          : 0,

        batchDistance: Number.isFinite(nearestShopDistanceKm)
          ? `${nearestShopDistanceKm.toFixed(2)} km`
          : 'Nearby',

        totalItems,

        totalCustomerDistanceKm: Number.isFinite(customerDistanceKm)
          ? customerDistanceKm
          : 0,

        batchOrders: group.batchOrders,

        // Batches screen summary (see above)
        offer,
        uniqueItems: offer.uniqueItems,
        totalUnits: offer.totalUnits,
        deliveryArea: offer.delivery.area,
      };

      orders.push(finalOrder);
    }

    // ===================================================
    // ROUTE PER OFFER: shopper -> shops in visiting order ->
    // customer (road distances / drive times, utils/offerRoute)
    // ===================================================

    await Promise.all(
      orders.map(async (finalOrder) => {
        const { offer } = finalOrder;
        const customer = offer.delivery;
        const hasCustomer = customer.latitude !== null && customer.longitude !== null;

        const route = hasCustomer
          ? await offerRoute({
              cacheId: `offer-${finalOrder.id}`,
              stops: [
                { latitude: shopperLatitude, longitude: shopperLongitude },
                ...finalOrder.shops.map((shop) => ({
                  latitude: shop.pickupLatitude,
                  longitude: shop.pickupLongitude,
                })),
                { latitude: customer.latitude, longitude: customer.longitude },
              ],
              vehicleType: shopper.vehicle_type,
            }).catch((error) => {
              console.log('⚠️ offer route error:', error?.message);
              return null;
            })
          : null;

        if (!route) {
          return;
        }

        const shoppingMinutes = shoppingMinutesFor(offer.totalUnits, offer.shopCount);

        offer.route = {
          ...route,
          // Leg 0 is shopper -> first shop
          toFirstShopKm: route.legs[0]?.distanceKm ?? null,
          toFirstShopMinutes: route.legs[0]?.driveMinutes ?? null,
          // Shops -> customer (what the delivery fee pays for)
          tripKm:
            Math.round(
              route.legs.slice(1).reduce((sum, leg) => sum + leg.distanceKm, 0) * 10
            ) / 10,
        };

        offer.time = {
          estimated: true,
          driveMinutes: route.driveMinutes,
          shoppingMinutes,
          totalMinutes: route.driveMinutes + shoppingMinutes,
          basis: `${STORE_MINUTES} min per shop + ${MINUTES_PER_UNIT} min per unit`,
        };
      })
    );

    // ===================================================
    // SORT BY SHOP DISTANCE
    // ===================================================

    orders.sort((a, b) => {
      const distanceA = Number(a.batchDistanceKm || 0);
      const distanceB = Number(b.batchDistanceKm || 0);

      if (distanceA !== distanceB) {
        return distanceA - distanceB;
      }

      return new Date(a.createdAt) - new Date(b.createdAt);
    });

    // ===================================================
    // BATCHES
    // ===================================================

    const batches = orders.map((order) => ({
      batchId: order.batchId,
      orderGroupId: order.orderGroupId,
      customerOrderId: order.customerOrderId,

      customerId: order.customerId,
      customerName: order.customerName,
      customerPhone: order.customerPhone,

      shopCount: order.shopCount,
      shopNames: order.shopNames,
      shops: order.shops,

      isBatch: order.isBatch,
      hasMultipleOrders: order.hasMultipleOrders,
      batchOrder: order.batchOrder,

      batchFee: order.batchFee,
      totalFee: order.totalFee,
      batchTotalAmount: order.batchTotalAmount,

      shopperEarnings: order.shopperEarnings,
      tipAmount: order.tipAmount,
      estimatedDeliveryMinutes: order.estimatedDeliveryMinutes,
      offerStartedAt: order.offerStartedAt,
      waitingSince: order.waitingSince,

      batchDistanceKm: order.batchDistanceKm,
      batchDistance: order.batchDistance,

      totalItems: order.totalItems,
      totalCustomerDistanceKm: order.totalCustomerDistanceKm,

      batchOrders: order.batchOrders,

      offer: order.offer,

      shoppingList: order.shoppingList,
      orderItems: order.orderItems,
      items: order.items,
    }));

    // ===================================================
    // NO CACHE
    // ===================================================

    res.set({
      'Cache-Control':
        'no-store, no-cache, must-revalidate, proxy-revalidate',

      Pragma: 'no-cache',
      Expires: '0',
    });

    return res.status(200).json({
      success: true,

      shopperLocation: {
        latitude: shopperLatitude,
        longitude: shopperLongitude,
      },

      count: orders.length,
      orders,
      batches,
    });
  } catch (error) {
    console.error('❌ getAvailableOrders error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to get available orders',
      error: error.message,
    });
  }
};

// =====================================================
// HIDE A BATCH FOR THIS SHOPPER
// POST /api/shopper/orders/:orderId/dismiss
// Called when the countdown runs out or the shopper taps "Hide".
// =====================================================

const dismissOrderOffer = async (req, res) => {
  try {
    const shopperId = getShopperId(req);
    const orderId = Number(req.params.orderId);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID',
      });
    }

    const orderResult = await db.query(
      'SELECT id FROM orders WHERE id = $1',
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    await db.query(
      `
      INSERT INTO shopper_order_offers (shopper_id, order_id, dismissed_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (shopper_id, order_id)
      DO UPDATE SET dismissed_at = COALESCE(shopper_order_offers.dismissed_at, NOW())
      `,
      [shopperId, orderId]
    );

    // Hand the batch to the next closest shopper right away
    await dispatchOrder({ io: req.app.get('io'), orderId });

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ dismissOrderOffer error:', error.message);

    return res.status(500).json({
      success: false,
      message: 'Unable to hide this batch',
    });
  }
};

module.exports = {
  getAvailableOrders,
  dismissOrderOffer,
};
