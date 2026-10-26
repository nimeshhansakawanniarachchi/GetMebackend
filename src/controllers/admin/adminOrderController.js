const pool = require('../../config/db');

const {
  ORDER_STATUS_GROUPS,
  FINISHED_STATUSES,
  statusLabel,
} = require('../../utils/orderStatus');

const { readPage, pageMeta } = require('../../utils/pagination');

const { SHOPPER_PAY_SQL } = require('../shopperPay');

const { broadcastOrderChange } = require('../../realtime');
const { reconcileInBackground, refundOrderAmount, owedForOrder } = require('../../payments/paymentService');
const { refreshOrderSettlement } = require('../settlementController');
const { cancelMoney } = require('../../orders/cancelPolicy');

const {
  getOfferHolders,
  notifyOffersWithdrawn,
} = require('../shopperDispatch');

const {
  createShopperNotification,
} = require('../shopperNotificationController');

const toNumber = (value) => (value == null ? null : Number(value));
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const rs = (value) => `Rs ${Number(value || 0).toFixed(2)}`;

// Audit entries for one record (admin_audit_log, phase 26)
const auditFor = async (entityType, entityId) =>
  (
    await pool.query(
      'SELECT * FROM admin_audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT 50',
      [entityType, String(entityId)]
    )
  ).rows.map((row) => ({
    id: Number(row.id),
    at: row.created_at,
    adminName: row.admin_name,
    adminRole: row.admin_role,
    action: row.action,
    summary: row.summary,
  }));

// Everything that happened to an order, oldest first: its own
// timestamps, card charges + refunds, store payments + bills, extra
// item requests, earnings / payouts and admin actions
const orderEvents = ({ order, payments, refunds, storePayments, bills, requests, earning, audit, cancellation }) => {
  const events = [];
  const add = (at, kind, label, detail = null, actor = null) => {
    if (at) events.push({ at, kind, label, detail, actor });
  };

  add(order.created_at, 'order', 'Order placed', `${order.payment_method === 'card' ? 'Card' : 'Cash'} · ${order.delivery_option || 'standard'} delivery`, 'Customer');
  add(order.shopper_search_started_at, 'order', 'Vehicle booked, finding a shopper', order.preferred_vehicle_type ? `Vehicle: ${order.preferred_vehicle_type}` : null, 'Customer');
  add(order.accepted_at, 'order', 'Shopper accepted', order.shopper_name || null, 'Shopper');
  add(order.shopping_started_at, 'order', 'Shopping started', null, 'Shopper');
  add(order.out_for_delivery_at, 'order', 'Out for delivery', null, 'Shopper');
  add(order.arrival_confirmed_at, 'order', 'Shopper arrived at the door', null, 'Shopper');
  add(order.delivery_photo_at, 'proof', 'Delivery photo taken', null, 'Shopper');
  add(order.delivered_at, 'order', 'Delivered (PIN confirmed)', null, 'Shopper');
  add(order.failed_delivery_at, 'order', 'Marked as failed delivery', order.cancel_reason, 'Admin');
  if (cancellation && !cancellation.failed_delivery) {
    add(
      cancellation.created_at,
      'order',
      `Cancelled (was ${statusLabel(cancellation.from_status)})`,
      cancellation.reason_text,
      cancellation.cancelled_by === 'customer' ? 'Customer' : cancellation.cancelled_by === 'admin' ? 'Admin' : 'System'
    );
  }

  payments.forEach((p) => {
    const card = [p.card_brand, p.card_last4 ? `•••• ${p.card_last4}` : null].filter(Boolean).join(' ');
    add(
      p.paid_at || p.created_at,
      'payment',
      `Card ${p.purpose === 'order' ? 'payment' : 'extra charge'} ${p.status}`,
      [rs(p.amount), card, p.status_message].filter(Boolean).join(' · '),
      'PayHere'
    );
  });
  refunds.forEach((r) => add(r.created_at, 'refund', `Refund ${rs(r.amount)}`, r.reason, 'PayHere'));
  storePayments.forEach((s) => add(
    s.created_at, 'bill', `Store paid (${s.shop_name || 'shop'})`,
    `${rs(s.amount_paid)} by ${s.method} · expected ${rs(s.expected_amount)}`, 'Shopper'
  ));
  storePayments.filter((s) => s.reviewed_at).forEach((s) => add(s.reviewed_at, 'bill', `Bill ${s.review_status}`, s.review_note, 'Admin'));
  storePayments.filter((s) => s.reimbursed_at).forEach((s) => add(
    s.reimbursed_at, 'payout', 'Groceries reimbursed', `${rs(s.amount_paid)} · ref ${s.reimbursement_reference || '—'}`, 'Admin'
  ));
  bills.forEach((b) => add(b.bill_uploaded_at, 'bill', 'Bill photo uploaded', b.shop_name || null, 'Shopper'));
  requests.forEach((r) => add(
    r.created_at, 'items', `${r.requested_by === 'customer' ? 'Customer asked for' : 'Shopper suggested'} an extra item`,
    `${r.item_name || 'Item'} · ${r.status}`, r.requested_by === 'customer' ? 'Customer' : 'Shopper'
  ));
  if (earning) {
    add(earning.created_at, 'earning', 'Shopper earnings recorded', `${rs(earning.net_amount)} · ${earning.status}`, 'System');
    add(earning.paid_at, 'payout', 'Shopper earnings paid out', null, 'Admin');
  }
  audit.forEach((a) => add(a.at, 'admin', a.summary || a.action, null, a.adminName ? `Admin · ${a.adminName}` : 'Admin'));

  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
};


