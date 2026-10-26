const pool = require('../../config/db');

const { ORDER_STATUS_GROUPS, statusLabel } = require('../../utils/orderStatus');
const { readPage, pageMeta } = require('../../utils/pagination');
const { SHOPPER_PAY_SQL } = require('../shopperPay');
const { shopperBalances } = require('../settlementController');
const { deliveryAreaOf } = require('../../utils/offerDetails');

// =====================================================
// ADMIN OPERATIONS (read-only views for the operations platform)
//   GET /api/admin/overview?days=7|30|90
//   GET /api/admin/operations/live
//   GET /api/admin/issues
//   GET /api/admin/search?q=
//   GET /api/admin/shoppers/:id
//   GET /api/admin/shops/:id
//   GET /api/admin/audit-log?adminId=&entityType=&entityId=&action=&page=
// Every number comes from the database. Money follows the GetMe fee
// model (settlementController / finance_ledger): the customer pays
// a GetMe fee line, the shopper keeps every fee + 100% of the tip,
// groceries are reimbursed separately.
// =====================================================

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const num = (value) => (value == null ? null : Number(value));
const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Operational thresholds (minutes); .env can override
const envMinutes = (key, fallback) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const thresholds = () => ({
  unassignedMinutes: envMinutes('OPS_UNASSIGNED_MINUTES', 10),
  staleLocationMinutes: envMinutes('OPS_STALE_LOCATION_MINUTES', 10),
  lateGraceMinutes: envMinutes('OPS_LATE_GRACE_MINUTES', 10),
  reimbursementOverdueDays: envMinutes('OPS_REIMBURSEMENT_OVERDUE_DAYS', 3),
  payoutOverdueDays: envMinutes('OPS_PAYOUT_OVERDUE_DAYS', 7),
  cashOverdueDays: envMinutes('OPS_CASH_OVERDUE_DAYS', 2),
});

const ACTIVE = [...ORDER_STATUS_GROUPS.active, ...ORDER_STATUS_GROUPS.delivery];
const IN_PROGRESS = ['shopper_accepted', 'shopping', 'out_for_delivery', 'arrived'];

// When the order is due at the door: the slot end for scheduled
// orders, else booking time + the longest estimate quoted
const EXPECTED_BY_SQL = `(
  CASE
    WHEN o.delivery_option = 'scheduled' AND o.scheduled_date IS NOT NULL
         AND o.scheduled_end_time ~ '^[0-9]{1,2}:[0-9]{2}$'
      THEN (o.scheduled_date + o.scheduled_end_time::time)::timestamp
    WHEN o.estimated_delivery_max_minutes IS NOT NULL
      THEN COALESCE(o.shopper_search_started_at, o.created_at)
           + make_interval(mins => o.estimated_delivery_max_minutes)
    ELSE NULL
  END
)`;

// When the order entered its current status (recorded timestamps only)
const STATUS_SINCE_SQL = `COALESCE(
  CASE o.status
    WHEN 'waiting_for_shopper' THEN o.shopper_search_started_at
    WHEN 'shopper_accepted' THEN o.accepted_at
    WHEN 'shopping' THEN o.shopping_started_at
    WHEN 'out_for_delivery' THEN o.out_for_delivery_at
    WHEN 'arrived' THEN o.arrival_confirmed_at
    WHEN 'delivered' THEN o.delivered_at
    ELSE NULL
  END,
  o.created_at
)`;

const minutesSince = (column) => `(EXTRACT(EPOCH FROM (NOW() - ${column})) / 60)::int`;

const parseDays = (value) => ([7, 30, 90].includes(Number(value)) ? Number(value) : 30);

// =====================================================
// OVERVIEW (operations dashboard)
// =====================================================

