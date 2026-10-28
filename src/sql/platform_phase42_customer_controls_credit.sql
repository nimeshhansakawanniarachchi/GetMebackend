-- =====================================================
-- PHASE 42 (2026-10-29): CUSTOMER ACCOUNT CONTROLS + GETME CREDIT
-- Shared groundwork for phases 42-46 (support cases, customer controls,
-- credit at checkout).
--
-- * customers.account_status: active | restricted (card payments only)
--   | blocked (cannot sign in or order). Reason + who/when recorded.
-- * customers.cod_limit: largest cash-on-delivery order total allowed
--   for this customer (NULL = platform default, see
--   customer_controls_settings).
-- * customer_credit_entries: GetMe credit ledger. Balance = SUM(amount).
--   issued (+) by staff / support case resolution, spent (-) at
--   checkout, reversed (+/-) when an order using credit is cancelled or
--   an issue is undone, adjusted (+/-) by a Super Admin. Never edited or
--   deleted: corrections are new entries. client_request_id makes
--   retries safe. Writers lock the customer row (SELECT ... FOR UPDATE)
--   so the balance can never go below zero.
-- * orders.credit_applied: credit used to pay part of the order (GetMe
--   funds it, like a promo discount).
-- =====================================================

BEGIN;

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS account_status VARCHAR(12) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_reason VARCHAR(300),
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_by INTEGER,
  ADD COLUMN IF NOT EXISTS cod_limit NUMERIC(12, 2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_account_status_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_account_status_check
      CHECK (account_status IN ('active', 'restricted', 'blocked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_cod_limit_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_cod_limit_check
      CHECK (cod_limit IS NULL OR cod_limit >= 0);
  END IF;
END $$;

-- Platform defaults for customer controls (one row)
CREATE TABLE IF NOT EXISTS customer_controls_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_cod_limit NUMERIC(12, 2) CHECK (default_cod_limit IS NULL OR default_cod_limit >= 0),
  credit_approval_limit NUMERIC(12, 2) NOT NULL DEFAULT 5000 CHECK (credit_approval_limit >= 0),
  support_report_window_hours INTEGER NOT NULL DEFAULT 48 CHECK (support_report_window_hours BETWEEN 1 AND 720),
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO customer_controls_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS customer_credit_entries (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount <> 0),
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('issued', 'spent', 'reversed', 'adjusted')),
  reason VARCHAR(300),
  order_id INTEGER,
  support_case_id BIGINT,
  admin_id INTEGER,
  client_request_id VARCHAR(80) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_credit_entries_customer_idx ON customer_credit_entries (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_credit_entries_order_idx ON customer_credit_entries (order_id) WHERE order_id IS NOT NULL;

-- Append-only, like the audit log
CREATE OR REPLACE FUNCTION customer_credit_entries_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'customer_credit_entries is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_credit_entries_no_change ON customer_credit_entries;
CREATE TRIGGER customer_credit_entries_no_change
  BEFORE UPDATE OR DELETE ON customer_credit_entries
  FOR EACH ROW EXECUTE FUNCTION customer_credit_entries_no_change();

ALTER TABLE orders ADD COLUMN IF NOT EXISTS credit_applied NUMERIC(12, 2) NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_credit_applied_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_credit_applied_check CHECK (credit_applied >= 0);
  END IF;
END $$;

COMMIT;
