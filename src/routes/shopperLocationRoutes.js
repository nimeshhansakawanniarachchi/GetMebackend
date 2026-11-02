const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../config/db');

const { emitToAdmins, emitToLiveOps } = require('../realtime');

const { isSessionCurrent, SESSION_ENDED } = require('../utils/shopperSession');

const router = express.Router();

// =====================================================
// LOCATION FLOOD + PLAUSIBILITY (security review B-25)
// At most LOCATION_PER_MINUTE posts per shopper (the app sends far fewer).
// A jump faster than ~150 km/h from the last fix is logged as an
// anomaly (not refused yet: a first fix after a long offline spell can
// look like one; see the security review).
// =====================================================

const LOCATION_PER_MINUTE = 60;
const MAX_PLAUSIBLE_MPS = 42;
const locationBuckets = new Map();

const tooManyLocationPosts = (shopperId) => {
  const now = Date.now();
  const bucket = locationBuckets.get(shopperId);
  if (!bucket || now - bucket.start > 60_000) {
    locationBuckets.set(shopperId, { start: now, count: 1 });
    if (locationBuckets.size > 20_000) locationBuckets.clear();
    return false;
  }
  bucket.count += 1;
  return bucket.count > LOCATION_PER_MINUTE;
};

const metersBetween = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
};


// ==================================================
// SHOPPER LOCATION UPDATE
// ==================================================

