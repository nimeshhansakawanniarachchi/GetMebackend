const pool = require('../../config/db');

const { FINISHED_STATUSES } = require('../../utils/orderStatus');
const { broadcastOrderChange } = require('../../realtime');
const { adminCan, recordAdminAudit } = require('../../middleware/adminAccess');
const notifications = require('../../admin/notifications');
const cashLimit = require('../../dispatch/cashLimit');

const {
  getEligibleShoppers,
  getOfferHolders,
  notifyOffersWithdrawn,
  dispatchOrder,
  alertOfferedShopper,
} = require('../shopperDispatch');

const { createShopperNotification } = require('../shopperNotificationController');

// =====================================================
// STAFF CONTROL OVER SHOPPER ASSIGNMENT (phase 45, orders.dispatch)
//
//   GET  /orders/:id/dispatch             state + history (orders.view)
//   GET  /orders/:id/dispatch-candidates  nearby eligible shoppers
//   POST /orders/:id/release-shopper      { reason, confirmShopping?,
//                                           expectedStatus?, expectedShopperId? }
//   POST /orders/:id/offer-shopper        { shopperId, reason, exclusive?,
//                                           expectedStatus? }
//   POST /orders/:id/redispatch           { reason, expectedStatus? }
//
// A shopper is never assigned without accepting: an offer only puts
// the order in their available batches (and alerts them). A released
// shopper is never offered the same order again automatically
// (order_dispatch_exclusions; a staff offer to them clears it).
// Every action locks the order row and refuses (409) when the order
// moved on meanwhile (e.g. a shopper accepted a second earlier);
// expectedStatus / expectedShopperId = what the admin's screen showed.
// Store payments, bills and other money records are never touched.
//
// Cash limit settings (dispatch_settings):
//   GET /dispatch-settings   PUT /dispatch-settings
//   GET /shoppers/:id/cash-limit
// =====================================================

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const iso = (value) => (value ? new Date(value).toISOString() : null);

const shortName = (fullName) => {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};

const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

// Reason: required, 5-300 characters
const readReason = (req) => {
  const reason = String(req.body?.reason ?? '').replace(/\s+/g, ' ').trim();
  return reason.length >= 5 && reason.length <= 300 ? reason : null;
};

const REASON_MESSAGE = 'Enter a reason (5 to 300 characters)';

// What the admin's screen showed vs. the order now
const staleCheck = (body, order) => {
  if (body?.expectedStatus && String(body.expectedStatus) !== order.status) return true;

  if (body?.expectedShopperId !== undefined) {
    const expected = body.expectedShopperId === null ? null : toId(body.expectedShopperId);
    const actual = order.shopper_id != null ? Number(order.shopper_id) : null;
    if (expected !== actual) return true;
  }

  return false;
};

const statusChanged = (res, order) =>
  fail(res, 409, `Order #${order.id} changed meanwhile (now ${String(order.status).replace(/_/g, ' ')}). Reload and try again.`, {
    code: 'STATUS_CHANGED',
    status: order.status,
    shopperId: order.shopper_id != null ? Number(order.shopper_id) : null,
  });

