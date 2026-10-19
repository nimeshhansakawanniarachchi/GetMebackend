const pool = require('../../config/db');

const { toProduct } = require('./shopFormat');

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

  return {
    value: {
      unit,
      productName,
      category,
      description: description || null,
      price,
      stockQuantity,
      isAvailable,
    },
  };
};

const productIdOf = (req) => {
  const id = Number(req.params.id);

  return Number.isInteger(id) && id > 0 ? id : null;
};


// =====================================================
// LIST
// GET /api/shop/products
// =====================================================

const getProducts = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM products WHERE shop_id = $1 ORDER BY id DESC',
      [req.shop.shopId]
    );

    return res.json({
      success: true,
      products: result.rows.map(toProduct),
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

    const imageUrl = req.file
      ? `/uploads/products/${req.file.filename}`
      : null;

    const result = await pool.query(
      `
      INSERT INTO products
        (shop_id, product_name, category, price, stock_quantity, description, is_available, image_url, unit)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        imageUrl,
        value.unit,
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Product added',
      product: toProduct(result.rows[0]),
    });
  } catch (error) {
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

    const result = await pool.query(
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
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    return res.json({
      success: true,
      message: 'Product updated',
      product: toProduct(result.rows[0]),
    });
  } catch (error) {
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

    const result = await pool.query(
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

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
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

module.exports = {
  getProducts,
  getProduct,
  addProduct,
  updateProduct,
  patchProduct,
  deleteProduct,
};
