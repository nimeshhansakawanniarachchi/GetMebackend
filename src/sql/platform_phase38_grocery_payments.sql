-- =====================================================
-- PLATFORM PHASE 38 - supermarket payment methods, spending limits,
-- payment attempts and reconciliation (2026-10-28)
-- Run once: node src/sql/runSql.js src/sql/platform_phase38_grocery_payments.sql
--
-- Builds on phase 20 (store_payments: one record per order + shop,
-- final once the bill photo is uploaded) and phase 32 (grocery
-- reimbursements paid through withdrawals).
--
-- * grocery_payment_methods: the catalogue. Only methods GetMe can
--   really use are enabled. Shopper-funded methods (cash, own card /
--   Google Wallet, own LANKAQR app) are reimbursed; the GetMe company
--   card (bank-issued, GetMe-funded) needs a bank card program, so it
--   is off until cards exist; methods with no Sri Lankan provider
--   (wallet virtual card, LANKAQR from GetMe's business account,
--   direct supermarket settlement) can't be enabled at all.
-- * grocery_shop_payment_methods: per-shop exceptions (e.g. a store
--   that doesn't take LANKAQR).
-- * getme_cards + getme_card_loads: company cards (bank name + last 4
--   only, never the card number) and the money GetMe loaded on them.
-- * grocery_reservations: the spending limit reserved for each order +
--   shop before shopping; captured by the payment, the rest released.
-- * grocery_payment_attempts: each try to pay a shop (pending ->
--   succeeded / failed / cancelled; reversed / disputed later), with
--   verification and reconciliation status.
-- * grocery_ledger_entries: append-only audit of every reserve,
--   limit change, capture, release, reversal, card load.
-- No card numbers, CVVs, PINs or wallet credentials anywhere.
-- =====================================================

CREATE TABLE IF NOT EXISTS grocery_payment_methods (
  key VARCHAR(30) PRIMARY KEY,
  label VARCHAR(80) NOT NULL,
  -- shopper: the shopper's own money, reimbursed; getme: GetMe's money
  funding VARCHAR(10) NOT NULL CHECK (funding IN ('shopper', 'getme')),
  -- manual: recorded by the shopper + bill photo; card_program: needs
  -- bank-issued GetMe cards; not_available: no provider GetMe can use
  integration VARCHAR(20) NOT NULL CHECK (integration IN ('manual', 'card_program', 'not_available')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  icon VARCHAR(40),
  instructions TEXT,
  requirement TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT grocery_payment_methods_available_check CHECK (NOT (integration = 'not_available' AND enabled))
);

INSERT INTO grocery_payment_methods (key, label, funding, integration, enabled, icon, instructions, requirement, sort_order) VALUES
  ('cash', 'Cash (your own money)', 'shopper', 'manual', TRUE, 'cash-outline',
   'Pay the cashier in cash and keep the bill. GetMe pays you back through a withdrawal after delivery.',
   NULL, 10),
  ('card', 'Your own card or Google Wallet', 'shopper', 'manual', TRUE, 'card-outline',
   'Tap or insert your own card, or Google Wallet on an NFC Android phone. Above about Rs 25,000 the terminal may ask for your PIN. GetMe pays you back after delivery.',
   NULL, 20),
  ('lankaqr', 'LANKAQR (your own bank app)', 'shopper', 'manual', TRUE, 'qr-code-outline',
   'Scan the store''s LANKAQR code with your own bank or wallet app and pay the bill total. Note the reference on the receipt. GetMe pays you back after delivery.',
   NULL, 30),
  ('getme_card', 'GetMe company card', 'getme', 'card_program', FALSE, 'wallet-outline',
   'Pay with the GetMe card assigned to you (tap or insert, PIN if asked). It is GetMe''s money: nothing is owed to you and nothing is added to your earnings.',
   'Needs a bank-issued company prepaid/debit card program (company account, KYC per cardholder). Register each card here (bank + last 4 only) and record every load with the bank reference.', 5),
  ('getme_wallet_card', 'GetMe virtual card in a phone wallet', 'getme', 'not_available', FALSE, 'phone-portrait-outline',
   NULL,
   'No Sri Lankan bank or fintech was found that issues business virtual cards which can be added to Google Wallet; Apple Pay and Samsung Pay are not available for Sri Lankan cards. Needs an issuer program and wallet tokenisation support.', 40),
  ('getme_lankaqr', 'LANKAQR from GetMe''s business account', 'getme', 'not_available', FALSE, 'business-outline',
   NULL,
   'Paying a LANKAQR merchant from GetMe''s own business account would need a bank app or API that lets a company authorise many shoppers with limits. None was found; sharing business banking logins is not allowed.', 50),
  ('store_direct', 'Direct supermarket settlement', 'getme', 'not_available', FALSE, 'storefront-outline',
   NULL,
   'No Sri Lankan supermarket chain offers a B2B account or payment API. Needs a commercial agreement (invoice settlement) with each chain.', 60)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS grocery_shop_payment_methods (
  shop_id INTEGER NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
  method_key VARCHAR(30) NOT NULL REFERENCES grocery_payment_methods (key),
  enabled BOOLEAN NOT NULL,
  note VARCHAR(200),
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shop_id, method_key)
);

-- Spending limit = estimate + max(min, estimate x percent)
CREATE TABLE IF NOT EXISTS grocery_payment_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  limit_buffer_percent NUMERIC(5, 2) NOT NULL DEFAULT 10 CHECK (limit_buffer_percent BETWEEN 0 AND 100),
  limit_buffer_min NUMERIC(12, 2) NOT NULL DEFAULT 500 CHECK (limit_buffer_min >= 0),
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO grocery_payment_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Company cards: bank name + last 4 only
CREATE TABLE IF NOT EXISTS getme_cards (
  id SERIAL PRIMARY KEY,
  label VARCHAR(60) NOT NULL,
  issuer VARCHAR(80) NOT NULL,
  last4 CHAR(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  shopper_id INTEGER REFERENCES shoppers (id) ON DELETE SET NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'retired')),
  note VARCHAR(300),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS getme_cards_issuer_last4_idx
  ON getme_cards (LOWER(issuer), last4) WHERE status <> 'retired';
-- One active card per shopper
CREATE UNIQUE INDEX IF NOT EXISTS getme_cards_shopper_active_idx
  ON getme_cards (shopper_id) WHERE status = 'active' AND shopper_id IS NOT NULL;

-- Money GetMe put on (or took off) a card, as done at the bank
CREATE TABLE IF NOT EXISTS getme_card_loads (
  id SERIAL PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES getme_cards (id),
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('load', 'unload')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reference VARCHAR(60) NOT NULL,
  note VARCHAR(300),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (card_id, reference)
);

-- The spending limit for one order + shop, reserved before shopping
CREATE TABLE IF NOT EXISTS grocery_reservations (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  shop_id INTEGER NOT NULL,
  shopper_id INTEGER NOT NULL,
  estimate_amount NUMERIC(12, 2) NOT NULL,
  limit_amount NUMERIC(12, 2) NOT NULL CHECK (limit_amount >= 0),
  -- An admin's limit (with a reason) replaces the computed one
  limit_override NUMERIC(12, 2),
  limit_note VARCHAR(300),
  limit_set_by INTEGER,
  -- active: open; captured: paid, order still open; settled: order
  -- finished, unused part released; released: nothing was paid
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'captured', 'settled', 'released')),
  captured_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  released_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, shop_id)
);

