-- ==================================================
-- PLATFORM PHASE 8 — shared product catalogue (manufacturer barcodes)
-- Run once: node src/sql/runSql.js src/sql/platform_phase8_product_catalog.sql
-- Safe to re-run.
-- ==================================================

-- One row per manufacturer barcode (EAN-13 / EAN-8 / UPC-A / UPC-E
-- as printed on the pack). The first shop to register a barcode
-- creates the row; other shops selling the same product link to it
-- and keep their own price, stock and availability in `products`.
-- barcode_key drops leading zeros, so the UPC-A and EAN-13 forms of
-- one code are the same product (same rule as the ShopperApp check).
CREATE TABLE IF NOT EXISTS product_catalog (
  id SERIAL PRIMARY KEY,
  barcode VARCHAR(64) NOT NULL,
  barcode_key VARCHAR(64) NOT NULL,
  product_name VARCHAR(150) NOT NULL,
  brand VARCHAR(80) NULL,
  size VARCHAR(40) NULL,
  category VARCHAR(60) NULL,
  image_url TEXT NULL,
  created_by_shop_id INTEGER NULL REFERENCES shops(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_catalog_barcode_key
  ON product_catalog (barcode_key);

-- Shop products: brand / pack size, and the shared identity
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand VARCHAR(80) NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS size VARCHAR(40) NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS catalog_id INTEGER NULL
    REFERENCES product_catalog(id) ON DELETE SET NULL;

-- A shop lists each barcode once (fresh / loose items have none)
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_shop_barcode_key
  ON products (shop_id, LTRIM(barcode, '0'))
  WHERE barcode IS NOT NULL;

-- Backfill: products that already have a barcode get a catalogue row
-- (oldest product wins) and are linked to it
INSERT INTO product_catalog
  (barcode, barcode_key, product_name, category, image_url, created_by_shop_id)
SELECT DISTINCT ON (LTRIM(barcode, '0'))
  barcode, LTRIM(barcode, '0'), product_name, category, image_url, shop_id
FROM products
WHERE barcode IS NOT NULL AND LTRIM(barcode, '0') <> ''
ORDER BY LTRIM(barcode, '0'), id
ON CONFLICT (barcode_key) DO NOTHING;

UPDATE products p
SET catalog_id = c.id
FROM product_catalog c
WHERE p.barcode IS NOT NULL
  AND p.catalog_id IS NULL
  AND c.barcode_key = LTRIM(p.barcode, '0');
