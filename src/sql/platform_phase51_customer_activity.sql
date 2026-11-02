-- =====================================================
-- PHASE 51 (2026-10-30): CUSTOMER ACTIVITY, SESSIONS AND LOCATION HISTORY
--
-- What admins see on Customer activity and the customer page tabs.
--
-- * customer_sessions: one row per sign-in (the customer JWT carries
--   `sid`). Ends on logout, when the token expires (closed by the clock
--   at expires_at) or when the account is blocked.
-- * customer_presence: one row per foreground visit of the app (the app
--   makes a new visit id each time it comes to the foreground). Socket.IO
--   decides online / offline; a dropped socket gets a reconnect grace
--   period before the visit ends as 'connection_lost', so a network blip
--   is a reconnection, not a logout.
-- * customer_tracking_sessions + customer_location_points: GPS points the
--   app sent while the customer had location sharing ON, the OS
--   permission granted and the app open. Append-only (no UPDATE); the
--   route on the admin map is these points in time order.
-- * customer_activity_state: one row per customer - consent, permission,
--   last known location, last activity. Separate from the history: a
--   late (queued) point never replaces a newer last location.
-- * customer_activity_events: the timeline. Database triggers below add
--   account, order, payment, address and support events whatever code
--   path made the change; Node adds sign-in, presence, location and the
--   app's browsing / cart events. No passwords, tokens, card numbers or
--   addresses are written here.
-- * customer_activity_settings: retention (src/customerActivity/retention.js
--   deletes older rows once a day).
-- Every trigger swallows its own errors (RAISE WARNING): an activity
-- record can never fail an order, payment or sign-up.
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS customer_activity_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  location_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (location_retention_days BETWEEN 7 AND 730),
  session_retention_days INTEGER NOT NULL DEFAULT 365 CHECK (session_retention_days BETWEEN 30 AND 1095),
  event_retention_days INTEGER NOT NULL DEFAULT 365 CHECK (event_retention_days BETWEEN 30 AND 1095),
  -- Off: the app stops sending points and the server refuses them
  location_collection_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Shown with the consent text in the app; consent to an older version is not consent
  consent_version VARCHAR(20) NOT NULL DEFAULT '2026-10-30',
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO customer_activity_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------
-- Sign-in sessions
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_sessions (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  login_method VARCHAR(10) NOT NULL CHECK (login_method IN ('email', 'mobile', 'register')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  end_reason VARCHAR(12) CHECK (end_reason IN ('logout', 'expired', 'blocked')),
  ip VARCHAR(64),
  user_agent VARCHAR(200),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);

CREATE INDEX IF NOT EXISTS customer_sessions_customer_idx ON customer_sessions (customer_id, started_at DESC);
CREATE INDEX IF NOT EXISTS customer_sessions_open_idx ON customer_sessions (expires_at) WHERE ended_at IS NULL;

-- -----------------------------------------------------
-- Online periods (one per foreground visit)
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_presence (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  session_id BIGINT REFERENCES customer_sessions(id) ON DELETE SET NULL,
  -- Random ids made by the app (no hardware identifiers):
  -- install = this app install, app_session = this app launch, visit = this foreground period
  install_id VARCHAR(64),
  app_session_id VARCHAR(64),
  visit_id VARCHAR(64) NOT NULL,
  platform VARCHAR(10),
  app_version VARCHAR(30),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  state VARCHAR(12) NOT NULL DEFAULT 'online' CHECK (state IN ('online', 'disconnected', 'ended')),
  state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  end_reason VARCHAR(20) CHECK (end_reason IN (
    'background', 'logout', 'connection_lost', 'app_restarted', 'session_expired', 'blocked', 'server_restart', 'heartbeat_lost'
  )),
  reconnect_count INTEGER NOT NULL DEFAULT 0,
  -- Seconds spent disconnected before reconnecting (interruptions)
  interrupted_seconds INTEGER NOT NULL DEFAULT 0,
  -- The socket that holds the visit: a late disconnect of an older socket can't end a newer connection
  socket_id VARCHAR(40),
  CHECK ((state = 'ended') = (ended_at IS NOT NULL))
);

-- One open row per visit; after a visit ended (long outage), the same visit id starts a new row
CREATE UNIQUE INDEX IF NOT EXISTS customer_presence_open_visit_idx ON customer_presence (customer_id, visit_id) WHERE state <> 'ended';
CREATE INDEX IF NOT EXISTS customer_presence_customer_idx ON customer_presence (customer_id, started_at DESC);
CREATE INDEX IF NOT EXISTS customer_presence_open_idx ON customer_presence (state, state_changed_at) WHERE state <> 'ended';
CREATE INDEX IF NOT EXISTS customer_presence_install_idx ON customer_presence (customer_id, install_id) WHERE state <> 'ended';

-- -----------------------------------------------------
-- Routes (tracking sessions) and GPS points
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_tracking_sessions (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  client_tracking_id VARCHAR(64) NOT NULL,
  presence_id BIGINT REFERENCES customer_presence(id) ON DELETE SET NULL,
  session_id BIGINT REFERENCES customer_sessions(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  purpose VARCHAR(20) NOT NULL CHECK (purpose IN ('app_in_use', 'active_order')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  end_reason VARCHAR(20) CHECK (end_reason IN (
    'stopped', 'background', 'logout', 'permission_revoked', 'consent_withdrawn', 'stale', 'order_finished', 'collection_disabled'
  )),
  start_latitude DOUBLE PRECISION,
  start_longitude DOUBLE PRECISION,
  end_latitude DOUBLE PRECISION,
  end_longitude DOUBLE PRECISION,
  -- The order's delivery point (what the customer was heading to / waiting at)
  destination_latitude DOUBLE PRECISION,
  destination_longitude DOUBLE PRECISION,
  point_count INTEGER NOT NULL DEFAULT 0,
  -- Only between accurate, close-in-time points (src/customerActivity/geo.js)
  distance_m NUMERIC(12, 1) NOT NULL DEFAULT 0,
  first_point_at TIMESTAMPTZ,
  last_point_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, client_tracking_id)
);

CREATE INDEX IF NOT EXISTS customer_tracking_customer_idx ON customer_tracking_sessions (customer_id, started_at DESC);
CREATE INDEX IF NOT EXISTS customer_tracking_open_idx ON customer_tracking_sessions (last_point_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_tracking_order_idx ON customer_tracking_sessions (order_id) WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_location_points (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tracking_session_id BIGINT NOT NULL REFERENCES customer_tracking_sessions(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_m REAL CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  speed_mps REAL,
  heading REAL,
  -- Phone time of the GPS fix (checked against server time on receipt)
  recorded_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source VARCHAR(20) NOT NULL CHECK (source IN ('app_in_use', 'active_order')),
  client_point_id VARCHAR(64) NOT NULL,
  UNIQUE (customer_id, client_point_id)
);

CREATE INDEX IF NOT EXISTS customer_points_customer_idx ON customer_location_points (customer_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS customer_points_session_idx ON customer_location_points (tracking_session_id, recorded_at);
CREATE INDEX IF NOT EXISTS customer_points_order_idx ON customer_location_points (order_id, recorded_at) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customer_points_received_idx ON customer_location_points (received_at);

-- -----------------------------------------------------
-- Current state (one row per customer)
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_activity_state (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  location_consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_version VARCHAR(20),
  consent_changed_at TIMESTAMPTZ,
  location_permission VARCHAR(15) CHECK (location_permission IN ('granted', 'denied', 'undetermined', 'restricted')),
  permission_precise BOOLEAN,
  permission_changed_at TIMESTAMPTZ,
  last_latitude DOUBLE PRECISION,
  last_longitude DOUBLE PRECISION,
  last_accuracy_m REAL,
  last_location_at TIMESTAMPTZ,
  last_location_source VARCHAR(20),
  last_activity_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  last_logout_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_activity_state_last_idx ON customer_activity_state (last_activity_at DESC NULLS LAST);

-- -----------------------------------------------------
-- Timeline
-- -----------------------------------------------------

-- No foreign keys on the timeline: a trigger on card_payments / refunds /
-- support_cases can run on a second connection while the order or
-- customer row is locked FOR UPDATE by the request's own transaction;
-- an FK check would then wait for that lock forever (found 2026-10-30).
-- The ids stay as history; deleting a customer deletes its events
-- (customers_activity_cleanup below).
CREATE TABLE IF NOT EXISTS customer_activity_events (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  category VARCHAR(12) NOT NULL CHECK (category IN ('account', 'session', 'location', 'browsing', 'cart', 'order', 'payment', 'support')),
  event_type VARCHAR(60) NOT NULL,
  summary VARCHAR(300) NOT NULL,
  details JSONB,
  source VARCHAR(10) NOT NULL CHECK (source IN ('server', 'app', 'database')),
  order_id INTEGER,
  session_id BIGINT,
  presence_id BIGINT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dedupe_key VARCHAR(200) UNIQUE
);

-- Databases that ran the first version of this file
ALTER TABLE customer_activity_events DROP CONSTRAINT IF EXISTS customer_activity_events_customer_id_fkey;
ALTER TABLE customer_activity_events DROP CONSTRAINT IF EXISTS customer_activity_events_order_id_fkey;
ALTER TABLE customer_activity_events DROP CONSTRAINT IF EXISTS customer_activity_events_session_id_fkey;
ALTER TABLE customer_activity_events DROP CONSTRAINT IF EXISTS customer_activity_events_presence_id_fkey;

CREATE OR REPLACE FUNCTION customer_activity_cleanup() RETURNS trigger AS $$
BEGIN
  DELETE FROM customer_activity_events WHERE customer_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_activity_cleanup ON customers;
CREATE TRIGGER customers_activity_cleanup
  BEFORE DELETE ON customers
  FOR EACH ROW EXECUTE FUNCTION customer_activity_cleanup();

CREATE INDEX IF NOT EXISTS customer_events_customer_idx ON customer_activity_events (customer_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS customer_events_category_idx ON customer_activity_events (customer_id, category, occurred_at DESC);
CREATE INDEX IF NOT EXISTS customer_events_recorded_idx ON customer_activity_events (recorded_at);

-- History is never edited (retention may delete whole rows). The one
-- update allowed is a link column set to NULL by ON DELETE SET NULL
-- (an order, sign-in or visit was deleted).
CREATE OR REPLACE FUNCTION customer_activity_no_update() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_location_points_no_update ON customer_location_points;
CREATE TRIGGER customer_location_points_no_update
  BEFORE UPDATE ON customer_location_points
  FOR EACH ROW EXECUTE FUNCTION customer_activity_no_update();

DROP TRIGGER IF EXISTS customer_activity_events_no_update ON customer_activity_events;
CREATE TRIGGER customer_activity_events_no_update
  BEFORE UPDATE ON customer_activity_events
  FOR EACH ROW EXECUTE FUNCTION customer_activity_no_update();

-- -----------------------------------------------------
-- Writer used by the triggers (dedupe key: written once)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_activity_log(
  p_customer INTEGER, p_category TEXT, p_type TEXT, p_summary TEXT, p_details JSONB,
  p_order INTEGER DEFAULT NULL, p_dedupe TEXT DEFAULT NULL
) RETURNS VOID AS $$
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
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------
-- Account: registration, profile changes (field names only), status
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_activity_customers() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_activity_insert ON customers;
CREATE CONSTRAINT TRIGGER customers_activity_insert
  AFTER INSERT ON customers DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION customer_activity_customers();

DROP TRIGGER IF EXISTS customers_activity_update ON customers;
CREATE TRIGGER customers_activity_update
  AFTER UPDATE OF full_name, mobile, email, password_hash, account_status ON customers
  FOR EACH ROW EXECUTE FUNCTION customer_activity_customers();

-- -----------------------------------------------------
-- Orders: created, status changes, cancellation, payment status
-- (deferred: order_shops rows exist by commit time)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_activity_orders() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_activity_insert ON orders;
CREATE CONSTRAINT TRIGGER orders_activity_insert
  AFTER INSERT ON orders DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION customer_activity_orders();

DROP TRIGGER IF EXISTS orders_activity_update ON orders;
CREATE TRIGGER orders_activity_update
  AFTER UPDATE OF status, payment_status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.payment_status IS DISTINCT FROM NEW.payment_status)
  EXECUTE FUNCTION customer_activity_orders();

-- -----------------------------------------------------
-- Card payments and refunds (brand + last 4 only)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_activity_card_payments() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS card_payments_activity ON card_payments;
CREATE TRIGGER card_payments_activity
  AFTER INSERT OR UPDATE OF status ON card_payments
  FOR EACH ROW EXECUTE FUNCTION customer_activity_card_payments();

CREATE OR REPLACE FUNCTION customer_activity_refunds() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS card_payment_refunds_activity ON card_payment_refunds;
CREATE TRIGGER card_payment_refunds_activity
  AFTER INSERT ON card_payment_refunds
  FOR EACH ROW EXECUTE FUNCTION customer_activity_refunds();

-- -----------------------------------------------------
-- Support cases
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_activity_support_cases() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_cases_activity ON support_cases;
CREATE TRIGGER support_cases_activity
  AFTER INSERT OR UPDATE OF status ON support_cases
  FOR EACH ROW EXECUTE FUNCTION customer_activity_support_cases();

-- -----------------------------------------------------
-- Saved addresses (label only; the address itself stays on its own table)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_activity_addresses() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customer_addresses_activity ON customer_addresses;
CREATE TRIGGER customer_addresses_activity
  AFTER INSERT OR DELETE OR UPDATE OF label, address, unit, building, instructions, latitude, longitude ON customer_addresses
  FOR EACH ROW EXECUTE FUNCTION customer_activity_addresses();

COMMIT;
