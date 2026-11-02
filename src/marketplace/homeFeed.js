// =====================================================
// PHASE 61: MARKETPLACE HOME FEED (customer)
//   GET /api/customer/marketplace/categories
//       every business type with whether customers can use it now
//   GET /api/customer/marketplace/home?type&latitude&longitude
//       featured products, popular products (real order counts),
//       popular stores, open-now stores - for one category
//   GET /api/customer/marketplace/buy-again?type&latitude&longitude  (auth)
//       products from the customer's own delivered orders, still sold
//   GET /api/customer/marketplace/products/batch?ids=1,2,3
//       fresh cards for "Recently viewed" (ids kept on the device)
//
// Rules: approved stores only; categories closed to customers (liquor
// until approved) return nothing; restaurants / grocery only from
// stores within the GetMe delivery radius (they can't ship); clothing
// stores anywhere (store delivery). Every number shown comes from real
// rows - when there are no orders yet, "popular" is simply empty.
// =====================================================

const {
  pool,
  MERCHANT_TYPES,
  round2,
  toId,
  fail,
  num,
  loadProductExtras,
  toProduct,
  customerVisible,
  publicShop,
  availabilityOf,
  customerTypeRules,
  customerTypeBlock,
  openMerchantTypes,
} = require('./common');
const { applyOffersToProducts } = require('../pricing/offers');

const LOCAL_KM = 10; // same radius as nearby shops / local search
const POPULAR_DAYS = 60;
const SECTION_MAX = 12;
const FEED_TYPES = ['grocery', ...MERCHANT_TYPES];

const TYPE_LABELS = {
  grocery: { title: 'Groceries', icon: 'basket' },
  clothing: { title: 'Clothing', icon: 'shirt' },
  restaurant: { title: 'Restaurants', icon: 'restaurant' },
  liquor: { title: 'Liquor', icon: 'wine' },
};

const distanceSql = (latP, lngP) => `(
  6371 * acos(LEAST(1, GREATEST(-1,
    cos(radians(${latP})) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians(${lngP}))
    + sin(radians(${latP})) * sin(radians(s.latitude))
  )))
)`;

const readLocation = (query) => {
  const latitude = query.latitude == null || query.latitude === '' ? NaN : Number(query.latitude);
  const longitude = query.longitude == null || query.longitude === '' ? NaN : Number(query.longitude);
  const ok = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  return ok ? { latitude, longitude } : null;
};

// Local-only categories need a location; clothing ships nationwide
const isLocalType = (type) => type !== 'clothing';

// -----------------------------------------------------
// Product cards
// -----------------------------------------------------

const shopCard = (shop, distanceKm) => ({
  id: Number(shop.id),
  name: shop.shop_name,
  logoUrl: shop.image_url || null,
  city: shop.city || shop.area || null,
  district: shop.district || null,
  distanceKm: distanceKm != null ? Number(Number(distanceKm).toFixed(1)) : null,
  isOpen: !!shop.is_open,
});

// Merchant product rows (+ s.* columns prefixed shop_) -> cards
const merchantCards = async (rows, shopsById) => {
  if (!rows.length) return [];
  const extras = await loadProductExtras(rows.map((r) => r.id));
  const out = [];
  for (const row of rows) {
    const shop = shopsById.get(Number(row.shop_id));
    if (!shop) continue;
    const view = toProduct(row, extras, shop);
    if (!customerVisible(view)) continue;
    const variantPrices = view.variants.filter((v) => v.inStock).map((v) => v.effectivePrice);
    out.push({
      productId: view.id,
      name: view.name,
      brand: view.brand,
      category: view.category,
      imageUrl: view.imageUrl,
      businessType: view.businessType,
      price: view.price,
      discountPrice: view.discountPrice,
      priceFrom: variantPrices.length ? Math.min(...variantPrices) : view.effectivePrice,
      hasVariants: view.hasVariants,
      sizes: view.sizes.slice(0, 8),
      colours: view.colours.slice(0, 8),
      inStock: view.inStock,
      lowStock: view.businessType !== 'restaurant' && view.inStock && view.stock <= 5,
      foodType: view.foodType,
      hasOptions: view.optionGroups.length > 0,
      orderCount: row.order_count != null ? Number(row.order_count) : null,
      shop: shopCard(shop, row.distance_km),
    });
  }
  return out;
};