const lockOrder = async (client, orderId) =>
  (
    await client.query(
      `
      SELECT id, status, shopper_id, customer_id, payment_method,
             dispatch_paused_until, dispatch_exclusive_shopper_id
      FROM orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId]
    )
  ).rows[0];

const shopperName = async (client, shopperId) =>
  shopperId ? (await client.query('SELECT full_name FROM shoppers WHERE id = $1', [shopperId])).rows[0]?.full_name || null : null;

const recordAction = (client, req, fields) =>
  client
    .query(
      `
      INSERT INTO order_dispatch_actions
        (order_id, action, admin_id, admin_name, admin_role, reason, shopper_id, exclusive, paused_until, from_status, to_status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
      `,
      [
        fields.orderId,
        fields.action,
        req.admin?.adminId ?? null,
        req.admin?.fullName ?? null,
        req.admin?.role ?? null,
        fields.reason,
        fields.shopperId ?? null,
        Boolean(fields.exclusive),
        fields.pausedUntil ?? null,
        fields.fromStatus ?? null,
        fields.toStatus ?? null,
      ]
    )
    .then((result) => result.rows[0]);

const notifyAdmins = (req, action, { event, severity, title, body }) =>
  notifications.notify({
    category: 'orders',
    event,
    severity,
    title,
    body,
    entityType: 'order',
    entityId: action.order_id,
    permissions: ['orders.view'],
    dedupe: `order.dispatch:${action.id}`,
    actorAdminId: req.admin?.adminId ?? null,
  });

// =====================================================
// RELEASE THE SHOPPER
// =====================================================

const releaseShopper = async (req, res) => {
  const orderId = toId(req.params.id);
  const reason = readReason(req);
  const confirmShopping = req.body?.confirmShopping === true;

  if (!orderId) return fail(res, 400, 'Invalid order ID');
  if (!reason) return fail(res, 400, REASON_MESSAGE);

  const client = await pool.connect();
  let before;
  let action;
  let staleHolders = [];
  let storePayments = 0;
  let releasedName = null;

  try {
    await client.query('BEGIN');

    before = await lockOrder(client, orderId);

    if (!before) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Order not found');
    }

    if (staleCheck(req.body, before)) {
      await client.query('ROLLBACK');
      return statusChanged(res, before);
    }

    if (!['shopper_accepted', 'shopping'].includes(before.status) || !before.shopper_id) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Only an order a shopper has accepted (or is shopping for) can be released', {
        code: 'NOT_RELEASABLE',
        status: before.status,
      });
    }

    if (before.status === 'shopping' && !confirmShopping) {
      await client.query('ROLLBACK');
      return fail(
        res,
        409,
        'The shopper has started shopping and may already have bought groceries. Confirm to release anyway: store payments and bills already recorded are kept.',
        { code: 'CONFIRM_SHOPPING', status: before.status }
      );
    }

    const shopperId = Number(before.shopper_id);
    releasedName = await shopperName(client, shopperId);

    const updated = await client.query(
      `
      UPDATE orders
      SET status = 'waiting_for_shopper',
          shopper_id = NULL,
          accepted_at = NULL,
          dispatch_paused_until = NULL,
          dispatch_exclusive_shopper_id = NULL,
          updated_at = NOW()
      WHERE id = $1 AND status = $2 AND shopper_id = $3
      RETURNING id
      `,
      [orderId, before.status, shopperId]
    );

    if (updated.rowCount === 0) {
      await client.query('ROLLBACK');
      return statusChanged(res, before);
    }

    // Not offered to the released shopper again automatically
    await client.query(
      `
      INSERT INTO order_dispatch_exclusions (order_id, shopper_id, reason, created_by)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (order_id, shopper_id)
      DO UPDATE SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = NOW()
      `,
      [orderId, shopperId, reason, req.admin?.adminId ?? null]
    );

    // Offers left over from the first search: a fresh round starts
    staleHolders = (await getOfferHolders(orderId, client)).filter((id) => id !== shopperId);
    await client.query('DELETE FROM shopper_order_offers WHERE order_id = $1', [orderId]);

    storePayments = Number(
      (await client.query('SELECT COUNT(*)::int AS n FROM store_payments WHERE order_id = $1', [orderId])).rows[0].n
    );

    action = await recordAction(client, req, {
      orderId,
      action: 'release',
      reason,
      shopperId,
      fromStatus: before.status,
      toStatus: 'waiting_for_shopper',
    });

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ release shopper error:', error.message);
    return fail(res, 500, 'Unable to release the shopper');
  } finally {
    client.release();
  }

  const io = req.app.get('io');
  const shopperId = Number(before.shopper_id);
  const payload = {
    orderId,
    order_id: orderId,
    status: 'waiting_for_shopper',
    event: 'shopper-released',
    released: true,
    releasedShopperId: shopperId,
  };

  if (io) {
    // The released shopper: the order leaves their jobs (no staff reason)
    io.to(`shopper:${shopperId}`).emit('order-status-changed', {
      ...payload,
      message: `GetMe moved order #${orderId} to another shopper. Stop working on it.`,
    });
    io.to(`customer:${before.customer_id}`).emit('order-status-changed', payload);
    io.to(`order:${orderId}`).emit('order-status-changed', payload);
  }

  broadcastOrderChange(io, orderId, { event: 'shopper-released', status: 'waiting_for_shopper' });
  notifyOffersWithdrawn(io, orderId, staleHolders, 'reassigned');

  createShopperNotification({
    io,
    shopperId,
    type: 'order_released',
    title: `Order #${orderId} reassigned`,
    body:
      before.status === 'shopping'
        ? 'GetMe moved this order to another shopper. Stop shopping for it - don\'t buy anything more. Store payments and bills you recorded are kept.'
        : 'GetMe moved this order to another shopper. You no longer need to go to the store for it.',
    orderId,
  }).catch(() => {});

  const name = shortName(releasedName) || `shopper #${shopperId}`;

  await notifyAdmins(req, action, {
    event: 'order.dispatch_released',
    severity: 'warning',
    title: `Order #${orderId} released from ${name} by staff`,
    body: `Was ${before.status.replace(/_/g, ' ')}; back in the shopper search.`,
  });

  res.locals.audit = {
    summary: `Released the shopper (${before.status.replace(/_/g, ' ')}): ${reason}`,
    before: { status: before.status, shopperId },
    after: { status: 'waiting_for_shopper', shopperId: null, excludedShopperId: shopperId },
  };

  // Dispatch resumes now (closest shopper first, not the released one)
  const dispatch = await dispatchOrder({ io, orderId });

  return res.json({
    success: true,
    message:
      before.status === 'shopping'
        ? `Shopper released. ${storePayments} store payment${storePayments === 1 ? '' : 's'} recorded so far ${storePayments === 1 ? 'is' : 'are'} kept. Looking for a new shopper.`
        : 'Shopper released. Looking for a new shopper.',
    order: { id: orderId, status: 'waiting_for_shopper', shopperId: null },
    releasedShopperId: shopperId,
    storePaymentsKept: storePayments,
    offeredTo: dispatch?.shopperIds?.length || 0,
    actionId: action.id,
  });
};

