-- =====================================================
-- PHASE 56: LANKAQR SCAN-TO-PAY FROM THE SHOPPER'S OWN BANK ACCOUNT
-- (2026-10-31) - research: code-backups/reports/pickme-style-lankaqr-research-2026-10-31.md
--
-- The CBSL-compliant "PickMe-style" model: GetMe's app becomes a
-- LankaPay-certified third-party payment app behind an acquiring bank;
-- the SHOPPER pays the till / pump LankaQR from their OWN linked bank
-- account (CBSL 02/2024: app user = account owner), authenticates at
-- their bank (OTP from Rs 10,000, CBSL 01/2024), and the bank confirms
-- the result to GetMe's backend. GetMe then reimburses the shopper like
-- any shopper-funded supermarket payment. NO BANK IS CONNECTED YET:
-- only the TEST SIMULATOR can run this flow (no money moves).
--
--  1. grocery method lankaqr_bank (funding shopper, provider_api, OFF)
--  2. attempts: bank login (payer authentication) URL + expiry, the bill
--     total the shopper typed before scanning
--  3. fuel payments through the same providers (shopper's own money):
--     payment_method 'lankaqr_bank' + provider columns
-- Safe to run more than once.
-- =====================================================

BEGIN;

INSERT INTO grocery_payment_methods (key, label, funding, integration, enabled, icon, instructions, requirement, sort_order)
VALUES (
  'lankaqr_bank',
  'Scan LankaQR, pay from your bank account',
  'shopper',
  'provider_api',
  FALSE,
  'qr-code-outline',
  'Scan the LankaQR at the till. GetMe checks the store and the amount, then your bank asks you to confirm (PIN / OTP in your bank''s page). GetMe never sees your PIN or OTP. GetMe pays you back like any bill you paid.',
  'Needs a bank / LankaPay-certified provider that lets GetMe start payments from a shopper''s own linked account (none connected yet).',
  32
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE store_payments DROP CONSTRAINT IF EXISTS store_payments_method_check;
ALTER TABLE store_payments ADD CONSTRAINT store_payments_method_check
  CHECK (method IN ('cash', 'card', 'phone_wallet', 'lankaqr', 'getme_card', 'getme_lankaqr', 'lankaqr_bank'));

-- The bank's own page where the shopper approves (PIN / OTP there, never
-- in GetMe). Only shown to the shopper who owns the attempt.
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS payer_auth_url TEXT;
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS payer_auth_expires_at TIMESTAMPTZ;
-- Bill total typed before scanning (the QR amount must equal it)
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS bill_total NUMERIC(12, 2)
  CHECK (bill_total IS NULL OR bill_total > 0);

-- Fuel: same providers, the shopper's own money (never GetMe's)
ALTER TABLE fuel_payments ALTER COLUMN payment_method TYPE VARCHAR(20);
ALTER TABLE fuel_payments DROP CONSTRAINT IF EXISTS fuel_payments_payment_method_check;
ALTER TABLE fuel_payments ADD CONSTRAINT fuel_payments_payment_method_check
  CHECK (payment_method IN ('lankaqr', 'card', 'cash', 'lankaqr_bank'));
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS provider VARCHAR(20);
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS provider_ref VARCHAR(80);
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS provider_status VARCHAR(20);
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS provider_message VARCHAR(300);
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS initiated_at TIMESTAMPTZ;
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS status_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS payer_auth_url TEXT;
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS payer_auth_expires_at TIMESTAMPTZ;
ALTER TABLE fuel_payments ADD COLUMN IF NOT EXISTS verification VARCHAR(10) NOT NULL DEFAULT 'none';
ALTER TABLE fuel_payments DROP CONSTRAINT IF EXISTS fuel_payments_verification_check;
ALTER TABLE fuel_payments ADD CONSTRAINT fuel_payments_verification_check
  CHECK (verification IN ('none', 'admin', 'provider', 'simulator'));

CREATE INDEX IF NOT EXISTS fuel_payments_provider_open_idx ON fuel_payments (updated_at)
  WHERE provider IS NOT NULL AND status = 'started';

COMMIT;
