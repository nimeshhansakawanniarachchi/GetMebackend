-- ==================================================
-- PLATFORM PHASE 2
-- Admin accounts, shopper approval, shop open/closed, order cancellation
-- Run once: node src/sql/runSql.js src/sql/platform_phase2.sql
-- ==================================================

-- Admin panel users
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Shopper approval is separate from online/offline.
-- Existing shoppers are already working, so they start approved.
ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20);

UPDATE shoppers
SET approval_status = CASE
  WHEN status = 'rejected' THEN 'rejected'
  ELSE 'approved'
END
WHERE approval_status IS NULL;

ALTER TABLE shoppers
  ALTER COLUMN approval_status SET DEFAULT 'pending',
  ALTER COLUMN approval_status SET NOT NULL;

-- status now only means online/offline ('pending' used to mean offline)
UPDATE shoppers
SET status = 'offline'
WHERE status IS NULL OR status NOT IN ('online', 'offline');

-- Shop can pause new orders
ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS is_open BOOLEAN NOT NULL DEFAULT true;

-- Who cancelled an order and why
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(20),
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
