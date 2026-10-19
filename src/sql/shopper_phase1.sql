-- ==================================================
-- SHOPPER APP PHASE 1
-- Earnings, batch countdown, notifications, profile
-- Run once: node src/sql/runSql.js src/sql/shopper_phase1.sql
-- ==================================================

-- When the order was delivered (earnings by day/week)
-- and when the customer started looking for a shopper ("waiting N min")
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS shopper_search_started_at TIMESTAMP;

UPDATE orders
SET delivered_at = updated_at
WHERE status = 'delivered'
  AND delivered_at IS NULL;

-- Shopper vehicle (profile)
ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS vehicle_number VARCHAR(30);

-- Which batches each shopper has seen / hidden (countdown)
CREATE TABLE IF NOT EXISTS shopper_order_offers (
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
  dismissed_at TIMESTAMP,
  PRIMARY KEY (shopper_id, order_id)
);

-- In-app notification history
CREATE TABLE IF NOT EXISTS shopper_notifications (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  type VARCHAR(40) NOT NULL,
  title VARCHAR(150) NOT NULL,
  body TEXT,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  read_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shopper_notifications_shopper
  ON shopper_notifications (shopper_id, created_at DESC);
