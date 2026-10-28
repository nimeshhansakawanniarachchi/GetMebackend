const pool = require('../../config/db');
const { recordChange } = require('../../inventory/stockService');
const { actorOf } = require('../../middleware/shopAccess');
const { applyOffersToProducts, offerStatus } = require('../../pricing/offers');
const { recordPriceChange, isSuspiciousChange, changePercent } = require('../../pricing/history');

const { toProduct } = require('./shopFormat');
const {
  barcodeKey,
  barcodeFormat,
  isManufacturerBarcode,
} = require('../../utils/barcode');

// How a product is priced: per item, per kg or per litre
const PRODUCT_UNITS = ['item', 'kg', 'L'];

// =====================================================
// VALIDATE PRODUCT FORM (multipart -> strings)
// The image only ever comes from an uploaded file; any
// client-sent imageUrl is ignored.
// =====================================================

const readProduct = (body) => {
  const productName = String(body?.productName || '').trim();
  const category = String(body?.category || '').trim();
  const description = String(body?.description || '').trim();
  const price = Number(body?.price);
  const stockQuantity = Number(body?.stockQuantity);
  const isAvailable = !(body?.isAvailable === false || body?.isAvailable === 'false');
  const unit = body?.unit == null || body.unit === '' ? 'item' : String(body.unit);
  // Optional EAN/UPC/PLU; spaces dropped, empty = none
  const barcode = String(body?.barcode || '').replace(/\s+/g, '');
  const brand = String(body?.brand || '').trim();
  const size = String(body?.size || '').trim();

  if (productName.length < 2 || productName.length > 150) {
    return { error: 'Enter a product name (2-150 characters)' };
  }

  if (!category || category.length > 60) {
    return { error: 'Choose a category' };
  }

  if (!Number.isFinite(price) || price < 0 || price > 10000000) {
    return { error: 'Enter a valid price' };
  }

  if (!Number.isInteger(stockQuantity) || stockQuantity < 0 || stockQuantity > 1000000) {
    return { error: 'Stock must be a whole number (0 or more)' };
  }

  if (!PRODUCT_UNITS.includes(unit)) {
    return { error: 'Choose how the product is sold: each, per kg or per litre' };
  }

  if (barcode && !/^[0-9A-Za-z-]{4,64}$/.test(barcode)) {
    return { error: 'Barcode must be 4-64 letters or digits' };
  }

  if (brand.length > 80) {
    return { error: 'Brand must be 80 characters or fewer' };
  }

  if (size.length > 40) {
    return { error: 'Size must be 40 characters or fewer' };
  }

  return {
    value: {
      unit,
      barcode: barcode || null,
      brand: brand || null,
      size: size || null,
      productName,
      category,
      description: description || null,
      price,
      stockQuantity,
      isAvailable,
    },
    // An 8/12/13-digit number that fails the EAN/UPC check digit is kept
    // as the shop's own code (e.g. Code 128 labels); it never joins the
    // shared catalogue, but a mistyped retail code deserves a heads-up
    warning: barcode && !barcodeFormat(barcode)
      ? "Not a valid EAN/UPC number, so it's kept as your own shop code"
      : null,
  };
};

const productIdOf = (req) => {
  const id = Number(req.params.id);

  return Number.isInteger(id) && id > 0 ? id : null;
};

// This shop's product with the same barcode (UPC-A / EAN-13 forms match)
const findShopProductByBarcode = async (db, shopId, barcode, exceptId = 0) => {
  const result = await db.query(
    `
    SELECT id, product_name
    FROM products
    WHERE shop_id = $1
      AND barcode IS NOT NULL
      AND LTRIM(barcode, '0') = LTRIM($2, '0')
      AND id <> $3
    LIMIT 1
    `,
    [shopId, barcode, exceptId]
  );

  return result.rows[0] || null;
};

const duplicateBarcodeResponse = (res, existing) =>
  res.status(409).json({
    success: false,
    code: 'duplicate_barcode',
    message: `You already list this barcode as "${existing.product_name}". Edit that product instead.`,
    productId: existing.id,
  });

