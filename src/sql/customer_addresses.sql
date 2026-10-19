-- ==================================================
-- CUSTOMER SAVED DELIVERY ADDRESSES
-- Run once: node src/sql/runSql.js src/sql/customer_addresses.sql
-- ==================================================

CREATE TABLE IF NOT EXISTS customer_addresses (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label VARCHAR(50) NOT NULL DEFAULT 'Other',
  address TEXT NOT NULL,
  unit VARCHAR(100),
  building VARCHAR(150),
  instructions TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  place_id VARCHAR(255),
  last_used_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
  ON customer_addresses (customer_id, last_used_at DESC);
