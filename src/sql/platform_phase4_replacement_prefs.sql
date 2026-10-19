-- ==================================================
-- PLATFORM PHASE 4 — replacement preferences
-- Run once: node src/sql/runSql.js src/sql/platform_phase4_replacement_prefs.sql
-- Safe to re-run.
-- ==================================================

-- What the customer wants if an item is out of stock:
--   best_match : shopper picks, customer approves the photo (default)
--   specific   : a backup product and/or note chosen by the customer
--   refund     : don't replace, refund the item
-- The product name/image/price are snapshots taken when ordering.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS replacement_preference VARCHAR(20) NOT NULL DEFAULT 'best_match',
  ADD COLUMN IF NOT EXISTS replacement_product_id INTEGER NULL,
  ADD COLUMN IF NOT EXISTS replacement_product_name VARCHAR(150) NULL,
  ADD COLUMN IF NOT EXISTS replacement_product_image TEXT NULL,
  ADD COLUMN IF NOT EXISTS replacement_product_price NUMERIC(10,2) NULL,
  ADD COLUMN IF NOT EXISTS replacement_note VARCHAR(300) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_items_replacement_preference_check'
  ) THEN
    ALTER TABLE order_items
      ADD CONSTRAINT order_items_replacement_preference_check
      CHECK (replacement_preference IN ('best_match', 'specific', 'refund'));
  END IF;
END $$;