CREATE INDEX IF NOT EXISTS grocery_reservations_shopper_idx ON grocery_reservations (shopper_id, status);

CREATE TABLE IF NOT EXISTS grocery_payment_attempts (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  shop_id INTEGER NOT NULL,
  shopper_id INTEGER NOT NULL,
  reservation_id INTEGER REFERENCES grocery_reservations (id),
  method VARCHAR(30) NOT NULL REFERENCES grocery_payment_methods (key),
  funding VARCHAR(10) NOT NULL CHECK (funding IN ('shopper', 'getme')),
  card_id INTEGER REFERENCES getme_cards (id),
  status VARCHAR(12) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled', 'reversed', 'disputed')),
  currency CHAR(3) NOT NULL DEFAULT 'LKR',
  expected_amount NUMERIC(12, 2) NOT NULL,
  limit_amount NUMERIC(12, 2) NOT NULL,
  amount NUMERIC(12, 2) CHECK (amount IS NULL OR amount > 0),
  reference VARCHAR(40),
  failure_reason VARCHAR(300),
  request_id VARCHAR(80),
  store_payment_id INTEGER REFERENCES store_payments (id),
  -- What backs the reported result: nothing yet, the bill photo, the
  -- bank statement (checked by an admin) or a provider confirmation
  verification VARCHAR(10) NOT NULL DEFAULT 'none' CHECK (verification IN ('none', 'receipt', 'statement', 'provider')),
  reconciliation_status VARCHAR(12) NOT NULL DEFAULT 'unreconciled'
    CHECK (reconciliation_status IN ('unreconciled', 'matched', 'mismatch', 'resolved')),
  reconciliation_note VARCHAR(300),
  statement_reference VARCHAR(60),
  reconciled_by INTEGER,
  reconciled_at TIMESTAMPTZ,
  over_limit BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A repeated submit (same request id) returns the same attempt
CREATE UNIQUE INDEX IF NOT EXISTS grocery_payment_attempts_request_idx
  ON grocery_payment_attempts (shopper_id, request_id) WHERE request_id IS NOT NULL;
-- One live payment per order + shop: no paying a shop twice
CREATE UNIQUE INDEX IF NOT EXISTS grocery_payment_attempts_live_idx
  ON grocery_payment_attempts (order_id, shop_id) WHERE status IN ('pending', 'succeeded', 'disputed');
CREATE INDEX IF NOT EXISTS grocery_payment_attempts_status_idx
  ON grocery_payment_attempts (status, reconciliation_status);
CREATE INDEX IF NOT EXISTS grocery_payment_attempts_card_idx
  ON grocery_payment_attempts (card_id) WHERE card_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS grocery_ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  entry_type VARCHAR(20) NOT NULL CHECK (entry_type IN (
    'reserve', 'limit_change', 'capture', 'release', 'reverse', 'dispute', 'reconcile',
    'attempt_start', 'attempt_failed', 'attempt_cancelled', 'card_load', 'card_unload'
  )),
  order_id INTEGER,
  shop_id INTEGER,
  shopper_id INTEGER,
  reservation_id INTEGER,
  attempt_id INTEGER,
  card_id INTEGER,
  amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('system', 'shopper', 'admin')),
  actor_id INTEGER,
  note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A payment is captured / reversed in the ledger at most once
