// =====================================================
// PHASE 60: NATIONWIDE SEARCH (all approved shops in Sri Lanka)
//   GET /api/customer/marketplace/search/products
//   GET /api/customer/marketplace/search/shops
//   GET /api/customer/marketplace/delivery-options
//   GET /api/customer/marketplace/districts
// Server-side search on products.search_text (trigram index) with
// filters, sorting and pagination - the app never downloads whole
// catalogues. Live stock / variants / prices every request. Each
// result says whether (and how) the shop can deliver to the
// customer's address; nothing about the customer is sent to shops.
// =====================================================

const {
  pool,
  MERCHANT_TYPES,
  PROVINCES,
  round2,
  toId,
  fail,
  text,
  publicShop,
  availabilityOf,
  activeMerchantOrders,
  isRetail,
  customerTypeBlock,
  openMerchantTypes,
} = require('./common');
const { resolveDistrict, normalize: normalizeDistrict } = require('./district');
const { deliveryOptionsFor, deliverySummary, zonesFor } = require('./deliveryOptions');
const { getPricingSettings } = require('../pricing/settings');
const { applyOffersToProducts } = require('../pricing/offers');
const { nearestDistrict } = require('./district');

const PAGE_MAX = 40;
const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'with', 'in', 'of', 's', 'to', 'size', 'colour', 'color']);
// recommended (phase 61c): what can reach the customer first, then relevance
const SORTS = ['relevance', 'recommended', 'price_asc', 'price_desc', 'distance', 'delivery'];
const SEARCH_TYPES = ['grocery', ...MERCHANT_TYPES];

