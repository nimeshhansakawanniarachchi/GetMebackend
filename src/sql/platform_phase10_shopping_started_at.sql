-- ==================================================
-- PLATFORM PHASE 10 — when shopping started
-- Run once: node src/sql/runSql.js src/sql/platform_phase10_shopping_started_at.sql
-- Safe to re-run.
-- ==================================================

-- Set the first time the shopper starts shopping; the ShopperApp's
-- shopping list shows the time spent since then (Instacart "Time").
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shopping_started_at TIMESTAMP NULL;