// Shared catalogue row for a manufacturer barcode: created by the
// first shop to register it; later shops only fill in blanks, so one
// shop can't rename a product for everyone. Shop-only codes (PLUs,
// in-store labels) and products without a barcode get no row.
const linkCatalog = async (db, shopId, value, imageUrl) => {
  if (!value.barcode || !isManufacturerBarcode(value.barcode)) {
    return null;
  }

  const result = await db.query(
    `
    INSERT INTO product_catalog
      (barcode, barcode_key, product_name, brand, size, category, image_url, created_by_shop_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (barcode_key) DO UPDATE SET
      brand = COALESCE(product_catalog.brand, EXCLUDED.brand),
      size = COALESCE(product_catalog.size, EXCLUDED.size),
      category = COALESCE(product_catalog.category, EXCLUDED.category),
      image_url = COALESCE(product_catalog.image_url, EXCLUDED.image_url),
      updated_at = CURRENT_TIMESTAMP
    RETURNING id, image_url
    `,
    [
      value.barcode,
      barcodeKey(value.barcode),
      value.productName,
      value.brand,
      value.size,
      value.category,
      imageUrl,
      shopId,
    ]
  );

  return result.rows[0];
};

// Same barcode saved twice at once in one shop: the unique index wins
const isDuplicateBarcodeError = (error) =>
  error?.code === '23505' && error.constraint === 'uq_products_shop_barcode_key';


// =====================================================
// BARCODE LOOKUP
// GET /api/shop/catalog/:barcode
// After a scan: is it already one of this shop's products, and
// does the shared catalogue know it (to pre-fill the form)?
// =====================================================

const lookupBarcode = async (req, res) => {
  try {
    const barcode = String(req.params.barcode || '').replace(/\s+/g, '');

    if (!/^[0-9A-Za-z-]{4,64}$/.test(barcode)) {
      return res.status(400).json({ success: false, message: 'Invalid barcode' });
    }

    const shopProduct = await findShopProductByBarcode(pool, req.shop.shopId, barcode);

    const catalog = isManufacturerBarcode(barcode)
      ? await pool.query(
          'SELECT * FROM product_catalog WHERE barcode_key = $1',
          [barcodeKey(barcode)]
        )
      : { rows: [] };

    const row = catalog.rows[0];

    return res.json({
      success: true,
      validCheckDigit: barcodeFormat(barcode) !== null,
      shopProduct: shopProduct
        ? { id: shopProduct.id, productName: shopProduct.product_name }
        : null,
      catalogProduct: row
        ? {
            id: row.id,
            barcode: row.barcode,
            productName: row.product_name,
            brand: row.brand || '',
            size: row.size || '',
            category: row.category || '',
            imageUrl: row.image_url || null,
          }
        : null,
    });
  } catch (error) {
    console.error('❌ lookupBarcode error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to look up barcode' });
  }
};


// =====================================================
// LIST
// GET /api/shop/products
// =====================================================

// Whitelisted sorts for the paginated list
const PRODUCT_SORTS = {
  newest: 'id DESC',
  name: 'LOWER(product_name) ASC, id DESC',
  price_asc: 'price ASC, id DESC',
  price_desc: 'price DESC, id DESC',
  stock_asc: 'stock_quantity ASC, id DESC',
  stock_desc: 'stock_quantity DESC, id DESC',
  updated: 'updated_at DESC NULLS LAST, id DESC',
};

// Effective customer price (live shop offers, pricing/offers.js)
const withOfferPrices = async (rows) => {
  const priced = await applyOffersToProducts(rows);
  return rows.map((row, i) => ({
    ...toProduct(row),
    customerPrice: Number(priced[i].price),
    offer: priced[i].offer
      ? {
          id: priced[i].offer.id,
          label: priced[i].offer.label || priced[i].offer.title || 'Offer',
          endsAt: priced[i].offer.endsAt || null,
          maxPerOrder: priced[i].offer.maxPerOrder ?? null,
        }
      : null,
    bulkOffer: priced[i].bulk_offer || null,
    purchaseLimit: priced[i].purchase_limit ?? null,
  }));
};

// An offer row `o` covers product row `p` (same rules as offers.appliesTo)
const OFFER_COVERS_SQL = `
  o.shop_id = p.shop_id
  AND (
    o.scope = 'shop'
    OR (o.scope = 'product' AND o.product_id = p.id)
    OR (o.scope = 'category' AND LOWER(TRIM(o.category)) = LOWER(TRIM(p.category)))
  )`;

const OFFER_LIVE_SQL = 'o.is_active AND NOT o.paused_by_admin AND o.starts_at <= NOW() AND (o.ends_at IS NULL OR o.ends_at > NOW())';
const OFFER_SCHEDULED_SQL = 'o.is_active AND NOT o.paused_by_admin AND o.starts_at > NOW()';

