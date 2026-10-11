
const pool = require('../config/db');

const GOOGLE_MAPS_API_KEY =
  process.env.GOOGLE_MAPS_API_KEY;


// ==================================================
// GET TRAVEL TIME FROM SHOP TO CUSTOMER
// ==================================================

const getTravelTime = async (
  shopLatitude,
  shopLongitude,
  customerLatitude,
  customerLongitude
) => {

  try {

    const response = await fetch(
      'https://routes.googleapis.com/directions/v2:computeRoutes',
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key':
            GOOGLE_MAPS_API_KEY,
          'X-Goog-FieldMask':
            'routes.duration,routes.distanceMeters',
        },

        body: JSON.stringify({

          origin: {
            location: {
              latLng: {
                latitude:
                  Number(shopLatitude),
                longitude:
                  Number(shopLongitude),
              },
            },
          },

          destination: {
            location: {
              latLng: {
                latitude:
                  Number(customerLatitude),
                longitude:
                  Number(customerLongitude),
              },
            },
          },

          travelMode: 'DRIVE',

        }),
      }
    );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.routes ||
      data.routes.length === 0
    ) {

      console.error(
        'Google Routes API error:',
        data
      );

      return null;
    }

    const route =
      data.routes[0];

    // Google duration comes like "842s"
    const seconds =
      Number(
        String(route.duration)
          .replace('s', '')
      );

    const minutes =
      Math.max(
        1,
        Math.round(seconds / 60)
      );

    return {
      minutes,

      distanceKm:
        route.distanceMeters
          ? Number(
              route.distanceMeters / 1000
            ).toFixed(1)
          : null,
    };

  } catch (error) {

    console.error(
      'Travel time error:',
      error
    );

    return null;
  }
};


// ==================================================
// GET APPROVED SHOPS WITHIN 10 KM
// ==================================================

const getCustomerShops = async (req, res) => {

  try {

    const latitude =
      Number(req.query.latitude);

    const longitude =
      Number(req.query.longitude);


    // ----------------------------------------------
    // VALIDATE LOCATION
    // ----------------------------------------------

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {

      return res.status(400).json({
        success: false,
        message:
          'Valid latitude and longitude are required',
      });

    }


    if (
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {

      return res.status(400).json({
        success: false,
        message:
          'Invalid latitude or longitude',
      });

    }


    // ----------------------------------------------
    // GET SHOPS WITHIN 10 KM
    // ----------------------------------------------

    const result =
      await pool.query(
        `
        SELECT *
        FROM (
          SELECT
            id,
            shop_name,
            address,
            image_url,
            status,
            created_at,
            latitude,
            longitude,

            (
              6371 * acos(
                LEAST(
                  1,
                  GREATEST(
                    -1,
                    cos(radians($1)) *
                    cos(radians(latitude)) *
                    cos(
                      radians(longitude) -
                      radians($2)
                    ) +
                    sin(radians($1)) *
                    sin(radians(latitude))
                  )
                )
              )
            ) AS distance_km

          FROM shops

          WHERE status = 'approved'
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL

        ) AS shops_with_distance

        WHERE distance_km <= 10

        ORDER BY
          distance_km ASC,
          shop_name ASC
        `,
        [latitude, longitude]
      );


    // ----------------------------------------------
    // GET ROAD TRAVEL TIME
    // ----------------------------------------------

    const shopsWithTravelTime =
      await Promise.all(

        result.rows.map(
          async (shop) => {

            const route =
              await getTravelTime(
                shop.latitude,
                shop.longitude,
                latitude,
                longitude
              );

            return {

              ...shop,

              travel_time_minutes:
                route
                  ? route.minutes
                  : null,

              route_distance_km:
                route
                  ? route.distanceKm
                  : null,

            };

          }
        )

      );


    // ----------------------------------------------
    // RETURN SHOPS
    // ----------------------------------------------

    return res.json({

      success: true,

      customerLocation: {
        latitude,
        longitude,
      },

      shops:
        shopsWithTravelTime,

    });

  } catch (error) {

    console.error(
      'Get customer shops error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Server error',
    });

  }

};


// ==================================================
// GET PRODUCTS FOR CUSTOMER
// ==================================================

const getCustomerShopProducts = async (
  req,
  res
) => {

  try {

    const shopId =
      req.params.shopId;


    const shopResult =
      await pool.query(
        `
        SELECT
          id,
          shop_name,
          address,
          image_url,
          status
        FROM shops
        WHERE id = $1
        AND status = 'approved'
        `,
        [shopId]
      );


    if (
      shopResult.rows.length === 0
    ) {

      return res.status(404).json({
        success: false,
        message:
          'Shop not found',
      });

    }


    const productResult =
      await pool.query(
        `
        SELECT
          id,
          shop_id,
          product_name,
          category,
          price,
          stock_quantity,
          description,
          is_available,
          image_url,
          created_at,
          updated_at
        FROM products
        WHERE shop_id = $1
        AND is_available = true
        AND stock_quantity > 0
        ORDER BY product_name ASC
        `,
        [shopId]
      );


    return res.json({

      success: true,

      shop:
        shopResult.rows[0],

      products:
        productResult.rows,

    });

  } catch (error) {

    console.error(
      'Get customer shop products error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Server error',
    });

  }

};