// =====================================================
// OFFER TO A CHOSEN SHOPPER (they still have to accept)
// =====================================================

const offerShopper = async (req, res) => {
  const orderId = toId(req.params.id);
  const shopperId = toId(req.body?.shopperId);
  const reason = readReason(req);
  const exclusive = req.body?.exclusive === true;

  if (!orderId) return fail(res, 400, 'Invalid order ID');
  if (!shopperId) return fail(res, 400, 'Choose a shopper');
  if (!reason) return fail(res, 400, REASON_MESSAGE);

  const settings = await cashLimit.getSettings(pool, { fresh: true });
  const client = await pool.connect();
  let before;
  let action;
  let withdrawn = [];
  let pausedUntil = null;
  let chosenName = null;

  try {
    await client.query('BEGIN');

    before = await lockOrder(client, orderId);

    if (!before) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Order not found');
    }

    if (staleCheck(req.body, before) || before.status !== 'waiting_for_shopper' || before.shopper_id !== null) {
      await client.query('ROLLBACK');
      return before.status === 'waiting_for_shopper' && before.shopper_id === null
        ? statusChanged(res, before)
        : fail(res, 409, `Order #${orderId} is not looking for a shopper (now ${before.status.replace(/_/g, ' ')})`, {
            code: 'STATUS_CHANGED',
            status: before.status,
            shopperId: before.shopper_id != null ? Number(before.shopper_id) : null,
          });
    }

    // Same rules as automatic dispatch (online, approved, documents,
    // not busy, in range, the customer's vehicle), except that a
    // shopper released earlier may be chosen again by staff
    const eligible = await getEligibleShoppers(orderId, client, { includeExcluded: true, ignoreCashLimit: true });
    const chosen = eligible.find((shopper) => shopper.id === shopperId);

    if (!chosen) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'This shopper can\'t take the order now (offline, busy with another order, too far, another vehicle, or not approved).', {
        code: 'NOT_ELIGIBLE',
      });
    }

    if (before.payment_method === 'cash') {
      const cash = await cashLimit.statusFor(shopperId, client);

      if (cash.reached) {
        await client.query('ROLLBACK');
        return fail(res, 409, `This shopper holds Rs ${cash.held.toFixed(2)} in cash (limit Rs ${cash.limit.toFixed(2)}): they can't take cash orders until it is handed over.`, {
          code: 'CASH_LIMIT_REACHED',
          cashLimit: cash,
        });
      }
    }

    chosenName = await shopperName(client, shopperId);

    // Chosen by staff: no longer excluded
    await client.query('DELETE FROM order_dispatch_exclusions WHERE order_id = $1 AND shopper_id = $2', [orderId, shopperId]);

    if (exclusive) {
      // Only the chosen shopper holds it while forwarding is paused
      withdrawn = (await getOfferHolders(orderId, client)).filter((id) => id !== shopperId);
      await client.query('DELETE FROM shopper_order_offers WHERE order_id = $1 AND shopper_id <> $2', [orderId, shopperId]);

      pausedUntil = (
        await client.query(
          `
          UPDATE orders
          SET dispatch_paused_until = NOW() + make_interval(mins => $2),
              dispatch_exclusive_shopper_id = $3
          WHERE id = $1
          RETURNING dispatch_paused_until
          `,
          [orderId, settings.exclusiveOfferMinutes, shopperId]
        )
      ).rows[0].dispatch_paused_until;
    } else if (before.dispatch_paused_until) {
      // A plain offer ends an earlier exclusive pause
      await client.query(
        'UPDATE orders SET dispatch_paused_until = NULL, dispatch_exclusive_shopper_id = NULL WHERE id = $1',
        [orderId]
      );
    }

    await client.query(
      `
      INSERT INTO shopper_order_offers (shopper_id, order_id, first_seen_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (shopper_id, order_id)
      DO UPDATE SET first_seen_at = NOW(), dismissed_at = NULL
      `,
      [shopperId, orderId]
    );

    action = await recordAction(client, req, {
      orderId,
      action: 'offer',
      reason,
      shopperId,
      exclusive,
      pausedUntil,
      fromStatus: before.status,
      toStatus: before.status,
    });

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ offer shopper error:', error.message);
    return fail(res, 500, 'Unable to offer the order');
  } finally {
    client.release();
  }

  const io = req.app.get('io');

  notifyOffersWithdrawn(io, orderId, withdrawn, 'reassigned');
  // Socket 'new-order' (app refreshes + alarm) + one saved notification
  await alertOfferedShopper({ io, orderId, shopperId });
  broadcastOrderChange(io, orderId, { event: 'dispatch-offer', status: before.status });

  const name = shortName(chosenName) || `shopper #${shopperId}`;

  await notifyAdmins(req, action, {
    event: 'order.dispatch_offered',
    severity: 'info',
    title: `Order #${orderId} offered to ${name} by staff`,
    body: exclusive
      ? `Only this shopper is offered it for ${settings.exclusiveOfferMinutes} min; they still have to accept.`
      : 'The shopper still has to accept; automatic dispatch continues.',
  });

  res.locals.audit = {
    summary: `Offered to shopper #${shopperId}${exclusive ? ` (exclusive, ${settings.exclusiveOfferMinutes} min)` : ''}: ${reason}`,
    before: { status: before.status, shopperId: null, pausedUntil: iso(before.dispatch_paused_until) },
    after: { status: before.status, shopperId: null, offeredShopperId: shopperId, exclusive, pausedUntil: iso(pausedUntil) },
  };

  return res.json({
    success: true,
    message: exclusive
      ? `Offered to ${chosenName || 'the shopper'}. Automatic dispatch is paused for ${settings.exclusiveOfferMinutes} minutes while they decide.`
      : `Offered to ${chosenName || 'the shopper'}. They still have to accept.`,
    offer: { shopperId, exclusive, pausedUntil },
    actionId: action.id,
  });
};