router.post('/location', async (req, res) => {
  try {

    // ================================================
    // GET TOKEN
    // ================================================

    const authHeader =
      req.headers.authorization;

    if (
      !authHeader ||
      !authHeader.startsWith('Bearer ')
    ) {

      return res.status(401).json({

        success: false,

        message:
          'Authorization token is required',

      });

    }


    const token =
      authHeader.split(' ')[1];


    // ================================================
    // VERIFY JWT
    // ================================================

    let decoded;

    try {

      decoded =
        jwt.verify(
          token,
          process.env.JWT_SECRET
        );

    } catch (error) {

      return res.status(401).json({

        success: false,

        message:
          'Invalid or expired token',

      });

    }


    // ================================================
    // GET SHOPPER ID
    // ================================================

    const shopperId =
      decoded.shopperId;

    // A token from before a phone change / recovery is no longer valid
    if (shopperId && !(await isSessionCurrent(decoded))) {
      return res.status(401).json(SESSION_ENDED);
    }


    if (!shopperId) {

      return res.status(401).json({

        success: false,

        message:
          'Invalid shopper token',

      });

    }


    // ================================================
    // GET LOCATION
    // ================================================

    const {
      latitude,
      longitude,
    } = req.body;


    // ================================================
    // VALIDATE LOCATION
    // ================================================

    if (
      latitude === undefined ||
      longitude === undefined ||
      latitude === null ||
      longitude === null
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Latitude and longitude are required',

      });

    }


    const lat =
      Number(latitude);

    const lng =
      Number(longitude);


    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Valid latitude and longitude are required',

      });

    }


    if (
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Invalid latitude or longitude',

      });

    }


    // Flood + plausibility (security review B-25)
    if (tooManyLocationPosts(Number(shopperId))) {
      return res.status(429).json({
        success: false,
        code: 'TOO_MANY_LOCATION_UPDATES',
        message: 'Too many location updates. Slow down.',
      });
    }

    try {
      const previous = (
        await db.query('SELECT latitude, longitude, location_updated_at FROM shoppers WHERE id = $1', [shopperId])
      ).rows[0];
      if (previous?.location_updated_at && previous.latitude != null) {
        const seconds = Math.max(1, (Date.now() - new Date(previous.location_updated_at).getTime()) / 1000);
        const meters = metersBetween({ lat: Number(previous.latitude), lng: Number(previous.longitude) }, { lat, lng });
        if (seconds < 600 && meters > 1000 && meters / seconds > MAX_PLAUSIBLE_MPS) {
          console.warn('⚠️ Implausible shopper location jump', { shopperId, km: Math.round(meters / 100) / 10, seconds: Math.round(seconds) });
        }
      }
    } catch {
      // the check never blocks an update
    }


    // ================================================
    // UPDATE SHOPPER LOCATION
    // ================================================

    const result =
      await db.query(
        `
        UPDATE shoppers
        SET
          latitude = $1,
          longitude = $2,
          location_updated_at = NOW()
        WHERE id = $3
        RETURNING
          id,
          latitude,
          longitude,
          status,
          location_updated_at
        `,
        [
          lat,
          lng,
          shopperId,
        ]
      );


    // ================================================
    // SHOPPER NOT FOUND
    // ================================================

    if (
      result.rows.length === 0
    ) {

      return res.status(404).json({

        success: false,

        message:
          'Shopper not found',

      });

    }


    // ================================================
    // LIVE MAP (admin panel): the new position, so the
    // shopper's pin moves without reloading everything
    // ================================================

    emitToLiveOps(
      req.app.get('io'),
      'admin:shopper-location',
      {
        shopperId: Number(result.rows[0].id),
        latitude: Number(result.rows[0].latitude),
        longitude: Number(result.rows[0].longitude),
        status: result.rows[0].status,
        at: result.rows[0].location_updated_at,
      }
    );


    const shopper =
      result.rows[0];


    // ================================================
    // REAL TIME: push the position to the customer of every
    // order this shopper is working on (tracking map, route,
    // ETA). Polling stays as a fallback in the app.
    // ================================================

    const io = req.app.get('io');

    if (io) {
      const activeOrders =
        await db.query(
          `
          SELECT id, customer_id
          FROM orders
          WHERE shopper_id = $1
            AND status NOT IN (
              'delivered',
              'completed',
              'cancelled',
              'shopper_search_cancelled'
            )
          `,
          [shopper.id]
        );

      activeOrders.rows.forEach((order) => {
        const payload = {
          orderId: Number(order.id),
          order_id: Number(order.id),
          shopperId: Number(shopper.id),
          latitude: Number(shopper.latitude),
          longitude: Number(shopper.longitude),
          at: new Date().toISOString(),
        };

        io.to(`customer:${order.customer_id}`).emit(
          'shopper-location-updated',
          payload
        );

        io.to(`order:${order.id}`).emit(
          'shopper-location-updated',
          payload
        );
      });
    }

    console.log(
      '📍 SHOPPER LOCATION UPDATED'
    );

    console.log(
      'SHOPPER ID:',
      shopper.id
    );

    console.log(
      'LATITUDE:',
      shopper.latitude
    );

    console.log(
      'LONGITUDE:',
      shopper.longitude
    );


    // ================================================
    // RESPONSE
    // ================================================

    return res.json({

      success: true,

      message:
        'Shopper location updated',

      location: {

        latitude:
          Number(shopper.latitude),

        longitude:
          Number(shopper.longitude),

      },

    });

  } catch (error) {

    console.error(
      '❌ Shopper location update error:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to update shopper location',

    });

  }
});


// ==================================================
// SHOPPER STATUS UPDATE
// ==================================================
// GO ONLINE  -> status = online
// GO OFFLINE -> status = pending
// ==================================================