const getOverview = async (req, res) => {
  try {
    const days = parseDays(req.query.days);
    const since = `date_trunc('day', NOW()) - INTERVAL '${days - 1} days'`;

    const [orders, people, ledger, liabilities, series, loss, issues] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int AS today,
          COUNT(*) FILTER (WHERE created_at >= ${since})::int AS period,
          COUNT(*) FILTER (WHERE status = 'pending_shopper_search')::int AS placed,
          COUNT(*) FILTER (WHERE status = 'waiting_for_shopper')::int AS awaiting_shopper,
          COUNT(*) FILTER (WHERE status = 'shopper_accepted')::int AS assigned,
          COUNT(*) FILTER (WHERE status = 'shopping')::int AS shopping,
          COUNT(*) FILTER (WHERE status IN ('out_for_delivery', 'arrived'))::int AS out_for_delivery,
          COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
          COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at >= date_trunc('day', NOW()))::int AS delivered_today,
          COUNT(*) FILTER (WHERE status = 'delivered' AND delivered_at >= ${since})::int AS delivered_period,
          COUNT(*) FILTER (WHERE status IN ('cancelled', 'shopper_search_cancelled'))::int AS cancelled,
          COUNT(*) FILTER (WHERE status IN ('cancelled', 'shopper_search_cancelled') AND created_at >= ${since})::int AS cancelled_period,
          COUNT(*) FILTER (WHERE failed_delivery_at IS NOT NULL)::int AS failed_deliveries,
          COUNT(*) FILTER (WHERE failed_delivery_at >= ${since})::int AS failed_period,
          COUNT(*) FILTER (
            WHERE delivery_option = 'scheduled' AND status = ANY($1) AND scheduled_date >= CURRENT_DATE
          )::int AS scheduled_upcoming
        FROM orders
        `,
        [ACTIVE]
      ),
      pool.query(
        `
        SELECT
          (SELECT COUNT(*)::int FROM customers) AS customers,
          (SELECT COUNT(*)::int FROM customers WHERE created_at >= ${since}) AS customers_new,
          (SELECT COUNT(*)::int FROM shoppers WHERE approval_status = 'approved') AS shoppers_approved,
          (SELECT COUNT(*)::int FROM shoppers WHERE approval_status = 'pending') AS shoppers_pending,
          (SELECT COUNT(*)::int FROM shoppers WHERE status = 'online' AND approval_status = 'approved') AS shoppers_online,
          (
            SELECT COUNT(DISTINCT o.shopper_id)::int FROM orders o
            WHERE o.status = ANY($1) AND o.shopper_id IS NOT NULL
          ) AS shoppers_busy,
          (SELECT COUNT(*)::int FROM shops WHERE status = 'approved') AS shops_approved,
          (SELECT COUNT(*)::int FROM shops WHERE status = 'approved' AND is_open IS TRUE) AS shops_open,
          (SELECT COUNT(*)::int FROM shops WHERE status = 'pending') AS shops_pending
        `,
        [IN_PROGRESS]
      ),
      // Money movements in the period, by category (finance_ledger)
      pool.query(
        `
        SELECT entry_type, COALESCE(SUM(amount), 0)::float AS total, COUNT(*)::int AS entries
        FROM finance_ledger
        WHERE entry_at >= ${since}
        GROUP BY entry_type
        `
      ),
      // What GetMe owes / is owed right now
      pool.query(
        `
        SELECT
          (SELECT COALESCE(SUM(net_amount), 0)::float FROM shopper_earnings WHERE status = 'awaiting_bills') AS earnings_awaiting,
          (SELECT COALESCE(SUM(net_amount), 0)::float FROM shopper_earnings WHERE status = 'payable') AS earnings_payable,
          (SELECT COALESCE(SUM(net_amount), 0)::float FROM shopper_earnings WHERE status = 'held') AS earnings_held,
          (SELECT COALESCE(SUM(amount_paid), 0)::float FROM store_payments WHERE reimbursement_status = 'pending') AS reimbursement_pending,
          (SELECT COALESCE(SUM(amount_paid), 0)::float FROM store_payments WHERE reimbursement_status = 'owed') AS reimbursement_owed,
          (SELECT COALESCE(SUM(amount_paid), 0)::float FROM store_payments WHERE reimbursement_status = 'held') AS reimbursement_held,
          (SELECT COALESCE(SUM(cash_collected), 0)::float FROM shopper_earnings WHERE cash_status = 'due') AS cash_due
        `
      ),
      pool.query(
        `
        SELECT
          to_char(day, 'YYYY-MM-DD') AS date,
          (SELECT COUNT(*)::int FROM orders o WHERE o.created_at >= day AND o.created_at < day + INTERVAL '1 day') AS placed,
          (SELECT COUNT(*)::int FROM orders o WHERE o.status = 'delivered' AND o.delivered_at >= day AND o.delivered_at < day + INTERVAL '1 day') AS delivered,
          (
            SELECT COUNT(*)::int FROM orders o
            WHERE o.status IN ('cancelled', 'shopper_search_cancelled')
              AND o.created_at >= day AND o.created_at < day + INTERVAL '1 day'
          ) AS cancelled,
          (
            SELECT COALESCE(SUM(o.total_amount), 0)::float FROM orders o
            WHERE o.status = 'delivered' AND o.delivered_at >= day AND o.delivered_at < day + INTERVAL '1 day'
          ) AS order_value,
          (
            SELECT COALESCE(SUM(o.getme_fee_kept), 0)::float FROM orders o
            WHERE o.status = 'delivered' AND o.delivered_at >= day AND o.delivered_at < day + INTERVAL '1 day'
          ) AS commission,
          (
            SELECT COALESCE(SUM(l.amount), 0)::float FROM finance_ledger l
            WHERE l.entry_type = 'getme_net_revenue' AND l.entry_at >= day AND l.entry_at < day + INTERVAL '1 day'
          ) AS net_revenue
        FROM generate_series(${since}, date_trunc('day', NOW()), INTERVAL '1 day') AS day
        ORDER BY day
        `
      ),
      // Settled orders where the money collected didn't cover the costs
      pool.query(
        `
        SELECT COUNT(*)::int AS orders, COALESCE(SUM(amount), 0)::float AS amount
        FROM finance_ledger
        WHERE entry_type = 'getme_net_revenue' AND amount < 0 AND entry_at >= ${since}
        `
      ),
      computeIssues(),
    ]);

    const o = orders.rows[0];
    const p = people.rows[0];
    const byType = Object.fromEntries(ledger.rows.map((row) => [row.entry_type, row.total]));
    const l = liabilities.rows[0];
    const sum = (type) => round2(byType[type] || 0);

    // Company money is for owner / finance / operations (reports
    // roles); support sees operations figures only
    const showMoney = ['owner', 'finance', 'operations'].includes(req.admin?.role);
    const cardPayments = sum('customer_payment');
    const refunds = sum('customer_refund');
    const cashCollected = sum('cash_collected');

    return res.json({
      success: true,
      days,
      generatedAt: new Date().toISOString(),
      orders: {
        total: o.total,
        today: o.today,
        period: o.period,
        placed: o.placed,
        awaitingShopper: o.awaiting_shopper,
        assigned: o.assigned,
        shopping: o.shopping,
        outForDelivery: o.out_for_delivery,
        delivered: o.delivered,
        deliveredToday: o.delivered_today,
        deliveredPeriod: o.delivered_period,
        cancelled: o.cancelled,
        cancelledPeriod: o.cancelled_period,
        failedDeliveries: o.failed_deliveries,
        failedPeriod: o.failed_period,
        scheduledUpcoming: o.scheduled_upcoming,
      },
      people: {
        customers: p.customers,
        customersNew: p.customers_new,
        shoppersApproved: p.shoppers_approved,
        shoppersPending: p.shoppers_pending,
        shoppersOnline: p.shoppers_online,
        shoppersBusy: p.shoppers_busy,
        shopsApproved: p.shops_approved,
        shopsOpen: p.shops_open,
        shopsPending: p.shops_pending,
      },
      // Period money, from the ledger (same source as the Ledger page)
      finance: !showMoney ? null : {
        orderValue: round2(series.rows.reduce((total, day) => total + day.order_value, 0)),
        cardPayments,
        refunds,
        cashCollected,
        customerPaymentsNet: round2(cardPayments - refunds + cashCollected),
        groceryCost: sum('grocery_expense'),
        groceryReimbursable: sum('grocery_reimbursement'),
        deliveryFees: sum('delivery_fee'),
        priorityFees: sum('priority_fee'),
        serviceFees: sum('service_fee'),
        tips: sum('tip'),
        adjustments: sum('adjustment'),
        shopperEarnings: round2(sum('delivery_fee') + sum('priority_fee') + sum('service_fee') + sum('tip') + sum('adjustment')),
        commission: sum('commission'),
        gatewayFees: sum('gateway_fee'),
        netRevenue: sum('getme_net_revenue'),
        shopperPayouts: sum('shopper_payout'),
        reimbursementPayouts: sum('reimbursement_payout'),
        cashDeposits: sum('cash_deposit'),
        lossOrders: loss.rows[0].orders,
        lossAmount: round2(loss.rows[0].amount),
      },
      liabilities: !showMoney ? null : {
        earningsAwaitingBills: round2(l.earnings_awaiting),
        earningsPayable: round2(l.earnings_payable),
        earningsHeld: round2(l.earnings_held),
        reimbursementPending: round2(l.reimbursement_pending),
        reimbursementOwed: round2(l.reimbursement_owed),
        reimbursementHeld: round2(l.reimbursement_held),
        cashDueFromShoppers: round2(l.cash_due),
      },
      series: series.rows.map((row) => ({
        date: row.date,
        placed: row.placed,
        delivered: row.delivered,
        cancelled: row.cancelled,
        orderValue: round2(row.order_value),
        commission: round2(row.commission),
        netRevenue: round2(row.net_revenue),
      })),
      issues: summarizeIssues(visibleIssues(issues, req.admin?.role)),
      moneyVisible: showMoney,
    });
  } catch (error) {
    console.error('❌ admin getOverview error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the overview' });
  }
};

// =====================================================
// LIVE OPERATIONS
// Real positions only: a shopper without a recorded position (or an
// old one) is flagged, never placed on the map from a guess.
// =====================================================

const getLiveOperations = async (req, res) => {
  try {
    const limits = thresholds();

    const [shoppersResult, ordersResult, shopsResult, allShopsResult, offersResult] = await Promise.all([
      pool.query(
        `
        SELECT
          s.id, s.full_name, s.mobile, s.status, s.vehicle_type, s.vehicle_number,
          s.latitude::float AS latitude, s.longitude::float AS longitude,
          s.location_updated_at, s.profile_image_url,
          CASE WHEN s.location_updated_at IS NULL THEN NULL
               ELSE ${minutesSince('s.location_updated_at')} END AS location_age,
          COALESCE(
            ARRAY_AGG(o.id ORDER BY o.id) FILTER (WHERE o.id IS NOT NULL), '{}'
          ) AS active_order_ids
        FROM shoppers s
        LEFT JOIN orders o ON o.shopper_id = s.id AND o.status = ANY($1)
        WHERE s.approval_status = 'approved'
          AND (s.status = 'online' OR o.id IS NOT NULL)
        GROUP BY s.id
        ORDER BY s.full_name
        `,
        [IN_PROGRESS]
      ),
      pool.query(
        `
        SELECT
          o.id, o.status, o.created_at, o.delivery_option, o.payment_method,
          o.delivery_address, o.delivery_latitude::float AS delivery_latitude,
          o.delivery_longitude::float AS delivery_longitude,
          o.scheduled_date, o.scheduled_start_time, o.scheduled_end_time,
          o.preferred_vehicle_type, o.total_amount::float AS total_amount,
          o.shopper_id, sh.full_name AS shopper_name, sh.mobile AS shopper_mobile,
          o.customer_id, c.full_name AS customer_name,
          ${STATUS_SINCE_SQL} AS status_since,
          ${minutesSince(STATUS_SINCE_SQL)} AS minutes_in_status,
          ${minutesSince('o.created_at')} AS age_minutes,
          ${EXPECTED_BY_SQL} AS expected_by,
          CASE WHEN ${EXPECTED_BY_SQL} IS NULL THEN NULL
               ELSE (EXTRACT(EPOCH FROM (${EXPECTED_BY_SQL} - NOW())) / 60)::int END AS minutes_to_due,
          (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS items,
          (
            SELECT COUNT(*)::int FROM order_items oi
            WHERE oi.order_id = o.id
              AND COALESCE(oi.shopping_status, 'pending') NOT IN ('pending', '')
          ) AS items_done
        FROM orders o
        LEFT JOIN shoppers sh ON sh.id = o.shopper_id
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.status = ANY($1)
        ORDER BY o.created_at
        `,
        [ACTIVE]
      ),
      pool.query(
        `
        SELECT os.order_id, o.status AS order_status, s.id, COALESCE(s.shop_name, os.shop_name) AS name,
               s.latitude::float AS latitude, s.longitude::float AS longitude, s.image_url
        FROM order_shops os
        JOIN orders o ON o.id = os.order_id AND o.status = ANY($1)
        LEFT JOIN shops s ON s.id = os.shop_id
        ORDER BY os.id
        `,
        [ACTIVE]
      ),
      // Every approved shop with a position, for the map (photo pins;
      // shops with active orders are highlighted)
      pool.query(
        `
        SELECT id, shop_name, area, address, image_url, is_open,
               latitude::float AS latitude, longitude::float AS longitude
        FROM shops
        WHERE status = 'approved' AND latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY shop_name
        `
      ),
      // Who holds the offer of each order still finding a shopper
      pool.query(
        `
        SELECT so.order_id, sh.id, sh.full_name, so.first_seen_at
        FROM shopper_order_offers so
        JOIN orders o ON o.id = so.order_id AND o.status = 'waiting_for_shopper'
        JOIN shoppers sh ON sh.id = so.shopper_id
        WHERE so.dismissed_at IS NULL
        ORDER BY so.first_seen_at
        `
      ),
    ]);

    const offeredByOrder = new Map();
    offersResult.rows.forEach((row) => {
      const list = offeredByOrder.get(row.order_id) || [];
      list.push({ id: row.id, name: row.full_name, since: row.first_seen_at });
      offeredByOrder.set(row.order_id, list);
    });

    const shopsByOrder = new Map();
    const activeByShop = new Map(); // shop id -> [{ orderId, status }]
    shopsResult.rows.forEach((row) => {
      const list = shopsByOrder.get(row.order_id) || [];
      list.push({ id: row.id, name: row.name, latitude: row.latitude, longitude: row.longitude, imageUrl: row.image_url || null });
      shopsByOrder.set(row.order_id, list);

      if (row.id != null) {
        const active = activeByShop.get(row.id) || [];
        active.push({ orderId: row.order_id, status: row.order_status });
        activeByShop.set(row.id, active);
      }
    });

    const mapShops = allShopsResult.rows.map((row) => {
      const active = activeByShop.get(row.id) || [];

      return {
        id: row.id,
        name: row.shop_name,
        area: row.area,
        address: row.address || null,
        imageUrl: row.image_url || null,
        isOpen: row.is_open === true,
        position: { latitude: row.latitude, longitude: row.longitude },
        activeOrderIds: active.map((a) => Number(a.orderId)),
        // Orders still looking for a shopper (needs action soonest)
        waitingOrderIds: active.filter((a) => a.status === 'waiting_for_shopper').map((a) => Number(a.orderId)),
      };
    });

    const shoppers = shoppersResult.rows.map((row) => {
      const hasPosition = Number.isFinite(row.latitude) && Number.isFinite(row.longitude);
      const stale = row.location_age == null || row.location_age > limits.staleLocationMinutes;

      return {
        id: row.id,
        name: row.full_name,
        mobile: row.mobile,
        online: row.status === 'online',
        vehicleType: row.vehicle_type,
        vehicleNumber: row.vehicle_number,
        photoUrl: row.profile_image_url,
        position: hasPosition ? { latitude: row.latitude, longitude: row.longitude } : null,
        locationUpdatedAt: row.location_updated_at,
        locationAgeMinutes: row.location_age,
        locationStale: hasPosition ? stale : true,
        activeOrderIds: row.active_order_ids.map(Number),
        busy: row.active_order_ids.length > 0,
      };
    });

    const orders = ordersResult.rows.map((row) => {
      const unassigned = row.status === 'waiting_for_shopper';
      const late = row.minutes_to_due != null && row.minutes_to_due < -limits.lateGraceMinutes;
      const flags = [];

      if (unassigned && row.minutes_in_status > limits.unassignedMinutes) flags.push('unassigned_too_long');
      if (late) flags.push('late');

      return {
        id: row.id,
        status: row.status,
        statusLabel: statusLabel(row.status),
        createdAt: row.created_at,
        statusSince: row.status_since,
        minutesInStatus: row.minutes_in_status,
        ageMinutes: row.age_minutes,
        deliveryOption: row.delivery_option,
        scheduled: row.delivery_option === 'scheduled'
          ? { date: row.scheduled_date, start: row.scheduled_start_time, end: row.scheduled_end_time }
          : null,
        expectedBy: row.expected_by,
        minutesToDue: row.minutes_to_due,
        paymentMethod: row.payment_method,
        totalAmount: round2(row.total_amount),
        preferredVehicle: row.preferred_vehicle_type,
        customerId: row.customer_id,
        customerName: row.customer_name || 'Customer',
        address: row.delivery_address,
        deliveryArea: deliveryAreaOf(row.delivery_address),
        // Shoppers currently holding the offer (finding-shopper orders)
        offeredTo: offeredByOrder.get(row.id) || [],
        destination: Number.isFinite(row.delivery_latitude) && Number.isFinite(row.delivery_longitude)
          ? { latitude: row.delivery_latitude, longitude: row.delivery_longitude }
          : null,
        shopper: row.shopper_id ? { id: row.shopper_id, name: row.shopper_name, mobile: row.shopper_mobile } : null,
        shops: shopsByOrder.get(row.id) || [],
        items: row.items,
        itemsDone: row.items_done,
        flags,
      };
    });

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      thresholds: limits,
      summary: {
        shoppersOnline: shoppers.filter((s) => s.online).length,
        shoppersBusy: shoppers.filter((s) => s.busy).length,
        shoppersWithoutPosition: shoppers.filter((s) => !s.position || s.locationStale).length,
        activeOrders: orders.length,
        unassigned: orders.filter((o) => o.status === 'waiting_for_shopper').length,
        unassignedTooLong: orders.filter((o) => o.flags.includes('unassigned_too_long')).length,
        late: orders.filter((o) => o.flags.includes('late')).length,
        shopsWithOrders: mapShops.filter((s) => s.activeOrderIds.length > 0).length,
      },
      shoppers,
      orders,
      shops: mapShops,
    });
  } catch (error) {
    console.error('❌ admin getLiveOperations error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load live operations' });
  }
};

// =====================================================
// ISSUES (problems the system can detect)
// severity: critical | high | medium | low
// =====================================================

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const computeIssues = async () => {
  const limits = thresholds();

  const [
    lateRefunds,
    failedPayments,
    stuck,
    staleLocations,
    billReviews,
    missingBills,
    reimbursements,
    payable,
    held,
    cashDue,
    lossOrders,
    mismatches,
    approvals,
  ] = await Promise.all([
    // PayHere confirmed a charge we had given up on, and the automatic
    // refund did not go through (money held with no order)
    pool.query(
      `
      SELECT id, ref, order_id, amount::float AS amount, updated_at
      FROM card_payments
      WHERE status = 'paid' AND abandoned_at IS NOT NULL
      ORDER BY updated_at DESC LIMIT 50
      `
    ),
    pool.query(
      `
      SELECT cp.id, cp.order_id, cp.amount::float AS amount, cp.status_message, cp.created_at, o.status AS order_status
      FROM card_payments cp
      LEFT JOIN orders o ON o.id = cp.order_id
      WHERE cp.status = 'failed' AND cp.purpose IN ('order', 'order_extra')
        AND cp.created_at >= NOW() - INTERVAL '2 days'
        AND COALESCE(o.payment_status, 'unpaid') NOT IN ('paid', 'partially_refunded')
        AND COALESCE(o.status, '') NOT IN ('cancelled', 'shopper_search_cancelled')
      ORDER BY cp.created_at DESC LIMIT 50
      `
    ),
    pool.query(
      `
      SELECT o.id, o.status, ${STATUS_SINCE_SQL} AS since,
             ${minutesSince(STATUS_SINCE_SQL)} AS minutes,
             CASE WHEN ${EXPECTED_BY_SQL} IS NULL THEN NULL
                  ELSE (EXTRACT(EPOCH FROM (NOW() - ${EXPECTED_BY_SQL})) / 60)::int END AS minutes_late
      FROM orders o
      WHERE o.status = ANY($1)
      `,
      [ACTIVE]
    ),
    pool.query(
      `
      SELECT DISTINCT s.id, s.full_name, s.location_updated_at,
             CASE WHEN s.location_updated_at IS NULL THEN NULL
                  ELSE ${minutesSince('s.location_updated_at')} END AS age
      FROM shoppers s
      JOIN orders o ON o.shopper_id = s.id AND o.status IN ('out_for_delivery', 'arrived')
      WHERE s.location_updated_at IS NULL OR s.location_updated_at < NOW() - make_interval(mins => $1::int)
      `,
      [limits.staleLocationMinutes]
    ),
    pool.query(
      `
      SELECT sp.id, sp.order_id, sp.review_status, sp.variance::float AS variance, sp.updated_at, s.shop_name
      FROM store_payments sp LEFT JOIN shops s ON s.id = sp.shop_id
      WHERE sp.review_status IN ('needs_review', 'queried')
      ORDER BY sp.updated_at
      `
    ),
    pool.query(
      `
      SELECT se.order_id, se.net_amount::float AS amount, se.created_at, sh.full_name
      FROM shopper_earnings se LEFT JOIN shoppers sh ON sh.id = se.shopper_id
      WHERE se.status = 'awaiting_bills'
      ORDER BY se.created_at
      `
    ),
    pool.query(
      `
      SELECT sp.id, sp.order_id, sp.amount_paid::float AS amount, sp.reimbursement_status, sp.updated_at, sh.full_name
      FROM store_payments sp LEFT JOIN shoppers sh ON sh.id = sp.shopper_id
      WHERE (sp.reimbursement_status = 'owed' AND sp.updated_at < NOW() - make_interval(days => $1::int))
         OR sp.reimbursement_status = 'held'
      ORDER BY sp.updated_at
      `,
      [limits.reimbursementOverdueDays]
    ),
    pool.query(
      `
      SELECT se.shopper_id, sh.full_name, COUNT(*)::int AS orders, SUM(se.net_amount)::float AS amount, MIN(se.updated_at) AS since
      FROM shopper_earnings se LEFT JOIN shoppers sh ON sh.id = se.shopper_id
      WHERE se.status = 'payable' AND se.updated_at < NOW() - make_interval(days => $1::int)
      GROUP BY se.shopper_id, sh.full_name
      `,
      [limits.payoutOverdueDays]
    ),
    pool.query(
      `
      SELECT se.order_id, se.net_amount::float AS amount, se.dispute_note, se.updated_at
      FROM shopper_earnings se WHERE se.status = 'held'
      ORDER BY se.updated_at
      `
    ),
    pool.query(
      `
      SELECT se.shopper_id, sh.full_name, SUM(se.cash_collected)::float AS amount, MIN(se.created_at) AS since
      FROM shopper_earnings se LEFT JOIN shoppers sh ON sh.id = se.shopper_id
      WHERE se.cash_status = 'due' AND se.created_at < NOW() - make_interval(days => $1::int)
      GROUP BY se.shopper_id, sh.full_name
      `,
      [limits.cashOverdueDays]
    ),
    pool.query(
      `
      SELECT order_id, amount::float AS amount, entry_at
      FROM finance_ledger
      WHERE entry_type = 'getme_net_revenue' AND amount < 0 AND entry_at >= NOW() - INTERVAL '30 days'
      ORDER BY entry_at DESC LIMIT 50
      `
    ),
    // Delivered card orders: card money held vs what the customer owes
    // (total less refunded items, paymentService.owedForOrder)
    pool.query(
      `
      SELECT o.id, o.delivered_at,
             GREATEST(0, o.total_amount - COALESCE(r.refunds, 0) - (
        SELECT COALESCE(SUM((a.details->>'amount')::numeric), 0) FROM admin_audit_log a
        WHERE a.action = 'order.refund' AND a.entity_type = 'order' AND a.entity_id = (o.id)::text
          AND (a.details->>'amount') ~ '^[0-9]+(\.[0-9]+)?$'
      ))::float AS owed,
             COALESCE(p.net, 0)::float AS held
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT SUM(refund_amount) AS refunds FROM order_items
        WHERE order_id = o.id AND shopping_status = 'refunded'
      ) r ON TRUE
      LEFT JOIN LATERAL (
        SELECT SUM(amount - refunded_amount) AS net FROM card_payments
        WHERE order_id = o.id AND purpose IN ('order', 'order_extra')
          AND status IN ('paid', 'partially_refunded', 'refunded')
      ) p ON TRUE
      WHERE o.status = 'delivered' AND o.payment_method = 'card'
        AND COALESCE(p.net, 0) < o.total_amount - COALESCE(r.refunds, 0) - (
        SELECT COALESCE(SUM((a.details->>'amount')::numeric), 0) FROM admin_audit_log a
        WHERE a.action = 'order.refund' AND a.entity_type = 'order' AND a.entity_id = (o.id)::text
          AND (a.details->>'amount') ~ '^[0-9]+(\.[0-9]+)?$'
      ) - 0.01
      ORDER BY o.delivered_at DESC LIMIT 50
      `
    ),
    pool.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM shops WHERE status = 'pending') AS shops,
        (SELECT COUNT(*)::int FROM shoppers WHERE approval_status = 'pending') AS shoppers
      `
    ),
  ]);

  const issues = [];
  const add = (issue) => issues.push(issue);
  const money = (value) => `Rs ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  lateRefunds.rows.forEach((row) => add({
    key: `late-refund-${row.id}`, type: 'refund_failed', severity: 'critical', category: 'payments',
    title: `Card charge ${row.ref} needs a manual refund`,
    detail: `PayHere confirmed ${money(row.amount)} after the app was told the payment failed, and the automatic refund did not go through.`,
    entity: row.order_id ? { type: 'order', id: Number(row.order_id) } : null, at: row.updated_at, amount: row.amount,
  }));

  mismatches.rows.forEach((row) => add({
    key: `underpaid-${row.id}`, type: 'payment_mismatch', severity: 'high', category: 'payments',
    title: `Order #${row.id} delivered with ${money(row.owed - row.held)} not collected`,
    detail: `The customer owes ${money(row.owed)} but the card holds ${money(row.held)}.`,
    entity: { type: 'order', id: row.id }, at: row.delivered_at, amount: round2(row.owed - row.held),
  }));

  lossOrders.rows.forEach((row) => add({
    key: `loss-${row.order_id}`, type: 'insufficient_funds', severity: 'high', category: 'finance',
    title: `Order #${row.order_id} cost GetMe ${money(-row.amount)}`,
    detail: 'Money collected from the customer did not cover groceries, shopper earnings and gateway fees.',
    entity: { type: 'order', id: Number(row.order_id) }, at: row.entry_at, amount: row.amount,
  }));

  stuck.rows.forEach((row) => {
    if (row.status === 'waiting_for_shopper' && row.minutes > limits.unassignedMinutes) {
      add({
        key: `unassigned-${row.id}`, type: 'unassigned', severity: row.minutes > limits.unassignedMinutes * 3 ? 'high' : 'medium',
        category: 'operations',
        title: `Order #${row.id} has no shopper after ${row.minutes} min`,
        detail: 'Still searching for a shopper.',
        entity: { type: 'order', id: row.id }, at: row.since,
      });
    }

    if (row.minutes_late != null && row.minutes_late > limits.lateGraceMinutes) {
      add({
        key: `late-${row.id}`, type: 'delayed', severity: row.minutes_late > 60 ? 'high' : 'medium', category: 'operations',
        title: `Order #${row.id} is ${row.minutes_late} min past its delivery time`,
        detail: `Currently ${statusLabel(row.status).toLowerCase()}.`,
        entity: { type: 'order', id: row.id }, at: row.since,
      });
    }
  });

  failedPayments.rows.forEach((row) => add({
    key: `failed-${row.id}`, type: 'payment_failed', severity: 'medium', category: 'payments',
    title: `Card payment of ${money(row.amount)} declined${row.order_id ? ` for order #${row.order_id}` : ''}`,
    detail: row.status_message || 'The customer has not paid yet.',
    entity: row.order_id ? { type: 'order', id: Number(row.order_id) } : null, at: row.created_at, amount: row.amount,
  }));

  staleLocations.rows.forEach((row) => add({
    key: `stale-${row.id}`, type: 'location_stale', severity: 'medium', category: 'operations',
    title: `${row.full_name || `Shopper #${row.id}`} is delivering without a recent location`,
    detail: row.age == null ? 'The app has never sent a position.' : `Last position ${row.age} min ago.`,
    entity: { type: 'shopper', id: row.id }, at: row.location_updated_at,
  }));

  billReviews.rows.forEach((row) => add({
    key: `bill-${row.id}`, type: 'bill_review', severity: 'medium', category: 'bills',
    title: `${row.review_status === 'queried' ? 'Queried' : 'Unchecked'} bill for order #${row.order_id}${row.shop_name ? ` (${row.shop_name})` : ''}`,
    detail: `Till amount differs from the expected cost by ${money(row.variance)}.`,
    entity: { type: 'order', id: Number(row.order_id) }, link: '/store-bills?status=review', at: row.updated_at, amount: row.variance,
  }));

  missingBills.rows.forEach((row) => add({
    key: `nobill-${row.order_id}`, type: 'bill_missing', severity: 'medium', category: 'bills',
    title: `Order #${row.order_id} delivered but bills not verified`,
    detail: `${row.full_name || 'The shopper'}'s earnings of ${money(row.amount)} wait for every store bill to be uploaded and approved.`,
    entity: { type: 'order', id: Number(row.order_id) }, at: row.created_at, amount: row.amount,
  }));

  reimbursements.rows.forEach((row) => add({
    key: `reimb-${row.id}`, type: row.reimbursement_status === 'held' ? 'reimbursement_held' : 'reimbursement_overdue',
    severity: 'medium', category: 'payouts',
    title: row.reimbursement_status === 'held'
      ? `Reimbursement of ${money(row.amount)} on hold (order #${row.order_id})`
      : `${row.full_name || 'Shopper'} waiting for ${money(row.amount)} grocery reimbursement`,
    detail: row.reimbursement_status === 'held' ? 'The bill is under review.' : `Owed for more than ${limits.reimbursementOverdueDays} days.`,
    entity: { type: 'order', id: Number(row.order_id) }, link: '/settlements', at: row.updated_at, amount: row.amount,
  }));

  payable.rows.forEach((row) => add({
    key: `payable-${row.shopper_id}`, type: 'payout_overdue', severity: 'low', category: 'payouts',
    title: `${row.full_name || 'Shopper'} has ${money(row.amount)} earnings unpaid`,
    detail: `${row.orders} order${row.orders === 1 ? '' : 's'} payable for more than ${limits.payoutOverdueDays} days.`,
    entity: { type: 'shopper', id: Number(row.shopper_id) }, link: '/settlements', at: row.since, amount: row.amount,
  }));

  held.rows.forEach((row) => add({
    key: `held-${row.order_id}`, type: 'earnings_held', severity: 'medium', category: 'payouts',
    title: `Earnings on hold for order #${row.order_id}`,
    detail: row.dispute_note || 'Disputed earnings.',
    entity: { type: 'order', id: Number(row.order_id) }, link: '/settlements', at: row.updated_at, amount: row.amount,
  }));

  cashDue.rows.forEach((row) => add({
    key: `cash-${row.shopper_id}`, type: 'cash_overdue', severity: 'high', category: 'payouts',
    title: `${row.full_name || 'Shopper'} holds ${money(row.amount)} cash for GetMe`,
    detail: `Cash collected more than ${limits.cashOverdueDays} days ago has not been deposited.`,
    entity: { type: 'shopper', id: Number(row.shopper_id) }, link: '/settlements', at: row.since, amount: row.amount,
  }));

  const pending = approvals.rows[0];
  if (pending.shoppers > 0) {
    add({
      key: 'approvals-shoppers', type: 'approval', severity: 'low', category: 'approvals',
      title: `${pending.shoppers} shopper application${pending.shoppers === 1 ? '' : 's'} to review`,
      detail: 'New shoppers cannot go online until approved.', link: '/shoppers?approval=pending', entity: null, at: null,
    });
  }
  if (pending.shops > 0) {
    add({
      key: 'approvals-shops', type: 'approval', severity: 'low', category: 'approvals',
      title: `${pending.shops} shop application${pending.shops === 1 ? '' : 's'} to review`,
      detail: 'Pending shops are hidden from customers.', link: '/shops?status=pending', entity: null, at: null,
    });
  }

  return issues.sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    new Date(a.at || 0) - new Date(b.at || 0)
  );
};