// =====================================================
// RE-DISPATCH: fresh automatic round, no pause
// =====================================================

const redispatch = async (req, res) => {
  const orderId = toId(req.params.id);
  const reason = readReason(req);

  if (!orderId) return fail(res, 400, 'Invalid order ID');
  if (!reason) return fail(res, 400, REASON_MESSAGE);

  const client = await pool.connect();
  let before;
  let action;
  let holders = [];

  try {
    await client.query('BEGIN');

    before = await lockOrder(client, orderId);

    if (!before) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Order not found');
    }

    if (staleCheck(req.body, before) || before.status !== 'waiting_for_shopper' || before.shopper_id !== null) {
      await client.query('ROLLBACK');
      return fail(res, 409, `Order #${orderId} is not looking for a shopper (now ${before.status.replace(/_/g, ' ')})`, {
        code: 'STATUS_CHANGED',
        status: before.status,
        shopperId: before.shopper_id != null ? Number(before.shopper_id) : null,
      });
    }

    holders = await getOfferHolders(orderId, client);

    await client.query('DELETE FROM shopper_order_offers WHERE order_id = $1', [orderId]);
    await client.query(
      'UPDATE orders SET dispatch_paused_until = NULL, dispatch_exclusive_shopper_id = NULL WHERE id = $1',
      [orderId]
    );

    action = await recordAction(client, req, {
      orderId,
      action: 'redispatch',
      reason,
      fromStatus: before.status,
      toStatus: before.status,
    });

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ redispatch error:', error.message);
    return fail(res, 500, 'Unable to restart dispatch');
  } finally {
    client.release();
  }

  const io = req.app.get('io');

  notifyOffersWithdrawn(io, orderId, holders, 'redispatch');

  await notifyAdmins(req, action, {
    event: 'order.redispatched',
    severity: 'info',
    title: `Order #${orderId} re-dispatched by staff`,
    body: 'Automatic dispatch restarted from the closest shopper.',
  });

  res.locals.audit = {
    summary: `Re-dispatched: ${reason}`,
    before: { status: before.status, shopperId: null, pausedUntil: iso(before.dispatch_paused_until), offerHolders: holders },
    after: { status: before.status, shopperId: null, pausedUntil: null },
  };

  const dispatch = await dispatchOrder({ io, orderId });

  broadcastOrderChange(io, orderId, { event: 'redispatch', status: before.status });

  return res.json({
    success: true,
    message: dispatch?.shopperIds?.length
      ? 'Dispatch restarted. Offered to the closest shopper.'
      : 'Dispatch restarted. No shopper in range yet; it keeps looking.',
    offeredTo: dispatch?.shopperIds || [],
    actionId: action.id,
  });
};