// Grocery rows -> cards with live shop offers (pricing/offers.js)
const groceryCards = async (rows, shopsById) => {
  if (!rows.length) return [];
  const priced = await applyOffersToProducts(rows);
  return priced
    .filter((row) => shopsById.has(Number(row.shop_id)))
    .map((row) => ({
      productId: Number(row.id),
      name: row.product_name,
      brand: row.brand || null,
      category: row.category || null,
      imageUrl: row.image_url || null,
      businessType: 'grocery',
      price: round2(row.original_price != null ? row.original_price : row.price),
      discountPrice: row.original_price != null ? round2(row.price) : null,
      priceFrom: round2(row.price),
      unit: row.unit || null,
      offer: row.offer || null,
      inStock: !!row.is_available,
      orderCount: row.order_count != null ? Number(row.order_count) : null,
      shop: shopCard(shopsById.get(Number(row.shop_id)), row.distance_km),
    }));
};

// Approved shops of a type the customer can order from, with distance
const eligibleShops = async (type, location) => {
  const params = [type];
  const dist = location ? distanceSql('$2', '$3') : 'NULL::float';
  if (location) params.push(location.latitude, location.longitude);
  const rows = (
    await pool.query(
      `SELECT * FROM (
         SELECT s.*, ${dist} AS distance_km FROM shops s
         WHERE s.status = 'approved' AND s.business_type = $1
           AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
       ) t
       ${isLocalType(type) ? `WHERE distance_km <= ${LOCAL_KM}` : ''}`,
      params
    )
  ).rows;
  return new Map(rows.map((r) => [Number(r.id), r]));
};

const productRowsFor = async (shopIds, extraWhere, orderBy, params = [], limit = SECTION_MAX * 2) =>
  shopIds.length
    ? (
        await pool.query(
          `SELECT p.* FROM products p WHERE p.shop_id = ANY($1) AND p.is_available ${extraWhere}
           ORDER BY ${orderBy} LIMIT ${limit}`,
          [shopIds, ...params]
        )
      ).rows
    : [];

const withDistance = (rows, shops) =>
  rows.map((row) => ({ ...row, distance_km: shops.get(Number(row.shop_id))?.distance_km ?? null }));

const cardsFor = (type, rows, shops) =>
  type === 'grocery' ? groceryCards(withDistance(rows, shops), shops) : merchantCards(withDistance(rows, shops), shops);

// -----------------------------------------------------
// GET /marketplace/categories
// -----------------------------------------------------

const getCategories = async (req, res) => {
  try {
    const rules = await customerTypeRules({ fresh: true });
    const categories = FEED_TYPES.map((key) => {
      const rule = rules.get(key);
      const open = key === 'grocery' ? true : !!rule?.open;
      return {
        key,
        label: TYPE_LABELS[key]?.title || rule?.label || key,
        icon: TYPE_LABELS[key]?.icon || 'storefront',
        available: open,
        minAge: rule?.minAge || null,
        message: open
          ? null
          : key === 'liquor'
            ? 'Liquor ordering is not available on GetMe yet. It will open only after legal approval.'
            : 'Coming soon',
        // Restaurants: GetMe Bike riders only
        deliveryNote: key === 'restaurant' ? 'Delivered by Bike' : null,
      };
    });
    return res.json({ success: true, categories });
  } catch (error) {
    console.error('❌ MARKETPLACE CATEGORIES ERROR:', error.message);
    return fail(res, 500, "Couldn't load categories.");
  }
};

// -----------------------------------------------------
// GET /marketplace/home
// -----------------------------------------------------

