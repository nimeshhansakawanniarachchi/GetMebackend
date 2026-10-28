const pool = require('../config/db');

const { customerTotals, serviceUnitsSql } = require('../pricing/fees');
const { broadcastOrderChange } = require('../realtime');
const { publicBaseUrl } = require('../payments/payhere');
const {
  extraChargeFor,
  chargeOrderExtra,
  chargeApprovalNeeded,
  chargeApproved,
  syncOrderPaymentColumns,
  refundWholePayment,
  reconcileInBackground,
} = require('../payments/paymentService');
const { createShopperNotification } = require('./shopperNotificationController');

// =====================================================
// SHELF PRICE REPORTS (order_item_price_reports, phase 29)
// While shopping, the shopper reports that an item's shelf price
// differs from the price on the order. Policy (chosen by GetMe):
//
//   shelf LOWER            -> 'lower' / applied: the item is re-priced
//                             and the customer pays less (card orders
//                             get the difference refunded)
//   shelf HIGHER, small    -> 'absorbed': the customer's price stays;
//   (<= max(Rs 20, 5%)     GetMe pays the difference (the store bill
//    per unit)             is expected at the shelf price)
//   shelf HIGHER, bigger   -> 'approval' / pending: the customer
//                             approves the new price (saved card:
//                             402 CARD_CHARGE_REQUIRED first) or
//                             declines and the item is refunded
//
// Only items the shopper hasn't bought yet, while shopping, before
// that store's bill. A pending report blocks the item, that store's
// checkout and delivery (orderItemRequestsController.pendingRequestsBlock).
//
// Socket events (customer:{id}, order:{id}, shopper:{id}):
//   order-price-report          { orderId, report }
//   order-price-report-updated  { orderId, report, totals? }
// =====================================================

const ABSORB_LKR = () => Number(process.env.PRICE_REPORT_ABSORB_LKR ?? 20);
const ABSORB_PERCENT = () => Number(process.env.PRICE_REPORT_ABSORB_PERCENT ?? 5);
const MAX_SHELF_PRICE = 10000000;

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// GetMe absorbs a higher shelf price up to this much per unit
const absorbLimit = (orderUnitPrice) => round2(Math.max(ABSORB_LKR(), (Number(orderUnitPrice) * ABSORB_PERCENT()) / 100));

// What one "unit" of the item's price is
const priceUnitOf = (item) => {
  const unit = String(item.unit || '').toLowerCase();
  if (unit === 'g' || unit === 'kg') return 'kg';
  if (unit === 'ml' || unit === 'l') return 'L';
  return 'item';
};

// Units in one pack (price = unit_price x this)
const packUnitsOf = (item) =>
  Number(item.unit_price) > 0 ? Number(item.price) / Number(item.unit_price) : 1;

const toPublicReport = (row) => ({
  id: Number(row.id),
  orderId: Number(row.order_id),
  orderItemId: Number(row.order_item_id),
  shopId: row.shop_id != null ? Number(row.shop_id) : null,
  productId: row.product_id != null ? Number(row.product_id) : null,
  itemName: row.item_name,
  orderUnitPrice: Number(row.order_unit_price),
  shelfUnitPrice: Number(row.shelf_unit_price),
  priceUnit: row.price_unit,
  outcome: row.outcome,
  status: row.status,
  lineBefore: row.line_before != null ? Number(row.line_before) : null,
  lineAfter: row.line_after != null ? Number(row.line_after) : null,
  difference: row.line_before != null && row.line_after != null ? round2(Number(row.line_after) - Number(row.line_before)) : null,
  getmeAbsorbed: Number(row.getme_absorbed || 0),
  photoUrl: row.photo_url,
  note: row.note,
  respondedAt: row.responded_at,
  adminStatus: row.admin_status,
  adminNote: row.admin_note,
  createdAt: row.created_at,
});

const orderTotals = (order) => ({
  itemsTotal: Number(order.items_total),
  serviceFee: Number(order.service_fee),
  getmeFee: Number(order.getme_fee),
  totalAmount: Number(order.total_amount),
});

