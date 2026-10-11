

const pool = require('../config/db');

// ==================================================
// SOCKET.IO ORDER EVENT HELPER
// ==================================================

const emitOrderSocketEvent = ({
  req,
  event,
  orderId,
  customerId,
  payload,
}) => {
  try {
    const io = req.app.get('io');

    if (!io) {
      console.log(
        '⚠️ SOCKET.IO INSTANCE NOT AVAILABLE'
      );
      return;
    }

    const numericOrderId = Number(orderId);
    const numericCustomerId = Number(customerId);

    if (!Number.isInteger(numericOrderId)) {
      console.log(
        '⚠️ SOCKET EVENT: Invalid order ID:',
        orderId
      );
      return;
    }

    console.log(
      '===================================='
    );

    console.log(
      '📡 SOCKET EVENT EMIT'
    );

    console.log(
      'EVENT:',
      event
    );

    console.log(
      'ORDER ID:',
      numericOrderId
    );

    console.log(
      'CUSTOMER ID:',
      numericCustomerId
    );

    console.log(
      '===================================='
    );

    const socketPayload = {
      orderId: numericOrderId,

      order_id: numericOrderId,

      customerId:
        Number.isInteger(numericCustomerId)
          ? numericCustomerId
          : null,

      customer_id:
        Number.isInteger(numericCustomerId)
          ? numericCustomerId
          : null,

      ...(payload &&
      typeof payload === 'object'
        ? payload
        : {}),
    };

    if (Number.isInteger(numericCustomerId)) {
      io.to(
        `customer:${numericCustomerId}`
      ).emit(
        event,
        socketPayload
      );
    }

    io.to(
      `order:${numericOrderId}`
    ).emit(
      event,
      socketPayload
    );

  } catch (error) {
    console.error(
      '❌ SOCKET EVENT EMIT ERROR:',
      error
    );
  }
};


// ==================================================
// UPLOAD CUSTOM ITEM MEDIA
// ==================================================

const uploadCustomItemMedia = async (
  req,
  res
) => {
  try {
    if (
      !req.files ||
      req.files.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded',
      });
    }

    const baseUrl =
      `${req.protocol}://${req.get('host')}`;

    const files =
      req.files.map(
        (file) => {
          const url =
            `${baseUrl}/uploads/items/${file.filename}`;

          return {
            fieldName: file.fieldname,
            originalName: file.originalname,
            fileName: file.filename,
            mimeType: file.mimetype,
            size: file.size,
            url,
          };
        }
      );

    const imageExtensions = [
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
    ];

    const audioExtensions = [
      '.mp3',
      '.m4a',
      '.wav',
      '.aac',
      '.ogg',
      '.webm',
    ];

    const imageMimeTypes = [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
    ];

    const audioMimeTypes = [
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/wav',
      'audio/x-wav',
      'audio/aac',
      'audio/ogg',
      'audio/webm',
    ];

    const path = require('path');

    const imageFile =
      files.find(
        (file) => {
          const mime =
            (
              file.mimeType ||
              ''
            ).toLowerCase();

          const ext =
            path
              .extname(
                file.originalName ||
                file.fileName ||
                ''
              )
              .toLowerCase();

          return (
            imageMimeTypes.includes(mime) ||
            imageExtensions.includes(ext)
          );
        }
      );

    const audioFile =
      files.find(
        (file) => {
          const mime =
            (
              file.mimeType ||
              ''
            ).toLowerCase();

          const ext =
            path
              .extname(
                file.originalName ||
                file.fileName ||
                ''
              )
              .toLowerCase();

          return (
            audioMimeTypes.includes(mime) ||
            audioExtensions.includes(ext)
          );
        }
      );

    return res.status(200).json({
      success: true,

      message:
        'Files uploaded successfully',

      imageUrl:
        imageFile?.url || null,

      voiceUrl:
        audioFile?.url || null,

      files,
    });

  } catch (error) {
    console.error(
      '❌ CUSTOM ITEM MEDIA UPLOAD ERROR:',
      error
    );

    return res.status(500).json({
      success: false,

      message:
        'Failed to upload custom item media',

      error:
        error.message,
    });
  }
};


// ==================================================
// CREATE ORDER
// ==================================================

