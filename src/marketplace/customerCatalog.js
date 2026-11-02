// =====================================================
// PHASE 59: CUSTOMER DISCOVERY for clothing shops + restaurants
//   GET /api/customer/marketplace/shops/:shopId
//   GET /api/customer/marketplace/shops/:shopId/products
//   GET /api/customer/marketplace/products/:productId
//   GET /api/customer/marketplace/search?q&type&latitude&longitude
// (GET /api/customer/shops?type=... lives in customerShopController)
// Only approved stores; customers never see unavailable variants or
// options, private shop data, or other customers' anything.
// =====================================================

const {
  pool,
  MERCHANT_TYPES,
  fail,
  text,
  toId,
  todayHours,
  activeMerchantOrders,
  availabilityOf,
  publicShop,
  loadProductExtras,
  toProduct,
  customerVisible,
  colomboDate,
  customerTypeBlock,
  openMerchantTypes,
} = require('./common');

const SEARCH_RADIUS_KM = 10;

const approvedShop = async (shopId) =>
  (await pool.query("SELECT * FROM shops WHERE id = $1 AND status = 'approved'", [shopId])).rows[0] || null;

const storefront = async (shop) => {
  const availability = availabilityOf(shop, await activeMerchantOrders(shop.id));
  const today = colomboDate();
  return {
    ...publicShop(shop, { availability }),
    openingHours: shop.opening_hours || null,
    todayHours: todayHours(shop),
    specialHours: (Array.isArray(shop.special_hours) ? shop.special_hours : []).filter((row) => row.date >= today).slice(0, 14),
    phone: shop.contact_phone || shop.mobile || null,
  };
};

const getStorefront = async (req, res) => {
  try {
    const shop = await approvedShop(toId(req.params.shopId));
    if (!shop) return fail(res, 404, 'This store is not available on GetMe', 'NOT_FOUND');
    const block = await customerTypeBlock(shop.business_type);
    if (block) return fail(res, block.status, block.message, block.code);
    return res.json({ success: true, shop: await storefront(shop) });
  } catch (error) {
    console.error('❌ STOREFRONT ERROR:', error.message);
    return fail(res, 500, "Couldn't load this store. Please try again.");
  }
};

