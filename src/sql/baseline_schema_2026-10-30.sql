-- =====================================================
-- BASELINE SCHEMA (security review B-38, 2026-10-30)
-- pg_dump --schema-only --no-owner --no-privileges of the development
-- database after phase 53: every table, function, trigger and index,
-- no data. About 11 core tables (orders, order_items, shops, ...) were
-- never in a migration file; this file rebuilds the whole schema on an
-- empty database:
--   createdb getme && psql -d getme -v ON_ERROR_STOP=1 -f baseline_schema_2026-10-30.sql
-- Tested: restored into a throw-away database (95 tables, 47 triggers).
-- Later migrations (phase 54+) apply on top of it.
-- Seed rows (settings tables with id = 1) come from the phase files.
-- =====================================================

--
-- PostgreSQL database dump
--

\restrict OkaGVIbMJsZG02PEjd40lHOJPIk5R4bDeNAMXI2aDqpb9WwI8KYPh6jsMx8p4y9

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: admin_audit_log_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_audit_log_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$;


--
-- Name: admin_money(numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_money(amount numeric) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT 'Rs ' || to_char(COALESCE(amount, 0), 'FM999,999,999,990.00');
$$;


--
-- Name: admin_notify(text, text, text, text, text, text, text, text[], text, integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify(p_category text, p_event text, p_severity text, p_title text, p_body text, p_entity_type text, p_entity_id text, p_permissions text[], p_dedupe text, p_target integer DEFAULT NULL::integer, p_actor integer DEFAULT NULL::integer, p_count integer DEFAULT NULL::integer) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_approvals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_approvals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM admin_notify('payments', 'approval.requested', 'critical',
      'Approval needed: ' || COALESCE(left(NEW.summary, 150), replace(NEW.action_type, '.', ' ')),
      CASE WHEN NEW.amount IS NULL THEN 'No amount' ELSE admin_money(NEW.amount) END || ' · waiting for a Super Admin decision.', 'approval', NEW.id::text,
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
$$;


--
-- Name: admin_notify_audit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_audit() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
$_$;


--
-- Name: admin_notify_card_payments(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_card_payments() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_customers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_customers() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_grocery_attempts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_grocery_attempts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_shop TEXT;
  v_perm TEXT[] := ARRAY['grocery.view'];
  v_what TEXT;
BEGIN
  SELECT shop_name INTO v_shop FROM shops WHERE id = NEW.shop_id;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('failed', 'disputed', 'reversed', 'rejected', 'unknown') THEN
    v_what := CASE NEW.status
      WHEN 'unknown' THEN 'outcome unknown (checking with the bank)'
      WHEN 'rejected' THEN 'rejected by the bank'
      ELSE NEW.status END;
    PERFORM admin_notify('payments', 'grocery_payment.' || NEW.status,
      CASE WHEN NEW.status IN ('disputed', 'unknown') THEN 'critical' ELSE 'warning' END,
      CASE WHEN NEW.provider = 'simulator' THEN 'TEST SIMULATOR: ' ELSE '' END ||
        'Supermarket payment ' || v_what || ' at ' || COALESCE(v_shop, 'a shop') || ' (order #' || NEW.order_id || ')',
      replace(NEW.method, '_', ' ') || COALESCE(' · ' || admin_money(COALESCE(NEW.amount, NEW.requested_amount, NEW.expected_amount)), '') ||
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
$$;


--
-- Name: admin_notify_orders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_orders() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_price_reports(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_price_reports() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_products_added(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_products_added() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_products_unavailable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_products_unavailable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_refunds(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_refunds() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_shop_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_shop_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_shopper_applications(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_shopper_applications() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_shopper_changes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_shopper_changes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_shoppers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_shoppers() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_shops(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_shops() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_store_payments(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_store_payments() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_support_notes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_support_notes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_notify_withdrawals(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_notify_withdrawals() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
$$;


--
-- Name: admin_short_name(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_short_name(full_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN full_name IS NULL OR btrim(full_name) = '' THEN NULL
    WHEN position(' ' IN btrim(full_name)) = 0 THEN btrim(full_name)
    ELSE split_part(btrim(full_name), ' ', 1) || ' ' ||
         upper(left(split_part(btrim(full_name), ' ', array_length(regexp_split_to_array(btrim(full_name), '\s+'), 1)), 1)) || '.'
  END;
$$;


--
-- Name: company_bank_account_defaults_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.company_bank_account_defaults_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM company_bank_accounts WHERE id = NEW.account_id AND status = 'active' AND NEW.purpose = ANY (purposes)
  ) THEN
    RAISE EXCEPTION 'the default for % must be an active account with that purpose', NEW.purpose;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: company_bank_account_events_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.company_bank_account_events_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'company_bank_account_events is append-only';
END;
$$;


--
-- Name: company_bank_account_funding_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.company_bank_account_funding_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM company_bank_accounts
    WHERE id = NEW.account_id AND status = 'active' AND currency = 'LKR' AND 'supermarket_payments' = ANY (purposes)
  ) THEN
    RAISE EXCEPTION 'the funding account must be an active LKR account for supermarket payments';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: company_bank_accounts_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.company_bank_accounts_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company bank accounts are never deleted (archive them instead)';
  END IF;

  IF NEW.account_number_encrypted IS DISTINCT FROM OLD.account_number_encrypted
     OR NEW.account_number_hash IS DISTINCT FROM OLD.account_number_hash
     OR NEW.account_last4 IS DISTINCT FROM OLD.account_last4
     OR NEW.bank_key IS DISTINCT FROM OLD.bank_key
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION 'the account number, bank and currency of a company bank account never change (add a new account)';
  END IF;

  IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    RAISE EXCEPTION 'an archived company bank account can not be used again';
  END IF;

  IF NEW.status <> 'active' AND (
       EXISTS (SELECT 1 FROM company_bank_account_defaults WHERE account_id = NEW.id)
    OR EXISTS (SELECT 1 FROM company_bank_account_funding WHERE account_id = NEW.id)
  ) THEN
    RAISE EXCEPTION 'company bank account % is a default or a funding source: change that first', NEW.id;
  END IF;

  IF EXISTS (SELECT 1 FROM company_bank_account_defaults d WHERE d.account_id = NEW.id AND NOT (d.purpose = ANY (NEW.purposes))) THEN
    RAISE EXCEPTION 'company bank account % is the default for a purpose it no longer has', NEW.id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: customer_activity_addresses(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_activity_addresses() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM customer_activity_log(NEW.customer_id, 'account', 'account.address_added',
      'Saved an address' || COALESCE(' (' || NULLIF(NEW.label, '') || ')', ''), jsonb_build_object('addressId', NEW.id));
    RETURN NULL;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM customer_activity_log(OLD.customer_id, 'account', 'account.address_removed',
      'Removed a saved address' || COALESCE(' (' || NULLIF(OLD.label, '') || ')', ''), jsonb_build_object('addressId', OLD.id));
    RETURN NULL;
  END IF;
  PERFORM customer_activity_log(NEW.customer_id, 'account', 'account.address_updated',
    'Edited a saved address' || COALESCE(' (' || NULLIF(NEW.label, '') || ')', ''), jsonb_build_object('addressId', NEW.id));
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_activity_addresses failed: %', SQLERRM;
  RETURN NULL;
END;
$$;


--
-- Name: customer_activity_card_payments(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_activity_card_payments() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_card TEXT := NULLIF(trim(COALESCE(initcap(NEW.card_brand), '') || COALESCE(' •••• ' || NEW.card_last4, '')), '');
BEGIN
  IF NEW.owner_type IS DISTINCT FROM 'customer' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NULL;
  END IF;
  -- 'pending' rows are the start of a charge; the result is the event
  IF NEW.status = 'pending' THEN
    RETURN NULL;
  END IF;
  PERFORM customer_activity_log(NEW.owner_id, 'payment', 'payment.card_' || NEW.status,
    CASE NEW.status WHEN 'paid' THEN 'Card charged' WHEN 'failed' THEN 'Card payment failed'
                    WHEN 'refunded' THEN 'Card payment refunded' WHEN 'partially_refunded' THEN 'Card payment partly refunded'
                    ELSE 'Card payment ' || NEW.status END ||
      ' · Rs ' || to_char(COALESCE(NEW.amount, 0), 'FM999,999,990.00') ||
      COALESCE(' · ' || v_card, '') || COALESCE(' · order #' || NEW.order_id, ''),
    jsonb_build_object('paymentId', NEW.id, 'purpose', NEW.purpose, 'amount', NEW.amount, 'status', NEW.status, 'card', v_card),
    NEW.order_id, 'payment.card:' || NEW.id || ':' || NEW.status);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_activity_card_payments failed: %', SQLERRM;
  RETURN NULL;
END;
$$;


--
-- Name: customer_activity_cleanup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_activity_cleanup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM customer_activity_events WHERE customer_id = OLD.id;
  RETURN OLD;
END;
$$;


--
-- Name: customer_activity_customers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_activity_customers() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_fields TEXT[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM customer_activity_log(NEW.id, 'account', 'account.registered',
      'Created a GetMe account', NULL, NULL, 'account.registered:' || NEW.id);
    RETURN NULL;
  END IF;

  IF NEW.full_name IS DISTINCT FROM OLD.full_name THEN v_fields := array_append(v_fields, 'name'); END IF;
  IF NEW.mobile IS DISTINCT FROM OLD.mobile THEN v_fields := array_append(v_fields, 'mobile'); END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN v_fields := array_append(v_fields, 'email'); END IF;
  IF cardinality(v_fields) > 0 THEN
    PERFORM customer_activity_log(NEW.id, 'account', 'account.profile_updated',
      'Profile updated: ' || array_to_string(v_fields, ', '), jsonb_build_object('fields', v_fields));
  END IF;

  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    PERFORM customer_activity_log(NEW.id, 'account', 'account.password_changed', 'Password changed', NULL);
  END IF;

  IF NEW.account_status IS DISTINCT FROM OLD.account_status THEN
    PERFORM customer_activity_log(NEW.id, 'account', 'account.status_changed',
      'Account status: ' || COALESCE(replace(OLD.account_status, '_', ' '), 'active') || ' → ' || COALESCE(replace(NEW.account_status, '_', ' '), 'active'),
      jsonb_build_object('from', OLD.account_status, 'to', NEW.account_status));
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_activity_customers failed: %', SQLERRM;
  RETURN NULL;
END;
$$;


--
-- Name: customer_activity_log(integer, text, text, text, jsonb, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_activity_log(p_customer integer, p_category text, p_type text, p_summary text, p_details jsonb, p_order integer DEFAULT NULL::integer, p_dedupe text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF p_customer IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO customer_activity_events (customer_id, category, event_type, summary, details, source, order_id, dedupe_key)
  VALUES (p_customer, p_category, p_type, left(p_summary, 300), p_details, 'database', p_order, left(p_dedupe, 200))
  ON CONFLICT (dedupe_key) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_activity_log % failed: %', p_type, SQLERRM;
END;
$$;


--
-- Name: customer_activity_no_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_activity_no_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  links TEXT[] := ARRAY['order_id', 'session_id', 'presence_id'];
  link TEXT;
  old_row JSONB := to_jsonb(OLD);
  new_row JSONB := to_jsonb(NEW);
BEGIN
  IF (new_row - links) IS DISTINCT FROM (old_row - links) THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
  END IF;
  FOREACH link IN ARRAY links LOOP
    IF (new_row -> link) IS DISTINCT FROM (old_row -> link) AND (new_row -> link) <> 'null'::jsonb THEN
      RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;


--
-- Name: customer_activity_orders(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_activity_orders() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_shops TEXT;
  v_id TEXT := NEW.id::text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT string_agg(shop_name, ', ' ORDER BY id) INTO v_shops FROM order_shops WHERE order_id = NEW.id;
    PERFORM customer_activity_log(NEW.customer_id, 'order', 'order.created',
      'Placed order #' || v_id || ' · Rs ' || to_char(COALESCE(NEW.total_amount, 0), 'FM999,999,990.00') ||
        CASE WHEN NEW.payment_method = 'cash' THEN ' · cash' ELSE ' · card' END ||
        COALESCE(' · ' || v_shops, ''),
      jsonb_build_object('status', NEW.status, 'paymentMethod', NEW.payment_method, 'total', NEW.total_amount,
                         'deliveryOption', NEW.delivery_option, 'shops', v_shops),
      NEW.id, 'order.created:' || v_id);
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('cancelled', 'shopper_search_cancelled') THEN
      PERFORM customer_activity_log(NEW.customer_id, 'order',
        CASE WHEN NEW.failed_delivery_at IS NOT NULL THEN 'order.failed_delivery' ELSE 'order.cancelled' END,
        CASE WHEN NEW.failed_delivery_at IS NOT NULL THEN 'Order #' || v_id || ': delivery failed'
             ELSE 'Order #' || v_id || ' cancelled by ' || CASE NEW.cancelled_by WHEN 'customer' THEN 'the customer' WHEN 'admin' THEN 'GetMe staff'
                    WHEN 'system' THEN 'the system' WHEN 'shopper' THEN 'the shopper' ELSE COALESCE(NEW.cancelled_by, 'the customer') END END,
        jsonb_build_object('from', OLD.status, 'to', NEW.status, 'cancelledBy', NEW.cancelled_by, 'reasonCode', NEW.cancel_reason_code),
        NEW.id, 'order.cancelled:' || v_id);
    ELSE
      PERFORM customer_activity_log(NEW.customer_id, 'order', 'order.status_changed',
        'Order #' || v_id || ': ' || replace(COALESCE(OLD.status, '-'), '_', ' ') || ' → ' || replace(NEW.status, '_', ' '),
        jsonb_build_object('from', OLD.status, 'to', NEW.status), NEW.id);
    END IF;
  END IF;

  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    PERFORM customer_activity_log(NEW.customer_id, 'payment', 'payment.status_changed',
      'Order #' || v_id || ' payment: ' || replace(COALESCE(OLD.payment_status, 'none'), '_', ' ') || ' → ' || replace(COALESCE(NEW.payment_status, 'none'), '_', ' '),
      jsonb_build_object('from', OLD.payment_status, 'to', NEW.payment_status, 'paymentMethod', NEW.payment_method), NEW.id);
  END IF;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_activity_orders failed: %', SQLERRM;
  RETURN NULL;
END;
$$;


--
-- Name: customer_activity_refunds(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_activity_refunds() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_payment card_payments%ROWTYPE;
BEGIN
  SELECT * INTO v_payment FROM card_payments WHERE id = NEW.card_payment_id;
  IF v_payment.owner_type IS DISTINCT FROM 'customer' THEN
    RETURN NULL;
  END IF;
  PERFORM customer_activity_log(v_payment.owner_id, 'payment', 'payment.refund',
    'Refund Rs ' || to_char(COALESCE(NEW.amount, 0), 'FM999,999,990.00') || ' to card' ||
      COALESCE(' · order #' || v_payment.order_id, ''),
    jsonb_build_object('refundId', NEW.id, 'paymentId', v_payment.id, 'amount', NEW.amount),
    v_payment.order_id, 'payment.refund:' || NEW.id);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_activity_refunds failed: %', SQLERRM;
  RETURN NULL;
END;
$$;


--
-- Name: customer_activity_support_cases(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_activity_support_cases() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM customer_activity_log(NEW.customer_id, 'support', 'support.case_opened',
      'Reported a problem (' || replace(COALESCE(NEW.category, 'other'), '_', ' ') || ')' || COALESCE(' on order #' || NEW.order_id, ''),
      jsonb_build_object('caseId', NEW.id, 'category', NEW.category), NEW.order_id, 'support.opened:' || NEW.id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM customer_activity_log(NEW.customer_id, 'support', 'support.case_status',
      'Support case #' || NEW.id || ': ' || replace(COALESCE(OLD.status, '-'), '_', ' ') || ' → ' || replace(NEW.status, '_', ' ') ||
        COALESCE(' (' || replace(NEW.resolution_type, '_', ' ') || ')', ''),
      jsonb_build_object('caseId', NEW.id, 'from', OLD.status, 'to', NEW.status, 'resolution', NEW.resolution_type), NEW.order_id);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_activity_support_cases failed: %', SQLERRM;
  RETURN NULL;
END;
$$;


--
-- Name: customer_credit_entries_no_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.customer_credit_entries_no_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'customer_credit_entries is append-only';
END;
$$;


--
-- Name: keep_shopper_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.keep_shopper_code() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.shopper_code IS DISTINCT FROM OLD.shopper_code THEN
    RAISE EXCEPTION 'Shopper ID % can not be changed', OLD.shopper_code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: next_shopper_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_shopper_code() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  n BIGINT := nextval('shopper_code_seq');
BEGIN
  -- 6 digits, growing past 999999 instead of wrapping
  RETURN 'GET-SHP-' || CASE WHEN n < 1000000 THEN lpad(n::text, 6, '0') ELSE n::text END;
END;
$$;


--
-- Name: order_support_notes_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.order_support_notes_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'order_support_notes are append-only';
END;
$$;


--
-- Name: shoppers_set_approved_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.shoppers_set_approved_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.approval_status = 'approved' AND NEW.approved_at IS NULL THEN
    NEW.approved_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: support_case_events_no_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.support_case_events_no_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'support_case_events is append-only';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_approval_requests (
    id integer NOT NULL,
    action_type character varying(40) NOT NULL,
    entity_type character varying(40),
    entity_id character varying(40),
    amount numeric(12,2),
    summary character varying(300),
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status character varying(10) DEFAULT 'pending'::character varying NOT NULL,
    requested_by integer NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by integer,
    decided_at timestamp with time zone,
    decision_note character varying(300),
    result_status integer,
    result_message character varying(300),
    CONSTRAINT admin_approval_not_self CHECK (((decided_by IS NULL) OR (decided_by <> requested_by))),
    CONSTRAINT admin_approval_requests_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'cancelled'::character varying, 'failed'::character varying])::text[])))
);


--
-- Name: admin_approval_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_approval_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_approval_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_approval_requests_id_seq OWNED BY public.admin_approval_requests.id;


--
-- Name: admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_log (
    id bigint NOT NULL,
    admin_id integer,
    admin_name character varying(120),
    admin_role character varying(20),
    action character varying(80) NOT NULL,
    entity_type character varying(30),
    entity_id character varying(40),
    summary character varying(300),
    details jsonb,
    ip character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    outcome character varying(10) DEFAULT 'success'::character varying NOT NULL,
    before_value jsonb,
    after_value jsonb
);


--
-- Name: admin_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_audit_log_id_seq OWNED BY public.admin_audit_log.id;


--
-- Name: admin_notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notification_preferences (
    admin_id integer NOT NULL,
    muted_categories text[] DEFAULT '{}'::text[] NOT NULL,
    important_only_categories text[] DEFAULT '{}'::text[] CONSTRAINT admin_notification_preferenc_important_only_categories_not_null NOT NULL,
    popups character varying(10) DEFAULT 'important'::character varying NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_notification_preferences_popups_check CHECK (((popups)::text = ANY ((ARRAY['all'::character varying, 'important'::character varying, 'off'::character varying])::text[])))
);


--
-- Name: admin_notification_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notification_settings (
    id smallint DEFAULT 1 NOT NULL,
    retention_days integer DEFAULT 90 NOT NULL,
    role_categories jsonb NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_notification_settings_id_check CHECK ((id = 1)),
    CONSTRAINT admin_notification_settings_retention_days_check CHECK (((retention_days >= 7) AND (retention_days <= 730)))
);


--
-- Name: admin_notification_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notification_states (
    admin_id integer NOT NULL,
    notification_id bigint NOT NULL,
    read_at timestamp with time zone,
    dismissed_at timestamp with time zone
);


--
-- Name: admin_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notifications (
    id bigint NOT NULL,
    category character varying(20) NOT NULL,
    event_type character varying(60) NOT NULL,
    severity character varying(10) DEFAULT 'info'::character varying NOT NULL,
    title character varying(200) NOT NULL,
    body character varying(500),
    entity_type character varying(40),
    entity_id character varying(60),
    permissions text[] DEFAULT '{}'::text[] NOT NULL,
    target_admin_id integer,
    actor_admin_id integer,
    item_count integer,
    dedupe_key character varying(200) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_notifications_category_check CHECK (((category)::text = ANY ((ARRAY['orders'::character varying, 'customers'::character varying, 'shoppers'::character varying, 'shops'::character varying, 'products'::character varying, 'payments'::character varying, 'support'::character varying, 'staff'::character varying, 'system'::character varying])::text[]))),
    CONSTRAINT admin_notifications_check CHECK (((cardinality(permissions) > 0) OR (target_admin_id IS NOT NULL))),
    CONSTRAINT admin_notifications_severity_check CHECK (((severity)::text = ANY ((ARRAY['info'::character varying, 'warning'::character varying, 'critical'::character varying])::text[])))
);


--
-- Name: admin_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admin_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_notifications_id_seq OWNED BY public.admin_notifications.id;


--
-- Name: admin_security_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_security_settings (
    id smallint DEFAULT 1 NOT NULL,
    refund_approval_limit numeric(12,2) DEFAULT 10000 NOT NULL,
    earnings_adjust_approval_limit numeric(12,2) DEFAULT 2000 NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    mfa_required boolean DEFAULT true NOT NULL,
    CONSTRAINT admin_security_settings_earnings_adjust_approval_limit_check CHECK ((earnings_adjust_approval_limit >= (0)::numeric)),
    CONSTRAINT admin_security_settings_id_check CHECK ((id = 1)),
    CONSTRAINT admin_security_settings_refund_approval_limit_check CHECK ((refund_approval_limit >= (0)::numeric))
);


--
-- Name: admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admins (
    id integer NOT NULL,
    full_name character varying(100) NOT NULL,
    email character varying(150) NOT NULL,
    password_hash text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    role character varying(20) DEFAULT 'owner'::character varying NOT NULL,
    permission_grants text[] DEFAULT '{}'::text[] NOT NULL,
    permission_revokes text[] DEFAULT '{}'::text[] NOT NULL,
    auth_version integer DEFAULT 0 NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    created_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deactivated_at timestamp with time zone,
    password_changed_at timestamp with time zone,
    mfa_secret_enc text,
    mfa_pending_secret_enc text,
    mfa_enabled boolean DEFAULT false NOT NULL,
    mfa_enabled_at timestamp with time zone,
    mfa_last_step bigint,
    mfa_failed_attempts integer DEFAULT 0 NOT NULL,
    mfa_locked_until timestamp with time zone,
    CONSTRAINT admins_role_check CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'operations'::character varying, 'finance'::character varying, 'support'::character varying, 'developer'::character varying])::text[])))
);


--
-- Name: admins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admins_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: admins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admins_id_seq OWNED BY public.admins.id;


--
-- Name: card_payment_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_payment_refunds (
    id integer NOT NULL,
    card_payment_id integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    reason text,
    gateway_refund_id character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT card_payment_refunds_amount_check CHECK ((amount > (0)::numeric))
);


--
-- Name: card_payment_refunds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.card_payment_refunds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: card_payment_refunds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.card_payment_refunds_id_seq OWNED BY public.card_payment_refunds.id;


--
-- Name: card_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_payments (
    id integer NOT NULL,
    ref character varying(64) NOT NULL,
    owner_type character varying(20) NOT NULL,
    owner_id integer NOT NULL,
    purpose character varying(20) NOT NULL,
    order_id integer,
    shop_id integer,
    saved_card_id integer,
    gateway character varying(20) NOT NULL,
    amount numeric(12,2) NOT NULL,
    currency character varying(3) DEFAULT 'LKR'::character varying NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    gateway_payment_id character varying(64),
    status_message text,
    refunded_amount numeric(12,2) DEFAULT 0 NOT NULL,
    card_brand character varying(20),
    card_last4 character varying(4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    abandoned_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    gateway_fee numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT card_payments_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT card_payments_owner_type_check CHECK (((owner_type)::text = ANY ((ARRAY['customer'::character varying, 'shopper'::character varying])::text[]))),
    CONSTRAINT card_payments_purpose_check CHECK (((purpose)::text = ANY ((ARRAY['order'::character varying, 'order_extra'::character varying, 'store_bill'::character varying])::text[]))),
    CONSTRAINT card_payments_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'paid'::character varying, 'failed'::character varying, 'refunded'::character varying, 'partially_refunded'::character varying])::text[])))
);


--
-- Name: card_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.card_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: card_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.card_payments_id_seq OWNED BY public.card_payments.id;


--
-- Name: card_setups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.card_setups (
    id integer NOT NULL,
    ref character varying(64) NOT NULL,
    owner_type character varying(20) NOT NULL,
    owner_id integer NOT NULL,
    gateway character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    saved_card_id integer,
    status_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT card_setups_owner_type_check CHECK (((owner_type)::text = ANY ((ARRAY['customer'::character varying, 'shopper'::character varying])::text[]))),
    CONSTRAINT card_setups_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'saved'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: card_setups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.card_setups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: card_setups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.card_setups_id_seq OWNED BY public.card_setups.id;


--
-- Name: cash_settlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cash_settlements (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    cash_due numeric(12,2) NOT NULL,
    handed_over numeric(12,2) NOT NULL,
    offset_earnings numeric(12,2) DEFAULT 0 NOT NULL,
    offset_reimbursement numeric(12,2) DEFAULT 0 NOT NULL,
    reference character varying(60),
    note character varying(300),
    client_request_id character varying(64),
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cash_settlements_cash_due_check CHECK ((cash_due > (0)::numeric)),
    CONSTRAINT cash_settlements_handed_over_check CHECK ((handed_over >= (0)::numeric)),
    CONSTRAINT cash_settlements_offset_earnings_check CHECK ((offset_earnings >= (0)::numeric)),
    CONSTRAINT cash_settlements_offset_reimbursement_check CHECK ((offset_reimbursement >= (0)::numeric)),
    CONSTRAINT cash_settlements_parts_check CHECK ((((handed_over + offset_earnings) + offset_reimbursement) = cash_due))
);


--
-- Name: cash_settlements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cash_settlements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cash_settlements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cash_settlements_id_seq OWNED BY public.cash_settlements.id;


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id integer NOT NULL,
    order_id integer NOT NULL,
    sender_type character varying(20) NOT NULL,
    sender_id integer NOT NULL,
    message text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    event_type character varying(40),
    event_data jsonb
);


--
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_messages_id_seq OWNED BY public.chat_messages.id;


--
-- Name: chat_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_reads (
    order_id integer NOT NULL,
    reader_type character varying(20) NOT NULL,
    reader_id integer NOT NULL,
    last_read_message_id integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chat_reads_reader_type_check CHECK (((reader_type)::text = ANY ((ARRAY['customer'::character varying, 'shopper'::character varying])::text[])))
);


--
-- Name: company_bank_account_defaults; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_bank_account_defaults (
    purpose character varying(30) NOT NULL,
    account_id integer NOT NULL,
    set_by integer,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_bank_account_defaults_purpose_check CHECK (((purpose)::text = ANY ((ARRAY['supermarket_payments'::character varying, 'customer_settlements'::character varying, 'shopper_payouts'::character varying, 'gateway_settlements'::character varying, 'operational_expenses'::character varying])::text[])))
);


--
-- Name: company_bank_account_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_bank_account_events (
    id integer NOT NULL,
    account_id integer,
    action character varying(40) NOT NULL,
    actor_admin_id integer,
    actor_name character varying(120),
    actor_role character varying(20),
    approval_request_id integer,
    approved_by integer,
    before_value jsonb,
    after_value jsonb,
    reason character varying(300),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: company_bank_account_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.company_bank_account_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: company_bank_account_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.company_bank_account_events_id_seq OWNED BY public.company_bank_account_events.id;


--
-- Name: company_bank_account_funding; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_bank_account_funding (
    method_key character varying(30) NOT NULL,
    account_id integer NOT NULL,
    set_by integer,
    set_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: company_bank_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_bank_accounts (
    id integer NOT NULL,
    nickname character varying(60) NOT NULL,
    bank_key character varying(40) NOT NULL,
    bank_name character varying(80) NOT NULL,
    account_holder_name character varying(120) NOT NULL,
    account_number_encrypted text NOT NULL,
    account_last4 character varying(4) NOT NULL,
    account_number_hash character(64) NOT NULL,
    branch_name character varying(80),
    branch_code character varying(12),
    country character(2) DEFAULT 'LK'::bpchar NOT NULL,
    currency character(3) DEFAULT 'LKR'::bpchar NOT NULL,
    purposes text[] DEFAULT '{}'::text[] NOT NULL,
    status character varying(10) DEFAULT 'inactive'::character varying NOT NULL,
    integration_provider character varying(20),
    integration_reference character varying(80),
    authorization_status character varying(10) DEFAULT 'none'::character varying NOT NULL,
    authorization_reference character varying(80),
    authorization_date date,
    authorization_recorded_by integer,
    authorization_recorded_at timestamp with time zone,
    approval_status character varying(20) DEFAULT 'none'::character varying NOT NULL,
    approval_note character varying(300),
    approved_by integer,
    approved_at timestamp with time zone,
    activated_by integer,
    activated_at timestamp with time zone,
    deactivated_by integer,
    deactivated_at timestamp with time zone,
    archived_by integer,
    archived_at timestamp with time zone,
    created_by integer,
    updated_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_bank_accounts_account_last4_check CHECK (((account_last4)::text ~ '^[0-9A-Z]{4}$'::text)),
    CONSTRAINT company_bank_accounts_approval_status_check CHECK (((approval_status)::text = ANY ((ARRAY['none'::character varying, 'test_approved'::character varying, 'production_approved'::character varying])::text[]))),
    CONSTRAINT company_bank_accounts_authorization_status_check CHECK (((authorization_status)::text = ANY ((ARRAY['none'::character varying, 'requested'::character varying, 'confirmed'::character varying])::text[]))),
    CONSTRAINT company_bank_accounts_check CHECK ((NOT (((integration_provider)::text = 'simulator'::text) AND ((approval_status)::text = 'production_approved'::text)))),
    CONSTRAINT company_bank_accounts_check1 CHECK ((((approval_status)::text = 'none'::text) OR (integration_provider IS NOT NULL))),
    CONSTRAINT company_bank_accounts_country_check CHECK ((country ~ '^[A-Z]{2}$'::text)),
    CONSTRAINT company_bank_accounts_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT company_bank_accounts_purposes_check CHECK ((purposes <@ ARRAY['supermarket_payments'::text, 'customer_settlements'::text, 'shopper_payouts'::text, 'gateway_settlements'::text, 'operational_expenses'::text])),
    CONSTRAINT company_bank_accounts_status_check CHECK (((status)::text = ANY ((ARRAY['inactive'::character varying, 'active'::character varying, 'archived'::character varying])::text[])))
);


--
-- Name: company_bank_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.company_bank_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: company_bank_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.company_bank_accounts_id_seq OWNED BY public.company_bank_accounts.id;


--
-- Name: customer_activity_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_activity_events (
    id bigint NOT NULL,
    customer_id integer NOT NULL,
    category character varying(12) NOT NULL,
    event_type character varying(60) NOT NULL,
    summary character varying(300) NOT NULL,
    details jsonb,
    source character varying(10) NOT NULL,
    order_id integer,
    session_id bigint,
    presence_id bigint,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    dedupe_key character varying(200),
    CONSTRAINT customer_activity_events_category_check CHECK (((category)::text = ANY ((ARRAY['account'::character varying, 'session'::character varying, 'location'::character varying, 'browsing'::character varying, 'cart'::character varying, 'order'::character varying, 'payment'::character varying, 'support'::character varying])::text[]))),
    CONSTRAINT customer_activity_events_source_check CHECK (((source)::text = ANY ((ARRAY['server'::character varying, 'app'::character varying, 'database'::character varying])::text[])))
);


--
-- Name: customer_activity_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_activity_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_activity_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_activity_events_id_seq OWNED BY public.customer_activity_events.id;


--
-- Name: customer_activity_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_activity_settings (
    id smallint DEFAULT 1 NOT NULL,
    location_retention_days integer DEFAULT 90 NOT NULL,
    session_retention_days integer DEFAULT 365 NOT NULL,
    event_retention_days integer DEFAULT 365 NOT NULL,
    location_collection_enabled boolean DEFAULT true NOT NULL,
    consent_version character varying(20) DEFAULT '2026-10-30'::character varying NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_activity_settings_event_retention_days_check CHECK (((event_retention_days >= 30) AND (event_retention_days <= 1095))),
    CONSTRAINT customer_activity_settings_id_check CHECK ((id = 1)),
    CONSTRAINT customer_activity_settings_location_retention_days_check CHECK (((location_retention_days >= 7) AND (location_retention_days <= 730))),
    CONSTRAINT customer_activity_settings_session_retention_days_check CHECK (((session_retention_days >= 30) AND (session_retention_days <= 1095)))
);


--
-- Name: customer_activity_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_activity_state (
    customer_id integer NOT NULL,
    location_consent boolean DEFAULT false NOT NULL,
    consent_version character varying(20),
    consent_changed_at timestamp with time zone,
    location_permission character varying(15),
    permission_precise boolean,
    permission_changed_at timestamp with time zone,
    last_latitude double precision,
    last_longitude double precision,
    last_accuracy_m real,
    last_location_at timestamp with time zone,
    last_location_source character varying(20),
    last_activity_at timestamp with time zone,
    last_login_at timestamp with time zone,
    last_logout_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_activity_state_location_permission_check CHECK (((location_permission)::text = ANY ((ARRAY['granted'::character varying, 'denied'::character varying, 'undetermined'::character varying, 'restricted'::character varying])::text[])))
);


--
-- Name: customer_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_addresses (
    id integer NOT NULL,
    customer_id integer NOT NULL,
    label character varying(50) DEFAULT 'Other'::character varying NOT NULL,
    address text NOT NULL,
    unit character varying(100),
    building character varying(150),
    instructions text,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    place_id character varying(255),
    last_used_at timestamp without time zone DEFAULT now() NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: customer_addresses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_addresses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_addresses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_addresses_id_seq OWNED BY public.customer_addresses.id;


--
-- Name: customer_controls_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_controls_settings (
    id smallint DEFAULT 1 NOT NULL,
    default_cod_limit numeric(12,2),
    credit_approval_limit numeric(12,2) DEFAULT 5000 NOT NULL,
    support_report_window_hours integer DEFAULT 48 NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_controls_settings_credit_approval_limit_check CHECK ((credit_approval_limit >= (0)::numeric)),
    CONSTRAINT customer_controls_settings_default_cod_limit_check CHECK (((default_cod_limit IS NULL) OR (default_cod_limit >= (0)::numeric))),
    CONSTRAINT customer_controls_settings_id_check CHECK ((id = 1)),
    CONSTRAINT customer_controls_settings_support_report_window_hours_check CHECK (((support_report_window_hours >= 1) AND (support_report_window_hours <= 720)))
);


--
-- Name: customer_credit_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_credit_entries (
    id bigint NOT NULL,
    customer_id integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    kind character varying(12) NOT NULL,
    reason character varying(300),
    order_id integer,
    support_case_id bigint,
    admin_id integer,
    client_request_id character varying(80),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_credit_entries_amount_check CHECK ((amount <> (0)::numeric)),
    CONSTRAINT customer_credit_entries_kind_check CHECK (((kind)::text = ANY ((ARRAY['issued'::character varying, 'spent'::character varying, 'reversed'::character varying, 'adjusted'::character varying])::text[])))
);


--
-- Name: customer_credit_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_credit_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_credit_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_credit_entries_id_seq OWNED BY public.customer_credit_entries.id;


--
-- Name: customer_location_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_location_points (
    id bigint NOT NULL,
    customer_id integer NOT NULL,
    tracking_session_id bigint NOT NULL,
    order_id integer,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    accuracy_m real,
    speed_mps real,
    heading real,
    recorded_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    source character varying(20) NOT NULL,
    client_point_id character varying(64) NOT NULL,
    CONSTRAINT customer_location_points_accuracy_m_check CHECK (((accuracy_m IS NULL) OR (accuracy_m >= (0)::double precision))),
    CONSTRAINT customer_location_points_latitude_check CHECK (((latitude >= ('-90'::integer)::double precision) AND (latitude <= (90)::double precision))),
    CONSTRAINT customer_location_points_longitude_check CHECK (((longitude >= ('-180'::integer)::double precision) AND (longitude <= (180)::double precision))),
    CONSTRAINT customer_location_points_source_check CHECK (((source)::text = ANY ((ARRAY['app_in_use'::character varying, 'active_order'::character varying])::text[])))
);


--
-- Name: customer_location_points_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_location_points_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_location_points_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_location_points_id_seq OWNED BY public.customer_location_points.id;


--
-- Name: customer_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_presence (
    id bigint NOT NULL,
    customer_id integer NOT NULL,
    session_id bigint,
    install_id character varying(64),
    app_session_id character varying(64),
    visit_id character varying(64) NOT NULL,
    platform character varying(10),
    app_version character varying(30),
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    state character varying(12) DEFAULT 'online'::character varying NOT NULL,
    state_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    end_reason character varying(20),
    reconnect_count integer DEFAULT 0 NOT NULL,
    interrupted_seconds integer DEFAULT 0 NOT NULL,
    socket_id character varying(40),
    CONSTRAINT customer_presence_check CHECK ((((state)::text = 'ended'::text) = (ended_at IS NOT NULL))),
    CONSTRAINT customer_presence_end_reason_check CHECK (((end_reason)::text = ANY ((ARRAY['background'::character varying, 'logout'::character varying, 'connection_lost'::character varying, 'app_restarted'::character varying, 'session_expired'::character varying, 'blocked'::character varying, 'server_restart'::character varying, 'heartbeat_lost'::character varying])::text[]))),
    CONSTRAINT customer_presence_state_check CHECK (((state)::text = ANY ((ARRAY['online'::character varying, 'disconnected'::character varying, 'ended'::character varying])::text[])))
);


--
-- Name: customer_presence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_presence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_presence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_presence_id_seq OWNED BY public.customer_presence.id;


--
-- Name: customer_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_sessions (
    id bigint NOT NULL,
    customer_id integer NOT NULL,
    login_method character varying(10) NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    end_reason character varying(12),
    ip character varying(64),
    user_agent character varying(200),
    CONSTRAINT customer_sessions_check CHECK (((ended_at IS NULL) = (end_reason IS NULL))),
    CONSTRAINT customer_sessions_end_reason_check CHECK (((end_reason)::text = ANY ((ARRAY['logout'::character varying, 'expired'::character varying, 'blocked'::character varying])::text[]))),
    CONSTRAINT customer_sessions_login_method_check CHECK (((login_method)::text = ANY ((ARRAY['email'::character varying, 'mobile'::character varying, 'register'::character varying])::text[])))
);


--
-- Name: customer_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_sessions_id_seq OWNED BY public.customer_sessions.id;


--
-- Name: customer_tracking_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_tracking_sessions (
    id bigint NOT NULL,
    customer_id integer NOT NULL,
    client_tracking_id character varying(64) NOT NULL,
    presence_id bigint,
    session_id bigint,
    order_id integer,
    purpose character varying(20) NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    end_reason character varying(20),
    start_latitude double precision,
    start_longitude double precision,
    end_latitude double precision,
    end_longitude double precision,
    destination_latitude double precision,
    destination_longitude double precision,
    point_count integer DEFAULT 0 NOT NULL,
    distance_m numeric(12,1) DEFAULT 0 NOT NULL,
    first_point_at timestamp with time zone,
    last_point_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_tracking_sessions_end_reason_check CHECK (((end_reason)::text = ANY ((ARRAY['stopped'::character varying, 'background'::character varying, 'logout'::character varying, 'permission_revoked'::character varying, 'consent_withdrawn'::character varying, 'stale'::character varying, 'order_finished'::character varying, 'collection_disabled'::character varying])::text[]))),
    CONSTRAINT customer_tracking_sessions_purpose_check CHECK (((purpose)::text = ANY ((ARRAY['app_in_use'::character varying, 'active_order'::character varying])::text[])))
);


--
-- Name: customer_tracking_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customer_tracking_sessions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customer_tracking_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customer_tracking_sessions_id_seq OWNED BY public.customer_tracking_sessions.id;


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id integer NOT NULL,
    full_name character varying(150) NOT NULL,
    mobile character varying(20) NOT NULL,
    email character varying(150) NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    account_status character varying(12) DEFAULT 'active'::character varying NOT NULL,
    status_reason character varying(300),
    status_changed_at timestamp with time zone,
    status_changed_by integer,
    cod_limit numeric(12,2),
    CONSTRAINT customers_account_status_check CHECK (((account_status)::text = ANY ((ARRAY['active'::character varying, 'restricted'::character varying, 'blocked'::character varying])::text[]))),
    CONSTRAINT customers_cod_limit_check CHECK (((cod_limit IS NULL) OR (cod_limit >= (0)::numeric)))
);


--
-- Name: customers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.customers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: customers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.customers_id_seq OWNED BY public.customers.id;


--
-- Name: dispatch_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispatch_settings (
    id smallint DEFAULT 1 NOT NULL,
    shopper_cash_limit numeric(12,2) DEFAULT 15000 NOT NULL,
    exclusive_offer_minutes integer DEFAULT 3 NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dispatch_settings_exclusive_offer_minutes_check CHECK (((exclusive_offer_minutes >= 1) AND (exclusive_offer_minutes <= 30))),
    CONSTRAINT dispatch_settings_id_check CHECK ((id = 1)),
    CONSTRAINT dispatch_settings_shopper_cash_limit_check CHECK ((shopper_cash_limit >= (0)::numeric))
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id integer NOT NULL,
    customer_id integer NOT NULL,
    shop_id integer NOT NULL,
    delivery_address text NOT NULL,
    delivery_latitude double precision NOT NULL,
    delivery_longitude double precision NOT NULL,
    delivery_option character varying(30) DEFAULT 'fast'::character varying NOT NULL,
    payment_method character varying(50) DEFAULT 'cash'::character varying NOT NULL,
    items_total numeric(12,2) DEFAULT 0 NOT NULL,
    delivery_fee numeric(12,2) DEFAULT 0 NOT NULL,
    service_fee numeric(12,2) DEFAULT 0 NOT NULL,
    total_amount numeric(12,2) DEFAULT 0 NOT NULL,
    status character varying(30) DEFAULT 'waiting_for_shopper'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    shopper_id integer,
    payment_id character varying(100),
    payment_status character varying(30),
    paid_at timestamp without time zone,
    bill_url text,
    bill_uploaded_at timestamp without time zone,
    delivery_pin character varying(6),
    arrival_confirmed_at timestamp without time zone,
    delivered_at timestamp without time zone,
    distance_km numeric(10,2),
    fast_delivery_fee numeric DEFAULT 0 NOT NULL,
    scheduled_date date,
    scheduled_start_time character varying(20),
    scheduled_end_time character varying(20),
    estimated_delivery_minutes integer,
    estimated_delivery_max_minutes integer,
    actual_items_total numeric(12,2),
    reimbursement_status character varying(30) DEFAULT 'not_due'::character varying NOT NULL,
    reimbursement_amount numeric(12,2),
    reimbursed_at timestamp without time zone,
    bill_verified_at timestamp without time zone,
    shopper_search_started_at timestamp without time zone,
    cancelled_by character varying(20),
    cancel_reason text,
    tip_amount numeric(10,2) DEFAULT 0 NOT NULL,
    promo_code character varying(40),
    discount_amount numeric(10,2) DEFAULT 0 NOT NULL,
    preferred_vehicle_type character varying(30),
    shopping_started_at timestamp without time zone,
    delivery_dropoff character varying(20),
    delivery_instructions text,
    contact_phone character varying(20),
    window_discount numeric(10,2) DEFAULT 0 NOT NULL,
    vehicle_fees jsonb,
    offer_savings numeric(10,2) DEFAULT 0 NOT NULL,
    delivery_photo_url text,
    delivery_photo_at timestamp with time zone,
    payment_card_id integer,
    getme_fee numeric(12,2) DEFAULT 0 NOT NULL,
    getme_fee_percent numeric(5,2) DEFAULT 15 NOT NULL,
    service_fee_per_unit numeric(12,2) DEFAULT 50 NOT NULL,
    getme_fee_kept numeric(12,2),
    failed_delivery_at timestamp with time zone,
    accepted_at timestamp with time zone,
    out_for_delivery_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancelled_from_status character varying(40),
    cancel_reason_code character varying(40),
    client_request_id character varying(64),
    delivery_pricing jsonb,
    credit_applied numeric(12,2) DEFAULT 0 NOT NULL,
    dispatch_paused_until timestamp with time zone,
    dispatch_exclusive_shopper_id integer,
    delivery_pin_failed_attempts integer DEFAULT 0 NOT NULL,
    delivery_pin_locked_until timestamp with time zone,
    CONSTRAINT orders_credit_applied_check CHECK ((credit_applied >= (0)::numeric))
);


--
-- Name: shopper_earnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_earnings (
    id integer NOT NULL,
    order_id integer NOT NULL,
    shopper_id integer NOT NULL,
    delivery_pay numeric(12,2) NOT NULL,
    commission_percent numeric(5,2) NOT NULL,
    commission numeric(12,2) NOT NULL,
    tip numeric(12,2) DEFAULT 0 NOT NULL,
    net_amount numeric(12,2) NOT NULL,
    status character varying(20) DEFAULT 'payable'::character varying NOT NULL,
    dispute_note text,
    payout_id integer,
    cash_collected numeric(12,2) DEFAULT 0 NOT NULL,
    cash_status character varying(20) DEFAULT 'none'::character varying NOT NULL,
    cash_payout_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    service_fee numeric(12,2) DEFAULT 0 NOT NULL,
    delivery_fee numeric(12,2) DEFAULT 0 NOT NULL,
    priority_fee numeric(12,2) DEFAULT 0 NOT NULL,
    adjustment numeric(12,2) DEFAULT 0 NOT NULL,
    adjustment_note text,
    cash_withdrawal_id integer,
    cash_settlement_id integer,
    CONSTRAINT shopper_earnings_cash_status_check CHECK (((cash_status)::text = ANY ((ARRAY['none'::character varying, 'due'::character varying, 'deposited'::character varying, 'netted'::character varying])::text[]))),
    CONSTRAINT shopper_earnings_status_check CHECK (((status)::text = ANY ((ARRAY['awaiting_bills'::character varying, 'payable'::character varying, 'held'::character varying, 'paid'::character varying, 'void'::character varying])::text[])))
);


--
-- Name: shopper_payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_payouts (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    kind character varying(20) NOT NULL,
    amount numeric(12,2) NOT NULL,
    reference character varying(60) NOT NULL,
    note text,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shopper_payouts_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT shopper_payouts_kind_check CHECK (((kind)::text = ANY ((ARRAY['earnings'::character varying, 'reimbursement'::character varying, 'cash_deposit'::character varying])::text[])))
);


--
-- Name: store_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.store_payments (
    id integer NOT NULL,
    order_id integer NOT NULL,
    shop_id integer NOT NULL,
    shopper_id integer NOT NULL,
    method character varying(20) NOT NULL,
    amount_paid numeric(12,2) NOT NULL,
    expected_amount numeric(12,2) NOT NULL,
    variance numeric(12,2) NOT NULL,
    reference character varying(40),
    note text,
    review_status character varying(20) DEFAULT 'ok'::character varying NOT NULL,
    review_note text,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    reimbursement_status character varying(20) DEFAULT 'owed'::character varying NOT NULL,
    reimbursement_reference character varying(60),
    reimbursed_at timestamp with time zone,
    reimbursed_by integer,
    locked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    payout_id integer,
    customer_payment_check character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    customer_payment_note character varying(300),
    customer_payment_override_by integer,
    customer_payment_override_at timestamp with time zone,
    duplicate_flags jsonb DEFAULT '[]'::jsonb NOT NULL,
    reimbursement_withdrawal_id integer,
    funded_by character varying(10) DEFAULT 'shopper'::character varying NOT NULL,
    attempt_id integer,
    card_id integer,
    funding_account_id integer,
    funding_account_label character varying(120),
    CONSTRAINT store_payments_amount_paid_check CHECK ((amount_paid > (0)::numeric)),
    CONSTRAINT store_payments_company_paid_check CHECK ((((funded_by)::text = 'getme'::text) = ((reimbursement_status)::text = 'company_paid'::text))),
    CONSTRAINT store_payments_customer_payment_check_check CHECK (((customer_payment_check)::text = ANY ((ARRAY['pending'::character varying, 'confirmed'::character varying, 'unconfirmed'::character varying, 'overridden'::character varying])::text[]))),
    CONSTRAINT store_payments_funded_by_check CHECK (((funded_by)::text = ANY ((ARRAY['shopper'::character varying, 'getme'::character varying])::text[]))),
    CONSTRAINT store_payments_method_check CHECK (((method)::text = ANY ((ARRAY['cash'::character varying, 'card'::character varying, 'phone_wallet'::character varying, 'lankaqr'::character varying, 'getme_card'::character varying, 'getme_lankaqr'::character varying])::text[]))),
    CONSTRAINT store_payments_reimbursement_status_check CHECK (((reimbursement_status)::text = ANY ((ARRAY['pending'::character varying, 'owed'::character varying, 'held'::character varying, 'reimbursed'::character varying, 'company_paid'::character varying])::text[]))),
    CONSTRAINT store_payments_review_status_check CHECK (((review_status)::text = ANY ((ARRAY['ok'::character varying, 'needs_review'::character varying, 'approved'::character varying, 'queried'::character varying])::text[])))
);


--
-- Name: finance_ledger; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.finance_ledger AS
 SELECT cp.paid_at AS entry_at,
    'customer_payment'::text AS entry_type,
    'in'::text AS flow,
    cp.order_id,
    NULL::integer AS shopper_id,
    o.customer_id,
    (cp.amount)::numeric AS amount,
    (cp.gateway_payment_id)::text AS reference,
    ((('Card '::text || (COALESCE(cp.card_brand, ''::character varying))::text) || ' '::text) || (COALESCE(cp.card_last4, ''::character varying))::text) AS description
   FROM (public.card_payments cp
     LEFT JOIN public.orders o ON ((o.id = cp.order_id)))
  WHERE (((cp.purpose)::text = ANY ((ARRAY['order'::character varying, 'order_extra'::character varying])::text[])) AND (cp.paid_at IS NOT NULL) AND ((cp.status)::text = ANY ((ARRAY['paid'::character varying, 'partially_refunded'::character varying, 'refunded'::character varying])::text[])))
UNION ALL
 SELECT cp.paid_at AS entry_at,
    'gateway_fee'::text AS entry_type,
    'out'::text AS flow,
    cp.order_id,
    NULL::integer AS shopper_id,
    o.customer_id,
    cp.gateway_fee AS amount,
    cp.gateway_payment_id AS reference,
    'Payment gateway fee'::text AS description
   FROM (public.card_payments cp
     LEFT JOIN public.orders o ON ((o.id = cp.order_id)))
  WHERE (((cp.purpose)::text = ANY ((ARRAY['order'::character varying, 'order_extra'::character varying])::text[])) AND (cp.paid_at IS NOT NULL) AND ((cp.status)::text = ANY ((ARRAY['paid'::character varying, 'partially_refunded'::character varying, 'refunded'::character varying])::text[])) AND (cp.gateway_fee > (0)::numeric))
UNION ALL
 SELECT r.created_at AS entry_at,
    'customer_refund'::text AS entry_type,
    'out'::text AS flow,
    cp.order_id,
    NULL::integer AS shopper_id,
    o.customer_id,
    r.amount,
    r.gateway_refund_id AS reference,
    COALESCE(r.reason, 'Refund'::text) AS description
   FROM ((public.card_payment_refunds r
     JOIN public.card_payments cp ON ((cp.id = r.card_payment_id)))
     LEFT JOIN public.orders o ON ((o.id = cp.order_id)))
  WHERE ((cp.purpose)::text = ANY ((ARRAY['order'::character varying, 'order_extra'::character varying])::text[]))
UNION ALL
 SELECT sp.created_at AS entry_at,
    'grocery_expense'::text AS entry_type,
    'accrual'::text AS flow,
    sp.order_id,
    sp.shopper_id,
    o.customer_id,
    sp.amount_paid AS amount,
    sp.reference,
    ('Paid at store by '::text || (sp.method)::text) AS description
   FROM (public.store_payments sp
     LEFT JOIN public.orders o ON ((o.id = sp.order_id)))
UNION ALL
 SELECT COALESCE(sp.reimbursed_at, sp.updated_at) AS entry_at,
    'grocery_reimbursement'::text AS entry_type,
    'accrual'::text AS flow,
    sp.order_id,
    sp.shopper_id,
    o.customer_id,
    sp.amount_paid AS amount,
    sp.reimbursement_reference AS reference,
    (('Grocery reimbursement ('::text || (sp.reimbursement_status)::text) || ')'::text) AS description
   FROM (public.store_payments sp
     LEFT JOIN public.orders o ON ((o.id = sp.order_id)))
  WHERE ((sp.reimbursement_status)::text = ANY ((ARRAY['owed'::character varying, 'reimbursed'::character varying])::text[]))
UNION ALL
 SELECT se.created_at AS entry_at,
    c.entry_type,
    'accrual'::text AS flow,
    se.order_id,
    se.shopper_id,
    o.customer_id,
    c.amount,
    NULL::text AS reference,
    (((c.label || ' ('::text) || (se.status)::text) || ')'::text) AS description
   FROM ((public.shopper_earnings se
     LEFT JOIN public.orders o ON ((o.id = se.order_id)))
     CROSS JOIN LATERAL ( VALUES ('delivery_fee'::text,se.delivery_fee,'Delivery fee'::text), ('priority_fee'::text,se.priority_fee,'Priority fee'::text), ('service_fee'::text,se.service_fee,'Service fee'::text), ('tip'::text,se.tip,'Tip (100% to shopper)'::text), ('adjustment'::text,se.adjustment,COALESCE(('Adjustment: '::text || se.adjustment_note), 'Adjustment'::text))) c(entry_type, amount, label))
  WHERE (((se.status)::text <> 'void'::text) AND (c.amount <> (0)::numeric))
UNION ALL
 SELECT COALESCE(o.delivered_at, o.updated_at) AS entry_at,
    'commission'::text AS entry_type,
    'accrual'::text AS flow,
    o.id AS order_id,
    o.shopper_id,
    o.customer_id,
    o.getme_fee_kept AS amount,
    NULL::text AS reference,
    (o.getme_fee_percent || '% GetMe fee'::text) AS description
   FROM public.orders o
  WHERE ((o.getme_fee_kept IS NOT NULL) AND (o.getme_fee_kept > (0)::numeric))
UNION ALL
 SELECT se.created_at AS entry_at,
    'cash_collected'::text AS entry_type,
    'accrual'::text AS flow,
    se.order_id,
    se.shopper_id,
    o.customer_id,
    se.cash_collected AS amount,
    NULL::text AS reference,
    'Cash collected at the door'::text AS description
   FROM (public.shopper_earnings se
     LEFT JOIN public.orders o ON ((o.id = se.order_id)))
  WHERE (se.cash_collected > (0)::numeric)
UNION ALL
 SELECT p.created_at AS entry_at,
        CASE p.kind
            WHEN 'earnings'::text THEN 'shopper_payout'::text
            WHEN 'reimbursement'::text THEN 'reimbursement_payout'::text
            ELSE 'cash_deposit'::text
        END AS entry_type,
        CASE
            WHEN ((p.kind)::text = 'cash_deposit'::text) THEN 'in'::text
            ELSE 'out'::text
        END AS flow,
    NULL::integer AS order_id,
    p.shopper_id,
    NULL::integer AS customer_id,
    p.amount,
    p.reference,
    COALESCE(p.note, (p.kind)::text) AS description
   FROM public.shopper_payouts p
UNION ALL
 SELECT COALESCE(o.delivered_at, o.updated_at) AS entry_at,
    'getme_net_revenue'::text AS entry_type,
    'accrual'::text AS flow,
    o.id AS order_id,
    o.shopper_id,
    o.customer_id,
    round(((((COALESCE(pay.net_paid, (0)::numeric) + COALESCE(se.cash_collected, (0)::numeric)) - COALESCE(se.net_amount, (0)::numeric)) - COALESCE(gro.reimbursable, (0)::numeric)) - COALESCE(pay.gateway, (0)::numeric)), 2) AS amount,
    NULL::text AS reference,
    'Customer paid - shopper earnings - groceries - gateway fees'::text AS description
   FROM (((public.orders o
     LEFT JOIN public.shopper_earnings se ON (((se.order_id = o.id) AND ((se.status)::text <> 'void'::text))))
     LEFT JOIN LATERAL ( SELECT sum((cp.amount - cp.refunded_amount)) AS net_paid,
            sum(cp.gateway_fee) AS gateway
           FROM public.card_payments cp
          WHERE ((cp.order_id = o.id) AND ((cp.purpose)::text = ANY ((ARRAY['order'::character varying, 'order_extra'::character varying])::text[])) AND (cp.paid_at IS NOT NULL) AND ((cp.status)::text = ANY ((ARRAY['paid'::character varying, 'partially_refunded'::character varying, 'refunded'::character varying])::text[])))) pay ON (true))
     LEFT JOIN LATERAL ( SELECT sum(sp.amount_paid) AS reimbursable
           FROM public.store_payments sp
          WHERE ((sp.order_id = o.id) AND ((sp.reimbursement_status)::text = ANY ((ARRAY['owed'::character varying, 'held'::character varying, 'reimbursed'::character varying])::text[])))) gro ON (true))
  WHERE (o.getme_fee_kept IS NOT NULL)
UNION ALL
 SELECT COALESCE(o.delivered_at, o.updated_at) AS entry_at,
    'credit_used'::text AS entry_type,
    'accrual'::text AS flow,
    o.id AS order_id,
    o.shopper_id,
    o.customer_id,
    (o.credit_applied - COALESCE(cr.returned, (0)::numeric)) AS amount,
    NULL::text AS reference,
    'GetMe credit used (paid by GetMe)'::text AS description
   FROM (public.orders o
     LEFT JOIN LATERAL ( SELECT sum(ce.amount) AS returned
           FROM public.customer_credit_entries ce
          WHERE ((ce.order_id = o.id) AND ((ce.kind)::text = 'reversed'::text) AND ((ce.client_request_id)::text = (('order:'::text || o.id) || ':credit-return'::text)))) cr ON (true))
  WHERE ((o.getme_fee_kept IS NOT NULL) AND (o.credit_applied > (0)::numeric) AND ((o.credit_applied - COALESCE(cr.returned, (0)::numeric)) > (0)::numeric));


--
-- Name: getme_card_loads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.getme_card_loads (
    id integer NOT NULL,
    card_id integer NOT NULL,
    kind character varying(10) NOT NULL,
    amount numeric(12,2) NOT NULL,
    reference character varying(60) NOT NULL,
    note character varying(300),
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT getme_card_loads_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT getme_card_loads_kind_check CHECK (((kind)::text = ANY ((ARRAY['load'::character varying, 'unload'::character varying])::text[])))
);


--
-- Name: getme_card_loads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.getme_card_loads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: getme_card_loads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.getme_card_loads_id_seq OWNED BY public.getme_card_loads.id;


--
-- Name: getme_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.getme_cards (
    id integer NOT NULL,
    label character varying(60) NOT NULL,
    issuer character varying(80) NOT NULL,
    last4 character(4) NOT NULL,
    shopper_id integer,
    status character varying(10) DEFAULT 'active'::character varying NOT NULL,
    note character varying(300),
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT getme_cards_last4_check CHECK ((last4 ~ '^[0-9]{4}$'::text)),
    CONSTRAINT getme_cards_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'frozen'::character varying, 'retired'::character varying])::text[])))
);


--
-- Name: getme_cards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.getme_cards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: getme_cards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.getme_cards_id_seq OWNED BY public.getme_cards.id;


--
-- Name: grocery_ledger_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grocery_ledger_entries (
    id bigint NOT NULL,
    entry_type character varying(20) NOT NULL,
    order_id integer,
    shop_id integer,
    shopper_id integer,
    reservation_id integer,
    attempt_id integer,
    card_id integer,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    actor_type character varying(10) NOT NULL,
    actor_id integer,
    note character varying(300),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grocery_ledger_entries_actor_type_check CHECK (((actor_type)::text = ANY ((ARRAY['system'::character varying, 'shopper'::character varying, 'admin'::character varying])::text[]))),
    CONSTRAINT grocery_ledger_entries_entry_type_check CHECK (((entry_type)::text = ANY ((ARRAY['reserve'::character varying, 'limit_change'::character varying, 'capture'::character varying, 'release'::character varying, 'reverse'::character varying, 'dispute'::character varying, 'reconcile'::character varying, 'attempt_start'::character varying, 'attempt_failed'::character varying, 'attempt_cancelled'::character varying, 'card_load'::character varying, 'card_unload'::character varying])::text[])))
);


--
-- Name: grocery_ledger_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grocery_ledger_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grocery_ledger_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.grocery_ledger_entries_id_seq OWNED BY public.grocery_ledger_entries.id;


--
-- Name: grocery_payment_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grocery_payment_attempts (
    id integer NOT NULL,
    order_id integer NOT NULL,
    shop_id integer NOT NULL,
    shopper_id integer NOT NULL,
    reservation_id integer,
    method character varying(30) NOT NULL,
    funding character varying(10) NOT NULL,
    card_id integer,
    status character varying(12) DEFAULT 'pending'::character varying NOT NULL,
    currency character(3) DEFAULT 'LKR'::bpchar NOT NULL,
    expected_amount numeric(12,2) NOT NULL,
    limit_amount numeric(12,2) NOT NULL,
    amount numeric(12,2),
    reference character varying(40),
    failure_reason character varying(300),
    request_id character varying(80),
    store_payment_id integer,
    verification character varying(10) DEFAULT 'none'::character varying NOT NULL,
    reconciliation_status character varying(12) DEFAULT 'unreconciled'::character varying NOT NULL,
    reconciliation_note character varying(300),
    statement_reference character varying(60),
    reconciled_by integer,
    reconciled_at timestamp with time zone,
    over_limit boolean DEFAULT false NOT NULL,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    provider character varying(20),
    provider_ref character varying(80),
    provider_status character varying(20),
    provider_message character varying(300),
    requested_amount numeric(12,2),
    merchant_id integer,
    qr_kind character varying(10),
    qr_reference character varying(25),
    initiated_at timestamp with time zone,
    initiate_count integer DEFAULT 0 NOT NULL,
    last_checked_at timestamp with time zone,
    status_checks integer DEFAULT 0 NOT NULL,
    funding_account_id integer,
    funding_account_label character varying(120),
    CONSTRAINT grocery_payment_attempts_amount_check CHECK (((amount IS NULL) OR (amount > (0)::numeric))),
    CONSTRAINT grocery_payment_attempts_funding_check CHECK (((funding)::text = ANY ((ARRAY['shopper'::character varying, 'getme'::character varying])::text[]))),
    CONSTRAINT grocery_payment_attempts_qr_kind_check CHECK (((qr_kind IS NULL) OR ((qr_kind)::text = ANY ((ARRAY['static'::character varying, 'dynamic'::character varying])::text[])))),
    CONSTRAINT grocery_payment_attempts_reconciliation_status_check CHECK (((reconciliation_status)::text = ANY ((ARRAY['unreconciled'::character varying, 'matched'::character varying, 'mismatch'::character varying, 'resolved'::character varying])::text[]))),
    CONSTRAINT grocery_payment_attempts_requested_amount_check CHECK (((requested_amount IS NULL) OR ((requested_amount >= (1)::numeric) AND (requested_amount <= (500000)::numeric)))),
    CONSTRAINT grocery_payment_attempts_simulator_check CHECK (((((verification)::text <> 'simulator'::text) OR ((provider)::text = 'simulator'::text)) AND (((provider)::text IS DISTINCT FROM 'simulator'::text) OR ((verification)::text = ANY ((ARRAY['none'::character varying, 'simulator'::character varying])::text[]))))),
    CONSTRAINT grocery_payment_attempts_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'succeeded'::character varying, 'failed'::character varying, 'cancelled'::character varying, 'reversed'::character varying, 'disputed'::character varying, 'unknown'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT grocery_payment_attempts_verification_check CHECK (((verification)::text = ANY ((ARRAY['none'::character varying, 'receipt'::character varying, 'statement'::character varying, 'provider'::character varying, 'simulator'::character varying])::text[])))
);


--
-- Name: grocery_payment_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grocery_payment_attempts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grocery_payment_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.grocery_payment_attempts_id_seq OWNED BY public.grocery_payment_attempts.id;


--
-- Name: grocery_payment_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grocery_payment_methods (
    key character varying(30) NOT NULL,
    label character varying(80) NOT NULL,
    funding character varying(10) NOT NULL,
    integration character varying(20) NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    icon character varying(40),
    instructions text,
    requirement text,
    sort_order integer DEFAULT 0 NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grocery_payment_methods_available_check CHECK ((NOT (((integration)::text = 'not_available'::text) AND enabled))),
    CONSTRAINT grocery_payment_methods_funding_check CHECK (((funding)::text = ANY ((ARRAY['shopper'::character varying, 'getme'::character varying])::text[]))),
    CONSTRAINT grocery_payment_methods_integration_check CHECK (((integration)::text = ANY ((ARRAY['manual'::character varying, 'card_program'::character varying, 'provider_api'::character varying, 'not_available'::character varying])::text[])))
);


--
-- Name: grocery_payment_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grocery_payment_settings (
    id smallint DEFAULT 1 NOT NULL,
    limit_buffer_percent numeric(5,2) DEFAULT 10 NOT NULL,
    limit_buffer_min numeric(12,2) DEFAULT 500 NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grocery_payment_settings_id_check CHECK ((id = 1)),
    CONSTRAINT grocery_payment_settings_limit_buffer_min_check CHECK ((limit_buffer_min >= (0)::numeric)),
    CONSTRAINT grocery_payment_settings_limit_buffer_percent_check CHECK (((limit_buffer_percent >= (0)::numeric) AND (limit_buffer_percent <= (100)::numeric)))
);


--
-- Name: grocery_reservations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grocery_reservations (
    id integer NOT NULL,
    order_id integer NOT NULL,
    shop_id integer NOT NULL,
    shopper_id integer NOT NULL,
    estimate_amount numeric(12,2) NOT NULL,
    limit_amount numeric(12,2) NOT NULL,
    limit_override numeric(12,2),
    limit_note character varying(300),
    limit_set_by integer,
    status character varying(10) DEFAULT 'active'::character varying NOT NULL,
    captured_amount numeric(12,2) DEFAULT 0 NOT NULL,
    released_amount numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT grocery_reservations_limit_amount_check CHECK ((limit_amount >= (0)::numeric)),
    CONSTRAINT grocery_reservations_status_check CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'captured'::character varying, 'settled'::character varying, 'released'::character varying])::text[])))
);


