-- ==================================================
-- PLATFORM PHASE 12 — shop brand color
-- Run once: node src/sql/runSql.js src/sql/platform_phase12_shop_brand_color.sql
-- Safe to re-run.
-- ==================================================

-- The customer app paints the store page header in this color
-- (Instacart style) with white text on it. NULL = the app picks a
-- color from the shop id. Stored as uppercase "#RRGGBB"; admins set
-- it from the admin panel.
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS brand_color VARCHAR(7) NULL;

ALTER TABLE shops
  DROP CONSTRAINT IF EXISTS shops_brand_color_hex;

ALTER TABLE shops
  ADD CONSTRAINT shops_brand_color_hex
  CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9A-F]{6}$');
