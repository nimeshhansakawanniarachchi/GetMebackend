// =====================================================
// PHASE 59: MERCHANT PRODUCTS (shop portal, clothing + restaurants)
// /api/shop/merchant-products ...
// Same products table as grocery (so offers, search and the admin
// tools see them) with clothing variants, multiple images and menu
// option groups. Grocery shops keep the existing /products API.
// Every query is scoped to req.shop.shopId.
// =====================================================

const fs = require('fs');
const path = require('path');
const {
  pool,
  MERCHANT_TYPES,
  isRetail,
  round2,
  toId,
  fail,
  text,
  bool,
  money,
  loadProductExtras,
  toProduct,
} = require('./common');
const { recordShopActivity } = require('../middleware/shopAccess');
const { broadcastCatalogChange } = require('../realtime');
const { recordPriceChange } = require('../pricing/history');

const MAX_IMAGES = 10;
const MAX_VARIANTS = 200;
const MAX_GROUPS = 15;
const MAX_OPTIONS = 30;
const GENDERS = ['men', 'women', 'unisex', 'kids'];
const FOOD_TYPES = ['veg', 'non_veg', 'vegan'];

const shopOf = async (req, client = pool) =>
  (await client.query('SELECT id, business_type, low_stock_threshold FROM shops WHERE id = $1', [req.shop.shopId])).rows[0];

// Guard: only clothing shops and restaurants use these endpoints
const requireMerchant = async (req, res, next) => {
  try {
    const shop = await shopOf(req);
    if (!shop) return fail(res, 404, 'Shop not found');
    if (!MERCHANT_TYPES.includes(shop.business_type)) {
      return fail(res, 403, 'Grocery shops manage products on the Products page.', 'GROCERY_USES_PRODUCTS');
    }
    req.merchantShop = shop;
    return next();
  } catch (error) {
    return next(error);
  }
};

const actorOf = (req) => ({
  type: req.shop.staffId ? 'staff' : 'owner',
  id: req.shop.staffId || req.shop.shopId,
  name: req.shop.actorName || null,
  role: req.shop.role,
});

const logActivity = (req, action, productId, summary) =>
  recordShopActivity({
    shopId: req.shop.shopId,
    actor: actorOf(req),
    action,
    entityType: 'product',
    entityId: productId,
    summary,
  });

const changed = (req) => broadcastCatalogChange(req.app.get('io'), req.shop.shopId, 'products');

