-- ==================================================
-- PLATFORM PHASE 14 — shop offers on products (phase 1)
-- Run once: node src/sql/runSql.js src/sql/platform_phase14_product_offers.sql
-- Safe to re-run.
-- ==================================================

-- An offer a shop runs on its own products (usually one its till
-- also applies). The server prices orders with the best active
-- offer (src/pricing/offers.js); shops manage them in GetMe-Shop,
-- admins can pause them.
CREATE TABLE IF NOT EXISTS product_offers (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,

  -- What it covers: one product, one category, or the whole shop
  scope VARCHAR(20) NOT NULL,
  product_id INTEGER NULL REFERENCES products(id) ON DELETE CASCADE,
  category VARCHAR(100) NULL,

  -- percent: value = % off (1-90)
  -- sale_price: value = the new price (one product only)
  discount_type VARCHAR(20) NOT NULL,
  discount_value NUMERIC(10, 2) NOT NULL,

  -- Shown to customers, e.g. "Weekend deal"; NULL = "20% off"
  title VARCHAR(80) NULL,

  starts_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ends_at TIMESTAMP NULL,

  -- Shop's own on/off switch
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  -- Admin pause (the shop can't undo it)
  paused_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  admin_note VARCHAR(300) NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_offers_scope_check') THEN
    ALTER TABLE product_offers ADD CONSTRAINT product_offers_scope_check CHECK (
      (scope = 'product' AND product_id IS NOT NULL)
      OR (scope = 'category' AND category IS NOT NULL AND discount_type = 'percent')
      OR (scope = 'shop' AND discount_type = 'percent')
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_offers_type_check') THEN
    ALTER TABLE product_offers ADD CONSTRAINT product_offers_type_check CHECK (
      (discount_type = 'percent' AND discount_value > 0 AND discount_value <= 90)
      OR (discount_type = 'sale_price' AND discount_value > 0)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS product_offers_shop_idx ON product_offers (shop_id);
CREATE INDEX IF NOT EXISTS product_offers_product_idx ON product_offers (product_id);

-- What each line was charged with, fixed when the order is placed
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS original_unit_price NUMERIC(10, 2) NULL,
  ADD COLUMN IF NOT EXISTS offer_id INTEGER NULL REFERENCES product_offers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offer_label VARCHAR(80) NULL;

-- Total saved through shop offers (separate from promo discount)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS offer_savings NUMERIC(10, 2) NOT NULL DEFAULT 0;