// GET /api/shop/products
//   no ?page          -> every product (original response)
//   ?page=&pageSize=&search=&category=&availability=available|hidden|live
//   &stock=low|out|in&sort=newest|name|price_asc|price_desc|stock_asc|stock_desc|updated
//   &minPrice=&maxPrice= (normal price, Rs) &offer=live|scheduled|none
const getProducts = async (req, res) => {
  try {
    if (req.query.page === undefined) {
      const result = await pool.query(
        'SELECT * FROM products WHERE shop_id = $1 ORDER BY id DESC',
        [req.shop.shopId]
      );

      return res.json({
        success: true,
        products: result.rows.map(toProduct),
      });
    }

    const shopId = req.shop.shopId;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(5, Number.parseInt(req.query.pageSize, 10) || 25));
    const threshold = (await pool.query('SELECT low_stock_threshold FROM shops WHERE id = $1', [shopId])).rows[0]?.low_stock_threshold ?? 5;
    const where = ['shop_id = $1'];
    const params = [shopId];

    const search = String(req.query.search || '').trim().slice(0, 80);
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      const p = `$${params.length}`;
      where.push(`(LOWER(product_name) LIKE ${p} OR LOWER(COALESCE(brand, '')) LIKE ${p} OR COALESCE(barcode, '') LIKE ${p})`);
    }

    if (req.query.category) {
      params.push(String(req.query.category).slice(0, 80));
      where.push(`category = $${params.length}`);
    }

    if (req.query.availability === 'available') where.push('is_available = true');
    if (req.query.availability === 'hidden') where.push('is_available = false');
    // Customers can see it: switched on and in stock
    if (req.query.availability === 'live') where.push('is_available = true AND stock_quantity > 0');

    if (req.query.stock === 'out') where.push('stock_quantity <= 0');
    if (req.query.stock === 'low' || req.query.stock === 'in') {
      params.push(threshold);
      where.push(req.query.stock === 'low' ? `stock_quantity BETWEEN 1 AND $${params.length}` : `stock_quantity > $${params.length}`);
    }

    const minPrice = Number(req.query.minPrice);
    const maxPrice = Number(req.query.maxPrice);

    if (req.query.minPrice !== undefined && req.query.minPrice !== '' && Number.isFinite(minPrice)) {
      params.push(minPrice);
      where.push(`price >= $${params.length}`);
    }

    if (req.query.maxPrice !== undefined && req.query.maxPrice !== '' && Number.isFinite(maxPrice)) {
      params.push(maxPrice);
      where.push(`price <= $${params.length}`);
    }

    if (req.query.offer === 'live') where.push(`EXISTS (SELECT 1 FROM product_offers o WHERE ${OFFER_COVERS_SQL} AND ${OFFER_LIVE_SQL})`);
    if (req.query.offer === 'scheduled') where.push(`EXISTS (SELECT 1 FROM product_offers o WHERE ${OFFER_COVERS_SQL} AND ${OFFER_SCHEDULED_SQL})`);
    if (req.query.offer === 'none') where.push(`NOT EXISTS (SELECT 1 FROM product_offers o WHERE ${OFFER_COVERS_SQL} AND ${OFFER_LIVE_SQL})`);

    // Unqualified columns below belong to the product (alias p)
    const whereSql = where.join(' AND ');
    const order = PRODUCT_SORTS[req.query.sort] || PRODUCT_SORTS.newest;

    const [count, rows, summary, categories] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM products p WHERE ${whereSql}`, params),
      pool.query(
        `SELECT * FROM products p WHERE ${whereSql} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize]
      ),
      pool.query(
        `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_available AND stock_quantity > 0)::int AS live,
          COUNT(*) FILTER (WHERE NOT is_available)::int AS hidden,
          COUNT(*) FILTER (WHERE stock_quantity <= 0)::int AS out_of_stock,
          COUNT(*) FILTER (WHERE stock_quantity BETWEEN 1 AND $2)::int AS low_stock
        FROM products WHERE shop_id = $1
        `,
        [shopId, threshold]
      ),
      pool.query(
        "SELECT category, COUNT(*)::int AS count FROM products WHERE shop_id = $1 AND COALESCE(category, '') <> '' GROUP BY category ORDER BY category",
        [shopId]
      ),
    ]);

    const total = count.rows[0].total;
    const s = summary.rows[0];

    return res.json({
      success: true,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      lowStockThreshold: threshold,
      summary: { total: s.total, live: s.live, hidden: s.hidden, outOfStock: s.out_of_stock, lowStock: s.low_stock },
      categories: categories.rows,
      products: await withOfferPrices(rows.rows),
    });
  } catch (error) {
    console.error('❌ getProducts error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load products' });
  }
};


