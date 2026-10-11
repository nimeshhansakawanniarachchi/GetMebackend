
const db = require('../config/db');

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
        status
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
    // GET AVAILABLE ORDERS + SHOPS
    // ===================================================

    const ordersResult = await db.query(
      `
      SELECT
        o.id,
        o.customer_id,

        c.full_name AS customer_name,
        c.mobile AS customer_phone,

        os.shop_id,

        o.delivery_address,
        o.delivery_latitude,
        o.delivery_longitude,

        o.delivery_option,
        o.payment_method,

        o.items_total,
        o.delivery_fee,
        o.service_fee,
        o.total_amount,

        o.distance_km AS customer_distance_km,

        o.status,
        o.created_at,
        o.updated_at,
        o.shopper_id,

        s.shop_name,
        s.image_url AS shop_image,
        s.status AS shop_status,

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

      WHERE
        o.status = 'waiting_for_shopper'
        AND o.shopper_id IS NULL
        AND s.status = 'approved'
        AND s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL

      ORDER BY
        o.created_at ASC,
        shop_distance_km ASC
      `,
      [shopperLatitude, shopperLongitude]
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

      const itemsResult = await db.query(
        `
        SELECT
          id,
          order_id,
          product_id,
          item_name,
          quantity,
          amount,
          unit,
          price,
          custom,
          details,
          image,
          voice_url,
          shopper_photo_url,
          shopping_status,
          found_quantity,
          found_weight,
          found_weight_unit,
          barcode_scanned,
          completed_at,
          shop_id

        FROM order_items

        WHERE
          order_id = $1
          AND shop_id = $2

        ORDER BY id ASC
        `,
        [order.id, order.shop_id]
      );

      const orderItems = itemsResult.rows.map((item) => ({
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
        deliveryFee: Number(order.delivery_fee || 0),
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

      const allShopsWithin10Km =
        shopDistances.length === group.shops.length &&
        shopDistances.every(
          (distance) =>
            Number.isFinite(distance) &&
            distance <= 10
        );

      if (!allShopsWithin10Km) {
        console.log(
          '⚠️ ORDER SKIPPED - SHOP OUTSIDE 10 KM:',
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
        deliveryFee: Number(order.delivery_fee || 0),
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

        // TOTALS
        batchFee: Number(order.total_amount || 0),
        totalFee: Number(order.total_amount || 0),
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
      };

      orders.push(finalOrder);
    }

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

      batchDistanceKm: order.batchDistanceKm,
      batchDistance: order.batchDistance,

      totalItems: order.totalItems,
      totalCustomerDistanceKm: order.totalCustomerDistanceKm,

      batchOrders: order.batchOrders,

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

module.exports = {
  getAvailableOrders,
};