// "Men's Black Slim-Fit Shirts" -> ['men', 'black', 'slim', 'fit', 'shirt']
const tokensOf = (q) =>
  [...new Set(
    String(q || '')
      .toLowerCase()
      .replace(/['’]s\b/g, '')
      .replace(/[^a-z0-9඀-෿஀-௿\s-]/g, ' ')
      .split(/[\s-]+/)
      .map((t) => t.trim())
      .filter((t) => t && !STOP.has(t))
      .map((t) => (t.length > 3 && t.endsWith('es') && !t.endsWith('ses') ? t.slice(0, -2) : t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
      .map((t) => (t === 'mens' ? 'men' : t === 'womens' ? 'women' : t === 'ladie' ? 'ladies' : t))
  )].slice(0, 8);

const likeEscape = (t) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

const readNumber = (value, { min = 0, max = 10000000 } = {}) => {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};

const customerContext = async (query) => {
  const latitude = Number(query.latitude);
  const longitude = Number(query.longitude);
  const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  const where = await resolveDistrict({
    declared: query.deliveryDistrict,
    placeId: query.placeId,
    latitude: hasLocation ? latitude : null,
    longitude: hasLocation ? longitude : null,
  });
  return { latitude: hasLocation ? latitude : null, longitude: hasLocation ? longitude : null, hasLocation, ...where };
};

const distanceSql = (latParam, lngParam) => `(6371 * acos(LEAST(1, GREATEST(-1,
  cos(radians(${latParam})) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians(${lngParam}))
  + sin(radians(${latParam})) * sin(radians(s.latitude))))))`;

// -----------------------------------------------------
// Products
// -----------------------------------------------------

// Phase 61b: multi-select filters (comma lists), facet counts that
// ignore the shopper's own selections (ticking a box doesn't hide the
// other boxes), browse without a query (browse=1), and suggestions.
// Single-value params (category, size, colour, brand...) still work.
const listParam = (value, max, limit = 25) =>
  [...new Set(String(value || '').split(',').map((s) => text(s, max)).filter(Boolean).map((s) => s.toLowerCase()))].slice(0, limit);

const readSelection = (query) => {
  const merge = (single, multi, max) => [...new Set([...listParam(single, max, 1), ...listParam(multi, max)])];
  return {
    categories: merge(query.category, query.categories, 60),
    subcategories: merge(query.subcategory, query.subcategories, 60),
    brands: merge(query.brand, query.brands, 80),
    sizes: merge(query.size, query.sizes, 20),
    colours: merge(query.colour, query.colours, 30),
    materials: merge(query.material, query.materials, 40),
  };
};

const SIZE_ORDER = ['xxxs', 'xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '2xl', 'xxxl', '3xl', '4xl', 'free size', 'one size'];
const sizeRank = (size) => {
  const s = String(size).trim().toLowerCase();
  const i = SIZE_ORDER.indexOf(s);
  if (i >= 0) return [0, i, ''];
  const n = parseFloat(s);
  if (Number.isFinite(n)) return [1, n, s];
  return [2, 0, s];
};
const sortSizes = (list) =>
  [...list].sort((a, b) => {
    const [ga, na, sa] = sizeRank(a.name ?? a);
    const [gb, nb, sb] = sizeRank(b.name ?? b);
    return ga - gb || na - nb || sa.localeCompare(sb);
  });

// SQL for one product search. facetMode leaves out the shopper's
// selections (category / subcategory / brand / size / colour / material
// / price) so facet counts stay stable while boxes are ticked.
const buildProductSql = ({ searchTypes, ctx, maxKm, tokens, filterDistrict, selection, facetMode, textMode, minPrice, maxPrice, inStockOnly, deliverableOnly }) => {
  const params = [searchTypes];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const latP = ctx.hasLocation ? add(ctx.latitude) : null;
  const lngP = ctx.hasLocation ? add(ctx.longitude) : null;
  const distExpr = ctx.hasLocation ? distanceSql(latP, lngP) : 'NULL::float';
  const districtP = add(ctx.district || null);
  const maxKmP = ctx.hasLocation ? add(maxKm) : null;

  const sel = facetMode ? { categories: [], subcategories: [], brands: [], sizes: [], colours: [], materials: [] } : selection;
  const sizesP = sel.sizes.length ? add(sel.sizes) : null;
  const coloursP = sel.colours.length ? add(sel.colours) : null;
  const materialsP = sel.materials.length ? add(sel.materials.map((m) => `%${likeEscape(m)}%`)) : null;

  const variantMatch = [
    'v.is_available', 'v.stock_quantity > 0',
    sizesP ? `lower(v.size) = ANY(${sizesP}::text[])` : null,
    coloursP ? `lower(v.colour) = ANY(${coloursP}::text[])` : null,
    materialsP ? `(lower(COALESCE(v.material, '')) LIKE ANY(${materialsP}::text[]) OR lower(COALESCE(p.material, '')) LIKE ANY(${materialsP}::text[]))` : null,
  ].filter(Boolean).join(' AND ');

  const effective = `CASE
    WHEN (CASE WHEN v.price IS NOT NULL THEN v.discount_price ELSE COALESCE(v.discount_price, p.discount_price) END) IS NOT NULL
     AND (CASE WHEN v.price IS NOT NULL THEN v.discount_price ELSE COALESCE(v.discount_price, p.discount_price) END) < COALESCE(v.price, p.price)
    THEN (CASE WHEN v.price IS NOT NULL THEN v.discount_price ELSE COALESCE(v.discount_price, p.discount_price) END)
    ELSE COALESCE(v.price, p.price) END`;
  const productEffective = '(CASE WHEN p.discount_price IS NOT NULL AND p.discount_price < p.price THEN p.discount_price ELSE p.price END)';

  const where = ["s.status = 'approved'", 's.business_type = ANY($1::text[])', 'p.is_available', 's.latitude IS NOT NULL'];
  const tokenParams = tokens.map((t) => add(`%${likeEscape(t)}%`));
  const nameMatch = tokenParams.map((tp) => `(CASE WHEN lower(p.product_name) LIKE ${tp} ESCAPE '\\' THEN 3 WHEN p.search_text LIKE ${tp} ESCAPE '\\' THEN 1 ELSE 0 END)`);
  // A word may also match the shop's name, city or district ("black shirt kandy")
  const shopText = "lower(s.shop_name || ' ' || COALESCE(s.city, '') || ' ' || COALESCE(s.area, '') || ' ' || COALESCE(s.district, ''))";
  const tokenMatch = (tp) => `(p.search_text LIKE ${tp} ESCAPE '\\' OR ${shopText} LIKE ${tp} ESCAPE '\\')`;
  const simP = tokens.length ? add(tokens.join(' ')) : null;

  if (sel.categories.length) where.push(`lower(p.category) = ANY(${add(sel.categories)}::text[])`);
  if (sel.subcategories.length) where.push(`lower(p.subcategory) = ANY(${add(sel.subcategories)}::text[])`);
  if (sel.brands.length) where.push(`lower(p.brand) = ANY(${add(sel.brands)}::text[])`);
  if (filterDistrict) where.push(`s.district = ${add(filterDistrict)}`);
  if (materialsP && !sizesP && !coloursP) {
    where.push(`(lower(COALESCE(p.material, '')) LIKE ANY(${materialsP}::text[]) OR vv.v_match)`);
  }
  if (sizesP || coloursP) where.push('vv.v_match');
  if (tokenParams.length && textMode === 'all') where.push(`(${tokenParams.map(tokenMatch).join(' AND ')})`);
  if (tokenParams.length && textMode === 'any') where.push(`(${tokenParams.map(tokenMatch).join(' OR ')})`);

  const deliverableExpr = `(
    (s.business_type = 'clothing' AND s.shop_delivery_enabled AND ${districtP}::text IS NOT NULL AND EXISTS (
      SELECT 1 FROM shop_delivery_zones z WHERE z.shop_id = s.id AND z.is_active AND z.district = ${districtP}::text))
    OR (s.offers_delivery AND (s.business_type <> 'grocery' OR s.is_open) AND ${ctx.hasLocation ? `${distExpr} <= ${maxKmP}` : 'FALSE'})
  )`;

  const base = `
    SELECT p.id, p.shop_id, s.business_type, p.product_name, p.brand, p.category, p.subcategory, p.material, p.gender,
           p.price, p.discount_price, p.image_url, p.is_featured, p.stock_quantity, p.has_variants, p.unit, vv.v_count,
           s.shop_name, s.image_url AS shop_logo, s.city AS shop_city, s.area AS shop_area, s.district AS shop_district,
           s.latitude AS shop_lat, s.longitude AS shop_lng,
           ${distExpr} AS distance_km,
           COALESCE(CASE WHEN vv.v_count > 0 THEN vv.v_min END, ${productEffective}) AS price_from,
           COALESCE(CASE WHEN vv.v_count > 0 THEN vv.v_max END, ${productEffective}) AS price_to,
           CASE WHEN s.business_type = 'restaurant' THEN TRUE
                WHEN s.business_type = 'grocery' THEN p.stock_quantity > 0
                WHEN vv.v_count > 0 THEN COALESCE(vv.v_stock, 0) > 0
                ELSE p.stock_quantity > 0 END AS in_stock,
           CASE WHEN vv.v_count > 0 THEN COALESCE(vv.v_stock, 0) ELSE p.stock_quantity END AS stock_total,
           vv.sizes, vv.colours,
           ${deliverableExpr} AS deliverable,
           (${nameMatch.length ? nameMatch.join(' + ') : '0'})
             + ${simP ? `similarity(lower(p.product_name), ${simP}) * 2` : '0'}
             + CASE WHEN p.is_featured THEN 0.3 ELSE 0 END AS score
    FROM products p
    JOIN shops s ON s.id = p.shop_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS v_count,
             MIN(${effective}) FILTER (WHERE ${variantMatch}) AS v_min,
             MAX(${effective}) FILTER (WHERE ${variantMatch}) AS v_max,
             SUM(v.stock_quantity) FILTER (WHERE v.is_available) AS v_stock,
             array_agg(DISTINCT v.size) FILTER (WHERE v.is_available AND v.stock_quantity > 0 AND v.size IS NOT NULL) AS sizes,
             array_agg(DISTINCT v.colour) FILTER (WHERE v.is_available AND v.stock_quantity > 0 AND v.colour IS NOT NULL) AS colours,
             COALESCE(bool_or(${variantMatch}), FALSE) AS v_match
      FROM product_variants v WHERE v.product_id = p.id
    ) vv ON TRUE
    WHERE ${where.join(' AND ')}`;

  const outer = [];
  if (inStockOnly) outer.push('in_stock');
  if (!facetMode && minPrice != null) outer.push(`price_from >= ${add(minPrice)}`);
  if (!facetMode && maxPrice != null) outer.push(`price_from <= ${add(maxPrice)}`);
  if (deliverableOnly) outer.push('deliverable');
  const outerWhere = outer.length ? `WHERE ${outer.join(' AND ')}` : '';

  return { base, outerWhere, params };
};

const searchProducts = async (req, res) => {
  try {
    const q = text(req.query.q, 80);
    const tokens = tokensOf(q);
    // Phase 61: 'all' = every category open to customers (61c: grocery too,
    // so the main search bar covers every approved shop in Sri Lanka)
    const type = req.query.type === 'all' ? 'all' : SEARCH_TYPES.includes(req.query.type) ? req.query.type : 'clothing';
    if (type !== 'all' && type !== 'grocery') {
      const block = await customerTypeBlock(type);
      if (block) return fail(res, block.status, block.message, block.code);
    }
    const searchTypes = type === 'all' ? ['grocery', ...(await openMerchantTypes())] : [type];
    const sort = SORTS.includes(req.query.sort) ? req.query.sort : 'relevance';
    const page = Math.max(1, Math.min(200, Number(req.query.page) || 1));
    const pageSize = Math.max(1, Math.min(PAGE_MAX, Number(req.query.pageSize) || 20));
    const minPrice = readNumber(req.query.minPrice);
    const maxPrice = readNumber(req.query.maxPrice);
    if (minPrice === undefined || maxPrice === undefined) return fail(res, 400, 'Enter a valid price range', 'BAD_PRICE');
    if (minPrice != null && maxPrice != null && minPrice > maxPrice) return fail(res, 400, 'The lowest price is above the highest price', 'BAD_PRICE');
    const filterDistrict = req.query.district ? normalizeDistrict(req.query.district) : null;
    if (req.query.district && !filterDistrict) return fail(res, 400, 'Choose a district from the list', 'BAD_DISTRICT');
    const selection = readSelection(req.query);
    const browse = req.query.browse === '1' || req.query.browse === 'true';
    if (!tokens.length && !browse && !selection.categories.length && !selection.brands.length && !selection.subcategories.length) {
      return fail(res, 400, 'Type what you are looking for (at least 2 letters)', 'QUERY_TOO_SHORT');
    }
    if (tokens.length && tokens.every((t) => t.length < 2)) return fail(res, 400, 'Type at least 2 letters', 'QUERY_TOO_SHORT');

    const ctx = await customerContext(req.query);
    const settings = await getPricingSettings();
    const maxKm = Number(settings.delivery.maxKm);
    const inStockOnly = req.query.inStock !== '0';
    const deliverableOnly = req.query.delivery === 'available';
    if (deliverableOnly && !ctx.hasLocation && !ctx.district) {
      return fail(res, 400, 'Choose a delivery address to filter by delivery', 'LOCATION_REQUIRED');
    }

    const common = { searchTypes, ctx, maxKm, tokens, filterDistrict, selection, minPrice, maxPrice, inStockOnly, deliverableOnly };
    const orderBy = {
      relevance: 'score DESC, in_stock DESC, distance_km ASC NULLS LAST, id',
      recommended: 'in_stock DESC, deliverable DESC, score DESC, distance_km ASC NULLS LAST, id',
      price_asc: 'price_from ASC, score DESC, id',
      price_desc: 'price_from DESC, score DESC, id',
      distance: 'distance_km ASC NULLS LAST, score DESC, id',
      delivery: 'deliverable DESC, distance_km ASC NULLS LAST, score DESC, id',
    }[sort];

    const run = async (textMode) => {
      const { base, outerWhere, params } = buildProductSql({ ...common, facetMode: false, textMode });
      return (
        await pool.query(
          `SELECT *, COUNT(*) OVER () AS total FROM (${base}) r ${outerWhere}
           ORDER BY ${orderBy} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
          params
        )
      ).rows;
    };

    let relaxed = false;
    let textMode = tokens.length ? 'all' : null;
    let rows = await run(textMode);
    if (!rows.length && tokens.length > 1 && page === 1) {
      rows = await run('any');
      relaxed = rows.length > 0;
      if (relaxed) textMode = 'any';
    }
    const total = rows.length ? Number(rows[0].total) : 0;

    // Grocery prices include the shop's live offers (same as the shop page)
    const groceryRows = rows.filter((r) => r.business_type === 'grocery');
    const groceryPriced = new Map(
      groceryRows.length
        ? (await applyOffersToProducts(groceryRows.map((r) => ({ id: r.id, shop_id: r.shop_id, price: r.price, category: r.category, product_name: r.product_name, unit: r.unit }))))
            .map((p) => [Number(p.id), p])
        : []
    );

    // Delivery options for the shops on this page
    const shopIds = [...new Set(rows.map((r) => Number(r.shop_id)))];
    const shops = new Map(
      (await pool.query('SELECT * FROM shops WHERE id = ANY($1)', [shopIds])).rows.map((s) => [Number(s.id), s])
    );
    const zones = await zonesFor(shopIds);
    const delivery = new Map();
    for (const id of shopIds) {
      const shop = shops.get(id);
      const options = await deliveryOptionsFor({
        shop, zones: zones.get(id), latitude: ctx.latitude, longitude: ctx.longitude, district: ctx.district, route: false, settings,
      });
      const availability = availabilityOf(shop, await activeMerchantOrders(id));
      delivery.set(id, { options, ...deliverySummary(options), acceptingOrders: availability.acceptingOrders || (availability.reason === 'closed' && shop.shop_delivery_enabled), notAcceptingReason: availability.reason });
    }

    // Facets (first page): counts ignore the shopper's own selections
    let facets = null;
    if (page === 1) {
      const { base, outerWhere, params } = buildProductSql({ ...common, facetMode: true, textMode });
      const f = (
        await pool.query(
          `WITH r AS (SELECT * FROM (${base}) q ${outerWhere})
           SELECT
             (SELECT json_agg(json_build_object('name', category, 'count', n)) FROM (SELECT category, COUNT(*) AS n FROM r WHERE category IS NOT NULL GROUP BY category) c) AS categories,
             (SELECT json_agg(json_build_object('category', category, 'name', subcategory, 'count', n)) FROM (SELECT category, subcategory, COUNT(*) AS n FROM r WHERE subcategory IS NOT NULL GROUP BY category, subcategory) c) AS subcategories,
             (SELECT json_agg(json_build_object('name', brand, 'count', n)) FROM (SELECT brand, COUNT(*) AS n FROM r WHERE brand IS NOT NULL GROUP BY brand) b) AS brands,
             (SELECT json_agg(json_build_object('name', material, 'count', n)) FROM (SELECT material, COUNT(*) AS n FROM r WHERE material IS NOT NULL GROUP BY material) m) AS materials,
             (SELECT json_agg(json_build_object('name', shop_district, 'count', n)) FROM (SELECT shop_district, COUNT(*) AS n FROM r WHERE shop_district IS NOT NULL GROUP BY shop_district) d) AS districts,
             (SELECT json_agg(json_build_object('name', x, 'count', n)) FROM (SELECT x, COUNT(*) AS n FROM r, unnest(r.sizes) x GROUP BY x) s) AS sizes,
             (SELECT json_agg(json_build_object('name', x, 'count', n)) FROM (SELECT x, COUNT(*) AS n FROM r, unnest(r.colours) x GROUP BY x) s) AS colours,
             (SELECT MIN(price_from) FROM r) AS min_price,
             (SELECT MAX(price_from) FROM r) AS max_price`,
          params
        )
      ).rows[0];
      const byCount = (list) => (list || []).filter((x) => x && x.name).map((x) => ({ ...x, count: Number(x.count) }))
        .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
      const byName = (list) => (list || []).filter((x) => x && x.name).map((x) => ({ ...x, count: Number(x.count) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const subs = (f.subcategories || []).map((x) => ({ ...x, count: Number(x.count) }));
      const categoryTree = byCount(f.categories).map((c) => ({
        name: c.name,
        count: c.count,
        subcategories: subs.filter((s) => s.category === c.name).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).map(({ name, count }) => ({ name, count })),
      }));
      const sizes = sortSizes(byName(f.sizes));
      facets = {
        // names only (phase 60 shape, still used by older app builds)
        brands: byName(f.brands).map((x) => x.name).slice(0, 40),
        categories: byName(f.categories).map((x) => x.name),
        subcategories: [...new Set(subs.map((s) => s.name))].sort().slice(0, 40),
        materials: byName(f.materials).map((x) => x.name).slice(0, 30),
        districts: byName(f.districts).map((x) => x.name),
        sizes: sizes.map((x) => x.name).slice(0, 40),
        colours: byName(f.colours).map((x) => x.name).slice(0, 40),
        priceRange: f.min_price != null ? { min: round2(f.min_price), max: round2(f.max_price) } : null,
        // Phase 61b: counts (products matching the search, before your own ticks)
        counts: {
          categories: categoryTree,
          brands: byCount(f.brands).slice(0, 40),
          sizes: sizes.slice(0, 40),
          colours: byCount(f.colours).slice(0, 40),
          materials: byCount(f.materials).slice(0, 30),
          districts: byCount(f.districts),
        },
      };
    }

    return res.json({
      success: true,
      query: { q: q || null, tokens, type, sort, relaxed, browse },
      selection,
      customer: { district: ctx.district, districtSource: ctx.source, hasLocation: ctx.hasLocation },
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      facets,
      results: rows.map((r) => {
        const d = delivery.get(Number(r.shop_id));
        const g = r.business_type === 'grocery' ? groceryPriced.get(Number(r.id)) : null;
        const shopDistrict = r.shop_district || (r.shop_lat != null ? nearestDistrict(Number(r.shop_lat), Number(r.shop_lng)) : null);
        return {
          productId: Number(r.id),
          name: r.product_name,
          brand: r.brand || null,
          category: r.category,
          subcategory: r.subcategory || null,
          material: r.material || null,
          imageUrl: r.image_url || null,
          price: round2(r.price),
          discountPrice: g ? (g.offer ? round2(g.price) : null) : r.discount_price != null ? round2(r.discount_price) : null,
          priceFrom: g ? round2(g.price) : round2(r.price_from),
          priceTo: g ? round2(g.price) : round2(r.price_to),
          unit: r.business_type === 'grocery' ? r.unit || null : null,
          offer: g?.offer || null,
          hasVariants: Number(r.v_count) > 0,
          sizes: sortSizes((r.sizes || []).filter(Boolean)),
          colours: (r.colours || []).filter(Boolean),
          inStock: !!r.in_stock,
          stock: Number(r.stock_total) || 0,
          lowStock: !!r.in_stock && Number(r.stock_total) <= 5 && isRetail(r.business_type),
          businessType: r.business_type,
          shop: {
            id: Number(r.shop_id),
            name: r.shop_name,
            logoUrl: r.shop_logo || null,
            city: r.shop_city || r.shop_area || null,
            district: shopDistrict,
            // grocery shops have no district on file: nearest district centre
            districtApproximate: !r.shop_district && !!shopDistrict,
            distanceKm: r.distance_km != null ? Number(Number(r.distance_km).toFixed(1)) : null,
            acceptingOrders: d?.acceptingOrders ?? false,
          },
          delivery: d
            ? { deliverable: d.deliverable, summary: d.summary, cheapestFee: d.cheapestFee, pickup: d.pickup, methods: d.methods || [] }
            : null,
        };
      }),
    });
  } catch (error) {
    console.error('❌ NATIONWIDE PRODUCT SEARCH ERROR:', error.message);
    return fail(res, 500, "Search isn't working right now. Please try again.");
  }
};

// -----------------------------------------------------
// Suggestions while typing (search box)
//   GET /marketplace/search/suggest?q&type
//   -> { terms: [{ label, kind, filter, count }], products: [light card] }
// Terms are real categories / subcategories / brands of in-stock items;
// products are the closest name matches (at most 6).
// -----------------------------------------------------

const suggest = async (req, res) => {
  try {
    const q = text(req.query.q, 60) || '';
    const type = req.query.type === 'all' ? 'all' : SEARCH_TYPES.includes(req.query.type) ? req.query.type : 'clothing';
    if (type !== 'all' && type !== 'grocery') {
      const block = await customerTypeBlock(type);
      if (block) return fail(res, block.status, block.message, block.code);
    }
    const types = type === 'all' ? ['grocery', ...(await openMerchantTypes())] : [type];
    // Suggestions use what was typed as-is ("to" -> Tops, Totes), not the
    // search stop-word list
    const raw = q.toLowerCase().replace(/[^a-z0-9\u0D80-\u0DFF\u0B80-\u0BFF\s-]/g, ' ').trim();
    const tokens = raw ? [...new Set(raw.split(/\s+/).filter(Boolean))].slice(0, 6) : [];
    const sellable = `(s.business_type = 'restaurant' OR (s.business_type = 'grocery' AND p.stock_quantity > 0) OR (s.business_type <> 'grocery' AND EXISTS (
        SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_available AND v.stock_quantity > 0)
      OR (s.business_type <> 'grocery' AND NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id) AND p.stock_quantity > 0)))`;
    const base = `FROM products p JOIN shops s ON s.id = p.shop_id
      WHERE s.status = 'approved' AND s.business_type = ANY($1::text[]) AND p.is_available AND ${sellable}`;

    // No text yet: the most stocked categories
    if (!tokens.length) {
      const rows = (
        await pool.query(`SELECT p.category AS label, COUNT(*)::int AS n ${base} AND p.category IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 8`, [types])
      ).rows;
      return res.json({ success: true, q, terms: rows.map((r) => ({ label: r.label, kind: 'category', filter: { category: r.label }, count: r.n })), products: [] });
    }

    const last = tokens[tokens.length - 1];
    const startP = `${likeEscape(last)}%`;
    const anyP = `%${likeEscape(last)}%`;
    const terms = (
      await pool.query(
        `SELECT kind, label, parent, SUM(n)::int AS n, BOOL_OR(starts) AS starts FROM (
           SELECT 'category' AS kind, p.category AS label, NULL::text AS parent, 1 AS n, lower(p.category) LIKE $2 ESCAPE '\\' AS starts
             ${base} AND lower(p.category) LIKE $3 ESCAPE '\\'
           UNION ALL
           SELECT 'subcategory', p.subcategory, p.category, 1, lower(p.subcategory) LIKE $2 ESCAPE '\\'
             ${base} AND lower(p.subcategory) LIKE $3 ESCAPE '\\'
           UNION ALL
           SELECT 'brand', p.brand, NULL, 1, lower(p.brand) LIKE $2 ESCAPE '\\'
             ${base} AND lower(p.brand) LIKE $3 ESCAPE '\\'
         ) t WHERE label IS NOT NULL
         GROUP BY kind, label, parent
         ORDER BY BOOL_OR(starts) DESC, SUM(n) DESC, label
         LIMIT 8`,
        [types, startP, anyP]
      )
    ).rows;

    const params = [types];
    const conds = tokens.map((t) => {
      params.push(`%${likeEscape(t)}%`);
      return `p.search_text LIKE $${params.length} ESCAPE '\\'`;
    });
    params.push(tokens.join(' '));
    const simP = `$${params.length}`;
    // Name matches first ("dr" -> dresses before a hoodie whose description matched)
    const nameRank = tokens.map((t, i) => `(CASE WHEN lower(p.product_name) LIKE $${i + 2} ESCAPE '\\' THEN 1 ELSE 0 END)`).join(' + ');
    const products = (
      await pool.query(
        `SELECT p.id, p.product_name, p.brand, p.image_url, p.price, p.discount_price, p.category, s.business_type,
                s.id AS shop_id, s.shop_name, s.district,
                (SELECT MIN(CASE WHEN COALESCE(v.discount_price, CASE WHEN v.price IS NULL THEN p.discount_price END) IS NOT NULL
                                  AND COALESCE(v.discount_price, CASE WHEN v.price IS NULL THEN p.discount_price END) < COALESCE(v.price, p.price)
                                 THEN COALESCE(v.discount_price, CASE WHEN v.price IS NULL THEN p.discount_price END)
                                 ELSE COALESCE(v.price, p.price) END)
                   FROM product_variants v WHERE v.product_id = p.id AND v.is_available AND v.stock_quantity > 0) AS variant_from
         ${base} AND ${conds.join(' AND ')}
         ORDER BY (${nameRank}) DESC, similarity(lower(p.product_name), ${simP}) DESC, p.is_featured DESC, p.id
         LIMIT 6`,
        params
      )
    ).rows;

    const effective = (r) => (r.discount_price != null && Number(r.discount_price) < Number(r.price) ? Number(r.discount_price) : Number(r.price));
    return res.json({
      success: true,
      q,
      terms: terms.map((r) => ({
        label: r.label,
        kind: r.kind,
        parent: r.parent || null,
        count: r.n,
        filter: r.kind === 'brand' ? { brand: r.label } : r.kind === 'subcategory' ? { category: r.parent, subcategory: r.label } : { category: r.label },
      })),
      products: products.map((r) => ({
        productId: Number(r.id),
        name: r.product_name,
        brand: r.brand || null,
        category: r.category,
        businessType: r.business_type,
        imageUrl: r.image_url || null,
        priceFrom: round2(r.variant_from != null ? r.variant_from : effective(r)),
        shop: { id: Number(r.shop_id), name: r.shop_name, district: r.district || null },
      })),
    });
  } catch (error) {
    console.error('❌ SEARCH SUGGEST ERROR:', error.message);
    return fail(res, 500, "Suggestions aren't available right now.");
  }
};

// -----------------------------------------------------
// Shops
// -----------------------------------------------------

const searchShops = async (req, res) => {
  try {
    const q = text(req.query.q, 80);
    const tokens = tokensOf(q);
    const typeParam = String(req.query.type || '');
    const open = await openMerchantTypes();
    if (MERCHANT_TYPES.includes(typeParam) && !open.includes(typeParam)) {
      const block = await customerTypeBlock(typeParam);
      return fail(res, block.status, block.message, block.code);
    }
    const types = typeParam === 'all' ? ['grocery', ...open] : MERCHANT_TYPES.includes(typeParam) || typeParam === 'grocery' ? [typeParam] : open;
    const sort = ['relevance', 'distance', 'name'].includes(req.query.sort) ? req.query.sort : 'relevance';
    const page = Math.max(1, Math.min(200, Number(req.query.page) || 1));
    const pageSize = Math.max(1, Math.min(PAGE_MAX, Number(req.query.pageSize) || 20));
    const district = req.query.district ? normalizeDistrict(req.query.district) : null;
    if (req.query.district && !district) return fail(res, 400, 'Choose a district from the list', 'BAD_DISTRICT');
    const city = text(req.query.city, 60);

    const ctx = await customerContext(req.query);
    const settings = await getPricingSettings();
    const params = [types];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    const distExpr = ctx.hasLocation ? distanceSql(add(ctx.latitude), add(ctx.longitude)) : 'NULL::float';
    const where = ["s.status = 'approved'", 's.business_type = ANY($1)', 's.latitude IS NOT NULL'];
    if (district) where.push(`s.district = ${add(district)}`);
    if (city) where.push(`(lower(COALESCE(s.city, '')) LIKE ${add(`%${likeEscape(city.toLowerCase())}%`)} ESCAPE '\\' OR lower(COALESCE(s.area, '')) LIKE $${params.length} ESCAPE '\\')`);

    let scoreSql = '0';
    if (tokens.length) {
      const parts = tokens.map((t) => {
        const tp = add(`%${likeEscape(t)}%`);
        return {
          match: `(lower(s.shop_name) LIKE ${tp} ESCAPE '\\' OR lower(COALESCE(s.description, '')) LIKE ${tp} ESCAPE '\\'
                   OR lower(COALESCE(s.city, '')) LIKE ${tp} ESCAPE '\\' OR lower(COALESCE(s.district, '')) LIKE ${tp} ESCAPE '\\'
                   OR lower(s.business_type) LIKE ${tp} ESCAPE '\\'
                   OR EXISTS (SELECT 1 FROM products p WHERE p.shop_id = s.id AND p.is_available AND p.search_text LIKE ${tp} ESCAPE '\\'))`,
          score: `(CASE WHEN lower(s.shop_name) LIKE ${tp} ESCAPE '\\' THEN 3 ELSE 1 END)`,
        };
      });
      where.push(parts.map((p) => p.match).join(' AND '));
      scoreSql = parts.map((p) => p.score).join(' + ');
    }
    const orderBy = { relevance: 'score DESC, distance_km ASC NULLS LAST, s.shop_name', distance: 'distance_km ASC NULLS LAST, s.shop_name', name: 's.shop_name' }[sort];

    const rows = (
      await pool.query(
        `SELECT s.*, ${distExpr} AS distance_km, ${scoreSql} AS score,
                (SELECT COUNT(*)::int FROM products p WHERE p.shop_id = s.id AND p.is_available) AS product_count,
                COUNT(*) OVER () AS total
         FROM shops s
         WHERE ${where.join(' AND ')}
           AND (s.business_type = 'grocery' OR EXISTS (SELECT 1 FROM products p WHERE p.shop_id = s.id AND p.is_available))
         ORDER BY ${orderBy}
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      )
    ).rows;
    const total = rows.length ? Number(rows[0].total) : 0;
    const zones = await zonesFor(rows.map((r) => r.id));

    const shops = [];
    for (const row of rows) {
      const options = await deliveryOptionsFor({
        shop: row, zones: zones.get(Number(row.id)), latitude: ctx.latitude, longitude: ctx.longitude, district: ctx.district, route: false, settings,
      });
      // Grocery: GetMe shoppers shop locally only
      const summary = row.business_type === 'grocery'
        ? { deliverable: row.distance_km != null && row.distance_km <= 10, summary: 'Nearby grocery delivery only', cheapestFee: null, pickup: false }
        : deliverySummary(options);
      shops.push({
        ...publicShop(row, { activeCount: await activeMerchantOrders(row.id) }),
        distanceKm: row.distance_km != null ? Number(Number(row.distance_km).toFixed(1)) : null,
        productCount: Number(row.product_count) || 0,
        delivery: { ...summary, methods: summary.methods || [], shopDeliveryDistricts: (zones.get(Number(row.id)) || []).length },
      });
    }

    return res.json({
      success: true,
      customer: { district: ctx.district, districtSource: ctx.source, hasLocation: ctx.hasLocation },
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      shops,
    });
  } catch (error) {
    console.error('❌ NATIONWIDE SHOP SEARCH ERROR:', error.message);
    return fail(res, 500, "Shop search isn't working right now. Please try again.");
  }
};

// -----------------------------------------------------
// Delivery options for one shop -> one address
// -----------------------------------------------------

const getDeliveryOptions = async (req, res) => {
  try {
    const shop = (await pool.query("SELECT * FROM shops WHERE id = $1 AND status = 'approved'", [toId(req.query.shopId)])).rows[0];
    if (!shop) return fail(res, 404, 'This store is not available on GetMe', 'NOT_FOUND');
    const block = await customerTypeBlock(shop.business_type);
    if (block) return fail(res, block.status, block.message, block.code);
    const ctx = await customerContext(req.query);
    const options = await deliveryOptionsFor({ shop, latitude: ctx.latitude, longitude: ctx.longitude, district: ctx.district, route: true });
    return res.json({
      success: true,
      shopId: Number(shop.id),
      customer: { district: ctx.district, districtSource: ctx.source, hasLocation: ctx.hasLocation },
      options,
      ...deliverySummary(options),
    });
  } catch (error) {
    console.error('❌ DELIVERY OPTIONS ERROR:', error.message);
    return fail(res, 500, "Couldn't check delivery right now. Please try again.");
  }
};

const getDistricts = (req, res) => res.json({ success: true, provinces: PROVINCES });

module.exports = { searchProducts, suggest, searchShops, getDeliveryOptions, getDistricts, tokensOf };
