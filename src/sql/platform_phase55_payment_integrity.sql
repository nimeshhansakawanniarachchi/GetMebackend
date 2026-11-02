-- =====================================================
-- PHASE 55: PAYMENT SYSTEM AUDIT FIXES (2026-10-31)
-- Audit: code-backups/reports/payment-system-audit-2026-10-31.md
--
--  1. Card refund requests: written (and committed) BEFORE PayHere is
--     asked to refund, so a rolled-back transaction can't lose a refund
--     PayHere already made, and an unanswered refund blocks a second one
--     until an admin resolves it (P-02).
--  2. Card payments: chargebacks, status checks by the payment sweeper,
--     late successes on charges recorded as failed (P-01 / P-06).
--     Card setups: expiry (P-17).
--  3. payment_status_events: append-only trail of every status change on
--     the payment tables (who, when, from -> to).
--  4. received_qr_payments: money paid INTO GetMe's own LankaQR (HelaPOS).
--     HelaPOS has no API / webhook / export, so a payment is confirmed
--     only by a finance admin who found it in the HelaPOS app (evidence:
--     HelaPOS reference + amount + time), never by a scan or screenshot.
--  5. Merchant QR registry: checksum result + merchant category for
--     supermarket and fuel station QRs; who submitted / approved.
--  6. GetMe company cards: per-payment / daily / monthly limits,
--     allowed merchant categories, expiry.
-- Safe to run more than once.
-- =====================================================

BEGIN;

-- -----------------------------------------------------
-- 1. Card refund requests
-- No foreign key on purpose: the request is inserted on its own
-- connection while the caller's transaction holds the payment row
-- FOR UPDATE (an FK check would wait on that lock forever).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS card_payment_refund_requests (
  id SERIAL PRIMARY KEY,
  card_payment_id INTEGER NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  full_refund BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT,
  -- requested: PayHere is being asked / was asked and never answered
  -- succeeded: PayHere accepted (applied_at = written to card_payments)
  -- refused:   PayHere said no (nothing refunded)
  -- unknown:   no answer; blocks more refunds of this payment until an
  --            admin checks the PayHere portal and resolves it
  status VARCHAR(12) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'succeeded', 'refused', 'unknown')),
  gateway_refund_id VARCHAR(64),
  gateway_message VARCHAR(300),
  applied_at TIMESTAMPTZ,
  resolved_by INTEGER,
  resolved_at TIMESTAMPTZ,
  resolved_note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS card_refund_requests_payment_idx ON card_payment_refund_requests (card_payment_id);
CREATE INDEX IF NOT EXISTS card_refund_requests_open_idx ON card_payment_refund_requests (created_at)
  WHERE status IN ('requested', 'unknown') OR (status = 'succeeded' AND applied_at IS NULL);

ALTER TABLE card_payment_refunds ADD COLUMN IF NOT EXISTS request_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS card_payment_refunds_request_idx
  ON card_payment_refunds (request_id) WHERE request_id IS NOT NULL;

-- -----------------------------------------------------
-- 2. Card payments / setups
-- -----------------------------------------------------

ALTER TABLE card_payments ADD COLUMN IF NOT EXISTS chargeback_at TIMESTAMPTZ;
ALTER TABLE card_payments ADD COLUMN IF NOT EXISTS chargeback_note VARCHAR(300);
-- A verified PayHere success arrived for a row recorded as failed
ALTER TABLE card_payments ADD COLUMN IF NOT EXISTS late_success_at TIMESTAMPTZ;
ALTER TABLE card_payments ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE card_payments ADD COLUMN IF NOT EXISTS status_checks INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS card_payments_pending_idx ON card_payments (created_at) WHERE status = 'pending';

ALTER TABLE card_setups ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

