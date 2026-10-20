-- ==================================================
-- PLATFORM PHASE 5 — shopper tips, promo codes, order ratings
-- Run once: node src/sql/runSql.js src/sql/platform_phase5_tips_promos_ratings.sql
-- Safe to re-run.
-- ==================================================

-- Tip goes 100% to the shopper; discount is paid by GetMe.
-- total_amount = items + fees + tip - discount
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promo_code VARCHAR(40) NULL,
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Promo codes (managed by admins)
CREATE TABLE IF NOT EXISTS promo_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,          -- stored upper-case
  description VARCHAR(200) NULL,
  discount_type VARCHAR(20) NOT NULL,        -- percent | fixed | free_delivery
  discount_value NUMERIC(10,2) NOT NULL DEFAULT 0,
  max_discount NUMERIC(10,2) NULL,           -- cap for percent codes
  min_order_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  starts_at TIMESTAMP NULL,
  ends_at TIMESTAMP NULL,
  usage_limit INTEGER NULL,                  -- total uses, NULL = unlimited
  per_customer_limit INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_discount_type_check') THEN
    ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_discount_type_check
      CHECK (discount_type IN ('percent','fixed','free_delivery'));
  END IF;
END $$;

-- One row per order that used a code (cancelled orders don't count toward limits)
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id SERIAL PRIMARY KEY,
  promo_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  discount_amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_redemptions_promo ON promo_redemptions(promo_id);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_customer ON promo_redemptions(customer_id, promo_id);

-- Customer rating of a delivered order (one per order, editable)
CREATE TABLE IF NOT EXISTS order_ratings (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  shopper_id INTEGER NULL REFERENCES shoppers(id) ON DELETE SET NULL,
  rating SMALLINT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  comment VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_ratings_rating_check') THEN
    ALTER TABLE order_ratings ADD CONSTRAINT order_ratings_rating_check
      CHECK (rating BETWEEN 1 AND 5);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_order_ratings_shopper ON order_ratings(shopper_id);