CREATE UNIQUE INDEX IF NOT EXISTS grocery_ledger_capture_once_idx
  ON grocery_ledger_entries (entry_type, attempt_id) WHERE entry_type IN ('capture', 'reverse');
-- One reservation, one final release
CREATE UNIQUE INDEX IF NOT EXISTS grocery_ledger_release_once_idx
  ON grocery_ledger_entries (reservation_id) WHERE entry_type = 'release';
CREATE INDEX IF NOT EXISTS grocery_ledger_order_idx ON grocery_ledger_entries (order_id, created_at);

-- Store payments: who funded it and which attempt / card it came from.
-- A GetMe-funded payment is never owed to the shopper.
ALTER TABLE store_payments ADD COLUMN IF NOT EXISTS funded_by VARCHAR(10) NOT NULL DEFAULT 'shopper';
ALTER TABLE store_payments DROP CONSTRAINT IF EXISTS store_payments_funded_by_check;
ALTER TABLE store_payments ADD CONSTRAINT store_payments_funded_by_check CHECK (funded_by IN ('shopper', 'getme'));
ALTER TABLE store_payments ADD COLUMN IF NOT EXISTS attempt_id INTEGER;
ALTER TABLE store_payments ADD COLUMN IF NOT EXISTS card_id INTEGER;