--
-- Name: grocery_reservations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grocery_reservations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: grocery_reservations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.grocery_reservations_id_seq OWNED BY public.grocery_reservations.id;


--
-- Name: grocery_shop_payment_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grocery_shop_payment_methods (
    shop_id integer NOT NULL,
    method_key character varying(30) NOT NULL,
    enabled boolean NOT NULL,
    note character varying(200),
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_cancellations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_cancellations (
    id bigint NOT NULL,
    order_id integer NOT NULL,
    cancelled_by character varying(20) NOT NULL,
    actor_id integer,
    reason_code character varying(40),
    reason_text text,
    from_status character varying(40) NOT NULL,
    shopper_id integer,
    items_bought integer DEFAULT 0 NOT NULL,
    failed_delivery boolean DEFAULT false NOT NULL,
    payment_method character varying(20),
    amount_held numeric(12,2),
    amount_owed numeric(12,2),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_cancellations_cancelled_by_check CHECK (((cancelled_by)::text = ANY ((ARRAY['customer'::character varying, 'admin'::character varying, 'system'::character varying])::text[])))
);


--
-- Name: order_cancellations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_cancellations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_cancellations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_cancellations_id_seq OWNED BY public.order_cancellations.id;


--
-- Name: order_dispatch_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_dispatch_actions (
    id integer NOT NULL,
    order_id integer NOT NULL,
    action character varying(20) NOT NULL,
    admin_id integer,
    admin_name character varying(160),
    admin_role character varying(40),
    reason character varying(300) NOT NULL,
    shopper_id integer,
    exclusive boolean DEFAULT false NOT NULL,
    paused_until timestamp with time zone,
    from_status character varying(40),
    to_status character varying(40),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_dispatch_actions_action_check CHECK (((action)::text = ANY ((ARRAY['release'::character varying, 'offer'::character varying, 'redispatch'::character varying])::text[])))
);


--
-- Name: order_dispatch_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_dispatch_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_dispatch_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_dispatch_actions_id_seq OWNED BY public.order_dispatch_actions.id;


--
-- Name: order_dispatch_exclusions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_dispatch_exclusions (
    order_id integer NOT NULL,
    shopper_id integer NOT NULL,
    reason character varying(300),
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_item_price_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item_price_reports (
    id integer NOT NULL,
    order_id integer NOT NULL,
    order_item_id integer NOT NULL,
    shop_id integer,
    shopper_id integer,
    product_id integer,
    item_name character varying(200),
    order_unit_price numeric(12,2) NOT NULL,
    shelf_unit_price numeric(12,2) NOT NULL,
    price_unit character varying(10) DEFAULT 'item'::character varying NOT NULL,
    outcome character varying(10) NOT NULL,
    status character varying(10) NOT NULL,
    line_before numeric(12,2),
    line_after numeric(12,2),
    getme_absorbed numeric(12,2) DEFAULT 0 NOT NULL,
    approved_charge numeric(12,2),
    photo_url text,
    note character varying(300),
    responded_at timestamp with time zone,
    admin_status character varying(10) DEFAULT 'open'::character varying NOT NULL,
    admin_note character varying(300),
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_item_price_reports_admin_status_check CHECK (((admin_status)::text = ANY ((ARRAY['open'::character varying, 'resolved'::character varying])::text[]))),
    CONSTRAINT order_item_price_reports_outcome_check CHECK (((outcome)::text = ANY ((ARRAY['lower'::character varying, 'absorbed'::character varying, 'approval'::character varying])::text[]))),
    CONSTRAINT order_item_price_reports_shelf_unit_price_check CHECK ((shelf_unit_price > (0)::numeric)),
    CONSTRAINT order_item_price_reports_status_check CHECK (((status)::text = ANY ((ARRAY['applied'::character varying, 'absorbed'::character varying, 'pending'::character varying, 'approved'::character varying, 'declined'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: order_item_price_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_item_price_reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_item_price_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_item_price_reports_id_seq OWNED BY public.order_item_price_reports.id;


--
-- Name: order_item_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_item_requests (
    id integer NOT NULL,
    order_id integer NOT NULL,
    shop_id integer NOT NULL,
    requested_by character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    product_id integer,
    item_name character varying(255) NOT NULL,
    item_image text,
    quantity numeric(10,3) NOT NULL,
    unit character varying(20),
    line jsonb NOT NULL,
    line_total numeric(12,2) NOT NULL,
    approved_charge numeric(12,2),
    note text,
    reject_reason text,
    order_item_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT order_item_requests_requested_by_check CHECK (((requested_by)::text = ANY ((ARRAY['customer'::character varying, 'shopper'::character varying])::text[]))),
    CONSTRAINT order_item_requests_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'rejected'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: order_item_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_item_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_item_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_item_requests_id_seq OWNED BY public.order_item_requests.id;


--
-- Name: order_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_items (
    id integer NOT NULL,
    order_id integer NOT NULL,
    product_id integer,
    item_name character varying(255) NOT NULL,
    quantity numeric(12,3) DEFAULT 1 NOT NULL,
    amount numeric(12,3) DEFAULT 1 NOT NULL,
    unit character varying(30),
    price numeric(12,2) DEFAULT 0 NOT NULL,
    custom boolean DEFAULT false NOT NULL,
    details text,
    image text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    shopper_photo_url text,
    shopping_status character varying(30) DEFAULT 'pending'::character varying,
    found_quantity numeric,
    found_weight numeric,
    found_weight_unit character varying(10),
    barcode_scanned boolean DEFAULT false,
    completed_at timestamp without time zone,
    voice_url text,
    shop_id integer,
    unit_price numeric(12,2),
    pack_amount numeric(12,3),
    replacement_preference character varying(20) DEFAULT 'best_match'::character varying NOT NULL,
    replacement_product_id integer,
    replacement_product_name character varying(150),
    replacement_product_image text,
    replacement_product_price numeric(10,2),
    replacement_note character varying(300),
    refund_amount numeric(10,2),
    refunded_at timestamp without time zone,
    original_unit_price numeric(10,2),
    offer_id integer,
    offer_label character varying(80),
    added_by character varying(20),
    regular_unit_price numeric(12,2),
    line_total numeric(12,2),
    offer_discount numeric(12,2) DEFAULT 0 NOT NULL,
    shelf_unit_price numeric(12,2),
    CONSTRAINT order_items_replacement_preference_check CHECK (((replacement_preference)::text = ANY ((ARRAY['best_match'::character varying, 'specific'::character varying, 'refund'::character varying])::text[])))
);


--
-- Name: order_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_items_id_seq OWNED BY public.order_items.id;


--
-- Name: order_ratings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_ratings (
    id integer NOT NULL,
    order_id integer NOT NULL,
    customer_id integer NOT NULL,
    shopper_id integer,
    rating smallint NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    comment character varying(500),
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_ratings_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: order_ratings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_ratings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_ratings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_ratings_id_seq OWNED BY public.order_ratings.id;


--
-- Name: order_replacement_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_replacement_items (
    id integer NOT NULL,
    order_id integer NOT NULL,
    order_item_id integer NOT NULL,
    option_number integer NOT NULL,
    photo_url text NOT NULL,
    status character varying(50) DEFAULT 'waiting_customer'::character varying,
    customer_selected boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: order_replacement_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_replacement_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_replacement_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_replacement_items_id_seq OWNED BY public.order_replacement_items.id;


--
-- Name: order_shop_bills; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_shop_bills (
    id integer NOT NULL,
    order_id integer NOT NULL,
    shop_id integer NOT NULL,
    bill_url text NOT NULL,
    bill_uploaded_at timestamp without time zone DEFAULT now(),
    shopping_status character varying(50) DEFAULT 'completed'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    bill_urls jsonb,
    bill_hashes text[] DEFAULT '{}'::text[] NOT NULL
);


--
-- Name: order_shop_bills_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_shop_bills_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_shop_bills_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_shop_bills_id_seq OWNED BY public.order_shop_bills.id;


--
-- Name: order_shops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_shops (
    id integer NOT NULL,
    order_id integer NOT NULL,
    shop_id integer NOT NULL,
    shop_name character varying(255),
    shop_image text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: order_shops_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_shops_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_shops_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_shops_id_seq OWNED BY public.order_shops.id;


--
-- Name: order_support_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_support_notes (
    id integer NOT NULL,
    order_id integer NOT NULL,
    admin_id integer NOT NULL,
    category character varying(30) DEFAULT 'general'::character varying NOT NULL,
    note text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_support_notes_category_check CHECK (((category)::text = ANY ((ARRAY['general'::character varying, 'complaint'::character varying, 'missing_items'::character varying, 'cancellation'::character varying, 'delivery'::character varying, 'payment'::character varying, 'other'::character varying])::text[]))),
    CONSTRAINT order_support_notes_note_check CHECK (((char_length(note) >= 3) AND (char_length(note) <= 2000)))
);


--
-- Name: order_support_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.order_support_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: order_support_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.order_support_notes_id_seq OWNED BY public.order_support_notes.id;


--
-- Name: orders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.orders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: orders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;


--
-- Name: platform_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_by integer
);


--
-- Name: pricing_settings_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pricing_settings_versions (
    id integer NOT NULL,
    value jsonb NOT NULL,
    effective_from timestamp with time zone DEFAULT now() NOT NULL,
    note character varying(300),
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_at timestamp with time zone,
    cancelled_by integer
);


--
-- Name: pricing_settings_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pricing_settings_versions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pricing_settings_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pricing_settings_versions_id_seq OWNED BY public.pricing_settings_versions.id;


--
-- Name: product_catalog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_catalog (
    id integer NOT NULL,
    barcode character varying(64) NOT NULL,
    barcode_key character varying(64) NOT NULL,
    product_name character varying(150) NOT NULL,
    brand character varying(80),
    size character varying(40),
    category character varying(60),
    image_url text,
    created_by_shop_id integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: product_catalog_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_catalog_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_catalog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_catalog_id_seq OWNED BY public.product_catalog.id;


--
-- Name: product_offer_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_offer_history (
    id bigint NOT NULL,
    offer_id integer NOT NULL,
    shop_id integer NOT NULL,
    action character varying(20) NOT NULL,
    before jsonb,
    after jsonb,
    actor_type character varying(20) NOT NULL,
    actor_id integer,
    actor_name character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_offer_history_action_check CHECK (((action)::text = ANY ((ARRAY['create'::character varying, 'update'::character varying, 'delete'::character varying, 'pause'::character varying, 'resume'::character varying])::text[])))
);


--
-- Name: product_offer_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_offer_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_offer_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_offer_history_id_seq OWNED BY public.product_offer_history.id;


--
-- Name: product_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_offers (
    id integer NOT NULL,
    shop_id integer NOT NULL,
    scope character varying(20) NOT NULL,
    product_id integer,
    category character varying(100),
    discount_type character varying(20) NOT NULL,
    discount_value numeric(10,2) NOT NULL,
    title character varying(80),
    starts_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ends_at timestamp without time zone,
    is_active boolean DEFAULT true NOT NULL,
    paused_by_admin boolean DEFAULT false NOT NULL,
    admin_note character varying(300),
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    min_quantity integer DEFAULT 1 NOT NULL,
    max_per_order integer,
    source character varying(10) DEFAULT 'portal'::character varying NOT NULL,
    CONSTRAINT product_offers_dates CHECK (((ends_at IS NULL) OR (ends_at > starts_at))),
    CONSTRAINT product_offers_quantities CHECK ((((min_quantity >= 1) AND (min_quantity <= 100)) AND ((max_per_order IS NULL) OR (((max_per_order >= 1) AND (max_per_order <= 100)) AND (max_per_order >= min_quantity))))),
    CONSTRAINT product_offers_scope_check CHECK (((((scope)::text = 'product'::text) AND (product_id IS NOT NULL)) OR (((scope)::text = 'category'::text) AND (category IS NOT NULL) AND ((discount_type)::text = 'percent'::text)) OR (((scope)::text = 'shop'::text) AND ((discount_type)::text = 'percent'::text)))),
    CONSTRAINT product_offers_source CHECK (((source)::text = ANY ((ARRAY['portal'::character varying, 'import'::character varying])::text[]))),
    CONSTRAINT product_offers_type_check CHECK (((((discount_type)::text = 'percent'::text) AND (discount_value > (0)::numeric) AND (discount_value <= (90)::numeric)) OR (((discount_type)::text = 'sale_price'::text) AND (discount_value > (0)::numeric))))
);


--
-- Name: product_offers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_offers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_offers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_offers_id_seq OWNED BY public.product_offers.id;


--
-- Name: product_price_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_price_history (
    id bigint NOT NULL,
    shop_id integer NOT NULL,
    product_id integer NOT NULL,
    old_price numeric(12,2),
    new_price numeric(12,2) NOT NULL,
    source character varying(20) NOT NULL,
    note character varying(300),
    actor_type character varying(20) NOT NULL,
    actor_id integer,
    actor_name character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_price_history_new_price_check CHECK ((new_price >= (0)::numeric)),
    CONSTRAINT product_price_history_source_check CHECK (((source)::text = ANY ((ARRAY['created'::character varying, 'manual'::character varying, 'import'::character varying, 'admin'::character varying])::text[])))
);


--
-- Name: product_price_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_price_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_price_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_price_history_id_seq OWNED BY public.product_price_history.id;


--
-- Name: product_stock_movements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.product_stock_movements (
    id bigint NOT NULL,
    shop_id integer NOT NULL,
    product_id integer NOT NULL,
    change integer NOT NULL,
    stock_before integer NOT NULL,
    stock_after integer NOT NULL,
    reason character varying(30) NOT NULL,
    note character varying(300),
    order_id integer,
    order_item_id integer,
    actor_type character varying(20) NOT NULL,
    actor_id integer,
    actor_name character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT product_stock_movements_stock_after_check CHECK ((stock_after >= 0))
);


--
-- Name: product_stock_movements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.product_stock_movements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: product_stock_movements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.product_stock_movements_id_seq OWNED BY public.product_stock_movements.id;


--
-- Name: products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.products (
    id integer NOT NULL,
    shop_id integer NOT NULL,
    product_name character varying(200) NOT NULL,
    category character varying(100) NOT NULL,
    price numeric(12,2) DEFAULT 0 NOT NULL,
    stock_quantity integer DEFAULT 0 NOT NULL,
    description text,
    image_url text,
    is_available boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    unit character varying(10) DEFAULT 'item'::character varying NOT NULL,
    barcode character varying(64),
    brand character varying(80),
    size character varying(40),
    catalog_id integer,
    price_updated_at timestamp with time zone,
    CONSTRAINT products_price_not_negative CHECK ((price >= (0)::numeric)),
    CONSTRAINT products_stock_not_negative CHECK ((stock_quantity >= 0))
);


--
-- Name: products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.products_id_seq OWNED BY public.products.id;


--
-- Name: promo_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_codes (
    id integer NOT NULL,
    code character varying(40) NOT NULL,
    description character varying(200),
    discount_type character varying(20) NOT NULL,
    discount_value numeric(10,2) DEFAULT 0 NOT NULL,
    max_discount numeric(10,2),
    min_order_amount numeric(10,2) DEFAULT 0 NOT NULL,
    starts_at timestamp without time zone,
    ends_at timestamp without time zone,
    usage_limit integer,
    per_customer_limit integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT promo_codes_discount_type_check CHECK (((discount_type)::text = ANY ((ARRAY['percent'::character varying, 'fixed'::character varying, 'free_delivery'::character varying])::text[])))
);


--
-- Name: promo_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.promo_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: promo_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.promo_codes_id_seq OWNED BY public.promo_codes.id;


--
-- Name: promo_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.promo_redemptions (
    id integer NOT NULL,
    promo_id integer NOT NULL,
    order_id integer NOT NULL,
    customer_id integer NOT NULL,
    discount_amount numeric(10,2) NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: promo_redemptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.promo_redemptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: promo_redemptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.promo_redemptions_id_seq OWNED BY public.promo_redemptions.id;


--
-- Name: push_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_tokens (
    token character varying(255) NOT NULL,
    owner_type character varying(20) NOT NULL,
    owner_id integer NOT NULL,
    platform character varying(20),
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_tokens_owner_type_check CHECK (((owner_type)::text = ANY ((ARRAY['customer'::character varying, 'shopper'::character varying])::text[])))
);


--
-- Name: replacement_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replacement_items (
    id integer NOT NULL,
    order_id integer NOT NULL,
    original_item_id integer NOT NULL,
    shopper_id integer NOT NULL,
    option_number integer NOT NULL,
    photo_url text NOT NULL,
    status character varying(50) DEFAULT 'waiting_customer'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: replacement_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.replacement_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: replacement_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.replacement_items_id_seq OWNED BY public.replacement_items.id;


--
-- Name: saved_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_cards (
    id integer NOT NULL,
    owner_type character varying(20) NOT NULL,
    owner_id integer NOT NULL,
    gateway character varying(20) NOT NULL,
    token_encrypted text NOT NULL,
    card_brand character varying(20),
    card_last4 character varying(4),
    card_holder_name character varying(120),
    card_expiry character varying(4),
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT saved_cards_owner_type_check CHECK (((owner_type)::text = ANY ((ARRAY['customer'::character varying, 'shopper'::character varying])::text[])))
);


--
-- Name: saved_cards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.saved_cards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: saved_cards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.saved_cards_id_seq OWNED BY public.saved_cards.id;


--
-- Name: shop_activity_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shop_activity_log (
    id bigint NOT NULL,
    shop_id integer NOT NULL,
    actor_type character varying(20) NOT NULL,
    actor_id integer,
    actor_name character varying(120),
    actor_role character varying(20),
    action character varying(80) NOT NULL,
    entity_type character varying(30),
    entity_id character varying(40),
    summary character varying(300),
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shop_activity_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shop_activity_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shop_activity_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shop_activity_log_id_seq OWNED BY public.shop_activity_log.id;


--
-- Name: shop_lankaqr_merchants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shop_lankaqr_merchants (
    id integer NOT NULL,
    shop_id integer NOT NULL,
    merchant_key character(64) NOT NULL,
    account_hash character(64) NOT NULL,
    account_tags character varying(10) NOT NULL,
    merchant_name character varying(50) NOT NULL,
    merchant_city character varying(30) NOT NULL,
    mcc character(4) NOT NULL,
    status character varying(10) DEFAULT 'pending'::character varying NOT NULL,
    submitted_by_type character varying(10) NOT NULL,
    submitted_by_id integer,
    submitted_order_id integer,
    submitted_note character varying(300),
    sample_payload text,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    review_note character varying(300),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shop_lankaqr_merchants_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'rejected'::character varying, 'disabled'::character varying])::text[]))),
    CONSTRAINT shop_lankaqr_merchants_submitted_by_type_check CHECK (((submitted_by_type)::text = ANY ((ARRAY['shopper'::character varying, 'admin'::character varying])::text[])))
);


--
-- Name: shop_lankaqr_merchants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shop_lankaqr_merchants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shop_lankaqr_merchants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shop_lankaqr_merchants_id_seq OWNED BY public.shop_lankaqr_merchants.id;


--
-- Name: shop_staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shop_staff (
    id integer NOT NULL,
    shop_id integer NOT NULL,
    full_name character varying(120) NOT NULL,
    email character varying(160) NOT NULL,
    mobile character varying(20),
    password_hash text NOT NULL,
    role character varying(20) DEFAULT 'staff'::character varying NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    last_login_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_version integer DEFAULT 0 NOT NULL,
    CONSTRAINT shop_staff_role_check CHECK (((role)::text = ANY ((ARRAY['manager'::character varying, 'staff'::character varying])::text[])))
);


--
-- Name: shop_staff_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shop_staff_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shop_staff_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shop_staff_id_seq OWNED BY public.shop_staff.id;


--
-- Name: shopper_activation_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_activation_codes (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    code_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    sent_by_sms boolean DEFAULT false NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shopper_activation_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_activation_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_activation_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_activation_codes_id_seq OWNED BY public.shopper_activation_codes.id;


--
-- Name: shopper_application_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_application_documents (
    id integer NOT NULL,
    application_id integer NOT NULL,
    doc_type character varying(30) NOT NULL,
    file_name character varying(200) NOT NULL,
    mime_type character varying(60) NOT NULL,
    size_bytes integer NOT NULL,
    sha256 character varying(64) NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    replaced_at timestamp with time zone,
    deleted_at timestamp with time zone,
    review_status character varying(10) DEFAULT 'pending'::character varying NOT NULL,
    review_note character varying(300),
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    CONSTRAINT shopper_application_documents_doc_type_check CHECK (((doc_type)::text = ANY ((ARRAY['nic_front'::character varying, 'nic_back'::character varying, 'selfie'::character varying, 'licence_front'::character varying, 'licence_back'::character varying, 'vehicle_cr'::character varying, 'owner_letter'::character varying, 'vehicle_front'::character varying, 'vehicle_side'::character varying, 'vehicle_rear'::character varying, 'vehicle_interior'::character varying])::text[]))),
    CONSTRAINT shopper_application_documents_review_check CHECK (((review_status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: shopper_application_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_application_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_application_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_application_documents_id_seq OWNED BY public.shopper_application_documents.id;


--
-- Name: shopper_application_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_application_events (
    id integer NOT NULL,
    application_id integer NOT NULL,
    action character varying(40) NOT NULL,
    from_status character varying(30),
    to_status character varying(30),
    actor_type character varying(10) NOT NULL,
    actor_id integer,
    note character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shopper_application_events_actor_type_check CHECK (((actor_type)::text = ANY ((ARRAY['shopper'::character varying, 'admin'::character varying, 'system'::character varying])::text[])))
);


--
-- Name: shopper_application_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_application_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_application_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_application_events_id_seq OWNED BY public.shopper_application_events.id;


--
-- Name: shopper_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_applications (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    full_name character varying(120),
    date_of_birth date,
    email character varying(160),
    phone_verified_at timestamp with time zone,
    phone_verified_by character varying(10),
    nic_encrypted text,
    nic_hash character varying(64),
    nic_last4 character varying(4),
    vehicle_type character varying(20),
    vehicle_number character varying(20),
    is_registered_owner boolean,
    licence_encrypted text,
    licence_last4 character varying(4),
    licence_expiry date,
    address_line character varying(200),
    city character varying(80),
    district character varying(40),
    service_area character varying(120),
    emergency_name character varying(120),
    emergency_phone character varying(20),
    emergency_relation character varying(40),
    payout_account_id integer,
    terms_accepted_at timestamp with time zone,
    privacy_accepted_at timestamp with time zone,
    terms_version character varying(20),
    submitted_at timestamp with time zone,
    submit_count integer DEFAULT 0 NOT NULL,
    last_submit_request_id character varying(64),
    reviewed_at timestamp with time zone,
    reviewed_by integer,
    decision_reason character varying(500),
    info_request jsonb,
    documents_deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_admin integer,
    consent_recorded_by integer,
    CONSTRAINT shopper_applications_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'submitted'::character varying, 'under_review'::character varying, 'more_info_required'::character varying, 'approved'::character varying, 'rejected'::character varying])::text[]))),
    CONSTRAINT shopper_applications_vehicle_type_check CHECK (((vehicle_type)::text = ANY ((ARRAY['motorbike'::character varying, 'three-wheeler'::character varying, 'car'::character varying])::text[])))
);


--
-- Name: shopper_applications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_applications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_applications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_applications_id_seq OWNED BY public.shopper_applications.id;


--
-- Name: shopper_cash_limit_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_cash_limit_state (
    shopper_id integer NOT NULL,
    over_limit boolean DEFAULT false NOT NULL,
    cash_held numeric(12,2) DEFAULT 0 NOT NULL,
    cash_limit numeric(12,2),
    crossings integer DEFAULT 0 NOT NULL,
    crossed_at timestamp with time zone,
    cleared_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shopper_change_request_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_change_request_documents (
    id integer NOT NULL,
    request_id integer NOT NULL,
    doc_type character varying(30) NOT NULL,
    file_name character varying(200) NOT NULL,
    mime_type character varying(60) NOT NULL,
    size_bytes integer NOT NULL,
    sha256 character varying(64) NOT NULL,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    replaced_at timestamp with time zone,
    deleted_at timestamp with time zone,
    review_status character varying(10) DEFAULT 'pending'::character varying NOT NULL,
    review_note character varying(300),
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    CONSTRAINT shopper_change_request_documents_doc_type_check CHECK (((doc_type)::text = ANY ((ARRAY['nic_front'::character varying, 'nic_back'::character varying, 'selfie'::character varying, 'licence_front'::character varying, 'licence_back'::character varying, 'vehicle_cr'::character varying, 'owner_letter'::character varying, 'vehicle_front'::character varying, 'vehicle_side'::character varying, 'vehicle_rear'::character varying, 'vehicle_interior'::character varying])::text[]))),
    CONSTRAINT shopper_change_request_documents_review_check CHECK (((review_status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: shopper_change_request_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_change_request_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_change_request_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_change_request_documents_id_seq OWNED BY public.shopper_change_request_documents.id;


--
-- Name: shopper_change_request_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_change_request_events (
    id integer NOT NULL,
    request_id integer NOT NULL,
    action character varying(40) NOT NULL,
    from_status character varying(30),
    to_status character varying(30),
    actor_type character varying(10) NOT NULL,
    actor_id integer,
    note character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shopper_change_request_events_actor_type_check CHECK (((actor_type)::text = ANY ((ARRAY['shopper'::character varying, 'admin'::character varying, 'system'::character varying, 'public'::character varying])::text[])))
);


--
-- Name: shopper_change_request_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_change_request_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_change_request_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_change_request_events_id_seq OWNED BY public.shopper_change_request_events.id;


--
-- Name: shopper_change_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_change_requests (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    type character varying(20) NOT NULL,
    status character varying(30) DEFAULT 'draft'::character varying NOT NULL,
    current_values jsonb DEFAULT '{}'::jsonb NOT NULL,
    proposed_values jsonb DEFAULT '{}'::jsonb NOT NULL,
    proposed_mobile character varying(20),
    proposed_licence_encrypted text,
    proposed_nic_encrypted text,
    proposed_nic_hash character varying(64),
    verification jsonb DEFAULT '{}'::jsonb NOT NULL,
    risk_flags jsonb DEFAULT '[]'::jsonb NOT NULL,
    shopper_note character varying(500),
    decision_reason character varying(500),
    info_request jsonb,
    status_token_hash character varying(64),
    client_request_id character varying(64),
    submitted_at timestamp with time zone,
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    completed_at timestamp with time zone,
    documents_deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shopper_change_requests_status_check CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'pending_verification'::character varying, 'pending_review'::character varying, 'more_info_required'::character varying, 'approved'::character varying, 'rejected'::character varying, 'cancelled'::character varying])::text[]))),
    CONSTRAINT shopper_change_requests_type_check CHECK (((type)::text = ANY ((ARRAY['vehicle_change'::character varying, 'phone_change'::character varying, 'phone_recovery'::character varying, 'identity_change'::character varying])::text[])))
);


--
-- Name: shopper_change_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_change_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_change_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_change_requests_id_seq OWNED BY public.shopper_change_requests.id;


--
-- Name: shopper_code_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_code_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_compliance_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_compliance_alerts (
    shopper_id integer NOT NULL,
    document character varying(40) NOT NULL,
    threshold character varying(10) NOT NULL,
    expiry_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shopper_earnings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_earnings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_earnings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_earnings_id_seq OWNED BY public.shopper_earnings.id;


--
-- Name: shopper_incident_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_incident_events (
    id bigint NOT NULL,
    incident_id bigint NOT NULL,
    kind character varying(20) NOT NULL,
    note character varying(500),
    admin_id integer,
    admin_name character varying(120),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shopper_incident_events_kind_check CHECK (((kind)::text = ANY ((ARRAY['created'::character varying, 'shopper_update'::character varying, 'acknowledged'::character varying, 'note'::character varying, 'resolved'::character varying])::text[])))
);


--
-- Name: shopper_incident_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_incident_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_incident_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_incident_events_id_seq OWNED BY public.shopper_incident_events.id;


--
-- Name: shopper_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_incidents (
    id bigint NOT NULL,
    shopper_id integer NOT NULL,
    order_id integer,
    type character varying(20) NOT NULL,
    severity character varying(10) NOT NULL,
    note character varying(500),
    latitude double precision,
    longitude double precision,
    location_at timestamp with time zone,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    acknowledged_by integer,
    acknowledged_at timestamp with time zone,
    resolved_by integer,
    resolved_at timestamp with time zone,
    resolution_note character varying(500),
    client_request_id character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shopper_incidents_severity_check CHECK (((severity)::text = ANY ((ARRAY['warning'::character varying, 'critical'::character varying])::text[]))),
    CONSTRAINT shopper_incidents_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'acknowledged'::character varying, 'resolved'::character varying])::text[]))),
    CONSTRAINT shopper_incidents_type_check CHECK (((type)::text = ANY ((ARRAY['safety'::character varying, 'accident'::character varying, 'customer'::character varying, 'store'::character varying, 'app_payment'::character varying, 'other'::character varying])::text[])))
);


--
-- Name: shopper_incidents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_incidents_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_incidents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_incidents_id_seq OWNED BY public.shopper_incidents.id;


--
-- Name: shopper_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_notifications (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    type character varying(40) NOT NULL,
    title character varying(150) NOT NULL,
    body text,
    order_id integer,
    read_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: shopper_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_notifications_id_seq OWNED BY public.shopper_notifications.id;


--
-- Name: shopper_order_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_order_offers (
    shopper_id integer NOT NULL,
    order_id integer NOT NULL,
    first_seen_at timestamp without time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp without time zone
);


--
-- Name: shopper_payout_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_payout_accounts (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    method character varying(20) DEFAULT 'bank'::character varying NOT NULL,
    bank_name character varying(80) NOT NULL,
    branch_name character varying(80) NOT NULL,
    account_holder_name character varying(120) NOT NULL,
    account_number_encrypted text NOT NULL,
    account_last4 character varying(4) NOT NULL,
    account_number_hash character varying(64) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    status_note character varying(300),
    reviewed_by integer,
    reviewed_at timestamp with time zone,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT shopper_payout_accounts_method_check CHECK (((method)::text = 'bank'::text)),
    CONSTRAINT shopper_payout_accounts_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'verified'::character varying, 'rejected'::character varying])::text[])))
);


--
-- Name: shopper_payout_accounts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_payout_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_payout_accounts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_payout_accounts_id_seq OWNED BY public.shopper_payout_accounts.id;


--
-- Name: shopper_payouts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_payouts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_payouts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_payouts_id_seq OWNED BY public.shopper_payouts.id;


--
-- Name: shopper_phone_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_phone_otps (
    id integer NOT NULL,
    mobile character varying(20) NOT NULL,
    purpose character varying(20) DEFAULT 'register'::character varying NOT NULL,
    code_hash character varying(64) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    consumed_at timestamp with time zone,
    proof_hash character varying(64),
    proof_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shopper_phone_otps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_phone_otps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_phone_otps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_phone_otps_id_seq OWNED BY public.shopper_phone_otps.id;


--
-- Name: shopper_profile_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_profile_history (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    field character varying(40) NOT NULL,
    old_value character varying(200),
    new_value character varying(200),
    change_request_id integer,
    changed_by_type character varying(10) NOT NULL,
    changed_by_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shopper_profile_history_changed_by_type_check CHECK (((changed_by_type)::text = ANY ((ARRAY['shopper'::character varying, 'admin'::character varying, 'system'::character varying])::text[])))
);


--
-- Name: shopper_profile_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_profile_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_profile_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_profile_history_id_seq OWNED BY public.shopper_profile_history.id;


--
-- Name: shopper_training_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_training_attempts (
    id bigint NOT NULL,
    shopper_id integer NOT NULL,
    questions_version integer NOT NULL,
    answers jsonb DEFAULT '{}'::jsonb NOT NULL,
    wrong_question_ids text[] DEFAULT '{}'::text[] NOT NULL,
    score integer NOT NULL,
    total integer NOT NULL,
    passed boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shopper_training_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_training_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_training_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_training_attempts_id_seq OWNED BY public.shopper_training_attempts.id;


--
-- Name: shopper_training_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_training_settings (
    id smallint DEFAULT 1 NOT NULL,
    training_required boolean DEFAULT false NOT NULL,
    training_enabled_at timestamp with time zone,
    questions jsonb,
    questions_version integer DEFAULT 1 NOT NULL,
    updated_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shopper_training_settings_id_check CHECK ((id = 1))
);


--
-- Name: shopper_vehicle_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_vehicle_records (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    source_type character varying(20) NOT NULL,
    source_id integer NOT NULL,
    vehicle_type character varying(20),
    vehicle_number character varying(20),
    vehicle_make character varying(40),
    vehicle_model character varying(60),
    is_registered_owner boolean,
    licence_expiry date,
    documents jsonb DEFAULT '[]'::jsonb NOT NULL,
    approved_by integer,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    superseded_at timestamp with time zone,
    superseded_by integer,
    CONSTRAINT shopper_vehicle_records_source_type_check CHECK (((source_type)::text = ANY ((ARRAY['application'::character varying, 'change_request'::character varying])::text[])))
);


--
-- Name: shopper_vehicle_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_vehicle_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_vehicle_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_vehicle_records_id_seq OWNED BY public.shopper_vehicle_records.id;


--
-- Name: shopper_withdrawal_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_withdrawal_events (
    id integer NOT NULL,
    withdrawal_id integer NOT NULL,
    action character varying(30) NOT NULL,
    from_status character varying(20),
    to_status character varying(20) NOT NULL,
    actor_type character varying(10) NOT NULL,
    actor_id integer,
    note character varying(300),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shopper_withdrawal_events_actor_type_check CHECK (((actor_type)::text = ANY ((ARRAY['shopper'::character varying, 'admin'::character varying])::text[])))
);


--
-- Name: shopper_withdrawal_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_withdrawal_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_withdrawal_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_withdrawal_events_id_seq OWNED BY public.shopper_withdrawal_events.id;


--
-- Name: shopper_withdrawals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shopper_withdrawals (
    id integer NOT NULL,
    shopper_id integer NOT NULL,
    amount numeric(12,2) NOT NULL,
    fee numeric(12,2) DEFAULT 0 NOT NULL,
    payout_amount numeric(12,2) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    payout_account_id integer,
    account_snapshot jsonb NOT NULL,
    cash_netted numeric(12,2) DEFAULT 0 NOT NULL,
    reference character varying(80),
    reason character varying(300),
    client_request_id character varying(64),
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_at timestamp with time zone,
    approved_by integer,
    paid_at timestamp with time zone,
    paid_by integer,
    closed_at timestamp with time zone,
    closed_by integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    earnings_amount numeric(12,2) DEFAULT 0 NOT NULL,
    reimbursement_amount numeric(12,2) DEFAULT 0 NOT NULL,
    cash_netted_reimbursement numeric(12,2) DEFAULT 0 NOT NULL,
    CONSTRAINT shopper_withdrawals_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT shopper_withdrawals_fee_check CHECK ((fee >= (0)::numeric)),
    CONSTRAINT shopper_withdrawals_parts_check CHECK (((earnings_amount >= (0)::numeric) AND (reimbursement_amount >= (0)::numeric) AND ((earnings_amount + reimbursement_amount) = amount))),
    CONSTRAINT shopper_withdrawals_payout_amount_check CHECK ((payout_amount > (0)::numeric)),
    CONSTRAINT shopper_withdrawals_status_check CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'approved'::character varying, 'processing'::character varying, 'paid'::character varying, 'rejected'::character varying, 'failed'::character varying, 'cancelled'::character varying])::text[])))
);


