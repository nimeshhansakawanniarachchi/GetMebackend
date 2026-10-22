const pool = require('../config/db');

// =====================================================
// SHOPPER PRODUCT LOOKUPS (replacement scan flow)
// Public catalogue fields only.
// =====================================================

const toPositiveInt = (value) => {
  const number = Number(value);

  return Number.isInteger(number) && number > 0 ? number : null;
};

const toProduct = (row) => ({
  id: row.id,
  shopId: row.shop_id,
  name: row.product_name,
  category: row.category,
  price: Number(row.price || 0),
  unit: row.unit || 'item',
  imageUrl: row.image_url || null,
  barcode: row.barcode || null,
  isAvailable: row.is_available !== false,
});

// GET /api/shopper/products/:productId
// The replacement's details (name, price, aisle/category, barcode)
const getProductDetails = async (req, res) => {
  try {
    const productId = toPositiveInt(req.params.productId);

    if (!productId) {
      return res.status(400).json({ success: false, message: 'Invalid product ID' });
    }

    const result = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    return res.json({ success: true, product: toProduct(result.rows[0]) });
  } catch (error) {
    console.error('Get product details error:', error);

    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

// GET /api/shopper/shops/:shopId/products/by-barcode/:barcode
// What the shopper scanned: { product } or { product: null }
const getProductByBarcode = async (req, res) => {
  try {
    const shopId = toPositiveInt(req.params.shopId);
    const barcode = String(req.params.barcode || '').replace(/\s+/g, '');

    if (!shopId || !/^[0-9A-Za-z-]{4,64}$/.test(barcode)) {
      return res.status(400).json({
        success: false,
        message: 'Valid shopId and barcode are required',
      });
    }

    // Leading zeros ignored (UPC-A vs EAN-13), as when verifying
    const result = await pool.query(
      `
      SELECT * FROM products
      WHERE shop_id = $1
        AND ltrim(barcode, '0') = ltrim($2, '0')
      ORDER BY id
      LIMIT 1
      `,
      [shopId, barcode]
    );

    return res.json({
      success: true,
      product: result.rows[0] ? toProduct(result.rows[0]) : null,
    });
  } catch (error) {
    console.error('Get product by barcode error:', error);

    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = {
  getProductDetails,
  getProductByBarcode,
};
