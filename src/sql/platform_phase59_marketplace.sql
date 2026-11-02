-- =====================================================
-- PHASE 59: MULTI-CATEGORY MARKETPLACE (2026-11-01)
-- Grocery shops keep working exactly as before. Clothing shops and
-- restaurants are added on the SAME shops / products / orders tables
-- (so delivery, PIN, chat, notifications, payments and the admin
-- tools are shared) with category-specific tables for variants,
-- images, menu options, documents, returns and merchant settlements.
--
-- ADDITIVE ONLY: new tables, new nullable / defaulted columns,
-- new triggers. Every existing row keeps its meaning:
--   shops.business_type defaults to 'grocery'
--   orders.business_type defaults to 'grocery' (merchant_status NULL)
-- Merchant orders reuse the existing orders.status values for the
-- delivery stages (waiting_for_shopper -> shopper_accepted ->
-- out_for_delivery -> arrived -> delivered / cancelled); the store's
-- own progress lives in orders.merchant_status. Customer-pickup
-- orders use one new status, 'awaiting_pickup'.
-- =====================================================

-- -----------------------------------------------------
-- Business categories (grocery / clothing / restaurant)
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS business_types (
  key VARCHAR(20) PRIMARY KEY,
  label VARCHAR(60) NOT NULL,
  description VARCHAR(300),
  -- GetMe's commission on a merchant order's item value (clothing /
  -- restaurants). Grocery orders keep the customer-paid GetMe fee
  -- model (orders.getme_fee) and ignore this.
  commission_percent NUMERIC(5, 2) NOT NULL DEFAULT 0
    CHECK (commission_percent >= 0 AND commission_percent <= 50),
  -- Clothing: days after delivery a customer can ask for a return;
  -- the merchant's money for the order becomes payable after it
  return_window_days INTEGER NOT NULL DEFAULT 0
    CHECK (return_window_days >= 0 AND return_window_days <= 60),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO business_types (key, label, description, commission_percent, return_window_days, sort)
VALUES
  ('grocery', 'Grocery shop', 'Supermarkets and grocery stores. A GetMe shopper shops the order.', 0, 0, 1),
  ('clothing', 'Clothing shop', 'Fashion stores. The store packs the order; a GetMe shopper delivers it.', 10, 7, 2),
  ('restaurant', 'Restaurant', 'Restaurants and food outlets. The kitchen prepares the order; a GetMe shopper delivers it.', 15, 0, 3)
ON CONFLICT (key) DO NOTHING;

-- Product / menu categories and subcategories per business type
-- (suggestions for the portal and customer filters; products keep
-- free-text category / subcategory so nothing existing breaks)
CREATE TABLE IF NOT EXISTS marketplace_categories (
  id SERIAL PRIMARY KEY,
  business_type VARCHAR(20) NOT NULL REFERENCES business_types(key),
  parent_id INTEGER REFERENCES marketplace_categories(id) ON DELETE CASCADE,
  name VARCHAR(60) NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_categories_unique
  ON marketplace_categories (business_type, COALESCE(parent_id, 0), lower(name));

DO $$
DECLARE
  v_parent INTEGER;
  v_row RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM marketplace_categories) THEN
    FOR v_row IN
      SELECT * FROM (VALUES
        ('clothing', 'Men', ARRAY['T-shirts', 'Shirts', 'Trousers', 'Jeans', 'Shorts', 'Sarongs']),
        ('clothing', 'Women', ARRAY['Dresses', 'Tops', 'Sarees', 'Skirts', 'Jeans', 'Frocks']),
        ('clothing', 'Kids', ARRAY['Boys', 'Girls', 'Baby']),
        ('clothing', 'Accessories', ARRAY['Bags', 'Belts', 'Caps', 'Scarves']),
        ('clothing', 'Footwear', ARRAY['Slippers', 'Sandals', 'Shoes']),
        ('restaurant', 'Rice & Curry', ARRAY['Chicken', 'Fish', 'Vegetable']),
        ('restaurant', 'Kottu', ARRAY['Chicken', 'Cheese', 'Vegetable']),
        ('restaurant', 'Fried Rice & Noodles', ARRAY[]::text[]),
        ('restaurant', 'Short Eats', ARRAY[]::text[]),
        ('restaurant', 'Burgers & Sandwiches', ARRAY[]::text[]),
        ('restaurant', 'Pizza', ARRAY[]::text[]),
        ('restaurant', 'Beverages', ARRAY['Hot', 'Cold', 'Juices']),
        ('restaurant', 'Desserts', ARRAY[]::text[])
      ) AS t(btype, name, subs)
    LOOP
      INSERT INTO marketplace_categories (business_type, name, sort)
      VALUES (v_row.btype, v_row.name, 0)
      RETURNING id INTO v_parent;

      INSERT INTO marketplace_categories (business_type, parent_id, name, sort)
      SELECT v_row.btype, v_parent, s, ord::int
      FROM unnest(v_row.subs) WITH ORDINALITY AS u(s, ord);
    END LOOP;
  END IF;
END $$;

-- Documents a business must upload, per type (Admin-configurable)
CREATE TABLE IF NOT EXISTS business_document_types (
  id SERIAL PRIMARY KEY,
  business_type VARCHAR(20) NOT NULL REFERENCES business_types(key),
  doc_key VARCHAR(40) NOT NULL,
  label VARCHAR(100) NOT NULL,
  description VARCHAR(300),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (business_type, doc_key)
);

INSERT INTO business_document_types (business_type, doc_key, label, description, required, sort)
VALUES
  ('grocery', 'business_registration', 'Business registration certificate', 'Registrar of Companies / Divisional Secretariat business registration', TRUE, 1),
  ('grocery', 'owner_identity', 'Owner NIC or passport', 'Front and back of the owner''s NIC, or passport photo page', TRUE, 2),
  ('clothing', 'business_registration', 'Business registration certificate', 'Registrar of Companies / Divisional Secretariat business registration', TRUE, 1),
  ('clothing', 'owner_identity', 'Owner NIC or passport', 'Front and back of the owner''s NIC, or passport photo page', TRUE, 2),
  ('restaurant', 'business_registration', 'Business registration certificate', 'Registrar of Companies / Divisional Secretariat business registration', TRUE, 1),
  ('restaurant', 'owner_identity', 'Owner NIC or passport', 'Front and back of the owner''s NIC, or passport photo page', TRUE, 2),
  ('restaurant', 'trade_licence', 'Trade licence', 'Trade licence from the local authority (Municipal / Urban / Pradeshiya Sabha)', TRUE, 3),
  ('restaurant', 'health_clearance', 'Health / food safety clearance', 'Clearance from the area MOH / PHI, if issued for your premises', FALSE, 4)
ON CONFLICT (business_type, doc_key) DO NOTHING;

-- -----------------------------------------------------
-- Shops: business category, profile, branches, operations
-- -----------------------------------------------------

ALTER TABLE shops ADD COLUMN IF NOT EXISTS business_type VARCHAR(20) NOT NULL DEFAULT 'grocery';
ALTER TABLE shops ADD COLUMN IF NOT EXISTS owner_name VARCHAR(120);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS description VARCHAR(600);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS province VARCHAR(40);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS district VARCHAR(40);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS city VARCHAR(80);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS business_reg_no VARCHAR(40);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(20);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS contact_email VARCHAR(150);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS cover_url TEXT;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS offers_delivery BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS offers_pickup BOOLEAN NOT NULL DEFAULT FALSE;
-- A branch is a shop row of its own (address, location, hours,
-- products, orders) whose parent is the business's main shop
ALTER TABLE shops ADD COLUMN IF NOT EXISTS parent_shop_id INTEGER REFERENCES shops(id);
-- Restaurant operations
ALTER TABLE shops ADD COLUMN IF NOT EXISTS default_prep_minutes INTEGER NOT NULL DEFAULT 20;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS max_active_orders INTEGER;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS orders_paused_until TIMESTAMPTZ;
-- [{ "date": "YYYY-MM-DD", "closed": true|false, "open": "HH:MM", "close": "HH:MM", "note": "" }]
ALTER TABLE shops ADD COLUMN IF NOT EXISTS special_hours JSONB NOT NULL DEFAULT '[]'::jsonb;
-- Registration review
ALTER TABLE shops ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS status_reason VARCHAR(500);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_business_type_fk') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_business_type_fk
      FOREIGN KEY (business_type) REFERENCES business_types(key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_prep_minutes_range') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_prep_minutes_range
      CHECK (default_prep_minutes BETWEEN 1 AND 240);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_max_active_range') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_max_active_range
      CHECK (max_active_orders IS NULL OR max_active_orders BETWEEN 1 AND 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_special_hours_array') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_special_hours_array
      CHECK (jsonb_typeof(special_hours) = 'array');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS shops_business_type_idx ON shops (business_type, status);
CREATE INDEX IF NOT EXISTS shops_parent_idx ON shops (parent_shop_id) WHERE parent_shop_id IS NOT NULL;

-- Uploaded registration documents (private files)
CREATE TABLE IF NOT EXISTS shop_documents (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  doc_key VARCHAR(40) NOT NULL,
  file_name VARCHAR(200) NOT NULL,
  original_name VARCHAR(200),
  mime_type VARCHAR(80),
  size_bytes INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  review_note VARCHAR(500),
  reviewed_by_admin_id INTEGER,
  reviewed_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shop_documents_shop ON shop_documents (shop_id, doc_key, id DESC);

-- Payout bank account (one per shop / branch)
CREATE TABLE IF NOT EXISTS shop_bank_accounts (
  shop_id INTEGER PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
  bank_name VARCHAR(80) NOT NULL,
  branch_name VARCHAR(80),
  account_name VARCHAR(120) NOT NULL,
  account_number VARCHAR(30) NOT NULL,
  verified_at TIMESTAMPTZ,
  verified_by_admin_id INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------
-- Products: clothing / restaurant fields, images, variants, options
-- -----------------------------------------------------

ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory VARCHAR(60);
-- Clothing / restaurant sale price (grocery keeps product_offers)
ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_price NUMERIC(12, 2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sku VARCHAR(60);
ALTER TABLE products ADD COLUMN IF NOT EXISTS material VARCHAR(60);
ALTER TABLE products ADD COLUMN IF NOT EXISTS gender VARCHAR(20);
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS has_variants BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS prep_minutes INTEGER;
-- 'veg' | 'non_veg' | 'vegan'
ALTER TABLE products ADD COLUMN IF NOT EXISTS food_type VARCHAR(10);
-- 0 none .. 3 hot
ALTER TABLE products ADD COLUMN IF NOT EXISTS spice_level SMALLINT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_discount_price_valid') THEN
    ALTER TABLE products ADD CONSTRAINT products_discount_price_valid
      CHECK (discount_price IS NULL OR (discount_price >= 0 AND discount_price < price));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_food_type_valid') THEN
    ALTER TABLE products ADD CONSTRAINT products_food_type_valid
      CHECK (food_type IS NULL OR food_type IN ('veg', 'non_veg', 'vegan'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_spice_level_valid') THEN
    ALTER TABLE products ADD CONSTRAINT products_spice_level_valid
      CHECK (spice_level IS NULL OR spice_level BETWEEN 0 AND 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_prep_minutes_valid') THEN
    ALTER TABLE products ADD CONSTRAINT products_prep_minutes_valid
      CHECK (prep_minutes IS NULL OR prep_minutes BETWEEN 1 AND 240);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS product_images (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS product_images_product ON product_images (product_id, sort, id);

-- One row per size / colour / material combination (clothing)
CREATE TABLE IF NOT EXISTS product_variants (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL,
  size VARCHAR(20),
  colour VARCHAR(30),
  material VARCHAR(40),
  sku VARCHAR(60),
  barcode VARCHAR(64),
  -- NULL = the product's price / discount price
  price NUMERIC(12, 2) CHECK (price IS NULL OR price >= 0),
  discount_price NUMERIC(12, 2),
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_variants_has_option CHECK (size IS NOT NULL OR colour IS NOT NULL OR material IS NOT NULL),
  CONSTRAINT product_variants_discount_valid CHECK (
    discount_price IS NULL OR (discount_price >= 0 AND (price IS NULL OR discount_price < price))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_combo
  ON product_variants (product_id, lower(COALESCE(size, '')), lower(COALESCE(colour, '')), lower(COALESCE(material, '')));
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_sku
  ON product_variants (shop_id, lower(sku)) WHERE sku IS NOT NULL AND sku <> '';
CREATE INDEX IF NOT EXISTS product_variants_product ON product_variants (product_id, sort, id);

-- Restaurant add-ons / customisations ("Choose your size", "Extra cheese")
CREATE TABLE IF NOT EXISTS product_option_groups (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  shop_id INTEGER NOT NULL,
  name VARCHAR(80) NOT NULL,
  -- min_select >= 1 = required
  min_select INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0 AND min_select <= 20),
  max_select INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1 AND max_select <= 20),
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_option_groups_range CHECK (min_select <= max_select)
);

CREATE INDEX IF NOT EXISTS product_option_groups_product ON product_option_groups (product_id, sort, id);

CREATE TABLE IF NOT EXISTS product_options (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES product_option_groups(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL,
  name VARCHAR(80) NOT NULL,
  price_delta NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (price_delta >= 0 AND price_delta <= 100000),
  is_available BOOLEAN NOT NULL DEFAULT TRUE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS product_options_group ON product_options (group_id, sort, id);

-- Stock movements can name the variant they changed
ALTER TABLE product_stock_movements ADD COLUMN IF NOT EXISTS variant_id INTEGER;

-- -----------------------------------------------------
-- Orders: category, fulfilment, merchant progress
-- -----------------------------------------------------

ALTER TABLE orders ADD COLUMN IF NOT EXISTS business_type VARCHAR(20) NOT NULL DEFAULT 'grocery';
-- 'delivery' (a GetMe shopper delivers) | 'pickup' (customer collects)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilment_method VARCHAR(10) NOT NULL DEFAULT 'delivery';
-- NULL for grocery. new | accepted | preparing | ready | picked_up |
-- completed | rejected | cancelled
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_status VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_accepted_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_preparing_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_ready_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_picked_up_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_rejected_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_ready_by TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_prep_minutes INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_note VARCHAR(500);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5, 2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(12, 2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_business_type_valid') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_business_type_valid
      CHECK (business_type IN ('grocery', 'clothing', 'restaurant'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_fulfilment_valid') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_fulfilment_valid
      CHECK (fulfilment_method IN ('delivery', 'pickup'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_merchant_status_valid') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_merchant_status_valid
      CHECK (merchant_status IS NULL OR merchant_status IN
        ('new', 'accepted', 'preparing', 'ready', 'picked_up', 'completed', 'rejected', 'cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_merchant_grocery_split') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_merchant_grocery_split
      CHECK ((business_type = 'grocery') = (merchant_status IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS orders_merchant_idx
  ON orders (shop_id, merchant_status, created_at DESC) WHERE business_type <> 'grocery';

-- Merchant order lines: chosen variant / options; reserved stock
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id INTEGER;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_label VARCHAR(120);
-- [{ "groupId", "groupName", "optionId", "name", "priceDelta" }]
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS options JSONB;
-- TRUE while this line's stock is taken from the shelf count; put
-- back once (trigger below) if the order is cancelled
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS stock_reserved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS returned_quantity NUMERIC(12, 3) NOT NULL DEFAULT 0;

-- -----------------------------------------------------
-- Clothing returns / refunds
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS merchant_return_requests (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  customer_id INTEGER NOT NULL,
  shop_id INTEGER NOT NULL,
  quantity NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  reason_code VARCHAR(30) NOT NULL,
  reason_text VARCHAR(500),
  photo_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- requested -> approved | rejected; approved -> received ->
  -- refund_pending -> refunded; requested -> cancelled (by customer)
  status VARCHAR(20) NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'rejected', 'received', 'refund_pending', 'refunded', 'cancelled')),
  merchant_note VARCHAR(500),
  refund_amount NUMERIC(12, 2),
  refund_method VARCHAR(20),
  refund_reference VARCHAR(120),
  refunded_by_admin_id INTEGER,
  client_request_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS merchant_returns_shop ON merchant_return_requests (shop_id, status, id DESC);
CREATE INDEX IF NOT EXISTS merchant_returns_order ON merchant_return_requests (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_returns_client
  ON merchant_return_requests (customer_id, client_request_id) WHERE client_request_id IS NOT NULL;
-- One open return per order line at a time
CREATE UNIQUE INDEX IF NOT EXISTS merchant_returns_one_open
  ON merchant_return_requests (order_item_id) WHERE status IN ('requested', 'approved', 'received', 'refund_pending');

-- -----------------------------------------------------
-- Merchant settlements (Business payments)
-- What GetMe owes a clothing shop / restaurant for a completed order:
-- item value - commission - approved return refunds. Recorded by
-- trigger when the order is delivered / collected; an admin records
-- the bank transfer (no bank API).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS merchant_settlements (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  shop_id INTEGER NOT NULL,
  business_type VARCHAR(20) NOT NULL,
  items_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  commission_percent NUMERIC(5, 2) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  refunds_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  -- who took the customer's cash: 'shopper' (GetMe delivery),
  -- 'merchant' (cash pickup: the store owes GetMe the commission), NULL (card)
  cash_collected_by VARCHAR(10),
  payable_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'held')),
  paid_at TIMESTAMPTZ,
  paid_reference VARCHAR(120),
  paid_by_admin_id INTEGER,
  hold_reason VARCHAR(300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS merchant_settlements_shop ON merchant_settlements (shop_id, status, id DESC);

-- -----------------------------------------------------
-- Trigger: a cancelled merchant order puts its reserved stock back
-- (every cancel path: customer, store rejection, admin, failed delivery)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION marketplace_restore_stock() RETURNS trigger AS $$
DECLARE
  v_line RECORD;
  v_qty INTEGER;
  v_after INTEGER;
BEGIN
  IF NEW.business_type = 'grocery' OR NEW.status <> 'cancelled' OR OLD.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  FOR v_line IN
    UPDATE order_items
       SET stock_reserved = FALSE
     WHERE order_id = NEW.id AND stock_reserved
    RETURNING id, product_id, variant_id, quantity
  LOOP
    v_qty := CEIL(v_line.quantity)::int;
    v_after := NULL;

    IF v_line.variant_id IS NOT NULL THEN
      UPDATE product_variants
         SET stock_quantity = stock_quantity + v_qty, updated_at = NOW()
       WHERE id = v_line.variant_id
      RETURNING stock_quantity INTO v_after;
      -- products.stock_quantity mirrors the sum of its variants
      UPDATE products p
         SET stock_quantity = COALESCE((SELECT SUM(stock_quantity) FROM product_variants WHERE product_id = p.id), 0),
             updated_at = NOW()
       WHERE p.id = v_line.product_id;
    ELSIF v_line.product_id IS NOT NULL THEN
      UPDATE products
         SET stock_quantity = stock_quantity + v_qty, updated_at = NOW()
       WHERE id = v_line.product_id
      RETURNING stock_quantity INTO v_after;
    END IF;

    IF v_after IS NOT NULL AND v_line.product_id IS NOT NULL THEN
      INSERT INTO product_stock_movements (shop_id, product_id, variant_id, change, stock_before, stock_after,
                                           reason, note, order_id, order_item_id, actor_type, actor_name)
      VALUES (NEW.shop_id, v_line.product_id, v_line.variant_id, v_qty, v_after - v_qty, v_after,
              'returned', 'Order #' || NEW.id || ' cancelled: stock put back',
              NEW.id, v_line.id, 'system', 'GetMe');
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_marketplace_restore_stock ON orders;
CREATE TRIGGER orders_marketplace_restore_stock
  AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_restore_stock();

-- -----------------------------------------------------
-- Trigger: a merchant order that reaches 'delivered' (shopper PIN or
-- store hand-over) is completed and its settlement recorded (once)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION marketplace_order_finished() RETURNS trigger AS $$
DECLARE
  v_window INTEGER := 0;
  v_items NUMERIC := COALESCE(NEW.items_total, 0);
  v_percent NUMERIC := COALESCE(NEW.commission_percent, 0);
  v_commission NUMERIC;
BEGIN
  IF NEW.business_type = 'grocery' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'delivered' THEN
    SELECT return_window_days INTO v_window FROM business_types WHERE key = NEW.business_type;
    v_commission := ROUND(v_items * v_percent / 100, 2);

    INSERT INTO merchant_settlements (order_id, shop_id, business_type, items_total, commission_percent,
                                      commission_amount, net_amount, cash_collected_by, payable_after)
    VALUES (NEW.id, NEW.shop_id, NEW.business_type, v_items, v_percent, v_commission, v_items - v_commission,
            CASE WHEN NEW.payment_method = 'cash'
                 THEN CASE WHEN NEW.fulfilment_method = 'pickup' THEN 'merchant' ELSE 'shopper' END END,
            COALESCE(NEW.delivered_at, NOW()) + make_interval(days => COALESCE(v_window, 0)))
    ON CONFLICT (order_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_marketplace_finished ON orders;
CREATE TRIGGER orders_marketplace_finished
  AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_order_finished();

-- BEFORE trigger: keep merchant_status in step with the delivery
-- statuses so every path (shopper PIN, admin tools) stays consistent
CREATE OR REPLACE FUNCTION marketplace_sync_merchant_status() RETURNS trigger AS $$
BEGIN
  IF NEW.business_type = 'grocery' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'delivered' AND NEW.merchant_status NOT IN ('completed') THEN
    NEW.merchant_status := 'completed';
  ELSIF NEW.status = 'cancelled' AND NEW.merchant_status NOT IN ('rejected', 'cancelled', 'completed') THEN
    NEW.merchant_status := 'cancelled';
  ELSIF NEW.status = 'out_for_delivery' AND NEW.merchant_status IN ('new', 'accepted', 'preparing', 'ready') THEN
    NEW.merchant_status := 'picked_up';
    NEW.merchant_picked_up_at := COALESCE(NEW.merchant_picked_up_at, NOW());
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_marketplace_sync_status ON orders;
CREATE TRIGGER orders_marketplace_sync_status
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION marketplace_sync_merchant_status();

-- -----------------------------------------------------
-- Customer notifications (phase 57) for merchant orders.
-- The phase 57 order trigger keeps handling grocery orders; for
-- clothing / restaurant orders the texts follow the store's
-- progress, and the shopper is the delivery rider.
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_notify_merchant_orders() RETURNS trigger AS $$
DECLARE
  v_shop TEXT;
  v_shopper TEXT;
  v_key TEXT := 'order:' || NEW.id || ':';
  v_food BOOLEAN := NEW.business_type = 'restaurant';
  v_data JSONB;
BEGIN
  IF NEW.business_type = 'grocery' THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT shop_name INTO v_shop FROM shops WHERE id = NEW.shop_id;
    SELECT customer_first_name(full_name) INTO v_shopper FROM shoppers WHERE id = NEW.shopper_id;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  v_shop := COALESCE(v_shop, 'The store');
  v_shopper := COALESCE(v_shopper, 'Your rider');
  v_data := jsonb_build_object('orderId', NEW.id, 'status', NEW.status, 'merchantStatus', NEW.merchant_status,
                               'businessType', NEW.business_type, 'fulfilment', NEW.fulfilment_method);

  IF NEW.merchant_status IS DISTINCT FROM OLD.merchant_status THEN
    IF NEW.merchant_status = 'accepted' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'merchant.accepted',
        'Order accepted',
        v_shop || ' accepted your order #' || NEW.id ||
          CASE WHEN NEW.merchant_prep_minutes IS NOT NULL
               THEN ' (about ' || NEW.merchant_prep_minutes || ' min).' ELSE '.' END,
        v_data, FALSE, v_key || 'merchant:accepted');
    ELSIF NEW.merchant_status = 'preparing' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'merchant.preparing',
        CASE WHEN v_food THEN 'Preparing your food' ELSE 'Packing your order' END,
        v_shop || CASE WHEN v_food THEN ' is preparing order #' ELSE ' is packing order #' END || NEW.id || '.',
        v_data, FALSE, v_key || 'merchant:preparing');
    ELSIF NEW.merchant_status = 'ready' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'merchant.ready',
        CASE WHEN NEW.fulfilment_method = 'pickup' THEN 'Ready to collect' ELSE 'Order ready' END,
        CASE WHEN NEW.fulfilment_method = 'pickup'
             THEN 'Order #' || NEW.id || ' is ready at ' || v_shop || '. Show your pickup code at the counter.'
             ELSE 'Order #' || NEW.id || ' is ready at ' || v_shop || ' for your rider to collect.' END,
        v_data, NEW.fulfilment_method = 'pickup', v_key || 'merchant:ready');
    ELSIF NEW.merchant_status = 'rejected' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'merchant.rejected',
        'Order not accepted',
        v_shop || ' couldn''t take order #' || NEW.id ||
          CASE WHEN NULLIF(btrim(COALESCE(NEW.merchant_note, '')), '') IS NOT NULL
               THEN ': ' || left(NEW.merchant_note, 200) ELSE '.' END ||
          CASE WHEN NEW.payment_method = 'card' THEN ' Any card payment is refunded.' ELSE '' END,
        v_data, FALSE, v_key || 'merchant:rejected');
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'shopper_accepted' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'delivery', 'order.shopper_accepted',
        'Rider assigned',
        v_shopper || ' will collect order #' || NEW.id || ' from ' || v_shop || ' and deliver it.',
        v_data, FALSE, v_key || 'accepted:' || COALESCE(NEW.shopper_id::text, '0'));
    ELSIF NEW.status = 'out_for_delivery' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'delivery', 'order.out_for_delivery',
        'Your order is on the way',
        v_shopper || ' picked up order #' || NEW.id || ' from ' || v_shop || '.',
        v_data, FALSE, v_key || 'out_for_delivery');
    ELSIF NEW.status = 'arrived' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'delivery', 'order.arrived',
        'Your rider has arrived',
        'Share your delivery PIN with ' || v_shopper || ' to receive order #' || NEW.id || '.',
        v_data || jsonb_build_object('pinRequired', TRUE), TRUE, v_key || 'arrived');
    ELSIF NEW.status = 'delivered' THEN
      PERFORM customer_notify_resolve(NEW.customer_id, v_key || 'arrived', 'done');
      PERFORM customer_notify_resolve(NEW.customer_id, v_key || 'merchant:ready', 'done');
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'delivery', 'order.delivered',
        CASE WHEN NEW.fulfilment_method = 'pickup' THEN 'Order collected' ELSE 'Order delivered' END,
        'Order #' || NEW.id || CASE WHEN NEW.fulfilment_method = 'pickup'
                                    THEN ' was collected from ' || v_shop || '. Enjoy!'
                                    ELSE ' has been delivered. Enjoy!' END,
        v_data, FALSE, v_key || 'delivered');
    ELSIF NEW.status = 'cancelled' AND NEW.merchant_status IS DISTINCT FROM 'rejected' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'order.cancelled',
        'Order cancelled',
        'Order #' || NEW.id || ' was cancelled' ||
          CASE WHEN NULLIF(btrim(COALESCE(NEW.cancel_reason, '')), '') IS NOT NULL
               THEN ': ' || left(NEW.cancel_reason, 200) ELSE '.' END,
        v_data || jsonb_build_object('cancelledBy', NEW.cancelled_by), FALSE, v_key || 'cancelled');
    END IF;

    IF NEW.status IN ('delivered', 'cancelled') THEN
      UPDATE customer_notifications
         SET action_state = 'expired', action_resolved_at = NOW()
       WHERE customer_id = NEW.customer_id AND order_id = NEW.id AND action_state = 'pending';
      PERFORM pg_notify('customer_notification', 'changed:' || NEW.customer_id::text);
    END IF;
  END IF;

  IF NEW.delivery_photo_url IS NOT NULL AND OLD.delivery_photo_url IS NULL THEN
    PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'delivery', 'order.delivery_photo',
      'Delivery photo added',
      v_shopper || ' added a photo of where your order was left.',
      v_data, FALSE, v_key || 'delivery_photo');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_merchant_orders failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_customer_notify_merchant ON orders;
CREATE TRIGGER orders_customer_notify_merchant
  AFTER UPDATE OF status, merchant_status, delivery_photo_url ON orders
  FOR EACH ROW EXECUTE FUNCTION customer_notify_merchant_orders();

-- The phase 57 order trigger (function unchanged) now fires for
-- grocery orders only; merchant orders use the trigger above.
DROP TRIGGER IF EXISTS orders_customer_notify ON orders;
CREATE TRIGGER orders_customer_notify
  AFTER UPDATE OF status, delivery_photo_url ON orders
  FOR EACH ROW
  WHEN (NEW.business_type = 'grocery')
  EXECUTE FUNCTION customer_notify_orders();