const emitReport = (io, order, event, payload) => {
  try {
    if (!io) return;

    const data = { orderId: Number(order.id), order_id: Number(order.id), ...payload };

    io.to(`customer:${order.customer_id}`).emit(event, data);
    io.to(`order:${order.id}`).emit(event, data);
    if (order.shopper_id) io.to(`shopper:${order.shopper_id}`).emit(event, data);

    broadcastOrderChange(io, order.id, { event });
  } catch (error) {
    console.error('❌ PRICE REPORT SOCKET ERROR:', error.message);
  }
};

// Order totals with one line's total changed by `delta` (delivery,
// tip, discounts and the service fee stay; the GetMe fee follows)
const totalsWithDelta = (order, delta) => {
  const itemsTotal = round2(Number(order.items_total || 0) + delta);
  const totals = customerTotals({
    itemsTotal,
    deliveryFee: order.delivery_fee,
    fastFee: order.fast_delivery_fee,
    serviceFee: order.service_fee,
    discount: order.discount_amount,
    windowDiscount: order.window_discount,
    tip: order.tip_amount,
    percent: order.getme_fee_percent ?? 15,
  });

  return { itemsTotal, getmeFee: totals.getmeFee, totalAmount: totals.totalAmount };
};

// Re-prices the item to the shelf price and the order totals with it
const repriceItem = async (client, order, item, shelfUnit) => {
  const newPack = round2(shelfUnit * packUnitsOf(item));
  const quantity = Number(item.quantity) || 1;
  const delta = round2(newPack * quantity - Number(item.price) * quantity);
  const totals = totalsWithDelta(order, delta);

  await client.query(
    `
    UPDATE order_items
    SET unit_price = $2, price = $3, shelf_unit_price = $2, line_total = $4
    WHERE id = $1
    `,
    [item.id, shelfUnit, newPack, round2(newPack * quantity)]
  );

  return (
    await client.query(
      'UPDATE orders SET items_total = $2, getme_fee = $3, total_amount = $4, updated_at = NOW() WHERE id = $1 RETURNING *',
      [order.id, totals.itemsTotal, totals.getmeFee, totals.totalAmount]
    )
  ).rows[0];
};