// =====================================================
// GET ONE
// GET /api/shop/products/:id
// =====================================================

const getProduct = async (req, res) => {
  try {
    const productId = productIdOf(req);

    if (!productId) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const result = await pool.query(
      'SELECT * FROM products WHERE id = $1 AND shop_id = $2',
      [productId, req.shop.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    return res.json({ success: true, product: toProduct(result.rows[0]) });
  } catch (error) {
    console.error('❌ getProduct error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load product' });
  }
};


// =====================================================
// CREATE
// POST /api/shop/products (multipart, optional `image`)
// =====================================================

const addProduct = async (req, res) => {
  try {
    const { value, error } = readProduct(req.body);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const uploadedImage = req.file
      ? `/uploads/products/${req.file.filename}`
      : null;

    if (value.barcode) {
      const existing = await findShopProductByBarcode(pool, req.shop.shopId, value.barcode);

      if (existing) {
        return duplicateBarcodeResponse(res, existing);
      }
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const catalog = await linkCatalog(client, req.shop.shopId, value, uploadedImage);

      const result = await client.query(
        `
        INSERT INTO products
          (shop_id, product_name, category, price, stock_quantity, description, is_available, image_url, unit, barcode, brand, size, catalog_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
        `,
        [
          req.shop.shopId,
          value.productName,
          value.category,
          value.price,
          value.stockQuantity,
          value.description,
          value.isAvailable,
          // No photo uploaded: use the catalogue's
          uploadedImage || catalog?.image_url || null,
          value.unit,
          value.barcode,
          value.brand,
          value.size,
          catalog?.id || null,
        ]
      );

      await recordChange(client, {
        shopId: req.shop.shopId,
        productId: result.rows[0].id,
        before: 0,
        after: value.stockQuantity,
        reason: 'initial',
        actor: actorOf(req),
      });

      await recordPriceChange(client, {
        shopId: req.shop.shopId,
        productId: result.rows[0].id,
        newPrice: value.price,
        source: 'created',
        actor: actorOf(req),
      });

      await client.query('COMMIT');

      return res.status(201).json({
        success: true,
        message: 'Product added',
        product: toProduct(result.rows[0]),
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (isDuplicateBarcodeError(error)) {
      return res.status(409).json({
        success: false,
        code: 'duplicate_barcode',
        message: 'You already list this barcode. Edit that product instead.',
      });
    }

    console.error('❌ addProduct error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to add product' });
  }
};


// =====================================================
// UPDATE
// PUT /api/shop/products/:id (multipart, optional `image`)
// =====================================================

const updateProduct = async (req, res) => {
  try {
    const productId = productIdOf(req);

    if (!productId) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const { value, error } = readProduct(req.body);

    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const imageUrl = req.file
      ? `/uploads/products/${req.file.filename}`
      : null;

    if (value.barcode) {
      const existing = await findShopProductByBarcode(pool, req.shop.shopId, value.barcode, productId);

      if (existing) {
        return duplicateBarcodeResponse(res, existing);
      }
    }

    const client = await pool.connect();
    let result;

    try {
      await client.query('BEGIN');

      // Stock + price before the edit (stock and price history)
      const before = (
        await client.query('SELECT stock_quantity, price FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE', [productId, req.shop.shopId])
      ).rows[0];

      // Adding / changing / removing the barcode re-links the catalogue
      const catalog = await linkCatalog(client, req.shop.shopId, value, imageUrl);

      result = await client.query(
        `
        UPDATE products
        SET
          product_name = $1,
          category = $2,
          price = $3,
          stock_quantity = $4,
          description = $5,
          is_available = $6,
          image_url = COALESCE($7, image_url),
          unit = $10,
          barcode = $11,
          brand = $12,
          size = $13,
          catalog_id = $14,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $8 AND shop_id = $9
        RETURNING *
        `,
        [
          value.productName,
          value.category,
          value.price,
          value.stockQuantity,
          value.description,
          value.isAvailable,
          imageUrl,
          productId,
          req.shop.shopId,
          value.unit,
          value.barcode,
          value.brand,
          value.size,
          catalog?.id || null,
        ]
      );

      if (result.rows.length > 0 && before) {
        await recordChange(client, {
          shopId: req.shop.shopId,
          productId,
          before: before.stock_quantity,
          after: value.stockQuantity,
          reason: 'edit',
          actor: actorOf(req),
        });

        await recordPriceChange(client, {
          shopId: req.shop.shopId,
          productId,
          oldPrice: before.price,
          newPrice: value.price,
          source: 'manual',
          actor: actorOf(req),
        });
      }

      // Unknown product: don't leave a catalogue row it created behind
      await client.query(result.rows.length === 0 ? 'ROLLBACK' : 'COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    return res.json({
      success: true,
      message: 'Product updated',
      product: toProduct(result.rows[0]),
    });
  } catch (error) {
    if (isDuplicateBarcodeError(error)) {
      return res.status(409).json({
        success: false,
        code: 'duplicate_barcode',
        message: 'You already list this barcode. Edit that product instead.',
      });
    }

    console.error('❌ updateProduct error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update product' });
  }
};


// =====================================================
// QUICK AVAILABILITY / STOCK UPDATE
// PATCH /api/shop/products/:id { isAvailable?, stockQuantity? }
// =====================================================

const patchProduct = async (req, res) => {
  try {
    const productId = productIdOf(req);

    if (!productId) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const { isAvailable, stockQuantity } = req.body || {};

    if (isAvailable !== undefined && typeof isAvailable !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isAvailable must be true or false' });
    }

    if (
      stockQuantity !== undefined &&
      (!Number.isInteger(stockQuantity) || stockQuantity < 0)
    ) {
      return res.status(400).json({ success: false, message: 'Stock must be a whole number (0 or more)' });
    }

    if (stockQuantity !== undefined && stockQuantity > 1000000) {
      return res.status(400).json({ success: false, message: 'Stock is too large' });
    }

    const client = await pool.connect();
    let result;

    try {
      await client.query('BEGIN');

      const before = (
        await client.query('SELECT stock_quantity FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE', [productId, req.shop.shopId])
      ).rows[0];

      if (!before) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, message: 'Product not found' });
      }

      result = await client.query(
        `
        UPDATE products
        SET
          is_available = COALESCE($1, is_available),
          stock_quantity = COALESCE($2, stock_quantity),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $3 AND shop_id = $4
        RETURNING *
        `,
        [
          isAvailable ?? null,
          stockQuantity ?? null,
          productId,
          req.shop.shopId,
        ]
      );

      if (stockQuantity !== undefined) {
        await recordChange(client, {
          shopId: req.shop.shopId,
          productId,
          before: before.stock_quantity,
          after: stockQuantity,
          reason: 'edit',
          actor: actorOf(req),
        });
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return res.json({ success: true, product: toProduct(result.rows[0]) });
  } catch (error) {
    console.error('❌ patchProduct error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update product' });
  }
};