// Support staff don't see company finance or shopper payout problems
const visibleIssues = (issues, role) =>
  role === 'support' ? issues.filter((i) => !['finance', 'payouts'].includes(i.category)) : issues;

const summarizeIssues = (issues) => ({
  total: issues.length,
  critical: issues.filter((i) => i.severity === 'critical').length,
  high: issues.filter((i) => i.severity === 'high').length,
  medium: issues.filter((i) => i.severity === 'medium').length,
  low: issues.filter((i) => i.severity === 'low').length,
  top: issues.slice(0, 5),
});

const getIssues = async (req, res) => {
  try {
    const issues = visibleIssues(await computeIssues(), req.admin?.role);

    return res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      thresholds: thresholds(),
      summary: summarizeIssues(issues),
      issues,
    });
  } catch (error) {
    console.error('❌ admin getIssues error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load issues' });
  }
};

// =====================================================
// GLOBAL SEARCH
// =====================================================

const search = async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);

  if (q.length < 1) {
    return res.json({ success: true, q, orders: [], customers: [], shoppers: [], shops: [] });
  }

  try {
    const like = `%${q.toLowerCase()}%`;
    const orderId = Number(q.replace(/^#/, ''));
    const id = Number.isInteger(orderId) && orderId > 0 ? orderId : -1;

    const [orders, customers, shoppers, shops] = await Promise.all([
      pool.query(
        `
        SELECT o.id, o.status, o.total_amount::float AS total_amount, o.created_at, c.full_name AS customer_name
        FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1 OR LOWER(c.full_name) LIKE $2 OR c.mobile LIKE $2
        ORDER BY (o.id = $1) DESC, o.created_at DESC LIMIT 6
        `,
        [id, like]
      ),
      pool.query(
        `
        SELECT id, full_name, mobile, email FROM customers
        WHERE id = $1 OR LOWER(full_name) LIKE $2 OR mobile LIKE $2 OR LOWER(email) LIKE $2
        ORDER BY full_name LIMIT 5
        `,
        [id, like]
      ),
      pool.query(
        `
        SELECT id, full_name, mobile, approval_status, status FROM shoppers
        WHERE id = $1 OR LOWER(full_name) LIKE $2 OR mobile LIKE $2 OR LOWER(email) LIKE $2
          OR LOWER(COALESCE(vehicle_number, '')) LIKE $2
        ORDER BY full_name LIMIT 5
        `,
        [id, like]
      ),
      pool.query(
        `
        SELECT id, shop_name, area, status FROM shops
        WHERE id = $1 OR LOWER(shop_name) LIKE $2 OR LOWER(COALESCE(area, '')) LIKE $2
        ORDER BY shop_name LIMIT 5
        `,
        [id, like]
      ),
    ]);

    return res.json({
      success: true,
      q,
      orders: orders.rows.map((row) => ({
        id: row.id, status: row.status, statusLabel: statusLabel(row.status),
        totalAmount: row.total_amount, customerName: row.customer_name, createdAt: row.created_at,
      })),
      customers: customers.rows.map((row) => ({ id: row.id, name: row.full_name, mobile: row.mobile, email: row.email })),
      shoppers: shoppers.rows.map((row) => ({
        id: row.id, name: row.full_name, mobile: row.mobile, approvalStatus: row.approval_status, online: row.status === 'online',
      })),
      shops: shops.rows.map((row) => ({ id: row.id, name: row.shop_name, area: row.area, status: row.status })),
    });
  } catch (error) {
    console.error('❌ admin search error:', error.message);
    return res.status(500).json({ success: false, message: 'Search failed' });
  }
};

// =====================================================
// AUDIT ENTRIES (helper) + AUDIT LOG PAGE
// =====================================================

const toAudit = (row) => ({
  id: Number(row.id),
  at: row.created_at,
  adminId: row.admin_id,
  adminName: row.admin_name,
  adminRole: row.admin_role,
  action: row.action,
  entityType: row.entity_type,
  entityId: row.entity_id,
  summary: row.summary,
  details: row.details,
  ip: row.ip,
});

const auditFor = async (entityType, entityId, limit = 50) =>
  (
    await pool.query(
      'SELECT * FROM admin_audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at DESC LIMIT $3',
      [entityType, String(entityId), limit]
    )
  ).rows.map(toAudit);

const getAuditLog = async (req, res) => {
  try {
    const paging = readPage(req.query, 50);
    const where = [];
    const params = [];

    if (toId(req.query.adminId)) {
      params.push(toId(req.query.adminId));
      where.push(`admin_id = $${params.length}`);
    }

    if (/^[a-z_]{2,30}$/.test(String(req.query.entityType || ''))) {
      params.push(req.query.entityType);
      where.push(`entity_type = $${params.length}`);
    }

    if (req.query.entityId) {
      params.push(String(req.query.entityId).slice(0, 40));
      where.push(`entity_id = $${params.length}`);
    }

    if (req.query.action) {
      params.push(`${String(req.query.action).slice(0, 60)}%`);
      where.push(`action LIKE $${params.length}`);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) {
      params.push(req.query.from);
      where.push(`created_at >= $${params.length}::date`);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')) {
      params.push(req.query.to);
      where.push(`created_at < $${params.length}::date + INTERVAL '1 day'`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [count, rows, admins] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM admin_audit_log ${whereSql}`, params),
      pool.query(
        `SELECT * FROM admin_audit_log ${whereSql} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, paging.pageSize, paging.offset]
      ),
      pool.query('SELECT id, full_name FROM admins ORDER BY full_name'),
    ]);

    return res.json({
      success: true,
      ...pageMeta(paging, count.rows[0].total),
      admins: admins.rows.map((row) => ({ id: row.id, name: row.full_name })),
      entries: rows.rows.map(toAudit),
    });
  } catch (error) {
    console.error('❌ admin getAuditLog error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the audit log' });
  }
};