--
-- Name: shopper_withdrawals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shopper_withdrawals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shopper_withdrawals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shopper_withdrawals_id_seq OWNED BY public.shopper_withdrawals.id;


--
-- Name: shoppers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shoppers (
    id integer NOT NULL,
    full_name character varying(255) NOT NULL,
    mobile character varying(30) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash text NOT NULL,
    status character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    latitude double precision,
    longitude double precision,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    vehicle_type character varying(30),
    vehicle_number character varying(30),
    approval_status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    profile_image_url text,
    location_updated_at timestamp with time zone,
    auth_version integer DEFAULT 0 NOT NULL,
    vehicle_make character varying(40),
    vehicle_model character varying(60),
    licence_expiry date,
    vehicle_restriction character varying(300),
    vehicle_restricted_at timestamp with time zone,
    vehicle_restricted_by integer,
    shopper_code character varying(20) DEFAULT public.next_shopper_code() NOT NULL,
    registration_channel character varying(10) DEFAULT 'app'::character varying NOT NULL,
    registered_by_admin integer,
    activated_at timestamp with time zone DEFAULT now(),
    revenue_licence_expiry date,
    insurance_expiry date,
    approved_at timestamp with time zone,
    CONSTRAINT shoppers_registration_channel_check CHECK (((registration_channel)::text = ANY ((ARRAY['app'::character varying, 'admin'::character varying])::text[])))
);


