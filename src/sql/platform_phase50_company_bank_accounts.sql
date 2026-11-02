-- =====================================================
-- PLATFORM PHASE 50 - GetMe company bank accounts (2026-10-30)
-- Run once: node src/sql/runSql.js src/sql/platform_phase50_company_bank_accounts.sql
--
-- GetMe's OWN bank accounts (one company, several banks / accounts),
-- managed by Finance + the Super Admin (src/companyAccounts).
-- IMPORTANT: no bank integration exists. These are RECORDS: registering
-- or activating an account never moves money, never enables a payment
-- method and never initiates or authorises a payment. There is no
-- balance column: a bank balance is not a GetMe wallet.
--
-- * company_bank_accounts: account number encrypted (AES-256-GCM,
--   COMPANY_ACCOUNT_KEY), last 4 + HMAC hash (duplicates) only in
--   clear. Never deleted (trigger); retired accounts are 'archived'.
--   Account number, bank and currency never change (trigger): a
--   different account is added instead. Integration tracking: the
--   provider key chosen for the account, a bank-side reference (not a
--   secret), the bank authorisation record and the Super Admin's
--   test / production approval. Credentials live only in the server
--   environment, never here.
-- * company_bank_account_defaults: one default account per purpose
--   (active accounts with that purpose only).
-- * company_bank_account_funding: the account a GetMe-funded payment
--   method pays from (today only getme_lankaqr).
-- * company_bank_account_events: append-only history (masked).
-- * grocery_payment_attempts / store_payments: funding_account_id +
--   label snapshot. Existing rows stay NULL (history is not rewritten).
-- * admin_notify_approvals: an approval without an amount (company
--   account changes) no longer says "Rs 0.00".
-- Never stored: banking passwords, PINs, OTPs, internet-banking
-- credentials, API secrets.
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS company_bank_accounts (
  id SERIAL PRIMARY KEY,
  nickname VARCHAR(60) NOT NULL,
  -- Catalogue key (src/companyAccounts/catalogue.js) or 'other'
  bank_key VARCHAR(40) NOT NULL,
  -- Display name (free text when bank_key = 'other')
  bank_name VARCHAR(80) NOT NULL,
  account_holder_name VARCHAR(120) NOT NULL,
  account_number_encrypted TEXT NOT NULL,
  account_last4 VARCHAR(4) NOT NULL,
  account_number_hash CHAR(64) NOT NULL,
  branch_name VARCHAR(80),
  branch_code VARCHAR(12),
  country CHAR(2) NOT NULL DEFAULT 'LK' CHECK (country ~ '^[A-Z]{2}$'),
  currency CHAR(3) NOT NULL DEFAULT 'LKR' CHECK (currency ~ '^[A-Z]{3}$'),
  purposes TEXT[] NOT NULL DEFAULT '{}' CHECK (
    purposes <@ ARRAY['supermarket_payments', 'customer_settlements', 'shopper_payouts', 'gateway_settlements', 'operational_expenses']::TEXT[]
  ),
  status VARCHAR(10) NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'active', 'archived')),
  -- Integration tracking (never inferred from the account number)
  integration_provider VARCHAR(20),
  integration_reference VARCHAR(80),
  authorization_status VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (authorization_status IN ('none', 'requested', 'confirmed')),
  authorization_reference VARCHAR(80),
  authorization_date DATE,
  authorization_recorded_by INTEGER REFERENCES admins (id),
  authorization_recorded_at TIMESTAMPTZ,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none', 'test_approved', 'production_approved')),
  approval_note VARCHAR(300),
  approved_by INTEGER REFERENCES admins (id),
  approved_at TIMESTAMPTZ,
  activated_by INTEGER REFERENCES admins (id),
  activated_at TIMESTAMPTZ,
  deactivated_by INTEGER REFERENCES admins (id),
  deactivated_at TIMESTAMPTZ,
  archived_by INTEGER REFERENCES admins (id),
  archived_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES admins (id),
  updated_by INTEGER REFERENCES admins (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (account_last4 ~ '^[0-9A-Z]{4}$'),
  -- The simulator is never production-approved
  CHECK (NOT (integration_provider = 'simulator' AND approval_status = 'production_approved')),
  CHECK (approval_status = 'none' OR integration_provider IS NOT NULL)
);

