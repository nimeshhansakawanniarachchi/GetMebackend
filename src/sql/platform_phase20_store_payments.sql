-- =====================================================
-- PLATFORM PHASE 20 — shopper pays the store, GetMe reimburses
-- Run once: node src/sql/runSql.js src/sql/platform_phase20_store_payments.sql
--
-- The shopper pays the supermarket till (cash, their own card /
-- Google Wallet, or a LANKAQR bank app) and records what the till
-- charged. One record per order + shop, linked to that shop's bill
-- photos. The backend compares it with the expected cost of the
-- items bought; a big difference waits for admin review. GetMe then
-- reimburses the shopper (bank transfer, reference stored here).
-- No card data: at most the last 4 digits / a QR reference.
-- =====================================================

CREATE TABLE IF NOT EXISTS store_payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  shop_id INTEGER NOT NULL,
  shopper_id INTEGER NOT NULL,
  method VARCHAR(20) NOT NULL CHECK (method IN ('cash', 'card', 'lankaqr')),
  amount_paid NUMERIC(12, 2) NOT NULL CHECK (amount_paid > 0),
  expected_amount NUMERIC(12, 2) NOT NULL,
  variance NUMERIC(12, 2) NOT NULL,
  reference VARCHAR(40),
  note TEXT,
  -- ok: within tolerance; needs_review: over it; approved / queried by an admin
  review_status VARCHAR(20) NOT NULL DEFAULT 'ok'
    CHECK (review_status IN ('ok', 'needs_review', 'approved', 'queried')),
  review_note TEXT,
  reviewed_by INTEGER,
  reviewed_at TIMESTAMPTZ,
  -- owed: GetMe owes the shopper; held: waiting for review; reimbursed
  reimbursement_status VARCHAR(20) NOT NULL DEFAULT 'owed'
    CHECK (reimbursement_status IN ('owed', 'held', 'reimbursed')),
  reimbursement_reference VARCHAR(60),
  reimbursed_at TIMESTAMPTZ,
  reimbursed_by INTEGER,
  -- Set when the bill photo is uploaded: the record can't change after
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, shop_id)
);

CREATE INDEX IF NOT EXISTS store_payments_review_idx
  ON store_payments (reimbursement_status, review_status);
CREATE INDEX IF NOT EXISTS store_payments_shopper_idx
  ON store_payments (shopper_id);
