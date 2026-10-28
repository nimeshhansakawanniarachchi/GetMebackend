-- =====================================================
-- PHASE 31: SHOPPER WALLET + WITHDRAWALS
-- The shopper asks to withdraw part of their earnings to their own
-- bank account; a finance admin pays it by bank transfer (CEFTS /
-- SLIPS - there is no payout API) and records the reference.
-- Rules (owner's choice 2026-10-28): cash still owed to GetMe from
-- cash orders is deducted from what can be withdrawn; any amount
-- from the minimum (settings, LKR 500) up to the available balance;
-- bank transfer only; a new bank account is verified by an admin
-- before it can be paid. Grocery reimbursements are not part of it.
-- Balance: src/wallet/shopperWallet.js. Safe to run more than once.
-- =====================================================

-- The shopper's own bank accounts. The account number is stored
-- encrypted (AES-256-GCM, src/wallet/accountVault.js); the apps only
-- ever get the last 4 digits. Never: passwords, PINs, OTPs.
CREATE TABLE IF NOT EXISTS shopper_payout_accounts (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  method VARCHAR(20) NOT NULL DEFAULT 'bank' CHECK (method IN ('bank')),
  bank_name VARCHAR(80) NOT NULL,
  branch_name VARCHAR(80) NOT NULL,
  account_holder_name VARCHAR(120) NOT NULL,
  account_number_encrypted TEXT NOT NULL,
  account_last4 VARCHAR(4) NOT NULL,
  -- HMAC of the number: one shopper can't add the same account twice
  account_number_hash VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  status_note VARCHAR(300),
  reviewed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS shopper_payout_accounts_unique_number
  ON shopper_payout_accounts (shopper_id, account_number_hash)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS shopper_payout_accounts_status_idx
  ON shopper_payout_accounts (status) WHERE deleted_at IS NULL;

-- Withdrawal requests. pending / approved / processing / paid hold
-- the amount; rejected / failed / cancelled release it.
CREATE TABLE IF NOT EXISTS shopper_withdrawals (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  -- What is sent to the bank (amount - fee)
  payout_amount NUMERIC(12, 2) NOT NULL CHECK (payout_amount > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'processing', 'paid', 'rejected', 'failed', 'cancelled')),
  payout_account_id INTEGER REFERENCES shopper_payout_accounts(id) ON DELETE SET NULL,
  -- Bank, branch, holder, last 4 at request time (never the full number)
  account_snapshot JSONB NOT NULL,
  -- Cash owed to GetMe settled out of earnings when this was paid
  cash_netted NUMERIC(12, 2) NOT NULL DEFAULT 0,
  reference VARCHAR(80),
  reason VARCHAR(300),
  client_request_id VARCHAR(64),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  approved_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ,
  paid_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  closed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS shopper_withdrawals_request_key
  ON shopper_withdrawals (shopper_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- One bank reference pays one withdrawal
CREATE UNIQUE INDEX IF NOT EXISTS shopper_withdrawals_reference_key
  ON shopper_withdrawals (reference)
  WHERE reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS shopper_withdrawals_status_idx
  ON shopper_withdrawals (status, requested_at DESC);

CREATE INDEX IF NOT EXISTS shopper_withdrawals_shopper_idx
  ON shopper_withdrawals (shopper_id, requested_at DESC);

-- Every status change: who, when, why
CREATE TABLE IF NOT EXISTS shopper_withdrawal_events (
  id SERIAL PRIMARY KEY,
  withdrawal_id INTEGER NOT NULL REFERENCES shopper_withdrawals(id) ON DELETE CASCADE,
  action VARCHAR(30) NOT NULL,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('shopper', 'admin')),
  actor_id INTEGER,
  note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shopper_withdrawal_events_withdrawal_idx
  ON shopper_withdrawal_events (withdrawal_id, id);

-- Cash collected at the door, settled out of earnings by a paid
-- withdrawal ('netted'), as well as by a cash deposit ('deposited')
ALTER TABLE shopper_earnings DROP CONSTRAINT IF EXISTS shopper_earnings_cash_status_check;
ALTER TABLE shopper_earnings
  ADD CONSTRAINT shopper_earnings_cash_status_check
  CHECK (cash_status IN ('none', 'due', 'deposited', 'netted'));

ALTER TABLE shopper_earnings
  ADD COLUMN IF NOT EXISTS cash_withdrawal_id INTEGER REFERENCES shopper_withdrawals(id) ON DELETE SET NULL;
