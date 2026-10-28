-- =====================================================
-- PHASE 32: grocery reimbursements are withdrawn with earnings
-- (owner's rules 2026-10-28)
--   * a withdrawal has an earnings part and a grocery reimbursement
--     part (kept apart for the books: reimbursements are not earnings)
--   * a reimbursement is only released once the backend has confirmed
--     the customer's payment (card charge held / cash collected at the
--     door); otherwise it waits for an admin
--   * receipt photos are fingerprinted (SHA-256) and a store payment
--     whose receipt photo or till reference was already used on
--     another order goes to admin review
-- Admins no longer reimburse directly: reimbursements are paid only
-- through withdrawals (shopperWallet.changeWithdrawal 'pay').
-- =====================================================

BEGIN;

-- ---------- Withdrawals: earnings part + reimbursement part ----------

ALTER TABLE shopper_withdrawals
  ADD COLUMN IF NOT EXISTS earnings_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reimbursement_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  -- Cash owed to GetMe settled out of the reimbursement (the rest of
  -- cash_netted came out of earnings)
  ADD COLUMN IF NOT EXISTS cash_netted_reimbursement NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- Withdrawals before this phase were earnings only
UPDATE shopper_withdrawals
SET earnings_amount = amount
WHERE earnings_amount = 0 AND reimbursement_amount = 0;

ALTER TABLE shopper_withdrawals DROP CONSTRAINT IF EXISTS shopper_withdrawals_parts_check;
ALTER TABLE shopper_withdrawals
  ADD CONSTRAINT shopper_withdrawals_parts_check
  CHECK (
    earnings_amount >= 0
    AND reimbursement_amount >= 0
    AND earnings_amount + reimbursement_amount = amount
  );

-- ---------- Store payments: customer payment check + duplicates ----------

ALTER TABLE store_payments
  -- pending      order not finished yet
  -- confirmed    the backend saw the customer's money (card charge
  --              held, or cash collected at a delivered order)
  -- unconfirmed  finished but no customer money (e.g. a cash order
  --              cancelled after purchase): waits for an admin
  -- overridden   an admin released it anyway (recorded who / why)
  ADD COLUMN IF NOT EXISTS customer_payment_check VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS customer_payment_note VARCHAR(300),
  ADD COLUMN IF NOT EXISTS customer_payment_override_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS customer_payment_override_at TIMESTAMPTZ,
  -- [{ type: 'receipt_photo' | 'reference', orderId, shopId }]
  ADD COLUMN IF NOT EXISTS duplicate_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The withdrawal whose payment covered this reimbursement in full
  ADD COLUMN IF NOT EXISTS reimbursement_withdrawal_id INTEGER REFERENCES shopper_withdrawals(id) ON DELETE SET NULL;

ALTER TABLE store_payments DROP CONSTRAINT IF EXISTS store_payments_customer_payment_check_check;
ALTER TABLE store_payments
  ADD CONSTRAINT store_payments_customer_payment_check_check
  CHECK (customer_payment_check IN ('pending', 'confirmed', 'unconfirmed', 'overridden'));

-- Already reimbursed before this phase: nothing left to check
UPDATE store_payments
SET customer_payment_check = 'confirmed'
WHERE reimbursement_status = 'reimbursed' AND customer_payment_check = 'pending';

CREATE INDEX IF NOT EXISTS store_payments_shop_reference_idx
  ON store_payments (shop_id, LOWER(reference))
  WHERE reference IS NOT NULL;

-- ---------- Receipt photo fingerprints ----------

ALTER TABLE order_shop_bills
  ADD COLUMN IF NOT EXISTS bill_hashes TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS order_shop_bills_hashes_idx
  ON order_shop_bills USING GIN (bill_hashes);

COMMIT;