// =====================================================
// DELETE
// DELETE /api/shop/products/:id
// Products that appear in past orders are hidden instead of
// deleted, so order history stays intact.
// =====================================================

const deleteProduct = async (req, res) => {
  try {
    const productId = productIdOf(req);

    if (!productId) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const used = await pool.query(
      'SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1',
      [productId]
    );

    if (used.rows.length > 0) {
      const hidden = await pool.query(
        `
        UPDATE products
        SET is_available = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND shop_id = $2
        RETURNING *
        `,
        [productId, req.shop.shopId]
      );

      if (hidden.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Product not found' });
      }

      return res.json({
        success: true,
        hidden: true,
        message: 'This product is in past orders, so it was hidden from customers instead of deleted.',
        product: toProduct(hidden.rows[0]),
      });
    }

    const result = await pool.query(
      'DELETE FROM products WHERE id = $1 AND shop_id = $2 RETURNING id',
      [productId, req.shop.shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    return res.json({ success: true, hidden: false, message: 'Product deleted' });
  } catch (error) {
    console.error('❌ deleteProduct error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to delete product' });
  }
};

// =====================================================
// QUICK PRICE CHANGE
// PATCH /api/shop/products/:id/price { price, note? } (managers)
// Same checks as the product form; the row is locked so two edits
// (or an edit and a checkout) don't interleave.
// =====================================================

const MAX_PRICE = 10000000;

const patchProductPrice = async (req, res) => {
  const productId = productIdOf(req);
  const price = Number(req.body?.price);
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 300) : null;

  if (!productId) {
    return res.status(400).json({ success: false, message: 'Invalid product ID' });
  }

  if (req.body?.price === '' || req.body?.price == null || !Number.isFinite(price) || price < 0 || price > MAX_PRICE) {
    return res.status(400).json({ success: false, message: 'Enter a valid price (0 or more)' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const before = (
      await client.query('SELECT * FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE', [productId, req.shop.shopId])
    ).rows[0];

    if (!before) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const rounded = Math.round(price * 100) / 100;
    const result = await client.query(
      'UPDATE products SET price = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND shop_id = $3 RETURNING *',
      [rounded, productId, req.shop.shopId]
    );

    await recordPriceChange(client, {
      shopId: req.shop.shopId,
      productId,
      oldPrice: before.price,
      newPrice: rounded,
      source: 'manual',
      actor: actorOf(req),
      note,
    });

    await client.query('COMMIT');

    const [product] = await withOfferPrices(result.rows);

    return res.json({
      success: true,
      message: Number(before.price) === rounded ? 'Price unchanged' : 'Price updated',
      product,
      change: {
        oldPrice: Number(before.price),
        newPrice: rounded,
        percent: changePercent(before.price, rounded),
        // Big jumps are fine but worth a second look
        unusual: isSuspiciousChange(before.price, rounded),
      },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ patchProductPrice error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to update the price' });
  } finally {
    client.release();
  }
};


// =====================================================
// PRICE HISTORY
// GET /api/shop/products/:id/price-history
// -> { prices: [...], offers: [...] } newest first; offers = history
//    of offers that cover this product (product, category, shop)
// =====================================================

const toPriceChange = (row) => ({
  id: Number(row.id),
  oldPrice: row.old_price == null ? null : Number(row.old_price),
  newPrice: Number(row.new_price),
  percent: changePercent(row.old_price, row.new_price),
  source: row.source,
  note: row.note,
  actorType: row.actor_type,
  actorName: row.actor_name,
  at: row.created_at,
});

const getProductPriceHistory = async (req, res) => {
  try {
    const productId = productIdOf(req);

    if (!productId) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const product = (
      await pool.query('SELECT * FROM products WHERE id = $1 AND shop_id = $2', [productId, req.shop.shopId])
    ).rows[0];

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const [prices, offers] = await Promise.all([
      pool.query(
        'SELECT * FROM product_price_history WHERE product_id = $1 AND shop_id = $2 ORDER BY created_at DESC, id DESC LIMIT 100',
        [productId, req.shop.shopId]
      ),
      pool.query(
        `
        SELECT o.*,
          (SELECT json_agg(h ORDER BY h.created_at DESC)
           FROM (SELECT action, before, after, actor_type, actor_name, created_at
                 FROM product_offer_history WHERE offer_id = o.id
                 ORDER BY created_at DESC LIMIT 20) h) AS history
        FROM product_offers o
        WHERE o.shop_id = $1
          AND (
            o.scope = 'shop'
            OR (o.scope = 'product' AND o.product_id = $2)
            OR (o.scope = 'category' AND LOWER(TRIM(o.category)) = LOWER(TRIM($3)))
          )
        ORDER BY o.starts_at DESC
        LIMIT 50
        `,
        [req.shop.shopId, productId, product.category || '']
      ),
    ]);

    return res.json({
      success: true,
      product: toProduct(product),
      prices: prices.rows.map(toPriceChange),
      offers: offers.rows.map((offer) => ({
        id: Number(offer.id),
        scope: offer.scope,
        discountType: offer.discount_type,
        discountValue: Number(offer.discount_value),
        title: offer.title,
        startsAt: offer.starts_at,
        endsAt: offer.ends_at,
        minQuantity: offer.min_quantity,
        maxPerOrder: offer.max_per_order,
        status: offerStatus(offer),
        history: offer.history || [],
      })),
    });
  } catch (error) {
    console.error('❌ getProductPriceHistory error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load the price history' });
  }
};

module.exports = {
  getProducts,
  getProduct,
  addProduct,
  updateProduct,
  patchProduct,
  patchProductPrice,
  getProductPriceHistory,
  deleteProduct,
  toPriceChange,
  lookupBarcode,
  // Shared with the bulk import
  readProduct,
  linkCatalog,
  isDuplicateBarcodeError,
};