const createOrder = async (
  req,
  res
) => {
  const client =
    await pool.connect();

  try {
    const customerId =
      req.customer.customerId;

    const {
      shopId,
      shops = [],
      deliveryAddress,
      deliveryLatitude,
      deliveryLongitude,
      deliveryOption = 'fast',
      paymentMethod = 'cash',
      items = [],
      deliveryFee = 0,
      fastDeliveryFee = 0,
      serviceFee = 0,
      itemsTotal = 0,
      totalAmount = 0,
      scheduledDate = null,
      scheduledStartTime = null,
      scheduledEndTime = null,
      estimatedDeliveryMinutes = null,
      estimatedDeliveryMaxMinutes = null,
    } = req.body;

    if (!deliveryAddress) {
      return res.status(400).json({
        success: false,
        message:
          'Delivery address is required',
      });
    }

    if (
      deliveryLatitude === undefined ||
      deliveryLongitude === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Delivery latitude and longitude are required',
      });
    }

    const latitude =
      Number(deliveryLatitude);

    const longitude =
      Number(deliveryLongitude);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Valid latitude and longitude are required',
      });
    }

    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Latitude or longitude is out of range',
      });
    }

    if (
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          'At least one order item is required',
      });
    }

    // ==================================================
    // BUILD UNIQUE SHOP LIST
    // ==================================================

    const shopsMap = new Map();

    const parsedPrimaryShopId =
      Number(shopId);

    if (
      Number.isInteger(parsedPrimaryShopId)
    ) {
      shopsMap.set(
        parsedPrimaryShopId,
        {
          id: parsedPrimaryShopId,
          name: null,
          image: null,
        }
      );
    }

    if (Array.isArray(shops)) {
      shops.forEach(
        (shopItem) => {
          const id =
            Number(
              shopItem?.id ??
              shopItem?.shopId ??
              shopItem?.shop_id
            );

          if (!Number.isInteger(id)) {
            return;
          }

          shopsMap.set(
            id,
            {
              id,

              name:
                shopItem?.name ??
                shopItem?.shopName ??
                shopItem?.shop_name ??
                null,

              image:
                shopItem?.image ??
                shopItem?.shopImage ??
                shopItem?.shop_image ??
                shopItem?.image_url ??
                null,
            }
          );
        }
      );
    }

    items.forEach(
      (item) => {
        const id =
          Number(
            item?.shopId ??
            item?.shop_id
          );

        if (!Number.isInteger(id)) {
          return;
        }

        shopsMap.set(
          id,
          {
            id,

            name:
              item?.shopName ??
              item?.shop_name ??
              null,

            image:
              item?.shopImage ??
              item?.shop_image ??
              item?.image_url ??
              null,
          }
        );
      }
    );

    const uniqueShopIds =
      Array.from(
        shopsMap.keys()
      );

    if (uniqueShopIds.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          'At least one valid shop is required',
      });
    }

    const primaryShopId =
      Number(
        parsedPrimaryShopId ||
        uniqueShopIds[0]
      );

    if (
      !Number.isInteger(
        primaryShopId
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Valid primary shop ID is required',
      });
    }

    if (
      !uniqueShopIds.includes(
        primaryShopId
      )
    ) {
      uniqueShopIds.unshift(
        primaryShopId
      );
    }

    // ==================================================
    // GET ALL SHOPS
    // ==================================================

    const shopsResult =
      await client.query(
        `
        SELECT
          id,
          shop_name,
          image_url,
          status,
          latitude,
          longitude
        FROM shops
        WHERE id = ANY($1::int[])
        `,
        [
          uniqueShopIds,
        ]
      );

    if (
      shopsResult.rows.length !==
      uniqueShopIds.length
    ) {
      const foundShopIds =
        shopsResult.rows.map(
          shop =>
            Number(shop.id)
        );

      const missingShopIds =
        uniqueShopIds.filter(
          id =>
            !foundShopIds.includes(id)
        );

      return res.status(404).json({
        success: false,
        message:
          'One or more shops were not found',
        missingShopIds,
      });
    }

    // ==================================================
    // CHECK SHOP STATUS
    // ==================================================

    const unavailableShops =
      shopsResult.rows.filter(
        shop =>
          shop.status !== 'approved'
      );

    if (
      unavailableShops.length > 0
    ) {
      return res.status(400).json({
        success: false,

        message:
          'One or more selected shops are not available',

        shops:
          unavailableShops.map(
            shop => ({
              id:
                Number(shop.id),

              name:
                shop.shop_name,

              status:
                shop.status,
            })
          ),
      });
    }

    const primaryShop =
      shopsResult.rows.find(
        row =>
          Number(row.id) ===
          primaryShopId
      );

    if (!primaryShop) {
      return res.status(404).json({
        success: false,
        message:
          'Primary shop not found',
      });
    }

    // ==================================================
    // SAFE TOTALS
    // ==================================================

    const safeItemsTotal =
      Number(itemsTotal) || 0;

    const safeDeliveryFee =
      Number(deliveryFee) || 0;

    const safeFastDeliveryFee =
      Number(fastDeliveryFee) || 0;

    const safeServiceFee =
      Number(serviceFee) || 0;

    const parsedTotalAmount =
      Number(totalAmount);

    const safeTotalAmount =
      Number.isFinite(
        parsedTotalAmount
      ) &&
      parsedTotalAmount > 0
        ? parsedTotalAmount
        : (
            safeItemsTotal +
            safeDeliveryFee +
            safeServiceFee
          );

    // ==================================================
    // SAFE ESTIMATED DELIVERY VALUES
    // ==================================================

    const safeEstimatedDeliveryMinutes =
      estimatedDeliveryMinutes !== null &&
      estimatedDeliveryMinutes !== undefined &&
      estimatedDeliveryMinutes !== ''
        ? Number(
            estimatedDeliveryMinutes
          )
        : null;

    const safeEstimatedDeliveryMaxMinutes =
      estimatedDeliveryMaxMinutes !== null &&
      estimatedDeliveryMaxMinutes !== undefined &&
      estimatedDeliveryMaxMinutes !== ''
        ? Number(
            estimatedDeliveryMaxMinutes
          )
        : null;

    const safeScheduledDate =
      scheduledDate === '' ||
      scheduledDate === undefined
        ? null
        : scheduledDate;

    const safeScheduledStartTime =
      scheduledStartTime === '' ||
      scheduledStartTime === undefined
        ? null
        : scheduledStartTime;

    const safeScheduledEndTime =
      scheduledEndTime === '' ||
      scheduledEndTime === undefined
        ? null
        : scheduledEndTime;

    // ==================================================
    // CALCULATE DISTANCE
    // ==================================================

    const shopLatitude =
      Number(primaryShop.latitude);

    const shopLongitude =
      Number(primaryShop.longitude);

    let safeDistanceKm = null;

    if (
      Number.isFinite(shopLatitude) &&
      Number.isFinite(shopLongitude)
    ) {
      const earthRadiusKm = 6371;

      const dLat =
        (
          (
            latitude -
            shopLatitude
          ) *
          Math.PI
        ) / 180;

      const dLon =
        (
          (
            longitude -
            shopLongitude
          ) *
          Math.PI
        ) / 180;

      const customerLatRad =
        (
          latitude *
          Math.PI
        ) / 180;

      const shopLatRad =
        (
          shopLatitude *
          Math.PI
        ) / 180;

      const a =
        Math.sin(dLat / 2) *
          Math.sin(dLat / 2) +

        Math.cos(shopLatRad) *
          Math.cos(customerLatRad) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);

      const c =
        2 *
        Math.atan2(
          Math.sqrt(a),
          Math.sqrt(1 - a)
        );

      safeDistanceKm =
        Number(
          (
            earthRadiusKm * c
          ).toFixed(2)
        );
    }

    // ==================================================
    // BEGIN TRANSACTION
    // ==================================================

    await client.query('BEGIN');

    // ==================================================
    // INSERT ORDER
    // ==================================================

    const orderResult =
      await client.query(
        `
        INSERT INTO orders (
          customer_id,
          shop_id,
          delivery_address,
          delivery_latitude,
          delivery_longitude,
          delivery_option,
          payment_method,
          items_total,
          delivery_fee,
          fast_delivery_fee,
          service_fee,
          distance_km,
          total_amount,
          scheduled_date,
          scheduled_start_time,
          scheduled_end_time,
          estimated_delivery_minutes,
          estimated_delivery_max_minutes,
          status
        )
        VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,
          $17,$18,$19
        )
        RETURNING *
        `,
        [
          customerId,
          primaryShopId,
          deliveryAddress,
          latitude,
          longitude,
          deliveryOption,
          paymentMethod,
          safeItemsTotal,
          safeDeliveryFee,
          safeFastDeliveryFee,
          safeServiceFee,
          safeDistanceKm,
          safeTotalAmount,
          safeScheduledDate,
          safeScheduledStartTime,
          safeScheduledEndTime,
          safeEstimatedDeliveryMinutes,
          safeEstimatedDeliveryMaxMinutes,
          'waiting_for_shopper',
        ]
      );

    const order =
      orderResult.rows[0];

    // ==================================================
    // INSERT ORDER SHOPS
    // ==================================================

    const orderedShopRows =
      uniqueShopIds
        .map(
          id =>
            shopsResult.rows.find(
              row =>
                Number(row.id) === id
            )
        )
        .filter(Boolean);

    for (
      const selectedShop of orderedShopRows
    ) {
      const shopMeta =
        shopsMap.get(
          Number(selectedShop.id)
        ) || {};

      await client.query(
        `
        INSERT INTO order_shops (
          order_id,
          shop_id,
          shop_name,
          shop_image
        )
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (
          order_id,
          shop_id
        )
        DO UPDATE SET
          shop_name =
            EXCLUDED.shop_name,
          shop_image =
            EXCLUDED.shop_image
        `,
        [
          order.id,
          Number(selectedShop.id),

          selectedShop.shop_name ||
            shopMeta.name ||
            null,

          selectedShop.image_url ||
            shopMeta.image ||
            null,
        ]
      );
    }

    // ==================================================
    // INSERT ORDER ITEMS
    // ==================================================

    for (
      const item of items
    ) {
      const productId =
        item.productId ??
        item.product_id ??
        null;

      const itemName =
        item.itemName ||
        item.item_name ||
        item.name ||
        item.productName ||
        'Item';

      const quantity =
        Number(item.quantity) || 1;

      const amount =
        Number(item.amount) || 1;

      const unit =
        item.unit ||
        item.selectedUnit ||
        null;

      const price =
        Number(item.price) || 0;

      const custom =
        item.custom === true;

      const details =
        item.details || null;

      const image =
        item.image ||
        item.imageUrl ||
        item.image_url ||
        item.photo ||
        item.photoUrl ||
        item.photo_url ||
        null;

      const voiceUrl =
        item.voice_url ||
        item.voiceUrl ||
        item.voice ||
        null;

      const itemShopId =
        Number(
          item.shopId ??
          item.shop_id ??
          primaryShopId
        );

      if (
        !Number.isInteger(itemShopId)
      ) {
        throw new Error(
          `Invalid shop ID for order item: ${itemName}`
        );
      }

      if (
        !uniqueShopIds.includes(
          itemShopId
        )
      ) {
        throw new Error(
          `Shop ${itemShopId} for item "${itemName}" is not part of this order`
        );
      }

      await client.query(
        `
        INSERT INTO order_items (
          order_id,
          shop_id,
          product_id,
          item_name,
          quantity,
          amount,
          unit,
          price,
          custom,
          details,
          image,
          voice_url
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,$11,$12
        )
        `,
        [
          order.id,
          itemShopId,
          productId,
          itemName,
          quantity,
          amount,
          unit,
          price,
          custom,
          details,
          image,
          voiceUrl,
        ]
      );
    }

    await client.query('COMMIT');

    // ==================================================
    // GET CREATED ITEMS
    // ==================================================

    const createdItemsResult =
      await pool.query(
        `
        SELECT
          oi.id,
          oi.order_id,
          oi.shop_id,
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
          oi.created_at,

          s.shop_name,
          s.image_url AS shop_image

        FROM order_items oi

        LEFT JOIN shops s
          ON s.id = oi.shop_id

        WHERE
          oi.order_id = $1

        ORDER BY
          oi.id ASC
        `,
        [order.id]
      );

    const createdItems =
      createdItemsResult.rows.map(
        item => ({
          ...item,

          id:
            Number(item.id),

          order_id:
            Number(item.order_id),

          orderId:
            Number(item.order_id),

          shop_id:
            item.shop_id !== null
              ? Number(item.shop_id)
              : null,

          shopId:
            item.shop_id !== null
              ? Number(item.shop_id)
              : null,

          product_id:
            item.product_id !== null
              ? Number(item.product_id)
              : null,

          productId:
            item.product_id !== null
              ? Number(item.product_id)
              : null,

          quantity:
            Number(item.quantity),

          amount:
            Number(item.amount),

          price:
            Number(item.price),

          voice_url:
            item.voice_url || null,

          voiceUrl:
            item.voice_url || null,

          shoppingStatus:
            item.shopping_status ||
            'pending',

          foundQuantity:
            item.found_quantity !== null
              ? Number(item.found_quantity)
              : null,

          foundWeight:
            item.found_weight !== null
              ? Number(item.found_weight)
              : null,

          foundWeightUnit:
            item.found_weight_unit || null,

          barcodeScanned:
            item.barcode_scanned === true,

          shopperPhotoUrl:
            item.shopper_photo_url || null,

          completedAt:
            item.completed_at || null,

          shop:
            item.shop_id !== null
              ? {
                  id:
                    Number(item.shop_id),

                  name:
                    item.shop_name || null,

                  image:
                    item.shop_image || null,
                }
              : null,
        })
      );

    // ==================================================
    // GET CREATED ORDER SHOPS
    // ==================================================

    const createdOrderShopsResult =
      await pool.query(
        `
        SELECT
          os.id,
          os.order_id,
          os.shop_id,
          os.shop_name,
          os.shop_image,
          os.created_at
        FROM order_shops os
        WHERE
          os.order_id = $1
        ORDER BY
          os.id ASC
        `,
        [order.id]
      );

    const createdOrderShops =
      createdOrderShopsResult.rows.map(
        item => ({
          ...item,

          id:
            Number(item.id),

          order_id:
            Number(item.order_id),

          orderId:
            Number(item.order_id),

          shop_id:
            Number(item.shop_id),

          shopId:
            Number(item.shop_id),

          name:
            item.shop_name || null,

          shop_name:
            item.shop_name || null,

          image:
            item.shop_image || null,

          shop_image:
            item.shop_image || null,
        })
      );

    // ==================================================
    // SHOP OBJECTS
    // ==================================================

    const shopObjects =
      orderedShopRows.map(
        selectedShop => ({
          id:
            Number(selectedShop.id),

          shopId:
            Number(selectedShop.id),

          name:
            selectedShop.shop_name || null,

          shop_name:
            selectedShop.shop_name || null,

          image:
            selectedShop.image_url || null,

          image_url:
            selectedShop.image_url || null,

          latitude:
            selectedShop.latitude !== null
              ? Number(selectedShop.latitude)
              : null,

          longitude:
            selectedShop.longitude !== null
              ? Number(selectedShop.longitude)
              : null,
        })
      );

    // ==================================================
    // SOCKET.IO - ORDER CREATED
    // ==================================================

    const socketOrder = {
      ...order,

      id:
        Number(order.id),

      orderId:
        Number(order.id),

      customer_id:
        Number(customerId),

      customerId:
        Number(customerId),

      total:
        Number(order.total_amount),

      totalAmount:
        Number(order.total_amount),

      itemsTotal:
        Number(order.items_total),

      deliveryFee:
        Number(order.delivery_fee),

      fastDeliveryFee:
        Number(order.fast_delivery_fee),

      serviceFee:
        Number(order.service_fee),

      distance_km:
        order.distance_km !== null
          ? Number(order.distance_km)
          : null,

      distanceKm:
        order.distance_km !== null
          ? Number(order.distance_km)
          : null,

      shop: {
        id:
          Number(primaryShop.id),

        name:
          primaryShop.shop_name,

        image:
          primaryShop.image_url,

        latitude:
          Number(primaryShop.latitude),

        longitude:
          Number(primaryShop.longitude),
      },

      shops:
        shopObjects,

      orderShops:
        createdOrderShops,

      order_shops:
        createdOrderShops,

      items:
        createdItems,
    };

    emitOrderSocketEvent({
      req,

      event:
        'order-update',

      orderId:
        order.id,

      customerId,

      payload: {
        order:
          socketOrder,
      },
    });

    // ==================================================
    // RESPONSE
    // ==================================================

    return res.status(201).json({
      success: true,

      message:
        'Order created successfully',

      order: {
        ...order,

        id:
          Number(order.id),

        orderId:
          Number(order.id),

        customer_id:
          Number(order.customer_id),

        customerId:
          Number(order.customer_id),

        total:
          Number(order.total_amount),

        totalAmount:
          Number(order.total_amount),

        itemsTotal:
          Number(order.items_total),

        deliveryFee:
          Number(order.delivery_fee),

        fastDeliveryFee:
          Number(order.fast_delivery_fee),

        serviceFee:
          Number(order.service_fee),

        distance_km:
          order.distance_km !== null
            ? Number(order.distance_km)
            : null,

        distanceKm:
          order.distance_km !== null
            ? Number(order.distance_km)
            : null,

        shop: {
          id:
            Number(primaryShop.id),

          name:
            primaryShop.shop_name,

          image:
            primaryShop.image_url,

          latitude:
            Number(primaryShop.latitude),

          longitude:
            Number(primaryShop.longitude),
        },

        shops:
          shopObjects,

        orderShops:
          createdOrderShops,

        order_shops:
          createdOrderShops,

        items:
          createdItems,
      },
    });

  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error(
        '❌ Rollback error:',
        rollbackError.message
      );
    }

    console.error(
      '❌ CREATE ORDER ERROR:',
      error
    );

    return res.status(500).json({
      success: false,

      message:
        'Failed to create order',

      error:
        error.message,
    });

  } finally {
    client.release();
  }
};


