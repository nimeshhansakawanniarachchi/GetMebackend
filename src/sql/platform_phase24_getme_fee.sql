-- =====================================================
-- PLATFORM PHASE 24 — GetMe fee charged to the customer
-- Run once: node src/sql/runSql.js src/sql/platform_phase24_getme_fee.sql
--
-- Customer pays (pricing/quote.js):
--   groceries + delivery fee + priority (fast) fee
--   + service fee (LKR 50 per item unit, pricing settings)
--   - discounts                                   = fee base
--   + GetMe fee (getme_fee_percent of the fee base; tip excluded)
--   + tip
-- Shopper earns (shopper_earnings): delivery + priority + service
-- fee + 100% of the tip (+ approved adjustments), nothing deducted;
-- grocery spend is reimbursed separately (store_payments).
-- GetMe keeps the GetMe fee (getme_fee_kept once settled) and pays
-- the gateway fee.
-- =====================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS getme_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS getme_fee_percent NUMERIC(5, 2) NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS service_fee_per_unit NUMERIC(12, 2) NOT NULL DEFAULT 50,
  -- What GetMe keeps after delivery / cancellation (set at settlement)
  ADD COLUMN IF NOT EXISTS getme_fee_kept NUMERIC(12, 2),
  -- Admin-confirmed failed delivery (status becomes 'cancelled')
  ADD COLUMN IF NOT EXISTS failed_delivery_at TIMESTAMPTZ;

ALTER TABLE shopper_earnings
  ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS priority_fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment_note TEXT;