// =====================================================
// SHOPPER DETAIL
// =====================================================

const getShopper = async (req, res) => {
  const shopperId = toId(req.params.id);

  if (!shopperId) {
    return res.status(400).json({ success: false, message: 'Invalid shopper ID' });
  }

  try {
    const shopper = (
      await pool.query(
        `
        SELECT id, full_name, mobile, email, status, approval_status, vehicle_type, vehicle_number,
               latitude::float AS latitude, longitude::float AS longitude, location_updated_at,
               profile_image_url, created_at, updated_at
        FROM shoppers WHERE id = $1
        `,
        [shopperId]
      )
    ).rows[0];

    if (!shopper) {
      return res.status(404).json({ success: false, message: 'Shopper not found' });
    }

    const [stats, orders, earnings, payouts, storePayments, ratings, balances, audit] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::int AS orders,
          COUNT(*) FILTER (WHERE o.status = 'delivered')::int AS delivered,
          COUNT(*) FILTER (WHERE o.status = ANY($2))::int AS active,
          COUNT(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE o.failed_delivery_at IS NOT NULL)::int AS failed_deliveries,
          AVG(EXTRACT(EPOCH FROM (o.delivered_at - COALESCE(o.accepted_at, o.shopper_search_started_at, o.created_at))) / 60)
            FILTER (WHERE o.status = 'delivered')::float AS avg_fulfil_minutes,
          COUNT(*) FILTER (WHERE o.status = 'delivered' AND ${EXPECTED_BY_SQL} IS NOT NULL)::int AS timed,
          COUNT(*) FILTER (WHERE o.status = 'delivered' AND o.delivered_at <= ${EXPECTED_BY_SQL})::int AS on_time,
          COALESCE(SUM(o.tip_amount) FILTER (WHERE o.status = 'delivered'), 0)::float AS tips,
          (
            SELECT COUNT(*)::int FROM order_items oi JOIN orders o2 ON o2.id = oi.order_id
            WHERE o2.shopper_id = $1 AND oi.shopping_status = 'refunded'
          ) AS refunded_items,
          (
            SELECT COUNT(*)::int FROM order_items oi JOIN orders o2 ON o2.id = oi.order_id
            WHERE o2.shopper_id = $1
          ) AS items
        FROM orders o WHERE o.shopper_id = $1
        `,
        [shopperId, IN_PROGRESS]
      ),
      pool.query(
        `
        SELECT o.id, o.status, o.created_at, o.delivered_at, o.total_amount::float AS total_amount,
               o.payment_method, ${SHOPPER_PAY_SQL}::float AS shopper_pay, c.full_name AS customer_name,
               (SELECT STRING_AGG(os.shop_name, ' + ' ORDER BY os.id) FROM order_shops os WHERE os.order_id = o.id) AS shop_names
        FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.shopper_id = $1
        ORDER BY o.created_at DESC LIMIT 50
        `,
        [shopperId]
      ),
      pool.query(
        `
        SELECT order_id, status, delivery_fee::float AS delivery_fee, priority_fee::float AS priority_fee,
               service_fee::float AS service_fee, tip::float AS tip, adjustment::float AS adjustment,
               net_amount::float AS net_amount, cash_collected::float AS cash_collected, cash_status,
               dispute_note, adjustment_note, created_at, paid_at
        FROM shopper_earnings WHERE shopper_id = $1
        ORDER BY created_at DESC LIMIT 50
        `,
        [shopperId]
      ),
      pool.query(
        `
        SELECT p.id, p.kind, p.amount::float AS amount, p.reference, p.note, p.created_at, a.full_name AS created_by
        FROM shopper_payouts p LEFT JOIN admins a ON a.id = p.created_by
        WHERE p.shopper_id = $1 ORDER BY p.created_at DESC LIMIT 50
        `,
        [shopperId]
      ),
      pool.query(
        `
        SELECT sp.id, sp.order_id, sp.shop_id, s.shop_name, sp.method, sp.amount_paid::float AS amount_paid,
               sp.expected_amount::float AS expected_amount, sp.variance::float AS variance,
               sp.review_status, sp.reimbursement_status, sp.locked_at, sp.created_at,
               b.bill_url, b.bill_urls
        FROM store_payments sp
        LEFT JOIN shops s ON s.id = sp.shop_id
        LEFT JOIN LATERAL (
          SELECT bill_url, bill_urls FROM order_shop_bills
          WHERE order_id = sp.order_id AND shop_id = sp.shop_id ORDER BY id DESC LIMIT 1
        ) b ON TRUE
        WHERE sp.shopper_id = $1 ORDER BY sp.created_at DESC LIMIT 50
        `,
        [shopperId]
      ),
      pool.query(
        `
        SELECT AVG(rating)::float AS average, COUNT(*)::int AS count,
               COALESCE(json_agg(json_build_object('orderId', order_id, 'rating', rating, 'comment', comment, 'tags', tags, 'at', created_at)
                 ORDER BY created_at DESC) FILTER (WHERE comment IS NOT NULL AND comment <> ''), '[]') AS comments
        FROM order_ratings WHERE shopper_id = $1
        `,
        [shopperId]
      ),
      shopperBalances(shopperId),
      auditFor('shopper', shopperId),
    ]);

    const s = stats.rows[0];
    const r = ratings.rows[0];

    return res.json({
      success: true,
      shopper: {
        id: shopper.id,
        fullName: shopper.full_name,
        mobile: shopper.mobile,
        email: shopper.email,
        online: shopper.status === 'online',
        approvalStatus: shopper.approval_status,
        vehicleType: shopper.vehicle_type,
        vehicleNumber: shopper.vehicle_number,
        photoUrl: shopper.profile_image_url,
        position: Number.isFinite(shopper.latitude) && Number.isFinite(shopper.longitude)
          ? { latitude: shopper.latitude, longitude: shopper.longitude }
          : null,
        locationUpdatedAt: shopper.location_updated_at,
        createdAt: shopper.created_at,
        lastSeenAt: shopper.updated_at,
      },
      performance: {
        orders: s.orders,
        delivered: s.delivered,
        active: s.active,
        cancelled: s.cancelled,
        failedDeliveries: s.failed_deliveries,
        avgFulfilMinutes: s.avg_fulfil_minutes != null ? Math.round(s.avg_fulfil_minutes) : null,
        onTimeRate: s.timed ? s.on_time / s.timed : null,
        timedDeliveries: s.timed,
        refundedItemRate: s.items ? s.refunded_items / s.items : null,
        refundedItems: s.refunded_items,
        tips: round2(s.tips),
        rating: r.count ? { average: round2(r.average), count: r.count } : null,
      },
      balances,
      orders: orders.rows.map((row) => ({
        id: row.id, status: row.status, statusLabel: statusLabel(row.status), createdAt: row.created_at,
        deliveredAt: row.delivered_at, totalAmount: row.total_amount, paymentMethod: row.payment_method,
        shopperPay: row.shopper_pay, customerName: row.customer_name, shopNames: row.shop_names || '—',
      })),
      earnings: earnings.rows.map((row) => ({
        orderId: row.order_id, status: row.status, deliveryFee: row.delivery_fee, priorityFee: row.priority_fee,
        serviceFee: row.service_fee, tip: row.tip, adjustment: row.adjustment, net: row.net_amount,
        cashCollected: row.cash_collected, cashStatus: row.cash_status, disputeNote: row.dispute_note,
        adjustmentNote: row.adjustment_note, createdAt: row.created_at, paidAt: row.paid_at,
      })),
      payouts: payouts.rows.map((row) => ({
        id: row.id, kind: row.kind, amount: row.amount, reference: row.reference, note: row.note,
        createdAt: row.created_at, createdBy: row.created_by,
      })),
      storePayments: storePayments.rows.map((row) => ({
        id: row.id, orderId: row.order_id, shopId: row.shop_id, shopName: row.shop_name, method: row.method,
        amountPaid: row.amount_paid, expectedAmount: row.expected_amount, variance: row.variance,
        reviewStatus: row.review_status, reimbursementStatus: row.reimbursement_status, locked: Boolean(row.locked_at),
        createdAt: row.created_at,
        bills: Array.isArray(row.bill_urls) && row.bill_urls.length ? row.bill_urls : row.bill_url ? [row.bill_url] : [],
      })),
      ratingComments: (r.comments || []).slice(0, 20),
      audit,
    });
  } catch (error) {
    console.error('❌ admin getShopper error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the shopper' });
  }
};

// =====================================================
// SHOP DETAIL
// =====================================================

const getShop = async (req, res) => {
  const shopId = toId(req.params.id);

  if (!shopId) {
    return res.status(400).json({ success: false, message: 'Invalid shop ID' });
  }

  try {
    const shop = (
      await pool.query(
        `
        SELECT id, shop_name, email, mobile, address, area, status, is_open, image_url, brand_color,
               latitude::float AS latitude, longitude::float AS longitude, created_at, updated_at
        FROM shops WHERE id = $1
        `,
        [shopId]
      )
    ).rows[0];

    if (!shop) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    const [catalog, problems, offers, orderStats, orders, bills, audit] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_available IS TRUE)::int AS available,
          COUNT(*) FILTER (WHERE is_available IS NOT TRUE)::int AS unavailable,
          COUNT(*) FILTER (WHERE stock_quantity IS NOT NULL AND stock_quantity <= 0)::int AS out_of_stock,
          COUNT(*) FILTER (WHERE COALESCE(image_url, '') = '')::int AS no_image,
          COUNT(*) FILTER (WHERE COALESCE(barcode, '') = '')::int AS no_barcode,
          COUNT(*) FILTER (WHERE COALESCE(price, 0) <= 0)::int AS no_price,
          COUNT(*) FILTER (WHERE COALESCE(category, '') = '')::int AS no_category
        FROM products WHERE shop_id = $1
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT id, product_name, category, price::float AS price, stock_quantity, is_available, image_url, barcode
        FROM products
        WHERE shop_id = $1 AND (
          is_available IS NOT TRUE OR COALESCE(image_url, '') = '' OR COALESCE(barcode, '') = ''
          OR COALESCE(price, 0) <= 0 OR (stock_quantity IS NOT NULL AND stock_quantity <= 0)
        )
        ORDER BY is_available NULLS FIRST, product_name LIMIT 50
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT id, title, scope, discount_type, discount_value::float AS discount_value, starts_at, ends_at,
               is_active, paused_by_admin
        FROM product_offers WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 30
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT
          COUNT(DISTINCT o.id)::int AS orders,
          COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered')::int AS delivered,
          COUNT(DISTINCT o.id) FILTER (WHERE o.status IN ('cancelled', 'shopper_search_cancelled'))::int AS cancelled,
          COUNT(oi.id)::int AS items,
          COUNT(oi.id) FILTER (WHERE oi.shopping_status = 'refunded')::int AS refunded_items,
          COUNT(oi.id) FILTER (WHERE oi.shopping_status = 'replaced')::int AS replaced_items,
          COALESCE(SUM(oi.price * oi.quantity) FILTER (WHERE o.status = 'delivered' AND oi.shopping_status <> 'refunded'), 0)::float AS item_sales,
          (SELECT COALESCE(SUM(amount_paid), 0)::float FROM store_payments WHERE shop_id = $1) AS till_spend,
          (SELECT COALESCE(SUM(expected_amount), 0)::float FROM store_payments WHERE shop_id = $1) AS till_expected,
          (SELECT COUNT(*)::int FROM store_payments WHERE shop_id = $1) AS bills,
          (SELECT COUNT(*)::int FROM store_payments WHERE shop_id = $1 AND review_status IN ('needs_review', 'queried')) AS bills_flagged
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.shop_id = $1
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT DISTINCT ON (o.id) o.id, o.status, o.created_at, o.total_amount::float AS total_amount,
               c.full_name AS customer_name, sh.full_name AS shopper_name
        FROM order_shops os
        JOIN orders o ON o.id = os.order_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN shoppers sh ON sh.id = o.shopper_id
        WHERE os.shop_id = $1
        ORDER BY o.id DESC LIMIT 30
        `,
        [shopId]
      ),
      pool.query(
        `
        SELECT sp.id, sp.order_id, sp.amount_paid::float AS amount_paid, sp.expected_amount::float AS expected_amount,
               sp.variance::float AS variance, sp.review_status, sp.reimbursement_status, sp.created_at,
               sh.full_name AS shopper_name, b.bill_url, b.bill_urls
        FROM store_payments sp
        LEFT JOIN shoppers sh ON sh.id = sp.shopper_id
        LEFT JOIN LATERAL (
          SELECT bill_url, bill_urls FROM order_shop_bills
          WHERE order_id = sp.order_id AND shop_id = sp.shop_id ORDER BY id DESC LIMIT 1
        ) b ON TRUE
        WHERE sp.shop_id = $1 ORDER BY sp.created_at DESC LIMIT 30
        `,
        [shopId]
      ),
      auditFor('shop', shopId),
    ]);

    const c = catalog.rows[0];
    const st = orderStats.rows[0];

    const missing = [];
    if (!shop.latitude || !shop.longitude) missing.push('Map location');
    if (!shop.image_url) missing.push('Shop photo');
    if (!shop.address) missing.push('Address');
    if (!shop.mobile) missing.push('Phone number');
    if (!shop.area) missing.push('Area');

    return res.json({
      success: true,
      shop: {
        id: shop.id,
        name: shop.shop_name,
        email: shop.email,
        mobile: shop.mobile,
        address: shop.address,
        area: shop.area,
        status: shop.status,
        isOpen: shop.is_open === true,
        imageUrl: shop.image_url,
        brandColor: shop.brand_color,
        position: Number.isFinite(shop.latitude) && Number.isFinite(shop.longitude)
          ? { latitude: shop.latitude, longitude: shop.longitude }
          : null,
        createdAt: shop.created_at,
        updatedAt: shop.updated_at,
        missing,
      },
      catalog: {
        total: c.total, available: c.available, unavailable: c.unavailable, outOfStock: c.out_of_stock,
        noImage: c.no_image, noBarcode: c.no_barcode, noPrice: c.no_price, noCategory: c.no_category,
      },
      productProblems: problems.rows.map((row) => {
        const flags = [];
        if (row.is_available !== true) flags.push('Unavailable');
        if (row.stock_quantity != null && row.stock_quantity <= 0) flags.push('Out of stock');
        if (!(row.price > 0)) flags.push('No price');
        if (!row.image_url) flags.push('No photo');
        if (!row.barcode) flags.push('No barcode');
        return { id: row.id, name: row.product_name, category: row.category, price: row.price, imageUrl: row.image_url, flags };
      }),
      offers: offers.rows.map((row) => ({
        id: row.id, title: row.title, scope: row.scope, discountType: row.discount_type, discountValue: row.discount_value,
        startsAt: row.starts_at, endsAt: row.ends_at, isActive: row.is_active, pausedByAdmin: row.paused_by_admin,
      })),
      performance: {
        orders: st.orders,
        delivered: st.delivered,
        cancelled: st.cancelled,
        items: st.items,
        refundedItems: st.refunded_items,
        replacedItems: st.replaced_items,
        unavailableRate: st.items ? st.refunded_items / st.items : null,
        itemSales: round2(st.item_sales),
        tillSpend: round2(st.till_spend),
        tillExpected: round2(st.till_expected),
        tillVariance: round2(st.till_spend - st.till_expected),
        bills: st.bills,
        billsFlagged: st.bills_flagged,
      },
      orders: orders.rows.map((row) => ({
        id: row.id, status: row.status, statusLabel: statusLabel(row.status), createdAt: row.created_at,
        totalAmount: row.total_amount, customerName: row.customer_name, shopperName: row.shopper_name,
      })),
      bills: bills.rows.map((row) => ({
        id: row.id, orderId: row.order_id, amountPaid: row.amount_paid, expectedAmount: row.expected_amount,
        variance: row.variance, reviewStatus: row.review_status, reimbursementStatus: row.reimbursement_status,
        createdAt: row.created_at, shopperName: row.shopper_name,
        bills: Array.isArray(row.bill_urls) && row.bill_urls.length ? row.bill_urls : row.bill_url ? [row.bill_url] : [],
      })),
      audit,
    });
  } catch (error) {
    console.error('❌ admin getShop error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the shop' });
  }
};

module.exports = {
  EXPECTED_BY_SQL,
  STATUS_SINCE_SQL,
  thresholds,
  computeIssues,
  auditFor,
  getOverview,
  getLiveOperations,
  getIssues,
  search,
  getAuditLog,
  getShopper,
  getShop,
  num,
};