// =====================================================
// ORDERS LIST
// GET /api/admin/orders?status=active|delivery|delivered|cancelled|failed
//   &from=YYYY-MM-DD&to=YYYY-MM-DD&search=&page=&pageSize=
//   &method=cash|card&payment=paid|unpaid|partially_refunded|refunded
//   &shopId=&shopperId=&customerId=&sort=newest|oldest|total_desc|total_asc
// =====================================================

// Whitelisted sort orders (never raw input in SQL)
const ORDER_SORTS = {
  newest: 'o.created_at DESC',
  oldest: 'o.created_at ASC',
  total_desc: 'o.total_amount DESC, o.created_at DESC',
  total_asc: 'o.total_amount ASC, o.created_at DESC',
};

const listOrders = async (req, res) => {
  try {
    const paging = readPage(req.query);
    const where = [];
    const params = [];

    const statuses = ORDER_STATUS_GROUPS[req.query.status];

    if (statuses) {
      params.push(statuses);
      where.push(`o.status = ANY($${params.length})`);
    } else if (req.query.status === 'failed') {
      where.push('o.failed_delivery_at IS NOT NULL');
    }

    if (['cash', 'card'].includes(req.query.method)) {
      params.push(req.query.method);
      where.push(`o.payment_method = $${params.length}`);
    }

    if (['paid', 'unpaid', 'partially_refunded', 'refunded'].includes(req.query.payment)) {
      params.push(req.query.payment);
      where.push(`COALESCE(o.payment_status, 'unpaid') = $${params.length}`);
    }

    for (const [key, column] of [['shopperId', 'o.shopper_id'], ['customerId', 'o.customer_id']]) {
      const id = Number(req.query[key]);
      if (Number.isInteger(id) && id > 0) {
        params.push(id);
        where.push(`${column} = $${params.length}`);
      }
    }

    const shopId = Number(req.query.shopId);
    if (Number.isInteger(shopId) && shopId > 0) {
      params.push(shopId);
      where.push(`EXISTS (SELECT 1 FROM order_shops os3 WHERE os3.order_id = o.id AND os3.shop_id = $${params.length})`);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) {
      params.push(req.query.from);
      where.push(`o.created_at >= $${params.length}::date`);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) {
      params.push(req.query.to);
      where.push(`o.created_at < $${params.length}::date + INTERVAL '1 day'`);
    }

    const search = String(req.query.search || '').trim();

    if (search) {
      // "#42" or "42" also matches the order number exactly
      const orderNumber = Number(search.replace(/^#/, ''));

      params.push(Number.isInteger(orderNumber) ? orderNumber : -1);
      const idParam = `$${params.length}`;

      params.push(`%${search.toLowerCase()}%`);
      const like = `$${params.length}`;

      where.push(`(
        o.id = ${idParam}
        OR LOWER(c.full_name) LIKE ${like}
        OR c.mobile LIKE ${like}
        OR LOWER(sh.full_name) LIKE ${like}
        OR EXISTS (
          SELECT 1 FROM order_shops os2
          WHERE os2.order_id = o.id AND LOWER(os2.shop_name) LIKE ${like}
        )
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseFrom = `
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN shoppers sh ON sh.id = o.shopper_id
      ${whereSql}
    `;

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total ${baseFrom}`,
      params
    );

    const listParams = [...params, paging.pageSize, paging.offset];

    const result = await pool.query(
      `
      SELECT
        o.id, o.status, o.total_amount, o.payment_method, o.payment_status,
        o.delivery_option, o.created_at, o.delivered_at, o.failed_delivery_at,
        o.tip_amount, o.getme_fee, o.getme_fee_kept,
        c.full_name AS customer_name, c.mobile AS customer_mobile,
        sh.full_name AS shopper_name,
        (
          SELECT STRING_AGG(os.shop_name, ' + ' ORDER BY os.id)
          FROM order_shops os WHERE os.order_id = o.id
        ) AS shop_names,
        (
          SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id
        ) AS item_count
      ${baseFrom}
      ORDER BY ${ORDER_SORTS[req.query.sort] || ORDER_SORTS.newest}
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.json({
      success: true,
      ...pageMeta(paging, countResult.rows[0].total),
      orders: result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        statusLabel: statusLabel(row.status),
        customerName: row.customer_name || 'Customer',
        customerMobile: row.customer_mobile,
        shopperName: row.shopper_name || null,
        shopNames: row.shop_names || '—',
        itemCount: row.item_count,
        totalAmount: Number(row.total_amount || 0),
        paymentMethod: row.payment_method,
        paymentStatus: row.payment_status || 'unpaid',
        deliveryOption: row.delivery_option,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
        failedDelivery: Boolean(row.failed_delivery_at),
        tipAmount: Number(row.tip_amount || 0),
        getmeFee: Number(row.getme_fee || 0),
        getmeFeeKept: toNumber(row.getme_fee_kept),
      })),
    });
  } catch (error) {
    console.error('❌ admin listOrders error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load orders' });
  }
};


// =====================================================
// ORDER DETAIL
// GET /api/admin/orders/:id
// =====================================================

const getOrder = async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    const orderResult = await pool.query(
      `
      SELECT
        o.*,
        ${SHOPPER_PAY_SQL}::float AS shopper_pay,
        c.full_name AS customer_name, c.mobile AS customer_mobile, c.email AS customer_email,
        sh.full_name AS shopper_name, sh.mobile AS shopper_mobile,
        sh.vehicle_type, sh.vehicle_number
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN shoppers sh ON sh.id = o.shopper_id
      WHERE o.id = $1
      `,
      [orderId]
    );

    const order = orderResult.rows[0];

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const [shopsResult, itemsResult, replacementsResult, billsResult, chatResult] =
      await Promise.all([
        pool.query(
          `
          SELECT os.shop_id, COALESCE(s.shop_name, os.shop_name) AS shop_name,
                 COALESCE(s.image_url, os.shop_image) AS image_url, s.address, s.mobile
          FROM order_shops os
          LEFT JOIN shops s ON s.id = os.shop_id
          WHERE os.order_id = $1
          ORDER BY os.id
          `,
          [orderId]
        ),
        pool.query(
          'SELECT * FROM order_items WHERE order_id = $1 ORDER BY shop_id, id',
          [orderId]
        ),
        pool.query(
          `
          SELECT id, original_item_id, option_number, photo_url, status, created_at
          FROM replacement_items WHERE order_id = $1
          ORDER BY original_item_id, option_number
          `,
          [orderId]
        ),
        pool.query(
          `
          SELECT shop_id, bill_url, bill_uploaded_at, shopping_status
          FROM order_shop_bills WHERE order_id = $1
          ORDER BY id
          `,
          [orderId]
        ),
        pool.query(
          `
          SELECT id, sender_type, message, created_at
          FROM chat_messages WHERE order_id = $1
          ORDER BY created_at ASC
          LIMIT 200
          `,
          [orderId]
        ),
      ]);

    const [paymentsResult, storePaymentsResult, requestsResult, earningResult, ratingResult, netRevenueResult, audit, owed, cancellationResult] =
      await Promise.all([
        pool.query(
          "SELECT * FROM card_payments WHERE order_id = $1 AND purpose IN ('order', 'order_extra') ORDER BY id",
          [orderId]
        ),
        pool.query(
          'SELECT sp.*, s.shop_name FROM store_payments sp LEFT JOIN shops s ON s.id = sp.shop_id WHERE sp.order_id = $1 ORDER BY sp.id',
          [orderId]
        ),
        pool.query('SELECT * FROM order_item_requests WHERE order_id = $1 ORDER BY id', [orderId]),
        pool.query("SELECT * FROM shopper_earnings WHERE order_id = $1 AND status <> 'void'", [orderId]),
        pool.query('SELECT rating, tags, comment, created_at FROM order_ratings WHERE order_id = $1 LIMIT 1', [orderId]),
        pool.query(
          "SELECT amount::float AS amount FROM finance_ledger WHERE order_id = $1 AND entry_type = 'getme_net_revenue' LIMIT 1",
          [orderId]
        ),
        auditFor('order', orderId),
        owedForOrder(pool, order),
        pool.query(
          `SELECT oc.*, a.full_name AS admin_name, c.full_name AS customer_name
           FROM order_cancellations oc
           LEFT JOIN admins a ON oc.cancelled_by = 'admin' AND a.id = oc.actor_id
           LEFT JOIN customers c ON oc.cancelled_by = 'customer' AND c.id = oc.actor_id
           WHERE oc.order_id = $1`,
          [orderId]
        ),
      ]);

    const cancellationRow = cancellationResult.rows[0] || null;

    // Refunds an admin gave (disputes, goodwill) are approved, not owed
    const goodwill = round2(
      (
        await pool.query(
          `SELECT COALESCE(SUM((details->>'amount')::numeric), 0)::float AS total FROM admin_audit_log
           WHERE action = 'order.refund' AND entity_type = 'order' AND entity_id = $1
             AND (details->>'amount') ~ '^[0-9]+(\\.[0-9]+)?$'`,
          [String(orderId)]
        )
      ).rows[0].total
    );

    const paymentIds = paymentsResult.rows.map((row) => row.id);
    const refundsResult = paymentIds.length
      ? await pool.query('SELECT * FROM card_payment_refunds WHERE card_payment_id = ANY($1) ORDER BY id', [paymentIds])
      : { rows: [] };

    const earningRow = earningResult.rows[0] || null;
    const heldByCard = paymentsResult.rows
      .filter((row) => ['paid', 'partially_refunded', 'refunded'].includes(row.status))
      .reduce((sum, row) => sum + Number(row.amount) - Number(row.refunded_amount || 0), 0);
    const collected = round2(heldByCard + Number(earningRow?.cash_collected || 0));

    const replacementsByItem = new Map();

    replacementsResult.rows.forEach((row) => {
      const list = replacementsByItem.get(row.original_item_id) || [];
      list.push({
        id: row.id,
        optionNumber: row.option_number,
        photoUrl: row.photo_url,
        status: row.status,
        createdAt: row.created_at,
      });
      replacementsByItem.set(row.original_item_id, list);
    });

    const billsByShop = new Map(
      billsResult.rows.map((bill) => [bill.shop_id, bill])
    );

    const shops = shopsResult.rows.map((shop) => {
      const bill = billsByShop.get(shop.shop_id);

      return {
        id: shop.shop_id,
        name: shop.shop_name,
        imageUrl: shop.image_url,
        address: shop.address,
        mobile: shop.mobile,
        bill: bill?.bill_url
          ? { url: bill.bill_url, uploadedAt: bill.bill_uploaded_at, status: bill.shopping_status }
          : null,
        items: itemsResult.rows
          .filter((item) => Number(item.shop_id) === Number(shop.shop_id))
          .map((item) => ({
            id: item.id,
            name: item.item_name,
            quantity: Number(item.quantity || 0),
            unit: item.unit,
            price: Number(item.price || 0),
            lineTotal: Number(item.price || 0) * Number(item.quantity || 0),
            custom: item.custom === true,
            details: item.details,
            image: item.image,
            voiceUrl: item.voice_url,
            shoppingStatus: item.shopping_status || 'pending',
            foundQuantity: toNumber(item.found_quantity),
            foundWeight: toNumber(item.found_weight),
            foundWeightUnit: item.found_weight_unit,
            shopperPhotoUrl: item.shopper_photo_url,
            replacements: replacementsByItem.get(item.id) || [],
          })),
      };
    });

    // Timeline from the timestamps the order already records
    const timeline = [
      ['Order placed', order.created_at],
      ['Shopper search started', order.shopper_search_started_at],
      ['Bill uploaded', order.bill_uploaded_at],
      ['Paid', order.paid_at],
      ['Shopper arrived', order.arrival_confirmed_at],
      ['Delivered', order.delivered_at],
    ]
      .filter(([, at]) => at)
      .map(([label, at]) => ({ label, at }))
      .sort((a, b) => new Date(a.at) - new Date(b.at));

    return res.json({
      success: true,
      order: {
        id: order.id,
        status: order.status,
        statusLabel: statusLabel(order.status),
        canCancel: !FINISHED_STATUSES.includes(order.status),
        cancelledBy: order.cancelled_by,
        cancelReason: order.cancel_reason,
        // Cancellation record (phase 28): who, why, from which stage,
        // money position at that moment. Refunds: cardPayments.
        cancellation: cancellationRow
          ? {
              cancelledBy: cancellationRow.cancelled_by,
              actorName: cancellationRow.admin_name || cancellationRow.customer_name || null,
              reasonCode: cancellationRow.reason_code,
              reason: cancellationRow.reason_text,
              fromStatus: cancellationRow.from_status,
              fromStatusLabel: statusLabel(cancellationRow.from_status),
              cancelledAt: cancellationRow.created_at,
              shopperId: cancellationRow.shopper_id,
              itemsBought: Number(cancellationRow.items_bought || 0),
              failedDelivery: cancellationRow.failed_delivery,
              paymentMethod: cancellationRow.payment_method,
              amountHeld: cancellationRow.amount_held === null ? null : Number(cancellationRow.amount_held),
              amountOwed: cancellationRow.amount_owed === null ? null : Number(cancellationRow.amount_owed),
            }
          : order.status === 'cancelled'
            ? {
                // Cancelled before records were kept (phase 28)
                cancelledBy: order.cancelled_by,
                reason: order.cancel_reason,
                fromStatus: order.cancelled_from_status,
                fromStatusLabel: order.cancelled_from_status ? statusLabel(order.cancelled_from_status) : null,
                cancelledAt: order.cancelled_at,
                legacy: true,
              }
            : null,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        customer: {
          id: order.customer_id,
          name: order.customer_name,
          mobile: order.customer_mobile,
          email: order.customer_email,
        },
        shopper: order.shopper_id
          ? {
              id: order.shopper_id,
              name: order.shopper_name,
              mobile: order.shopper_mobile,
              vehicleType: order.vehicle_type,
              vehicleNumber: order.vehicle_number,
            }
          : null,
        delivery: {
          address: order.delivery_address,
          latitude: toNumber(order.delivery_latitude),
          longitude: toNumber(order.delivery_longitude),
          option: order.delivery_option,
          distanceKm: toNumber(order.distance_km),
          scheduledDate: order.scheduled_date,
          scheduledStartTime: order.scheduled_start_time,
          scheduledEndTime: order.scheduled_end_time,
          dropoff: order.delivery_dropoff,
          instructions: order.delivery_instructions,
          contactPhone: order.contact_phone,
        },
        money: {
          itemsTotal: Number(order.items_total || 0),
          actualItemsTotal: toNumber(order.actual_items_total),
          deliveryFee: Number(order.delivery_fee || 0),
          fastDeliveryFee: Number(order.fast_delivery_fee || 0),
          serviceFee: Number(order.service_fee || 0),
          serviceFeePerUnit: Number(order.service_fee_per_unit || 0),
          windowDiscount: Number(order.window_discount || 0),
          discountAmount: Number(order.discount_amount || 0),
          tipAmount: Number(order.tip_amount || 0),
          getmeFee: Number(order.getme_fee || 0),
          getmeFeePercent: Number(order.getme_fee_percent || 0),
          getmeFeeKept: toNumber(order.getme_fee_kept),
          totalAmount: Number(order.total_amount || 0),
          shopperPay: Number(order.shopper_pay || 0),
          failedDeliveryAt: order.failed_delivery_at,
        },
        payment: {
          method: order.payment_method,
          status: order.payment_status || 'unpaid',
          reference: order.payment_id,
          paidAt: order.paid_at,
          reimbursementStatus: order.reimbursement_status,
          reimbursementAmount: toNumber(order.reimbursement_amount),
          reimbursedAt: order.reimbursed_at,
        },
        shops,
        timeline,
        // Full lifecycle (phase 26): order steps, payments, bills,
        // items, earnings and admin actions in one list
        events: orderEvents({
          order,
          payments: paymentsResult.rows,
          refunds: refundsResult.rows,
          storePayments: storePaymentsResult.rows,
          bills: billsResult.rows.map((bill) => ({
            ...bill,
            shop_name: shopsResult.rows.find((shop) => Number(shop.shop_id) === Number(bill.shop_id))?.shop_name,
          })),
          requests: requestsResult.rows,
          earning: earningRow,
          audit,
          cancellation: cancellationRow,
        }),
        deliveryProof: order.delivery_photo_url
          ? { photoUrl: order.delivery_photo_url, takenAt: order.delivery_photo_at }
          : null,
        cardPayments: paymentsResult.rows.map((row) => ({
          id: row.id,
          ref: row.ref,
          purpose: row.purpose,
          amount: Number(row.amount),
          status: row.status,
          statusMessage: row.status_message,
          transactionId: row.gateway_payment_id,
          card: row.card_last4 ? `${row.card_brand || 'Card'} •••• ${row.card_last4}` : null,
          gatewayFee: Number(row.gateway_fee || 0),
          refundedAmount: Number(row.refunded_amount || 0),
          testMode: row.gateway === 'test',
          createdAt: row.created_at,
          paidAt: row.paid_at,
          needsManualRefund: row.status === 'paid' && Boolean(row.abandoned_at),
          refunds: refundsResult.rows
            .filter((refund) => Number(refund.card_payment_id) === Number(row.id))
            .map((refund) => ({
              id: refund.id,
              amount: Number(refund.amount),
              reason: refund.reason,
              refundId: refund.gateway_refund_id,
              createdAt: refund.created_at,
            })),
        })),
        storePayments: storePaymentsResult.rows.map((row) => ({
          id: row.id,
          shopId: row.shop_id,
          shopName: row.shop_name,
          method: row.method,
          amountPaid: Number(row.amount_paid),
          expectedAmount: Number(row.expected_amount),
          variance: Number(row.variance),
          reviewStatus: row.review_status,
          reviewNote: row.review_note,
          reimbursementStatus: row.reimbursement_status,
          reimbursementReference: row.reimbursement_reference,
          reimbursedAt: row.reimbursed_at,
          locked: Boolean(row.locked_at),
          createdAt: row.created_at,
        })),
        itemRequests: requestsResult.rows.map((row) => ({
          id: row.id,
          requestedBy: row.requested_by,
          itemName: row.item_name,
          status: row.status,
          createdAt: row.created_at,
        })),
        earning: earningRow
          ? {
              status: earningRow.status,
              deliveryFee: Number(earningRow.delivery_fee),
              priorityFee: Number(earningRow.priority_fee),
              serviceFee: Number(earningRow.service_fee),
              tip: Number(earningRow.tip),
              adjustment: Number(earningRow.adjustment),
              net: Number(earningRow.net_amount),
              cashCollected: Number(earningRow.cash_collected),
              cashStatus: earningRow.cash_status,
              disputeNote: earningRow.dispute_note,
            }
          : null,
        // What the customer owes vs paid, and what the order left GetMe
        settlement: {
          owed: round2(owed),
          goodwillRefunds: goodwill,
          collected,
          difference: round2(collected - Math.max(0, owed - goodwill)),
          groceryCost: round2(storePaymentsResult.rows.reduce((sum, row) => sum + Number(row.amount_paid), 0)),
          groceriesReimbursable: round2(
            storePaymentsResult.rows
              .filter((row) => ['owed', 'held', 'reimbursed'].includes(row.reimbursement_status))
              .reduce((sum, row) => sum + Number(row.amount_paid), 0)
          ),
          gatewayFees: round2(paymentsResult.rows.reduce((sum, row) => sum + Number(row.gateway_fee || 0), 0)),
          netRevenue: netRevenueResult.rows[0] ? round2(netRevenueResult.rows[0].amount) : null,
        },
        rating: ratingResult.rows[0]
          ? {
              rating: Number(ratingResult.rows[0].rating),
              tags: ratingResult.rows[0].tags,
              comment: ratingResult.rows[0].comment,
              createdAt: ratingResult.rows[0].created_at,
            }
          : null,
        audit,
        chat: chatResult.rows.map((row) => ({
          id: row.id,
          senderType: row.sender_type,
          message: row.message,
          createdAt: row.created_at,
        })),
      },
    });
  } catch (error) {
    console.error('❌ admin getOrder error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load order' });
  }
};


// =====================================================
// CANCEL ORDER
// PATCH /api/admin/orders/:id/cancel { reason, failedDelivery }
// failedDelivery: the shopper reached the customer (out for delivery
// / arrived) but couldn't hand over. The customer then pays the
// groceries bought + delivery fee (+ GetMe fee) and the shopper is
// paid the delivery fee (paymentService.owedForOrder, settlement).
// =====================================================

const DELIVERY_STATUSES = ['out_for_delivery', 'arrived'];

const cancelOrder = async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const reason = String(req.body?.reason || '').trim();
    const failedDelivery = req.body?.failedDelivery === true;

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid order ID' });
    }

    if (reason.length < 3) {
      return res.status(400).json({ success: false, message: 'Enter a reason for cancelling' });
    }

    // Locked so a customer cancel / shopper step can't interleave;
    // the order's status before and the money position are recorded
    const client = await pool.connect();
    let result = { rows: [] };

    try {
      await client.query('BEGIN');

      const before = (
        await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId])
      ).rows[0];

      result = await client.query(
        `
        UPDATE orders
        SET
          status = 'cancelled',
          cancelled_by = 'admin',
          cancel_reason = $2,
          cancel_reason_code = CASE WHEN $4::boolean THEN 'failed_delivery' ELSE 'admin' END,
          cancelled_at = NOW(),
          cancelled_from_status = $6,
          delivery_pin = NULL,
          failed_delivery_at = CASE WHEN $4::boolean THEN NOW() ELSE NULL END,
          updated_at = NOW()
        WHERE id = $1
          AND NOT (status = ANY($3))
          AND (NOT $4::boolean OR (status = ANY($5) AND shopper_id IS NOT NULL))
        RETURNING id, customer_id, shopper_id, status
        `,
        [orderId, reason.slice(0, 500), FINISHED_STATUSES, failedDelivery, DELIVERY_STATUSES, before?.status || null]
      );

      if (result.rows.length > 0) {
        const money = await cancelMoney(client, before);
        const owed = await owedForOrder(client, {
          ...before,
          status: 'cancelled',
          failed_delivery_at: failedDelivery ? new Date() : null,
        });

        await client.query(
          `
          INSERT INTO order_cancellations
            (order_id, cancelled_by, actor_id, reason_code, reason_text, from_status, shopper_id,
             items_bought, failed_delivery, payment_method, amount_held, amount_owed)
          VALUES ($1, 'admin', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (order_id) DO NOTHING
          `,
          [
            orderId,
            req.admin?.adminId || null,
            failedDelivery ? 'failed_delivery' : 'admin',
            reason.slice(0, 500),
            before.status,
            before.shopper_id,
            money.itemsBought,
            failedDelivery,
            before.payment_method,
            money.held,
            owed,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (result.rows.length === 0) {
      return res.status(409).json({
        success: false,
        message: failedDelivery
          ? 'Only an order out for delivery can be marked as a failed delivery'
          : 'This order is already finished and cannot be cancelled',
      });
    }

    const order = result.rows[0];
    const io = req.app.get('io');

    const payload = {
      orderId,
      order_id: orderId,
      status: 'cancelled',
      cancelledBy: 'admin',
      reason,
      failedDelivery,
    };

    if (io) {
      io.to(`order:${orderId}`).emit('order-status-changed', payload);
      io.to(`customer:${order.customer_id}`).emit('order-status-changed', payload);

      if (order.shopper_id) {
        io.to(`shopper:${order.shopper_id}`).emit('order-status-changed', payload);
      }
    }

    broadcastOrderChange(io, orderId, { event: 'order-status-changed', status: 'cancelled' });

    // Paid by saved card: the card gets back all but what the customer
    // still owes (groceries bought; + delivery on a failed delivery)
    reconcileInBackground(orderId, {
      io,
      reason: failedDelivery ? 'Delivery failed' : 'Order cancelled by GetMe',
    });

    // Groceries the shopper already paid for go to reimbursement
    // review; a failed delivery also pays the shopper's delivery fee
    refreshOrderSettlement(orderId, io);

    // Shoppers still holding the offer see it vanish at once
    notifyOffersWithdrawn(io, orderId, await getOfferHolders(orderId), 'cancelled');

    if (order.shopper_id) {
      createShopperNotification({
        io,
        shopperId: order.shopper_id,
        type: 'order_cancelled',
        title: 'Order cancelled',
        body: `GetMe cancelled order #${orderId}: ${reason}`,
        orderId,
      });
    }

    return res.json({
      success: true,
      message: failedDelivery ? 'Marked as a failed delivery' : 'Order cancelled',
    });
  } catch (error) {
    console.error('❌ admin cancelOrder error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to cancel order' });
  }
};

// =====================================================
// REFUND THE CUSTOMER'S CARD
// PATCH /api/admin/orders/:id/refund { amount, reason }
// Disputed deliveries / goodwill; capped at what the card still holds.
// =====================================================

const refundOrder = async (req, res) => {
  const orderId = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim().slice(0, 200);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid order ID' });
  }

  if (reason.length < 3) {
    return res.status(400).json({ success: false, message: 'Enter a reason for the refund' });
  }

  const outcome = await refundOrderAmount(
    orderId,
    req.body?.amount,
    `GetMe order #${orderId}: ${reason}`,
    req.app.get('io')
  );

  if (outcome.error) {
    return res.status(outcome.error.status).json({ success: false, message: outcome.error.message });
  }

  return res.json({
    success: true,
    message: `Rs ${outcome.refunded.toFixed(2)} refunded to the customer's card`,
    refunded: outcome.refunded,
  });
};

module.exports = {
  refundOrder,
  listOrders,
  getOrder,
  cancelOrder,
};