const ownProduct = async (client, shopId, productId, lock = false) =>
  (await client.query(`SELECT * FROM products WHERE id = $1 AND shop_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [productId, shopId])).rows[0] || null;

const fullProduct = async (shop, productId, client = pool) => {
  const row = await ownProduct(client, shop.id, productId);
  if (!row) return null;
  const extras = await loadProductExtras([row.id], client);
  const view = toProduct(row, extras, shop, { forMerchant: true });
  view.images = (extras.images.get(Number(row.id)) || []).map((img) => ({ id: Number(img.id), url: img.url, sort: Number(img.sort) }));
  if (!view.images.length && row.image_url) view.images = [{ id: null, url: row.image_url, sort: 0 }];
  view.stockQuantity = Number(row.stock_quantity) || 0;
  return view;
};

// -----------------------------------------------------
// List / get
// -----------------------------------------------------

const listProducts = async (req, res) => {
  try {
    const shop = req.merchantShop;
    const params = [shop.id];
    const where = ['p.shop_id = $1'];
    const search = text(req.query.search, 60);
    if (search) {
      params.push(`%${search}%`);
      where.push(`(p.product_name ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR p.brand ILIKE $${params.length})`);
    }
    const category = text(req.query.category, 60);
    if (category) {
      params.push(category);
      where.push(`p.category = $${params.length}`);
    }
    if (req.query.available === '1' || req.query.available === '0') {
      where.push(`p.is_available = ${req.query.available === '1'}`);
    }
    if (req.query.featured === '1') where.push('p.is_featured');

    const rows = (
      await pool.query(
        `SELECT p.*,
                (SELECT COUNT(*)::int FROM product_variants v WHERE v.product_id = p.id) AS variant_count,
                (SELECT COUNT(*)::int FROM product_option_groups g WHERE g.product_id = p.id) AS group_count,
                (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY sort, id LIMIT 1) AS first_image
         FROM products p WHERE ${where.join(' AND ')}
         ORDER BY p.category, p.sort_order, p.product_name
         LIMIT 1000`,
        params
      )
    ).rows;

    const categories = (
      await pool.query(
        'SELECT category AS name, COUNT(*)::int AS count FROM products WHERE shop_id = $1 GROUP BY category ORDER BY category',
        [shop.id]
      )
    ).rows;

    const threshold = Number(shop.low_stock_threshold ?? 5);
    return res.json({
      success: true,
      products: rows.map((p) => ({
        id: Number(p.id),
        name: p.product_name,
        category: p.category,
        subcategory: p.subcategory || null,
        price: round2(p.price),
        discountPrice: p.discount_price != null ? round2(p.discount_price) : null,
        imageUrl: p.first_image || p.image_url || null,
        isAvailable: !!p.is_available,
        isFeatured: !!p.is_featured,
        stockTotal: Number(p.stock_quantity) || 0,
        variantCount: Number(p.variant_count) || 0,
        optionGroupCount: Number(p.group_count) || 0,
        lowStock: isRetail(shop.business_type) && !!p.is_available && Number(p.stock_quantity) <= threshold,
        foodType: p.food_type || null,
        updatedAt: p.updated_at,
      })),
      categories: categories.map((c) => ({ name: c.name, count: Number(c.count) })),
    });
  } catch (error) {
    console.error('❌ MERCHANT PRODUCTS LIST ERROR:', error.message);
    return fail(res, 500, "Couldn't load products. Please try again.");
  }
};

const getProduct = async (req, res) => {
  try {
    const id = toId(req.params.id);
    const product = id ? await fullProduct(req.merchantShop, id) : null;
    if (!product) return fail(res, 404, 'Product not found', 'NOT_FOUND');
    return res.json({ success: true, product });
  } catch (error) {
    console.error('❌ MERCHANT PRODUCT ERROR:', error.message);
    return fail(res, 500, "Couldn't load this product. Please try again.");
  }
};

// -----------------------------------------------------
// Create / update
// -----------------------------------------------------

const readProductBody = (body, shop, existing = null) => {
  const name = text(body?.name, 200);
  if (!name || name.length < 2) return { error: 'Enter a product name (at least 2 characters)' };
  const category = text(body?.category, 60);
  if (!category) return { error: shop.business_type === 'restaurant' ? 'Choose a menu category' : 'Choose a category' };
  const price = money(body?.price);
  if (price == null || price === undefined || price <= 0) return { error: 'Enter a price above Rs 0' };
  const discountPrice = money(body?.discountPrice);
  if (discountPrice === undefined) return { error: 'Enter a valid discount price' };
  if (discountPrice != null && discountPrice >= price) return { error: 'The discount price must be lower than the price' };

  const out = {
    product_name: name,
    category,
    subcategory: text(body?.subcategory, 60),
    description: text(body?.description, 2000),
    brand: text(body?.brand, 80),
    price,
    discount_price: discountPrice,
    sku: text(body?.sku, 60),
    barcode: text(body?.barcode, 64),
    is_available: bool(body?.isAvailable, existing ? existing.is_available : true),
    is_featured: bool(body?.isFeatured, existing ? existing.is_featured : false),
    sort_order: Number.isInteger(Number(body?.sortOrder)) ? Math.max(0, Math.min(10000, Number(body.sortOrder))) : existing?.sort_order || 0,
  };

  if (isRetail(shop.business_type)) {
    out.material = text(body?.material, 60);
    const gender = body?.gender ? String(body.gender).toLowerCase() : null;
    if (gender && !GENDERS.includes(gender)) return { error: 'Choose men, women, unisex or kids' };
    out.gender = gender;
    out.unit = 'item';
    if (body?.stockQuantity !== undefined && !(existing?.has_variants)) {
      const stock = Number(body.stockQuantity);
      if (!Number.isInteger(stock) || stock < 0 || stock > 100000) return { error: 'Enter a stock quantity between 0 and 100000' };
      out.stock_quantity = stock;
    }
  } else {
    const prep = body?.prepMinutes == null || body.prepMinutes === '' ? null : Number(body.prepMinutes);
    if (prep != null && (!Number.isInteger(prep) || prep < 1 || prep > 240)) return { error: 'Preparation time must be 1 to 240 minutes' };
    const foodType = body?.foodType ? String(body.foodType) : null;
    if (foodType && !FOOD_TYPES.includes(foodType)) return { error: 'Choose veg, non-veg or vegan' };
    const spice = body?.spiceLevel == null || body.spiceLevel === '' ? null : Number(body.spiceLevel);
    if (spice != null && (!Number.isInteger(spice) || spice < 0 || spice > 3)) return { error: 'Spice level must be 0 to 3' };
    out.prep_minutes = prep;
    out.food_type = foodType;
    out.spice_level = spice;
    out.unit = 'item';
    // Menu items aren't stock-counted; availability switches them on / off
    if (!existing) out.stock_quantity = 0;
  }
  return { value: out };
};

const createProduct = async (req, res) => {
  const shop = req.merchantShop;
  const read = readProductBody(req.body, shop);
  if (read.error) return fail(res, 400, read.error, 'VALIDATION');

  try {
    const fields = { ...read.value, shop_id: shop.id };
    if (fields.stock_quantity === undefined) fields.stock_quantity = 0;
    const keys = Object.keys(fields);
    const row = (
      await pool.query(
        `INSERT INTO products (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        keys.map((k) => fields[k])
      )
    ).rows[0];
    logActivity(req, 'product.created', row.id, `Added ${fields.product_name}`);
    changed(req);
    return res.status(201).json({ success: true, product: await fullProduct(shop, row.id) });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'Another product already uses this barcode', 'DUPLICATE');
    console.error('❌ MERCHANT PRODUCT CREATE ERROR:', error.message);
    return fail(res, 500, "Couldn't save this product. Please try again.");
  }
};

