-- =====================================================
-- PLATFORM PHASE 18 — extra items while shopping
-- Run once: node src/sql/runSql.js src/sql/platform_phase18_item_requests.sql
--
-- Once shopping has started, items are no longer added straight to
-- the order (that is /add-items, before shopping). Each extra item
-- is a request the other side answers:
--   requested_by 'customer' -> the shopper accepts / rejects it
--   requested_by 'shopper'  -> the customer approves / declines it
-- Accepting inserts the priced line (order_items) into the right
-- shop's list and raises the order total. A shop can't be checked
-- out while one of its requests is pending.
-- =====================================================

CREATE TABLE IF NOT EXISTS order_item_requests (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  shop_id INTEGER NOT NULL,
  requested_by VARCHAR(20) NOT NULL CHECK (requested_by IN ('customer', 'shopper')),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  product_id INTEGER,
  item_name VARCHAR(255) NOT NULL,
  item_image TEXT,
  quantity NUMERIC(10, 3) NOT NULL,
  unit VARCHAR(20),
  -- The priced quote line (pricing/quote.js) inserted on accept, so
  -- the customer pays the price they saw
  line JSONB NOT NULL,
  line_total NUMERIC(12, 2) NOT NULL,
  -- Saved-card orders: the extra the customer approved for this item
  approved_charge NUMERIC(12, 2),
  note TEXT,
  reject_reason TEXT,
  order_item_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS order_item_requests_order_idx
  ON order_item_requests (order_id, status);

-- Which items were added after checkout (shown as "Added" in both apps)
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS added_by VARCHAR(20);
