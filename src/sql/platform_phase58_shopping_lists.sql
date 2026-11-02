-- =====================================================
-- PHASE 58: CUSTOMER SHOPPING LISTS (2026-11-01)
-- Additive only: new tables, nothing existing changes.
--
-- A customer keeps one or more saved lists. A list item is either
--   'product' - a catalogue product (prices are NEVER stored here; the
--               API reads the live catalogue price / availability), or
--   'special' - a special request that isn't in the catalogue (name,
--               brand, size, description, optional photo). It has no
--               price: it goes to the cart / an order as an existing
--               custom item, which the shopper prices at the shelf.
-- client_item_id makes "add" idempotent (a retried request returns the
-- same row); a product appears once per list (adding it again raises
-- the quantity instead of making a second line).
-- Ownership: every row carries customer_id; the API always filters on
-- the signed-in customer.
-- =====================================================

CREATE TABLE IF NOT EXISTS shopping_lists (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  name VARCHAR(80) NOT NULL DEFAULT 'My shopping list',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS shopping_lists_customer
  ON shopping_lists (customer_id, id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS shopping_list_items (
  id SERIAL PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('product', 'special')),
  product_id INTEGER,
  -- product: the product's own shop (from the catalogue, never the app);
  -- special: the store the customer wants it from (optional)
  shop_id INTEGER,
  item_name VARCHAR(150) NOT NULL,
  brand VARCHAR(80),
  size VARCHAR(60),
  quantity NUMERIC(10, 3) NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  unit VARCHAR(10) NOT NULL DEFAULT 'pcs',
  -- notes / preferences ("ripe ones", "no sugar version")
  note VARCHAR(500),
  photo_url TEXT,
  checked BOOLEAN NOT NULL DEFAULT FALSE,
  client_item_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shopping_list_items_product_has_id CHECK (kind <> 'product' OR product_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS shopping_list_items_list
  ON shopping_list_items (list_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS shopping_list_items_client_id
  ON shopping_list_items (list_id, client_item_id) WHERE client_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS shopping_list_items_one_product
  ON shopping_list_items (list_id, product_id) WHERE kind = 'product';