const updateProduct = async (req, res) => {
  const shop = req.merchantShop;
  const id = toId(req.params.id);
  try {
    const existing = id ? await ownProduct(pool, shop.id, id) : null;
    if (!existing) return fail(res, 404, 'Product not found', 'NOT_FOUND');
    const read = readProductBody(req.body, shop, existing);
    if (read.error) return fail(res, 400, read.error, 'VALIDATION');
    const keys = Object.keys(read.value);
    const priceChanged = Number(existing.price) !== Number(read.value.price);
    await pool.query(
      `UPDATE products SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')},
              updated_at = NOW()
       WHERE id = $1 AND shop_id = $2`,
      [id, shop.id, ...keys.map((k) => read.value[k])]
    );
    if (priceChanged) {
      await recordPriceChange(pool, {
        shopId: shop.id,
        productId: id,
        oldPrice: existing.price,
        newPrice: read.value.price,
        source: 'manual',
        actor: actorOf(req),
        note: 'Edited in the portal',
      }).catch((error) => console.error('❌ PRICE HISTORY:', error.message));
    }
    logActivity(req, 'product.updated', id, `Edited ${read.value.product_name}`);
    changed(req);
    return res.json({ success: true, product: await fullProduct(shop, id) });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'Another product already uses this barcode', 'DUPLICATE');
    console.error('❌ MERCHANT PRODUCT UPDATE ERROR:', error.message);
    return fail(res, 500, "Couldn't save this product. Please try again.");
  }
};

const patchProduct = async (req, res) => {
  const shop = req.merchantShop;
  const id = toId(req.params.id);
  if (typeof req.body?.isAvailable !== 'boolean') return fail(res, 400, 'Send isAvailable true or false', 'VALIDATION');
  try {
    const row = (
      await pool.query(
        'UPDATE products SET is_available = $3, updated_at = NOW() WHERE id = $1 AND shop_id = $2 RETURNING id, product_name',
        [id, shop.id, req.body.isAvailable]
      )
    ).rows[0];
    if (!row) return fail(res, 404, 'Product not found', 'NOT_FOUND');
    logActivity(req, req.body.isAvailable ? 'product.available' : 'product.unavailable', id,
      `${row.product_name} ${req.body.isAvailable ? 'available' : 'marked unavailable'}`);
    changed(req);
    return res.json({ success: true, product: await fullProduct(shop, id) });
  } catch (error) {
    console.error('❌ MERCHANT PRODUCT PATCH ERROR:', error.message);
    return fail(res, 500, "Couldn't update this product.");
  }
};