// ==================================================
// GET CUSTOMER ORDERS
// ==================================================

const getCustomerOrders = async (
  req,
  res
) => {
  try {
    const customerId =
      req.customer.customerId;

    const ordersResult =
      await pool.query(
        `
        SELECT
          o.*,

          s.shop_name,
          s.image_url AS shop_image,
          s.latitude AS shop_latitude,
          s.longitude AS shop_longitude,

          sh.id AS shopper_id_joined,
          sh.full_name AS shopper_name,
          sh.mobile AS shopper_mobile,
          sh.status AS shopper_status,
          sh.latitude AS shopper_latitude,
          sh.longitude AS shopper_longitude

        FROM orders o

        LEFT JOIN shops s
          ON s.id = o.shop_id

        LEFT JOIN shoppers sh
          ON sh.id = o.shopper_id

        WHERE
          o.customer_id = $1

        ORDER BY
          o.created_at DESC
        `,
        [customerId]
      );

    const formattedOrders =
      await Promise.all(
        ordersResult.rows.map(
          async order => {

            // ==================================================
            // ORDER SHOPS
            // ==================================================

            const orderShopsResult =
              await pool.query(
                `
                SELECT
                  os.id,
                  os.order_id,
                  os.shop_id,
                  os.shop_name,
                  os.shop_image,
                  os.created_at,

                  s.latitude,
                  s.longitude

                FROM order_shops os

                LEFT JOIN shops s
                  ON s.id = os.shop_id

                WHERE
                  os.order_id = $1

                ORDER BY
                  os.id ASC
                `,
                [order.id]
              );

            let orderShops =
              orderShopsResult.rows.map(
                shop => ({
                  ...shop,

                  id:
                    Number(shop.id),

                  order_id:
                    Number(shop.order_id),

                  orderId:
                    Number(shop.order_id),

                  shop_id:
                    Number(shop.shop_id),

                  shopId:
                    Number(shop.shop_id),

                  name:
                    shop.shop_name || null,

                  shop_name:
                    shop.shop_name || null,

                  image:
                    shop.shop_image || null,

                  shop_image:
                    shop.shop_image || null,

                  latitude:
                    shop.latitude !== null
                      ? Number(shop.latitude)
                      : null,

                  longitude:
                    shop.longitude !== null
                      ? Number(shop.longitude)
                      : null,
                })
              );

            // ==================================================
            // SHOP BILLS / SHOP-LEVEL STATUS
            // ==================================================

            const shopBillsResult =
              await pool.query(
                `
                SELECT
                  osb.id,
                  osb.order_id,
                  osb.shop_id,
                  osb.bill_url,
                  osb.bill_uploaded_at,
                  osb.shopping_status,
                  osb.created_at,
                  osb.updated_at

                FROM order_shop_bills osb

                WHERE
                  osb.order_id = $1

                ORDER BY
                  osb.id ASC
                `,
                [order.id]
              );

            const shopBills =
              shopBillsResult.rows.map(
                bill => ({
                  ...bill,

                  id:
                    Number(bill.id),

                  order_id:
                    Number(bill.order_id),

                  orderId:
                    Number(bill.order_id),

                  shop_id:
                    bill.shop_id !== null
                      ? Number(bill.shop_id)
                      : null,

                  shopId:
                    bill.shop_id !== null
                      ? Number(bill.shop_id)
                      : null,

                  shopping_status:
                    bill.shopping_status ||
                    'pending',

                  shoppingStatus:
                    bill.shopping_status ||
                    'pending',

                  bill_url:
                    bill.bill_url || null,

                  billUrl:
                    bill.bill_url || null,

                  bill_uploaded_at:
                    bill.bill_uploaded_at || null,

                  billUploadedAt:
                    bill.bill_uploaded_at || null,
                })
              );

            // ==================================================
            // ADD SHOP STATUS TO EACH SHOP
            // ==================================================

            orderShops =
              orderShops.map(
                shop => {
                  const bill =
                    shopBills.find(
                      item =>
                        Number(
                          item.shop_id
                        ) ===
                        Number(
                          shop.shop_id
                        )
                    );

                  const status =
                    bill?.shopping_status ||
                    'pending';

                  return {
                    ...shop,

                    shopping_status:
                      status,

                    shoppingStatus:
                      status,

                    shopStatus:
                      status,

                    shop_status:
                      status,

                    bill_id:
                      bill?.id || null,

                    billId:
                      bill?.id || null,

                    bill_url:
                      bill?.bill_url ||
                      null,

                    billUrl:
                      bill?.bill_url ||
                      null,

                    bill_uploaded_at:
                      bill?.bill_uploaded_at ||
                      null,

                    billUploadedAt:
                      bill?.bill_uploaded_at ||
                      null,

                    order_shop_bill:
                      bill || null,

                    orderShopBill:
                      bill || null,

                    bill:
                      bill || null,
                  };
                }
              );

            // ==================================================
            // FALLBACK FOR OLD ORDERS
            // ==================================================

            if (
              orderShops.length === 0 &&
              order.shop_id
            ) {
              const bill =
                shopBills.find(
                  item =>
                    Number(
                      item.shop_id
                    ) ===
                    Number(
                      order.shop_id
                    )
                );

              const status =
                bill?.shopping_status ||
                'pending';

              orderShops = [
                {
                  id: null,

                  order_id:
                    Number(order.id),

                  orderId:
                    Number(order.id),

                  shop_id:
                    Number(order.shop_id),

                  shopId:
                    Number(order.shop_id),

                  name:
                    order.shop_name || null,

                  shop_name:
                    order.shop_name || null,

                  image:
                    order.shop_image || null,

                  shop_image:
                    order.shop_image || null,

                  latitude:
                    order.shop_latitude !== null
                      ? Number(
                          order.shop_latitude
                        )
                      : null,

                  longitude:
                    order.shop_longitude !== null
                      ? Number(
                          order.shop_longitude
                        )
                      : null,

                  shopping_status:
                    status,

                  shoppingStatus:
                    status,

                  shopStatus:
                    status,

                  shop_status:
                    status,

                  bill_id:
                    bill?.id || null,

                  billId:
                    bill?.id || null,

                  bill_url:
                    bill?.bill_url || null,

                  billUrl:
                    bill?.bill_url || null,

                  bill_uploaded_at:
                    bill?.bill_uploaded_at ||
                    null,

                  billUploadedAt:
                    bill?.bill_uploaded_at ||
                    null,

                  order_shop_bill:
                    bill || null,

                  orderShopBill:
                    bill || null,

                  bill:
                    bill || null,
                },
              ];
            }

            // ==================================================
            // ITEMS
            // ==================================================

            const itemsResult =
              await pool.query(
                `
                SELECT
                  oi.id,
                  oi.order_id,
                  oi.shop_id,

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
                  oi.created_at,

                  s.shop_name,
                  s.image_url AS shop_image,

                  COALESCE(
                    (
                      SELECT json_agg(
                        json_build_object(
                          'id', ri.id,
                          'order_id', ri.order_id,
                          'original_item_id', ri.original_item_id,
                          'shopper_id', ri.shopper_id,
                          'option_number', ri.option_number,
                          'photo_url', ri.photo_url,
                          'photoUrl', ri.photo_url,
                          'replacement_photo_url', ri.photo_url,
                          'replacementPhotoUrl', ri.photo_url,
                          'status', ri.status,
                          'created_at', ri.created_at,
                          'updated_at', ri.updated_at
                        )
                        ORDER BY
                          ri.option_number ASC
                      )
                      FROM replacement_items ri
                      WHERE
                        ri.order_id = oi.order_id
                        AND ri.original_item_id = oi.id
                    ),
                    '[]'::json
                  ) AS replacement_items

                FROM order_items oi

                LEFT JOIN shops s
                  ON s.id = oi.shop_id

                WHERE
                  oi.order_id = $1

                ORDER BY
                  oi.id ASC
                `,
                [order.id]
              );

            const items =
              itemsResult.rows.map(
                item => ({
                  ...item,

                  id:
                    Number(item.id),

                  order_id:
                    Number(item.order_id),

                  orderId:
                    Number(item.order_id),

                  shop_id:
                    item.shop_id !== null
                      ? Number(item.shop_id)
                      : null,

                  shopId:
                    item.shop_id !== null
                      ? Number(item.shop_id)
                      : null,

                  product_id:
                    item.product_id !== null
                      ? Number(item.product_id)
                      : null,

                  productId:
                    item.product_id !== null
                      ? Number(item.product_id)
                      : null,

                  quantity:
                    Number(item.quantity),

                  amount:
                    Number(item.amount),

                  price:
                    Number(item.price),

                  image:
                    item.image || null,

                  voice_url:
                    item.voice_url || null,

                  voiceUrl:
                    item.voice_url || null,

                  shop:
                    item.shop_id !== null
                      ? {
                          id:
                            Number(item.shop_id),

                          name:
                            item.shop_name || null,

                          image:
                            item.shop_image || null,
                        }
                      : null,

                  replacement_items:
                    Array.isArray(
                      item.replacement_items
                    )
                      ? item.replacement_items
                      : [],

                  replacementItems:
                    Array.isArray(
                      item.replacement_items
                    )
                      ? item.replacement_items
                      : [],

                  replacements:
                    Array.isArray(
                      item.replacement_items
                    )
                      ? item.replacement_items
                      : [],

                  shopping_status:
                    item.shopping_status ||
                    'pending',

                  shoppingStatus:
                    item.shopping_status ||
                    'pending',

                  found_quantity:
                    item.found_quantity !== null
                      ? Number(
                          item.found_quantity
                        )
                      : null,

                  foundQuantity:
                    item.found_quantity !== null
                      ? Number(
                          item.found_quantity
                        )
                      : null,

                  found_weight:
                    item.found_weight !== null
                      ? Number(
                          item.found_weight
                        )
                      : null,

                  foundWeight:
                    item.found_weight !== null
                      ? Number(
                          item.found_weight
                        )
                      : null,

                  found_weight_unit:
                    item.found_weight_unit ||
                    null,

                  foundWeightUnit:
                    item.found_weight_unit ||
                    null,

                  barcode_scanned:
                    item.barcode_scanned === true,

                  barcodeScanned:
                    item.barcode_scanned === true,

                  shopper_photo_url:
                    item.shopper_photo_url ||
                    null,

                  shopperPhotoUrl:
                    item.shopper_photo_url ||
                    null,

                  completed_at:
                    item.completed_at ||
                    null,

                  completedAt:
                    item.completed_at ||
                    null,
                })
              );

            // ==================================================
            // TOTALS
            // ==================================================

            const totalAmount =
              Number(order.total_amount) || 0;

            const itemsTotal =
              Number(order.items_total) || 0;

            const deliveryFee =
              Number(order.delivery_fee) || 0;

            const fastDeliveryFee =
              Number(order.fast_delivery_fee) || 0;

            const serviceFee =
              Number(order.service_fee) || 0;

            const distanceKm =
              order.distance_km !== null
                ? Number(order.distance_km)
                : null;

            // ==================================================
            // SHOPPER
            // ==================================================

            const shopper =
              order.shopper_id
                ? {
                    id:
                      Number(order.shopper_id),

                    name:
                      order.shopper_name ||
                      'Shopper',

                    full_name:
                      order.shopper_name ||
                      'Shopper',

                    mobile:
                      order.shopper_mobile ||
                      null,

                    status:
                      order.shopper_status ||
                      null,

                    latitude:
                      order.shopper_latitude !== null
                        ? Number(
                            order.shopper_latitude
                          )
                        : null,

                    longitude:
                      order.shopper_longitude !== null
                        ? Number(
                            order.shopper_longitude
                          )
                        : null,
                  }
                : null;

            // ==================================================
            // RETURN ORDER
            // ==================================================

            return {
              ...order,

              id:
                Number(order.id),

              orderId:
                Number(order.id),

              customer_id:
                Number(order.customer_id),

              customerId:
                Number(order.customer_id),

              shop_id:
                order.shop_id !== null
                  ? Number(order.shop_id)
                  : null,

              shopper_id:
                order.shopper_id
                  ? Number(order.shopper_id)
                  : null,

              delivery_latitude:
                Number(order.delivery_latitude),

              delivery_longitude:
                Number(order.delivery_longitude),

              items_total:
                itemsTotal,

              delivery_fee:
                deliveryFee,

              fast_delivery_fee:
                fastDeliveryFee,

              service_fee:
                serviceFee,

              distance_km:
                distanceKm,

              distanceKm:
                distanceKm,

              total_amount:
                totalAmount,

              total:
                totalAmount,

              totalAmount:
                totalAmount,

              itemsTotal:
                itemsTotal,

              deliveryFee:
                deliveryFee,

              fastDeliveryFee:
                fastDeliveryFee,

              serviceFee:
                serviceFee,

              scheduled_date:
                order.scheduled_date || null,

              scheduledDate:
                order.scheduled_date || null,

              scheduled_start_time:
                order.scheduled_start_time || null,

              scheduledStartTime:
                order.scheduled_start_time || null,

              scheduled_end_time:
                order.scheduled_end_time || null,

              scheduledEndTime:
                order.scheduled_end_time || null,

              estimated_delivery_minutes:
                order.estimated_delivery_minutes !== null
                  ? Number(
                      order.estimated_delivery_minutes
                    )
                  : null,

              estimatedDeliveryMinutes:
                order.estimated_delivery_minutes !== null
                  ? Number(
                      order.estimated_delivery_minutes
                    )
                  : null,

              estimated_delivery_max_minutes:
                order.estimated_delivery_max_minutes !== null
                  ? Number(
                      order.estimated_delivery_max_minutes
                    )
                  : null,

              estimatedDeliveryMaxMinutes:
                order.estimated_delivery_max_minutes !== null
                  ? Number(
                      order.estimated_delivery_max_minutes
                    )
                  : null,

              shop: {
                id:
                  order.shop_id !== null
                    ? Number(order.shop_id)
                    : null,

                name:
                  order.shop_name ||
                  'Selected Shop',

                shop_name:
                  order.shop_name ||
                  'Selected Shop',

                image:
                  order.shop_image ||
                  null,

                image_url:
                  order.shop_image ||
                  null,

                latitude:
                  order.shop_latitude !== null
                    ? Number(
                        order.shop_latitude
                      )
                    : null,

                longitude:
                  order.shop_longitude !== null
                    ? Number(
                        order.shop_longitude
                      )
                    : null,
              },

              // ==================================================
              // MULTI SHOP DATA
              // ==================================================

              shops:
                orderShops,

              orderShops:
                orderShops,

              order_shops:
                orderShops,

              shopBills:
                shopBills,

              shop_bills:
                shopBills,

              orderShopBills:
                shopBills,

              order_shop_bills:
                shopBills,

              // ==================================================
              // SHOPPER
              // ==================================================

              shopper:
                shopper,

              assignedShopper:
                shopper,

              assigned_shopper:
                shopper,

              // ==================================================
              // ITEMS
              // ==================================================

              items:
                items,

              shoppingList:
                items,

              orderItems:
                items,
            };
          }
        )
      );

    return res.status(200).json({
      success: true,

      orders:
        formattedOrders,
    });

  } catch (error) {
    console.error(
      '❌ GET CUSTOMER ORDERS ERROR:',
      error
    );

    return res.status(500).json({
      success: false,

      message:
        'Failed to load customer orders',

      error:
        error.message,
    });
  }
};


