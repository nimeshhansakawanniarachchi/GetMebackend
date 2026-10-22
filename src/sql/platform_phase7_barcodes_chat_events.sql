-- ==================================================
-- PLATFORM PHASE 7 — product barcodes + chat timeline events
-- Run once: node src/sql/runSql.js src/sql/platform_phase7_barcodes_chat_events.sql
-- Safe to re-run.
-- ==================================================

-- Product barcode (EAN/UPC/PLU), set by the shop. The ShopperApp
-- scans a replacement and checks it against this; NULL = not set
-- (the scan is then accepted without a check).
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS barcode VARCHAR(64) NULL;

-- Look a scanned barcode up within one shop
CREATE INDEX IF NOT EXISTS idx_products_shop_barcode
  ON products (shop_id, barcode)
  WHERE barcode IS NOT NULL;

-- Chat timeline events ("Melanie was notified that you started
-- shopping"). Event rows have sender_type = 'system', sender_id = 0
-- and a plain-text message as a fallback; the apps word them from
-- event_type + event_data for each side.
--   event_type: shopping_started | item_unavailable |
--               item_replaced | replacement_approved
--   event_data: { itemName, replacementName, ... }
ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS event_type VARCHAR(40) NULL;

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS event_data JSONB NULL;
