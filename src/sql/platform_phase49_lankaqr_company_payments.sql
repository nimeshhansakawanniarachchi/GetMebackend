-- =====================================================
-- PLATFORM PHASE 49 - in-app LANKAQR scan-to-pay from GetMe's company
-- account (2026-10-30)
-- Run once: node src/sql/runSql.js src/sql/platform_phase49_lankaqr_company_payments.sql
--
-- IMPORTANT: no bank integration exists. DFCC has not provided an API
-- for paying LANKAQR merchants from a corporate account, so the DFCC
-- provider is an unconfigured stub (src/groceryPayments/providers).
-- A TEST SIMULATOR (dev/test only, never production, never together
-- with live mode) lets the automated tests run the flow. Simulated
-- payments are stored with provider / verification 'simulator' and are
-- never counted as bank-verified.
--
-- * grocery_payment_methods.getme_lankaqr: integration 'provider_api'
--   (was 'not_available'); it stays switched OFF. It is usable only when
--   a provider is configured (+ GROCERY_QR_LIVE=true for a live one) AND
--   the Super Admin switches it on (audited).
-- * shop_lankaqr_merchants: merchant QRs approved per shop (merchant
--   substitution protection). Unknown QR -> shopper submits -> staff
--   with grocery.manage approves for THAT shop only.
-- * grocery_payment_attempts: provider fields, requested amount, the
--   merchant, statuses 'unknown' (no answer: never paid twice, checked
--   with the provider) and 'rejected'; verification 'simulator'.
-- * store_payments.method 'getme_lankaqr' (funded_by getme ->
--   reimbursement_status company_paid, never owed to the shopper).
-- * Admin notifications for rejected / unknown outcomes.
-- =====================================================

BEGIN;

-- ---------------------------------------------------
-- Method catalogue
-- ---------------------------------------------------

ALTER TABLE grocery_payment_methods DROP CONSTRAINT IF EXISTS grocery_payment_methods_integration_check;
ALTER TABLE grocery_payment_methods ADD CONSTRAINT grocery_payment_methods_integration_check
  CHECK (integration IN ('manual', 'card_program', 'provider_api', 'not_available'));

UPDATE grocery_payment_methods SET
  label = 'Scan LankaQR (GetMe pays)',
  integration = 'provider_api',
  icon = 'qr-code-outline',
  instructions = 'Scan the store''s LankaQR code in the GetMe app. Check the store name and amount, then confirm: GetMe pays the store from its company account. It is GetMe''s money: nothing is owed to you and nothing is added to your earnings. Upload the bill photo after.',
  requirement = 'Needs a bank API that pays a LANKAQR merchant from GetMe''s corporate account (DFCC). DFCC has not provided one; see code-backups/reports/dfcc-lankaqr-questions.md. Usable only when a provider is configured on the server (GROCERY_QR_PROVIDER, and GROCERY_QR_LIVE=true for a live provider) and the Super Admin switches it on. Every store QR must be approved for its shop first.'
WHERE key = 'getme_lankaqr';

-- ---------------------------------------------------
-- Approved merchant QRs per shop
-- ---------------------------------------------------

CREATE TABLE IF NOT EXISTS shop_lankaqr_merchants (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  -- sha256 of the tag 26/27 value(s) + MCC + name + city (normalised)
  merchant_key CHAR(64) NOT NULL,
  -- sha256 of the tag 26/27 value(s) only (same account, other name/city)
  account_hash CHAR(64) NOT NULL,
  account_tags VARCHAR(10) NOT NULL,
  merchant_name VARCHAR(50) NOT NULL,
  merchant_city VARCHAR(30) NOT NULL,
  mcc CHAR(4) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
  submitted_by_type VARCHAR(10) NOT NULL CHECK (submitted_by_type IN ('shopper', 'admin')),
  submitted_by_id INTEGER,
  submitted_order_id INTEGER,
  submitted_note VARCHAR(300),
  -- merchant-identity tags only (00, 01, 26/27, 52, 53, 58, 59, 60, 61)
  -- with a fresh CRC; no amount, no bill / customer references
  sample_payload TEXT,
  reviewed_by INTEGER,
  reviewed_at TIMESTAMPTZ,
  review_note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop_id, merchant_key)
);

CREATE INDEX IF NOT EXISTS shop_lankaqr_merchants_account_idx ON shop_lankaqr_merchants (account_hash);
CREATE INDEX IF NOT EXISTS shop_lankaqr_merchants_status_idx ON shop_lankaqr_merchants (status, created_at);

-- ---------------------------------------------------
-- Payment attempts
-- ---------------------------------------------------

ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS provider VARCHAR(20);
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS provider_ref VARCHAR(80);
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS provider_status VARCHAR(20);
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS provider_message VARCHAR(300);
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS requested_amount NUMERIC(12, 2);
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS merchant_id INTEGER REFERENCES shop_lankaqr_merchants (id);
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS qr_kind VARCHAR(10);
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS qr_reference VARCHAR(25);
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS initiated_at TIMESTAMPTZ;
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS initiate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS status_checks INTEGER NOT NULL DEFAULT 0;

