-- =====================================================
-- PHASE 60: NATIONWIDE PRODUCT SEARCH + SHOP-MANAGED DELIVERY
-- (2026-11-01). Additive; nearby discovery, grocery and the phase 59
-- marketplace keep working as before.
--
--  * products.search_text: one lower-case text per product (name,
--    brand, category, material, gender words, its available
--    sizes / colours), kept up to date by triggers; trigram index for
--    fast nationwide search with pagination on the server.
--  * Shop-managed delivery: a shop (clothing) can deliver itself or
--    through its own courier to the districts it lists, at the fee and
--    delivery days IT sets (shop_delivery_zones). GetMe has no courier
--    API: nothing is priced or timed by GetMe for these orders.
--    New fulfilment 'shop_delivery'; order status 'shop_shipping'
--    while the store handles it; merchant_status 'shipped' once handed
--    to the courier (courier name / tracking number recorded).
--  * The GetMe rider delivery keeps its own rules (road distance limit).
-- =====================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------
-- Search text
-- -----------------------------------------------------

ALTER TABLE products ADD COLUMN IF NOT EXISTS search_text TEXT;

CREATE OR REPLACE FUNCTION marketplace_gender_words(p_gender TEXT) RETURNS TEXT AS $$
  SELECT CASE lower(COALESCE(p_gender, ''))
    WHEN 'men' THEN 'men mens man gents male'
    WHEN 'women' THEN 'women womens woman ladies female'
    WHEN 'kids' THEN 'kids kid children child boys girls'
    WHEN 'unisex' THEN 'unisex men women'
    ELSE '' END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION marketplace_search_text(
  p_id INTEGER, p_name TEXT, p_brand TEXT, p_category TEXT, p_subcategory TEXT,
  p_material TEXT, p_gender TEXT, p_description TEXT
) RETURNS TEXT AS $$
  SELECT lower(regexp_replace(concat_ws(' ',
    p_name, p_brand, p_category, p_subcategory, p_material, marketplace_gender_words(p_gender),
    left(COALESCE(p_description, ''), 300),
    (SELECT string_agg(DISTINCT concat_ws(' ', v.size, v.colour, v.material), ' ')
       FROM product_variants v WHERE v.product_id = p_id AND v.is_available)
  ), '\s+', ' ', 'g'));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION products_search_text_set() RETURNS trigger AS $$
BEGIN
  NEW.search_text := marketplace_search_text(NEW.id, NEW.product_name, NEW.brand, NEW.category,
    NEW.subcategory, NEW.material, NEW.gender, NEW.description);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_search_text ON products;
CREATE TRIGGER products_search_text
  BEFORE INSERT OR UPDATE OF product_name, brand, category, subcategory, material, gender, description ON products
  FOR EACH ROW EXECUTE FUNCTION products_search_text_set();

-- A variant change (size / colour / availability) refreshes its product
CREATE OR REPLACE FUNCTION product_variants_search_text() RETURNS trigger AS $$
DECLARE
  v_product INTEGER := COALESCE(NEW.product_id, OLD.product_id);
BEGIN
  UPDATE products p
     SET search_text = marketplace_search_text(p.id, p.product_name, p.brand, p.category,
           p.subcategory, p.material, p.gender, p.description)
   WHERE p.id = v_product;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_variants_search_text ON product_variants;
CREATE TRIGGER product_variants_search_text
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION product_variants_search_text();

UPDATE products p
   SET search_text = marketplace_search_text(p.id, p.product_name, p.brand, p.category,
         p.subcategory, p.material, p.gender, p.description)
 WHERE p.search_text IS NULL;

