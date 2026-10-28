-- =====================================================
-- PHASE 45 (2026-10-29): staff control over shopper assignment +
-- shopper cash limit. Idempotent.
--
-- dispatch_settings         one row: shopper cash limit (LKR) and how
--                           long an exclusive staff offer pauses the
--                           automatic forwarding
-- orders.dispatch_paused_*  an exclusive staff offer: no automatic
--                           forwarding until dispatch_paused_until
-- order_dispatch_exclusions shoppers a staff member released from an
--                           order: never offered it again automatically
--                           (a staff offer to them clears the row)
-- order_dispatch_actions    history of staff dispatch actions (release,
--                           offer, re-dispatch) with the reason
-- shopper_cash_limit_state  last known at/over-limit state per shopper,
--                           so a crossing is notified once
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS dispatch_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  shopper_cash_limit NUMERIC(12, 2) NOT NULL DEFAULT 15000 CHECK (shopper_cash_limit >= 0),
  exclusive_offer_minutes INTEGER NOT NULL DEFAULT 3 CHECK (exclusive_offer_minutes BETWEEN 1 AND 30),
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dispatch_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_paused_until TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_exclusive_shopper_id INTEGER;

CREATE TABLE IF NOT EXISTS order_dispatch_exclusions (
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  shopper_id INTEGER NOT NULL REFERENCES shoppers (id) ON DELETE CASCADE,
  reason VARCHAR(300),
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, shopper_id)
);

CREATE TABLE IF NOT EXISTS order_dispatch_actions (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  action VARCHAR(20) NOT NULL CHECK (action IN ('release', 'offer', 'redispatch')),
  admin_id INTEGER,
  admin_name VARCHAR(160),
  admin_role VARCHAR(40),
  reason VARCHAR(300) NOT NULL,
  -- released shopper (release) / chosen shopper (offer)
  shopper_id INTEGER,
  exclusive BOOLEAN NOT NULL DEFAULT FALSE,
  paused_until TIMESTAMPTZ,
  from_status VARCHAR(40),
  to_status VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_dispatch_actions_order_idx ON order_dispatch_actions (order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS shopper_cash_limit_state (
  shopper_id INTEGER PRIMARY KEY REFERENCES shoppers (id) ON DELETE CASCADE,
  over_limit BOOLEAN NOT NULL DEFAULT FALSE,
  cash_held NUMERIC(12, 2) NOT NULL DEFAULT 0,
  cash_limit NUMERIC(12, 2),
  crossings INTEGER NOT NULL DEFAULT 0,
  crossed_at TIMESTAMPTZ,
  cleared_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
