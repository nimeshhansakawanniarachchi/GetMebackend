const fs = require('fs/promises');
const path = require('path');

const pool = require('../../config/db');
const { recordChange } = require('../../inventory/stockService');
const { actorOf, recordShopActivity } = require('../../middleware/shopAccess');

const { barcodeKey } = require('../../utils/barcode');
const { readProductSheet, buildProductTemplate } = require('../../utils/productSheet');
const {
  readProduct,
  linkCatalog,
  isDuplicateBarcodeError,
} = require('./shopProductController');

// =====================================================
// BULK PRODUCT IMPORT (Excel / CSV)
// The shop uploads the same file twice: `mode=preview` checks every
// row without saving, `mode=import` saves the rows that passed.
// Existing products are matched by barcode (or, without one, by name)
// and are skipped unless `updateExisting=true`.
// =====================================================

// Served at /uploads/products (see app.js)
const PRODUCT_UPLOADS = path.join(__dirname, '../../../uploads/products');

const lowerName = (name) => name.trim().toLowerCase();

const summaryOf = (value, image) => ({
  productName: value.productName,
  category: value.category,
  price: value.price,
  stockQuantity: value.stockQuantity,
  unit: value.unit,
  barcode: value.barcode,
  hasPhoto: Boolean(image),
});

// Sheet photo -> /uploads/products/... (same naming as form uploads)
const savePhoto = async (image) => {
  const fileName = `product-${Date.now()}-${Math.round(Math.random() * 1e9)}.${image.extension}`;

  await fs.writeFile(path.join(PRODUCT_UPLOADS, fileName), image.buffer);

  return `/uploads/products/${fileName}`;
};

// Sheet rows -> [{ row, status: create|update|skip|error, message?, product, value?, image?, productId? }]
const planImport = async (shopId, sheetRows, updateExisting) => {
  const existing = await pool.query(
    'SELECT id, product_name, barcode FROM products WHERE shop_id = $1',
    [shopId]
  );

  const byBarcode = new Map();
  const byName = new Map();

  existing.rows.forEach((product) => {
    if (product.barcode) byBarcode.set(barcodeKey(product.barcode), product);

    const name = lowerName(product.product_name);
    byName.set(name, [...(byName.get(name) || []), product]);
  });

  const barcodeRows = new Map();
  const nameRows = new Map();

  return sheetRows.map(({ row, fields, error: sheetError, image, imageError }) => {
    const failed = (message) => ({
      row,
      status: 'error',
      message,
      // What the sheet said, so the shop can find the row
      product: {
        productName: fields?.productName?.trim() || '',
        category: fields?.category?.trim() || '',
        barcode: fields?.barcode || null,
        hasPhoto: Boolean(image),
      },
    });

    if (sheetError) return failed(sheetError);

    const { value, error, warning } = readProduct(fields);

    if (error) return failed(error);

    let match = null;

    if (value.barcode) {
      const key = barcodeKey(value.barcode);

      if (barcodeRows.has(key)) return failed(`Same barcode as row ${barcodeRows.get(key)}`);

      barcodeRows.set(key, row);
      match = byBarcode.get(key) || null;
    } else {
      const name = lowerName(value.productName);
      const named = byName.get(name) || [];

      if (nameRows.has(name)) return failed(`Same product as row ${nameRows.get(name)}. Add a barcode if they differ`);
      if (named.length > 1) return failed('You list more than one product with this name. Add a barcode to choose one');

      nameRows.set(name, row);
      match = named[0] || null;
    }

    const product = summaryOf(value, image);

    if (match && !updateExisting) {
      return { row, status: 'skip', message: `Already listed as "${match.product_name}"`, product };
    }

    const saved = { row, value, image, product, message: [warning, imageError].filter(Boolean).join('. ') || null };

    return match
      ? { ...saved, status: 'update', productId: match.id }
      : { ...saved, status: 'create' };
  });
};

const createProduct = async (client, shopId, value, imageUrl, actor) => {
  const catalog = await linkCatalog(client, shopId, value, imageUrl);

  const created = await client.query(
    `
    INSERT INTO products
      (shop_id, product_name, category, price, stock_quantity, description, is_available, image_url, unit, barcode, brand, size, catalog_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id
    `,
    [
      shopId,
      value.productName,
      value.category,
      value.price,
      value.stockQuantity,
      value.description,
      value.isAvailable,
      // No photo in the sheet: use the catalogue's
      imageUrl || catalog?.image_url || null,
      value.unit,
      value.barcode,
      value.brand,
      value.size,
      catalog?.id || null,
    ]
  );

  await recordChange(client, {
    shopId, productId: created.rows[0].id, before: 0, after: value.stockQuantity, reason: 'import', actor,
  });
};