ALTER TABLE store_payments DROP CONSTRAINT IF EXISTS store_payments_method_check;
ALTER TABLE store_payments ADD CONSTRAINT store_payments_method_check
  CHECK (method IN ('cash', 'card', 'lankaqr', 'getme_card'));

ALTER TABLE store_payments DROP CONSTRAINT IF EXISTS store_payments_reimbursement_status_check;
ALTER TABLE store_payments ADD CONSTRAINT store_payments_reimbursement_status_check
  CHECK (reimbursement_status IN ('pending', 'owed', 'held', 'reimbursed', 'company_paid'));

ALTER TABLE store_payments DROP CONSTRAINT IF EXISTS store_payments_company_paid_check;
ALTER TABLE store_payments ADD CONSTRAINT store_payments_company_paid_check
  CHECK ((funded_by = 'getme') = (reimbursement_status = 'company_paid'));

-- Existing store payments become past attempts (shopper-funded), so the
-- history and reconciliation start complete
INSERT INTO grocery_payment_attempts (
  order_id, shop_id, shopper_id, method, funding, status, expected_amount, limit_amount,
  amount, reference, store_payment_id, verification, reconciliation_status, paid_at, created_at, updated_at
)
SELECT sp.order_id, sp.shop_id, sp.shopper_id, sp.method, 'shopper', 'succeeded', sp.expected_amount, sp.expected_amount,
       sp.amount_paid, sp.reference, sp.id,
       CASE WHEN sp.locked_at IS NOT NULL THEN 'receipt' ELSE 'none' END,
       CASE WHEN sp.locked_at IS NOT NULL AND sp.review_status IN ('ok', 'approved') THEN 'matched'
            WHEN sp.review_status IN ('needs_review', 'queried') THEN 'mismatch'
            ELSE 'unreconciled' END,
       sp.created_at, sp.created_at, sp.updated_at
FROM store_payments sp
WHERE NOT EXISTS (SELECT 1 FROM grocery_payment_attempts a WHERE a.store_payment_id = sp.id);

UPDATE store_payments sp SET attempt_id = a.id
FROM grocery_payment_attempts a
WHERE a.store_payment_id = sp.id AND sp.attempt_id IS NULL;

-- Wording from the 2026-10-28 provider check (re-run safe)
UPDATE grocery_payment_methods SET
  requirement = 'Needs a bank corporate card for GetMe (e.g. a corporate purchasing or credit card with a limit per card; Sri Lankan banks offer prepaid company cards only for fuel). The bank does KYC per cardholder. Register each card here (bank + last 4 only) and record every amount GetMe makes available on it with the bank reference.',
  instructions = 'Pay with the GetMe card assigned to you (tap or insert, PIN if asked). It is GetMe''s money: nothing is owed to you and nothing is added to your earnings. Stay within the spending limit shown.'
WHERE key = 'getme_card';

UPDATE grocery_payment_methods SET
  instructions = 'Tap or insert your own card, or use Google Wallet on an NFC Android phone (ComBank, Sampath, Seylan cards; HNB Visa debit). The terminal may ask for your PIN on bigger bills. GetMe pays you back after delivery.'
WHERE key = 'card';

UPDATE grocery_payment_methods SET
  instructions = 'Scan the store''s LANKAQR code with your own bank or wallet app and pay the bill total. Your app may cap one payment (e.g. BOC SmartPay Rs 50,000). Note the reference on the receipt. GetMe pays you back after delivery.'
WHERE key = 'lankaqr';

-- A store payment removed (reversal before the bill, test cleanup)
-- leaves its attempt in the history
ALTER TABLE grocery_payment_attempts DROP CONSTRAINT IF EXISTS grocery_payment_attempts_store_payment_id_fkey;
ALTER TABLE grocery_payment_attempts ADD CONSTRAINT grocery_payment_attempts_store_payment_id_fkey
  FOREIGN KEY (store_payment_id) REFERENCES store_payments (id) ON DELETE SET NULL;
