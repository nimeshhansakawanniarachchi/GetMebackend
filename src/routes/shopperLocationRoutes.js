const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../config/db');

const { emitToAdmins, emitToLiveOps } = require('../realtime');

const router = express.Router();


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
          'SELECT approval_status FROM shoppers WHERE id = $1',
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