const getHome = async (req, res) => {
  try {
    const type = FEED_TYPES.includes(req.query.type) ? req.query.type : null;
    if (!type) return fail(res, 400, 'Choose a category', 'BAD_TYPE');
    if (type !== 'grocery') {
      const block = await customerTypeBlock(type);
      if (block) return res.json({ success: true, type, available: false, code: block.code, message: block.message, sections: {} });
    }
    const location = readLocation(req.query);
    if (isLocalType(type) && !location) return fail(res, 400, 'Set your delivery address first', 'LOCATION_REQUIRED');

    const shops = await eligibleShops(type, location);
    const shopIds = [...shops.keys()];

    // Featured (store-picked)
    const featuredRows = type === 'grocery' ? [] : await productRowsFor(
      shopIds, 'AND p.is_featured', 'p.sort_order, p.updated_at DESC'
    );

    // Popular: units sold in delivered orders over the last 60 days
    const popularRows = shopIds.length
      ? (
          await pool.query(
            `SELECT p.*, x.order_count FROM (
               SELECT oi.product_id, COUNT(DISTINCT o.id) AS order_count
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
               WHERE o.status = 'delivered' AND o.business_type = $2
                 AND o.delivered_at >= NOW() - make_interval(days => ${POPULAR_DAYS})
                 AND oi.product_id IS NOT NULL
               GROUP BY oi.product_id
             ) x
             JOIN products p ON p.id = x.product_id
             WHERE p.shop_id = ANY($1) AND p.is_available
             ORDER BY x.order_count DESC, p.product_name
             LIMIT ${SECTION_MAX * 2}`,
            [shopIds, type]
          )
        ).rows
      : [];

    // Stores: completed orders in the last 30 days, then distance
    const storeStats = shopIds.length
      ? new Map(
          (
            await pool.query(
              `SELECT s.id,
                 (SELECT COUNT(*)::int FROM orders o WHERE o.shop_id = s.id AND o.status = 'delivered'
                    AND o.delivered_at >= NOW() - INTERVAL '30 days') AS recent_orders,
                 (SELECT COUNT(*)::int FROM products p WHERE p.shop_id = s.id AND p.is_available) AS product_count,
                 (SELECT COUNT(*)::int FROM orders o WHERE o.shop_id = s.id AND o.business_type <> 'grocery'
                    AND o.merchant_status IN ('new', 'accepted', 'preparing', 'ready')
                    AND o.status NOT IN ('pending_shopper_search', 'cancelled', 'delivered')) AS active_orders
               FROM shops s WHERE s.id = ANY($1)`,
              [shopIds]
            )
          ).rows.map((r) => [Number(r.id), r])
        )
      : new Map();

    const stores = shopIds
      .map((id) => {
        const shop = shops.get(id);
        const stats = storeStats.get(id) || {};
        if (type !== 'grocery' && !Number(stats.product_count)) return null;
        const availability = availabilityOf(shop, Number(stats.active_orders) || 0);
        return {
          ...publicShop(shop, { availability }),
          distanceKm: shop.distance_km != null ? Number(Number(shop.distance_km).toFixed(1)) : null,
          recentOrders: Number(stats.recent_orders) || 0,
          productCount: Number(stats.product_count) || 0,
          shopDelivery: type === 'clothing' && !!shop.shop_delivery_enabled,
        };
      })
      .filter(Boolean);

    const popularStores = stores
      .filter((s) => s.recentOrders > 0)
      .sort((a, b) => b.recentOrders - a.recentOrders || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9))
      .slice(0, SECTION_MAX);
    const openNow = stores
      .filter((s) => s.acceptingOrders)
      .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9))
      .slice(0, SECTION_MAX);

    const [featured, popular] = await Promise.all([
      cardsFor(type, featuredRows, shops),
      cardsFor(type, popularRows, shops),
    ]);

    return res.json({
      success: true,
      type,
      available: true,
      hasLocation: !!location,
      sections: {
        featured: featured.slice(0, SECTION_MAX),
        popular: popular.slice(0, SECTION_MAX),
        popularStores,
        openNow,
      },
      counts: { stores: stores.length },
      notes: {
        popular: `Most ordered on GetMe in the last ${POPULAR_DAYS} days`,
        popularStores: 'Most orders delivered in the last 30 days',
        delivery: type === 'restaurant' ? 'Restaurant orders are delivered by Bike' : null,
      },
    });
  } catch (error) {
    console.error('❌ MARKETPLACE HOME ERROR:', error.message);
    return fail(res, 500, "Couldn't load this page. Please try again.");
  }
};

