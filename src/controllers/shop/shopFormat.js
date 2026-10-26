// =====================================================
// SHOP API RESPONSE SHAPES (camelCase, one place)
// =====================================================

const toShop = (row) => ({
  id: row.id,
  shopName: row.shop_name,
  email: row.email,
  mobile: row.mobile,
  address: row.address,
  area: row.area || null,
  latitude: row.latitude != null ? Number(row.latitude) : null,
  longitude: row.longitude != null ? Number(row.longitude) : null,
  status: row.status,
  isOpen: row.is_open !== false,
  imageUrl: row.image_url || null,
  // Store page header color in the customer app; null = automatic
  brandColor: row.brand_color || null,
  // Opening hours (phase 27, Asia/Colombo) and auto open / close
  openingHours: row.opening_hours || null,
  autoOpen: row.auto_open === true,
  openOverrideUntil: row.open_override_until || null,
  lowStockThreshold: row.low_stock_threshold != null ? Number(row.low_stock_threshold) : 5,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toProduct = (row) => ({
  id: row.id,
  shopId: row.shop_id,
  productName: row.product_name,
  category: row.category,
  price: Number(row.price || 0),
  unit: row.unit || 'item',
  barcode: row.barcode || '',
  brand: row.brand || '',
  size: row.size || '',
  // Linked to the shared catalogue (manufacturer barcode)
  catalogId: row.catalog_id || null,
  stockQuantity: Number(row.stock_quantity || 0),
  description: row.description || '',
  imageUrl: row.image_url || null,
  isAvailable: row.is_available !== false,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const { statusLabel } = require('../../utils/orderStatus');

const firstName = (fullName) =>
  String(fullName || 'Customer').trim().split(/\s+/)[0];

module.exports = {
  toShop,
  toProduct,
  statusLabel,
  firstName,
};
