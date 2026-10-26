-- =====================================================
-- PLATFORM PHASE 27 — shop portal (staff, stock history, hours)
-- Run once: node src/sql/runSql.js src/sql/platform_phase27_shop_portal.sql
--
--   shop_staff                staff logins per shop (the shop's own
--                             login stays the Owner)
--                             role: manager | staff
--   shop_activity_log         who changed what in a shop (owner,
--                             staff, GetMe system / shopper events)
--   product_stock_movements   every stock change with its reason;
--                             one 'sold_getme' row per order item
--                             (unique) so a GetMe sale deducts once
--   shops.opening_hours       { mon: { open: "08:00", close: "21:00",
--                             closed: false }, ... } (Asia/Colombo)
--   shops.auto_open           server opens / closes on those hours
--   shops.open_override_until a manual open / close holds until then
--   shops.low_stock_threshold "low stock" = 1..threshold units
-- All additive.
-- =====================================================

CREATE TABLE IF NOT EXISTS shop_staff (
  id SERIAL PRIMARY KEY,
  shop_id INT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  full_name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL,
  mobile VARCHAR(20),
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'staff' CHECK (role IN ('manager', 'staff')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shop_staff_email ON shop_staff (LOWER(email));
CREATE INDEX IF NOT EXISTS shop_staff_shop_idx ON shop_staff (shop_id);

CREATE TABLE IF NOT EXISTS shop_activity_log (
  id BIGSERIAL PRIMARY KEY,
  shop_id INT NOT NULL,
  actor_type VARCHAR(20) NOT NULL,         -- owner | staff | system
  actor_id INT,
  actor_name VARCHAR(120),
  actor_role VARCHAR(20),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(30),
  entity_id VARCHAR(40),
  summary VARCHAR(300),
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shop_activity_shop_idx ON shop_activity_log (shop_id, created_at DESC);

CREATE TABLE IF NOT EXISTS product_stock_movements (
  id BIGSERIAL PRIMARY KEY,
  shop_id INT NOT NULL,
  product_id INT NOT NULL,
  change INT NOT NULL,
  stock_before INT NOT NULL,
  stock_after INT NOT NULL,
  reason VARCHAR(30) NOT NULL,
  note VARCHAR(300),
  order_id INT,
  order_item_id INT,
  actor_type VARCHAR(20) NOT NULL,
  actor_id INT,
  actor_name VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (stock_after >= 0)
);

CREATE INDEX IF NOT EXISTS stock_moves_product_idx ON product_stock_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS stock_moves_shop_idx ON product_stock_movements (shop_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_moves_getme_item
  ON product_stock_movements (order_item_id) WHERE reason = 'sold_getme';

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS opening_hours JSONB,
  ADD COLUMN IF NOT EXISTS auto_open BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS open_override_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS low_stock_threshold INT NOT NULL DEFAULT 5;