// Transaction; a card charge taken inside is refunded on rollback
const inTransaction = async (req, work) => {
  const client = await pool.connect();
  const state = { payment: null };

  try {
    await client.query('BEGIN');
    const result = await work(client, state);
    await client.query(result?.commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (state.payment) {
      await refundWholePayment(state.payment.id, 'Price change was not saved', req.app.get('io'));
    }

    throw error;
  } finally {
    client.release();
  }
};

const sendError = (res, error, fallback) => {
  console.error(`❌ ${fallback}:`, error?.message || error);
  return res.status(500).json({ success: false, message: fallback });
};

const listFor = async (orderId) =>
  (await pool.query('SELECT * FROM order_item_price_reports WHERE order_id = $1 ORDER BY id', [orderId])).rows.map(toPublicReport);

// Pending reports on an order (or one store of it): they block checkout
const pendingPriceReports = async (orderId, shopId = null, client = pool) =>
  (
    await client.query(
      `
      SELECT COUNT(*)::int AS count FROM order_item_price_reports
      WHERE order_id = $1 AND status = 'pending' AND ($2::int IS NULL OR shop_id = $2::int)
      `,
      [orderId, shopId]
    )
  ).rows[0].count;

const itemHasPendingReport = async (orderItemId, client = pool) =>
  (
    await client.query("SELECT 1 FROM order_item_price_reports WHERE order_item_id = $1 AND status = 'pending'", [orderItemId])
  ).rows.length > 0;

// =====================================================
// SHOPPER
// =====================================================

const shopperIdOf = (req) => Number(req.shopper?.shopperId ?? req.shopper?.id);

// GET /api/shopper/orders/:orderId/price-reports
const shopperListReports = async (req, res) => {
  const orderId = toId(req.params.orderId);

  try {
    const owns = await pool.query('SELECT 1 FROM orders WHERE id = $1 AND shopper_id = $2', [orderId, shopperIdOf(req)]);

    if (owns.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    return res.json({ success: true, reports: await listFor(orderId) });
  } catch (error) {
    return sendError(res, error, 'Unable to load price reports');
  }
};

// POST /api/shopper/orders/:orderId/items/:itemId/price-report
// multipart: shelfPrice (per item / kg / L, like the order's unit
// price), note?, photo? (the shelf tag)
const shopperReportPrice = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const itemId = toId(req.params.itemId);
  const shelfPrice = round2(Number(String(req.body?.shelfPrice ?? '').replace(/,/g, '')));
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 300) || null : null;
  const photoUrl = req.file?.path ? `/uploads/${req.file.path.replace(/\\/g, '/').split('uploads/').pop()}` : null;

  if (!orderId || !itemId) {
    return res.status(400).json({ success: false, message: 'Invalid item' });
  }

  if (!(shelfPrice > 0 && shelfPrice <= MAX_SHELF_PRICE)) {
    return res.status(400).json({ success: false, message: 'Enter the price on the shelf (above Rs 0)' });
  }

  try {
    const outcome = await inTransaction(req, async (client) => {
      const order = (
        await client.query('SELECT * FROM orders WHERE id = $1 AND shopper_id = $2 FOR UPDATE', [orderId, shopperIdOf(req)])
      ).rows[0];

      if (!order) return { status: 404, body: { success: false, message: 'Order not found' } };

      if (order.status !== 'shopping') {
        return { status: 409, body: { success: false, message: 'Prices can only be reported while shopping' } };
      }

      const item = (
        await client.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [itemId, orderId])
      ).rows[0];

      if (!item) return { status: 404, body: { success: false, message: 'Item not found' } };

      if (item.custom || !(Number(item.unit_price) > 0)) {
        return { status: 409, body: { success: false, message: 'Custom items are priced from the bill. No report needed.' } };
      }

      if ((item.shopping_status || 'pending') !== 'pending') {
        return { status: 409, body: { success: false, message: 'Report the price before you mark the item found' } };
      }

      if (await itemHasPendingReport(item.id, client)) {
        return { status: 409, body: { success: false, code: 'PRICE_REPORT_PENDING', message: 'The customer is still answering the last price report for this item' } };
      }

      const billed = await client.query(
        `
        SELECT 1 FROM order_shop_bills
        WHERE order_id = $1 AND shop_id = $2 AND (bill_url IS NOT NULL OR bill_uploaded_at IS NOT NULL)
        UNION
        SELECT 1 FROM store_payments WHERE order_id = $1 AND shop_id = $2
        `,
        [orderId, item.shop_id]
      );

      if (billed.rows.length > 0) {
        return { status: 409, body: { success: false, message: 'This store is already checked out' } };
      }

      const orderUnit = Number(item.unit_price);

      if (Math.abs(shelfPrice - orderUnit) < 0.005) {
        return { status: 400, body: { success: false, message: 'That is the same as the order price' } };
      }

      const quantity = Number(item.quantity) || 1;
      const lineBefore = round2(Number(item.price) * quantity);
      const lineAtShelf = round2(round2(shelfPrice * packUnitsOf(item)) * quantity);

      let outcomeKind;
      if (shelfPrice < orderUnit) outcomeKind = 'lower';
      else if (shelfPrice - orderUnit <= absorbLimit(orderUnit)) outcomeKind = 'absorbed';
      else outcomeKind = 'approval';

      const status = { lower: 'applied', absorbed: 'absorbed', approval: 'pending' }[outcomeKind];

      let updatedOrder = order;

      if (outcomeKind === 'lower') {
        updatedOrder = await repriceItem(client, order, item, shelfPrice);
      } else if (outcomeKind === 'absorbed') {
        // Customer keeps the order price; the store bill is checked
        // against the shelf price (storePaymentController)
        await client.query('UPDATE order_items SET shelf_unit_price = $2 WHERE id = $1', [item.id, shelfPrice]);
      }

      const report = (
        await client.query(
          `
          INSERT INTO order_item_price_reports (
            order_id, order_item_id, shop_id, shopper_id, product_id, item_name,
            order_unit_price, shelf_unit_price, price_unit, outcome, status,
            line_before, line_after, getme_absorbed, photo_url, note
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          RETURNING *
          `,
          [
            orderId,
            item.id,
            item.shop_id,
            order.shopper_id,
            item.product_id,
            String(item.item_name || 'Item').slice(0, 200),
            orderUnit,
            shelfPrice,
            priceUnitOf(item),
            outcomeKind,
            status,
            lineBefore,
            outcomeKind === 'absorbed' ? lineBefore : lineAtShelf,
            outcomeKind === 'absorbed' ? round2(lineAtShelf - lineBefore) : 0,
            photoUrl,
            note,
          ]
        )
      ).rows[0];

      const messages = {
        lower: `Cheaper on the shelf: the customer now pays Rs ${(lineAtShelf).toFixed(2)} for this item (was Rs ${lineBefore.toFixed(2)})`,
        absorbed: `Small difference: buy it. GetMe covers the extra Rs ${round2(lineAtShelf - lineBefore).toFixed(2)}`,
        approval: 'Sent to the customer. Wait for their answer before buying this item.',
      };

      return { commit: true, order: updatedOrder, report, status: 201, body: { success: true, message: messages[outcomeKind] } };
    });

    if (outcome.commit) {
      const io = req.app.get('io');
      const report = toPublicReport(outcome.report);

      emitReport(io, outcome.order, 'order-price-report', {
        report,
        totals: report.outcome === 'lower' ? orderTotals(outcome.order) : undefined,
      });

      // Lower total: card orders get the difference back
      if (report.outcome === 'lower') reconcileInBackground(outcome.order.id, { io });

      outcome.body.report = report;
      outcome.body.totals = orderTotals(outcome.order);
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return sendError(res, error, 'Could not save the price');
  }
};