--
-- Name: shoppers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shoppers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shoppers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shoppers_id_seq OWNED BY public.shoppers.id;


--
-- Name: shops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shops (
    id integer NOT NULL,
    shop_name character varying(200) NOT NULL,
    email character varying(150) NOT NULL,
    mobile character varying(20),
    password_hash text NOT NULL,
    address text,
    status character varying(30) DEFAULT 'pending'::character varying,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    image_url text,
    latitude double precision,
    longitude double precision,
    area character varying(100),
    is_open boolean DEFAULT true NOT NULL,
    brand_color character varying(7),
    opening_hours jsonb,
    auto_open boolean DEFAULT false NOT NULL,
    open_override_until timestamp with time zone,
    low_stock_threshold integer DEFAULT 5 NOT NULL,
    account_manager_admin_id integer,
    onboarding jsonb DEFAULT '{}'::jsonb NOT NULL,
    onboarding_notes character varying(1000),
    onboarding_completed_at timestamp with time zone,
    auth_version integer DEFAULT 0 NOT NULL,
    CONSTRAINT shops_brand_color_hex CHECK (((brand_color IS NULL) OR ((brand_color)::text ~ '^#[0-9A-F]{6}$'::text))),
    CONSTRAINT shops_onboarding_is_object CHECK ((jsonb_typeof(onboarding) = 'object'::text))
);