router.post('/status', async (req, res) => {

  try {

    // ================================================
    // GET TOKEN
    // ================================================

    const authHeader =
      req.headers.authorization;


    if (
      !authHeader ||
      !authHeader.startsWith('Bearer ')
    ) {

      return res.status(401).json({

        success: false,

        message:
          'Authorization token required',

      });

    }


    const token =
      authHeader.split(' ')[1];


    // ================================================
    // VERIFY JWT
    // ================================================

    let decoded;

    try {

      decoded =
        jwt.verify(
          token,
          process.env.JWT_SECRET
        );

    } catch (error) {

      return res.status(401).json({

        success: false,

        message:
          'Invalid or expired token',

      });

    }


    // ================================================
    // GET SHOPPER ID
    // ================================================

    const shopperId =
      decoded.shopperId;

    // A token from before a phone change / recovery is no longer valid
    if (shopperId && !(await isSessionCurrent(decoded))) {
      return res.status(401).json(SESSION_ENDED);
    }


    if (!shopperId) {

      return res.status(401).json({

        success: false,

        message:
          'Shopper ID not found in token',

      });

    }


    // ================================================
    // GET STATUS
    // ================================================

    const requestedStatus =
      String(
        req.body?.status || ''
      )
        .trim()
        .toLowerCase();


    // ================================================
    // VALIDATE STATUS
    // ================================================

    // The app still sends 'pending' for "go offline"
    const statusMap = {
      online: 'online',
      offline: 'offline',
      pending: 'offline',
    };

    const newStatus =
      statusMap[requestedStatus];


    if (!newStatus) {

      return res.status(400).json({

        success: false,

        message:
          'Invalid shopper status. Use online or offline.',

      });

    }


    // ================================================
    // ONLY APPROVED SHOPPERS CAN GO ONLINE
    // ================================================

    if (newStatus === 'online') {

      const approvalResult =
        await db.query(
          'SELECT approval_status, vehicle_restriction, licence_expiry FROM shoppers WHERE id = $1',
          [shopperId]
        );

      const approvalStatus =
        approvalResult.rows[0]?.approval_status;

      if (approvalStatus !== 'approved') {

        return res.status(403).json({

          success: false,

          approvalStatus,

          message:
            approvalStatus === 'pending'
              ? 'Your account is waiting for GetMe approval. You can go online once it is approved.'
              : 'Your shopper account is not active. Please contact GetMe support.',

        });

      }

      // Vehicle no longer eligible (phase 35)
      const vehicleBlock =
        require('../onboarding/changeRequests').eligibilityBlock(approvalResult.rows[0]);

      if (vehicleBlock) {
        return res.status(403).json({ success: false, code: vehicleBlock.code, message: vehicleBlock.message });
      }

      // Phase 46: expired revenue licence / insurance (DOCUMENTS_EXPIRED),
      // then the training quiz before the first time online (TRAINING_REQUIRED)
      const complianceBlock =
        await require('../compliance/documents').goOnlineBlock(shopperId);

      if (complianceBlock) {
        return res.status(403).json({ success: false, ...complianceBlock });
      }

    }


    // ================================================
    // UPDATE SHOPPER STATUS
    // ================================================

    const result =
      await db.query(
        `
        UPDATE shoppers
        SET
          status = $1,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING
          id,
          full_name,
          mobile,
          email,
          status,
          latitude,
          longitude,
          updated_at
        `,
        [
          newStatus,
          shopperId,
        ]
      );


    // ================================================
    // SHOPPER NOT FOUND
    // ================================================

    if (
      result.rows.length === 0
    ) {

      return res.status(404).json({

        success: false,

        message:
          'Shopper not found',

      });

    }


    const updatedShopper =
      result.rows[0];


    // Admin Shoppers page + dashboard "online" count update live
    emitToAdmins(
      req.app.get('io'),
      'admin:shoppers-updated',
      {
        shopperId: Number(updatedShopper.id),
        reason: 'status',
        status: updatedShopper.status,
      }
    );


    // ================================================
    // SERVER LOG
    // ================================================

    console.log(
      '========================================'
    );

    console.log(
      '🟢 SHOPPER STATUS UPDATED'
    );

    console.log(
      'SHOPPER ID:',
      updatedShopper.id
    );

    console.log(
      'SHOPPER:',
      updatedShopper.full_name
    );

    console.log(
      'STATUS:',
      updatedShopper.status
    );

    console.log(
      'LATITUDE:',
      updatedShopper.latitude
    );

    console.log(
      'LONGITUDE:',
      updatedShopper.longitude
    );

    console.log(
      '========================================'
    );


    // ================================================
    // RESPONSE
    // ================================================

    return res.json({

      success: true,

      message:
        `Shopper status changed to ${updatedShopper.status}`,

      shopper: updatedShopper,

    });

  } catch (error) {

    console.error(
      '❌ SHOPPER STATUS UPDATE ERROR:',
      error
    );


    return res.status(500).json({

      success: false,

      message:
        'Failed to update shopper status',

      error:
        error.message,

    });

  }

});


module.exports =
  router;