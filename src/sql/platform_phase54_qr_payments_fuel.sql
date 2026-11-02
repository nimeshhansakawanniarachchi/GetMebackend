-- =====================================================
-- PHASE 54 (2026-10-30): QR PAYMENTS - SUPERMARKET QR CHECKS + FUEL
--
-- The user's decisions (no payer API exists; HelaPOS/HelaPay only
-- RECEIVES payments and has no public API):
-- * Record-and-verify: the shopper scans the till / pump LankaQR in the
--   app (GetMe checks the merchant and the amount), pays with their own
--   wallet or bank app (e.g. HelaPay in Helakuru), then reports the
--   reference and receipt. Nothing is "paid" until GetMe verifies it.
-- * Fuel is the SHOPPER'S OWN EXPENSE: GetMe keeps the record, receipt
--   and history only. Fuel payments never touch grocery totals, the
--   finance ledger, shopper earnings or reimbursements.
-- =====================================================

BEGIN;

-- ---------------------------------------------------
-- Supermarket: what the scanned till QR said + which app paid
-- ---------------------------------------------------

ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS payer_app VARCHAR(20)
  CHECK (payer_app IS NULL OR payer_app IN ('helapay', 'bank_app', 'card', 'other'));
-- { merchant: APPROVED|MERCHANT_UNKNOWN|MERCHANT_PENDING, merchantName, merchantCity,
--   qrAmount, expectedAmount, amountMatches, kind, scannedAt }
ALTER TABLE grocery_payment_attempts ADD COLUMN IF NOT EXISTS qr_check JSONB;

-- ---------------------------------------------------
-- Fuel stations (admin managed)
-- ---------------------------------------------------

CREATE TABLE IF NOT EXISTS fuel_stations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  brand VARCHAR(20) NOT NULL DEFAULT 'other' CHECK (brand IN ('ceypetco', 'lioc', 'sinopec', 'rm_parks', 'shell', 'other')),
  address VARCHAR(300),
  latitude DOUBLE PRECISION CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  phone VARCHAR(20),
  fuel_types TEXT[] NOT NULL DEFAULT ARRAY['petrol_92', 'auto_diesel']::TEXT[]
    CHECK (fuel_types <@ ARRAY['petrol_92', 'petrol_95', 'auto_diesel', 'super_diesel']::TEXT[] AND cardinality(fuel_types) > 0),
  -- How the station takes money (not every station has LankaQR)
  payment_methods TEXT[] NOT NULL DEFAULT ARRAY['lankaqr', 'card', 'cash']::TEXT[]
    CHECK (payment_methods <@ ARRAY['lankaqr', 'card', 'cash']::TEXT[] AND cardinality(payment_methods) > 0),
  -- Approved LankaQR merchant identity (from a scanned sample; no secrets)
  qr_merchant_key VARCHAR(64),
  qr_account_hash VARCHAR(64),
  qr_merchant_name VARCHAR(60),
  qr_merchant_city VARCHAR(40),
  qr_mcc VARCHAR(4),
  qr_approved_at TIMESTAMPTZ,
  qr_approved_by INTEGER,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  notes VARCHAR(500),
  created_by INTEGER,
  updated_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fuel_stations_status_idx ON fuel_stations (status);
CREATE UNIQUE INDEX IF NOT EXISTS fuel_stations_qr_account_idx ON fuel_stations (qr_account_hash) WHERE qr_account_hash IS NOT NULL;

-- ---------------------------------------------------
-- Fuel prices (CEYPETCO / LIOC revise them; admins enter each change)
-- ---------------------------------------------------

CREATE TABLE IF NOT EXISTS fuel_prices (
  id SERIAL PRIMARY KEY,
  fuel_type VARCHAR(20) NOT NULL CHECK (fuel_type IN ('petrol_92', 'petrol_95', 'auto_diesel', 'super_diesel')),
  price_per_litre NUMERIC(10, 2) NOT NULL CHECK (price_per_litre > 0 AND price_per_litre < 10000),
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note VARCHAR(200),
  set_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fuel_prices_type_idx ON fuel_prices (fuel_type, effective_from DESC);

-- ---------------------------------------------------
-- Shopper fuel payments (their own money; record + receipt)
-- ---------------------------------------------------

CREATE TABLE IF NOT EXISTS fuel_payments (
  id BIGSERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id),
  station_id INTEGER NOT NULL REFERENCES fuel_stations(id),
  fuel_type VARCHAR(20) NOT NULL CHECK (fuel_type IN ('petrol_92', 'petrol_95', 'auto_diesel', 'super_diesel')),
  litres NUMERIC(8, 2) CHECK (litres IS NULL OR (litres > 0 AND litres <= 300)),
  price_per_litre NUMERIC(10, 2),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0 AND amount <= 100000),
  vehicle_reg VARCHAR(16),
  payment_method VARCHAR(10) NOT NULL DEFAULT 'lankaqr' CHECK (payment_method IN ('lankaqr', 'card', 'cash')),
  payer_app VARCHAR(20) CHECK (payer_app IS NULL OR payer_app IN ('helapay', 'bank_app', 'card', 'other')),
  payer_reference VARCHAR(60),
  amount_paid NUMERIC(12, 2) CHECK (amount_paid IS NULL OR (amount_paid > 0 AND amount_paid <= 100000)),
  qr_check JSONB,
  receipt_url VARCHAR(300),
  status VARCHAR(12) NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'reported', 'verified', 'rejected', 'cancelled')),
  request_id VARCHAR(80) NOT NULL,
  reported_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER,
  review_note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shopper_id, request_id)
);

CREATE INDEX IF NOT EXISTS fuel_payments_shopper_idx ON fuel_payments (shopper_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fuel_payments_station_idx ON fuel_payments (station_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fuel_payments_status_idx ON fuel_payments (status, created_at DESC);

-- Status history (append-only)
CREATE TABLE IF NOT EXISTS fuel_payment_events (
  id BIGSERIAL PRIMARY KEY,
  payment_id BIGINT NOT NULL REFERENCES fuel_payments(id),
  event VARCHAR(30) NOT NULL,
  from_status VARCHAR(12),
  to_status VARCHAR(12),
  actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('shopper', 'admin', 'system')),
  actor_id INTEGER,
  note VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fuel_payment_events_payment_idx ON fuel_payment_events (payment_id, created_at);

CREATE OR REPLACE FUNCTION fuel_payment_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'fuel_payment_events rows are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fuel_payment_events_no_change ON fuel_payment_events;
CREATE TRIGGER fuel_payment_events_no_change
  BEFORE UPDATE OR DELETE ON fuel_payment_events
  FOR EACH ROW EXECUTE FUNCTION fuel_payment_events_append_only();

COMMIT;
