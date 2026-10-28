const crypto = require('crypto');

const db = require('../config/db');

const { FINISHED_STATUSES } = require('../utils/orderStatus');

const {
  OFFER_RADIUS_KM,
  shopperPayForOrder,
  distanceKm,
} = require('./shopperPay');

const {
  createShopperNotification,
} = require('./shopperNotificationController');

// Phase 45: shopper cash limit
const cashLimit = require('../dispatch/cashLimit');

// =====================================================
// SHOPPER DISPATCH
// A waiting order is offered to shoppers closest to the shop first
// (only shoppers with the customer's chosen vehicle, if any). Every
// FORWARD_SECONDS (5 s) the next closest shopper is ALSO offered it.
// Offers never expire: a shopper keeps the batch until someone
// accepts it (the first to accept wins and it is withdrawn from
// everyone else), they hide it, or they can no longer take it
// (offline, out of range or busy). If nobody holds it, the next
// shopper gets it straight away. When everyone in range has been
// asked, shoppers who hid it are offered it again, until someone
// accepts.
//
// startDispatchLoop() runs dispatchWaitingOrders() every second, so
// forwarding happens on time without any app polling. Shopper /
// customer polls, hides and new searches also call dispatchOrder().
// =====================================================

const FORWARD_SECONDS = 5;

// No shopper with the chosen vehicle accepted in this long: also
// offer it to vehicles that cost the same or less (the customer's
// screen says so); accepting re-prices it to that vehicle's fee
const VEHICLE_FALLBACK_SECONDS = 180;

const DISPATCH_TICK_MS = 1000;

// =====================================================
// ELIGIBLE SHOPPERS
// Online + approved shoppers who aren't busy with another order,
// with EVERY shop of the order within OFFER_RADIUS_KM and the
// customer's preferred vehicle (if any; once the search has run
// VEHICLE_FALLBACK_SECONDS, also vehicles whose fee in
// orders.vehicle_fees is no higher), sorted by distance to the
// nearest shop.
// anyVehicle: ignore the preference (nearby vehicles on the map).
// =====================================================

// Phase 45: shoppers a staff member released from this order are left
// out (includeExcluded: the admin candidate list shows them), and on
// cash orders so are shoppers at / over the cash limit
// (ignoreCashLimit: the admin list shows them, flagged).
const getEligibleShoppers = async (
  orderId,
  client = db,
  { anyVehicle = false, includeExcluded = false, ignoreCashLimit = false } = {}
) => {
  const [shopsResult, shoppersResult] = await Promise.all([
    client.query(
      `
      SELECT s.latitude, s.longitude
      FROM order_shops os
      INNER JOIN shops s ON s.id = os.shop_id
      WHERE os.order_id = $1
        AND s.latitude IS NOT NULL
        AND s.longitude IS NOT NULL
      `,
      [orderId]
    ),
    client.query(
      `
      SELECT
        sh.id,
        sh.vehicle_type,
        sh.latitude,
        sh.longitude
      FROM shoppers sh
      INNER JOIN orders o ON o.id = $1
      WHERE sh.status = 'online'
        AND sh.approval_status = 'approved'
        -- phase 35: no restricted vehicle / expired licence
        AND sh.vehicle_restriction IS NULL
        AND (sh.licence_expiry IS NULL OR sh.licence_expiry >= CURRENT_DATE)
        -- phase 46: no expired revenue licence / insurance
        AND (sh.revenue_licence_expiry IS NULL OR sh.revenue_licence_expiry >= CURRENT_DATE)
        AND (sh.insurance_expiry IS NULL OR sh.insurance_expiry >= CURRENT_DATE)
        AND sh.latitude IS NOT NULL
        AND sh.longitude IS NOT NULL
        -- Busy shoppers (any unfinished order) aren't offered more
        AND NOT EXISTS (
          SELECT 1
          FROM orders busy
          WHERE busy.shopper_id = sh.id
            AND busy.status <> ALL($3::text[])
        )
        -- Phase 45: released from this order by staff
        AND (
          $5
          OR NOT EXISTS (
            SELECT 1
            FROM order_dispatch_exclusions x
            WHERE x.order_id = o.id
              AND x.shopper_id = sh.id
          )
        )
        -- NULL preference = any vehicle. After
        -- VEHICLE_FALLBACK_SECONDS of searching, vehicles that cost
        -- the same or less too (any vehicle on orders without
        -- vehicle_fees). Unbookable types are priced like a Bike
        -- (pricing/vehicles.js priceClass).
        AND (
          $2
          OR o.preferred_vehicle_type IS NULL
          OR sh.vehicle_type = o.preferred_vehicle_type
          OR (
            o.shopper_search_started_at <= NOW() - make_interval(secs => $4)
            AND (
              o.vehicle_fees IS NULL
              OR COALESCE(
                (o.vehicle_fees ->> (
                  CASE
                    WHEN sh.vehicle_type IN ('motorbike', 'three-wheeler', 'car')
                      THEN sh.vehicle_type
                    ELSE 'motorbike'
                  END
                ))::numeric,
                o.delivery_fee
              ) <= o.delivery_fee
            )
          )
        )
      `,
      [orderId, anyVehicle, FINISHED_STATUSES, VEHICLE_FALLBACK_SECONDS, includeExcluded]
    ),
  ]);

  const shops = shopsResult.rows;

  if (shops.length === 0) {
    return [];
  }

  const inRange = shoppersResult.rows
    .map((shopper) => {
      const distances = shops.map((shop) =>
        distanceKm(
          Number(shopper.latitude),
          Number(shopper.longitude),
          Number(shop.latitude),
          Number(shop.longitude)
        )
      );

      return {
        ...shopper,
        id: Number(shopper.id),
        nearestKm: Math.min(...distances),
        farthestKm: Math.max(...distances),
      };
    })
    .filter(
      (shopper) =>
        Number.isFinite(shopper.farthestKm) &&
        shopper.farthestKm <= OFFER_RADIUS_KM
    )
    .sort((a, b) => a.nearestKm - b.nearestKm);

  // Phase 45: cash orders skip shoppers at / over the cash limit
  return ignoreCashLimit ? inRange : cashLimit.dropOverLimit(orderId, inRange, client);
};