// ==================================================
// GOOGLE PLACE AUTOCOMPLETE
// ==================================================

const placeAutocomplete = async (
  req,
  res
) => {

  // ==================================================
  // DEBUG
  // ==================================================

  console.log(
    '🔥 PLACE AUTOCOMPLETE ROUTE HIT',
    req.body
  );


  try {

    const {
      input,
      sessionToken,
    } = req.body;


    // ----------------------------------------------
    // VALIDATE INPUT
    // ----------------------------------------------

    if (
      !input ||
      typeof input !== 'string' ||
      input.trim().length < 3
    ) {

      return res.json({
        success: true,
        suggestions: [],
      });

    }


    // ----------------------------------------------
    // GOOGLE PLACES AUTOCOMPLETE
    // ----------------------------------------------

    const requestBody = {

      input:
        input.trim(),

      regionCode:
        'LK',

    };


    // Use session token when frontend sends one.
    if (
      sessionToken &&
      typeof sessionToken === 'string'
    ) {

      requestBody.sessionToken =
        sessionToken;

    }


    const response =
      await fetch(
        'https://places.googleapis.com/v1/places:autocomplete',
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            'X-Goog-Api-Key':
              GOOGLE_MAPS_API_KEY,

            'X-Goog-FieldMask':
              'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text',
          },

          body:
            JSON.stringify(
              requestBody
            ),
        }
      );


    const data =
      await response.json();


    // ==================================================
    // DEBUG GOOGLE RESPONSE
    // ==================================================

    console.log(
      '📍 GOOGLE PLACES RESPONSE:',
      data
    );


    // ----------------------------------------------
    // GOOGLE ERROR
    // ----------------------------------------------

    if (!response.ok) {

      console.error(
        'Google Places Autocomplete error:',
        data
      );

      return res.status(
        response.status || 500
      ).json({
        success: false,
        message:
          'Unable to search locations',
      });

    }


    // ----------------------------------------------
    // FORMAT SUGGESTIONS
    // ----------------------------------------------

    const suggestions =
      (data.suggestions || [])
        .filter(
          (item) =>
            item.placePrediction
        )
        .map(
          (item) => {

            const prediction =
              item.placePrediction;

            return {

              placeId:
                prediction.placeId,

              description:
                prediction.text?.text ||
                '',

              mainText:
                prediction
                  .structuredFormat
                  ?.mainText
                  ?.text ||
                '',

              secondaryText:
                prediction
                  .structuredFormat
                  ?.secondaryText
                  ?.text ||
                '',

            };

          }
        );


    // ==================================================
    // DEBUG FORMATTED SUGGESTIONS
    // ==================================================

    console.log(
      '📍 FORMATTED SUGGESTIONS:',
      suggestions
    );


    // ----------------------------------------------
    // RETURN
    // ----------------------------------------------

    return res.json({

      success: true,

      suggestions,

    });

  } catch (error) {

    console.error(
      'Place autocomplete error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Server error',
    });

  }

};


// ==================================================
// GOOGLE PLACE DETAILS
// ==================================================

const placeDetails = async (
  req,
  res
) => {

  try {

    const placeId =
      req.params.placeId;

    const sessionToken =
      req.query.sessionToken;


    // ----------------------------------------------
    // VALIDATE PLACE ID
    // ----------------------------------------------

    if (!placeId) {

      return res.status(400).json({
        success: false,
        message:
          'Place ID is required',
      });

    }


    // ----------------------------------------------
    // BUILD URL
    // ----------------------------------------------

    let url =
      `https://places.googleapis.com/v1/places/${encodeURIComponent(
        placeId
      )}`;


    if (
      sessionToken &&
      typeof sessionToken === 'string'
    ) {

      url +=
        `?sessionToken=${encodeURIComponent(
          sessionToken
        )}`;

    }


    // ----------------------------------------------
    // GOOGLE PLACE DETAILS
    // ----------------------------------------------

    const response =
      await fetch(
        url,
        {
          method: 'GET',

          headers: {

            'Content-Type':
              'application/json',

            'X-Goog-Api-Key':
              GOOGLE_MAPS_API_KEY,

            'X-Goog-FieldMask':
              'id,displayName,formattedAddress,location',

          },
        }
      );


    const data =
      await response.json();


    const googlePlaceDetailsData =
      data;


    // ----------------------------------------------
    // GOOGLE ERROR
    // ----------------------------------------------

    if (!response.ok) {

      console.error(
        'Google Place Details error:',
        googlePlaceDetailsData
      );

      return res.status(
        response.status || 500
      ).json({
        success: false,
        message:
          'Unable to get location details',
      });

    }


    // ----------------------------------------------
    // RETURN LOCATION
    // ----------------------------------------------

    return res.json({

      success: true,

      placeId:
        data.id,

      displayName:
        data.displayName?.text ||
        '',

      formattedAddress:
        data.formattedAddress ||
        '',

      latitude:
        data.location?.latitude,

      longitude:
        data.location?.longitude,

    });

  } catch (error) {

    console.error(
      'Place details error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Server error',
    });

  }

};


// ==================================================
// EXPORTS
// ==================================================

module.exports = {
  getCustomerShops,
  getCustomerShopProducts,
  placeAutocomplete,
  placeDetails,
};