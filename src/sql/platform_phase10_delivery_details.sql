-- ==================================================
-- PLATFORM PHASE 10 — delivery details + flexible windows
-- Run once: node src/sql/runSql.js src/sql/platform_phase10_delivery_details.sql
-- Safe to re-run.
-- ==================================================

-- How the customer wants the order handed over:
-- 'leave_at_door' | 'meet_at_door'
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_dropoff VARCHAR(20) NULL;

-- Free-text note for the shopper ("walk up the steps")
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivery_instructions TEXT NULL;

-- Number the shopper calls for this order (+94XXXXXXXXX).
-- NULL = use the customer's account mobile.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(20) NULL;

-- Saving for picking a flexible (longer) scheduled window.
-- Kept apart from discount_amount, which is the promo only.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS window_discount NUMERIC(10, 2) NOT NULL DEFAULT 0;