--
-- Name: shops_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shops_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shops_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shops_id_seq OWNED BY public.shops.id;


--
-- Name: store_payments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.store_payments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: store_payments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.store_payments_id_seq OWNED BY public.store_payments.id;


--
-- Name: support_case_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_case_events (
    id bigint NOT NULL,
    case_id bigint NOT NULL,
    kind character varying(12) NOT NULL,
    author_type character varying(10) NOT NULL,
    admin_id integer,
    visibility character varying(10) DEFAULT 'public'::character varying NOT NULL,
    body character varying(2000),
    data jsonb,
    client_request_id character varying(80),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_case_events_author_type_check CHECK (((author_type)::text = ANY ((ARRAY['customer'::character varying, 'staff'::character varying, 'system'::character varying])::text[]))),
    CONSTRAINT support_case_events_kind_check CHECK (((kind)::text = ANY ((ARRAY['created'::character varying, 'message'::character varying, 'note'::character varying, 'status'::character varying, 'assigned'::character varying, 'resolved'::character varying, 'approval'::character varying])::text[]))),
    CONSTRAINT support_case_events_visibility_check CHECK (((visibility)::text = ANY ((ARRAY['public'::character varying, 'internal'::character varying])::text[])))
);


--
-- Name: support_case_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_case_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_case_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_case_events_id_seq OWNED BY public.support_case_events.id;


--
-- Name: support_case_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_case_photos (
    id bigint NOT NULL,
    case_id bigint NOT NULL,
    file_name character varying(120) NOT NULL,
    mime_type character varying(40) NOT NULL,
    size_bytes integer NOT NULL,
    sha256 character(64) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_case_photos_size_bytes_check CHECK ((size_bytes > 0))
);


--
-- Name: support_case_photos_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_case_photos_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_case_photos_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_case_photos_id_seq OWNED BY public.support_case_photos.id;


--
-- Name: support_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_cases (
    id bigint NOT NULL,
    order_id integer NOT NULL,
    customer_id integer NOT NULL,
    category character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'open'::character varying NOT NULL,
    description character varying(1000) NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    suggested_amount numeric(12,2) DEFAULT 0 NOT NULL,
    assigned_admin_id integer,
    assigned_at timestamp with time zone,
    first_response_at timestamp with time zone,
    first_response_due_at timestamp with time zone NOT NULL,
    overdue_notified_at timestamp with time zone,
    last_customer_message_at timestamp with time zone,
    last_staff_message_at timestamp with time zone,
    resolved_at timestamp with time zone,
    resolved_by integer,
    resolution_type character varying(12),
    resolution_amount numeric(12,2),
    resolution_note character varying(500),
    client_request_id character varying(80) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_cases_category_check CHECK (((category)::text = ANY ((ARRAY['missing_item'::character varying, 'wrong_item'::character varying, 'damaged'::character varying, 'quality'::character varying, 'late_delivery'::character varying, 'other'::character varying])::text[]))),
    CONSTRAINT support_cases_resolution_amount_check CHECK (((resolution_amount IS NULL) OR (resolution_amount >= (0)::numeric))),
    CONSTRAINT support_cases_resolution_check CHECK ((((status)::text = ANY ((ARRAY['resolved'::character varying, 'declined'::character varying])::text[])) = ((resolution_type IS NOT NULL) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT support_cases_resolution_type_check CHECK (((resolution_type)::text = ANY ((ARRAY['card_refund'::character varying, 'credit'::character varying, 'declined'::character varying, 'no_money'::character varying])::text[]))),
    CONSTRAINT support_cases_status_check CHECK (((status)::text = ANY ((ARRAY['open'::character varying, 'in_progress'::character varying, 'waiting_customer'::character varying, 'resolved'::character varying, 'declined'::character varying])::text[]))),
    CONSTRAINT support_cases_suggested_amount_check CHECK ((suggested_amount >= (0)::numeric))
);


--
-- Name: support_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_cases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.support_cases_id_seq OWNED BY public.support_cases.id;


--
-- Name: admin_approval_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_approval_requests ALTER COLUMN id SET DEFAULT nextval('public.admin_approval_requests_id_seq'::regclass);


--
-- Name: admin_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log ALTER COLUMN id SET DEFAULT nextval('public.admin_audit_log_id_seq'::regclass);


--
-- Name: admin_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications ALTER COLUMN id SET DEFAULT nextval('public.admin_notifications_id_seq'::regclass);


--
-- Name: admins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins ALTER COLUMN id SET DEFAULT nextval('public.admins_id_seq'::regclass);


--
-- Name: card_payment_refunds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_payment_refunds ALTER COLUMN id SET DEFAULT nextval('public.card_payment_refunds_id_seq'::regclass);


--
-- Name: card_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_payments ALTER COLUMN id SET DEFAULT nextval('public.card_payments_id_seq'::regclass);


--
-- Name: card_setups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_setups ALTER COLUMN id SET DEFAULT nextval('public.card_setups_id_seq'::regclass);


--
-- Name: cash_settlements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_settlements ALTER COLUMN id SET DEFAULT nextval('public.cash_settlements_id_seq'::regclass);


--
-- Name: chat_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages ALTER COLUMN id SET DEFAULT nextval('public.chat_messages_id_seq'::regclass);


--
-- Name: company_bank_account_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_events ALTER COLUMN id SET DEFAULT nextval('public.company_bank_account_events_id_seq'::regclass);


--
-- Name: company_bank_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts ALTER COLUMN id SET DEFAULT nextval('public.company_bank_accounts_id_seq'::regclass);


--
-- Name: customer_activity_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_activity_events ALTER COLUMN id SET DEFAULT nextval('public.customer_activity_events_id_seq'::regclass);


--
-- Name: customer_addresses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses ALTER COLUMN id SET DEFAULT nextval('public.customer_addresses_id_seq'::regclass);


--
-- Name: customer_credit_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_entries ALTER COLUMN id SET DEFAULT nextval('public.customer_credit_entries_id_seq'::regclass);


--
-- Name: customer_location_points id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_location_points ALTER COLUMN id SET DEFAULT nextval('public.customer_location_points_id_seq'::regclass);


--
-- Name: customer_presence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_presence ALTER COLUMN id SET DEFAULT nextval('public.customer_presence_id_seq'::regclass);


--
-- Name: customer_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_sessions ALTER COLUMN id SET DEFAULT nextval('public.customer_sessions_id_seq'::regclass);


--
-- Name: customer_tracking_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tracking_sessions ALTER COLUMN id SET DEFAULT nextval('public.customer_tracking_sessions_id_seq'::regclass);


--
-- Name: customers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);


--
-- Name: getme_card_loads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.getme_card_loads ALTER COLUMN id SET DEFAULT nextval('public.getme_card_loads_id_seq'::regclass);


--
-- Name: getme_cards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.getme_cards ALTER COLUMN id SET DEFAULT nextval('public.getme_cards_id_seq'::regclass);


--
-- Name: grocery_ledger_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_ledger_entries ALTER COLUMN id SET DEFAULT nextval('public.grocery_ledger_entries_id_seq'::regclass);


--
-- Name: grocery_payment_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_attempts ALTER COLUMN id SET DEFAULT nextval('public.grocery_payment_attempts_id_seq'::regclass);


--
-- Name: grocery_reservations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_reservations ALTER COLUMN id SET DEFAULT nextval('public.grocery_reservations_id_seq'::regclass);


--
-- Name: order_cancellations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_cancellations ALTER COLUMN id SET DEFAULT nextval('public.order_cancellations_id_seq'::regclass);


--
-- Name: order_dispatch_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_dispatch_actions ALTER COLUMN id SET DEFAULT nextval('public.order_dispatch_actions_id_seq'::regclass);


--
-- Name: order_item_price_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_price_reports ALTER COLUMN id SET DEFAULT nextval('public.order_item_price_reports_id_seq'::regclass);


--
-- Name: order_item_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_requests ALTER COLUMN id SET DEFAULT nextval('public.order_item_requests_id_seq'::regclass);


--
-- Name: order_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items ALTER COLUMN id SET DEFAULT nextval('public.order_items_id_seq'::regclass);


--
-- Name: order_ratings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_ratings ALTER COLUMN id SET DEFAULT nextval('public.order_ratings_id_seq'::regclass);


--
-- Name: order_replacement_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_replacement_items ALTER COLUMN id SET DEFAULT nextval('public.order_replacement_items_id_seq'::regclass);


--
-- Name: order_shop_bills id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_shop_bills ALTER COLUMN id SET DEFAULT nextval('public.order_shop_bills_id_seq'::regclass);


--
-- Name: order_shops id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_shops ALTER COLUMN id SET DEFAULT nextval('public.order_shops_id_seq'::regclass);


--
-- Name: order_support_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_support_notes ALTER COLUMN id SET DEFAULT nextval('public.order_support_notes_id_seq'::regclass);


--
-- Name: orders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders ALTER COLUMN id SET DEFAULT nextval('public.orders_id_seq'::regclass);


--
-- Name: pricing_settings_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_settings_versions ALTER COLUMN id SET DEFAULT nextval('public.pricing_settings_versions_id_seq'::regclass);


--
-- Name: product_catalog id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog ALTER COLUMN id SET DEFAULT nextval('public.product_catalog_id_seq'::regclass);


--
-- Name: product_offer_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_offer_history ALTER COLUMN id SET DEFAULT nextval('public.product_offer_history_id_seq'::regclass);


--
-- Name: product_offers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_offers ALTER COLUMN id SET DEFAULT nextval('public.product_offers_id_seq'::regclass);


--
-- Name: product_price_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history ALTER COLUMN id SET DEFAULT nextval('public.product_price_history_id_seq'::regclass);


--
-- Name: product_stock_movements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_stock_movements ALTER COLUMN id SET DEFAULT nextval('public.product_stock_movements_id_seq'::regclass);


--
-- Name: products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products ALTER COLUMN id SET DEFAULT nextval('public.products_id_seq'::regclass);


--
-- Name: promo_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes ALTER COLUMN id SET DEFAULT nextval('public.promo_codes_id_seq'::regclass);


--
-- Name: promo_redemptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions ALTER COLUMN id SET DEFAULT nextval('public.promo_redemptions_id_seq'::regclass);


--
-- Name: replacement_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_items ALTER COLUMN id SET DEFAULT nextval('public.replacement_items_id_seq'::regclass);


--
-- Name: saved_cards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_cards ALTER COLUMN id SET DEFAULT nextval('public.saved_cards_id_seq'::regclass);


--
-- Name: shop_activity_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_activity_log ALTER COLUMN id SET DEFAULT nextval('public.shop_activity_log_id_seq'::regclass);


--
-- Name: shop_lankaqr_merchants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_lankaqr_merchants ALTER COLUMN id SET DEFAULT nextval('public.shop_lankaqr_merchants_id_seq'::regclass);


--
-- Name: shop_staff id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_staff ALTER COLUMN id SET DEFAULT nextval('public.shop_staff_id_seq'::regclass);


--
-- Name: shopper_activation_codes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_activation_codes ALTER COLUMN id SET DEFAULT nextval('public.shopper_activation_codes_id_seq'::regclass);


--
-- Name: shopper_application_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_application_documents ALTER COLUMN id SET DEFAULT nextval('public.shopper_application_documents_id_seq'::regclass);


--
-- Name: shopper_application_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_application_events ALTER COLUMN id SET DEFAULT nextval('public.shopper_application_events_id_seq'::regclass);


--
-- Name: shopper_applications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_applications ALTER COLUMN id SET DEFAULT nextval('public.shopper_applications_id_seq'::regclass);


--
-- Name: shopper_change_request_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_request_documents ALTER COLUMN id SET DEFAULT nextval('public.shopper_change_request_documents_id_seq'::regclass);


--
-- Name: shopper_change_request_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_request_events ALTER COLUMN id SET DEFAULT nextval('public.shopper_change_request_events_id_seq'::regclass);


--
-- Name: shopper_change_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_requests ALTER COLUMN id SET DEFAULT nextval('public.shopper_change_requests_id_seq'::regclass);


--
-- Name: shopper_earnings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_earnings ALTER COLUMN id SET DEFAULT nextval('public.shopper_earnings_id_seq'::regclass);


--
-- Name: shopper_incident_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_incident_events ALTER COLUMN id SET DEFAULT nextval('public.shopper_incident_events_id_seq'::regclass);


--
-- Name: shopper_incidents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_incidents ALTER COLUMN id SET DEFAULT nextval('public.shopper_incidents_id_seq'::regclass);


--
-- Name: shopper_notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_notifications ALTER COLUMN id SET DEFAULT nextval('public.shopper_notifications_id_seq'::regclass);


--
-- Name: shopper_payout_accounts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_payout_accounts ALTER COLUMN id SET DEFAULT nextval('public.shopper_payout_accounts_id_seq'::regclass);


--
-- Name: shopper_payouts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_payouts ALTER COLUMN id SET DEFAULT nextval('public.shopper_payouts_id_seq'::regclass);


--
-- Name: shopper_phone_otps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_phone_otps ALTER COLUMN id SET DEFAULT nextval('public.shopper_phone_otps_id_seq'::regclass);


--
-- Name: shopper_profile_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_profile_history ALTER COLUMN id SET DEFAULT nextval('public.shopper_profile_history_id_seq'::regclass);


--
-- Name: shopper_training_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_training_attempts ALTER COLUMN id SET DEFAULT nextval('public.shopper_training_attempts_id_seq'::regclass);


--
-- Name: shopper_vehicle_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_vehicle_records ALTER COLUMN id SET DEFAULT nextval('public.shopper_vehicle_records_id_seq'::regclass);


--
-- Name: shopper_withdrawal_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawal_events ALTER COLUMN id SET DEFAULT nextval('public.shopper_withdrawal_events_id_seq'::regclass);


--
-- Name: shopper_withdrawals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawals ALTER COLUMN id SET DEFAULT nextval('public.shopper_withdrawals_id_seq'::regclass);


--
-- Name: shoppers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shoppers ALTER COLUMN id SET DEFAULT nextval('public.shoppers_id_seq'::regclass);


--
-- Name: shops id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shops ALTER COLUMN id SET DEFAULT nextval('public.shops_id_seq'::regclass);


--
-- Name: store_payments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payments ALTER COLUMN id SET DEFAULT nextval('public.store_payments_id_seq'::regclass);


--
-- Name: support_case_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_events ALTER COLUMN id SET DEFAULT nextval('public.support_case_events_id_seq'::regclass);


--
-- Name: support_case_photos id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_photos ALTER COLUMN id SET DEFAULT nextval('public.support_case_photos_id_seq'::regclass);


--
-- Name: support_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases ALTER COLUMN id SET DEFAULT nextval('public.support_cases_id_seq'::regclass);


--
-- Name: admin_approval_requests admin_approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_approval_requests
    ADD CONSTRAINT admin_approval_requests_pkey PRIMARY KEY (id);


--
-- Name: admin_audit_log admin_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);


--
-- Name: admin_notification_preferences admin_notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences
    ADD CONSTRAINT admin_notification_preferences_pkey PRIMARY KEY (admin_id);


--
-- Name: admin_notification_settings admin_notification_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_settings
    ADD CONSTRAINT admin_notification_settings_pkey PRIMARY KEY (id);


--
-- Name: admin_notification_states admin_notification_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_states
    ADD CONSTRAINT admin_notification_states_pkey PRIMARY KEY (admin_id, notification_id);


--
-- Name: admin_notifications admin_notifications_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_dedupe_key_key UNIQUE (dedupe_key);


--
-- Name: admin_notifications admin_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_pkey PRIMARY KEY (id);


--
-- Name: admin_security_settings admin_security_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_security_settings
    ADD CONSTRAINT admin_security_settings_pkey PRIMARY KEY (id);


--
-- Name: admins admins_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_email_key UNIQUE (email);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (id);


--
-- Name: card_payment_refunds card_payment_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_payment_refunds
    ADD CONSTRAINT card_payment_refunds_pkey PRIMARY KEY (id);


--
-- Name: card_payments card_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_payments
    ADD CONSTRAINT card_payments_pkey PRIMARY KEY (id);


--
-- Name: card_payments card_payments_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_payments
    ADD CONSTRAINT card_payments_ref_key UNIQUE (ref);


--
-- Name: card_setups card_setups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_setups
    ADD CONSTRAINT card_setups_pkey PRIMARY KEY (id);


--
-- Name: card_setups card_setups_ref_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_setups
    ADD CONSTRAINT card_setups_ref_key UNIQUE (ref);


--
-- Name: cash_settlements cash_settlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_settlements
    ADD CONSTRAINT cash_settlements_pkey PRIMARY KEY (id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_reads chat_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_reads
    ADD CONSTRAINT chat_reads_pkey PRIMARY KEY (order_id, reader_type, reader_id);


--
-- Name: company_bank_account_defaults company_bank_account_defaults_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_defaults
    ADD CONSTRAINT company_bank_account_defaults_pkey PRIMARY KEY (purpose);


--
-- Name: company_bank_account_events company_bank_account_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_events
    ADD CONSTRAINT company_bank_account_events_pkey PRIMARY KEY (id);


--
-- Name: company_bank_account_funding company_bank_account_funding_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_funding
    ADD CONSTRAINT company_bank_account_funding_pkey PRIMARY KEY (method_key);


--
-- Name: company_bank_accounts company_bank_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_pkey PRIMARY KEY (id);


--
-- Name: customer_activity_events customer_activity_events_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_activity_events
    ADD CONSTRAINT customer_activity_events_dedupe_key_key UNIQUE (dedupe_key);


--
-- Name: customer_activity_events customer_activity_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_activity_events
    ADD CONSTRAINT customer_activity_events_pkey PRIMARY KEY (id);


--
-- Name: customer_activity_settings customer_activity_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_activity_settings
    ADD CONSTRAINT customer_activity_settings_pkey PRIMARY KEY (id);


--
-- Name: customer_activity_state customer_activity_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_activity_state
    ADD CONSTRAINT customer_activity_state_pkey PRIMARY KEY (customer_id);


--
-- Name: customer_addresses customer_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_pkey PRIMARY KEY (id);


--
-- Name: customer_controls_settings customer_controls_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_controls_settings
    ADD CONSTRAINT customer_controls_settings_pkey PRIMARY KEY (id);


--
-- Name: customer_credit_entries customer_credit_entries_client_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_entries
    ADD CONSTRAINT customer_credit_entries_client_request_id_key UNIQUE (client_request_id);


--
-- Name: customer_credit_entries customer_credit_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_entries
    ADD CONSTRAINT customer_credit_entries_pkey PRIMARY KEY (id);


--
-- Name: customer_location_points customer_location_points_customer_id_client_point_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_location_points
    ADD CONSTRAINT customer_location_points_customer_id_client_point_id_key UNIQUE (customer_id, client_point_id);


--
-- Name: customer_location_points customer_location_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_location_points
    ADD CONSTRAINT customer_location_points_pkey PRIMARY KEY (id);


--
-- Name: customer_presence customer_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_presence
    ADD CONSTRAINT customer_presence_pkey PRIMARY KEY (id);


--
-- Name: customer_sessions customer_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_sessions
    ADD CONSTRAINT customer_sessions_pkey PRIMARY KEY (id);


--
-- Name: customer_tracking_sessions customer_tracking_sessions_customer_id_client_tracking_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tracking_sessions
    ADD CONSTRAINT customer_tracking_sessions_customer_id_client_tracking_id_key UNIQUE (customer_id, client_tracking_id);


--
-- Name: customer_tracking_sessions customer_tracking_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tracking_sessions
    ADD CONSTRAINT customer_tracking_sessions_pkey PRIMARY KEY (id);


--
-- Name: customers customers_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_email_key UNIQUE (email);


--
-- Name: customers customers_mobile_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_mobile_key UNIQUE (mobile);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: dispatch_settings dispatch_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispatch_settings
    ADD CONSTRAINT dispatch_settings_pkey PRIMARY KEY (id);


--
-- Name: getme_card_loads getme_card_loads_card_id_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.getme_card_loads
    ADD CONSTRAINT getme_card_loads_card_id_reference_key UNIQUE (card_id, reference);


--
-- Name: getme_card_loads getme_card_loads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.getme_card_loads
    ADD CONSTRAINT getme_card_loads_pkey PRIMARY KEY (id);


--
-- Name: getme_cards getme_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.getme_cards
    ADD CONSTRAINT getme_cards_pkey PRIMARY KEY (id);


--
-- Name: grocery_ledger_entries grocery_ledger_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_ledger_entries
    ADD CONSTRAINT grocery_ledger_entries_pkey PRIMARY KEY (id);


--
-- Name: grocery_payment_attempts grocery_payment_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_attempts
    ADD CONSTRAINT grocery_payment_attempts_pkey PRIMARY KEY (id);


--
-- Name: grocery_payment_methods grocery_payment_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_methods
    ADD CONSTRAINT grocery_payment_methods_pkey PRIMARY KEY (key);


--
-- Name: grocery_payment_settings grocery_payment_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_settings
    ADD CONSTRAINT grocery_payment_settings_pkey PRIMARY KEY (id);


--
-- Name: grocery_reservations grocery_reservations_order_id_shop_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_reservations
    ADD CONSTRAINT grocery_reservations_order_id_shop_id_key UNIQUE (order_id, shop_id);


--
-- Name: grocery_reservations grocery_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_reservations
    ADD CONSTRAINT grocery_reservations_pkey PRIMARY KEY (id);


--
-- Name: grocery_shop_payment_methods grocery_shop_payment_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_shop_payment_methods
    ADD CONSTRAINT grocery_shop_payment_methods_pkey PRIMARY KEY (shop_id, method_key);


--
-- Name: order_cancellations order_cancellations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_cancellations
    ADD CONSTRAINT order_cancellations_pkey PRIMARY KEY (id);


--
-- Name: order_dispatch_actions order_dispatch_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_dispatch_actions
    ADD CONSTRAINT order_dispatch_actions_pkey PRIMARY KEY (id);


--
-- Name: order_dispatch_exclusions order_dispatch_exclusions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_dispatch_exclusions
    ADD CONSTRAINT order_dispatch_exclusions_pkey PRIMARY KEY (order_id, shopper_id);


--
-- Name: order_item_price_reports order_item_price_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_price_reports
    ADD CONSTRAINT order_item_price_reports_pkey PRIMARY KEY (id);


--
-- Name: order_item_requests order_item_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_requests
    ADD CONSTRAINT order_item_requests_pkey PRIMARY KEY (id);


--
-- Name: order_items order_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);


--
-- Name: order_ratings order_ratings_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_ratings
    ADD CONSTRAINT order_ratings_order_id_key UNIQUE (order_id);


--
-- Name: order_ratings order_ratings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_ratings
    ADD CONSTRAINT order_ratings_pkey PRIMARY KEY (id);


--
-- Name: order_replacement_items order_replacement_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_replacement_items
    ADD CONSTRAINT order_replacement_items_pkey PRIMARY KEY (id);


--
-- Name: order_shop_bills order_shop_bills_order_id_shop_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_shop_bills
    ADD CONSTRAINT order_shop_bills_order_id_shop_id_key UNIQUE (order_id, shop_id);


--
-- Name: order_shop_bills order_shop_bills_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_shop_bills
    ADD CONSTRAINT order_shop_bills_pkey PRIMARY KEY (id);


--
-- Name: order_shops order_shops_order_id_shop_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_shops
    ADD CONSTRAINT order_shops_order_id_shop_id_key UNIQUE (order_id, shop_id);


--
-- Name: order_shops order_shops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_shops
    ADD CONSTRAINT order_shops_pkey PRIMARY KEY (id);


--
-- Name: order_support_notes order_support_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_support_notes
    ADD CONSTRAINT order_support_notes_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: platform_settings platform_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_pkey PRIMARY KEY (key);


--
-- Name: pricing_settings_versions pricing_settings_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_settings_versions
    ADD CONSTRAINT pricing_settings_versions_pkey PRIMARY KEY (id);


--
-- Name: product_catalog product_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog
    ADD CONSTRAINT product_catalog_pkey PRIMARY KEY (id);


--
-- Name: product_offer_history product_offer_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_offer_history
    ADD CONSTRAINT product_offer_history_pkey PRIMARY KEY (id);


--
-- Name: product_offers product_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_offers
    ADD CONSTRAINT product_offers_pkey PRIMARY KEY (id);


--
-- Name: product_price_history product_price_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_pkey PRIMARY KEY (id);


--
-- Name: product_stock_movements product_stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_stock_movements
    ADD CONSTRAINT product_stock_movements_pkey PRIMARY KEY (id);


--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);