// =====================================================
// STATE + HISTORY (orders.view)
// =====================================================

const getDispatch = async (req, res) => {
  const orderId = toId(req.params.id);
  if (!orderId) return fail(res, 400, 'Invalid order ID');

  try {
    const order = (
      await pool.query(
        `
        SELECT o.id, o.status, o.shopper_id, o.payment_method, o.preferred_vehicle_type,
               o.shopper_search_started_at, o.dispatch_paused_until, o.dispatch_exclusive_shopper_id,
               COALESCE(o.dispatch_paused_until > NOW(), false) AS paused,
               sh.full_name AS shopper_name, ex.full_name AS exclusive_name
        FROM orders o
        LEFT JOIN shoppers sh ON sh.id = o.shopper_id
        LEFT JOIN shoppers ex ON ex.id = o.dispatch_exclusive_shopper_id
        WHERE o.id = $1
        `,
        [orderId]
      )
    ).rows[0];

    if (!order) return fail(res, 404, 'Order not found');

    const [offers, exclusions, history, settings] = await Promise.all([
      pool.query(
        `
        SELECT so.shopper_id, so.first_seen_at, so.dismissed_at, sh.full_name
        FROM shopper_order_offers so
        LEFT JOIN shoppers sh ON sh.id = so.shopper_id
        WHERE so.order_id = $1
        ORDER BY so.first_seen_at
        `,
        [orderId]
      ),
      pool.query(
        `
        SELECT x.shopper_id, x.reason, x.created_at, sh.full_name
        FROM order_dispatch_exclusions x
        LEFT JOIN shoppers sh ON sh.id = x.shopper_id
        WHERE x.order_id = $1
        ORDER BY x.created_at DESC
        `,
        [orderId]
      ),
      pool.query(
        `
        SELECT a.*, sh.full_name AS shopper_name
        FROM order_dispatch_actions a
        LEFT JOIN shoppers sh ON sh.id = a.shopper_id
        WHERE a.order_id = $1
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 50
        `,
        [orderId]
      ),
      cashLimit.getSettings(),
    ]);

    const waiting = order.status === 'waiting_for_shopper' && order.shopper_id === null;

    return res.json({
      success: true,
      dispatch: {
        orderId,
        status: order.status,
        paymentMethod: order.payment_method,
        preferredVehicle: order.preferred_vehicle_type || null,
        searchStartedAt: order.shopper_search_started_at,
        shopper: order.shopper_id ? { id: Number(order.shopper_id), name: order.shopper_name } : null,
        canRelease: ['shopper_accepted', 'shopping'].includes(order.status) && Boolean(order.shopper_id),
        releaseNeedsConfirm: order.status === 'shopping',
        canOffer: waiting,
        canRedispatch: waiting,
        paused: Boolean(order.paused),
        pausedUntil: order.paused ? order.dispatch_paused_until : null,
        exclusiveShopper: order.paused && order.dispatch_exclusive_shopper_id
          ? { id: Number(order.dispatch_exclusive_shopper_id), name: order.exclusive_name }
          : null,
        offers: waiting
          ? offers.rows.map((row) => ({
              shopperId: Number(row.shopper_id),
              name: row.full_name,
              since: row.first_seen_at,
              declined: row.dismissed_at !== null,
            }))
          : [],
        released: exclusions.rows.map((row) => ({
          shopperId: Number(row.shopper_id),
          name: row.full_name,
          at: row.created_at,
        })),
        history: history.rows.map((row) => ({
          id: Number(row.id),
          action: row.action,
          reason: row.reason,
          shopperId: row.shopper_id != null ? Number(row.shopper_id) : null,
          shopperName: row.shopper_name || null,
          exclusive: row.exclusive,
          pausedUntil: row.paused_until,
          fromStatus: row.from_status,
          toStatus: row.to_status,
          adminName: row.admin_name,
          adminRole: row.admin_role,
          at: row.created_at,
        })),
        exclusiveOfferMinutes: settings.exclusiveOfferMinutes,
      },
    });
  } catch (error) {
    console.error('❌ get dispatch error:', error.message);
    return fail(res, 500, 'Unable to load dispatch details');
  }
};