const deleteProduct = async (req, res) => {
  const shop = req.merchantShop;
  const id = toId(req.params.id);
  try {
    const existing = id ? await ownProduct(pool, shop.id, id) : null;
    if (!existing) return fail(res, 404, 'Product not found', 'NOT_FOUND');
    const used = (await pool.query('SELECT 1 FROM order_items WHERE product_id = $1 LIMIT 1', [id])).rows.length > 0;
    if (used) {
      await pool.query('UPDATE products SET is_available = false, updated_at = NOW() WHERE id = $1', [id]);
      logActivity(req, 'product.hidden', id, `Hid ${existing.product_name} (in past orders)`);
      changed(req);
      return res.json({ success: true, hidden: true, message: 'This product is in past orders, so it was hidden from customers instead of deleted.' });
    }
    await pool.query('DELETE FROM products WHERE id = $1 AND shop_id = $2', [id, shop.id]);
    logActivity(req, 'product.deleted', id, `Deleted ${existing.product_name}`);
    changed(req);
    return res.json({ success: true, hidden: false, message: 'Product deleted' });
  } catch (error) {
    console.error('❌ MERCHANT PRODUCT DELETE ERROR:', error.message);
    return fail(res, 500, "Couldn't delete this product.");
  }
};

// -----------------------------------------------------
// Variants (clothing)
// -----------------------------------------------------

const syncProductStock = (client, productId) =>
  client.query(
    `UPDATE products p
     SET stock_quantity = COALESCE((SELECT SUM(stock_quantity) FROM product_variants WHERE product_id = p.id), p.stock_quantity),
         has_variants = EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id),
         updated_at = NOW()
     WHERE p.id = $1`,
    [productId]
  );

const logStock = (client, req, productId, variantId, before, after, note) =>
  before === after
    ? null
    : client.query(
        `INSERT INTO product_stock_movements (shop_id, product_id, variant_id, change, stock_before, stock_after, reason, note, actor_type, actor_id, actor_name)
         VALUES ($1,$2,$3,$4,$5,$6,'count',$7,$8,$9,$10)`,
        [req.shop.shopId, productId, variantId, after - before, before, after, note, req.shop.staffId ? 'staff' : 'owner', req.shop.staffId || req.shop.shopId, req.shop.actorName || null]
      );