const visibleProducts = async (shop, { search, category, subcategory, featured } = {}) => {
  const params = [shop.id];
  const where = ['p.shop_id = $1', 'p.is_available'];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(p.product_name ILIKE $${params.length} OR p.brand ILIKE $${params.length} OR p.category ILIKE $${params.length} OR p.description ILIKE $${params.length})`);
  }
  if (category) {
    params.push(category);
    where.push(`p.category = $${params.length}`);
  }
  if (subcategory) {
    params.push(subcategory);
    where.push(`p.subcategory = $${params.length}`);
  }
  if (featured) where.push('p.is_featured');

  const rows = (
    await pool.query(
      `SELECT p.* FROM products p WHERE ${where.join(' AND ')} ORDER BY p.is_featured DESC, p.category, p.sort_order, p.product_name LIMIT 1500`,
      params
    )
  ).rows;
  const extras = await loadProductExtras(rows.map((r) => r.id));
  return rows.map((row) => toProduct(row, extras, shop)).filter(customerVisible);
};

// Phase 61: the store's own section order / descriptions (shop_categories)
const categoriesOf = (products, order = new Map()) => {
  const map = new Map();
  for (const p of products) {
    const name = p.category || 'Other';
    if (!map.has(name)) map.set(name, { name, count: 0, subcategories: new Set() });
    const entry = map.get(name);
    entry.count += 1;
    if (p.subcategory) entry.subcategories.add(p.subcategory);
  }
  return [...map.values()]
    .map((c) => ({ name: c.name, count: c.count, subcategories: [...c.subcategories], description: order.get(c.name.toLowerCase())?.description || null, sort: order.get(c.name.toLowerCase())?.sort ?? null }))
    .sort((a, b) => (a.sort ?? 100000) - (b.sort ?? 100000) || 0);
};

const getStoreProducts = async (req, res) => {
  try {
    const shop = await approvedShop(toId(req.params.shopId));
    if (!shop) return fail(res, 404, 'This store is not available on GetMe', 'NOT_FOUND');
    if (!MERCHANT_TYPES.includes(shop.business_type)) {
      return fail(res, 400, 'Grocery stores use the grocery store page', 'GROCERY_STORE');
    }
    const block = await customerTypeBlock(shop.business_type);
    if (block) return fail(res, block.status, block.message, block.code);
    const filters = {
      search: text(req.query.search, 60),
      category: text(req.query.category, 60),
      subcategory: text(req.query.subcategory, 60),
      featured: req.query.featured === '1',
    };
    const products = await visibleProducts(shop, filters);
    const all = filters.search || filters.category || filters.subcategory || filters.featured ? await visibleProducts(shop) : products;
    const order = await require('./merchantTools').sectionOrder(shop.id);
    const rank = (p) => order.get(String(p.category || 'Other').toLowerCase())?.sort ?? 100000;
    const sorted = order.size ? [...products].sort((a, b) => rank(a) - rank(b)) : products;
    return res.json({ success: true, shop: await storefront(shop), categories: categoriesOf(all, order), products: sorted });
  } catch (error) {
    console.error('❌ STORE PRODUCTS ERROR:', error.message);
    return fail(res, 500, "Couldn't load this store's products. Please try again.");
  }
};

const getProductDetail = async (req, res) => {
  try {
    const row = (
      await pool.query(
        `SELECT p.*, s.business_type FROM products p JOIN shops s ON s.id = p.shop_id
         WHERE p.id = $1 AND s.status = 'approved' AND s.business_type = ANY($2)`,
        [toId(req.params.productId), await openMerchantTypes()]
      )
    ).rows[0];
    if (!row) return fail(res, 404, 'This item is no longer available', 'NOT_FOUND');
    const shop = (await pool.query('SELECT * FROM shops WHERE id = $1', [row.shop_id])).rows[0];
    const view = toProduct(row, await loadProductExtras([row.id]), shop);
    if (!customerVisible(view)) return fail(res, 404, 'This item is no longer available', 'NOT_FOUND');
    return res.json({ success: true, product: view, shop: publicShop(shop, { activeCount: await activeMerchantOrders(shop.id) }) });
  } catch (error) {
    console.error('❌ PRODUCT DETAIL ERROR:', error.message);
    return fail(res, 500, "Couldn't load this item. Please try again.");
  }
};

const DISTANCE_SQL = (lat, lng) => `(
  6371 * acos(LEAST(1, GREATEST(-1,
    cos(radians(${lat})) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians(${lng}))
    + sin(radians(${lat})) * sin(radians(s.latitude))
  )))
)`;

const searchMarketplace = async (req, res) => {
  try {
    const q = text(req.query.q, 60);
    const type = MERCHANT_TYPES.includes(req.query.type) ? req.query.type : null;
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);
    if (!q || q.length < 2) return fail(res, 400, 'Type at least 2 letters to search', 'QUERY_TOO_SHORT');
    if (!type) return fail(res, 400, 'Choose clothing or restaurants', 'BAD_TYPE');
    const typeBlock = await customerTypeBlock(type);
    if (typeBlock) return fail(res, typeBlock.status, typeBlock.message, typeBlock.code);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return fail(res, 400, 'Set your location first', 'LOCATION_REQUIRED');

    const like = `%${q}%`;
    const shops = (
      await pool.query(
        `SELECT * FROM (
           SELECT s.*, ${DISTANCE_SQL('$1', '$2')} AS distance_km FROM shops s
           WHERE s.status = 'approved' AND s.business_type = $3 AND s.latitude IS NOT NULL AND s.longitude IS NOT NULL
         ) s WHERE distance_km <= ${SEARCH_RADIUS_KM}
         ORDER BY distance_km`,
        [latitude, longitude, type]
      )
    ).rows;

    const shopIds = shops.map((s) => Number(s.id));
    const byId = new Map(shops.map((s) => [Number(s.id), s]));
    const matchingShops = shops.filter((s) =>
      [s.shop_name, s.description, s.city].some((v) => v && String(v).toLowerCase().includes(q.toLowerCase()))
    );

    const productRows = shopIds.length
      ? (
          await pool.query(
            `SELECT p.* FROM products p
             WHERE p.shop_id = ANY($1) AND p.is_available
               AND (p.product_name ILIKE $2 OR p.brand ILIKE $2 OR p.category ILIKE $2 OR p.subcategory ILIKE $2)
             ORDER BY p.is_featured DESC, p.product_name LIMIT 120`,
            [shopIds, like]
          )
        ).rows
      : [];
    const extras = await loadProductExtras(productRows.map((r) => r.id));
    const products = productRows
      .map((row) => {
        const shop = byId.get(Number(row.shop_id));
        const view = toProduct(row, extras, shop);
        return { ...view, shopName: shop.shop_name, shopLogoUrl: shop.image_url || null, distanceKm: Number(Number(shop.distance_km).toFixed(1)) };
      })
      .filter(customerVisible)
      .slice(0, 60);

    const rows = [];
    for (const shop of matchingShops.slice(0, 20)) {
      rows.push({ ...publicShop(shop, { activeCount: await activeMerchantOrders(shop.id) }), distanceKm: Number(Number(shop.distance_km).toFixed(1)) });
    }
    return res.json({ success: true, shops: rows, products });
  } catch (error) {
    console.error('❌ MARKETPLACE SEARCH ERROR:', error.message);
    return fail(res, 500, "Search isn't working right now. Please try again.");
  }
};

module.exports = { getStorefront, getStoreProducts, getProductDetail, searchMarketplace, storefront };