// =====================================================
// CANDIDATES (orders.dispatch): no phone numbers
// =====================================================

const getCandidates = async (req, res) => {
  const orderId = toId(req.params.id);
  if (!orderId) return fail(res, 400, 'Invalid order ID');

  try {
    const order = (await pool.query('SELECT id, status, shopper_id, payment_method FROM orders WHERE id = $1', [orderId])).rows[0];
    if (!order) return fail(res, 404, 'Order not found');

    const list = await getEligibleShoppers(orderId, pool, { includeExcluded: true, ignoreCashLimit: true });
    const ids = list.map((shopper) => shopper.id);

    const [details, offers, exclusions, statuses] = await Promise.all([
      ids.length
        ? pool.query(
            `
            SELECT sh.id, sh.full_name, sh.vehicle_type, sh.status, sh.location_updated_at,
                   (SELECT COUNT(*)::int FROM orders a WHERE a.shopper_id = sh.id AND a.status <> ALL($2::text[])) AS active_orders
            FROM shoppers sh
            WHERE sh.id = ANY($1::int[])
            `,
            [ids, FINISHED_STATUSES]
          )
        : { rows: [] },
      pool.query('SELECT shopper_id, dismissed_at FROM shopper_order_offers WHERE order_id = $1', [orderId]),
      pool.query('SELECT shopper_id FROM order_dispatch_exclusions WHERE order_id = $1', [orderId]),
      cashLimit.statusesFor(ids),
    ]);

    const byId = new Map(details.rows.map((row) => [Number(row.id), row]));
    const offerOf = new Map(offers.rows.map((row) => [Number(row.shopper_id), row]));
    const excluded = new Set(exclusions.rows.map((row) => Number(row.shopper_id)));
    const cashOrder = order.payment_method === 'cash';

    const candidates = list.map((shopper) => {
      const row = byId.get(shopper.id) || {};
      const cash = statuses.get(shopper.id);
      const offer = offerOf.get(shopper.id);

      return {
        shopperId: shopper.id,
        name: row.full_name || `Shopper #${shopper.id}`,
        vehicleType: shopper.vehicle_type || null,
        distanceKm: round2(shopper.nearestKm),
        online: row.status === 'online',
        locationUpdatedAt: row.location_updated_at || null,
        activeOrders: Number(row.active_orders || 0),
        cashHeld: cash?.held ?? 0,
        cashLimit: cash?.limit ?? null,
        cashLimitReached: Boolean(cash?.reached),
        // Cash orders: not for shoppers at / over the cash limit
        canOffer: !(cashOrder && cash?.reached),
        releasedFromOrder: excluded.has(shopper.id),
        offer: offer ? (offer.dismissed_at ? 'declined' : 'holding') : null,
      };
    });

    return res.json({
      success: true,
      orderId,
      status: order.status,
      paymentMethod: order.payment_method,
      waiting: order.status === 'waiting_for_shopper' && order.shopper_id === null,
      candidates,
    });
  } catch (error) {
    console.error('❌ dispatch candidates error:', error.message);
    return fail(res, 500, 'Unable to load nearby shoppers');
  }
};

