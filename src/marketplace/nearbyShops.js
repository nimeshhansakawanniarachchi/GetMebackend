// =====================================================
// PHASE 59: GET /api/customer/shops?type=clothing|restaurant|all
// Approved stores of that type within 10 km. Unlike the grocery
// list, closed stores are included (isOpen:false, opensAt) so the
// app can show "Closed · opens 10:00"; ordering still refuses them.
// =====================================================

const { pool, MERCHANT_TYPES, publicShop, availabilityOf, customerTypeBlock, openMerchantTypes } = require('./common');

const RADIUS_KM = 10;

const nearbyShops = async (req, res, { latitude, longitude, type }) => {
  try {
    const types = type === 'all' ? ['grocery', ...(await openMerchantTypes())] : MERCHANT_TYPES.includes(type) ? [type] : null;
    if (!types) {
      return res.status(400).json({ success: false, message: 'Choose grocery, clothing, restaurant or all' });
    }
    // Phase 61: a category closed to customers (liquor until approved)
    if (type !== 'all') {
      const block = await customerTypeBlock(type);
      if (block) {
        return res.json({
          success: true,
          customerLocation: { latitude, longitude },
          type,
          shops: [],
          categoryAvailable: false,
          code: block.code,
          message: block.message,
        });
      }
    }

    const rows = (
      await pool.query(
        `SELECT * FROM (
           SELECT s.*,
             (6371 * acos(LEAST(1, GREATEST(-1,
               cos(radians($1)) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians($2))
               + sin(radians($1)) * sin(radians(s.latitude)))))) AS distance_km,
             (SELECT COUNT(*)::int FROM orders o
               WHERE o.shop_id = s.id AND o.business_type <> 'grocery'
                 AND o.merchant_status IN ('new', 'accepted', 'preparing', 'ready')
                 AND o.status NOT IN ('pending_shopper_search', 'cancelled', 'delivered')) AS active_orders,
             (SELECT array_agg(category ORDER BY n DESC) FROM (
                SELECT category, COUNT(*) AS n FROM products p
                WHERE p.shop_id = s.id AND p.is_available GROUP BY category ORDER BY n DESC LIMIT 6) c) AS top_categories,
             (SELECT COUNT(*)::int FROM products p WHERE p.shop_id = s.id AND p.is_available) AS product_count
           FROM shops s
           WHERE s.status = 'approved' AND s.business_type = ANY($3)
             AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
             -- grocery keeps its own rule: open shops only
             AND (s.business_type <> 'grocery' OR s.is_open)
         ) t
         WHERE distance_km <= ${RADIUS_KM}
         ORDER BY is_open DESC, distance_km ASC, shop_name ASC`,
        [latitude, longitude, types]
      )
    ).rows;

    const shops = rows
      // A store with nothing to sell yet isn't shown to customers
      .filter((row) => row.business_type === 'grocery' || Number(row.product_count) > 0)
      .map((row) => {
        const availability = availabilityOf(row, Number(row.active_orders) || 0);
        return {
          // existing grocery fields, so shared UI keeps working
          id: Number(row.id),
          shop_name: row.shop_name,
          address: row.address,
          image_url: row.image_url,
          brand_color: row.brand_color,
          status: row.status,
          created_at: row.created_at,
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          distance_km: Number(Number(row.distance_km).toFixed(2)),
          travel_time_minutes: null,
          route_distance_km: null,
          ...publicShop(row, { availability }),
          categories: (row.top_categories || []).filter(Boolean),
          productCount: Number(row.product_count) || 0,
        };
      });

    return res.json({ success: true, customerLocation: { latitude, longitude }, type, shops, categoryAvailable: true });
  } catch (error) {
    console.error('❌ NEARBY MARKETPLACE SHOPS ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { nearbyShops };
