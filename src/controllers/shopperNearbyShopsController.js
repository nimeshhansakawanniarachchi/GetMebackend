const pool = require('../config/db');

// =====================================================
// NEARBY SHOPS (ShopperApp Home map)
// GET /api/shopper/nearby-shops?latitude=&longitude=
//
// Approved shops within NEARBY_SHOPS_RADIUS_KM of the shopper,
// nearest first - same distance query and radius as the
// customer's GET /api/customer/shops, but without the per-shop
// Google Routes call (this is re-fetched as the shopper moves).
// Only public shop details are returned.
// =====================================================

const NEARBY_SHOPS_RADIUS_KM = 10;
const NEARBY_SHOPS_LIMIT = 50;

const getNearbyShops = async (req, res) => {
  try {
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 ||
      latitude > 90 ||
      longitude < -180 ||
      longitude > 180
    ) {
      return res.status(400).json({
        success: false,
        message: 'Valid latitude and longitude are required',
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM (
        SELECT
          id,
          shop_name,
          address,
          area,
          image_url,
          latitude,
          longitude,
          is_open,
          (
            6371 * acos(
              LEAST(
                1,
                GREATEST(
                  -1,
                  cos(radians($1)) *
                  cos(radians(latitude)) *
                  cos(radians(longitude) - radians($2)) +
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
      WHERE distance_km <= $3
      ORDER BY distance_km ASC, shop_name ASC
      LIMIT $4
      `,
      [latitude, longitude, NEARBY_SHOPS_RADIUS_KM, NEARBY_SHOPS_LIMIT]
    );

    return res.json({
      success: true,
      radiusKm: NEARBY_SHOPS_RADIUS_KM,
      shops: result.rows.map((shop) => ({
        id: shop.id,
        shopName: shop.shop_name,
        address: shop.address,
        area: shop.area,
        imageUrl: shop.image_url,
        latitude: Number(shop.latitude),
        longitude: Number(shop.longitude),
        isOpen: shop.is_open !== false,
        distanceKm: Number(Number(shop.distance_km).toFixed(2)),
      })),
    });
  } catch (error) {
    console.error('Get nearby shops error:', error);

    return res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};

module.exports = {
  getNearbyShops,
};
