-- =====================================================
-- PLATFORM PHASE 17 — saved cards + card payments (PayHere)
-- Run once: node src/sql/runSql.js src/sql/platform_phase17_saved_cards.sql
--
-- Card numbers and CVVs never reach this database. PayHere's
-- Preapproval API takes the card on its own page and gives back
-- a customer_token; only that token (encrypted, see
-- src/payments/cardVault.js) and the masked card it describes are
-- kept. Payments are charged with the token (Charging API).
-- =====================================================

-- A card a customer or shopper saved. owner_type + owner_id point at
-- customers.id or shoppers.id. Removing a card soft-deletes it so old
-- payments still show which card paid.
CREATE TABLE IF NOT EXISTS saved_cards (
  id SERIAL PRIMARY KEY,
  owner_type VARCHAR(20) NOT NULL CHECK (owner_type IN ('customer', 'shopper')),
  owner_id INTEGER NOT NULL,
  gateway VARCHAR(20) NOT NULL,
  token_encrypted TEXT NOT NULL,
  card_brand VARCHAR(20),
  card_last4 VARCHAR(4),
  card_holder_name VARCHAR(120),
  card_expiry VARCHAR(4),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS saved_cards_owner_idx
  ON saved_cards (owner_type, owner_id)
  WHERE deleted_at IS NULL;

-- One "add a card" attempt: the app opens PayHere's page for it and
-- PayHere's notify call finishes it. ref is the order_id sent to
-- PayHere and the one-time key in the checkout URL.
CREATE TABLE IF NOT EXISTS card_setups (
  id SERIAL PRIMARY KEY,
  ref VARCHAR(64) NOT NULL UNIQUE,
  owner_type VARCHAR(20) NOT NULL CHECK (owner_type IN ('customer', 'shopper')),
  owner_id INTEGER NOT NULL,
  gateway VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'saved', 'failed', 'cancelled')),
  saved_card_id INTEGER REFERENCES saved_cards (id),
  status_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Every card charge. purpose:
--   order        - customer pays the order total at Place order
--   order_extra  - customer approved a higher total later (more
--                  items, a dearer vehicle, a new delivery time)
--   store_bill   - shopper pays a store's bill at checkout
-- refunded_amount grows with each refund (card_payment_refunds).
-- order_id has no foreign key on purpose: charges are written on
-- their own connection while the caller holds the order row lock
-- (a key check on orders would wait for that lock forever).
-- abandoned_at: the app was told the payment failed (PayHere didn't
-- answer in time); if PayHere later reports it paid, it is refunded.
CREATE TABLE IF NOT EXISTS card_payments (
  id SERIAL PRIMARY KEY,
  ref VARCHAR(64) NOT NULL UNIQUE,
  owner_type VARCHAR(20) NOT NULL CHECK (owner_type IN ('customer', 'shopper')),
  owner_id INTEGER NOT NULL,
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('order', 'order_extra', 'store_bill')),
  order_id INTEGER,
  shop_id INTEGER,
  saved_card_id INTEGER REFERENCES saved_cards (id),
  gateway VARCHAR(20) NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'LKR',
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'partially_refunded')),
  gateway_payment_id VARCHAR(64),
  status_message TEXT,
  refunded_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  card_brand VARCHAR(20),
  card_last4 VARCHAR(4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS card_payments_order_idx ON card_payments (order_id);
CREATE INDEX IF NOT EXISTS card_payments_owner_idx ON card_payments (owner_type, owner_id);

-- A shop's bill is paid once per order
CREATE UNIQUE INDEX IF NOT EXISTS card_payments_store_bill_once
  ON card_payments (order_id, shop_id)
  WHERE purpose = 'store_bill' AND status IN ('paid', 'pending') AND abandoned_at IS NULL;

CREATE TABLE IF NOT EXISTS card_payment_refunds (
  id SERIAL PRIMARY KEY,
  card_payment_id INTEGER NOT NULL REFERENCES card_payments (id),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reason TEXT,
  gateway_refund_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS card_payment_refunds_payment_idx
  ON card_payment_refunds (card_payment_id);