CREATE INDEX IF NOT EXISTS products_search_trgm ON products USING gin (search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_name_trgm ON products USING gin (lower(product_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS products_shop_available ON products (shop_id) WHERE is_available;
CREATE INDEX IF NOT EXISTS product_variants_size_colour ON product_variants (lower(size), lower(colour)) WHERE is_available AND stock_quantity > 0;
CREATE INDEX IF NOT EXISTS shops_marketplace_district ON shops (business_type, status, district);
CREATE INDEX IF NOT EXISTS shops_name_trgm ON shops USING gin (lower(shop_name) gin_trgm_ops);

-- -----------------------------------------------------
-- Shop-managed delivery (settings + districts served)
-- -----------------------------------------------------

ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_delivery_enabled BOOLEAN NOT NULL DEFAULT FALSE;
-- cash on delivery collected by the store / its courier
ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_delivery_cod BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_delivery_courier VARCHAR(60);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS shop_delivery_note VARCHAR(300);

CREATE TABLE IF NOT EXISTS shop_delivery_zones (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  district VARCHAR(40) NOT NULL,
  fee NUMERIC(10, 2) NOT NULL CHECK (fee >= 0 AND fee <= 50000),
  min_days INTEGER NOT NULL CHECK (min_days BETWEEN 0 AND 30),
  max_days INTEGER NOT NULL CHECK (max_days BETWEEN 0 AND 30),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shop_delivery_zones_days CHECK (min_days <= max_days),
  UNIQUE (shop_id, district)
);

CREATE INDEX IF NOT EXISTS shop_delivery_zones_district ON shop_delivery_zones (district, shop_id) WHERE is_active;

-- Places resolved to a district (Google Place Details), cached
CREATE TABLE IF NOT EXISTS place_districts (
  place_id VARCHAR(300) PRIMARY KEY,
  district VARCHAR(40),
  province VARCHAR(40),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------
-- Orders
-- -----------------------------------------------------

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_district VARCHAR(40);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_district_source VARCHAR(12);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_min_days INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ship_max_days INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_name VARCHAR(60);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number VARCHAR(80);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS merchant_shipped_at TIMESTAMPTZ;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fulfilment_valid;
ALTER TABLE orders ADD CONSTRAINT orders_fulfilment_valid
  CHECK (fulfilment_method IN ('delivery', 'pickup', 'shop_delivery'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_merchant_status_valid;
ALTER TABLE orders ADD CONSTRAINT orders_merchant_status_valid
  CHECK (merchant_status IS NULL OR merchant_status IN
    ('new', 'accepted', 'preparing', 'ready', 'shipped', 'picked_up', 'completed', 'rejected', 'cancelled'));

ALTER TABLE merchant_settlements ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- Settlement on completion: a store that delivered itself also gets
-- the delivery fee the customer paid; cash at pickup / store delivery
-- is collected by the store
CREATE OR REPLACE FUNCTION marketplace_order_finished() RETURNS trigger AS $$
DECLARE
  v_window INTEGER := 0;
  v_items NUMERIC := COALESCE(NEW.items_total, 0);
  v_percent NUMERIC := COALESCE(NEW.commission_percent, 0);
  v_commission NUMERIC;
  v_delivery NUMERIC := CASE WHEN NEW.fulfilment_method = 'shop_delivery' THEN COALESCE(NEW.delivery_fee, 0) ELSE 0 END;
BEGIN
  IF NEW.business_type = 'grocery' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'delivered' THEN
    SELECT return_window_days INTO v_window FROM business_types WHERE key = NEW.business_type;
    v_commission := ROUND(v_items * v_percent / 100, 2);

    INSERT INTO merchant_settlements (order_id, shop_id, business_type, items_total, commission_percent,
                                      commission_amount, delivery_fee, net_amount, cash_collected_by, payable_after)
    VALUES (NEW.id, NEW.shop_id, NEW.business_type, v_items, v_percent, v_commission, v_delivery,
            v_items - v_commission + v_delivery,
            CASE WHEN NEW.payment_method = 'cash'
                 THEN CASE WHEN NEW.fulfilment_method IN ('pickup', 'shop_delivery') THEN 'merchant' ELSE 'shopper' END END,
            COALESCE(NEW.delivered_at, NOW()) + make_interval(days => COALESCE(v_window, 0)))
    ON CONFLICT (order_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Customer notifications for merchant orders: + 'shipped' (store
-- delivery), store-delivered texts
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
          CASE WHEN NEW.fulfilment_method = 'shop_delivery' AND NEW.ship_max_days IS NOT NULL
               THEN ' (delivery in ' || NEW.ship_min_days || '-' || NEW.ship_max_days || ' days).'
               WHEN NEW.merchant_prep_minutes IS NOT NULL
               THEN ' (about ' || NEW.merchant_prep_minutes || ' min).' ELSE '.' END,
        v_data, FALSE, v_key || 'merchant:accepted');
    ELSIF NEW.merchant_status = 'preparing' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'merchant.preparing',
        CASE WHEN v_food THEN 'Preparing your food' ELSE 'Packing your order' END,
        v_shop || CASE WHEN v_food THEN ' is preparing order #' ELSE ' is packing order #' END || NEW.id || '.',
        v_data, FALSE, v_key || 'merchant:preparing');
    ELSIF NEW.merchant_status = 'ready' AND NEW.fulfilment_method <> 'shop_delivery' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'merchant.ready',
        CASE WHEN NEW.fulfilment_method = 'pickup' THEN 'Ready to collect' ELSE 'Order ready' END,
        CASE WHEN NEW.fulfilment_method = 'pickup'
             THEN 'Order #' || NEW.id || ' is ready at ' || v_shop || '. Show your pickup code at the counter.'
             ELSE 'Order #' || NEW.id || ' is ready at ' || v_shop || ' for your rider to collect.' END,
        v_data, NEW.fulfilment_method = 'pickup', v_key || 'merchant:ready');
    ELSIF NEW.merchant_status = 'shipped' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'delivery', 'merchant.shipped',
        'Your order is on the way',
        v_shop || ' sent order #' || NEW.id ||
          COALESCE(' with ' || NULLIF(btrim(NEW.courier_name), ''), '') ||
          COALESCE(' (tracking ' || NULLIF(btrim(NEW.tracking_number), '') || ')', '') || '.',
        v_data || jsonb_build_object('courier', NEW.courier_name, 'trackingNumber', NEW.tracking_number),
        FALSE, v_key || 'merchant:shipped');
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

-- 'shop_delivery' needs more than the phase 59 column width
ALTER TABLE orders ALTER COLUMN fulfilment_method TYPE VARCHAR(20);
