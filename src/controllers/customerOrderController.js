

const pool = require('../config/db');

const {
  notifyNearbyShoppersOfNewBatch,
} = require('./shopperBatchAlerts');

const {
  dispatchOrder,
  getNearbyVehicles,
  getEligibleShoppers,
  getOfferHolders,
  notifyOffersWithdrawn,
} = require('./shopperDispatch');

const { VEHICLE_TYPES } = require('../utils/vehicleTypes');
const {
  BOOKABLE_VEHICLES,
  orderFeeFor,
  repriceOrder,
  hasFreeDeliveryPromo,
  applyVehiclePrice,
} = require('../pricing/vehicles');

const { broadcastOrderChange } = require('../realtime');
const { postChatEvent } = require('../utils/chatEvents');
const {
  extraChargeFor,
  bookingChargeFor,
  toPublicPayment,
  chargeApprovalNeeded,
  chargeApproved,
  chargeOrderExtra,
  syncOrderPaymentColumns,
  refundWholePayment,
  reconcileInBackground,
} = require('../payments/paymentService');
const { publicBaseUrl } = require('../payments/payhere');
const { vehicleEtasToShop } = require('../utils/vehicleEta');
const {
  CUSTOMER_CANCELLABLE_STATUSES,
  FINISHED_STATUSES,
} = require('../utils/orderStatus');

const {
  createShopperNotification,
} = require('./shopperNotificationController');
const { getPricingSettings } = require('../pricing/settings');
const {
  REASONS: CANCEL_REASONS,
  customerCancelDecision,
  cancelMoney,
  readReason: readCancelReason,
} = require('../orders/cancelPolicy');
const { refreshOrderSettlement } = require('./settlementController');

// ==================================================
// SOCKET.IO ORDER EVENT HELPER
// ==================================================

