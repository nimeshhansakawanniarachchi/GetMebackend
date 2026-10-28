-- =====================================================
-- PHASE 33: cash-order (COD) hand-over, net of the shopper's balances
-- (owner's choice 2026-10-28: keep the customer-paid GetMe fee; the
-- shopper hands over only what they owe after their released
-- earnings and approved grocery reimbursements)
--
-- One row per hand-over recorded by a finance admin. The cash the
-- shopper collected (cash_due) is settled in full, booked like a
-- withdrawal's cash netting so nothing is counted twice:
--   shopper_payouts cash_deposit   = cash_due      (reference CS<id>)
--   shopper_payouts earnings       = offset_earnings       (CS<id>)
--   shopper_payouts reimbursement  = offset_reimbursement  (CS<id>)
--   handed_over = cash_due - offset_earnings - offset_reimbursement
--     (the physical cash GetMe received; mostly the GetMe fee)
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS cash_settlements (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  cash_due NUMERIC(12, 2) NOT NULL CHECK (cash_due > 0),
  handed_over NUMERIC(12, 2) NOT NULL CHECK (handed_over >= 0),
  offset_earnings NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (offset_earnings >= 0),
  offset_reimbursement NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (offset_reimbursement >= 0),
  -- Cash receipt / deposit slip number (required when cash changed hands)
  reference VARCHAR(60),
  note VARCHAR(300),
  client_request_id VARCHAR(64),
  created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cash_settlements_parts_check
    CHECK (handed_over + offset_earnings + offset_reimbursement = cash_due)
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_settlements_request_key
  ON cash_settlements (shopper_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cash_settlements_reference_key
  ON cash_settlements (LOWER(reference))
  WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS cash_settlements_shopper_idx
  ON cash_settlements (shopper_id, created_at DESC);

-- Which hand-over settled an order's cash
ALTER TABLE shopper_earnings
  ADD COLUMN IF NOT EXISTS cash_settlement_id INTEGER REFERENCES cash_settlements(id) ON DELETE SET NULL;

COMMIT;