const replaceVariants = async (req, res) => {
  const shop = req.merchantShop;
  if (!isRetail(shop.business_type)) return fail(res, 400, 'Sizes and colours are for clothing and liquor stores', 'NOT_CLOTHING');
  const id = toId(req.params.id);
  const list = Array.isArray(req.body?.variants) ? req.body.variants : null;
  if (!list) return fail(res, 400, 'Send the list of variants', 'VALIDATION');
  if (list.length > MAX_VARIANTS) return fail(res, 400, `A product can have at most ${MAX_VARIANTS} variants`, 'VALIDATION');

  const clean = [];
  const combos = new Set();
  const skus = new Set();
  for (const [i, raw] of list.entries()) {
    const size = text(raw?.size, 20);
    const colour = text(raw?.colour, 30);
    const material = text(raw?.material, 40);
    if (!size && !colour && !material) return fail(res, 400, `Row ${i + 1}: choose a size, colour or material`, 'VALIDATION');
    const combo = [size, colour, material].map((v) => (v || '').toLowerCase()).join('|');
    if (combos.has(combo)) return fail(res, 400, `Row ${i + 1}: ${[size, colour, material].filter(Boolean).join(' / ')} is listed twice`, 'DUPLICATE_VARIANT');
    combos.add(combo);
    const sku = text(raw?.sku, 60);
    if (sku) {
      if (skus.has(sku.toLowerCase())) return fail(res, 400, `SKU ${sku} is used twice`, 'DUPLICATE_SKU');
      skus.add(sku.toLowerCase());
    }
    const price = money(raw?.price);
    const discount = money(raw?.discountPrice);
    if (price === undefined || discount === undefined) return fail(res, 400, `Row ${i + 1}: enter valid prices`, 'VALIDATION');
    if (price != null && price <= 0) return fail(res, 400, `Row ${i + 1}: the price must be above Rs 0`, 'VALIDATION');
    const stock = Number(raw?.stockQuantity ?? 0);
    if (!Number.isInteger(stock) || stock < 0 || stock > 100000) return fail(res, 400, `Row ${i + 1}: stock must be 0 to 100000`, 'VALIDATION');
    clean.push({
      id: toId(raw?.id),
      size, colour, material, sku,
      barcode: text(raw?.barcode, 64),
      price,
      discount,
      stock,
      available: bool(raw?.isAvailable, true),
      sort: i,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await ownProduct(client, shop.id, id, true);
    if (!product) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Product not found', 'NOT_FOUND');
    }
    for (const v of clean) {
      const effective = v.price ?? Number(product.price);
      if (v.discount != null && v.discount >= effective) {
        await client.query('ROLLBACK');
        return fail(res, 400, `${[v.size, v.colour, v.material].filter(Boolean).join(' / ')}: the discount price must be lower than the price`, 'VALIDATION');
      }
    }

    const existing = (await client.query('SELECT * FROM product_variants WHERE product_id = $1 FOR UPDATE', [id])).rows;
    const byId = new Map(existing.map((row) => [Number(row.id), row]));
    const keep = new Set();

    // Free the combos / SKUs of rows being replaced first (unique indexes)
    for (const v of clean) if (v.id && byId.has(v.id)) keep.add(v.id);
    const removed = existing.filter((row) => !keep.has(Number(row.id)));
    for (const row of removed) {
      await client.query('DELETE FROM product_variants WHERE id = $1', [row.id]);
      await logStock(client, req, id, row.id, Number(row.stock_quantity), 0, `Variant ${[row.size, row.colour, row.material].filter(Boolean).join(' / ')} removed`);
    }
    await client.query(`UPDATE product_variants SET sku = NULL WHERE product_id = $1`, [id]);

    for (const v of clean) {
      const before = v.id && byId.has(v.id) ? Number(byId.get(v.id).stock_quantity) : 0;
      let variantId = v.id && byId.has(v.id) ? v.id : null;
      if (variantId) {
        await client.query(
          `UPDATE product_variants SET size = $2, colour = $3, material = $4, sku = $5, barcode = $6, price = $7, discount_price = $8,
                  stock_quantity = $9, is_available = $10, sort = $11, updated_at = NOW() WHERE id = $1`,
          [variantId, v.size, v.colour, v.material, v.sku, v.barcode, v.price, v.discount, v.stock, v.available, v.sort]
        );
      } else {
        variantId = (
          await client.query(
            `INSERT INTO product_variants (product_id, shop_id, size, colour, material, sku, barcode, price, discount_price, stock_quantity, is_available, sort)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [id, shop.id, v.size, v.colour, v.material, v.sku, v.barcode, v.price, v.discount, v.stock, v.available, v.sort]
          )
        ).rows[0].id;
      }
      await logStock(client, req, id, variantId, before, v.stock, `Variant ${[v.size, v.colour, v.material].filter(Boolean).join(' / ')}`);
    }

    await syncProductStock(client, id);
    if (!clean.length) await client.query('UPDATE products SET has_variants = false WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return fail(res, 409, 'A SKU is already used by another product in your shop', 'DUPLICATE_SKU');
    console.error('❌ MERCHANT VARIANTS ERROR:', error.message);
    return fail(res, 500, "Couldn't save the variants. Please try again.");
  } finally {
    client.release();
  }

  logActivity(req, 'product.variants', id, `Updated sizes / colours (${clean.length} variants)`);
  changed(req);
  return res.json({ success: true, product: await fullProduct(shop, id) });
};

const patchVariant = async (req, res) => {
  const shop = req.merchantShop;
  const id = toId(req.params.id);
  const variantId = toId(req.params.variantId);
  const body = req.body || {};
  if (body.stockQuantity === undefined && typeof body.isAvailable !== 'boolean') {
    return fail(res, 400, 'Send stockQuantity or isAvailable', 'VALIDATION');
  }
  if (body.stockQuantity !== undefined) {
    const stock = Number(body.stockQuantity);
    if (!Number.isInteger(stock) || stock < 0 || stock > 100000) return fail(res, 400, 'Stock must be 0 to 100000', 'VALIDATION');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (
      await client.query(
        'SELECT v.* FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND v.product_id = $2 AND p.shop_id = $3 FOR UPDATE',
        [variantId, id, shop.id]
      )
    ).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Variant not found', 'NOT_FOUND');
    }
    const stock = body.stockQuantity !== undefined ? Number(body.stockQuantity) : Number(row.stock_quantity);
    const available = typeof body.isAvailable === 'boolean' ? body.isAvailable : row.is_available;
    await client.query('UPDATE product_variants SET stock_quantity = $2, is_available = $3, updated_at = NOW() WHERE id = $1', [variantId, stock, available]);
    await logStock(client, req, id, variantId, Number(row.stock_quantity), stock, `Variant ${[row.size, row.colour, row.material].filter(Boolean).join(' / ')}`);
    await syncProductStock(client, id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ MERCHANT VARIANT PATCH ERROR:', error.message);
    return fail(res, 500, "Couldn't update this variant.");
  } finally {
    client.release();
  }
  changed(req);
  return res.json({ success: true, product: await fullProduct(shop, id) });
};

// -----------------------------------------------------
// Images
// -----------------------------------------------------

// A refused request's just-uploaded files are deleted again
const moveAside = (file) => {
  try {
    fs.unlinkSync(file.path);
  } catch (_) {
    // already gone
  }
};

const syncMainImage = (client, productId) =>
  client.query(
    `UPDATE products p SET image_url = COALESCE((SELECT url FROM product_images WHERE product_id = p.id ORDER BY sort, id LIMIT 1), p.image_url),
            updated_at = NOW() WHERE p.id = $1`,
    [productId]
  );

const addImages = async (req, res) => {
  const shop = req.merchantShop;
  const id = toId(req.params.id);
  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) return fail(res, 400, 'Choose at least one photo', 'VALIDATION');
  try {
    const product = await ownProduct(pool, shop.id, id);
    if (!product) {
      files.forEach(moveAside);
      return fail(res, 404, 'Product not found', 'NOT_FOUND');
    }
    const count = Number((await pool.query('SELECT COUNT(*)::int AS n FROM product_images WHERE product_id = $1', [id])).rows[0].n);
    if (count + files.length > MAX_IMAGES) {
      files.forEach(moveAside);
      return fail(res, 400, `A product can have at most ${MAX_IMAGES} photos (${count} already)`, 'TOO_MANY_IMAGES');
    }
    // The single grocery-style photo becomes the first gallery photo
    if (count === 0 && product.image_url) {
      await pool.query('INSERT INTO product_images (product_id, url, sort) VALUES ($1, $2, 0)', [id, product.image_url]);
    }
    let sort = count + 1;
    for (const file of files) {
      await pool.query('INSERT INTO product_images (product_id, url, sort) VALUES ($1, $2, $3)', [id, `/uploads/products/${path.basename(file.filename)}`, sort]);
      sort += 1;
    }
    await syncMainImage(pool, id);
    changed(req);
    const view = await fullProduct(shop, id);
    return res.json({ success: true, images: view.images, product: view });
  } catch (error) {
    console.error('❌ MERCHANT IMAGES ERROR:', error.message);
    return fail(res, 500, "Couldn't save the photos. Please try again.");
  }
};

const deleteImage = async (req, res) => {
  const shop = req.merchantShop;
  const id = toId(req.params.id);
  const imageId = toId(req.params.imageId);
  try {
    const product = await ownProduct(pool, shop.id, id);
    if (!product) return fail(res, 404, 'Product not found', 'NOT_FOUND');
    const removed = (await pool.query('DELETE FROM product_images WHERE id = $1 AND product_id = $2 RETURNING url', [imageId, id])).rows[0];
    if (!removed) return fail(res, 404, 'Photo not found', 'NOT_FOUND');
    const left = Number((await pool.query('SELECT COUNT(*)::int AS n FROM product_images WHERE product_id = $1', [id])).rows[0].n);
    if (left === 0) await pool.query('UPDATE products SET image_url = NULL, updated_at = NOW() WHERE id = $1', [id]);
    else await syncMainImage(pool, id);
    changed(req);
    const view = await fullProduct(shop, id);
    return res.json({ success: true, images: view.images, product: view });
  } catch (error) {
    console.error('❌ MERCHANT IMAGE DELETE ERROR:', error.message);
    return fail(res, 500, "Couldn't delete the photo.");
  }
};

const orderImages = async (req, res) => {
  const shop = req.merchantShop;
  const id = toId(req.params.id);
  const ids = Array.isArray(req.body?.imageIds) ? req.body.imageIds.map(toId) : null;
  if (!ids || ids.some((v) => !v)) return fail(res, 400, 'Send the photo ids in order', 'VALIDATION');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await ownProduct(client, shop.id, id, true);
    if (!product) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Product not found', 'NOT_FOUND');
    }
    const existing = (await client.query('SELECT id FROM product_images WHERE product_id = $1', [id])).rows.map((r) => Number(r.id));
    if (existing.length !== ids.length || !ids.every((v) => existing.includes(v))) {
      await client.query('ROLLBACK');
      return fail(res, 400, 'The photo list changed. Reload and try again.', 'STALE');
    }
    for (const [i, imageId] of ids.entries()) {
      await client.query('UPDATE product_images SET sort = $2 WHERE id = $1', [imageId, i]);
    }
    await syncMainImage(client, id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ MERCHANT IMAGE ORDER ERROR:', error.message);
    return fail(res, 500, "Couldn't reorder the photos.");
  } finally {
    client.release();
  }
  changed(req);
  const view = await fullProduct(shop, id);
  return res.json({ success: true, images: view.images, product: view });
};

// -----------------------------------------------------
// Menu options (restaurant)
// -----------------------------------------------------

const replaceOptions = async (req, res) => {
  const shop = req.merchantShop;
  if (shop.business_type !== 'restaurant') return fail(res, 400, 'Add-ons are for restaurants', 'NOT_RESTAURANT');
  const id = toId(req.params.id);
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : null;
  if (!groups) return fail(res, 400, 'Send the list of option groups', 'VALIDATION');
  if (groups.length > MAX_GROUPS) return fail(res, 400, `At most ${MAX_GROUPS} option groups per item`, 'VALIDATION');

  const clean = [];
  for (const [gi, g] of groups.entries()) {
    const name = text(g?.name, 80);
    if (!name) return fail(res, 400, `Group ${gi + 1}: enter a name (e.g. "Choose your size")`, 'VALIDATION');
    const options = Array.isArray(g?.options) ? g.options : [];
    if (!options.length) return fail(res, 400, `"${name}": add at least one option`, 'VALIDATION');
    if (options.length > MAX_OPTIONS) return fail(res, 400, `"${name}": at most ${MAX_OPTIONS} options`, 'VALIDATION');
    const min = Number(g?.minSelect ?? 0);
    const max = Number(g?.maxSelect ?? 1);
    if (!Number.isInteger(min) || min < 0 || !Number.isInteger(max) || max < 1) return fail(res, 400, `"${name}": enter whole numbers for min and max`, 'VALIDATION');
    if (min > max) return fail(res, 400, `"${name}": the minimum can't be more than the maximum`, 'VALIDATION');
    if (max > options.length) return fail(res, 400, `"${name}": the maximum can't be more than the number of options (${options.length})`, 'VALIDATION');
    const cleanOptions = [];
    const names = new Set();
    for (const [oi, o] of options.entries()) {
      const oname = text(o?.name, 80);
      if (!oname) return fail(res, 400, `"${name}" option ${oi + 1}: enter a name`, 'VALIDATION');
      if (names.has(oname.toLowerCase())) return fail(res, 400, `"${name}": "${oname}" is listed twice`, 'VALIDATION');
      names.add(oname.toLowerCase());
      const delta = money(o?.priceDelta ?? 0);
      if (delta == null || delta === undefined || delta > 100000) return fail(res, 400, `"${oname}": enter an extra price of Rs 0 or more`, 'VALIDATION');
      cleanOptions.push({ id: toId(o?.id), name: oname, delta, available: bool(o?.isAvailable, true), isDefault: bool(o?.isDefault, false), sort: oi });
    }
    if (cleanOptions.filter((o) => o.available).length < min) {
      return fail(res, 400, `"${name}" is required but has fewer than ${min} available options`, 'VALIDATION');
    }
    clean.push({ id: toId(g?.id), name, min, max, options: cleanOptions, sort: gi });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const product = await ownProduct(client, shop.id, id, true);
    if (!product) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Product not found', 'NOT_FOUND');
    }
    const existingGroups = (await client.query('SELECT id FROM product_option_groups WHERE product_id = $1', [id])).rows.map((r) => Number(r.id));
    const keepGroups = new Set(clean.map((g) => g.id).filter((gid) => gid && existingGroups.includes(gid)));
    for (const gid of existingGroups) if (!keepGroups.has(gid)) await client.query('DELETE FROM product_option_groups WHERE id = $1', [gid]);

    for (const g of clean) {
      let groupId = g.id && keepGroups.has(g.id) ? g.id : null;
      if (groupId) {
        await client.query('UPDATE product_option_groups SET name = $2, min_select = $3, max_select = $4, sort = $5 WHERE id = $1', [groupId, g.name, g.min, g.max, g.sort]);
      } else {
        groupId = (
          await client.query(
            'INSERT INTO product_option_groups (product_id, shop_id, name, min_select, max_select, sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [id, shop.id, g.name, g.min, g.max, g.sort]
          )
        ).rows[0].id;
      }
      const existingOptions = (await client.query('SELECT id FROM product_options WHERE group_id = $1', [groupId])).rows.map((r) => Number(r.id));
      const keepOptions = new Set(g.options.map((o) => o.id).filter((oid) => oid && existingOptions.includes(oid)));
      for (const oid of existingOptions) if (!keepOptions.has(oid)) await client.query('DELETE FROM product_options WHERE id = $1', [oid]);
      for (const o of g.options) {
        if (o.id && keepOptions.has(o.id)) {
          await client.query('UPDATE product_options SET name = $2, price_delta = $3, is_available = $4, is_default = $5, sort = $6 WHERE id = $1', [o.id, o.name, o.delta, o.available, o.isDefault, o.sort]);
        } else {
          await client.query(
            'INSERT INTO product_options (group_id, product_id, name, price_delta, is_available, is_default, sort) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [groupId, id, o.name, o.delta, o.available, o.isDefault, o.sort]
          );
        }
      }
    }
    await client.query('UPDATE products SET updated_at = NOW() WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ MERCHANT OPTIONS ERROR:', error.message);
    return fail(res, 500, "Couldn't save the add-ons. Please try again.");
  } finally {
    client.release();
  }
  logActivity(req, 'product.options', id, `Updated add-ons (${clean.length} groups)`);
  changed(req);
  return res.json({ success: true, product: await fullProduct(shop, id) });
};

const categoriesForShop = async (req, res) => {
  try {
    const shop = await shopOf(req);
    const rows = (
      await pool.query(
        'SELECT id, parent_id, name FROM marketplace_categories WHERE business_type = $1 AND is_active ORDER BY sort, name',
        [shop.business_type]
      )
    ).rows;
    const parents = rows.filter((r) => !r.parent_id);
    return res.json({
      success: true,
      categories: parents.map((p) => ({
        id: Number(p.id),
        name: p.name,
        subcategories: rows.filter((r) => Number(r.parent_id) === Number(p.id)).map((r) => ({ id: Number(r.id), name: r.name })),
      })),
    });
  } catch (error) {
    console.error('❌ MARKETPLACE CATEGORIES ERROR:', error.message);
    return fail(res, 500, "Couldn't load categories.");
  }
};

module.exports = {
  requireMerchant,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  patchProduct,
  deleteProduct,
  replaceVariants,
  patchVariant,
  addImages,
  deleteImage,
  orderImages,
  replaceOptions,
  categoriesForShop,
};