// POST /api/shopper/orders/:orderId/price-reports/:reportId/cancel
// (only while the customer hasn't answered)
const shopperCancelReport = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const reportId = toId(req.params.reportId);

  try {
    const result = await pool.query(
      `
      UPDATE order_item_price_reports r
      SET status = 'cancelled', updated_at = NOW()
      FROM orders o
      WHERE r.id = $1 AND r.order_id = $2 AND o.id = r.order_id AND o.shopper_id = $3 AND r.status = 'pending'
      RETURNING r.*, o.customer_id, o.shopper_id AS order_shopper_id
      `,
      [reportId, orderId, shopperIdOf(req)]
    );

    if (result.rows.length === 0) {
      return res.status(409).json({ success: false, message: 'This report was already answered or does not exist' });
    }

    const row = result.rows[0];
    emitReport(req.app.get('io'), { id: orderId, customer_id: row.customer_id, shopper_id: row.order_shopper_id }, 'order-price-report-updated', {
      report: toPublicReport(row),
    });

    return res.json({ success: true, message: 'Price report withdrawn', report: toPublicReport(row) });
  } catch (error) {
    return sendError(res, error, 'Could not withdraw the report');
  }
};

// =====================================================
// CUSTOMER
// =====================================================

// GET /api/customer/orders/:orderId/price-reports
const customerListReports = async (req, res) => {
  const orderId = toId(req.params.orderId);

  try {
    const owns = await pool.query('SELECT 1 FROM orders WHERE id = $1 AND customer_id = $2', [orderId, req.customer.customerId]);

    if (owns.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    return res.json({ success: true, reports: await listFor(orderId) });
  } catch (error) {
    return sendError(res, error, 'Unable to load price changes');
  }
};

// POST /api/customer/orders/:orderId/price-reports/:reportId/approve
//      { authorizeCharge } (saved card: 402 CARD_CHARGE_REQUIRED until it matches)
// POST /api/customer/orders/:orderId/price-reports/:reportId/decline
//      -> the item is refunded
const customerAnswer = (action) => async (req, res) => {
  const orderId = toId(req.params.orderId);
  const reportId = toId(req.params.reportId);

  if (!orderId || !reportId) {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }

  try {
    const outcome = await inTransaction(req, async (client, state) => {
      const order = (
        await client.query('SELECT * FROM orders WHERE id = $1 AND customer_id = $2 FOR UPDATE', [orderId, req.customer.customerId])
      ).rows[0];

      if (!order) return { status: 404, body: { success: false, message: 'Order not found' } };

      const report = (
        await client.query('SELECT * FROM order_item_price_reports WHERE id = $1 AND order_id = $2 FOR UPDATE', [reportId, orderId])
      ).rows[0];

      if (!report) return { status: 404, body: { success: false, message: 'Price change not found' } };

      if (report.status !== 'pending') {
        return { status: 409, body: { success: false, message: 'This price change was already answered', report: toPublicReport(report) } };
      }

      const item = (
        await client.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE', [report.order_item_id, orderId])
      ).rows[0];

      if (action === 'decline') {
        // Not bought: refunded like any unavailable item (line + its
        // service fee, with the GetMe fee on both)
        await client.query(
          `
          UPDATE order_items
          SET shopping_status = 'refunded', found_quantity = 0, refunded_at = NOW(), completed_at = NOW(),
            refund_amount = ROUND(
              (COALESCE(order_items.price, 0) * COALESCE(order_items.quantity, 1)
               + $2::numeric * ${serviceUnitsSql('order_items')}) * (1 + $3::numeric / 100), 2)
          WHERE id = $1 AND COALESCE(shopping_status, 'pending') = 'pending'
          `,
          [item.id, Number(order.service_fee_per_unit ?? 50), Number(order.getme_fee_percent ?? 15)]
        );

        const declined = (
          await client.query(
            "UPDATE order_item_price_reports SET status = 'declined', responded_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *",
            [reportId]
          )
        ).rows[0];

        return { commit: true, order, report: declined, refunded: true, status: 200, body: { success: true, message: `${report.item_name} won't be bought. You get a refund for it.` } };
      }

      if (order.status !== 'shopping') {
        return { status: 409, body: { success: false, message: 'Shopping has finished, so this can no longer change' } };
      }

      const newPack = round2(Number(report.shelf_unit_price) * packUnitsOf(item));
      const delta = round2((newPack - Number(item.price)) * (Number(item.quantity) || 1));
      const totals = totalsWithDelta(order, delta);
      const charge = await extraChargeFor(client, order, totals.totalAmount);

      if (charge.extra > 0 && !chargeApproved(req.body, charge)) {
        return { reply: () => chargeApprovalNeeded(res, charge, `The new price of ${report.item_name}`) };
      }

      if (charge.cardPaid && charge.extra > 0.009) {
        const paid = await chargeOrderExtra({
          order,
          charge,
          items: `GetMe order #${order.id} - ${report.item_name} price change`,
          baseUrl: publicBaseUrl(req),
          io: req.app.get('io'),
        });

        if (paid.error) {
          return { status: paid.error.status || 402, body: { success: false, code: paid.error.code, message: paid.error.message } };
        }

        state.payment = paid.row;
      }

      const updatedOrder = await repriceItem(client, order, item, Number(report.shelf_unit_price));

      if (charge.cardPaid) await syncOrderPaymentColumns(client, order.id);

      const approved = (
        await client.query(
          `
          UPDATE order_item_price_reports
          SET status = 'approved', approved_charge = $2, responded_at = NOW(), updated_at = NOW()
          WHERE id = $1 RETURNING *
          `,
          [reportId, charge.cardPaid ? charge.extra : null]
        )
      ).rows[0];

      return {
        commit: true,
        order: updatedOrder,
        report: approved,
        status: 200,
        body: { success: true, message: `Approved. ${report.item_name} will be bought at the new price.`, totals: orderTotals(updatedOrder) },
      };
    });

    if (outcome.reply) return outcome.reply();

    if (outcome.commit) {
      const io = req.app.get('io');
      const report = toPublicReport(outcome.report);

      emitReport(io, outcome.order, 'order-price-report-updated', { report, totals: orderTotals(outcome.order) });

      createShopperNotification({
        io,
        shopperId: outcome.order.shopper_id,
        type: 'price_report',
        title: action === 'approve' ? 'Customer approved the new price' : 'Customer declined the new price',
        body: action === 'approve'
          ? `Buy ${report.itemName} at Rs ${report.shelfUnitPrice.toFixed(2)}`
          : `Don't buy ${report.itemName}. It was refunded.`,
        orderId: outcome.order.id,
      });

      // A refunded item lowers what the card should hold
      if (outcome.refunded) reconcileInBackground(outcome.order.id, { io });

      outcome.body.report = report;
    }

    return res.status(outcome.status).json(outcome.body);
  } catch (error) {
    return sendError(res, error, 'Could not answer the price change');
  }
};

module.exports = {
  ABSORB_LKR,
  ABSORB_PERCENT,
  absorbLimit,
  toPublicReport,
  pendingPriceReports,
  itemHasPendingReport,
  shopperListReports,
  shopperReportPrice,
  shopperCancelReport,
  customerListReports,
  customerApproveReport: customerAnswer('approve'),
  customerDeclineReport: customerAnswer('decline'),
};