// -----------------------------------------------------
// GET /marketplace/buy-again (auth)
// -----------------------------------------------------

const getBuyAgain = async (req, res) => {
  try {
    const customerId = Number(req.customer.customerId);
    const type = FEED_TYPES.includes(req.query.type) ? req.query.type : null;
    if (!type) return fail(res, 400, 'Choose a category', 'BAD_TYPE');
    if (type !== 'grocery' && (await customerTypeBlock(type))) return res.json({ success: true, type, products: [] });
    const location = readLocation(req.query);
    if (isLocalType(type) && !location) return res.json({ success: true, type, products: [], needsLocation: true });

    const shops = await eligibleShops(type, location);
    const shopIds = [...shops.keys()];
    if (!shopIds.length) return res.json({ success: true, type, products: [] });

    const rows = (
      await pool.query(
        `SELECT p.*, x.times AS order_count, x.last_at FROM (
           SELECT oi.product_id, COUNT(DISTINCT o.id) AS times, MAX(o.delivered_at) AS last_at
           FROM orders o JOIN order_items oi ON oi.order_id = o.id
           WHERE o.customer_id = $1 AND o.status = 'delivered' AND o.business_type = $2
             AND oi.product_id IS NOT NULL
             -- grocery: items the shopper found (not missing / refunded)
             AND COALESCE(oi.shopping_status, '') NOT IN ('not_found', 'refunded')
           GROUP BY oi.product_id
         ) x
         JOIN products p ON p.id = x.product_id
         WHERE p.shop_id = ANY($3) AND p.is_available
         ORDER BY x.last_at DESC, x.times DESC
         LIMIT ${SECTION_MAX * 2}`,
        [customerId, type, shopIds]
      )
    ).rows;

    const products = (await cardsFor(type, rows, shops)).slice(0, SECTION_MAX);
    return res.json({ success: true, type, products });
  } catch (error) {
    console.error('❌ BUY AGAIN ERROR:', error.message);
    return fail(res, 500, "Couldn't load your past items.");
  }
};

// -----------------------------------------------------
// GET /marketplace/products/batch?ids=
// -----------------------------------------------------

const getProductsBatch = async (req, res) => {
  try {
    const ids = [...new Set(String(req.query.ids || '').split(',').map(toId).filter(Boolean))].slice(0, 30);
    if (!ids.length) return res.json({ success: true, products: [] });
    const location = readLocation(req.query);
    const open = ['grocery', ...(await openMerchantTypes())];

    const params = [ids, open];
    const dist = location ? distanceSql('$3', '$4') : 'NULL::float';
    if (location) params.push(location.latitude, location.longitude);
    const shopRows = (
      await pool.query(
        `SELECT s.*, ${dist} AS distance_km FROM shops s
         WHERE s.id IN (SELECT shop_id FROM products WHERE id = ANY($1))
           AND s.status = 'approved' AND s.business_type = ANY($2::text[])`,
        params
      )
    ).rows;
    const shops = new Map(shopRows.map((s) => [Number(s.id), s]));
    const rows = (
      await pool.query('SELECT p.* FROM products p WHERE p.id = ANY($1) AND p.is_available', [ids])
    ).rows.filter((r) => shops.has(Number(r.shop_id)));

    const grocery = rows.filter((r) => shops.get(Number(r.shop_id)).business_type === 'grocery');
    const merchant = rows.filter((r) => shops.get(Number(r.shop_id)).business_type !== 'grocery');
    const cards = [
      ...(await groceryCards(withDistance(grocery, shops), shops)),
      ...(await merchantCards(withDistance(merchant, shops), shops)),
    ];
    const byId = new Map(cards.map((c) => [c.productId, c]));
    // Same order as asked; gone / closed items are simply left out
    return res.json({ success: true, products: ids.map((id) => byId.get(id)).filter(Boolean) });
  } catch (error) {
    console.error('❌ PRODUCTS BATCH ERROR:', error.message);
    return fail(res, 500, "Couldn't load these items.");
  }
};

module.exports = { getCategories, getHome, getBuyAgain, getProductsBatch, num };