-- The same number can't be registered twice (archived rows excluded)
CREATE UNIQUE INDEX IF NOT EXISTS company_bank_accounts_number_idx
  ON company_bank_accounts (account_number_hash) WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS company_bank_accounts_status_idx ON company_bank_accounts (status, id);

-- One default account per purpose
CREATE TABLE IF NOT EXISTS company_bank_account_defaults (
  purpose VARCHAR(30) PRIMARY KEY CHECK (
    purpose IN ('supermarket_payments', 'customer_settlements', 'shopper_payouts', 'gateway_settlements', 'operational_expenses')
  ),
  account_id INTEGER NOT NULL REFERENCES company_bank_accounts (id),
  set_by INTEGER REFERENCES admins (id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Account a GetMe-funded payment method pays from
CREATE TABLE IF NOT EXISTS company_bank_account_funding (
  method_key VARCHAR(30) PRIMARY KEY REFERENCES grocery_payment_methods (key),
  account_id INTEGER NOT NULL REFERENCES company_bank_accounts (id),
  set_by INTEGER REFERENCES admins (id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only history (masked values only)
CREATE TABLE IF NOT EXISTS company_bank_account_events (
  id SERIAL PRIMARY KEY,
  account_id INTEGER REFERENCES company_bank_accounts (id),
  action VARCHAR(40) NOT NULL,
  actor_admin_id INTEGER REFERENCES admins (id),
  actor_name VARCHAR(120),
  actor_role VARCHAR(20),
  approval_request_id INTEGER REFERENCES admin_approval_requests (id),
  approved_by INTEGER REFERENCES admins (id),
  before_value JSONB,
  after_value JSONB,
  reason VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS company_bank_account_events_account_idx ON company_bank_account_events (account_id, id DESC);
CREATE INDEX IF NOT EXISTS company_bank_account_events_reveal_idx ON company_bank_account_events (actor_admin_id, created_at) WHERE action = 'reveal';

CREATE OR REPLACE FUNCTION company_bank_account_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'company_bank_account_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS company_bank_account_events_no_change ON company_bank_account_events;
CREATE TRIGGER company_bank_account_events_no_change
  BEFORE UPDATE OR DELETE ON company_bank_account_events
  FOR EACH ROW EXECUTE FUNCTION company_bank_account_events_immutable();

-- Accounts: never deleted; number / bank / currency never change; an
-- archived account never comes back; an account that is a default or a
-- funding source can't stop being active or lose that purpose
CREATE OR REPLACE FUNCTION company_bank_accounts_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company bank accounts are never deleted (archive them instead)';
  END IF;

  IF NEW.account_number_encrypted IS DISTINCT FROM OLD.account_number_encrypted
     OR NEW.account_number_hash IS DISTINCT FROM OLD.account_number_hash
     OR NEW.account_last4 IS DISTINCT FROM OLD.account_last4
     OR NEW.bank_key IS DISTINCT FROM OLD.bank_key
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'the account number, bank and currency of a company bank account never change (add a new account)';
  END IF;

  IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    RAISE EXCEPTION 'an archived company bank account can not be used again';
  END IF;

  IF NEW.status <> 'active' AND (
       EXISTS (SELECT 1 FROM company_bank_account_defaults WHERE account_id = NEW.id)
    OR EXISTS (SELECT 1 FROM company_bank_account_funding WHERE account_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'company bank account % is a default or a funding source: change that first', NEW.id;
  END IF;

  IF EXISTS (SELECT 1 FROM company_bank_account_defaults d WHERE d.account_id = NEW.id AND NOT (d.purpose = ANY (NEW.purposes))) THEN
    RAISE EXCEPTION 'company bank account % is the default for a purpose it no longer has', NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS company_bank_accounts_guard ON company_bank_accounts;
CREATE TRIGGER company_bank_accounts_guard
  BEFORE UPDATE OR DELETE ON company_bank_accounts
  FOR EACH ROW EXECUTE FUNCTION company_bank_accounts_guard();

-- Defaults: active accounts that have the purpose
CREATE OR REPLACE FUNCTION company_bank_account_defaults_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM company_bank_accounts WHERE id = NEW.account_id AND status = 'active' AND NEW.purpose = ANY (purposes)
  ) THEN
    RAISE EXCEPTION 'the default for % must be an active account with that purpose', NEW.purpose;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS company_bank_account_defaults_guard ON company_bank_account_defaults;
CREATE TRIGGER company_bank_account_defaults_guard
  BEFORE INSERT OR UPDATE ON company_bank_account_defaults
  FOR EACH ROW EXECUTE FUNCTION company_bank_account_defaults_guard();

-- Funding: an active LKR account with the supermarket payments purpose
-- (provider eligibility is checked by the server, src/companyAccounts)
CREATE OR REPLACE FUNCTION company_bank_account_funding_guard() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM company_bank_accounts
    WHERE id = NEW.account_id AND status = 'active' AND currency = 'LKR' AND 'supermarket_payments' = ANY (purposes)
  ) THEN
    RAISE EXCEPTION 'the funding account must be an active LKR account for supermarket payments';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS company_bank_account_funding_guard ON company_bank_account_funding;
CREATE TRIGGER company_bank_account_funding_guard
  BEFORE INSERT OR UPDATE ON company_bank_account_funding
  FOR EACH ROW EXECUTE FUNCTION company_bank_account_funding_guard();

-- ---------------------------------------------------
-- Snapshots on supermarket payments (new rows only)
-- ---------------------------------------------------

ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS funding_account_id INTEGER REFERENCES company_bank_accounts (id);
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS funding_account_label VARCHAR(120);
ALTER TABLE store_payments ADD COLUMN IF NOT EXISTS funding_account_id INTEGER REFERENCES company_bank_accounts (id);
ALTER TABLE store_payments ADD COLUMN IF NOT EXISTS funding_account_label VARCHAR(120);

CREATE INDEX IF NOT EXISTS grocery_payment_attempts_funding_open_idx
  ON grocery_payment_attempts (funding_account_id) WHERE funding_account_id IS NOT NULL AND status IN ('pending', 'unknown');

-- ---------------------------------------------------
-- Approval notifications: no "Rs 0.00" for changes without an amount
-- (same as phase 41 otherwise)
-- ---------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_approvals() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM admin_notify('payments', 'approval.requested', 'critical',
      'Approval needed: ' || COALESCE(left(NEW.summary, 150), replace(NEW.action_type, '.', ' ')),
      CASE WHEN NEW.amount IS NULL THEN 'No amount' ELSE admin_money(NEW.amount) END || ' · waiting for a Super Admin decision.', 'approval', NEW.id::text,
      ARRAY['approvals.decide'], 'approval.requested:' || NEW.id, NULL, NEW.requested_by);
  ELSIF NEW.status IN ('approved', 'rejected', 'failed') THEN
    -- The requester learns the outcome
    PERFORM admin_notify('payments', 'approval.' || NEW.status,
      CASE WHEN NEW.status = 'approved' THEN 'info' ELSE 'warning' END,
      'Your request was ' || CASE NEW.status WHEN 'failed' THEN 'approved but failed' ELSE NEW.status END,
      COALESCE(left(NEW.summary, 150), '') || COALESCE(' · ' || NULLIF(left(COALESCE(NEW.decision_note, NEW.result_message), 140), ''), ''),
      'approval', NEW.id::text, '{}', 'approval.decided:' || NEW.id, NEW.requested_by, NEW.decided_by);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_approvals failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMIT;