// =====================================================
// NEARBY VEHICLES FOR THE CUSTOMER MAP (PickMe style)
// Vehicle type + APPROXIMATE position of each shopper who could
// take the order, any vehicle type. No ids or names. Each position
// is moved FUZZ_MIN_M..FUZZ_MAX_M in a direction that is fixed per
// shopper per day: icons don't jump on every poll, and the real
// location can't be averaged out. Shoppers without a vehicle type
// are left out (they only count for "any").
// =====================================================

const FUZZ_MIN_M = 200;
const FUZZ_MAX_M = 300;

const fuzzPosition = (shopperId, latitude, longitude) => {
  const day = new Date().toISOString().slice(0, 10);

  const hash = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'getme-vehicles')
    .update(`${shopperId}:${day}`)
    .digest();

  const bearing = (hash.readUInt16BE(0) / 65535) * 2 * Math.PI;
  const meters =
    FUZZ_MIN_M + (hash.readUInt16BE(2) / 65535) * (FUZZ_MAX_M - FUZZ_MIN_M);

  const metersPerDegree = 111320;

  return {
    latitude: latitude + (meters * Math.cos(bearing)) / metersPerDegree,
    longitude:
      longitude +
      (meters * Math.sin(bearing)) /
        (metersPerDegree * Math.cos((latitude * Math.PI) / 180)),
  };
};

// shoppers: getEligibleShoppers(orderId, db, { anyVehicle: true })
// when the caller already has it
const getNearbyVehicles = async (orderId, shoppers = null) => {
  shoppers =
    shoppers ||
    (await getEligibleShoppers(orderId, db, {
      anyVehicle: true,
    }));

  return (
    shoppers
      .filter((shopper) => shopper.vehicle_type)
      .map((shopper) => {
        const position = fuzzPosition(
          shopper.id,
          Number(shopper.latitude),
          Number(shopper.longitude)
        );

        return {
          type: shopper.vehicle_type,
          latitude: Number(position.latitude.toFixed(5)),
          longitude: Number(position.longitude.toFixed(5)),
        };
      })
      // Not by distance: list order must not hint who is closest
      .sort(
        (a, b) =>
          a.type.localeCompare(b.type) || a.latitude - b.latitude
      )
  );
};

// =====================================================
// ALERT THE SHOPPER WHO NOW HOLDS THE OFFER
// Socket 'new-order' makes the app refresh + play the alarm.
// =====================================================

