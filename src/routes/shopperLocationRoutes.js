// const express = require('express');
// const jwt = require('jsonwebtoken');

// const db = require('../config/db');

// const router = express.Router();


// // ==================================================
// // SHOPPER LOCATION UPDATE
// // ==================================================

// router.post('/location', async (req, res) => {
//   try {

//     // ================================================
//     // GET TOKEN
//     // ================================================

//     const authHeader =
//       req.headers.authorization;

//     if (
//       !authHeader ||
//       !authHeader.startsWith('Bearer ')
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Authorization token is required',

//       });

//     }


//     const token =
//       authHeader.split(' ')[1];


//     // ================================================
//     // VERIFY JWT
//     // ================================================

//     let decoded;

//     try {

//       decoded =
//         jwt.verify(
//           token,
//           process.env.JWT_SECRET
//         );

//     } catch (error) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid or expired token',

//       });

//     }


//     // ================================================
//     // GET SHOPPER ID
//     // ================================================

//     const shopperId =
//       decoded.shopperId;


//     if (!shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid shopper token',

//       });

//     }


//     // ================================================
//     // GET LOCATION
//     // ================================================

//     const {
//       latitude,
//       longitude,
//     } = req.body;


//     // ================================================
//     // VALIDATE LOCATION
//     // ================================================

//     if (
//       latitude === undefined ||
//       longitude === undefined ||
//       latitude === null ||
//       longitude === null
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Latitude and longitude are required',

//       });

//     }


//     const lat =
//       Number(latitude);

//     const lng =
//       Number(longitude);


//     if (
//       !Number.isFinite(lat) ||
//       !Number.isFinite(lng)
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Valid latitude and longitude are required',

//       });

//     }


//     if (
//       lat < -90 ||
//       lat > 90 ||
//       lng < -180 ||
//       lng > 180
//     ) {

//       return res.status(400).json({

//         success: false,

//         message:
//           'Invalid latitude or longitude',

//       });

//     }


//     // ================================================
//     // UPDATE SHOPPER LOCATION
//     // ================================================

//     const result =
//       await db.query(
//         `
//         UPDATE shoppers
//         SET
//           latitude = $1,
//           longitude = $2
//         WHERE id = $3
//         RETURNING
//           id,
//           latitude,
//           longitude
//         `,
//         [
//           lat,
//           lng,
//           shopperId,
//         ]
//       );


//     // ================================================
//     // SHOPPER NOT FOUND
//     // ================================================

//     if (
//       result.rows.length === 0
//     ) {

//       return res.status(404).json({

//         success: false,

//         message:
//           'Shopper not found',

//       });

//     }


//     const shopper =
//       result.rows[0];


//     console.log(
//       '📍 SHOPPER LOCATION UPDATED'
//     );

//     console.log(
//       'SHOPPER ID:',
//       shopper.id
//     );

//     console.log(
//       'LATITUDE:',
//       shopper.latitude
//     );

//     console.log(
//       'LONGITUDE:',
//       shopper.longitude
//     );


//     // ================================================
//     // RESPONSE
//     // ================================================

//     return res.json({

//       success: true,

//       message:
//         'Shopper location updated',

//       location: {

//         latitude:
//           Number(shopper.latitude),

//         longitude:
//           Number(shopper.longitude),

//       },

//     });

//   } catch (error) {

//     console.error(
//       '❌ Shopper location update error:',
//       error
//     );


//     return res.status(500).json({

//       success: false,

//       message:
//         'Failed to update shopper location',

//     });

//   }
// });


// module.exports =
//   router;










const express = require('express');
const jwt = require('jsonwebtoken');

const db = require('../config/db');

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
          longitude = $2
        WHERE id = $3
        RETURNING
          id,
          latitude,
          longitude
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


    const shopper =
      result.rows[0];


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

    const allowedStatuses = [
      'online',
      'pending',
    ];


    if (
      !allowedStatuses.includes(
        requestedStatus
      )
    ) {

      return res.status(400).json({

        success: false,

        message:
          'Invalid shopper status. Use online or pending.',

      });

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
          requestedStatus,
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