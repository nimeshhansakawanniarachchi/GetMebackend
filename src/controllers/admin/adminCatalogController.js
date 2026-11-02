const pool = require('../../config/db');

const { readPage, pageMeta } = require('../../utils/pagination');

const { emitToAdmins, broadcastCatalogChange } = require('../../realtime');
const { applyOffersToProducts } = require('../../pricing/offers');
// Phase 47: onboarding progress + account manager on the shops list
const { DONE_COUNT_SQL: ONBOARDING_DONE_SQL, TOTAL_ITEMS: ONBOARDING_TOTAL } = require('../../shops/onboarding');

const {
  MIN_WHITE_CONTRAST,
  normalizeBrandColor,
  whiteContrast,
} = require('../../utils/brandColor');

// Phase 59: under_review = the business sent its documents for review
const SHOP_STATUSES = ['pending', 'under_review', 'approved', 'rejected', 'suspended'];
const BUSINESS_TYPES = ['grocery', 'clothing', 'restaurant', 'liquor'];


// =====================================================
// SHOPS
// GET /api/admin/shops?status=&search=&page=&onboarding=incomplete|complete
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

    // Phase 59: business category, and branches of one business
    if (BUSINESS_TYPES.includes(req.query.type)) {
      params.push(req.query.type);
      where.push(`s.business_type = $${params.length}`);
    }

    if (/^\d+$/.test(String(req.query.parent || ''))) {
      params.push(Number(req.query.parent));
      where.push(`(s.parent_shop_id = $${params.length} OR s.id = $${params.length})`);
    }

    const search = String(req.query.search || '').trim().toLowerCase();

    if (search) {
      params.push(`%${search}%`);
      where.push(`(LOWER(s.shop_name) LIKE $${params.length} OR LOWER(s.email) LIKE $${params.length} OR LOWER(COALESCE(s.address, '')) LIKE $${params.length})`);
    }

    // Phase 47: complete = every onboarding item done (computed live)
    if (req.query.onboarding === 'complete') {
      where.push(`${ONBOARDING_DONE_SQL} = ${ONBOARDING_TOTAL}`);
    } else if (req.query.onboarding === 'incomplete') {
      where.push(`${ONBOARDING_DONE_SQL} < ${ONBOARDING_TOTAL}`);
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
        ) AS sales,
        ${ONBOARDING_DONE_SQL} AS onboarding_done,
        s.onboarding_completed_at,
        s.business_type, s.parent_shop_id, s.city, s.submitted_at, s.status_reason,
        (SELECT COUNT(*)::int FROM shops b WHERE b.parent_shop_id = s.id) AS branch_count,
        (
          SELECT COUNT(*)::int FROM business_document_types dt
          WHERE dt.business_type = s.business_type AND dt.required AND dt.is_active
            AND NOT EXISTS (
              SELECT 1 FROM shop_documents d
              WHERE d.shop_id = s.id AND d.doc_key = dt.doc_key AND d.status <> 'rejected'
            )
        ) AS missing_documents,
        am.id AS manager_id, am.full_name AS manager_name
      FROM shops s
      LEFT JOIN admins am ON am.id = s.account_manager_admin_id
      ${whereSql}
      ORDER BY
        CASE s.status WHEN 'under_review' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
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
        businessType: row.business_type || 'grocery',
        parentShopId: row.parent_shop_id != null ? Number(row.parent_shop_id) : null,
        branchCount: Number(row.branch_count) || 0,
        city: row.city || null,
        submittedAt: row.submitted_at || null,
        statusReason: row.status_reason || null,
        missingDocuments: Number(row.missing_documents) || 0,
        documentsComplete: Number(row.missing_documents) === 0,
        accountManager: row.manager_id ? { id: row.manager_id, name: row.manager_name } : null,
        onboarding: {
          done: Number(row.onboarding_done),
          total: ONBOARDING_TOTAL,
          complete: Number(row.onboarding_done) === ONBOARDING_TOTAL,
          completedAt: row.onboarding_completed_at,
        },
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

    // Phase 59: why a business was rejected / suspended (shown to it);
    // required for clothing shops and restaurants
    const reason = String(req.body?.reason || '').trim().slice(0, 500) || null;
    const current = (await pool.query('SELECT business_type FROM shops WHERE id = $1', [shopId])).rows[0];

    if (current && current.business_type !== 'grocery' && ['rejected', 'suspended'].includes(status) && !reason) {
      return res.status(400).json({ success: false, code: 'REASON_REQUIRED', message: 'Enter a reason for the business' });
    }

    const result = await pool.query(
      `
      UPDATE shops SET status = $1::varchar, updated_at = NOW(),
        status_reason = CASE WHEN $1::varchar IN ('rejected', 'suspended') THEN $3::varchar ELSE NULL END,
        reviewed_at = CASE WHEN $1::varchar IN ('approved', 'rejected') THEN NOW() ELSE reviewed_at END
      WHERE id = $2
      RETURNING id, status, business_type, status_reason
      `,
      [status, shopId, reason]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Shop not found' });
    }

    const io = req.app.get('io');

    io?.to(`shop:${shopId}`).emit('shop:status-changed', { status });
    // A suspended / rejected shop's open sockets close (B-14); its API
    // calls are already refused by shopAuthMiddleware
    if (status === 'suspended' || status === 'rejected') {
      setTimeout(() => io?.in(`shop:${shopId}`).disconnectSockets(true), 500);
    }
    emitToAdmins(io, 'admin:shops-updated', { shopId, reason: 'status' });
    // Approved / suspended changes what customers can see
    broadcastCatalogChange(io, shopId, 'shop');

    // Approving with documents not yet accepted is allowed (an admin
    // decision) but flagged
    const warnings = [];
    if (status === 'approved' && result.rows[0].business_type !== 'grocery') {
      const pending = (
        await pool.query(
          `SELECT dt.label FROM business_document_types dt
           WHERE dt.business_type = $2 AND dt.required AND dt.is_active
             AND NOT EXISTS (SELECT 1 FROM shop_documents d WHERE d.shop_id = $1 AND d.doc_key = dt.doc_key AND d.status = 'accepted')`,
          [shopId, result.rows[0].business_type]
        )
      ).rows.map((row) => row.label);
      if (pending.length) warnings.push(`Approved without these accepted documents: ${pending.join(', ')}`);
    }

    return res.json({ success: true, shop: result.rows[0], warnings });
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