// Blank optional cells keep what the product already has. A photo in
// the sheet replaces the current one; without one, the catalogue photo
// only fills a missing image.
const updateProduct = async (client, shopId, productId, value, imageUrl, actor) => {
  const before = (
    await client.query('SELECT stock_quantity FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE', [productId, shopId])
  ).rows[0];
  const catalog = await linkCatalog(client, shopId, value, imageUrl);

  await client.query(
    `
    UPDATE products
    SET
      product_name = $1,
      category = $2,
      price = $3,
      stock_quantity = $4,
      is_available = $5,
      unit = $6,
      description = COALESCE($7, description),
      barcode = COALESCE($8, barcode),
      brand = COALESCE($9, brand),
      size = COALESCE($10, size),
      catalog_id = CASE WHEN $8::text IS NULL THEN catalog_id ELSE $11 END,
      image_url = COALESCE($15, image_url, $12),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $13 AND shop_id = $14
    `,
    [
      value.productName,
      value.category,
      value.price,
      value.stockQuantity,
      value.isAvailable,
      value.unit,
      value.description,
      value.barcode,
      value.brand,
      value.size,
      catalog?.id || null,
      catalog?.image_url || null,
      productId,
      shopId,
      imageUrl,
    ]
  );

  if (before) {
    await recordChange(client, {
      shopId, productId, before: before.stock_quantity, after: value.stockQuantity, reason: 'import', actor,
    });
  }
};

// Each row saves on its own savepoint, so one bad row doesn't undo the rest
const applyImport = async (shopId, plan, actor) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const item of plan) {
      if (item.status !== 'create' && item.status !== 'update') continue;

      await client.query('SAVEPOINT import_row');
      let imageUrl = null;

      try {
        if (item.image) imageUrl = await savePhoto(item.image);

        if (item.status === 'create') await createProduct(client, shopId, item.value, imageUrl, actor);
        else await updateProduct(client, shopId, item.productId, item.value, imageUrl, actor);

        await client.query('RELEASE SAVEPOINT import_row');
        item.status = item.status === 'create' ? 'created' : 'updated';
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT import_row');

        if (imageUrl) await fs.unlink(path.join(PRODUCT_UPLOADS, path.basename(imageUrl))).catch(() => {});

        if (!isDuplicateBarcodeError(error)) {
          console.error(`❌ importProducts row ${item.row} error:`, error.message);
        }

        item.status = 'error';
        item.message = isDuplicateBarcodeError(error)
          ? 'You already list this barcode'
          : 'Could not save this row';
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};


// =====================================================
// IMPORT
// POST /api/shop/products/import
// multipart: file (.xlsx / .csv), mode=preview|import, updateExisting
// =====================================================

const importProducts = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Choose an .xlsx or .csv file' });
    }

    const sheet = await readProductSheet(req.file.buffer, req.file.originalname);

    if (sheet.error) {
      return res.status(400).json({ success: false, message: sheet.error });
    }

    const saving = req.body?.mode === 'import';
    const plan = await planImport(req.shop.shopId, sheet.rows, req.body?.updateExisting === 'true');

    if (saving) await applyImport(req.shop.shopId, plan, actorOf(req));

    const rows = plan.map(({ row, status, message, product }) => ({ row, status, message: message || null, product }));
    const summary = rows.reduce(
      (counts, { status }) => ({ ...counts, [status]: (counts[status] || 0) + 1 }),
      { total: rows.length }
    );

    // A saved import with rows that failed shows up in notifications
    if (saving && summary.error) {
      recordShopActivity({
        shopId: req.shop.shopId,
        actor: actorOf(req),
        action: 'product.import_failed',
        entityType: 'import',
        summary: `${summary.error} of ${summary.total} rows could not be imported`,
        details: { file: req.file.originalname, summary, failed: rows.filter((r) => r.status === 'error').slice(0, 20) },
      });
    }

    return res.json({ success: true, imported: saving, summary, rows });
  } catch (error) {
    console.error('❌ importProducts error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to import products' });
  }
};


// =====================================================
// TEMPLATE
// GET /api/shop/products/import/template -> .xlsx
// =====================================================

const getImportTemplate = async (req, res) => {
  try {
    const buffer = await buildProductTemplate();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="getme-products-template.xlsx"');

    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('❌ getImportTemplate error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to create the template' });
  }
};

module.exports = {
  importProducts,
  getImportTemplate,
};
