-- =====================================================
-- PLATFORM PHASE 28 — order cancellations
-- Run once: node src/sql/runSql.js src/sql/platform_phase28_cancellations.sql
--
--   orders.cancelled_at           when the order was cancelled
--   orders.cancelled_from_status  status it had just before
--   orders.cancel_reason_code     customer's reason (list in
--                                 src/orders/cancelPolicy.js)
--   order_cancellations           one row per cancelled order
--                                 (UNIQUE order_id: a second cancel
--                                 can't be recorded), who / why /
--                                 from which stage, and the money
--                                 position at that moment
-- Rules (customer: free until shopping starts) live in
-- platform_settings 'pricing'.cancellation (admin Fees & pricing).
-- All additive.
-- =====================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_from_status VARCHAR(40);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason_code VARCHAR(40);

CREATE TABLE IF NOT EXISTS order_cancellations (
  id BIGSERIAL PRIMARY KEY,
  order_id INT NOT NULL,
  cancelled_by VARCHAR(20) NOT NULL CHECK (cancelled_by IN ('customer', 'admin', 'system')),
  actor_id INT,
  reason_code VARCHAR(40),
  reason_text TEXT,
  from_status VARCHAR(40) NOT NULL,
  shopper_id INT,
  items_bought INT NOT NULL DEFAULT 0,
  failed_delivery BOOLEAN NOT NULL DEFAULT FALSE,
  payment_method VARCHAR(20),
  -- Card money held when cancelled, and what the customer still
  -- owes (bought groceries + fee, or 0). Refunds themselves are in
  -- card_payment_refunds (only once PayHere confirms them).
  amount_held NUMERIC(12, 2),
  amount_owed NUMERIC(12, 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_order_cancellations_order ON order_cancellations (order_id);
CREATE INDEX IF NOT EXISTS order_cancellations_created_idx ON order_cancellations (created_at DESC);