--
-- Name: promo_codes promo_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_code_key UNIQUE (code);


--
-- Name: promo_codes promo_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_pkey PRIMARY KEY (id);


--
-- Name: promo_redemptions promo_redemptions_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_order_id_key UNIQUE (order_id);


--
-- Name: promo_redemptions promo_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_pkey PRIMARY KEY (id);


--
-- Name: push_tokens push_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_tokens
    ADD CONSTRAINT push_tokens_pkey PRIMARY KEY (token);


--
-- Name: replacement_items replacement_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_items
    ADD CONSTRAINT replacement_items_pkey PRIMARY KEY (id);


--
-- Name: saved_cards saved_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_cards
    ADD CONSTRAINT saved_cards_pkey PRIMARY KEY (id);


--
-- Name: shop_activity_log shop_activity_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_activity_log
    ADD CONSTRAINT shop_activity_log_pkey PRIMARY KEY (id);


--
-- Name: shop_lankaqr_merchants shop_lankaqr_merchants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_lankaqr_merchants
    ADD CONSTRAINT shop_lankaqr_merchants_pkey PRIMARY KEY (id);


--
-- Name: shop_lankaqr_merchants shop_lankaqr_merchants_shop_id_merchant_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_lankaqr_merchants
    ADD CONSTRAINT shop_lankaqr_merchants_shop_id_merchant_key_key UNIQUE (shop_id, merchant_key);


--
-- Name: shop_staff shop_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_staff
    ADD CONSTRAINT shop_staff_pkey PRIMARY KEY (id);


--
-- Name: shopper_activation_codes shopper_activation_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_activation_codes
    ADD CONSTRAINT shopper_activation_codes_pkey PRIMARY KEY (id);


--
-- Name: shopper_application_documents shopper_application_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_application_documents
    ADD CONSTRAINT shopper_application_documents_pkey PRIMARY KEY (id);


--
-- Name: shopper_application_events shopper_application_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_application_events
    ADD CONSTRAINT shopper_application_events_pkey PRIMARY KEY (id);


--
-- Name: shopper_applications shopper_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_applications
    ADD CONSTRAINT shopper_applications_pkey PRIMARY KEY (id);


--
-- Name: shopper_applications shopper_applications_shopper_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_applications
    ADD CONSTRAINT shopper_applications_shopper_id_key UNIQUE (shopper_id);


--
-- Name: shopper_cash_limit_state shopper_cash_limit_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_cash_limit_state
    ADD CONSTRAINT shopper_cash_limit_state_pkey PRIMARY KEY (shopper_id);


--
-- Name: shopper_change_request_documents shopper_change_request_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_request_documents
    ADD CONSTRAINT shopper_change_request_documents_pkey PRIMARY KEY (id);


--
-- Name: shopper_change_request_events shopper_change_request_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_request_events
    ADD CONSTRAINT shopper_change_request_events_pkey PRIMARY KEY (id);


--
-- Name: shopper_change_requests shopper_change_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_requests
    ADD CONSTRAINT shopper_change_requests_pkey PRIMARY KEY (id);


--
-- Name: shopper_compliance_alerts shopper_compliance_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_compliance_alerts
    ADD CONSTRAINT shopper_compliance_alerts_pkey PRIMARY KEY (shopper_id, document, threshold, expiry_date);


--
-- Name: shopper_earnings shopper_earnings_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_earnings
    ADD CONSTRAINT shopper_earnings_order_id_key UNIQUE (order_id);


--
-- Name: shopper_earnings shopper_earnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_earnings
    ADD CONSTRAINT shopper_earnings_pkey PRIMARY KEY (id);


--
-- Name: shopper_incident_events shopper_incident_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_incident_events
    ADD CONSTRAINT shopper_incident_events_pkey PRIMARY KEY (id);


--
-- Name: shopper_incidents shopper_incidents_client_request_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_incidents
    ADD CONSTRAINT shopper_incidents_client_request_id_key UNIQUE (client_request_id);


--
-- Name: shopper_incidents shopper_incidents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_incidents
    ADD CONSTRAINT shopper_incidents_pkey PRIMARY KEY (id);


--
-- Name: shopper_notifications shopper_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_notifications
    ADD CONSTRAINT shopper_notifications_pkey PRIMARY KEY (id);


--
-- Name: shopper_order_offers shopper_order_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_order_offers
    ADD CONSTRAINT shopper_order_offers_pkey PRIMARY KEY (shopper_id, order_id);


--
-- Name: shopper_payout_accounts shopper_payout_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_payout_accounts
    ADD CONSTRAINT shopper_payout_accounts_pkey PRIMARY KEY (id);


--
-- Name: shopper_payouts shopper_payouts_kind_reference_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_payouts
    ADD CONSTRAINT shopper_payouts_kind_reference_key UNIQUE (kind, reference);


--
-- Name: shopper_payouts shopper_payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_payouts
    ADD CONSTRAINT shopper_payouts_pkey PRIMARY KEY (id);


--
-- Name: shopper_phone_otps shopper_phone_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_phone_otps
    ADD CONSTRAINT shopper_phone_otps_pkey PRIMARY KEY (id);


--
-- Name: shopper_profile_history shopper_profile_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_profile_history
    ADD CONSTRAINT shopper_profile_history_pkey PRIMARY KEY (id);


--
-- Name: shopper_training_attempts shopper_training_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_training_attempts
    ADD CONSTRAINT shopper_training_attempts_pkey PRIMARY KEY (id);


--
-- Name: shopper_training_settings shopper_training_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_training_settings
    ADD CONSTRAINT shopper_training_settings_pkey PRIMARY KEY (id);


--
-- Name: shopper_vehicle_records shopper_vehicle_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_vehicle_records
    ADD CONSTRAINT shopper_vehicle_records_pkey PRIMARY KEY (id);


--
-- Name: shopper_withdrawal_events shopper_withdrawal_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawal_events
    ADD CONSTRAINT shopper_withdrawal_events_pkey PRIMARY KEY (id);


--
-- Name: shopper_withdrawals shopper_withdrawals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawals
    ADD CONSTRAINT shopper_withdrawals_pkey PRIMARY KEY (id);


--
-- Name: shoppers shoppers_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shoppers
    ADD CONSTRAINT shoppers_email_key UNIQUE (email);


--
-- Name: shoppers shoppers_mobile_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shoppers
    ADD CONSTRAINT shoppers_mobile_key UNIQUE (mobile);


--
-- Name: shoppers shoppers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shoppers
    ADD CONSTRAINT shoppers_pkey PRIMARY KEY (id);


--
-- Name: shops shops_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shops
    ADD CONSTRAINT shops_email_key UNIQUE (email);


--
-- Name: shops shops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shops
    ADD CONSTRAINT shops_pkey PRIMARY KEY (id);


--
-- Name: store_payments store_payments_order_id_shop_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payments
    ADD CONSTRAINT store_payments_order_id_shop_id_key UNIQUE (order_id, shop_id);


--
-- Name: store_payments store_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payments
    ADD CONSTRAINT store_payments_pkey PRIMARY KEY (id);


--
-- Name: support_case_events support_case_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_events
    ADD CONSTRAINT support_case_events_pkey PRIMARY KEY (id);


--
-- Name: support_case_photos support_case_photos_file_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_photos
    ADD CONSTRAINT support_case_photos_file_name_key UNIQUE (file_name);


--
-- Name: support_case_photos support_case_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_photos
    ADD CONSTRAINT support_case_photos_pkey PRIMARY KEY (id);


--
-- Name: support_cases support_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_pkey PRIMARY KEY (id);


