-- ==================================================
-- PLATFORM PHASE 15 — delivery photo (Instacart "Order complete")
-- Run once: node src/sql/runSql.js src/sql/platform_phase15_delivery_photo.sql
-- Safe to re-run.
-- ==================================================

-- Photo the shopper takes of the order at the door
-- (/uploads/deliveries/...). NULL = no photo.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_photo_url TEXT NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_photo_at TIMESTAMPTZ NULL;
