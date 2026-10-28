const pool = require('../../config/db');

const { readPage, pageMeta } = require('../../utils/pagination');

const { emitToAdmins, broadcastCatalogChange } = require('../../realtime');
const { applyOffersToProducts } = require('../../pricing/offers');

const {
  MIN_WHITE_CONTRAST,
  normalizeBrandColor,
  whiteContrast,
} = require('../../utils/brandColor');

const SHOP_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];


// =====================================================
// SHOPS
// GET /api/admin/shops?status=&search=&page=
// =====================================================

const listShops = async (req, res) => {
  try {
    const paging = readPage(req.query);
    const where = [];
    const params = [];

    if (SHOP_STATUSES.includes(req.query.status)) {
      params.push(req.query.status);
      where.push(`s.status = $${params.length}`);
    }

    const search = String(req.query.search || '').trim().toLowerCase();

    if (search) {
      params.push(`%${search}%`);
      where.push(`(LOWER(s.shop_name) LIKE $${params.length} OR LOWER(s.email) LIKE $${params.length} OR LOWER(COALESCE(s.address, '')) LIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM shops s ${whereSql}`,
      params
    );

    const listParams = [...params, paging.pageSize, paging.offset];

    const result = await pool.query(
      `
      SELECT
        s.id, s.shop_name, s.email, s.mobile, s.address, s.area, s.status, s.is_open,
        s.image_url, s.brand_color, s.latitude, s.longitude, s.created_at,
        (SELECT COUNT(*)::int FROM products p WHERE p.shop_id = s.id) AS product_count,
        (SELECT COUNT(*)::int FROM order_shops os WHERE os.shop_id = s.id) AS order_count,
        (
          SELECT COALESCE(SUM(oi.price * oi.quantity), 0)::float
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE oi.shop_id = s.id AND o.status = 'delivered'
        ) AS sales
      FROM shops s
      ${whereSql}
      ORDER BY
        CASE s.status WHEN 'pending' THEN 0 ELSE 1 END,
        s.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    return res.json({
      success: true,
      ...pageMeta(paging, countResult.rows[0].total),
      shops: result.rows.map((row) => ({
        id: row.id,
        shopName: row.shop_name,
        email: row.email,
        mobile: row.mobile,
        address: row.address,
        area: row.area,
        status: row.status,
        isOpen: row.is_open,
        imageUrl: row.image_url,
        brandColor: row.brand_color,
        latitude: row.latitude,
        longitude: row.longitude,
        productCount: row.product_count,
        orderCount: row.order_count,
        sales: row.sales,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin listShops error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load shops' });
  }
};


// =====================================================
// SHOP STATUS
// PATCH /api/admin/shops/:id/status { status }
// =====================================================

const setShopStatus = async (req, res) => {
  try {
    const shopId = Number(req.params.id);
    const status = String(req.body?.status || '');

    if (!Number.isInteger(shopId) || !SHOP_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid request' });
    }

    const result = await pool.query(
      `
      UPDATE shops SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, status
      `,
      [status, shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    const io = req.app.get('io');

    io?.to(`shop:${shopId}`).emit('shop:status-changed', { status });
    emitToAdmins(io, 'admin:shops-updated', { shopId, reason: 'status' });
    // Approved / suspended changes what customers can see
    broadcastCatalogChange(io, shopId, 'shop');

    return res.json({ success: true, shop: result.rows[0] });
  } catch (error) {
    console.error('❌ admin setShopStatus error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update shop' });
  }
};


// =====================================================
// SHOP BRAND COLOR
// PATCH /api/admin/shops/:id/brand-color { brandColor: "#RRGGBB" | null }
// null clears it (the customer app picks a color).
// =====================================================

const setShopBrandColor = async (req, res) => {
  try {
    const shopId = Number(req.params.id);
    const raw = req.body?.brandColor;
    const clearing = raw === null || raw === '';
    const brandColor = clearing ? null : normalizeBrandColor(raw);

    if (!Number.isInteger(shopId) || (!clearing && !brandColor)) {
      return res.status(400).json({ success: false, message: 'Enter a color like #0060A9.' });
    }

    if (brandColor && whiteContrast(brandColor) < MIN_WHITE_CONTRAST) {
      return res.status(400).json({
        success: false,
        message: 'This color is too light for white text. Pick a darker shade.',
      });
    }

    const result = await pool.query(
      `
      UPDATE shops SET brand_color = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, brand_color
      `,
      [brandColor, shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    emitToAdmins(req.app.get('io'), 'admin:shops-updated', { shopId, reason: 'brand-color' });
    broadcastCatalogChange(req.app.get('io'), shopId, 'shop');

    return res.json({
      success: true,
      shop: { id: result.rows[0].id, brandColor: result.rows[0].brand_color },
    });
  } catch (error) {
    console.error('❌ admin setShopBrandColor error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update shop' });
  }
};


// =====================================================
// PRODUCTS
// GET /api/admin/products?shopId=&category=&availability=available|unavailable
//   &search=&page=
// =====================================================

const listProducts = async (req, res) => {
  try {
    const paging = readPage(req.query, 25);
    const where = [];
    const params = [];

    const shopId = Number(req.query.shopId);

    if (Number.isInteger(shopId) && shopId > 0) {
      params.push(shopId);
      where.push(`p.shop_id = $${params.length}`);
    }

    if (req.query.category) {
      params.push(String(req.query.category));
      where.push(`p.category = $${params.length}`);
    }

    if (req.query.availability === 'available') {
      where.push('p.is_available = true AND p.stock_quantity > 0');
    } else if (req.query.availability === 'unavailable') {
      where.push('(p.is_available = false OR p.stock_quantity <= 0)');
    }

    const search = String(req.query.search || '').trim().toLowerCase();

    if (search) {
      params.push(`%${search}%`);
      where.push(`(LOWER(p.product_name) LIKE $${params.length} OR LOWER(s.shop_name) LIKE $${params.length} OR COALESCE(p.barcode, '') LIKE $${params.length})`);
    }

    // pricing=missing: no price set (Rs 0); pricing=offer: a live offer covers it
    if (req.query.pricing === 'missing') where.push('p.price <= 0');
    if (req.query.pricing === 'offer') {
      where.push(`EXISTS (
        SELECT 1 FROM product_offers o
        WHERE o.shop_id = p.shop_id
          AND o.is_active AND NOT o.paused_by_admin
          AND o.starts_at <= NOW() AND (o.ends_at IS NULL OR o.ends_at > NOW())
          AND (o.scope = 'shop' OR (o.scope = 'product' AND o.product_id = p.id)
               OR (o.scope = 'category' AND LOWER(TRIM(o.category)) = LOWER(TRIM(p.category))))
      )`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const fromSql = `FROM products p JOIN shops s ON s.id = p.shop_id ${whereSql}`;

    const [countResult, categoriesResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total ${fromSql}`, params),
      pool.query('SELECT DISTINCT category FROM products WHERE category IS NOT NULL ORDER BY category'),
    ]);

    const listParams = [...params, paging.pageSize, paging.offset];

    const result = await pool.query(
      `
      SELECT p.*, s.shop_name
      ${fromSql}
      ORDER BY p.created_at DESC
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    // What customers pay now (live offers), next to the shelf price
    const priced = await applyOffersToProducts(result.rows);

    return res.json({
      success: true,
      ...pageMeta(paging, countResult.rows[0].total),
      categories: categoriesResult.rows.map((row) => row.category),
      products: result.rows.map((row, index) => ({
        id: row.id,
        shopId: row.shop_id,
        shopName: row.shop_name,
        productName: row.product_name,
        category: row.category,
        price: Number(row.price || 0),
        customerPrice: Number(priced[index].price || 0),
        offer: priced[index].offer
          ? { id: priced[index].offer.id, label: priced[index].offer.label, endsAt: priced[index].offer.endsAt || null }
          : null,
        priceUpdatedAt: row.price_updated_at || null,
        barcode: row.barcode || null,
        unit: row.unit || 'item',
        stockQuantity: Number(row.stock_quantity || 0),
        isAvailable: row.is_available !== false,
        imageUrl: row.image_url,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin listProducts error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load products' });
  }
};


// =====================================================
// HIDE / SHOW PRODUCT (moderation)
// PATCH /api/admin/products/:id/availability { isAvailable }
// =====================================================

const setProductAvailability = async (req, res) => {
  const productId = Number(req.params.id);

  if (!Number.isInteger(productId) || typeof req.body?.isAvailable !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Invalid request' });
  }

  try {
    const result = await pool.query(
      `
      UPDATE products SET is_available = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, shop_id, is_available
      `,
      [req.body.isAvailable, productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    broadcastCatalogChange(req.app.get('io'), result.rows[0].shop_id, 'products');

    return res.json({
      success: true,
      product: { id: result.rows[0].id, isAvailable: result.rows[0].is_available },
    });
  } catch (error) {
    console.error('❌ admin setProductAvailability error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update product' });
  }
};

module.exports = {
  listShops,
  setShopStatus,
  setShopBrandColor,
  listProducts,
  setProductAvailability,
};