-- -----------------------------------------------------
-- 3. Payment status trail (append-only)
-- Actor: set per transaction with
--   SELECT set_config('getme.actor', 'admin:12', true)
-- (unset = 'system'). Reason: set_config('getme.reason', ..., true).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS payment_status_events (
  id BIGSERIAL PRIMARY KEY,
  source VARCHAR(40) NOT NULL,
  source_id BIGINT NOT NULL,
  field VARCHAR(40) NOT NULL,
  from_value VARCHAR(40),
  to_value VARCHAR(40),
  actor VARCHAR(40) NOT NULL DEFAULT 'system',
  reason VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_status_events_source_idx ON payment_status_events (source, source_id, id);
CREATE INDEX IF NOT EXISTS payment_status_events_created_idx ON payment_status_events (created_at);

CREATE OR REPLACE FUNCTION payment_status_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_status_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_status_events_no_change ON payment_status_events;
CREATE TRIGGER payment_status_events_no_change
  BEFORE UPDATE OR DELETE ON payment_status_events
  FOR EACH ROW EXECUTE FUNCTION payment_status_events_append_only();

-- TG_ARGV = the status columns to follow on this table
CREATE OR REPLACE FUNCTION payment_status_audit() RETURNS trigger AS $$
DECLARE
  col TEXT;
  old_value TEXT;
  new_value TEXT;
  who TEXT := COALESCE(NULLIF(current_setting('getme.actor', true), ''), 'system');
  why TEXT := NULLIF(current_setting('getme.reason', true), '');
  new_row JSONB := to_jsonb(NEW);
  old_row JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    new_value := new_row ->> col;
    old_value := CASE WHEN old_row IS NULL THEN NULL ELSE old_row ->> col END;
    IF TG_OP = 'INSERT' OR old_value IS DISTINCT FROM new_value THEN
      INSERT INTO payment_status_events (source, source_id, field, from_value, to_value, actor, reason)
      VALUES (TG_TABLE_NAME, (new_row ->> 'id')::BIGINT, col, LEFT(old_value, 40), LEFT(new_value, 40), LEFT(who, 40), LEFT(why, 300));
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('card_payments', ARRAY['status']),
      ('card_setups', ARRAY['status']),
      ('card_payment_refund_requests', ARRAY['status']),
      ('grocery_payment_attempts', ARRAY['status', 'reconciliation_status']),
      ('store_payments', ARRAY['review_status', 'reimbursement_status']),
      ('fuel_payments', ARRAY['status']),
      ('shopper_withdrawals', ARRAY['status']),
      ('shop_lankaqr_merchants', ARRAY['status'])
    ) AS t(tbl, cols)
  LOOP
    IF to_regclass(spec.tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', spec.tbl || '_status_audit', spec.tbl);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION payment_status_audit(%s)',
        spec.tbl || '_status_audit', spec.tbl,
        (SELECT string_agg(quote_literal(c), ', ') FROM unnest(spec.cols) AS c)
      );
    END IF;
  END LOOP;
END;
$$;