const alertOfferedShopper = async ({ io, orderId, shopperId }) => {
  try {
    const orderResult = await db.query(
      `
      SELECT
        o.delivery_fee,
        o.vehicle_fees,
        o.fast_delivery_fee,
        o.service_fee,
        o.tip_amount,
        (SELECT vehicle_type FROM shoppers WHERE id = $2) AS shopper_vehicle_type,
        STRING_AGG(s.shop_name, ' + ' ORDER BY os.shop_id) AS shop_names
      FROM orders o
      LEFT JOIN order_shops os ON os.order_id = o.id
      LEFT JOIN shops s ON s.id = os.shop_id
      WHERE o.id = $1
      GROUP BY o.id
      `,
      [orderId, shopperId]
    );

    const order = orderResult.rows[0];

    if (!order) {
      return;
    }

    if (io) {
      io.to(`shopper:${shopperId}`).emit('new-order', {
        orderId,
        order_id: orderId,
      });
    }

    // Re-offers come every few seconds: always push the socket
    // event, but save only one notification per shopper per search
    const alreadyNotified = await db.query(
      `
      SELECT 1
      FROM shopper_notifications n
      INNER JOIN orders o ON o.id = n.order_id
      WHERE n.shopper_id = $1
        AND n.order_id = $2
        AND n.type = 'new_batch'
        AND n.created_at >= COALESCE(o.shopper_search_started_at, o.created_at)
      LIMIT 1
      `,
      [shopperId, orderId]
    );

    if (alreadyNotified.rows.length > 0) {
      return;
    }

    await createShopperNotification({
      io,
      shopperId,
      type: 'new_batch',
      title: 'New batch available',
      body: `${order.shop_names || 'New order'} · Earn LKR ${shopperPayForOrder(
        order,
        order.shopper_vehicle_type
      ).toFixed(2)}. Open the app to accept it.`,
      orderId,
    });
  } catch (error) {
    console.error('❌ alertOfferedShopper error:', error.message);
  }
};

// =====================================================
// DISPATCH ONE ORDER
// Ends offers of shoppers who went offline / out of range, then
// adds the next closest shopper when the forwarding time is due.
// Returns { shopperIds } currently holding the offer ([] when
// nobody in range can take it), or null when not searching.
// Never throws.
// =====================================================