ALTER TABLE grocery_payment_attempts DROP CONSTRAINT IF EXISTS grocery_payment_attempts_qr_kind_check;
ALTER TABLE grocery_payment_attempts ADD CONSTRAINT grocery_payment_attempts_qr_kind_check
  CHECK (qr_kind IS NULL OR qr_kind IN ('static', 'dynamic'));

ALTER TABLE grocery_payment_attempts DROP CONSTRAINT IF EXISTS grocery_payment_attempts_requested_amount_check;
ALTER TABLE grocery_payment_attempts ADD CONSTRAINT grocery_payment_attempts_requested_amount_check
  CHECK (requested_amount IS NULL OR (requested_amount >= 1 AND requested_amount <= 500000));

-- Existing statuses kept; 'unknown' = the bank did not answer (live:
-- blocks a second payment until the provider says succeeded / failed);
-- 'rejected' = refused by the provider before processing
ALTER TABLE grocery_payment_attempts DROP CONSTRAINT IF EXISTS grocery_payment_attempts_status_check;
ALTER TABLE grocery_payment_attempts ADD CONSTRAINT grocery_payment_attempts_status_check
  CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled', 'reversed', 'disputed', 'unknown', 'rejected'));

ALTER TABLE grocery_payment_attempts DROP CONSTRAINT IF EXISTS grocery_payment_attempts_verification_check;
ALTER TABLE grocery_payment_attempts ADD CONSTRAINT grocery_payment_attempts_verification_check
  CHECK (verification IN ('none', 'receipt', 'statement', 'provider', 'simulator'));

-- A simulated payment is never bank-verified, and only the simulator
-- can produce 'simulator' verification
ALTER TABLE grocery_payment_attempts DROP CONSTRAINT IF EXISTS grocery_payment_attempts_simulator_check;
ALTER TABLE grocery_payment_attempts ADD CONSTRAINT grocery_payment_attempts_simulator_check
  CHECK (
    (verification <> 'simulator' OR provider = 'simulator')
    AND (provider IS DISTINCT FROM 'simulator' OR verification IN ('none', 'simulator'))
  );

-- One live payment per order + shop now includes 'unknown'
DROP INDEX IF EXISTS grocery_payment_attempts_live_idx;
CREATE UNIQUE INDEX grocery_payment_attempts_live_idx
  ON grocery_payment_attempts (order_id, shop_id) WHERE status IN ('pending', 'succeeded', 'disputed', 'unknown');

CREATE UNIQUE INDEX IF NOT EXISTS grocery_payment_attempts_provider_ref_idx
  ON grocery_payment_attempts (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS grocery_payment_attempts_provider_open_idx
  ON grocery_payment_attempts (status, last_checked_at) WHERE provider IS NOT NULL AND status IN ('pending', 'unknown');

-- ---------------------------------------------------
-- Store payments
-- ---------------------------------------------------

ALTER TABLE store_payments DROP CONSTRAINT IF EXISTS store_payments_method_check;
ALTER TABLE store_payments ADD CONSTRAINT store_payments_method_check
  CHECK (method IN ('cash', 'card', 'phone_wallet', 'lankaqr', 'getme_card', 'getme_lankaqr'));

-- ---------------------------------------------------
-- Admin notifications (phase 41 trigger): also rejected / unknown
-- ---------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_grocery_attempts() RETURNS trigger AS $$
DECLARE
  v_shop TEXT;
  v_perm TEXT[] := ARRAY['grocery.view'];
  v_what TEXT;
BEGIN
  SELECT shop_name INTO v_shop FROM shops WHERE id = NEW.shop_id;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('failed', 'disputed', 'reversed', 'rejected', 'unknown') THEN
    v_what := CASE NEW.status
      WHEN 'unknown' THEN 'outcome unknown (checking with the bank)'
      WHEN 'rejected' THEN 'rejected by the bank'
      ELSE NEW.status END;
    PERFORM admin_notify('payments', 'grocery_payment.' || NEW.status,
      CASE WHEN NEW.status IN ('disputed', 'unknown') THEN 'critical' ELSE 'warning' END,
      CASE WHEN NEW.provider = 'simulator' THEN 'TEST SIMULATOR: ' ELSE '' END ||
        'Supermarket payment ' || v_what || ' at ' || COALESCE(v_shop, 'a shop') || ' (order #' || NEW.order_id || ')',
      replace(NEW.method, '_', ' ') || COALESCE(' · ' || admin_money(COALESCE(NEW.amount, NEW.requested_amount, NEW.expected_amount)), '') ||
        COALESCE(' · ' || NULLIF(left(NEW.failure_reason, 120), ''), ''),
      'order', NEW.order_id::text, v_perm, 'grocery.attempt:' || NEW.id || ':' || NEW.status);
  END IF;

  IF NEW.reconciliation_status IS DISTINCT FROM OLD.reconciliation_status AND NEW.reconciliation_status = 'mismatch' THEN
    PERFORM admin_notify('payments', 'grocery_payment.mismatch', 'warning',
      'Supermarket payment does not match the statement',
      COALESCE(v_shop, 'Shop') || ' · order #' || NEW.order_id || COALESCE(' · ' || NULLIF(left(NEW.reconciliation_note, 120), ''), ''),
      'order', NEW.order_id::text, v_perm, 'grocery.mismatch:' || NEW.id || ':' || to_char(NOW(), 'YYYYMMDDHH24MISS'));
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_grocery_attempts failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMIT;