// ==================================================
// GET CUSTOMER ORDER BY ID
// ==================================================

const getCustomerOrderById =
  async (
    req,
    res
  ) => {
    try {
      const customerId =
        req.customer.customerId;

      const orderId =
        Number(
          req.params.orderId
        );

      if (
        !Number.isInteger(orderId)
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Invalid order ID',
        });
      }

      const orderResult =
        await pool.query(
          `
          SELECT
            o.*,

            s.shop_name,
            s.image_url AS shop_image,

            s.latitude AS shop_latitude,
            s.longitude AS shop_longitude,

            sh.id AS shopper_id_joined,
            sh.full_name AS shopper_name,
            sh.mobile AS shopper_mobile,
            sh.status AS shopper_status,
            sh.latitude AS shopper_latitude,
            sh.longitude AS shopper_longitude

          FROM orders o

          LEFT JOIN shops s
            ON s.id = o.shop_id

          LEFT JOIN shoppers sh
            ON sh.id = o.shopper_id

          WHERE
            o.id = $1
            AND o.customer_id = $2

          LIMIT 1
          `,
          [
            orderId,
            customerId,
          ]
        );

      if (
        orderResult.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,

          message:
            'Order not found',
        });
      }

      const order =
        orderResult.rows[0];

      // ==================================================
      // ORDER SHOPS
      // ==================================================

      const orderShopsResult =
        await pool.query(
          `
          SELECT
            os.id,
            os.order_id,
            os.shop_id,
            os.shop_name,
            os.shop_image,
            os.created_at,

            s.latitude,
            s.longitude

          FROM order_shops os

          LEFT JOIN shops s
            ON s.id = os.shop_id

          WHERE
            os.order_id = $1

          ORDER BY
            os.id ASC
          `,
          [orderId]
        );

      let orderShops =
        orderShopsResult.rows.map(
          shop => ({
            ...shop,

            id:
              Number(shop.id),

            order_id:
              Number(shop.order_id),

            orderId:
              Number(shop.order_id),

            shop_id:
              Number(shop.shop_id),

            shopId:
              Number(shop.shop_id),

            name:
              shop.shop_name || null,

            shop_name:
              shop.shop_name || null,

            image:
              shop.shop_image || null,

            shop_image:
              shop.shop_image || null,

            latitude:
              shop.latitude !== null
                ? Number(shop.latitude)
                : null,

            longitude:
              shop.longitude !== null
                ? Number(shop.longitude)
                : null,
          })
        );

      // ==================================================
      // SHOP BILLS / SHOP-LEVEL STATUS
      // ==================================================

      const shopBillsResult =
        await pool.query(
          `
          SELECT
            osb.id,
            osb.order_id,
            osb.shop_id,
            osb.bill_url,
            osb.bill_uploaded_at,
            osb.shopping_status,
            osb.created_at,
            osb.updated_at

          FROM order_shop_bills osb

          WHERE
            osb.order_id = $1

          ORDER BY
            osb.id ASC
          `,
          [orderId]
        );

      const shopBills =
        shopBillsResult.rows.map(
          bill => ({
            ...bill,

            id:
              Number(bill.id),

            order_id:
              Number(bill.order_id),

            orderId:
              Number(bill.order_id),

            shop_id:
              bill.shop_id !== null
                ? Number(bill.shop_id)
                : null,

            shopId:
              bill.shop_id !== null
                ? Number(bill.shop_id)
                : null,

            shopping_status:
              bill.shopping_status ||
              'pending',

            shoppingStatus:
              bill.shopping_status ||
              'pending',

            bill_url:
              bill.bill_url || null,

            billUrl:
              bill.bill_url || null,

            bill_uploaded_at:
              bill.bill_uploaded_at || null,

            billUploadedAt:
              bill.bill_uploaded_at || null,
          })
        );

      // ==================================================
      // ADD SHOP STATUS TO EACH SHOP
      // ==================================================

      orderShops =
        orderShops.map(
          shop => {
            const bill =
              shopBills.find(
                item =>
                  Number(
                    item.shop_id
                  ) ===
                  Number(
                    shop.shop_id
                  )
              );

            const status =
              bill?.shopping_status ||
              'pending';

            return {
              ...shop,

              shopping_status:
                status,

              shoppingStatus:
                status,

              shopStatus:
                status,

              shop_status:
                status,

              bill_id:
                bill?.id || null,

              billId:
                bill?.id || null,

              bill_url:
                bill?.bill_url || null,

              billUrl:
                bill?.bill_url || null,

              bill_uploaded_at:
                bill?.bill_uploaded_at ||
                null,

              billUploadedAt:
                bill?.bill_uploaded_at ||
                null,

              order_shop_bill:
                bill || null,

              orderShopBill:
                bill || null,

              bill:
                bill || null,
            };
          }
        );

      // ==================================================
      // FALLBACK FOR OLD ORDERS
      // ==================================================

      if (
        orderShops.length === 0 &&
        order.shop_id
      ) {
        const bill =
          shopBills.find(
            item =>
              Number(item.shop_id) ===
              Number(order.shop_id)
          );

        const status =
          bill?.shopping_status ||
          'pending';

        orderShops = [
          {
            id: null,

            order_id:
              Number(order.id),

            orderId:
              Number(order.id),

            shop_id:
              Number(order.shop_id),

            shopId:
              Number(order.shop_id),

            name:
              order.shop_name || null,

            shop_name:
              order.shop_name || null,

            image:
              order.shop_image || null,

            shop_image:
              order.shop_image || null,

            latitude:
              order.shop_latitude !== null
                ? Number(
                    order.shop_latitude
                  )
                : null,

            longitude:
              order.shop_longitude !== null
                ? Number(
                    order.shop_longitude
                  )
                : null,

            shopping_status:
              status,

            shoppingStatus:
              status,

            shopStatus:
              status,

            shop_status:
              status,

            bill_id:
              bill?.id || null,

            billId:
              bill?.id || null,

            bill_url:
              bill?.bill_url || null,

            billUrl:
              bill?.bill_url || null,

            bill_uploaded_at:
              bill?.bill_uploaded_at ||
              null,

            billUploadedAt:
              bill?.bill_uploaded_at ||
              null,

            order_shop_bill:
              bill || null,

            orderShopBill:
              bill || null,

            bill:
              bill || null,
          },
        ];
      }

      // ==================================================
      // ITEMS
      // ==================================================

      const itemsResult =
        await pool.query(
          `
          SELECT
            oi.id,
            oi.order_id,
            oi.shop_id,

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
            oi.created_at,

            s.shop_name,
            s.image_url AS shop_image,

            COALESCE(
              (
                SELECT json_agg(
                  json_build_object(
                    'id', ri.id,
                    'order_id', ri.order_id,
                    'original_item_id', ri.original_item_id,
                    'shopper_id', ri.shopper_id,
                    'option_number', ri.option_number,

                    'photo_url', ri.photo_url,
                    'photoUrl', ri.photo_url,

                    'replacement_photo_url', ri.photo_url,
                    'replacementPhotoUrl', ri.photo_url,

                    'status', ri.status,

                    'created_at', ri.created_at,
                    'updated_at', ri.updated_at
                  )
                  ORDER BY
                    ri.option_number ASC
                )
                FROM replacement_items ri
                WHERE
                  ri.order_id = oi.order_id
                  AND ri.original_item_id = oi.id
              ),
              '[]'::json
            ) AS replacement_items

          FROM order_items oi

          LEFT JOIN shops s
            ON s.id = oi.shop_id

          WHERE
            oi.order_id = $1

          ORDER BY
            oi.id ASC
          `,
          [orderId]
        );

      const items =
        itemsResult.rows.map(
          item => ({
            ...item,

            id:
              Number(item.id),

            order_id:
              Number(item.order_id),

            orderId:
              Number(item.order_id),

            shop_id:
              item.shop_id !== null
                ? Number(item.shop_id)
                : null,

            shopId:
              item.shop_id !== null
                ? Number(item.shop_id)
                : null,

            product_id:
              item.product_id !== null
                ? Number(item.product_id)
                : null,

            productId:
              item.product_id !== null
                ? Number(item.product_id)
                : null,

            quantity:
              Number(item.quantity),

            amount:
              Number(item.amount),

            price:
              Number(item.price),

            image:
              item.image || null,

            voice_url:
              item.voice_url || null,

            voiceUrl:
              item.voice_url || null,

            shop:
              item.shop_id !== null
                ? {
                    id:
                      Number(item.shop_id),

                    name:
                      item.shop_name || null,

                    image:
                      item.shop_image || null,
                  }
                : null,

            replacement_items:
              Array.isArray(
                item.replacement_items
              )
                ? item.replacement_items
                : [],

            replacementItems:
              Array.isArray(
                item.replacement_items
              )
                ? item.replacement_items
                : [],

            replacements:
              Array.isArray(
                item.replacement_items
              )
                ? item.replacement_items
                : [],

            shopping_status:
              item.shopping_status ||
              'pending',

            shoppingStatus:
              item.shopping_status ||
              'pending',

            found_quantity:
              item.found_quantity !== null
                ? Number(
                    item.found_quantity
                  )
                : null,

            foundQuantity:
              item.found_quantity !== null
                ? Number(
                    item.found_quantity
                  )
                : null,

            found_weight:
              item.found_weight !== null
                ? Number(
                    item.found_weight
                  )
                : null,

            foundWeight:
              item.found_weight !== null
                ? Number(
                    item.found_weight
                  )
                : null,

            found_weight_unit:
              item.found_weight_unit ||
              null,

            foundWeightUnit:
              item.found_weight_unit ||
              null,

            barcode_scanned:
              item.barcode_scanned === true,

            barcodeScanned:
              item.barcode_scanned === true,

            shopper_photo_url:
              item.shopper_photo_url ||
              null,

            shopperPhotoUrl:
              item.shopper_photo_url ||
              null,

            completed_at:
              item.completed_at ||
              null,

            completedAt:
              item.completed_at ||
              null,
          })
        );

      // ==================================================
      // TOTALS
      // ==================================================

      const totalAmount =
        Number(order.total_amount) || 0;

      const itemsTotal =
        Number(order.items_total) || 0;

      const deliveryFee =
        Number(order.delivery_fee) || 0;

      const fastDeliveryFee =
        Number(order.fast_delivery_fee) || 0;

      const serviceFee =
        Number(order.service_fee) || 0;

      const distanceKm =
        order.distance_km !== null
          ? Number(order.distance_km)
          : null;

      // ==================================================
      // SHOPPER
      // ==================================================

      const shopper =
        order.shopper_id
          ? {
              id:
                Number(order.shopper_id),

              name:
                order.shopper_name ||
                'Shopper',

              full_name:
                order.shopper_name ||
                'Shopper',

              mobile:
                order.shopper_mobile ||
                null,

              status:
                order.shopper_status ||
                null,

              latitude:
                order.shopper_latitude !== null
                  ? Number(
                      order.shopper_latitude
                    )
                  : null,

              longitude:
                order.shopper_longitude !== null
                  ? Number(
                      order.shopper_longitude
                    )
                  : null,
            }
          : null;

      // ==================================================
      // RESPONSE
      // ==================================================

      return res.status(200).json({
        success: true,

        order: {
          ...order,

          id:
            Number(order.id),

          orderId:
            Number(order.id),

          customer_id:
            Number(order.customer_id),

          customerId:
            Number(order.customer_id),

          shop_id:
            order.shop_id !== null
              ? Number(order.shop_id)
              : null,

          shopper_id:
            order.shopper_id
              ? Number(order.shopper_id)
              : null,

          delivery_latitude:
            Number(order.delivery_latitude),

          delivery_longitude:
            Number(order.delivery_longitude),

          items_total:
            itemsTotal,

          delivery_fee:
            deliveryFee,

          fast_delivery_fee:
            fastDeliveryFee,

          service_fee:
            serviceFee,

          distance_km:
            distanceKm,

          distanceKm:
            distanceKm,

          total_amount:
            totalAmount,

          total:
            totalAmount,

          totalAmount:
            totalAmount,

          itemsTotal:
            itemsTotal,

          deliveryFee:
            deliveryFee,

          fastDeliveryFee:
            fastDeliveryFee,

          serviceFee:
            serviceFee,

          scheduled_date:
            order.scheduled_date || null,

          scheduledDate:
            order.scheduled_date || null,

          scheduled_start_time:
            order.scheduled_start_time || null,

          scheduledStartTime:
            order.scheduled_start_time || null,

          scheduled_end_time:
            order.scheduled_end_time || null,

          scheduledEndTime:
            order.scheduled_end_time || null,

          estimated_delivery_minutes:
            order.estimated_delivery_minutes !== null
              ? Number(
                  order.estimated_delivery_minutes
                )
              : null,

          estimatedDeliveryMinutes:
            order.estimated_delivery_minutes !== null
              ? Number(
                  order.estimated_delivery_minutes
                )
              : null,

          estimated_delivery_max_minutes:
            order.estimated_delivery_max_minutes !== null
              ? Number(
                  order.estimated_delivery_max_minutes
                )
              : null,

          estimatedDeliveryMaxMinutes:
            order.estimated_delivery_max_minutes !== null
              ? Number(
                  order.estimated_delivery_max_minutes
                )
              : null,

          shop: {
            id:
              order.shop_id !== null
                ? Number(order.shop_id)
                : null,

            name:
              order.shop_name ||
              'Selected Shop',

            shop_name:
              order.shop_name ||
              'Selected Shop',

            image:
              order.shop_image ||
              null,

            image_url:
              order.shop_image ||
              null,

            latitude:
              order.shop_latitude !== null
                ? Number(
                    order.shop_latitude
                  )
                : null,

            longitude:
              order.shop_longitude !== null
                ? Number(
                    order.shop_longitude
                  )
                : null,
          },

          // ==================================================
          // MULTI SHOP DATA
          // ==================================================

          shops:
            orderShops,

          orderShops:
            orderShops,

          order_shops:
            orderShops,

          shopBills:
            shopBills,

          shop_bills:
            shopBills,

          orderShopBills:
            shopBills,

          order_shop_bills:
            shopBills,

          // ==================================================
          // SHOPPER
          // ==================================================

          shopper:
            shopper,

          assignedShopper:
            shopper,

          assigned_shopper:
            shopper,

          // ==================================================
          // ITEMS
          // ==================================================

          items:
            items,

          shoppingList:
            items,

          orderItems:
            items,
        },
      });

    } catch (error) {
      console.error(
        '❌ GET CUSTOMER ORDER ERROR:',
        error
      );

      return res.status(500).json({
        success: false,

        message:
          'Failed to load order',

        error:
          error.message,
      });
    }
  };