const dispatchOrder = async ({ io = null, orderId }) => {
  const client = await db.connect();

  let newOffer = null;
  let result = null;

  try {
    await client.query('BEGIN');

    // One dispatcher per order at a time (accept locks the same row)
    const orderResult = await client.query(
      `
      SELECT
        id,
        status,
        shopper_id,
        -- Phase 45: an exclusive staff offer pauses forwarding
        dispatch_exclusive_shopper_id,
        dispatch_paused_until IS NOT NULL AS has_pause,
        COALESCE(dispatch_paused_until > NOW(), false) AS paused
      FROM orders
      WHERE id = $1
      FOR UPDATE
      `,
      [orderId]
    );

    const order = orderResult.rows[0];

    if (
      !order ||
      order.status !== 'waiting_for_shopper' ||
      order.shopper_id !== null
    ) {
      await client.query('ROLLBACK');
      return null;
    }

    const eligible = await getEligibleShoppers(orderId, client);
    const eligibleIds = new Set(eligible.map((shopper) => shopper.id));

    // Rows = this round's offers (older rounds are deleted)
    const offersResult = await client.query(
      `
      SELECT
        shopper_id,
        dismissed_at,
        EXTRACT(EPOCH FROM (NOW() - first_seen_at)) AS age_seconds
      FROM shopper_order_offers
      WHERE order_id = $1
      `,
      [orderId]
    );

    // An offer runs until the shopper hides it (no time limit)
    const offers = offersResult.rows.map((offer) => ({
      shopperId: Number(offer.shopper_id),
      ageSeconds: Number(offer.age_seconds),
      running: offer.dismissed_at === null,
    }));

    // -------------------------------------------------
    // END OFFERS OF SHOPPERS WHO WENT OFFLINE / AWAY
    // -------------------------------------------------

    const gone = offers.filter(
      (offer) => offer.running && !eligibleIds.has(offer.shopperId)
    );

    if (gone.length > 0) {
      await client.query(
        `
        UPDATE shopper_order_offers
        SET dismissed_at = NOW()
        WHERE order_id = $1 AND shopper_id = ANY($2::int[])
        `,
        [orderId, gone.map((offer) => offer.shopperId)]
      );
    }

    const holders = offers.filter(
      (offer) => offer.running && eligibleIds.has(offer.shopperId)
    );

    const holderIds = new Set(holders.map((offer) => offer.shopperId));

    // -------------------------------------------------
    // FORWARD? Every FORWARD_SECONDS, or now if nobody holds it
    // -------------------------------------------------

    const newestOfferAge = offers.length
      ? Math.min(...offers.map((offer) => offer.ageSeconds))
      : Infinity;

    // Phase 45: staff offered it to one shopper exclusively. No
    // forwarding while that shopper still holds the offer and the
    // pause runs; once it ends, or the shopper hides it / can no
    // longer take it, the pause is cleared and forwarding resumes.
    const exclusiveId = Number(order.dispatch_exclusive_shopper_id) || null;
    const exclusiveWaiting =
      order.paused && holders.some((offer) => offer.shopperId === exclusiveId);

    if (order.has_pause && !exclusiveWaiting) {
      await client.query(
        `
        UPDATE orders
        SET dispatch_paused_until = NULL, dispatch_exclusive_shopper_id = NULL
        WHERE id = $1
        `,
        [orderId]
      );
    }

    const forwardDue =
      !exclusiveWaiting &&
      (holders.length === 0 || newestOfferAge >= FORWARD_SECONDS);

    let next = null;

    if (forwardDue) {
      // Closest shopper not asked yet in this round
      next = eligible.find(
        (shopper) =>
          !offers.some((offer) => offer.shopperId === shopper.id)
      );

      // Everyone asked: new round from the closest (keep running offers)
      if (!next && eligible.length > 0) {
        await client.query(
          `
          DELETE FROM shopper_order_offers
          WHERE order_id = $1
            AND NOT (shopper_id = ANY($2::int[]))
          `,
          [orderId, [...holderIds]]
        );

        next = eligible.find((shopper) => !holderIds.has(shopper.id));
      }
    }

    if (next) {
      await client.query(
        `
        INSERT INTO shopper_order_offers (shopper_id, order_id, first_seen_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (shopper_id, order_id)
        DO UPDATE SET first_seen_at = NOW(), dismissed_at = NULL
        `,
        [next.id, orderId]
      );

      holderIds.add(next.id);
      newOffer = next;
    }

    await client.query('COMMIT');

    result = { shopperIds: [...holderIds] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ dispatchOrder error:', error.message);
    return null;
  } finally {
    client.release();
  }

  // After commit, so the shopper's refresh already sees the offer
  if (newOffer) {
    console.log(
      `🎯 BATCH #${orderId} offered to shopper #${newOffer.id} (${newOffer.nearestKm.toFixed(
        2
      )} km from shop)`
    );

    await alertOfferedShopper({ io, orderId, shopperId: newOffer.id });
  }

  return result;
};

// =====================================================
// DISPATCH EVERY WAITING ORDER
// =====================================================

const dispatchWaitingOrders = async ({ io = null } = {}) => {
  try {
    const waiting = await db.query(
      `
      SELECT id
      FROM orders
      WHERE status = 'waiting_for_shopper'
        AND shopper_id IS NULL
      `
    );

    for (const row of waiting.rows) {
      await dispatchOrder({ io, orderId: Number(row.id) });
    }
  } catch (error) {
    console.error('❌ dispatchWaitingOrders error:', error.message);
  }
};

// =====================================================
// BACKGROUND LOOP (bin/www)
// Keeps the 5 s forwarding on time even when no app is polling.
// =====================================================

let dispatchLoopBusy = false;

const startDispatchLoop = (io) => {
  // Cash limit notifications from background checks (phase 45)
  cashLimit.useIo(io);

  return setInterval(async () => {
    if (dispatchLoopBusy) {
      return;
    }

    dispatchLoopBusy = true;

    try {
      await dispatchWaitingOrders({ io });
    } finally {
      dispatchLoopBusy = false;
    }
  }, DISPATCH_TICK_MS);
};

// =====================================================
// DOES THIS SHOPPER HOLD THE OFFER?
// Any offer they haven't hidden (offers don't expire).
// =====================================================

const shopperHoldsOffer = async ({ client = db, orderId, shopperId }) => {
  const result = await client.query(
    `
    SELECT 1
    FROM shopper_order_offers
    WHERE order_id = $1
      AND shopper_id = $2
      AND dismissed_at IS NULL
    LIMIT 1
    `,
    [orderId, shopperId]
  );

  return result.rows.length > 0;
};

// =====================================================
// OFFER WITHDRAWN (real time)
// When an order is accepted by someone else, the search is stopped
// or the order is cancelled, the shoppers still holding the offer
// get 'offers-changed' so the batch disappears at once (instead
// of on their next 5 s poll).
// =====================================================

const getOfferHolders = async (orderId, client = db) => {
  const result = await client.query(
    `
    SELECT shopper_id
    FROM shopper_order_offers
    WHERE order_id = $1
      AND dismissed_at IS NULL
    `,
    [orderId]
  );

  return result.rows.map((row) => Number(row.shopper_id));
};

const notifyOffersWithdrawn = (io, orderId, shopperIds, reason) => {
  if (!io) {
    return;
  }

  shopperIds.forEach((shopperId) => {
    io.to(`shopper:${shopperId}`).emit('offers-changed', {
      orderId: Number(orderId),
      order_id: Number(orderId),
      reason,
    });
  });
};

module.exports = {
  VEHICLE_FALLBACK_SECONDS,
  getEligibleShoppers,
  getOfferHolders,
  notifyOffersWithdrawn,
  getNearbyVehicles,
  dispatchOrder,
  dispatchWaitingOrders,
  startDispatchLoop,
  shopperHoldsOffer,
  // Phase 45: staff offers alert the chosen shopper the same way
  alertOfferedShopper,
};