// =====================================================
// SETTINGS: cash limit (finance.settlements) + exclusive offer
// minutes (orders.dispatch); the Super Admin has both
// =====================================================

const settingsBody = async (settings) => {
  const over = (
    await pool.query(
      `
      SELECT st.shopper_id, st.cash_held, st.crossed_at, sh.full_name
      FROM shopper_cash_limit_state st
      LEFT JOIN shoppers sh ON sh.id = st.shopper_id
      WHERE st.over_limit
      ORDER BY st.cash_held DESC
      LIMIT 50
      `
    )
  ).rows;

  return {
    shopperCashLimit: settings.shopperCashLimit,
    exclusiveOfferMinutes: settings.exclusiveOfferMinutes,
    updatedAt: settings.updatedAt,
    currency: 'LKR',
    shoppersOverLimit: over.map((row) => ({
      shopperId: Number(row.shopper_id),
      name: row.full_name,
      cashHeld: Number(row.cash_held),
      since: row.crossed_at,
    })),
  };
};

const getSettings = async (req, res) => {
  try {
    const settings = await cashLimit.getSettings(pool, { fresh: true });
    return res.json({ success: true, settings: await settingsBody(settings) });
  } catch (error) {
    console.error('❌ dispatch settings error:', error.message);
    return fail(res, 500, 'Unable to load the dispatch settings');
  }
};

const MAX_CASH_LIMIT = 10000000;