--
-- Name: admin_approval_requests_pending_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_approval_requests_pending_entity_idx ON public.admin_approval_requests USING btree (action_type, entity_type, entity_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: admin_approval_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_approval_requests_status_idx ON public.admin_approval_requests USING btree (status, requested_at DESC);


--
-- Name: admin_audit_log_admin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_admin_idx ON public.admin_audit_log USING btree (admin_id, created_at DESC);


--
-- Name: admin_audit_log_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_created_idx ON public.admin_audit_log USING btree (created_at DESC);


--
-- Name: admin_audit_log_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_entity_idx ON public.admin_audit_log USING btree (entity_type, entity_id);


--
-- Name: admin_audit_log_outcome_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_audit_log_outcome_idx ON public.admin_audit_log USING btree (outcome, created_at DESC);


--
-- Name: admin_notification_states_notification_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_notification_states_notification_idx ON public.admin_notification_states USING btree (notification_id);


--
-- Name: admin_notifications_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_notifications_category_idx ON public.admin_notifications USING btree (category, created_at DESC);


--
-- Name: admin_notifications_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_notifications_created_idx ON public.admin_notifications USING btree (created_at DESC);


--
-- Name: admin_notifications_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_notifications_target_idx ON public.admin_notifications USING btree (target_admin_id) WHERE (target_admin_id IS NOT NULL);


--
-- Name: card_payment_refunds_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_payment_refunds_payment_idx ON public.card_payment_refunds USING btree (card_payment_id);


--
-- Name: card_payments_order_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_payments_order_id_idx ON public.card_payments USING btree (order_id) WHERE (order_id IS NOT NULL);


--
-- Name: card_payments_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_payments_order_idx ON public.card_payments USING btree (order_id);


--
-- Name: card_payments_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX card_payments_owner_idx ON public.card_payments USING btree (owner_type, owner_id);


--
-- Name: card_payments_store_bill_once; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX card_payments_store_bill_once ON public.card_payments USING btree (order_id, shop_id) WHERE (((purpose)::text = 'store_bill'::text) AND ((status)::text = ANY ((ARRAY['paid'::character varying, 'pending'::character varying])::text[])) AND (abandoned_at IS NULL));


--
-- Name: cash_settlements_reference_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cash_settlements_reference_key ON public.cash_settlements USING btree (lower((reference)::text)) WHERE (reference IS NOT NULL);


--
-- Name: cash_settlements_request_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cash_settlements_request_key ON public.cash_settlements USING btree (shopper_id, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: cash_settlements_shopper_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cash_settlements_shopper_idx ON public.cash_settlements USING btree (shopper_id, created_at DESC);


--
-- Name: chat_messages_order_sender_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_order_sender_idx ON public.chat_messages USING btree (order_id, sender_type, id);


--
-- Name: company_bank_account_events_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_bank_account_events_account_idx ON public.company_bank_account_events USING btree (account_id, id DESC);


--
-- Name: company_bank_account_events_reveal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_bank_account_events_reveal_idx ON public.company_bank_account_events USING btree (actor_admin_id, created_at) WHERE ((action)::text = 'reveal'::text);


--
-- Name: company_bank_accounts_number_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX company_bank_accounts_number_idx ON public.company_bank_accounts USING btree (account_number_hash) WHERE ((status)::text <> 'archived'::text);


--
-- Name: company_bank_accounts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_bank_accounts_status_idx ON public.company_bank_accounts USING btree (status, id);


--
-- Name: customer_activity_state_last_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_activity_state_last_idx ON public.customer_activity_state USING btree (last_activity_at DESC NULLS LAST);


--
-- Name: customer_credit_entries_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_credit_entries_case_idx ON public.customer_credit_entries USING btree (support_case_id) WHERE (support_case_id IS NOT NULL);


--
-- Name: customer_credit_entries_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_credit_entries_customer_idx ON public.customer_credit_entries USING btree (customer_id, created_at DESC);


--
-- Name: customer_credit_entries_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_credit_entries_order_idx ON public.customer_credit_entries USING btree (order_id) WHERE (order_id IS NOT NULL);


--
-- Name: customer_credit_entries_order_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_credit_entries_order_kind_idx ON public.customer_credit_entries USING btree (order_id, kind) WHERE (order_id IS NOT NULL);


--
-- Name: customer_events_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_events_category_idx ON public.customer_activity_events USING btree (customer_id, category, occurred_at DESC);


--
-- Name: customer_events_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_events_customer_idx ON public.customer_activity_events USING btree (customer_id, occurred_at DESC, id DESC);


--
-- Name: customer_events_recorded_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_events_recorded_idx ON public.customer_activity_events USING btree (recorded_at);


--
-- Name: customer_points_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_points_customer_idx ON public.customer_location_points USING btree (customer_id, recorded_at DESC);


--
-- Name: customer_points_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_points_order_idx ON public.customer_location_points USING btree (order_id, recorded_at) WHERE (order_id IS NOT NULL);


--
-- Name: customer_points_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_points_received_idx ON public.customer_location_points USING btree (received_at);


--
-- Name: customer_points_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_points_session_idx ON public.customer_location_points USING btree (tracking_session_id, recorded_at);


--
-- Name: customer_presence_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_presence_customer_idx ON public.customer_presence USING btree (customer_id, started_at DESC);


--
-- Name: customer_presence_install_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_presence_install_idx ON public.customer_presence USING btree (customer_id, install_id) WHERE ((state)::text <> 'ended'::text);


--
-- Name: customer_presence_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_presence_open_idx ON public.customer_presence USING btree (state, state_changed_at) WHERE ((state)::text <> 'ended'::text);


--
-- Name: customer_presence_open_visit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customer_presence_open_visit_idx ON public.customer_presence USING btree (customer_id, visit_id) WHERE ((state)::text <> 'ended'::text);


--
-- Name: customer_sessions_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_sessions_customer_idx ON public.customer_sessions USING btree (customer_id, started_at DESC);


--
-- Name: customer_sessions_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_sessions_open_idx ON public.customer_sessions USING btree (expires_at) WHERE (ended_at IS NULL);


--
-- Name: customer_tracking_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_tracking_customer_idx ON public.customer_tracking_sessions USING btree (customer_id, started_at DESC);


--
-- Name: customer_tracking_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_tracking_open_idx ON public.customer_tracking_sessions USING btree (last_point_at) WHERE (ended_at IS NULL);


--
-- Name: customer_tracking_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_tracking_order_idx ON public.customer_tracking_sessions USING btree (order_id) WHERE (order_id IS NOT NULL);


--
-- Name: customers_account_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_account_status_idx ON public.customers USING btree (account_status) WHERE ((account_status)::text <> 'active'::text);


--
-- Name: getme_cards_issuer_last4_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX getme_cards_issuer_last4_idx ON public.getme_cards USING btree (lower((issuer)::text), last4) WHERE ((status)::text <> 'retired'::text);


--
-- Name: getme_cards_shopper_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX getme_cards_shopper_active_idx ON public.getme_cards USING btree (shopper_id) WHERE (((status)::text = 'active'::text) AND (shopper_id IS NOT NULL));


--
-- Name: grocery_ledger_capture_once_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX grocery_ledger_capture_once_idx ON public.grocery_ledger_entries USING btree (entry_type, attempt_id) WHERE ((entry_type)::text = ANY ((ARRAY['capture'::character varying, 'reverse'::character varying])::text[]));


--
-- Name: grocery_ledger_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grocery_ledger_order_idx ON public.grocery_ledger_entries USING btree (order_id, created_at);


--
-- Name: grocery_ledger_release_once_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX grocery_ledger_release_once_idx ON public.grocery_ledger_entries USING btree (reservation_id) WHERE ((entry_type)::text = 'release'::text);


--
-- Name: grocery_payment_attempts_card_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grocery_payment_attempts_card_idx ON public.grocery_payment_attempts USING btree (card_id) WHERE (card_id IS NOT NULL);


--
-- Name: grocery_payment_attempts_funding_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grocery_payment_attempts_funding_open_idx ON public.grocery_payment_attempts USING btree (funding_account_id) WHERE ((funding_account_id IS NOT NULL) AND ((status)::text = ANY ((ARRAY['pending'::character varying, 'unknown'::character varying])::text[])));


--
-- Name: grocery_payment_attempts_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX grocery_payment_attempts_live_idx ON public.grocery_payment_attempts USING btree (order_id, shop_id) WHERE ((status)::text = ANY ((ARRAY['pending'::character varying, 'succeeded'::character varying, 'disputed'::character varying, 'unknown'::character varying])::text[]));


--
-- Name: grocery_payment_attempts_provider_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grocery_payment_attempts_provider_open_idx ON public.grocery_payment_attempts USING btree (status, last_checked_at) WHERE ((provider IS NOT NULL) AND ((status)::text = ANY ((ARRAY['pending'::character varying, 'unknown'::character varying])::text[])));


--
-- Name: grocery_payment_attempts_provider_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX grocery_payment_attempts_provider_ref_idx ON public.grocery_payment_attempts USING btree (provider, provider_ref) WHERE (provider_ref IS NOT NULL);


--
-- Name: grocery_payment_attempts_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX grocery_payment_attempts_request_idx ON public.grocery_payment_attempts USING btree (shopper_id, request_id) WHERE (request_id IS NOT NULL);


--
-- Name: grocery_payment_attempts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grocery_payment_attempts_status_idx ON public.grocery_payment_attempts USING btree (status, reconciliation_status);


--
-- Name: grocery_reservations_shopper_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grocery_reservations_shopper_idx ON public.grocery_reservations USING btree (shopper_id, status);


--
-- Name: idx_chat_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_created_at ON public.chat_messages USING btree (created_at);


--
-- Name: idx_chat_messages_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chat_messages_order_id ON public.chat_messages USING btree (order_id);


--
-- Name: idx_customer_addresses_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_addresses_customer ON public.customer_addresses USING btree (customer_id, last_used_at DESC);


--
-- Name: idx_order_items_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_items_order_id ON public.order_items USING btree (order_id);


--
-- Name: idx_order_ratings_shopper; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_ratings_shopper ON public.order_ratings USING btree (shopper_id);


--
-- Name: idx_order_shop_bills_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_shop_bills_order_id ON public.order_shop_bills USING btree (order_id);


--
-- Name: idx_order_shop_bills_shop_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_order_shop_bills_shop_id ON public.order_shop_bills USING btree (shop_id);


--
-- Name: idx_orders_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_customer_id ON public.orders USING btree (customer_id);


--
-- Name: idx_orders_shop_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_shop_id ON public.orders USING btree (shop_id);


--
-- Name: idx_orders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_orders_status ON public.orders USING btree (status);


--
-- Name: idx_products_shop_barcode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_products_shop_barcode ON public.products USING btree (shop_id, barcode) WHERE (barcode IS NOT NULL);


--
-- Name: idx_promo_redemptions_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_promo_redemptions_customer ON public.promo_redemptions USING btree (customer_id, promo_id);


--
-- Name: idx_promo_redemptions_promo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_promo_redemptions_promo ON public.promo_redemptions USING btree (promo_id);


--
-- Name: idx_replacement_items_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_replacement_items_order_id ON public.replacement_items USING btree (order_id);


--
-- Name: idx_replacement_items_original_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_replacement_items_original_item_id ON public.replacement_items USING btree (original_item_id);


--
-- Name: idx_replacement_items_shopper_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_replacement_items_shopper_id ON public.replacement_items USING btree (shopper_id);


--
-- Name: idx_shopper_notifications_shopper; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shopper_notifications_shopper ON public.shopper_notifications USING btree (shopper_id, created_at DESC);


--
-- Name: idx_shoppers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shoppers_status ON public.shoppers USING btree (status);


--
-- Name: offer_history_offer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX offer_history_offer_idx ON public.product_offer_history USING btree (offer_id, created_at DESC);


--
-- Name: offer_history_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX offer_history_shop_idx ON public.product_offer_history USING btree (shop_id, created_at DESC);


--
-- Name: order_cancellations_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_cancellations_created_idx ON public.order_cancellations USING btree (created_at DESC);


--
-- Name: order_dispatch_actions_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_dispatch_actions_order_idx ON public.order_dispatch_actions USING btree (order_id, created_at DESC);


--
-- Name: order_item_requests_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_item_requests_order_idx ON public.order_item_requests USING btree (order_id, status);


--
-- Name: order_items_offer_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_items_offer_id_idx ON public.order_items USING btree (offer_id) WHERE (offer_id IS NOT NULL);


--
-- Name: order_shop_bills_hashes_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_shop_bills_hashes_idx ON public.order_shop_bills USING gin (bill_hashes);


--
-- Name: order_support_notes_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_support_notes_order_idx ON public.order_support_notes USING btree (order_id, created_at);


--
-- Name: orders_customer_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_customer_created_idx ON public.orders USING btree (customer_id, created_at);


--
-- Name: orders_delivered_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_delivered_at_idx ON public.orders USING btree (delivered_at) WHERE (delivered_at IS NOT NULL);


--
-- Name: price_history_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_history_product_idx ON public.product_price_history USING btree (product_id, created_at DESC);


--
-- Name: price_history_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_history_shop_idx ON public.product_price_history USING btree (shop_id, created_at DESC);


--
-- Name: price_reports_admin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_reports_admin_idx ON public.order_item_price_reports USING btree (admin_status, created_at DESC);


--
-- Name: price_reports_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_reports_order_idx ON public.order_item_price_reports USING btree (order_id);


--
-- Name: pricing_settings_versions_effective_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pricing_settings_versions_effective_idx ON public.pricing_settings_versions USING btree (effective_from DESC, id DESC) WHERE (cancelled_at IS NULL);


--
-- Name: product_offers_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_offers_live_idx ON public.product_offers USING btree (shop_id, starts_at, ends_at) WHERE (is_active AND (NOT paused_by_admin));


--
-- Name: product_offers_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_offers_product_idx ON public.product_offers USING btree (product_id);


--
-- Name: product_offers_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX product_offers_shop_idx ON public.product_offers USING btree (shop_id);


--
-- Name: products_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX products_shop_idx ON public.products USING btree (shop_id, category);


--
-- Name: promo_redemptions_promo_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX promo_redemptions_promo_id_idx ON public.promo_redemptions USING btree (promo_id);


--
-- Name: push_tokens_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_tokens_owner_idx ON public.push_tokens USING btree (owner_type, owner_id);


--
-- Name: saved_cards_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX saved_cards_owner_idx ON public.saved_cards USING btree (owner_type, owner_id) WHERE (deleted_at IS NULL);


--
-- Name: shop_activity_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shop_activity_shop_idx ON public.shop_activity_log USING btree (shop_id, created_at DESC);


--
-- Name: shop_lankaqr_merchants_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shop_lankaqr_merchants_account_idx ON public.shop_lankaqr_merchants USING btree (account_hash);


--
-- Name: shop_lankaqr_merchants_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shop_lankaqr_merchants_status_idx ON public.shop_lankaqr_merchants USING btree (status, created_at);


--
-- Name: shop_staff_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shop_staff_shop_idx ON public.shop_staff USING btree (shop_id);


--
-- Name: shopper_activation_codes_shopper_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_activation_codes_shopper_idx ON public.shopper_activation_codes USING btree (shopper_id, created_at DESC);


--
-- Name: shopper_application_documents_current_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_application_documents_current_key ON public.shopper_application_documents USING btree (application_id, doc_type) WHERE ((replaced_at IS NULL) AND (deleted_at IS NULL));


--
-- Name: shopper_application_events_app_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_application_events_app_idx ON public.shopper_application_events USING btree (application_id, created_at);


--
-- Name: shopper_applications_nic_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_applications_nic_key ON public.shopper_applications USING btree (nic_hash) WHERE ((nic_hash IS NOT NULL) AND ((status)::text <> 'rejected'::text));


--
-- Name: shopper_applications_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_applications_status_idx ON public.shopper_applications USING btree (status, submitted_at DESC);


--
-- Name: shopper_change_request_documents_current_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_change_request_documents_current_key ON public.shopper_change_request_documents USING btree (request_id, doc_type) WHERE ((replaced_at IS NULL) AND (deleted_at IS NULL));


--
-- Name: shopper_change_request_events_req_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_change_request_events_req_idx ON public.shopper_change_request_events USING btree (request_id, created_at);


--
-- Name: shopper_change_requests_client_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_change_requests_client_key ON public.shopper_change_requests USING btree (shopper_id, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: shopper_change_requests_open_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_change_requests_open_key ON public.shopper_change_requests USING btree (shopper_id, (
CASE
    WHEN ((type)::text = 'phone_recovery'::text) THEN 'phone_change'::character varying
    ELSE type
END)) WHERE ((status)::text = ANY ((ARRAY['draft'::character varying, 'pending_verification'::character varying, 'pending_review'::character varying, 'more_info_required'::character varying])::text[]));


--
-- Name: shopper_change_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_change_requests_status_idx ON public.shopper_change_requests USING btree (status, submitted_at);


--
-- Name: shopper_earnings_shopper_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_earnings_shopper_idx ON public.shopper_earnings USING btree (shopper_id, status);


--
-- Name: shopper_incident_events_incident; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_incident_events_incident ON public.shopper_incident_events USING btree (incident_id, created_at);


--
-- Name: shopper_incidents_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_incidents_one_open ON public.shopper_incidents USING btree (shopper_id, type, COALESCE(order_id, 0)) WHERE ((status)::text <> 'resolved'::text);


--
-- Name: shopper_incidents_shopper; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_incidents_shopper ON public.shopper_incidents USING btree (shopper_id, created_at DESC);


--
-- Name: shopper_incidents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_incidents_status ON public.shopper_incidents USING btree (status, created_at DESC);


--
-- Name: shopper_payout_accounts_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_payout_accounts_status_idx ON public.shopper_payout_accounts USING btree (status) WHERE (deleted_at IS NULL);


--
-- Name: shopper_payout_accounts_unique_number; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_payout_accounts_unique_number ON public.shopper_payout_accounts USING btree (shopper_id, account_number_hash) WHERE (deleted_at IS NULL);


--
-- Name: shopper_payouts_shopper_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_payouts_shopper_idx ON public.shopper_payouts USING btree (shopper_id);


--
-- Name: shopper_phone_otps_mobile_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_phone_otps_mobile_idx ON public.shopper_phone_otps USING btree (mobile, created_at DESC);


--
-- Name: shopper_profile_history_shopper_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_profile_history_shopper_idx ON public.shopper_profile_history USING btree (shopper_id, created_at DESC);


--
-- Name: shopper_training_attempts_shopper; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_training_attempts_shopper ON public.shopper_training_attempts USING btree (shopper_id, created_at DESC);


--
-- Name: shopper_vehicle_records_current_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_vehicle_records_current_key ON public.shopper_vehicle_records USING btree (shopper_id) WHERE (superseded_at IS NULL);


--
-- Name: shopper_vehicle_records_shopper_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_vehicle_records_shopper_idx ON public.shopper_vehicle_records USING btree (shopper_id, approved_at DESC);


--
-- Name: shopper_withdrawal_events_withdrawal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_withdrawal_events_withdrawal_idx ON public.shopper_withdrawal_events USING btree (withdrawal_id, id);


--
-- Name: shopper_withdrawals_reference_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_withdrawals_reference_key ON public.shopper_withdrawals USING btree (reference) WHERE (reference IS NOT NULL);


--
-- Name: shopper_withdrawals_request_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shopper_withdrawals_request_key ON public.shopper_withdrawals USING btree (shopper_id, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: shopper_withdrawals_shopper_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_withdrawals_shopper_idx ON public.shopper_withdrawals USING btree (shopper_id, requested_at DESC);


--
-- Name: shopper_withdrawals_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shopper_withdrawals_status_idx ON public.shopper_withdrawals USING btree (status, requested_at DESC);


--
-- Name: shoppers_shopper_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shoppers_shopper_code_key ON public.shoppers USING btree (shopper_code);


--
-- Name: shops_account_manager_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shops_account_manager_idx ON public.shops USING btree (account_manager_admin_id) WHERE (account_manager_admin_id IS NOT NULL);


--
-- Name: stock_moves_product_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_moves_product_idx ON public.product_stock_movements USING btree (product_id, created_at DESC);


--
-- Name: stock_moves_shop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX stock_moves_shop_idx ON public.product_stock_movements USING btree (shop_id, created_at DESC);


--
-- Name: store_payments_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_payments_review_idx ON public.store_payments USING btree (reimbursement_status, review_status);


--
-- Name: store_payments_shop_reference_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_payments_shop_reference_idx ON public.store_payments USING btree (shop_id, lower((reference)::text)) WHERE (reference IS NOT NULL);


--
-- Name: store_payments_shopper_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX store_payments_shopper_idx ON public.store_payments USING btree (shopper_id);


--
-- Name: support_case_events_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_case_events_case_idx ON public.support_case_events USING btree (case_id, id);


--
-- Name: support_case_events_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX support_case_events_request_idx ON public.support_case_events USING btree (case_id, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: support_case_photos_case_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_case_photos_case_idx ON public.support_case_photos USING btree (case_id, id);


--
-- Name: support_cases_assigned_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_cases_assigned_idx ON public.support_cases USING btree (assigned_admin_id) WHERE (assigned_admin_id IS NOT NULL);


--
-- Name: support_cases_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_cases_customer_idx ON public.support_cases USING btree (customer_id, created_at DESC);


--
-- Name: support_cases_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_cases_due_idx ON public.support_cases USING btree (first_response_due_at) WHERE ((first_response_at IS NULL) AND ((status)::text <> ALL ((ARRAY['resolved'::character varying, 'declined'::character varying])::text[])));


--
-- Name: support_cases_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_cases_order_idx ON public.support_cases USING btree (order_id);


--
-- Name: support_cases_request_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX support_cases_request_idx ON public.support_cases USING btree (customer_id, client_request_id);


--
-- Name: support_cases_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_cases_status_idx ON public.support_cases USING btree (status, created_at DESC);


--
-- Name: uq_order_cancellations_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_order_cancellations_order ON public.order_cancellations USING btree (order_id);


--
-- Name: uq_orders_client_request; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_orders_client_request ON public.orders USING btree (customer_id, client_request_id) WHERE (client_request_id IS NOT NULL);


--
-- Name: uq_price_report_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_price_report_pending ON public.order_item_price_reports USING btree (order_item_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: uq_product_catalog_barcode_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_product_catalog_barcode_key ON public.product_catalog USING btree (barcode_key);


--
-- Name: uq_products_shop_barcode_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_products_shop_barcode_key ON public.products USING btree (shop_id, ltrim((barcode)::text, '0'::text)) WHERE (barcode IS NOT NULL);


--
-- Name: uq_shop_staff_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_shop_staff_email ON public.shop_staff USING btree (lower((email)::text));


--
-- Name: uq_stock_moves_getme_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_stock_moves_getme_item ON public.product_stock_movements USING btree (order_item_id) WHERE ((reason)::text = 'sold_getme'::text);


--
-- Name: admin_approval_requests admin_approval_requests_admin_notify_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER admin_approval_requests_admin_notify_insert AFTER INSERT ON public.admin_approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_approvals();


--
-- Name: admin_approval_requests admin_approval_requests_admin_notify_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER admin_approval_requests_admin_notify_update AFTER UPDATE OF status ON public.admin_approval_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.status)::text IS DISTINCT FROM (new.status)::text)) EXECUTE FUNCTION public.admin_notify_approvals();


--
-- Name: admin_audit_log admin_audit_log_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER admin_audit_log_admin_notify AFTER INSERT ON public.admin_audit_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_audit();


--
-- Name: admin_audit_log admin_audit_log_no_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER admin_audit_log_no_change BEFORE DELETE OR UPDATE ON public.admin_audit_log FOR EACH ROW EXECUTE FUNCTION public.admin_audit_log_immutable();


--
-- Name: card_payment_refunds card_payment_refunds_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_payment_refunds_activity AFTER INSERT ON public.card_payment_refunds FOR EACH ROW EXECUTE FUNCTION public.customer_activity_refunds();


--
-- Name: card_payment_refunds card_payment_refunds_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_payment_refunds_admin_notify AFTER INSERT ON public.card_payment_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_refunds();


--
-- Name: card_payments card_payments_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER card_payments_activity AFTER INSERT OR UPDATE OF status ON public.card_payments FOR EACH ROW EXECUTE FUNCTION public.customer_activity_card_payments();


--
-- Name: card_payments card_payments_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_payments_admin_notify AFTER UPDATE OF status ON public.card_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((((old.status)::text IS DISTINCT FROM (new.status)::text) AND ((new.status)::text = ANY ((ARRAY['paid'::character varying, 'failed'::character varying])::text[])))) EXECUTE FUNCTION public.admin_notify_card_payments();


--
-- Name: card_payments card_payments_admin_notify_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER card_payments_admin_notify_insert AFTER INSERT ON public.card_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.status)::text = ANY ((ARRAY['paid'::character varying, 'failed'::character varying])::text[]))) EXECUTE FUNCTION public.admin_notify_card_payments();


--
-- Name: company_bank_account_defaults company_bank_account_defaults_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER company_bank_account_defaults_guard BEFORE INSERT OR UPDATE ON public.company_bank_account_defaults FOR EACH ROW EXECUTE FUNCTION public.company_bank_account_defaults_guard();


--
-- Name: company_bank_account_events company_bank_account_events_no_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER company_bank_account_events_no_change BEFORE DELETE OR UPDATE ON public.company_bank_account_events FOR EACH ROW EXECUTE FUNCTION public.company_bank_account_events_immutable();


--
-- Name: company_bank_account_funding company_bank_account_funding_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER company_bank_account_funding_guard BEFORE INSERT OR UPDATE ON public.company_bank_account_funding FOR EACH ROW EXECUTE FUNCTION public.company_bank_account_funding_guard();


--
-- Name: company_bank_accounts company_bank_accounts_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER company_bank_accounts_guard BEFORE DELETE OR UPDATE ON public.company_bank_accounts FOR EACH ROW EXECUTE FUNCTION public.company_bank_accounts_guard();


--
-- Name: customer_activity_events customer_activity_events_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customer_activity_events_no_update BEFORE UPDATE ON public.customer_activity_events FOR EACH ROW EXECUTE FUNCTION public.customer_activity_no_update();


--
-- Name: customer_addresses customer_addresses_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customer_addresses_activity AFTER INSERT OR DELETE OR UPDATE OF label, address, unit, building, instructions, latitude, longitude ON public.customer_addresses FOR EACH ROW EXECUTE FUNCTION public.customer_activity_addresses();


--
-- Name: customer_credit_entries customer_credit_entries_no_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customer_credit_entries_no_change BEFORE DELETE OR UPDATE ON public.customer_credit_entries FOR EACH ROW EXECUTE FUNCTION public.customer_credit_entries_no_change();


--
-- Name: customer_location_points customer_location_points_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customer_location_points_no_update BEFORE UPDATE ON public.customer_location_points FOR EACH ROW EXECUTE FUNCTION public.customer_activity_no_update();


--
-- Name: customers customers_activity_cleanup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customers_activity_cleanup BEFORE DELETE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.customer_activity_cleanup();


--
-- Name: customers customers_activity_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER customers_activity_insert AFTER INSERT ON public.customers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.customer_activity_customers();


--
-- Name: customers customers_activity_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customers_activity_update AFTER UPDATE OF full_name, mobile, email, password_hash, account_status ON public.customers FOR EACH ROW EXECUTE FUNCTION public.customer_activity_customers();


--
-- Name: customers customers_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER customers_admin_notify AFTER INSERT ON public.customers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_customers();


--
-- Name: grocery_payment_attempts grocery_payment_attempts_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER grocery_payment_attempts_admin_notify AFTER UPDATE OF status, reconciliation_status ON public.grocery_payment_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((((old.status)::text IS DISTINCT FROM (new.status)::text) OR ((old.reconciliation_status)::text IS DISTINCT FROM (new.reconciliation_status)::text))) EXECUTE FUNCTION public.admin_notify_grocery_attempts();


--
-- Name: order_item_price_reports order_item_price_reports_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER order_item_price_reports_admin_notify AFTER INSERT ON public.order_item_price_reports DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_price_reports();


--
-- Name: order_support_notes order_support_notes_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER order_support_notes_admin_notify AFTER INSERT ON public.order_support_notes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.category)::text <> 'general'::text)) EXECUTE FUNCTION public.admin_notify_support_notes();


--
-- Name: order_support_notes order_support_notes_no_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER order_support_notes_no_change BEFORE UPDATE ON public.order_support_notes FOR EACH ROW EXECUTE FUNCTION public.order_support_notes_immutable();


--
-- Name: orders orders_activity_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER orders_activity_insert AFTER INSERT ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.customer_activity_orders();


--
-- Name: orders orders_activity_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orders_activity_update AFTER UPDATE OF status, payment_status ON public.orders FOR EACH ROW WHEN ((((old.status)::text IS DISTINCT FROM (new.status)::text) OR ((old.payment_status)::text IS DISTINCT FROM (new.payment_status)::text))) EXECUTE FUNCTION public.customer_activity_orders();


--
-- Name: orders orders_admin_notify_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER orders_admin_notify_insert AFTER INSERT ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_orders();


--
-- Name: orders orders_admin_notify_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER orders_admin_notify_update AFTER UPDATE OF status ON public.orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.status)::text IS DISTINCT FROM (new.status)::text)) EXECUTE FUNCTION public.admin_notify_orders();


--
-- Name: products products_admin_notify_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_admin_notify_insert AFTER INSERT ON public.products REFERENCING NEW TABLE AS new_products FOR EACH STATEMENT EXECUTE FUNCTION public.admin_notify_products_added();


--
-- Name: products products_admin_notify_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER products_admin_notify_update AFTER UPDATE ON public.products REFERENCING OLD TABLE AS old_products NEW TABLE AS new_products FOR EACH STATEMENT EXECUTE FUNCTION public.admin_notify_products_unavailable();


--
-- Name: shop_activity_log shop_activity_log_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shop_activity_log_admin_notify AFTER INSERT ON public.shop_activity_log DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.action)::text = 'product.import_failed'::text)) EXECUTE FUNCTION public.admin_notify_shop_activity();


--
-- Name: shopper_applications shopper_applications_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shopper_applications_admin_notify AFTER UPDATE OF status ON public.shopper_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.status)::text IS DISTINCT FROM (new.status)::text)) EXECUTE FUNCTION public.admin_notify_shopper_applications();


--
-- Name: shopper_applications shopper_applications_admin_notify_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shopper_applications_admin_notify_insert AFTER INSERT ON public.shopper_applications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.status)::text = 'submitted'::text)) EXECUTE FUNCTION public.admin_notify_shopper_applications();


--
-- Name: shopper_change_requests shopper_change_requests_admin_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shopper_change_requests_admin_notify AFTER INSERT OR UPDATE OF status ON public.shopper_change_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.status)::text = 'pending_review'::text)) EXECUTE FUNCTION public.admin_notify_shopper_changes();


--
-- Name: shopper_withdrawals shopper_withdrawals_admin_notify_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shopper_withdrawals_admin_notify_insert AFTER INSERT ON public.shopper_withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_withdrawals();


--
-- Name: shopper_withdrawals shopper_withdrawals_admin_notify_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shopper_withdrawals_admin_notify_update AFTER UPDATE OF status ON public.shopper_withdrawals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.status)::text IS DISTINCT FROM (new.status)::text)) EXECUTE FUNCTION public.admin_notify_withdrawals();


--
-- Name: shoppers shoppers_admin_notify_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shoppers_admin_notify_insert AFTER INSERT ON public.shoppers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_shoppers();


--
-- Name: shoppers shoppers_admin_notify_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shoppers_admin_notify_update AFTER UPDATE OF approval_status, status, vehicle_restriction ON public.shoppers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((((old.approval_status)::text IS DISTINCT FROM (new.approval_status)::text) OR ((old.status)::text IS DISTINCT FROM (new.status)::text) OR ((old.vehicle_restriction)::text IS DISTINCT FROM (new.vehicle_restriction)::text))) EXECUTE FUNCTION public.admin_notify_shoppers();


--
-- Name: shoppers shoppers_approved_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER shoppers_approved_at BEFORE INSERT OR UPDATE OF approval_status ON public.shoppers FOR EACH ROW EXECUTE FUNCTION public.shoppers_set_approved_at();


--
-- Name: shoppers shoppers_keep_code; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER shoppers_keep_code BEFORE UPDATE OF shopper_code ON public.shoppers FOR EACH ROW EXECUTE FUNCTION public.keep_shopper_code();


