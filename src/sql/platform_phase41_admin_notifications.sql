-- =====================================================
-- PHASE 41 (2026-10-29): ADMIN NOTIFICATIONS
--
-- One row per business event in admin_notifications, written by the
-- database itself when the change is committed (deferred constraint
-- triggers + statement triggers below), so a notification exists only
-- for something that really happened, whatever code path made it.
-- Node (src/admin/notifications.js) LISTENs on 'admin_notification',
-- loads the row and pushes it over Socket.IO to the admins allowed to
-- see it. Time-based alerts (late orders, unassigned orders, stuck
-- payments) and technical errors are added from Node through the same
-- admin_notify() function.
--
-- * dedupe_key UNIQUE: retries and repeated events never make a second
--   notification (count events such as "products added" add to
--   item_count instead).
-- * permissions TEXT[]: an admin sees the row if they hold ANY of them
--   (and the role's notification categories allow it); target_admin_id
--   rows go only to that admin.
-- * Read / dismissed state is per admin (admin_notification_states);
--   dismissing hides the notification for that admin only - business
--   records are never touched.
-- * Bodies hold no phone numbers, emails, addresses, card data or
--   secrets (failed sign-ins show the e-mail that was tried, to the
--   Super Admin only).
-- * actor_admin_id: the admin who caused it doesn't get it - except
--   staff / security events, which the Super Admin always sees (an
--   unexpected "new staff account" is itself a warning sign).
-- Every trigger function swallows its own errors (RAISE WARNING): a
-- notification problem can never fail an order, payment or sign-in.
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS admin_notifications (
  id BIGSERIAL PRIMARY KEY,
  category VARCHAR(20) NOT NULL
    CHECK (category IN ('orders', 'customers', 'shoppers', 'shops', 'products', 'payments', 'support', 'staff', 'system')),
  event_type VARCHAR(60) NOT NULL,
  severity VARCHAR(10) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  title VARCHAR(200) NOT NULL,
  body VARCHAR(500),
  entity_type VARCHAR(40),
  entity_id VARCHAR(60),
  permissions TEXT[] NOT NULL DEFAULT '{}',
  target_admin_id INTEGER REFERENCES admins(id),
  actor_admin_id INTEGER,
  item_count INTEGER,
  dedupe_key VARCHAR(200) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cardinality(permissions) > 0 OR target_admin_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS admin_notifications_created_idx ON admin_notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_notifications_category_idx ON admin_notifications (category, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_notifications_target_idx ON admin_notifications (target_admin_id) WHERE target_admin_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS admin_notification_states (
  admin_id INTEGER NOT NULL REFERENCES admins(id),
  notification_id BIGINT NOT NULL REFERENCES admin_notifications(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  PRIMARY KEY (admin_id, notification_id)
);

CREATE INDEX IF NOT EXISTS admin_notification_states_notification_idx ON admin_notification_states (notification_id);

-- A staff member's own choices (in-app only; e-mail / push are not set up)
CREATE TABLE IF NOT EXISTS admin_notification_preferences (
  admin_id INTEGER PRIMARY KEY REFERENCES admins(id),
  muted_categories TEXT[] NOT NULL DEFAULT '{}',
  important_only_categories TEXT[] NOT NULL DEFAULT '{}',
  popups VARCHAR(10) NOT NULL DEFAULT 'important' CHECK (popups IN ('all', 'important', 'off')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Super Admin policy: retention + which categories each role receives
CREATE TABLE IF NOT EXISTS admin_notification_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  retention_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 7 AND 730),
  role_categories JSONB NOT NULL,
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO admin_notification_settings (id, retention_days, role_categories)
VALUES (
  1, 90,
  '{"operations": ["orders", "customers", "shoppers", "shops", "products", "support"],
    "support": ["orders", "customers", "shoppers", "support"],
    "finance": ["payments"],
    "developer": ["system"]}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------
-- Helpers
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_money(amount NUMERIC) RETURNS TEXT AS $$
  SELECT 'Rs ' || to_char(COALESCE(amount, 0), 'FM999,999,999,990.00');
$$ LANGUAGE sql IMMUTABLE;

-- First name + initial only ("Nimal P.") for people in titles
CREATE OR REPLACE FUNCTION admin_short_name(full_name TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN full_name IS NULL OR btrim(full_name) = '' THEN NULL
    WHEN position(' ' IN btrim(full_name)) = 0 THEN btrim(full_name)
    ELSE split_part(btrim(full_name), ' ', 1) || ' ' ||
         upper(left(split_part(btrim(full_name), ' ', array_length(regexp_split_to_array(btrim(full_name), '\s+'), 1)), 1)) || '.'
  END;
$$ LANGUAGE sql IMMUTABLE;

-- Creates a notification once per dedupe key. p_count adds to item_count
-- of an existing row instead (aggregated events). NOTIFY goes out on
-- commit only, so rolled-back work never reaches an admin.
CREATE OR REPLACE FUNCTION admin_notify(
  p_category TEXT, p_event TEXT, p_severity TEXT, p_title TEXT, p_body TEXT,
  p_entity_type TEXT, p_entity_id TEXT, p_permissions TEXT[], p_dedupe TEXT,
  p_target INTEGER DEFAULT NULL, p_actor INTEGER DEFAULT NULL, p_count INTEGER DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
  v_id BIGINT;
  v_inserted BOOLEAN;
BEGIN
  INSERT INTO admin_notifications (category, event_type, severity, title, body, entity_type, entity_id,
                                   permissions, target_admin_id, actor_admin_id, item_count, dedupe_key)
  VALUES (p_category, p_event, p_severity, left(p_title, 200), left(p_body, 500), p_entity_type, left(p_entity_id, 60),
          COALESCE(p_permissions, '{}'), p_target, p_actor, p_count, left(p_dedupe, 200))
  ON CONFLICT (dedupe_key) DO UPDATE
    SET item_count = admin_notifications.item_count + EXCLUDED.item_count,
        body = EXCLUDED.body,
        updated_at = NOW()
    WHERE EXCLUDED.item_count IS NOT NULL AND admin_notifications.item_count IS NOT NULL
  RETURNING id, (xmax = 0) INTO v_id, v_inserted;

  IF v_id IS NOT NULL THEN
    PERFORM pg_notify('admin_notification', v_id::text || CASE WHEN v_inserted THEN '' ELSE ':count' END);
  END IF;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify % failed: %', p_event, SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------
-- Orders
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_orders() RETURNS trigger AS $$
DECLARE
  v_shops TEXT;
  v_shop_count INTEGER;
  v_shopper TEXT;
  v_perm TEXT[] := ARRAY['orders.view'];
  v_id TEXT := NEW.id::text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT count(*), string_agg(shop_name, ', ' ORDER BY id) INTO v_shop_count, v_shops
    FROM order_shops WHERE order_id = NEW.id;
    PERFORM admin_notify('orders', 'order.created', 'info',
      'New order #' || v_id,
      admin_money(NEW.total_amount) || ' · ' ||
        CASE WHEN NEW.payment_method = 'cash' THEN 'Cash on delivery' ELSE 'Card' END ||
        CASE WHEN v_shop_count > 1 THEN ' · ' || v_shop_count || ' shops: ' || v_shops
             WHEN v_shop_count = 1 THEN ' · ' || v_shops ELSE '' END ||
        CASE WHEN NEW.delivery_option = 'scheduled' THEN ' · Scheduled' ELSE '' END,
      'order', v_id, v_perm, 'order.created:' || v_id);
    RETURN NULL;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;

  IF NEW.shopper_id IS NOT NULL THEN
    SELECT admin_short_name(full_name) INTO v_shopper FROM shoppers WHERE id = NEW.shopper_id;
  END IF;

  IF NEW.status = 'shopper_accepted' THEN
    PERFORM admin_notify('orders', 'order.accepted', 'info',
      'Order #' || v_id || ' accepted by ' || COALESCE(v_shopper, 'a shopper'),
      'The shopper is heading to the store.', 'order', v_id, v_perm,
      'order.accepted:' || v_id || ':' || COALESCE(NEW.shopper_id::text, '-'));

  ELSIF NEW.status = 'shopping' THEN
    PERFORM admin_notify('orders', 'order.shopping_started', 'info',
      'Shopping started for order #' || v_id,
      COALESCE(v_shopper, 'The shopper') || ' is in the store.', 'order', v_id, v_perm,
      'order.shopping:' || v_id || ':' || COALESCE(NEW.shopper_id::text, '-'));

  ELSIF NEW.status = 'out_for_delivery' THEN
    PERFORM admin_notify('orders', 'order.out_for_delivery', 'info',
      'Order #' || v_id || ' is out for delivery',
      'Shopping finished' || COALESCE(' · ' || v_shopper, '') || '.', 'order', v_id, v_perm,
      'order.delivery:' || v_id);

  ELSIF NEW.status = 'delivered' THEN
    PERFORM admin_notify('orders', 'order.delivered', 'info',
      'Order #' || v_id || ' delivered',
      admin_money(NEW.total_amount) || COALESCE(' · ' || v_shopper, ''), 'order', v_id, v_perm,
      'order.delivered:' || v_id);

  ELSIF NEW.status IN ('cancelled', 'shopper_search_cancelled') THEN
    IF NEW.failed_delivery_at IS NOT NULL THEN
      PERFORM admin_notify('orders', 'order.failed_delivery', 'critical',
        'Failed delivery on order #' || v_id,
        COALESCE(NULLIF(left(NEW.cancel_reason, 160), ''), 'The order could not be handed over.'),
        'order', v_id, v_perm, 'order.cancelled:' || v_id);
    ELSE
      PERFORM admin_notify('orders', 'order.cancelled',
        CASE WHEN OLD.status IN ('shopper_accepted', 'shopping', 'out_for_delivery', 'arrived') THEN 'warning' ELSE 'info' END,
        'Order #' || v_id || ' cancelled by ' ||
          CASE NEW.cancelled_by WHEN 'customer' THEN 'the customer' WHEN 'admin' THEN 'staff'
               WHEN 'system' THEN 'the system' ELSE COALESCE(NEW.cancelled_by, 'the customer') END,
        'Was ' || replace(OLD.status, '_', ' ') ||
          COALESCE(' · ' || NULLIF(replace(NEW.cancel_reason_code, '_', ' '), ''), ''),
        'order', v_id, v_perm, 'order.cancelled:' || v_id);
    END IF;

  ELSIF NEW.status IN ('waiting_for_shopper', 'pending_shopper_search')
        AND OLD.status IN ('shopper_accepted', 'shopping') THEN
    -- The shopper gave the order back: it needs a new shopper
    PERFORM admin_notify('orders', 'order.shopper_released', 'warning',
      'Order #' || v_id || ' needs a new shopper',
      'Was ' || replace(OLD.status, '_', ' ') || ' and returned to the shopper search.',
      'order', v_id, v_perm,
      'order.released:' || v_id || ':' || COALESCE(OLD.shopper_id::text, '-') || ':' || OLD.status);
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_orders failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_admin_notify_insert ON orders;
CREATE CONSTRAINT TRIGGER orders_admin_notify_insert
  AFTER INSERT ON orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_orders();

DROP TRIGGER IF EXISTS orders_admin_notify_update ON orders;
CREATE CONSTRAINT TRIGGER orders_admin_notify_update
  AFTER UPDATE OF status ON orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION admin_notify_orders();

-- Shopper declines are notified by the decline endpoint itself
-- (shopperAvailableOrdersController.dismissOrderOffer): the dispatch
-- loop also ends offers of shoppers who went offline, which is not a
-- decline.
DROP TRIGGER IF EXISTS shopper_order_offers_admin_notify ON shopper_order_offers;
DROP FUNCTION IF EXISTS admin_notify_offer_declined();

-- -----------------------------------------------------
-- Customers
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_customers() RETURNS trigger AS $$
BEGIN
  PERFORM admin_notify('customers', 'customer.registered', 'info',
    'New customer: ' || COALESCE(admin_short_name(NEW.full_name), 'Customer #' || NEW.id),
    'Signed up in the customer app.', 'customer', NEW.id::text, ARRAY['customers.view'],
    'customer.registered:' || NEW.id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_customers failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_admin_notify ON customers;
CREATE CONSTRAINT TRIGGER customers_admin_notify
  AFTER INSERT ON customers DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_customers();

-- -----------------------------------------------------
-- Shoppers, applications, account change requests
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_shoppers() RETURNS trigger AS $$
DECLARE
  v_name TEXT := COALESCE(admin_short_name(NEW.full_name), 'Shopper #' || NEW.id);
  v_active INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM admin_notify('shoppers', 'shopper.registered', 'info',
      'New shopper sign-up: ' || v_name,
      CASE WHEN NEW.registration_channel = 'admin' THEN 'Registered by staff.' ELSE 'Signed up in the shopper app.' END,
      'shopper', NEW.id::text, ARRAY['shoppers.view'], 'shopper.registered:' || NEW.id);
    RETURN NULL;
  END IF;

  IF NEW.approval_status IS DISTINCT FROM OLD.approval_status AND NEW.approval_status IN ('approved', 'rejected', 'suspended') THEN
    PERFORM admin_notify('shoppers', 'shopper.' || NEW.approval_status,
      CASE WHEN NEW.approval_status = 'suspended' THEN 'warning' ELSE 'info' END,
      v_name || CASE NEW.approval_status WHEN 'approved' THEN ' approved to shop'
                                         WHEN 'rejected' THEN ' rejected' ELSE ' suspended' END,
      'Shopper account ' || NEW.approval_status || '.', 'shopper', NEW.id::text, ARRAY['shoppers.view'],
      'shopper.approval:' || NEW.id || ':' || NEW.approval_status || ':' || to_char(NOW(), 'YYYYMMDDHH24MISS'));
  END IF;

  -- Going offline matters only with an order in progress
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'offline' THEN
    SELECT id INTO v_active FROM orders
    WHERE shopper_id = NEW.id AND status IN ('shopper_accepted', 'shopping', 'out_for_delivery', 'arrived')
    ORDER BY id LIMIT 1;
    IF v_active IS NOT NULL THEN
      PERFORM admin_notify('shoppers', 'shopper.offline_with_order', 'warning',
        v_name || ' went offline during order #' || v_active,
        'Check that the order is still moving.', 'order', v_active::text, ARRAY['shoppers.view', 'orders.view'],
        'shopper.offline:' || NEW.id || ':' || v_active || ':' || to_char(NOW(), 'YYYYMMDDHH24MI'));
    END IF;
  END IF;

  IF NEW.vehicle_restriction IS DISTINCT FROM OLD.vehicle_restriction AND NEW.vehicle_restriction IS NOT NULL THEN
    PERFORM admin_notify('shoppers', 'shopper.vehicle_restricted', 'warning',
      v_name || '''s vehicle was restricted',
      'Restriction: ' || replace(NEW.vehicle_restriction, '_', ' ') || '.', 'shopper', NEW.id::text, ARRAY['shoppers.view'],
      'shopper.vehicle:' || NEW.id || ':' || to_char(NOW(), 'YYYYMMDDHH24MISS'));
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_shoppers failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shoppers_admin_notify_insert ON shoppers;
CREATE CONSTRAINT TRIGGER shoppers_admin_notify_insert
  AFTER INSERT ON shoppers DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_shoppers();

DROP TRIGGER IF EXISTS shoppers_admin_notify_update ON shoppers;
CREATE CONSTRAINT TRIGGER shoppers_admin_notify_update
  AFTER UPDATE OF approval_status, status, vehicle_restriction ON shoppers DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.approval_status IS DISTINCT FROM NEW.approval_status
                     OR OLD.status IS DISTINCT FROM NEW.status
                     OR OLD.vehicle_restriction IS DISTINCT FROM NEW.vehicle_restriction)
  EXECUTE FUNCTION admin_notify_shoppers();

CREATE OR REPLACE FUNCTION admin_notify_shopper_applications() RETURNS trigger AS $$
DECLARE
  v_name TEXT := COALESCE(admin_short_name(NEW.full_name), 'Applicant #' || NEW.id);
  v_perm TEXT[] := ARRAY['shopper_applications.list', 'shoppers.manage'];
BEGIN
  IF NEW.status = 'submitted' THEN
    PERFORM admin_notify('shoppers', 'application.submitted', 'warning',
      'Shopper application to review: ' || v_name,
      CASE WHEN COALESCE(NEW.submit_count, 1) > 1 THEN 'Sent again with the requested changes.'
           ELSE 'New application waiting for verification.' END,
      'shopper_application', NEW.id::text, v_perm,
      'application.submitted:' || NEW.id || ':' || COALESCE(NEW.submit_count, 1));
  ELSIF NEW.status = 'more_info_required' THEN
    PERFORM admin_notify('shoppers', 'application.more_info', 'info',
      'More information requested from ' || v_name,
      'The application went back to the applicant.', 'shopper_application', NEW.id::text, v_perm,
      'application.more_info:' || NEW.id || ':' || COALESCE(NEW.submit_count, 1));
  ELSIF NEW.status IN ('approved', 'rejected') THEN
    PERFORM admin_notify('shoppers', 'application.' || NEW.status, 'info',
      'Shopper application ' || NEW.status || ': ' || v_name,
      COALESCE(NULLIF(left(NEW.decision_reason, 160), ''), 'Review finished.'), 'shopper_application', NEW.id::text, v_perm,
      'application.decided:' || NEW.id || ':' || NEW.status, NULL, NEW.reviewed_by);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_shopper_applications failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shopper_applications_admin_notify ON shopper_applications;
CREATE CONSTRAINT TRIGGER shopper_applications_admin_notify
  AFTER UPDATE OF status ON shopper_applications DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION admin_notify_shopper_applications();

DROP TRIGGER IF EXISTS shopper_applications_admin_notify_insert ON shopper_applications;
CREATE CONSTRAINT TRIGGER shopper_applications_admin_notify_insert
  AFTER INSERT ON shopper_applications DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'submitted')
  EXECUTE FUNCTION admin_notify_shopper_applications();

CREATE OR REPLACE FUNCTION admin_notify_shopper_changes() RETURNS trigger AS $$
DECLARE
  v_name TEXT;
BEGIN
  SELECT COALESCE(admin_short_name(full_name), 'Shopper #' || id) INTO v_name FROM shoppers WHERE id = NEW.shopper_id;
  PERFORM admin_notify('shoppers', 'shopper.change_request', 'warning',
    'Account change to review: ' || COALESCE(v_name, 'shopper'),
    initcap(replace(NEW.type, '_', ' ')) || ' request.', 'shopper', NEW.shopper_id::text, ARRAY['shoppers.manage'],
    'shopper.change:' || NEW.id || ':' || to_char(COALESCE(NEW.submitted_at, NOW()), 'YYYYMMDDHH24MISS'));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_shopper_changes failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shopper_change_requests_admin_notify ON shopper_change_requests;
CREATE CONSTRAINT TRIGGER shopper_change_requests_admin_notify
  AFTER INSERT OR UPDATE OF status ON shopper_change_requests DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'pending_review')
  EXECUTE FUNCTION admin_notify_shopper_changes();

-- -----------------------------------------------------
-- Shops
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_shops() RETURNS trigger AS $$
DECLARE
  v_perm TEXT[] := ARRAY['shops.view'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM admin_notify('shops', 'shop.registered',
      CASE WHEN NEW.status = 'pending' THEN 'warning' ELSE 'info' END,
      'New shop: ' || COALESCE(NEW.shop_name, 'shop #' || NEW.id),
      CASE WHEN NEW.status = 'pending' THEN 'Waiting for approval before customers can see it.' ELSE 'Shop added.' END ||
        COALESCE(' · ' || NEW.area, ''),
      'shop', NEW.id::text, v_perm, 'shop.registered:' || NEW.id);
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM admin_notify('shops', 'shop.' || NEW.status,
      CASE WHEN NEW.status IN ('suspended', 'pending') THEN 'warning' ELSE 'info' END,
      NEW.shop_name || CASE NEW.status WHEN 'approved' THEN ' approved'
                                       WHEN 'suspended' THEN ' deactivated (suspended)'
                                       WHEN 'rejected' THEN ' rejected'
                                       ELSE ' waiting for approval' END,
      'Status: ' || OLD.status || ' → ' || NEW.status || '.', 'shop', NEW.id::text, v_perm,
      'shop.status:' || NEW.id || ':' || NEW.status || ':' || to_char(NOW(), 'YYYYMMDDHH24MISS'));
  END IF;

  IF NEW.is_open IS DISTINCT FROM OLD.is_open THEN
    PERFORM admin_notify('shops', CASE WHEN NEW.is_open THEN 'shop.opened' ELSE 'shop.closed' END, 'info',
      NEW.shop_name || CASE WHEN NEW.is_open THEN ' is now open' ELSE ' is now closed' END,
      CASE WHEN NEW.is_open THEN 'Customers can order from this shop.' ELSE 'Customers cannot order from this shop until it opens.' END,
      'shop', NEW.id::text, v_perm,
      'shop.open:' || NEW.id || ':' || NEW.is_open || ':' || to_char(NOW(), 'YYYYMMDDHH24MI'));
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_shops failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shops_admin_notify_insert ON shops;
CREATE CONSTRAINT TRIGGER shops_admin_notify_insert
  AFTER INSERT ON shops DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_shops();

DROP TRIGGER IF EXISTS shops_admin_notify_update ON shops;
CREATE CONSTRAINT TRIGGER shops_admin_notify_update
  AFTER UPDATE OF status, is_open ON shops DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.is_open IS DISTINCT FROM NEW.is_open)
  EXECUTE FUNCTION admin_notify_shops();

-- -----------------------------------------------------
-- Products: one notification per shop per transaction (imports add
-- hundreds of rows), counted in item_count
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_products_added() RETURNS trigger AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT n.shop_id, count(*)::int AS n, s.shop_name
           FROM new_products n LEFT JOIN shops s ON s.id = n.shop_id GROUP BY n.shop_id, s.shop_name LOOP
    PERFORM admin_notify('products', 'product.added', 'info',
      'New products at ' || COALESCE(r.shop_name, 'shop #' || r.shop_id),
      '{n} new product(s) added to the catalogue.', 'shop', r.shop_id::text, ARRAY['shops.view'],
      'product.added:' || r.shop_id || ':' || txid_current(), NULL, NULL, r.n);
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_products_added failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_admin_notify_insert ON products;
CREATE TRIGGER products_admin_notify_insert
  AFTER INSERT ON products REFERENCING NEW TABLE AS new_products
  FOR EACH STATEMENT EXECUTE FUNCTION admin_notify_products_added();

CREATE OR REPLACE FUNCTION admin_notify_products_unavailable() RETURNS trigger AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT n.shop_id, count(*)::int AS n, s.shop_name, min(n.product_name) AS first_name
           FROM new_products n
           JOIN old_products o ON o.id = n.id
           LEFT JOIN shops s ON s.id = n.shop_id
           WHERE (COALESCE(o.stock_quantity, 0) > 0 AND COALESCE(n.stock_quantity, 0) = 0)
              OR (o.is_available IS TRUE AND n.is_available IS FALSE)
           GROUP BY n.shop_id, s.shop_name LOOP
    PERFORM admin_notify('products', 'product.unavailable', 'warning',
      'Out of stock at ' || COALESCE(r.shop_name, 'shop #' || r.shop_id),
      '{n} product(s) became unavailable, e.g. ' || left(r.first_name, 80) || '.', 'shop', r.shop_id::text, ARRAY['shops.view'],
      'product.unavailable:' || r.shop_id || ':' || txid_current(), NULL, NULL, r.n);
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_products_unavailable failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_admin_notify_update ON products;
CREATE TRIGGER products_admin_notify_update
  AFTER UPDATE ON products REFERENCING OLD TABLE AS old_products NEW TABLE AS new_products
  FOR EACH STATEMENT EXECUTE FUNCTION admin_notify_products_unavailable();

-- Shelf price reports from shoppers (review on the Pricing page)
CREATE OR REPLACE FUNCTION admin_notify_price_reports() RETURNS trigger AS $$
DECLARE
  v_shop TEXT;
BEGIN
  SELECT shop_name INTO v_shop FROM shops WHERE id = NEW.shop_id;
  PERFORM admin_notify('products', 'product.price_report',
    CASE WHEN NEW.admin_status = 'open' THEN 'warning' ELSE 'info' END,
    'Shelf price differs: ' || COALESCE(left(NEW.item_name, 90), 'an item'),
    admin_money(NEW.order_unit_price) || ' in the app, ' || admin_money(NEW.shelf_unit_price) || ' on the shelf' ||
      COALESCE(' at ' || v_shop, '') || ' (order #' || NEW.order_id || ').',
    'order', NEW.order_id::text, ARRAY['pricing.view'], 'product.price_report:' || NEW.id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_price_reports failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_item_price_reports_admin_notify ON order_item_price_reports;
CREATE CONSTRAINT TRIGGER order_item_price_reports_admin_notify
  AFTER INSERT ON order_item_price_reports DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_price_reports();

-- Saved product imports with rows that failed (shop portal)
CREATE OR REPLACE FUNCTION admin_notify_shop_activity() RETURNS trigger AS $$
DECLARE
  v_shop TEXT;
BEGIN
  SELECT shop_name INTO v_shop FROM shops WHERE id = NEW.shop_id;
  PERFORM admin_notify('products', 'product.import_failed', 'warning',
    'Product import problems at ' || COALESCE(v_shop, 'shop #' || NEW.shop_id),
    COALESCE(NEW.summary, 'Some rows could not be imported.'), 'shop', NEW.shop_id::text, ARRAY['shops.view'],
    'product.import_failed:' || NEW.id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_shop_activity failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shop_activity_log_admin_notify ON shop_activity_log;
CREATE CONSTRAINT TRIGGER shop_activity_log_admin_notify
  AFTER INSERT ON shop_activity_log DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.action = 'product.import_failed')
  EXECUTE FUNCTION admin_notify_shop_activity();

-- -----------------------------------------------------
-- Payments: customer card payments, refunds
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_card_payments() RETURNS trigger AS $$
DECLARE
  v_what TEXT := CASE WHEN NEW.purpose = 'order_extra' THEN 'Extra charge' ELSE 'Card payment' END;
  v_order TEXT := COALESCE(' for order #' || NEW.order_id, '');
BEGIN
  IF NEW.owner_type <> 'customer' OR NEW.purpose NOT IN ('order', 'order_extra') THEN
    RETURN NULL;
  END IF;
  IF NEW.status = 'paid' THEN
    PERFORM admin_notify('payments', 'payment.succeeded', 'info',
      v_what || ' received' || v_order, admin_money(NEW.amount) || ' · ' || NEW.ref,
      'order', NEW.order_id::text, ARRAY['finance.view'], 'payment.paid:' || NEW.id);
  ELSIF NEW.status = 'failed' THEN
    PERFORM admin_notify('payments', 'payment.failed', 'warning',
      v_what || ' failed' || v_order,
      admin_money(NEW.amount) || ' · ' || COALESCE(NULLIF(left(NEW.status_message, 140), ''), 'Declined by the gateway.'),
      'order', NEW.order_id::text, ARRAY['finance.view'], 'payment.failed:' || NEW.id);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_card_payments failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS card_payments_admin_notify ON card_payments;
CREATE CONSTRAINT TRIGGER card_payments_admin_notify
  AFTER UPDATE OF status ON card_payments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('paid', 'failed'))
  EXECUTE FUNCTION admin_notify_card_payments();

DROP TRIGGER IF EXISTS card_payments_admin_notify_insert ON card_payments;
CREATE CONSTRAINT TRIGGER card_payments_admin_notify_insert
  AFTER INSERT ON card_payments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status IN ('paid', 'failed'))
  EXECUTE FUNCTION admin_notify_card_payments();

CREATE OR REPLACE FUNCTION admin_notify_refunds() RETURNS trigger AS $$
DECLARE
  v_order INTEGER;
BEGIN
  SELECT order_id INTO v_order FROM card_payments WHERE id = NEW.card_payment_id;
  PERFORM admin_notify('payments', 'payment.refunded', 'info',
    'Refund of ' || admin_money(NEW.amount) || COALESCE(' on order #' || v_order, ''),
    COALESCE(NULLIF(left(NEW.reason, 160), ''), 'Refunded to the customer''s card.'),
    'order', v_order::text, ARRAY['finance.view'], 'payment.refund:' || NEW.id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_refunds failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS card_payment_refunds_admin_notify ON card_payment_refunds;
CREATE CONSTRAINT TRIGGER card_payment_refunds_admin_notify
  AFTER INSERT ON card_payment_refunds DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_refunds();

-- -----------------------------------------------------
-- Store bills / shopper reimbursements, supermarket payment attempts
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_store_payments() RETURNS trigger AS $$
DECLARE
  v_shop TEXT;
  v_perm TEXT[] := ARRAY['finance.view', 'finance.store_bills'];
  v_where TEXT;
BEGIN
  SELECT shop_name INTO v_shop FROM shops WHERE id = NEW.shop_id;
  v_where := COALESCE(v_shop, 'the store') || ' · order #' || NEW.order_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.funded_by = 'shopper' THEN
      PERFORM admin_notify('payments', 'reimbursement.requested', 'info',
        'Shopper paid ' || admin_money(NEW.amount_paid) || ' at ' || COALESCE(v_shop, 'the store'),
        'Reimbursement to the shopper is ' || replace(NEW.reimbursement_status, '_', ' ') || ' · order #' || NEW.order_id || '.',
        'order', NEW.order_id::text, v_perm, 'store_payment.created:' || NEW.id);
    END IF;
    IF NEW.review_status = 'needs_review' THEN
      PERFORM admin_notify('payments', 'store_bill.review', 'warning',
        'Store bill differs by ' || admin_money(abs(COALESCE(NEW.variance, 0))),
        'Expected ' || admin_money(NEW.expected_amount) || ', paid ' || admin_money(NEW.amount_paid) || ' · ' || v_where || '.',
        'order', NEW.order_id::text, v_perm, 'store_payment.review:' || NEW.id || ':' || to_char(NOW(), 'YYYYMMDDHH24MISS'));
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.review_status IS DISTINCT FROM OLD.review_status AND NEW.review_status IN ('needs_review', 'queried') THEN
    PERFORM admin_notify('payments', 'store_bill.review', 'warning',
      CASE WHEN NEW.review_status = 'queried' THEN 'Store bill queried' ELSE 'Store bill needs review' END,
      'Paid ' || admin_money(NEW.amount_paid) || ' · ' || v_where || '.',
      'order', NEW.order_id::text, v_perm,
      'store_payment.review:' || NEW.id || ':' || NEW.review_status || ':' || to_char(NOW(), 'YYYYMMDDHH24MISS'));
  END IF;

  IF NEW.reimbursement_status IS DISTINCT FROM OLD.reimbursement_status AND NEW.reimbursement_status IN ('reimbursed', 'held') THEN
    PERFORM admin_notify('payments', 'reimbursement.' || NEW.reimbursement_status,
      CASE WHEN NEW.reimbursement_status = 'held' THEN 'warning' ELSE 'info' END,
      CASE WHEN NEW.reimbursement_status = 'held' THEN 'Reimbursement on hold' ELSE 'Shopper reimbursed' END ||
        ' (' || admin_money(NEW.amount_paid) || ')',
      v_where || '.', 'order', NEW.order_id::text, v_perm,
      'store_payment.reimb:' || NEW.id || ':' || NEW.reimbursement_status || ':' || to_char(NOW(), 'YYYYMMDDHH24MISS'));
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_store_payments failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS store_payments_admin_notify_insert ON store_payments;
CREATE CONSTRAINT TRIGGER store_payments_admin_notify_insert
  AFTER INSERT ON store_payments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_store_payments();

DROP TRIGGER IF EXISTS store_payments_admin_notify_update ON store_payments;
CREATE CONSTRAINT TRIGGER store_payments_admin_notify_update
  AFTER UPDATE OF review_status, reimbursement_status ON store_payments DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.review_status IS DISTINCT FROM NEW.review_status
                     OR OLD.reimbursement_status IS DISTINCT FROM NEW.reimbursement_status)
  EXECUTE FUNCTION admin_notify_store_payments();

CREATE OR REPLACE FUNCTION admin_notify_grocery_attempts() RETURNS trigger AS $$
DECLARE
  v_shop TEXT;
  v_perm TEXT[] := ARRAY['grocery.view'];
BEGIN
  SELECT shop_name INTO v_shop FROM shops WHERE id = NEW.shop_id;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('failed', 'disputed', 'reversed') THEN
    PERFORM admin_notify('payments', 'grocery_payment.' || NEW.status,
      CASE WHEN NEW.status = 'disputed' THEN 'critical' ELSE 'warning' END,
      'Supermarket payment ' || NEW.status || ' at ' || COALESCE(v_shop, 'a shop') || ' (order #' || NEW.order_id || ')',
      replace(NEW.method, '_', ' ') || COALESCE(' · ' || admin_money(COALESCE(NEW.amount, NEW.expected_amount)), '') ||
        COALESCE(' · ' || NULLIF(left(NEW.failure_reason, 120), ''), ''),
      'order', NEW.order_id::text, v_perm, 'grocery.attempt:' || NEW.id || ':' || NEW.status);
  END IF;

  IF NEW.reconciliation_status IS DISTINCT FROM OLD.reconciliation_status AND NEW.reconciliation_status = 'mismatch' THEN
    PERFORM admin_notify('payments', 'grocery_payment.mismatch', 'warning',
      'Supermarket payment does not match the statement',
      COALESCE(v_shop, 'Shop') || ' · order #' || NEW.order_id || COALESCE(' · ' || NULLIF(left(NEW.reconciliation_note, 120), ''), ''),
      'order', NEW.order_id::text, v_perm, 'grocery.mismatch:' || NEW.id || ':' || to_char(NOW(), 'YYYYMMDDHH24MISS'));
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_grocery_attempts failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS grocery_payment_attempts_admin_notify ON grocery_payment_attempts;
CREATE CONSTRAINT TRIGGER grocery_payment_attempts_admin_notify
  AFTER UPDATE OF status, reconciliation_status ON grocery_payment_attempts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.reconciliation_status IS DISTINCT FROM NEW.reconciliation_status)
  EXECUTE FUNCTION admin_notify_grocery_attempts();

-- -----------------------------------------------------
-- Shopper withdrawals (payout requests) and recorded payouts
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_withdrawals() RETURNS trigger AS $$
DECLARE
  v_name TEXT;
  v_perm TEXT[] := ARRAY['finance.view', 'finance.withdrawals'];
BEGIN
  SELECT COALESCE(admin_short_name(full_name), 'Shopper #' || id) INTO v_name FROM shoppers WHERE id = NEW.shopper_id;

  IF TG_OP = 'INSERT' THEN
    PERFORM admin_notify('payments', 'withdrawal.requested', 'info',
      'Withdrawal request: ' || admin_money(NEW.amount),
      COALESCE(v_name, 'A shopper') || ' asked for a bank payout.', 'withdrawal', NEW.id::text, v_perm,
      'withdrawal.requested:' || NEW.id);
  ELSIF NEW.status IN ('paid', 'failed', 'rejected') THEN
    PERFORM admin_notify('payments', 'withdrawal.' || NEW.status,
      CASE WHEN NEW.status = 'failed' THEN 'critical' ELSE 'info' END,
      CASE NEW.status WHEN 'paid' THEN 'Payout completed: ' WHEN 'failed' THEN 'Payout failed: ' ELSE 'Withdrawal rejected: ' END ||
        admin_money(NEW.payout_amount),
      COALESCE(v_name, 'Shopper') || COALESCE(' · ' || NULLIF(left(NEW.reason, 140), ''), ''),
      'withdrawal', NEW.id::text, v_perm, 'withdrawal.' || NEW.status || ':' || NEW.id, NULL,
      CASE NEW.status WHEN 'paid' THEN NEW.paid_by ELSE NEW.closed_by END);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_withdrawals failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shopper_withdrawals_admin_notify_insert ON shopper_withdrawals;
CREATE CONSTRAINT TRIGGER shopper_withdrawals_admin_notify_insert
  AFTER INSERT ON shopper_withdrawals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_withdrawals();

DROP TRIGGER IF EXISTS shopper_withdrawals_admin_notify_update ON shopper_withdrawals;
CREATE CONSTRAINT TRIGGER shopper_withdrawals_admin_notify_update
  AFTER UPDATE OF status ON shopper_withdrawals DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION admin_notify_withdrawals();

-- -----------------------------------------------------
-- Super Admin approvals (refunds / earnings adjustments over the limit)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_approvals() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM admin_notify('payments', 'approval.requested', 'critical',
      'Approval needed: ' || COALESCE(left(NEW.summary, 150), replace(NEW.action_type, '.', ' ')),
      admin_money(NEW.amount) || ' · waiting for a Super Admin decision.', 'approval', NEW.id::text,
      ARRAY['approvals.decide'], 'approval.requested:' || NEW.id, NULL, NEW.requested_by);
  ELSIF NEW.status IN ('approved', 'rejected', 'failed') THEN
    -- The requester learns the outcome
    PERFORM admin_notify('payments', 'approval.' || NEW.status,
      CASE WHEN NEW.status = 'approved' THEN 'info' ELSE 'warning' END,
      'Your request was ' || CASE NEW.status WHEN 'failed' THEN 'approved but failed' ELSE NEW.status END,
      COALESCE(left(NEW.summary, 150), '') || COALESCE(' · ' || NULLIF(left(COALESCE(NEW.decision_note, NEW.result_message), 140), ''), ''),
      'approval', NEW.id::text, '{}', 'approval.decided:' || NEW.id, NEW.requested_by, NEW.decided_by);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_approvals failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_approval_requests_admin_notify_insert ON admin_approval_requests;
CREATE CONSTRAINT TRIGGER admin_approval_requests_admin_notify_insert
  AFTER INSERT ON admin_approval_requests DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_approvals();

DROP TRIGGER IF EXISTS admin_approval_requests_admin_notify_update ON admin_approval_requests;
CREATE CONSTRAINT TRIGGER admin_approval_requests_admin_notify_update
  AFTER UPDATE OF status ON admin_approval_requests DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION admin_notify_approvals();

-- -----------------------------------------------------
-- Support: complaints and other support notes on orders
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_support_notes() RETURNS trigger AS $$
BEGIN
  PERFORM admin_notify('support',
    CASE WHEN NEW.category = 'complaint' THEN 'support.complaint' ELSE 'support.note' END,
    CASE WHEN NEW.category = 'complaint' THEN 'warning' ELSE 'info' END,
    CASE WHEN NEW.category = 'complaint' THEN 'Complaint logged on order #' ELSE initcap(replace(NEW.category, '_', ' ')) || ' note on order #' END
      || NEW.order_id,
    left(NEW.note, 160), 'order', NEW.order_id::text, ARRAY['orders.view'],
    'support.note:' || NEW.id, NULL, NEW.admin_id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_support_notes failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_support_notes_admin_notify ON order_support_notes;
CREATE CONSTRAINT TRIGGER order_support_notes_admin_notify
  AFTER INSERT ON order_support_notes DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.category <> 'general')
  EXECUTE FUNCTION admin_notify_support_notes();

-- -----------------------------------------------------
-- Staff + security, read from the append-only audit log
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION admin_notify_audit() RETURNS trigger AS $$
DECLARE
  v_who TEXT := COALESCE(NEW.admin_name, 'Unknown');
  v_target TEXT;
  v_summary TEXT;
BEGIN
  -- Staff e-mail addresses in summaries are replaced by the person's name
  IF NEW.entity_type = 'admin' AND NEW.entity_id ~ '^[0-9]+$' THEN
    SELECT full_name INTO v_target FROM admins WHERE id = NEW.entity_id::int;
  END IF;
  v_summary := regexp_replace(COALESCE(NEW.summary, ''), '[^[:space:]:;,]+@[^[:space:]:;,]+', COALESCE(v_target, 'a staff member'), 'g');

  IF NEW.outcome = 'denied' THEN
    -- Grouped per person (or IP) per hour; item_count = attempts
    PERFORM admin_notify('staff', 'security.' || CASE WHEN NEW.action = 'admin.login_failed' THEN 'login_failed' ELSE 'denied' END,
      'critical',
      CASE WHEN NEW.action = 'admin.login_failed' THEN 'Failed admin sign-in attempts'
           ELSE 'Access denied: ' || v_who || ' (' || COALESCE(NEW.admin_role, 'staff') || ')' END,
      'Latest: ' || COALESCE(left(NEW.summary, 200), NEW.action),
      'audit', NEW.id::text, ARRAY['audit.view'],
      'security.' || NEW.action || ':' || COALESCE(NEW.admin_id::text, NEW.ip, '-') || ':' || to_char(NEW.created_at, 'YYYYMMDDHH24'),
      NULL, NULL, 1);
  ELSIF NEW.outcome = 'success' AND NEW.action IN ('admin.create', 'admin.role', 'admin.permissions', 'admin.activate',
                                                    'admin.deactivate', 'admin.password_reset') THEN
    PERFORM admin_notify('staff', 'staff.' || split_part(NEW.action, '.', 2),
      CASE WHEN NEW.action IN ('admin.create', 'admin.activate') THEN 'info' ELSE 'warning' END,
      CASE NEW.action WHEN 'admin.create' THEN 'New staff account'
                      WHEN 'admin.role' THEN 'Staff role changed'
                      WHEN 'admin.permissions' THEN 'Staff permissions changed'
                      WHEN 'admin.activate' THEN 'Staff account activated'
                      WHEN 'admin.deactivate' THEN 'Staff account deactivated'
                      ELSE 'Staff password reset' END,
      left(v_summary, 200) || ' · by ' || v_who, 'admin', NEW.entity_id, ARRAY['admins.manage'],
      'staff.audit:' || NEW.id);
  ELSIF NEW.outcome = 'success' AND NEW.action IN ('settings.pricing', 'security.settings', 'notifications.policy') THEN
    PERFORM admin_notify('staff', 'security.sensitive_change', 'warning',
      CASE NEW.action WHEN 'settings.pricing' THEN 'Fees & pricing changed'
                      WHEN 'security.settings' THEN 'Approval limits changed'
                      ELSE 'Notification policy changed' END,
      left(v_summary, 200) || ' · by ' || v_who, 'audit', NEW.id::text, ARRAY['audit.view'],
      'security.change:' || NEW.id);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_notify_audit failed: %', SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_audit_log_admin_notify ON admin_audit_log;
CREATE CONSTRAINT TRIGGER admin_audit_log_admin_notify
  AFTER INSERT ON admin_audit_log DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_notify_audit();

COMMIT;