const updateSettings = async (req, res) => {
  const body = req.body || {};
  const before = await cashLimit.getSettings(pool, { fresh: true });
  const next = { ...before };
  const changes = [];

  if (body.shopperCashLimit !== undefined) {
    const limit = Number(body.shopperCashLimit);

    if (body.shopperCashLimit === null || body.shopperCashLimit === '' || !Number.isFinite(limit) || limit < 0 || limit > MAX_CASH_LIMIT) {
      return fail(res, 400, 'Enter a cash limit between Rs 0 and Rs 10,000,000');
    }

    if (round2(limit) !== before.shopperCashLimit) {
      if (!adminCan(req, 'finance.settlements')) {
        recordAdminAudit({
          admin: req.admin,
          action: 'security.denied',
          entityType: 'route',
          summary: 'PUT /dispatch-settings (cash limit) needs finance.settlements',
          outcome: 'denied',
          ip: req.ip,
        });
        return fail(res, 403, 'Changing the shopper cash limit needs the settlements permission.', {
          code: 'PERMISSION_DENIED',
          permission: 'finance.settlements',
        });
      }

      next.shopperCashLimit = round2(limit);
      changes.push('cash limit');
    }
  }

  if (body.exclusiveOfferMinutes !== undefined) {
    const minutes = Number(body.exclusiveOfferMinutes);

    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
      return fail(res, 400, 'Exclusive offers last 1 to 30 minutes');
    }

    if (minutes !== before.exclusiveOfferMinutes) {
      if (!adminCan(req, 'orders.dispatch')) {
        recordAdminAudit({
          admin: req.admin,
          action: 'security.denied',
          entityType: 'route',
          summary: 'PUT /dispatch-settings (exclusive offer minutes) needs orders.dispatch',
          outcome: 'denied',
          ip: req.ip,
        });
        return fail(res, 403, 'Changing the exclusive offer time needs the dispatch permission.', {
          code: 'PERMISSION_DENIED',
          permission: 'orders.dispatch',
        });
      }

      next.exclusiveOfferMinutes = minutes;
      changes.push('exclusive offer time');
    }
  }

  try {
    if (changes.length > 0) {
      await pool.query(
        `
        UPDATE dispatch_settings
        SET shopper_cash_limit = $1, exclusive_offer_minutes = $2, updated_by = $3, updated_at = NOW()
        WHERE id = 1
        `,
        [next.shopperCashLimit, next.exclusiveOfferMinutes, req.admin?.adminId ?? null]
      );
      cashLimit.clearSettingsCache();
    }

    const settings = await cashLimit.getSettings(pool, { fresh: true });

    res.locals.audit = {
      summary: changes.length
        ? `Dispatch settings: cash limit Rs ${settings.shopperCashLimit.toFixed(2)}, exclusive offers ${settings.exclusiveOfferMinutes} min`
        : 'Dispatch settings saved (no change)',
      before: { shopperCashLimit: before.shopperCashLimit, exclusiveOfferMinutes: before.exclusiveOfferMinutes },
      after: { shopperCashLimit: settings.shopperCashLimit, exclusiveOfferMinutes: settings.exclusiveOfferMinutes },
    };

    // A new limit: shoppers holding cash may now be over / under it
    if (settings.shopperCashLimit !== before.shopperCashLimit) {
      await cashLimit.refreshAll(req.app.get('io'));
    }

    return res.json({
      success: true,
      message: changes.length ? 'Dispatch settings saved' : 'Nothing changed',
      settings: await settingsBody(settings),
    });
  } catch (error) {
    console.error('❌ update dispatch settings error:', error.message);
    return fail(res, 500, 'Unable to save the dispatch settings');
  }
};

// GET /shoppers/:id/cash-limit (shoppers.view or finance.view)
const getShopperCashLimit = async (req, res) => {
  const shopperId = toId(req.params.id);
  if (!shopperId) return fail(res, 400, 'Invalid shopper');

  try {
    const exists = (await pool.query('SELECT id FROM shoppers WHERE id = $1', [shopperId])).rows[0];
    if (!exists) return fail(res, 404, 'Shopper not found');

    const [status, state] = await Promise.all([
      cashLimit.statusFor(shopperId),
      pool.query('SELECT crossings, crossed_at, cleared_at FROM shopper_cash_limit_state WHERE shopper_id = $1', [shopperId]),
    ]);

    const row = state.rows[0];

    return res.json({
      success: true,
      cashLimit: {
        ...status,
        crossings: row ? Number(row.crossings) : 0,
        lastCrossedAt: row?.crossed_at || null,
        lastClearedAt: row?.cleared_at || null,
      },
    });
  } catch (error) {
    console.error('❌ shopper cash limit error:', error.message);
    return fail(res, 500, 'Unable to load the cash limit');
  }
};

module.exports = {
  releaseShopper,
  offerShopper,
  redispatch,
  getDispatch,
  getCandidates,
  getSettings,
  updateSettings,
  getShopperCashLimit,
};
