

const pool = require('../config/db');

const {
  notifyNearbyShoppersOfNewBatch,
} = require('./shopperBatchAlerts');

const { broadcastOrderChange } = require('../realtime');

const {
  createShopperNotification,
} = require('./shopperNotificationController');

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

    // Admin panel + shop websites
    broadcastOrderChange(io, numericOrderId, {
      event,
      status: socketPayload.status || null,
    });

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
// START SHOPPER SEARCH
// ==================================================

const startShopperSearch = async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const orderId = Number(req.params.orderId);

    if (!Number.isInteger(orderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID',
      });
    }

    const result = await pool.query(
      `
      UPDATE orders
      SET
        status = 'waiting_for_shopper',
        shopper_search_started_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE
        id = $1
        AND customer_id = $2
        AND status = 'pending_shopper_search'
        AND shopper_id IS NULL
      RETURNING *
      `,
      [orderId, customerId]
    );

    if (result.rows.length === 0) {
      const existing = await pool.query(
        `
        SELECT id, status, shopper_id
        FROM orders
        WHERE id = $1 AND customer_id = $2
        LIMIT 1
        `,
        [orderId, customerId]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Order not found',
        });
      }

      const order = existing.rows[0];

      if (order.shopper_id) {
        return res.status(409).json({
          success: false,
          message: 'A shopper has already accepted this order',
          status: order.status,
        });
      }

      return res.status(409).json({
        success: false,
        message: 'This order cannot start shopper search',
        status: order.status,
      });
    }

    const order = result.rows[0];

    emitOrderSocketEvent({
      req,
      event: 'order-status-changed',
      orderId,
      customerId,
      payload: {
        status: 'waiting_for_shopper',
        order: {
          ...order,
          id: Number(order.id),
          orderId: Number(order.id),
          status: 'waiting_for_shopper',
        },
      },
    });

    // Not awaited - alerting shoppers must not slow down the customer
    notifyNearbyShoppersOfNewBatch({
      io: req.app.get('io'),
      order,
    });

    return res.status(200).json({
      success: true,
      message: 'Shopper search started',
      order: order,
    });
  } catch (error) {
    console.error('START SHOPPER SEARCH ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to start shopper search',
      error: error.message,
    });
  }
};


// ==================================================
// STOP SHOPPER SEARCH
// ==================================================

const stopShopperSearch = async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const orderId = Number(req.params.orderId);

    if (!Number.isInteger(orderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID',
      });
    }

    const result = await pool.query(
      `
      UPDATE orders
      SET
        status = 'shopper_search_cancelled',
        updated_at = CURRENT_TIMESTAMP
      WHERE
        id = $1
        AND customer_id = $2
        AND status = 'waiting_for_shopper'
        AND shopper_id IS NULL
      RETURNING *
      `,
      [orderId, customerId]
    );

    if (result.rows.length === 0) {
      const existing = await pool.query(
        `
        SELECT id, status, shopper_id
        FROM orders
        WHERE id = $1 AND customer_id = $2
        LIMIT 1
        `,
        [orderId, customerId]
      );

      if (existing.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Order not found',
        });
      }

      const order = existing.rows[0];

      if (order.shopper_id) {
        return res.status(409).json({
          success: false,
          message: 'A shopper has already accepted this order. Search cannot be stopped now.',
          status: order.status,
        });
      }

      return res.status(409).json({
        success: false,
        message: 'Shopper search is not currently active',
        status: order.status,
      });
    }

    const order = result.rows[0];

    emitOrderSocketEvent({
      req,
      event: 'order-status-changed',
      orderId,
      customerId,
      payload: {
        status: 'shopper_search_cancelled',
        order: {
          ...order,
          id: Number(order.id),
          orderId: Number(order.id),
          status: 'shopper_search_cancelled',
        },
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Shopper search stopped. Your order is still saved.',
      order: order,
    });
  } catch (error) {
    console.error('STOP SHOPPER SEARCH ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to stop shopper search',
      error: error.message,
    });
  }
};

























// ==================================================
// CREATE ORDER -> customerCreateOrderController.js (server-side pricing)
// ==================================================

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
                  oi.replacement_preference,
                  oi.replacement_product_id,
                  oi.replacement_product_name,
                  oi.replacement_product_image,
                  oi.replacement_product_price,
                  oi.replacement_note,
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
            oi.replacement_preference,
            oi.replacement_product_id,
            oi.replacement_product_name,
            oi.replacement_product_image,
            oi.replacement_product_price,
            oi.replacement_note,
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
            replacement_preference,
            replacement_product_id,
            replacement_product_name,
            replacement_product_image,
            replacement_product_price,
            replacement_note,
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

      createShopperNotification({
        io: req.app.get('io'),
        shopperId: updatedReplacement.shopper_id,
        type:
          finalStatus === 'accepted'
            ? 'replacement_approved'
            : 'replacement_rejected',
        title:
          finalStatus === 'accepted'
            ? 'Replacement approved'
            : 'Replacement rejected',
        body:
          finalStatus === 'accepted'
            ? `Customer approved the replacement for ${updatedOriginalItem.item_name}.`
            : `Customer rejected the replacement for ${updatedOriginalItem.item_name}. Don't add it.`,
        orderId,
      });

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

  getCustomerOrders,

  getCustomerOrderById,

  getNearbyShoppersForOrder,

  cancelCustomerOrder,

  updateReplacementStatus,

  uploadCustomItemMedia,


  startShopperSearch,
stopShopperSearch,
};