-- ==================================================
-- PLATFORM PHASE 9 — refund an unavailable item
-- Run once: node src/sql/runSql.js src/sql/platform_phase9_item_refunds.sql
-- Safe to re-run.
-- ==================================================

-- An item the shopper couldn't find and refunded instead of
-- replacing: shopping_status = 'refunded', found_quantity = 0,
-- refund_amount = what the customer is refunded for it.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10, 2) NULL;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP NULL;
