-- =====================================================
-- PLATFORM PHASE 29 — pricing & promotions
-- Run once: node src/sql/runSql.js src/sql/platform_phase29_pricing.sql
--
--   products                  price >= 0 (CHECK), price_updated_at,
--                             index on shop_id (product lists)
--   product_price_history     every price change: old -> new, source
--                             (created | manual | import | admin), who
--   product_offers            min_quantity (offer needs N+ units),
--                             max_per_order (customer limit while it runs),
--                             source (portal | import)
--   product_offer_history     create / update / delete / pause / resume
--                             with the offer before and after
--   order_items               regular_unit_price (shelf price, always),
--                             line_total, offer_discount (saved on the
--                             line), shelf_unit_price (price the shopper
--                             found at the till, when reported)
--   orders.client_request_id  same request id twice = same order
--                             (double taps / retries)
--   order_item_price_reports  shopper reports a different shelf price;
--                             policy outcome + customer answer + admin review
-- All additive. Existing rows keep working (new columns are nullable
-- or have defaults).
-- =====================================================

-- ---------- products ----------

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS price_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_price_not_negative') THEN
    ALTER TABLE products ADD CONSTRAINT products_price_not_negative CHECK (price >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_stock_not_negative') THEN
    ALTER TABLE products ADD CONSTRAINT products_stock_not_negative CHECK (stock_quantity >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS products_shop_idx ON products (shop_id, category);

-- ---------- price history ----------

CREATE TABLE IF NOT EXISTS product_price_history (
  id BIGSERIAL PRIMARY KEY,
  shop_id INT NOT NULL,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  old_price NUMERIC(12,2),                  -- NULL when the product was created
  new_price NUMERIC(12,2) NOT NULL CHECK (new_price >= 0),
  source VARCHAR(20) NOT NULL CHECK (source IN ('created', 'manual', 'import', 'admin')),
  note VARCHAR(300),
  actor_type VARCHAR(20) NOT NULL,          -- owner | staff | admin | system
  actor_id INT,
  actor_name VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS price_history_product_idx ON product_price_history (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS price_history_shop_idx ON product_price_history (shop_id, created_at DESC);

-- ---------- offers ----------

ALTER TABLE product_offers
  ADD COLUMN IF NOT EXISTS min_quantity INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_per_order INT,
  ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'portal';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_offers_quantities') THEN
    ALTER TABLE product_offers ADD CONSTRAINT product_offers_quantities CHECK (
      min_quantity BETWEEN 1 AND 100
      AND (max_per_order IS NULL OR (max_per_order BETWEEN 1 AND 100 AND max_per_order >= min_quantity))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_offers_dates') THEN
    ALTER TABLE product_offers ADD CONSTRAINT product_offers_dates CHECK (ends_at IS NULL OR ends_at > starts_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_offers_source') THEN
    ALTER TABLE product_offers ADD CONSTRAINT product_offers_source CHECK (source IN ('portal', 'import'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS product_offers_live_idx ON product_offers (shop_id, starts_at, ends_at)
  WHERE is_active AND NOT paused_by_admin;

CREATE TABLE IF NOT EXISTS product_offer_history (
  id BIGSERIAL PRIMARY KEY,
  offer_id INT NOT NULL,                    -- no FK: deleted offers keep their history
  shop_id INT NOT NULL,
  action VARCHAR(20) NOT NULL CHECK (action IN ('create', 'update', 'delete', 'pause', 'resume')),
  before JSONB,
  after JSONB,
  actor_type VARCHAR(20) NOT NULL,          -- owner | staff | admin | system
  actor_id INT,
  actor_name VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS offer_history_offer_idx ON product_offer_history (offer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS offer_history_shop_idx ON product_offer_history (shop_id, created_at DESC);

-- ---------- order snapshot ----------

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS regular_unit_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS offer_discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shelf_unit_price NUMERIC(12,2);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS client_request_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_client_request
  ON orders (customer_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- ---------- shopper price reports ----------
-- outcome: lower    shelf price below the order price -> customer pays less
--          absorbed higher, within tolerance -> GetMe pays the difference
--          approval higher, beyond tolerance -> customer approves or refunds
-- status:  applied | absorbed | pending | approved | declined | cancelled

CREATE TABLE IF NOT EXISTS order_item_price_reports (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id INT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  shop_id INT,
  shopper_id INT,
  product_id INT,
  item_name VARCHAR(200),
  order_unit_price NUMERIC(12,2) NOT NULL,  -- what the order charged per unit
  shelf_unit_price NUMERIC(12,2) NOT NULL CHECK (shelf_unit_price > 0),
  price_unit VARCHAR(10) NOT NULL DEFAULT 'item', -- item | kg | L (what one unit is)
  outcome VARCHAR(10) NOT NULL CHECK (outcome IN ('lower', 'absorbed', 'approval')),
  status VARCHAR(10) NOT NULL CHECK (status IN ('applied', 'absorbed', 'pending', 'approved', 'declined', 'cancelled')),
  line_before NUMERIC(12,2),                -- customer line total before
  line_after NUMERIC(12,2),                 -- customer line total after (approved / applied)
  getme_absorbed NUMERIC(12,2) NOT NULL DEFAULT 0,
  approved_charge NUMERIC(12,2),            -- card: extra amount the customer approved
  photo_url TEXT,
  note VARCHAR(300),
  responded_at TIMESTAMPTZ,
  admin_status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (admin_status IN ('open', 'resolved')),
  admin_note VARCHAR(300),
  reviewed_by INT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open (pending) report per order item at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_price_report_pending
  ON order_item_price_reports (order_item_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS price_reports_order_idx ON order_item_price_reports (order_id);
CREATE INDEX IF NOT EXISTS price_reports_admin_idx ON order_item_price_reports (admin_status, created_at DESC);