// ==================================================
// GET NEARBY ONLINE SHOPPERS FOR ORDER
// ==================================================

const getNearbyShoppersForOrder =
  async (
    req,
    res
  ) => {
    try {
      const customerId =
        req.customer.customerId;

      const orderId =
        Number(
          req.params.orderId
        );

      if (
        !Number.isInteger(orderId)
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Invalid order ID',
        });
      }

      const orderResult =
        await pool.query(
          `
          SELECT
            o.id,
            o.customer_id,
            o.shop_id,
            o.status,
            o.shopper_id,

            s.shop_name,

            s.latitude AS shop_latitude,
            s.longitude AS shop_longitude

          FROM orders o

          LEFT JOIN shops s
            ON s.id = o.shop_id

          WHERE
            o.id = $1
            AND o.customer_id = $2

          LIMIT 1
          `,
          [
            orderId,
            customerId,
          ]
        );

      if (
        orderResult.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,

          message:
            'Order not found',
        });
      }

      const order =
        orderResult.rows[0];

      let acceptedShopper =
        null;

      if (order.shopper_id) {
        const acceptedShopperResult =
          await pool.query(
            `
            SELECT
              id,
              full_name,
              mobile,
              status,
              latitude,
              longitude

            FROM shoppers

            WHERE
              id = $1

            LIMIT 1
            `,
            [order.shopper_id]
          );

        if (
          acceptedShopperResult.rows.length > 0
        ) {
          const shopper =
            acceptedShopperResult.rows[0];

          acceptedShopper = {
            id:
              Number(shopper.id),

            name:
              shopper.full_name ||
              'Shopper',

            full_name:
              shopper.full_name ||
              'Shopper',

            mobile:
              shopper.mobile ||
              null,

            status:
              shopper.status ||
              null,

            latitude:
              shopper.latitude !== null
                ? Number(shopper.latitude)
                : null,

            longitude:
              shopper.longitude !== null
                ? Number(shopper.longitude)
                : null,
          };
        }
      }

      const shopLatitude =
        Number(order.shop_latitude);

      const shopLongitude =
        Number(order.shop_longitude);

      if (
        !Number.isFinite(shopLatitude) ||
        !Number.isFinite(shopLongitude)
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Shop location is not available',
        });
      }

      const shoppersResult =
        await pool.query(
          `
          SELECT
            sh.id,
            sh.full_name,
            sh.mobile,
            sh.status,
            sh.latitude,
            sh.longitude,

            (
              6371 *
              acos(
                LEAST(
                  1,
                  GREATEST(
                    -1,

                    cos(radians($1)) *
                    cos(radians(sh.latitude)) *
                    cos(
                      radians(sh.longitude) -
                      radians($2)
                    ) +

                    sin(radians($1)) *
                    sin(radians(sh.latitude))
                  )
                )
              )
            ) AS distance_km

          FROM shoppers sh

          WHERE
            sh.status = 'online'

            AND sh.latitude IS NOT NULL
            AND sh.longitude IS NOT NULL

            AND sh.latitude BETWEEN -90 AND 90
            AND sh.longitude BETWEEN -180 AND 180

          ORDER BY
            distance_km ASC
          `,
          [
            shopLatitude,
            shopLongitude,
          ]
        );

      const shoppers =
        shoppersResult.rows
          .filter(
            shopper => {
              const distance =
                Number(
                  shopper.distance_km
                );

              return (
                Number.isFinite(distance) &&
                distance <= 10
              );
            }
          )
          .map(
            shopper => ({
              id:
                Number(shopper.id),

              name:
                shopper.full_name,

              full_name:
                shopper.full_name,

              mobile:
                shopper.mobile,

              status:
                shopper.status,

              latitude:
                shopper.latitude !== null
                  ? Number(
                      shopper.latitude
                    )
                  : null,

              longitude:
                shopper.longitude !== null
                  ? Number(
                      shopper.longitude
                    )
                  : null,

              distance_km:
                Number(
                  shopper.distance_km
                ),
            })
          );

      return res.status(200).json({
        success: true,

        orderId:
          Number(order.id),

        orderStatus:
          order.status,

        shop: {
          id:
            Number(order.shop_id),

          name:
            order.shop_name ||
            'Selected Shop',

          latitude:
            shopLatitude,

          longitude:
            shopLongitude,
        },

        shopper:
          acceptedShopper,

        acceptedShopper:
          acceptedShopper,

        assignedShopper:
          acceptedShopper,

        assigned_shopper:
          acceptedShopper,

        shoppers:
          shoppers,
      });

    } catch (error) {
      console.error(
        '❌ GET NEARBY SHOPPERS ERROR:',
        error
      );

      return res.status(500).json({
        success: false,

        message:
          'Failed to load nearby shoppers',

        error:
          error.message,
      });
    }
  };