-- -----------------------------------------------------
-- 4. Payments received on GetMe's own LankaQR (HelaPOS)
-- A row starts as a payer's claim (customer / shopper) or as an entry a
-- finance admin copied from the HelaPOS app. It becomes 'verified' only
-- with HelaPOS evidence, by an admin with finance.received_qr, within
-- the two-step window, with a note; the admin who typed the evidence
-- can't also verify it. One HelaPOS transaction proves one payment.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS received_qr_payments (
  id SERIAL PRIMARY KEY,
  channel VARCHAR(20) NOT NULL DEFAULT 'helapos' CHECK (channel IN ('helapos')),
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('order', 'cash_handover', 'other')),
  order_id INTEGER,
  customer_id INTEGER,
  shopper_id INTEGER,
  -- What GetMe expected (server-computed for orders / cash due)
  expected_amount NUMERIC(12, 2) CHECK (expected_amount IS NULL OR expected_amount > 0),
  -- What the payer says they paid
  claimed_amount NUMERIC(12, 2) CHECK (claimed_amount IS NULL OR claimed_amount > 0),
  claimed_reference VARCHAR(60),
  claimed_paid_at TIMESTAMPTZ,
  payer_app VARCHAR(20) CHECK (payer_app IS NULL OR payer_app IN ('helapay', 'bank_app', 'card', 'other')),
  -- Screenshot (private folder). Never proof on its own.
  proof_path VARCHAR(300),
  request_id VARCHAR(80),
  status VARCHAR(14) NOT NULL DEFAULT 'manual_review'
    CHECK (status IN ('manual_review', 'verified', 'rejected', 'cancelled', 'expired')),
  -- Evidence from the HelaPOS app (typed by finance)
  helapos_reference VARCHAR(60),
  helapos_amount NUMERIC(12, 2) CHECK (helapos_amount IS NULL OR helapos_amount > 0),
  helapos_paid_at TIMESTAMPTZ,
  helapos_payer VARCHAR(60),
  evidence_by INTEGER,
  evidence_at TIMESTAMPTZ,
  -- Decision
  decided_by INTEGER,
  decided_at TIMESTAMPTZ,
  decision_note VARCHAR(300),
  created_by_type VARCHAR(10) NOT NULL CHECK (created_by_type IN ('customer', 'shopper', 'admin')),
  created_by_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT received_qr_verified_needs_evidence CHECK (
    status <> 'verified' OR (
      helapos_reference IS NOT NULL AND helapos_amount IS NOT NULL AND helapos_paid_at IS NOT NULL
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_note IS NOT NULL
      AND (evidence_by IS NULL OR evidence_by <> decided_by)
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS received_qr_helapos_ref_idx
  ON received_qr_payments (channel, UPPER(helapos_reference))
  WHERE helapos_reference IS NOT NULL AND status IN ('manual_review', 'verified');
CREATE UNIQUE INDEX IF NOT EXISTS received_qr_request_idx
  ON received_qr_payments (created_by_type, created_by_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS received_qr_status_idx ON received_qr_payments (status, created_at DESC);
CREATE INDEX IF NOT EXISTS received_qr_order_idx ON received_qr_payments (order_id) WHERE order_id IS NOT NULL;

DROP TRIGGER IF EXISTS received_qr_payments_status_audit ON received_qr_payments;
CREATE TRIGGER received_qr_payments_status_audit AFTER INSERT OR UPDATE ON received_qr_payments
  FOR EACH ROW EXECUTE FUNCTION payment_status_audit('status');

-- A verified payment is final: its evidence and amounts can't be edited
CREATE OR REPLACE FUNCTION received_qr_verified_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'verified' THEN
    RAISE EXCEPTION 'A verified received payment cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS received_qr_payments_final ON received_qr_payments;
CREATE TRIGGER received_qr_payments_final BEFORE UPDATE OR DELETE ON received_qr_payments
  FOR EACH ROW EXECUTE FUNCTION received_qr_verified_is_final();

-- -----------------------------------------------------
-- 5. Merchant QR registry
-- merchant_category from the MCC: grocery / fuel / other
-- -----------------------------------------------------

ALTER TABLE shop_lankaqr_merchants ADD COLUMN IF NOT EXISTS crc_valid BOOLEAN;
ALTER TABLE shop_lankaqr_merchants ADD COLUMN IF NOT EXISTS merchant_category VARCHAR(10);

UPDATE shop_lankaqr_merchants
SET merchant_category = CASE
  WHEN mcc IN ('5411', '5412', '5422', '5441', '5451', '5462', '5499', '5311', '5331', '5399', '5912') THEN 'grocery'
  WHEN mcc IN ('5541', '5542', '5983', '5172') THEN 'fuel'
  ELSE 'other' END
WHERE merchant_category IS NULL;

ALTER TABLE fuel_stations ADD COLUMN IF NOT EXISTS qr_payload TEXT;
ALTER TABLE fuel_stations ADD COLUMN IF NOT EXISTS qr_crc_valid BOOLEAN;
ALTER TABLE fuel_stations ADD COLUMN IF NOT EXISTS qr_merchant_category VARCHAR(10);
ALTER TABLE fuel_stations ADD COLUMN IF NOT EXISTS qr_cleared_at TIMESTAMPTZ;
ALTER TABLE fuel_stations ADD COLUMN IF NOT EXISTS qr_cleared_by INTEGER;
ALTER TABLE fuel_stations ADD COLUMN IF NOT EXISTS qr_cleared_reason VARCHAR(300);

-- -----------------------------------------------------
-- 6. GetMe company cards: spending controls
-- -----------------------------------------------------

ALTER TABLE getme_cards ADD COLUMN IF NOT EXISTS per_payment_limit NUMERIC(12, 2)
  CHECK (per_payment_limit IS NULL OR per_payment_limit > 0);
ALTER TABLE getme_cards ADD COLUMN IF NOT EXISTS daily_limit NUMERIC(12, 2)
  CHECK (daily_limit IS NULL OR daily_limit > 0);
ALTER TABLE getme_cards ADD COLUMN IF NOT EXISTS monthly_limit NUMERIC(12, 2)
  CHECK (monthly_limit IS NULL OR monthly_limit > 0);
ALTER TABLE getme_cards ADD COLUMN IF NOT EXISTS allowed_categories TEXT[] NOT NULL DEFAULT ARRAY['grocery']::TEXT[];
ALTER TABLE getme_cards ADD COLUMN IF NOT EXISTS expires_on DATE;

COMMIT;