--
-- Name: shops shops_admin_notify_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shops_admin_notify_insert AFTER INSERT ON public.shops DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_shops();


--
-- Name: shops shops_admin_notify_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER shops_admin_notify_update AFTER UPDATE OF status, is_open ON public.shops DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((((old.status)::text IS DISTINCT FROM (new.status)::text) OR (old.is_open IS DISTINCT FROM new.is_open))) EXECUTE FUNCTION public.admin_notify_shops();


--
-- Name: store_payments store_payments_admin_notify_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER store_payments_admin_notify_insert AFTER INSERT ON public.store_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_notify_store_payments();


--
-- Name: store_payments store_payments_admin_notify_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER store_payments_admin_notify_update AFTER UPDATE OF review_status, reimbursement_status ON public.store_payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((((old.review_status)::text IS DISTINCT FROM (new.review_status)::text) OR ((old.reimbursement_status)::text IS DISTINCT FROM (new.reimbursement_status)::text))) EXECUTE FUNCTION public.admin_notify_store_payments();


--
-- Name: support_case_events support_case_events_no_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER support_case_events_no_change BEFORE DELETE OR UPDATE ON public.support_case_events FOR EACH ROW EXECUTE FUNCTION public.support_case_events_no_change();


--
-- Name: support_cases support_cases_activity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER support_cases_activity AFTER INSERT OR UPDATE OF status ON public.support_cases FOR EACH ROW EXECUTE FUNCTION public.customer_activity_support_cases();


--
-- Name: admin_approval_requests admin_approval_requests_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_approval_requests
    ADD CONSTRAINT admin_approval_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.admins(id);


--
-- Name: admin_approval_requests admin_approval_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_approval_requests
    ADD CONSTRAINT admin_approval_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.admins(id);


--
-- Name: admin_notification_preferences admin_notification_preferences_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_preferences
    ADD CONSTRAINT admin_notification_preferences_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id);


--
-- Name: admin_notification_states admin_notification_states_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_states
    ADD CONSTRAINT admin_notification_states_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id);


--
-- Name: admin_notification_states admin_notification_states_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notification_states
    ADD CONSTRAINT admin_notification_states_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.admin_notifications(id) ON DELETE CASCADE;


--
-- Name: admin_notifications admin_notifications_target_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_target_admin_id_fkey FOREIGN KEY (target_admin_id) REFERENCES public.admins(id);


--
-- Name: card_payment_refunds card_payment_refunds_card_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_payment_refunds
    ADD CONSTRAINT card_payment_refunds_card_payment_id_fkey FOREIGN KEY (card_payment_id) REFERENCES public.card_payments(id);


--
-- Name: card_payments card_payments_saved_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_payments
    ADD CONSTRAINT card_payments_saved_card_id_fkey FOREIGN KEY (saved_card_id) REFERENCES public.saved_cards(id);


--
-- Name: card_setups card_setups_saved_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.card_setups
    ADD CONSTRAINT card_setups_saved_card_id_fkey FOREIGN KEY (saved_card_id) REFERENCES public.saved_cards(id);


--
-- Name: cash_settlements cash_settlements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_settlements
    ADD CONSTRAINT cash_settlements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: cash_settlements cash_settlements_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cash_settlements
    ADD CONSTRAINT cash_settlements_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: chat_reads chat_reads_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_reads
    ADD CONSTRAINT chat_reads_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: company_bank_account_defaults company_bank_account_defaults_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_defaults
    ADD CONSTRAINT company_bank_account_defaults_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.company_bank_accounts(id);


--
-- Name: company_bank_account_defaults company_bank_account_defaults_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_defaults
    ADD CONSTRAINT company_bank_account_defaults_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.admins(id);


--
-- Name: company_bank_account_events company_bank_account_events_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_events
    ADD CONSTRAINT company_bank_account_events_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.company_bank_accounts(id);


--
-- Name: company_bank_account_events company_bank_account_events_actor_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_events
    ADD CONSTRAINT company_bank_account_events_actor_admin_id_fkey FOREIGN KEY (actor_admin_id) REFERENCES public.admins(id);


--
-- Name: company_bank_account_events company_bank_account_events_approval_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_events
    ADD CONSTRAINT company_bank_account_events_approval_request_id_fkey FOREIGN KEY (approval_request_id) REFERENCES public.admin_approval_requests(id);


--
-- Name: company_bank_account_events company_bank_account_events_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_events
    ADD CONSTRAINT company_bank_account_events_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.admins(id);


--
-- Name: company_bank_account_funding company_bank_account_funding_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_funding
    ADD CONSTRAINT company_bank_account_funding_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.company_bank_accounts(id);


--
-- Name: company_bank_account_funding company_bank_account_funding_method_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_funding
    ADD CONSTRAINT company_bank_account_funding_method_key_fkey FOREIGN KEY (method_key) REFERENCES public.grocery_payment_methods(key);


--
-- Name: company_bank_account_funding company_bank_account_funding_set_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_account_funding
    ADD CONSTRAINT company_bank_account_funding_set_by_fkey FOREIGN KEY (set_by) REFERENCES public.admins(id);


--
-- Name: company_bank_accounts company_bank_accounts_activated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_activated_by_fkey FOREIGN KEY (activated_by) REFERENCES public.admins(id);


--
-- Name: company_bank_accounts company_bank_accounts_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.admins(id);


--
-- Name: company_bank_accounts company_bank_accounts_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.admins(id);


--
-- Name: company_bank_accounts company_bank_accounts_authorization_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_authorization_recorded_by_fkey FOREIGN KEY (authorization_recorded_by) REFERENCES public.admins(id);


--
-- Name: company_bank_accounts company_bank_accounts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id);


--
-- Name: company_bank_accounts company_bank_accounts_deactivated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_deactivated_by_fkey FOREIGN KEY (deactivated_by) REFERENCES public.admins(id);


--
-- Name: company_bank_accounts company_bank_accounts_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_bank_accounts
    ADD CONSTRAINT company_bank_accounts_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.admins(id);


--
-- Name: customer_activity_state customer_activity_state_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_activity_state
    ADD CONSTRAINT customer_activity_state_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_addresses customer_addresses_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_addresses
    ADD CONSTRAINT customer_addresses_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_credit_entries customer_credit_entries_case_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_entries
    ADD CONSTRAINT customer_credit_entries_case_fk FOREIGN KEY (support_case_id) REFERENCES public.support_cases(id);


--
-- Name: customer_credit_entries customer_credit_entries_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_credit_entries
    ADD CONSTRAINT customer_credit_entries_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: customer_location_points customer_location_points_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_location_points
    ADD CONSTRAINT customer_location_points_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_location_points customer_location_points_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_location_points
    ADD CONSTRAINT customer_location_points_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: customer_location_points customer_location_points_tracking_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_location_points
    ADD CONSTRAINT customer_location_points_tracking_session_id_fkey FOREIGN KEY (tracking_session_id) REFERENCES public.customer_tracking_sessions(id) ON DELETE CASCADE;


--
-- Name: customer_presence customer_presence_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_presence
    ADD CONSTRAINT customer_presence_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_presence customer_presence_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_presence
    ADD CONSTRAINT customer_presence_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.customer_sessions(id) ON DELETE SET NULL;


--
-- Name: customer_sessions customer_sessions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_sessions
    ADD CONSTRAINT customer_sessions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_tracking_sessions customer_tracking_sessions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tracking_sessions
    ADD CONSTRAINT customer_tracking_sessions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_tracking_sessions customer_tracking_sessions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tracking_sessions
    ADD CONSTRAINT customer_tracking_sessions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: customer_tracking_sessions customer_tracking_sessions_presence_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tracking_sessions
    ADD CONSTRAINT customer_tracking_sessions_presence_id_fkey FOREIGN KEY (presence_id) REFERENCES public.customer_presence(id) ON DELETE SET NULL;


--
-- Name: customer_tracking_sessions customer_tracking_sessions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_tracking_sessions
    ADD CONSTRAINT customer_tracking_sessions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.customer_sessions(id) ON DELETE SET NULL;


--
-- Name: orders fk_orders_shopper; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT fk_orders_shopper FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE SET NULL;


--
-- Name: products fk_products_shop; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT fk_products_shop FOREIGN KEY (shop_id) REFERENCES public.shops(id) ON DELETE CASCADE;


--
-- Name: getme_card_loads getme_card_loads_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.getme_card_loads
    ADD CONSTRAINT getme_card_loads_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.getme_cards(id);


--
-- Name: getme_cards getme_cards_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.getme_cards
    ADD CONSTRAINT getme_cards_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE SET NULL;


--
-- Name: grocery_payment_attempts grocery_payment_attempts_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_attempts
    ADD CONSTRAINT grocery_payment_attempts_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.getme_cards(id);


--
-- Name: grocery_payment_attempts grocery_payment_attempts_funding_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_attempts
    ADD CONSTRAINT grocery_payment_attempts_funding_account_id_fkey FOREIGN KEY (funding_account_id) REFERENCES public.company_bank_accounts(id);


--
-- Name: grocery_payment_attempts grocery_payment_attempts_merchant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_attempts
    ADD CONSTRAINT grocery_payment_attempts_merchant_id_fkey FOREIGN KEY (merchant_id) REFERENCES public.shop_lankaqr_merchants(id);


--
-- Name: grocery_payment_attempts grocery_payment_attempts_method_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_attempts
    ADD CONSTRAINT grocery_payment_attempts_method_fkey FOREIGN KEY (method) REFERENCES public.grocery_payment_methods(key);


--
-- Name: grocery_payment_attempts grocery_payment_attempts_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_attempts
    ADD CONSTRAINT grocery_payment_attempts_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: grocery_payment_attempts grocery_payment_attempts_reservation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_attempts
    ADD CONSTRAINT grocery_payment_attempts_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES public.grocery_reservations(id);


--
-- Name: grocery_payment_attempts grocery_payment_attempts_store_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_payment_attempts
    ADD CONSTRAINT grocery_payment_attempts_store_payment_id_fkey FOREIGN KEY (store_payment_id) REFERENCES public.store_payments(id) ON DELETE SET NULL;


--
-- Name: grocery_reservations grocery_reservations_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_reservations
    ADD CONSTRAINT grocery_reservations_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: grocery_shop_payment_methods grocery_shop_payment_methods_method_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_shop_payment_methods
    ADD CONSTRAINT grocery_shop_payment_methods_method_key_fkey FOREIGN KEY (method_key) REFERENCES public.grocery_payment_methods(key);


--
-- Name: grocery_shop_payment_methods grocery_shop_payment_methods_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grocery_shop_payment_methods
    ADD CONSTRAINT grocery_shop_payment_methods_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.shops(id) ON DELETE CASCADE;


--
-- Name: order_dispatch_actions order_dispatch_actions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_dispatch_actions
    ADD CONSTRAINT order_dispatch_actions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_dispatch_exclusions order_dispatch_exclusions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_dispatch_exclusions
    ADD CONSTRAINT order_dispatch_exclusions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_dispatch_exclusions order_dispatch_exclusions_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_dispatch_exclusions
    ADD CONSTRAINT order_dispatch_exclusions_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: order_item_price_reports order_item_price_reports_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_price_reports
    ADD CONSTRAINT order_item_price_reports_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_item_price_reports order_item_price_reports_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_price_reports
    ADD CONSTRAINT order_item_price_reports_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE CASCADE;


--
-- Name: order_item_requests order_item_requests_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_item_requests
    ADD CONSTRAINT order_item_requests_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: order_items order_items_offer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.product_offers(id) ON DELETE SET NULL;


--
-- Name: order_items order_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_items order_items_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_items
    ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;


--
-- Name: order_ratings order_ratings_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_ratings
    ADD CONSTRAINT order_ratings_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: order_ratings order_ratings_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_ratings
    ADD CONSTRAINT order_ratings_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_ratings order_ratings_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_ratings
    ADD CONSTRAINT order_ratings_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE SET NULL;


--
-- Name: order_replacement_items order_replacement_items_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_replacement_items
    ADD CONSTRAINT order_replacement_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_replacement_items order_replacement_items_order_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_replacement_items
    ADD CONSTRAINT order_replacement_items_order_item_id_fkey FOREIGN KEY (order_item_id) REFERENCES public.order_items(id) ON DELETE CASCADE;


--
-- Name: order_shop_bills order_shop_bills_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_shop_bills
    ADD CONSTRAINT order_shop_bills_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_shop_bills order_shop_bills_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_shop_bills
    ADD CONSTRAINT order_shop_bills_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.shops(id) ON DELETE CASCADE;


--
-- Name: order_shops order_shops_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_shops
    ADD CONSTRAINT order_shops_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_support_notes order_support_notes_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_support_notes
    ADD CONSTRAINT order_support_notes_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id);


--
-- Name: order_support_notes order_support_notes_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_support_notes
    ADD CONSTRAINT order_support_notes_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: orders orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: orders orders_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.shops(id) ON DELETE RESTRICT;


--
-- Name: platform_settings platform_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_settings
    ADD CONSTRAINT platform_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: pricing_settings_versions pricing_settings_versions_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_settings_versions
    ADD CONSTRAINT pricing_settings_versions_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: pricing_settings_versions pricing_settings_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pricing_settings_versions
    ADD CONSTRAINT pricing_settings_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: product_catalog product_catalog_created_by_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_catalog
    ADD CONSTRAINT product_catalog_created_by_shop_id_fkey FOREIGN KEY (created_by_shop_id) REFERENCES public.shops(id) ON DELETE SET NULL;


--
-- Name: product_offers product_offers_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_offers
    ADD CONSTRAINT product_offers_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: product_offers product_offers_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_offers
    ADD CONSTRAINT product_offers_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.shops(id) ON DELETE CASCADE;


--
-- Name: product_price_history product_price_history_product_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.product_price_history
    ADD CONSTRAINT product_price_history_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;


--
-- Name: products products_catalog_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.products
    ADD CONSTRAINT products_catalog_id_fkey FOREIGN KEY (catalog_id) REFERENCES public.product_catalog(id) ON DELETE SET NULL;


--
-- Name: promo_codes promo_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_codes
    ADD CONSTRAINT promo_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: promo_redemptions promo_redemptions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: promo_redemptions promo_redemptions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: promo_redemptions promo_redemptions_promo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.promo_redemptions
    ADD CONSTRAINT promo_redemptions_promo_id_fkey FOREIGN KEY (promo_id) REFERENCES public.promo_codes(id) ON DELETE CASCADE;


--
-- Name: shop_lankaqr_merchants shop_lankaqr_merchants_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_lankaqr_merchants
    ADD CONSTRAINT shop_lankaqr_merchants_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.shops(id) ON DELETE CASCADE;


--
-- Name: shop_staff shop_staff_shop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shop_staff
    ADD CONSTRAINT shop_staff_shop_id_fkey FOREIGN KEY (shop_id) REFERENCES public.shops(id) ON DELETE CASCADE;


--
-- Name: shopper_activation_codes shopper_activation_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_activation_codes
    ADD CONSTRAINT shopper_activation_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_activation_codes shopper_activation_codes_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_activation_codes
    ADD CONSTRAINT shopper_activation_codes_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_application_documents shopper_application_documents_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_application_documents
    ADD CONSTRAINT shopper_application_documents_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.shopper_applications(id) ON DELETE CASCADE;


--
-- Name: shopper_application_documents shopper_application_documents_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_application_documents
    ADD CONSTRAINT shopper_application_documents_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_application_events shopper_application_events_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_application_events
    ADD CONSTRAINT shopper_application_events_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.shopper_applications(id) ON DELETE CASCADE;


--
-- Name: shopper_applications shopper_applications_consent_recorded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_applications
    ADD CONSTRAINT shopper_applications_consent_recorded_by_fkey FOREIGN KEY (consent_recorded_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_applications shopper_applications_created_by_admin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_applications
    ADD CONSTRAINT shopper_applications_created_by_admin_fkey FOREIGN KEY (created_by_admin) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_applications shopper_applications_payout_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_applications
    ADD CONSTRAINT shopper_applications_payout_account_id_fkey FOREIGN KEY (payout_account_id) REFERENCES public.shopper_payout_accounts(id) ON DELETE SET NULL;


--
-- Name: shopper_applications shopper_applications_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_applications
    ADD CONSTRAINT shopper_applications_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_applications shopper_applications_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_applications
    ADD CONSTRAINT shopper_applications_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_cash_limit_state shopper_cash_limit_state_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_cash_limit_state
    ADD CONSTRAINT shopper_cash_limit_state_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_change_request_documents shopper_change_request_documents_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_request_documents
    ADD CONSTRAINT shopper_change_request_documents_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.shopper_change_requests(id) ON DELETE CASCADE;


--
-- Name: shopper_change_request_documents shopper_change_request_documents_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_request_documents
    ADD CONSTRAINT shopper_change_request_documents_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_change_request_events shopper_change_request_events_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_request_events
    ADD CONSTRAINT shopper_change_request_events_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.shopper_change_requests(id) ON DELETE CASCADE;


--
-- Name: shopper_change_requests shopper_change_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_requests
    ADD CONSTRAINT shopper_change_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_change_requests shopper_change_requests_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_change_requests
    ADD CONSTRAINT shopper_change_requests_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_compliance_alerts shopper_compliance_alerts_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_compliance_alerts
    ADD CONSTRAINT shopper_compliance_alerts_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_earnings shopper_earnings_cash_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_earnings
    ADD CONSTRAINT shopper_earnings_cash_payout_id_fkey FOREIGN KEY (cash_payout_id) REFERENCES public.shopper_payouts(id);


--
-- Name: shopper_earnings shopper_earnings_cash_settlement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_earnings
    ADD CONSTRAINT shopper_earnings_cash_settlement_id_fkey FOREIGN KEY (cash_settlement_id) REFERENCES public.cash_settlements(id) ON DELETE SET NULL;


--
-- Name: shopper_earnings shopper_earnings_cash_withdrawal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_earnings
    ADD CONSTRAINT shopper_earnings_cash_withdrawal_id_fkey FOREIGN KEY (cash_withdrawal_id) REFERENCES public.shopper_withdrawals(id) ON DELETE SET NULL;


--
-- Name: shopper_earnings shopper_earnings_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_earnings
    ADD CONSTRAINT shopper_earnings_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: shopper_earnings shopper_earnings_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_earnings
    ADD CONSTRAINT shopper_earnings_payout_id_fkey FOREIGN KEY (payout_id) REFERENCES public.shopper_payouts(id);


--
-- Name: shopper_incident_events shopper_incident_events_incident_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_incident_events
    ADD CONSTRAINT shopper_incident_events_incident_id_fkey FOREIGN KEY (incident_id) REFERENCES public.shopper_incidents(id) ON DELETE CASCADE;


--
-- Name: shopper_incidents shopper_incidents_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_incidents
    ADD CONSTRAINT shopper_incidents_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: shopper_incidents shopper_incidents_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_incidents
    ADD CONSTRAINT shopper_incidents_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_notifications shopper_notifications_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_notifications
    ADD CONSTRAINT shopper_notifications_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: shopper_notifications shopper_notifications_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_notifications
    ADD CONSTRAINT shopper_notifications_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_order_offers shopper_order_offers_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_order_offers
    ADD CONSTRAINT shopper_order_offers_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: shopper_order_offers shopper_order_offers_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_order_offers
    ADD CONSTRAINT shopper_order_offers_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_payout_accounts shopper_payout_accounts_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_payout_accounts
    ADD CONSTRAINT shopper_payout_accounts_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_payout_accounts shopper_payout_accounts_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_payout_accounts
    ADD CONSTRAINT shopper_payout_accounts_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_profile_history shopper_profile_history_change_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_profile_history
    ADD CONSTRAINT shopper_profile_history_change_request_id_fkey FOREIGN KEY (change_request_id) REFERENCES public.shopper_change_requests(id) ON DELETE SET NULL;


--
-- Name: shopper_profile_history shopper_profile_history_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_profile_history
    ADD CONSTRAINT shopper_profile_history_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_training_attempts shopper_training_attempts_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_training_attempts
    ADD CONSTRAINT shopper_training_attempts_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_vehicle_records shopper_vehicle_records_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_vehicle_records
    ADD CONSTRAINT shopper_vehicle_records_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_vehicle_records shopper_vehicle_records_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_vehicle_records
    ADD CONSTRAINT shopper_vehicle_records_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shopper_vehicle_records shopper_vehicle_records_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_vehicle_records
    ADD CONSTRAINT shopper_vehicle_records_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.shopper_vehicle_records(id) ON DELETE SET NULL;


--
-- Name: shopper_withdrawal_events shopper_withdrawal_events_withdrawal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawal_events
    ADD CONSTRAINT shopper_withdrawal_events_withdrawal_id_fkey FOREIGN KEY (withdrawal_id) REFERENCES public.shopper_withdrawals(id) ON DELETE CASCADE;


--
-- Name: shopper_withdrawals shopper_withdrawals_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawals
    ADD CONSTRAINT shopper_withdrawals_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_withdrawals shopper_withdrawals_closed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawals
    ADD CONSTRAINT shopper_withdrawals_closed_by_fkey FOREIGN KEY (closed_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_withdrawals shopper_withdrawals_paid_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawals
    ADD CONSTRAINT shopper_withdrawals_paid_by_fkey FOREIGN KEY (paid_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shopper_withdrawals shopper_withdrawals_payout_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawals
    ADD CONSTRAINT shopper_withdrawals_payout_account_id_fkey FOREIGN KEY (payout_account_id) REFERENCES public.shopper_payout_accounts(id) ON DELETE SET NULL;


--
-- Name: shopper_withdrawals shopper_withdrawals_shopper_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shopper_withdrawals
    ADD CONSTRAINT shopper_withdrawals_shopper_id_fkey FOREIGN KEY (shopper_id) REFERENCES public.shoppers(id) ON DELETE CASCADE;


--
-- Name: shoppers shoppers_registered_by_admin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shoppers
    ADD CONSTRAINT shoppers_registered_by_admin_fkey FOREIGN KEY (registered_by_admin) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shoppers shoppers_vehicle_restricted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shoppers
    ADD CONSTRAINT shoppers_vehicle_restricted_by_fkey FOREIGN KEY (vehicle_restricted_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: shops shops_account_manager_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shops
    ADD CONSTRAINT shops_account_manager_admin_id_fkey FOREIGN KEY (account_manager_admin_id) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: store_payments store_payments_customer_payment_override_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payments
    ADD CONSTRAINT store_payments_customer_payment_override_by_fkey FOREIGN KEY (customer_payment_override_by) REFERENCES public.admins(id) ON DELETE SET NULL;


--
-- Name: store_payments store_payments_funding_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payments
    ADD CONSTRAINT store_payments_funding_account_id_fkey FOREIGN KEY (funding_account_id) REFERENCES public.company_bank_accounts(id);


--
-- Name: store_payments store_payments_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payments
    ADD CONSTRAINT store_payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: store_payments store_payments_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payments
    ADD CONSTRAINT store_payments_payout_id_fkey FOREIGN KEY (payout_id) REFERENCES public.shopper_payouts(id);


--
-- Name: store_payments store_payments_reimbursement_withdrawal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.store_payments
    ADD CONSTRAINT store_payments_reimbursement_withdrawal_id_fkey FOREIGN KEY (reimbursement_withdrawal_id) REFERENCES public.shopper_withdrawals(id) ON DELETE SET NULL;


--
-- Name: support_case_events support_case_events_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_events
    ADD CONSTRAINT support_case_events_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admins(id);


--
-- Name: support_case_events support_case_events_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_events
    ADD CONSTRAINT support_case_events_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.support_cases(id);


--
-- Name: support_case_photos support_case_photos_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_case_photos
    ADD CONSTRAINT support_case_photos_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.support_cases(id);


--
-- Name: support_cases support_cases_assigned_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_assigned_admin_id_fkey FOREIGN KEY (assigned_admin_id) REFERENCES public.admins(id);


--
-- Name: support_cases support_cases_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: support_cases support_cases_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);


--
-- Name: support_cases support_cases_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_cases
    ADD CONSTRAINT support_cases_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.admins(id);


--
-- PostgreSQL database dump complete
--

\unrestrict OkaGVIbMJsZG02PEjd40lHOJPIk5R4bDeNAMXI2aDqpb9WwI8KYPh6jsMx8p4y9