// ==================================================
// CANCEL CUSTOMER ORDER
// ==================================================

const cancelCustomerOrder =
  async (
    req,
    res
  ) => {
    try {
      const customerId =
        req.customer.customerId;

      const orderId =
        Number(
          req.params.orderId
        );

      if (
        !Number.isInteger(orderId)
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Invalid order ID',
        });
      }

      const orderResult =
        await pool.query(
          `
          SELECT
            id,
            status

          FROM orders

          WHERE
            id = $1
            AND customer_id = $2

          LIMIT 1
          `,
          [
            orderId,
            customerId,
          ]
        );

      if (
        orderResult.rows.length === 0
      ) {
        return res.status(404).json({
          success: false,

          message:
            'Order not found',
        });
      }

      const order =
        orderResult.rows[0];

      if (
        order.status !==
        'waiting_for_shopper'
      ) {
        return res.status(400).json({
          success: false,

          message:
            'This order cannot be cancelled now',
        });
      }

      const updateResult =
        await pool.query(
          `
          UPDATE orders

          SET
            status = 'cancelled',
            updated_at = CURRENT_TIMESTAMP

          WHERE
            id = $1
            AND customer_id = $2

          RETURNING *
          `,
          [
            orderId,
            customerId,
          ]
        );

      emitOrderSocketEvent({
        req,

        event:
          'order-status-changed',

        orderId,

        customerId,

        payload: {
          status:
            'cancelled',

          order: {
            ...updateResult.rows[0],

            id:
              Number(
                updateResult.rows[0].id
              ),

            orderId:
              Number(
                updateResult.rows[0].id
              ),

            status:
              'cancelled',
          },
        },
      });

      return res.status(200).json({
        success: true,

        message:
          'Order cancelled successfully',

        order:
          updateResult.rows[0],
      });

    } catch (error) {
      console.error(
        '❌ CANCEL ORDER ERROR:',
        error
      );

      return res.status(500).json({
        success: false,

        message:
          'Failed to cancel order',

        error:
          error.message,
      });
    }
  };