// shopperId (optional): also the shopper's own room - the
// ShopperApp never joins order:{id}, so e.g. a replacement decision
// only reached it on its next poll
const emitOrderSocketEvent = ({
  req,
  event,
  orderId,
  customerId,
  shopperId = null,
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

    if (Number.isInteger(Number(shopperId)) && Number(shopperId) > 0) {
      io.to(
        `shopper:${Number(shopperId)}`
      ).emit(
        event,
        socketPayload
      );
    }

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

    // Preferred shopper vehicle; missing / 'any' = any vehicle
    const requestedVehicle = String(
      req.body?.vehicleType || ''
    ).trim().toLowerCase();

    if (
      requestedVehicle &&
      requestedVehicle !== 'any' &&
      !VEHICLE_TYPES.includes(requestedVehicle)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Choose a valid vehicle type',
      });
    }

    const preferredVehicle =
      requestedVehicle && requestedVehicle !== 'any'
        ? requestedVehicle
        : null;

    // Status change + delivery fee for the booked vehicle together.
    // Saved card: the first booking charges the whole order (Place
    // order charges nothing); a later booking with a dearer vehicle
    // charges the difference. Either way the customer approves the
    // amount first (402 CARD_CHARGE_REQUIRED, then again with
    // authorizeCharge) and the card is charged before the search
    // starts. A decline rolls the booking back, so retrying (same
    // order, optional cardId for another card) can't double-charge.
    const client = await pool.connect();
    let result;
    let extraPayment = null;
    let refusal = null;

    try {
      await client.query('BEGIN');

      result = await client.query(
        `
        UPDATE orders
        SET
          status = 'waiting_for_shopper',
          preferred_vehicle_type = $3,
          shopper_search_started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE
          id = $1
          AND customer_id = $2
          -- shopper_search_cancelled: stopped before customers could
          -- book again; those orders can be booked again too
          AND status IN ('pending_shopper_search', 'shopper_search_cancelled')
          AND shopper_id IS NULL
        RETURNING *
        `,
        [orderId, customerId, preferredVehicle]
      );

      if (result.rows.length > 0 && preferredVehicle) {
        result = {
          rows: [await applyVehiclePrice(client, result.rows[0], preferredVehicle)],
        };
      }

      const booking =
        result.rows.length > 0
          ? await bookingChargeFor(client, result.rows[0], req.body?.cardId)
          : null;

      if (booking?.error) {
        refusal = () =>
          res.status(booking.error.status).json({
            success: false,
            code: booking.error.code,
            message: booking.error.message,
          });
      } else if (result.rows.length > 0) {
        const repriced = result.rows[0];
        const firstCharge = booking.needed;
        const charge = firstCharge
          ? booking
          : await extraChargeFor(client, repriced, repriced.total_amount);

        if (charge.extra > 0 && !chargeApproved(req.body, charge)) {
          refusal = () =>
            chargeApprovalNeeded(
              res,
              charge,
              'This vehicle',
              firstCharge
                ? `Booking charges Rs ${charge.extra.toFixed(2)} to ${charge.card?.label || 'your card'}. Approve the payment?`
                : undefined
            );
        } else if (charge.extra > 0) {
          const outcome = await chargeOrderExtra({
            order: repriced,
            charge,
            items: firstCharge
              ? `GetMe order #${orderId}`
              : `GetMe order #${orderId} - vehicle change`,
            purpose: firstCharge ? 'order' : 'order_extra',
            baseUrl: publicBaseUrl(req),
            io: req.app.get('io'),
          });

          if (outcome.error) {
            refusal = () =>
              res.status(outcome.error.status).json({
                success: false,
                code: outcome.error.code,
                message: outcome.error.message,
              });
          } else {
            extraPayment = outcome.row;
            await syncOrderPaymentColumns(client, orderId);
          }
        }
      }

      await client.query(refusal ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');

      if (extraPayment) {
        await refundWholePayment(extraPayment.id, 'Shopper search did not start', req.app.get('io'));
      }

      throw error;
    } finally {
      client.release();
    }

    if (refusal) {
      return refusal();
    }

    // A cheaper vehicle than before: the difference goes back
    reconcileInBackground(orderId, {
      io: req.app.get('io'),
      reason: 'Cheaper vehicle chosen',
    });

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
      // Saved-card charge taken for this booking (null: none needed)
      payment: extraPayment ? toPublicPayment(extraPayment) : null,
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

    // Stopping is not a cancellation: the order goes back to
    // "ready to book" (keeping the chosen vehicle), so the customer
    // can pick a vehicle and book again at any time.
    const result = await pool.query(
      `
      UPDATE orders
      SET
        status = 'pending_shopper_search',
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
        status: 'pending_shopper_search',
        order: {
          ...order,
          id: Number(order.id),
          orderId: Number(order.id),
          status: 'pending_shopper_search',
        },
      },
    });

    // Whoever held the offer loses it now (a new booking starts a
    // fresh closest-first round anyway) - and sees it vanish at once
    const holders = await getOfferHolders(orderId);

    await pool.query(
      'DELETE FROM shopper_order_offers WHERE order_id = $1',
      [orderId]
    );

    notifyOffersWithdrawn(req.app.get('io'), orderId, holders, 'search-stopped');

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
          sh.longitude AS shopper_longitude,
          sh.vehicle_type AS shopper_vehicle_type,
          sh.vehicle_number AS shopper_vehicle_number,
          sh.profile_image_url AS shopper_image

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
                  osb.bill_urls,
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
                  // Every receipt photo (first = billUrl)
                  billUrls:
                    Array.isArray(bill.bill_urls) && bill.bill_urls.length > 0
                      ? bill.bill_urls
                      : bill.bill_url ? [bill.bill_url] : [],

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
                  oi.refund_amount,
                  oi.refunded_at,
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

                  // Refunded instead of replaced (shopping_status 'refunded')
                  refund_amount:
                    item.refund_amount != null ? Number(item.refund_amount) : null,

                  refundAmount:
                    item.refund_amount != null ? Number(item.refund_amount) : null,

                  refunded_at:
                    item.refunded_at || null,

                  refundedAt:
                    item.refunded_at || null,

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


                    // Shown on the "Your shopper" card

                    vehicle_type:

                      order.shopper_vehicle_type ||

                      null,


                    vehicle_number:

                      order.shopper_vehicle_number ||

                      null,

                    // Face on the map pin + shopper card
                    image:
                      order.shopper_image || null,

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
              getme_fee:
                Number(order.getme_fee) || 0,

              getme_fee_percent:
                Number(order.getme_fee_percent) || 0,

              service_fee_per_unit:
                Number(order.service_fee_per_unit) || 0,


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
            sh.longitude AS shopper_longitude,
            sh.vehicle_type AS shopper_vehicle_type,
            sh.vehicle_number AS shopper_vehicle_number,
          sh.profile_image_url AS shopper_image

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
            osb.bill_urls,
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
            // Every receipt photo (first = billUrl)
            billUrls:
              Array.isArray(bill.bill_urls) && bill.bill_urls.length > 0
                ? bill.bill_urls
                : bill.bill_url ? [bill.bill_url] : [],

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
            oi.refund_amount,
            oi.refunded_at,
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

            // Refunded instead of replaced (shopping_status 'refunded')
            refund_amount:
              item.refund_amount != null ? Number(item.refund_amount) : null,

            refundAmount:
              item.refund_amount != null ? Number(item.refund_amount) : null,

            refunded_at:
              item.refunded_at || null,

            refundedAt:
              item.refunded_at || null,

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


              // Shown on the "Your shopper" card

              vehicle_type:

                order.shopper_vehicle_type ||

                null,


              vehicle_number:

                order.shopper_vehicle_number ||

                null,

              // Face on the map pin + shopper card
              image:
                order.shopper_image || null,

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
          getme_fee:
            Number(order.getme_fee) || 0,

          getme_fee_percent:
            Number(order.getme_fee_percent) || 0,

          service_fee_per_unit:
            Number(order.service_fee_per_unit) || 0,


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
// SHOPPER SEARCH POLL FOR ORDER
// GET /orders/:orderId/nearby-shoppers (path kept for old apps)
// Returns the shop + accepted shopper only. Available shoppers and
// their locations are never sent to customers; while searching,
// each poll advances the closest-first dispatch.
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

      // While searching, each poll moves the offer on to the next
      // closest shopper when the last one passed or timed out.
      // Customers are NOT told who is available or where they are.
      if (
        order.status === 'waiting_for_shopper' &&
        !order.shopper_id
      ) {
        await dispatchOrder({
          io: req.app.get('io'),
          orderId,
        });
      }

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

// ==================================================
// ORDER CANCELLATION (customer)
// Policy: src/orders/cancelPolicy.js (free until shopping starts;
// rules in pricing settings). The server decides - the app's
// button / preview only reflect this.
//   GET   /api/customer/orders/cancel-policy        rules + reasons
//   GET   /api/customer/orders/:orderId/cancel-preview
//   PATCH /api/customer/orders/:orderId/cancel  { reasonCode, reasonText }
// ==================================================

const toCancellation = (row) =>
  row
    ? {
        cancelledBy: row.cancelled_by,
        reasonCode: row.reason_code,
        reason: row.reason_text,
        fromStatus: row.from_status,
        cancelledAt: row.created_at,
        itemsBought: Number(row.items_bought || 0),
        paymentMethod: row.payment_method,
        amountHeld: row.amount_held === null ? null : Number(row.amount_held),
        amountOwed: row.amount_owed === null ? null : Number(row.amount_owed),
      }
    : null;

const getCancelPolicy = async (req, res) => {
  try {
    const settings = await getPricingSettings();

    return res.json({
      success: true,
      policy: {
        beforeAccept: true,
        afterAccept: !!settings.cancellation?.afterAccept,
        whileShopping: !!settings.cancellation?.whileShopping,
      },
      reasons: CANCEL_REASONS,
    });
  } catch (error) {
    console.error('❌ CANCEL POLICY ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Could not load the cancellation rules' });
  }
};

const getCancelPreview = async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const orderId = Number(req.params.orderId);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const order = (
      await pool.query('SELECT * FROM orders WHERE id = $1 AND customer_id = $2', [orderId, customerId])
    ).rows[0];

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const settings = await getPricingSettings();
    const decision = customerCancelDecision(order, settings);
    const money = decision.allowed ? await cancelMoney(pool, order) : null;

    return res.json({
      success: true,
      orderId,
      status: order.status,
      ...decision,
      money,
      reasons: CANCEL_REASONS,
    });
  } catch (error) {
    console.error('❌ CANCEL PREVIEW ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Could not check this order' });
  }
};

const cancelCustomerOrder = async (req, res) => {
  const customerId = req.customer.customerId;
  const orderId = Number(req.params.orderId);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  const reason = readCancelReason(req.body);

  if (reason.error) {
    return res.status(400).json({ success: false, code: 'REASON_REQUIRED', message: reason.error });
  }

  const settings = await getPricingSettings();
  const client = await pool.connect();
  let order = null;
  let cancelled = null;
  let cancellation = null;
  let offerHolders = [];

  try {
    await client.query('BEGIN');

    // Locked: accept / start shopping / another cancel wait for us
    order = (
      await client.query(
        'SELECT * FROM orders WHERE id = $1 AND customer_id = $2 FOR UPDATE',
        [orderId, customerId]
      )
    ).rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const decision = customerCancelDecision(order, settings);

    if (!decision.allowed) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        success: false,
        code: decision.code,
        stage: decision.stage,
        message: decision.message,
        // Already cancelled: the app shows the real state
        order: decision.code === 'ALREADY_CANCELLED' ? order : undefined,
      });
    }

    const money = await cancelMoney(client, order);
    offerHolders = await getOfferHolders(orderId, client);

    cancelled = (
      await client.query(
        `
        UPDATE orders
        SET
          status = 'cancelled',
          cancelled_by = 'customer',
          cancel_reason = $3,
          cancel_reason_code = $4,
          cancelled_at = NOW(),
          cancelled_from_status = $5,
          delivery_pin = NULL,
          updated_at = NOW()
        WHERE id = $1 AND customer_id = $2 AND status = $5
        RETURNING *
        `,
        [orderId, customerId, reason.text, reason.code, order.status]
      )
    ).rows[0];

    if (!cancelled) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'ORDER_CHANGED', message: 'This order just changed. Please check it again.' });
    }

    // One row per order (unique): the audit record of this cancel
    cancellation = (
      await client.query(
        `
        INSERT INTO order_cancellations
          (order_id, cancelled_by, actor_id, reason_code, reason_text, from_status,
           shopper_id, items_bought, payment_method, amount_held, amount_owed)
        VALUES ($1, 'customer', $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (order_id) DO NOTHING
        RETURNING *
        `,
        [
          orderId,
          customerId,
          reason.code,
          reason.text,
          order.status,
          order.shopper_id,
          money.itemsBought,
          order.payment_method,
          money.held,
          money.owedAfterCancel,
        ]
      )
    ).rows[0];

    if (!cancellation) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'ALREADY_CANCELLED', message: 'This order is already cancelled.' });
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ CANCEL ORDER ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to cancel order' });
  } finally {
    client.release();
  }

  const io = req.app.get('io');

  // Shoppers still holding the offer see it vanish at once
  notifyOffersWithdrawn(io, orderId, offerHolders, 'cancelled');

  // Customer app, the assigned shopper (stops the job), admin + shops
  emitOrderSocketEvent({
    req,
    event: 'order-status-changed',
    orderId,
    customerId,
    shopperId: order.shopper_id,
    payload: {
      status: 'cancelled',
      cancelledBy: 'customer',
      reason: reason.text,
      order: { ...cancelled, id: Number(cancelled.id), orderId: Number(cancelled.id), status: 'cancelled' },
    },
  });

  // Card money back (PayHere confirms each refund; only what isn't
  // owed), and shopper settlement for any groceries already bought
  reconcileInBackground(orderId, { io, reason: 'Order cancelled by customer' });

  if (order.shopper_id) {
    refreshOrderSettlement(orderId, io).catch((error) =>
      console.error('❌ cancel settlement refresh:', error.message)
    );
  }

  return res.status(200).json({
    success: true,
    message: 'Order cancelled',
    order: cancelled,
    cancellation: toCancellation(cancellation),
    refund: {
      // Expected back to the card; done only when PayHere confirms
      // (see GET /api/payments/customer/orders/:id)
      due: Number(cancellation.amount_held || 0) - Number(cancellation.amount_owed || 0) > 0.009
        ? Math.round((Number(cancellation.amount_held) - Number(cancellation.amount_owed)) * 100) / 100
        : 0,
      status: Number(cancellation.amount_held || 0) > 0.009 ? 'pending_gateway' : 'none',
    },
  });
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

      // Chat timeline: "<customer> has approved your <item>
      // replacement"
      if (finalStatus === 'accepted') {
        await postChatEvent({
          io: req.app.get('io'),
          orderId,
          eventType: 'replacement_approved',
          data: { itemName: updatedOriginalItem.item_name },
          onceKey: `item:${updatedOriginalItem.id}`,
        });
      }

      emitOrderSocketEvent({
        req,

        event:
          'order-item-updated',

        orderId,

        customerId,

        // The shopper is waiting on this decision
        shopperId: updatedReplacement.shopper_id,

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

// ==================================================
// NEARBY VEHICLES FOR THE FIND A SHOPPER MAP
// GET /orders/:orderId/nearby-vehicles
// PickMe-style vehicle icons: type + approximate position only
// (no ids / names; positions shifted 200-300 m, see
// shopperDispatch.getNearbyVehicles). Only until a shopper accepts.
// Also one option per bookable vehicle for the cards: its delivery
// fee and order total (orders.vehicle_fees, pricing/vehicles.js) and
// the nearest free shopper's road ETA to the shop.
// ==================================================

const getNearbyVehiclesForOrder = async (req, res) => {
  try {
    const customerId = req.customer.customerId;
    const orderId = Number(req.params.orderId);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid order ID',
      });
    }

    const orderResult = await pool.query(
      `
      SELECT
        o.id, o.status, o.shopper_id, o.promo_code,
        o.delivery_fee, o.vehicle_fees, o.discount_amount, o.total_amount,
        -- the parts repriceOrder rebuilds the total (and GetMe fee) from
        o.items_total, o.fast_delivery_fee, o.service_fee, o.window_discount,
        o.tip_amount, o.getme_fee, o.getme_fee_percent,
        s.latitude AS shop_latitude,
        s.longitude AS shop_longitude
      FROM orders o
      LEFT JOIN shops s ON s.id = o.shop_id
      WHERE o.id = $1 AND o.customer_id = $2
      LIMIT 1
      `,
      [orderId, customerId]
    );

    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found',
      });
    }

    const searching =
      !order.shopper_id &&
      (order.status === 'pending_shopper_search' ||
        order.status === 'waiting_for_shopper' ||
        order.status === 'shopper_search_cancelled');

    if (!searching) {
      return res.status(200).json({ success: true, vehicles: [], options: [] });
    }

    const shoppers = await getEligibleShoppers(orderId, pool, {
      anyVehicle: true,
    });

    const [vehicles, etas, freeDelivery] = await Promise.all([
      getNearbyVehicles(orderId, shoppers),
      vehicleEtasToShop({
        cacheId: orderId,
        shoppers,
        shop: { latitude: order.shop_latitude, longitude: order.shop_longitude },
        types: BOOKABLE_VEHICLES,
      }),
      hasFreeDeliveryPromo(pool, order),
    ]);

    // Older orders (no vehicle_fees) cost the same for every vehicle
    const options = BOOKABLE_VEHICLES.map((type) => {
      const price = repriceOrder(order, type, { freeDelivery });

      return {
        type,
        deliveryFee: price.deliveryFee,
        totalAmount: price.totalAmount,
        perVehiclePrice: orderFeeFor(order, type) !== null,
        etaSeconds: etas[type]?.seconds ?? null,
        etaEstimated: Boolean(etas[type]?.estimated),
      };
    });

    return res.status(200).json({
      success: true,
      vehicles,
      options,
    });
  } catch (error) {
    console.error('❌ GET NEARBY VEHICLES ERROR:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to load nearby vehicles',
    });
  }
};

module.exports = {

  getCustomerOrders,

  getCustomerOrderById,

  getNearbyShoppersForOrder,

  getNearbyVehiclesForOrder,

  cancelCustomerOrder,
  getCancelPreview,
  getCancelPolicy,

  updateReplacementStatus,

  uploadCustomItemMedia,


  startShopperSearch,
stopShopperSearch,
};