-- ==================================================
-- PLATFORM PHASE 11 — several receipt photos per shop bill
-- Run once: node src/sql/runSql.js src/sql/platform_phase11_bill_photos.sql
-- Safe to re-run.
-- ==================================================

-- Long receipts are photographed in parts. bill_url stays the first
-- photo (everything that reads it keeps working); bill_urls has all
-- of them, in order, e.g. ["/uploads/bills/a.jpg", "/uploads/bills/b.jpg"].
ALTER TABLE order_shop_bills
  ADD COLUMN IF NOT EXISTS bill_urls JSONB NULL;