// ==================================================
// UPDATE REPLACEMENT STATUS
// ==================================================

const updateReplacementStatus =
  async (
    req,
    res
  ) => {
    const client =
      await pool.connect();

    try {
      const customerId =
        req.customer.customerId;

      const orderId =
        Number(
          req.params.orderId
        );

      const replacementId =
        Number(
          req.params.replacementId
        );

      const {
        status,
        decision,
      } = req.body;

      if (
        !Number.isInteger(orderId) ||
        !Number.isInteger(replacementId)
      ) {
        return res.status(400).json({
          success: false,

          message:
            'Invalid order or replacement ID',
        });
      }

      const finalStatus =
        decision === 'accepted'
          ? 'accepted'
          : decision === 'rejected'
            ? 'rejected'
            : status === 'accepted'
              ? 'accepted'
              : status === 'rejected'
                ? 'rejected'
                : null;

      if (!finalStatus) {
        return res.status(400).json({
          success: false,

          message:
            'Decision must be accepted or rejected',
        });
      }

      await client.query('BEGIN');

      const orderResult =
        await client.query(
          `
          SELECT
            id,
            customer_id

          FROM orders

          WHERE
            id = $1
            AND customer_id = $2

          LIMIT 1
          `,
          [
            orderId,
            customerId,
          ]
        );

      if (
        orderResult.rows.length === 0
      ) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          success: false,

          message:
            'Order not found',
        });
      }

      const replacementResult =
        await client.query(
          `
          SELECT
            id,
            order_id,
            original_item_id,
            shopper_id,
            option_number,
            photo_url,
            status,
            created_at,
            updated_at

          FROM replacement_items

          WHERE
            id = $1
            AND order_id = $2

          LIMIT 1
          `,
          [
            replacementId,
            orderId,
          ]
        );

      if (
        replacementResult.rows.length === 0
      ) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          success: false,

          message:
            'Replacement item not found',
        });
      }

      const replacement =
        replacementResult.rows[0];

      if (
        replacement.status !==
        'waiting_customer'
      ) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          success: false,

          message:
            'This replacement has already been processed',

          status:
            replacement.status,
        });
      }

      const databaseStatus =
        finalStatus === 'accepted'
          ? 'customer_accepted'
          : 'customer_rejected';

      const updateReplacementResult =
        await client.query(
          `
          UPDATE replacement_items

          SET
            status = $1,
            updated_at = CURRENT_TIMESTAMP

          WHERE
            id = $2
            AND order_id = $3

          RETURNING
            id,
            order_id,
            original_item_id,
            shopper_id,
            option_number,
            photo_url,
            status,
            created_at,
            updated_at
          `,
          [
            databaseStatus,
            replacementId,
            orderId,
          ]
        );

      if (
        updateReplacementResult.rows.length === 0
      ) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          success: false,

          message:
            'Replacement item could not be updated',
        });
      }

      const updatedReplacement =
        updateReplacementResult.rows[0];

      const originalItemResult =
        await client.query(
          `
          UPDATE order_items

          SET
            shopping_status = 'done',
            completed_at = CURRENT_TIMESTAMP

          WHERE
            id = $1
            AND order_id = $2

          RETURNING
            id,
            order_id,
            shop_id,
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
            created_at
          `,
          [
            updatedReplacement.original_item_id,
            orderId,
          ]
        );

      if (
        originalItemResult.rows.length === 0
      ) {
        await client.query('ROLLBACK');

        return res.status(404).json({
          success: false,

          message:
            'Original order item not found',
        });
      }

      const updatedOriginalItem =
        originalItemResult.rows[0];

      await client.query('COMMIT');

      emitOrderSocketEvent({
        req,

        event:
          'order-item-updated',

        orderId,

        customerId,

        payload: {
          item: {
            ...updatedOriginalItem,

            id:
              Number(
                updatedOriginalItem.id
              ),

            order_id:
              Number(
                updatedOriginalItem.order_id
              ),

            orderId:
              Number(
                updatedOriginalItem.order_id
              ),

            shop_id:
              updatedOriginalItem.shop_id !== null
                ? Number(
                    updatedOriginalItem.shop_id
                  )
                : null,

            shopId:
              updatedOriginalItem.shop_id !== null
                ? Number(
                    updatedOriginalItem.shop_id
                  )
                : null,

            shopping_status:
              updatedOriginalItem.shopping_status,

            shoppingStatus:
              updatedOriginalItem.shopping_status,

            found_quantity:
              updatedOriginalItem.found_quantity !== null
                ? Number(
                    updatedOriginalItem.found_quantity
                  )
                : null,

            foundQuantity:
              updatedOriginalItem.found_quantity !== null
                ? Number(
                    updatedOriginalItem.found_quantity
                  )
                : null,

            found_weight:
              updatedOriginalItem.found_weight !== null
                ? Number(
                    updatedOriginalItem.found_weight
                  )
                : null,

            foundWeight:
              updatedOriginalItem.found_weight !== null
                ? Number(
                    updatedOriginalItem.found_weight
                  )
                : null,

            found_weight_unit:
              updatedOriginalItem.found_weight_unit ||
              null,

            foundWeightUnit:
              updatedOriginalItem.found_weight_unit ||
              null,

            barcode_scanned:
              updatedOriginalItem.barcode_scanned === true,

            barcodeScanned:
              updatedOriginalItem.barcode_scanned === true,

            shopper_photo_url:
              updatedOriginalItem.shopper_photo_url ||
              null,

            shopperPhotoUrl:
              updatedOriginalItem.shopper_photo_url ||
              null,

            completed_at:
              updatedOriginalItem.completed_at ||
              null,

            completedAt:
              updatedOriginalItem.completed_at ||
              null,
          },

          replacement: {
            id:
              Number(
                updatedReplacement.id
              ),

            orderId:
              Number(
                updatedReplacement.order_id
              ),

            order_id:
              Number(
                updatedReplacement.order_id
              ),

            originalItemId:
              Number(
                updatedReplacement.original_item_id
              ),

            original_item_id:
              Number(
                updatedReplacement.original_item_id
              ),

            shopperId:
              updatedReplacement.shopper_id !== null
                ? Number(
                    updatedReplacement.shopper_id
                  )
                : null,

            shopper_id:
              updatedReplacement.shopper_id !== null
                ? Number(
                    updatedReplacement.shopper_id
                  )
                : null,

            optionNumber:
              Number(
                updatedReplacement.option_number
              ),

            option_number:
              Number(
                updatedReplacement.option_number
              ),

            photoUrl:
              updatedReplacement.photo_url,

            photo_url:
              updatedReplacement.photo_url,

            replacementPhotoUrl:
              updatedReplacement.photo_url,

            replacement_photo_url:
              updatedReplacement.photo_url,

            status:
              updatedReplacement.status,

            createdAt:
              updatedReplacement.created_at,

            created_at:
              updatedReplacement.created_at,

            updatedAt:
              updatedReplacement.updated_at,

            updated_at:
              updatedReplacement.updated_at,
          },
        },
      });

      return res.status(200).json({
        success: true,

        message:
          finalStatus === 'accepted'
            ? 'Replacement accepted and order item moved to DONE successfully'
            : 'Replacement rejected and order item moved to DONE successfully',

        replacement: {
          id:
            Number(
              updatedReplacement.id
            ),

          orderId:
            Number(
              updatedReplacement.order_id
            ),

          originalItemId:
            Number(
              updatedReplacement.original_item_id
            ),

          shopperId:
            updatedReplacement.shopper_id !== null
              ? Number(
                  updatedReplacement.shopper_id
                )
              : null,

          optionNumber:
            Number(
              updatedReplacement.option_number
            ),

          photoUrl:
            updatedReplacement.photo_url,

          photo_url:
            updatedReplacement.photo_url,

          replacementPhotoUrl:
            updatedReplacement.photo_url,

          replacement_photo_url:
            updatedReplacement.photo_url,

          status:
            updatedReplacement.status,

          createdAt:
            updatedReplacement.created_at,

          updatedAt:
            updatedReplacement.updated_at,
        },

        originalItem: {
          ...updatedOriginalItem,

          shopId:
            updatedOriginalItem.shop_id !== null
              ? Number(
                  updatedOriginalItem.shop_id
                )
              : null,

          shop_id:
            updatedOriginalItem.shop_id !== null
              ? Number(
                  updatedOriginalItem.shop_id
                )
              : null,

          shoppingStatus:
            updatedOriginalItem.shopping_status,

          foundQuantity:
            updatedOriginalItem.found_quantity !== null
              ? Number(
                  updatedOriginalItem.found_quantity
                )
              : null,

          foundWeight:
            updatedOriginalItem.found_weight !== null
              ? Number(
                  updatedOriginalItem.found_weight
                )
              : null,

          foundWeightUnit:
            updatedOriginalItem.found_weight_unit ||
            null,

          barcodeScanned:
            updatedOriginalItem.barcode_scanned === true,

          shopperPhotoUrl:
            updatedOriginalItem.shopper_photo_url ||
            null,

          completedAt:
            updatedOriginalItem.completed_at ||
            null,
        },
      });

    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(
          '❌ Rollback error:',
          rollbackError.message
        );
      }

      console.error(
        '❌ UPDATE REPLACEMENT STATUS ERROR:',
        error
      );

      return res.status(500).json({
        success: false,

        message:
          'Failed to update replacement status',

        error:
          error.message,
      });

    } finally {
      client.release();
    }
  };


// ==================================================
// EXPORT
// ==================================================

module.exports = {
  createOrder,

  getCustomerOrders,

  getCustomerOrderById,

  getNearbyShoppersForOrder,

  cancelCustomerOrder,

  updateReplacementStatus,

  uploadCustomItemMedia,
};