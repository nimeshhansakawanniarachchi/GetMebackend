-- =====================================================
-- PHASE 57: CUSTOMER NOTIFICATIONS + ORDER ACTIVITY (2026-11-01)
--
-- Every shopper action the customer must know about is saved as a
-- customer_notifications row by database triggers on the tables the
-- shopper / payment flows already write (same design as the admin
-- notifications of phase 41). So:
--   - nothing depends on a socket event reaching the phone: a customer
--     who was offline sees the saved notification later;
--   - every code path (ShopperApp, admin, background jobs) is covered;
--   - dedupe_key (unique per customer) stops repeated triggers / retried
--     requests from creating duplicates;
--   - pg_notify('customer_notification') after commit lets the API
--     server push it live (Socket.IO + Expo push) - rolled-back work
--     never notifies anyone.
-- Action-required rows (replacement / extra item / price approvals,
-- delivery PIN) stay 'pending' until the request is answered or closed.
-- No foreign keys (phase 51: event tables must never lock order rows).
-- A trigger failure is caught: it can never break the shopper's action.
-- =====================================================

CREATE TABLE IF NOT EXISTS customer_notifications (
  id BIGSERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  order_id INTEGER,
  order_item_id INTEGER,
  category VARCHAR(20) NOT NULL
    CHECK (category IN ('replacements', 'refunds', 'messages', 'order_updates', 'delivery', 'payments')),
  event_type VARCHAR(60) NOT NULL,
  title VARCHAR(200) NOT NULL,
  body VARCHAR(500),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Needs the customer: shown under "Action required" until answered
  action_required BOOLEAN NOT NULL DEFAULT FALSE,
  action_state VARCHAR(10) CHECK (action_state IN ('pending', 'done', 'expired')),
  action_resolved_at TIMESTAMPTZ,
  dedupe_key VARCHAR(200) NOT NULL,
  -- Mobile push: whether to send one, and how it went
  push_wanted BOOLEAN NOT NULL DEFAULT TRUE,
  push_status VARCHAR(12) NOT NULL DEFAULT 'pending'
    CHECK (push_status IN ('pending', 'sent', 'failed', 'no_device', 'skipped')),
  push_attempts INTEGER NOT NULL DEFAULT 0,
  push_error VARCHAR(300),
  push_sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_notifications_dedupe UNIQUE (customer_id, dedupe_key),
  CONSTRAINT customer_notifications_action CHECK (action_required = (action_state IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS customer_notifications_list
  ON customer_notifications (customer_id, id DESC);
CREATE INDEX IF NOT EXISTS customer_notifications_unread
  ON customer_notifications (customer_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_notifications_actions
  ON customer_notifications (customer_id) WHERE action_state = 'pending';
CREATE INDEX IF NOT EXISTS customer_notifications_order
  ON customer_notifications (order_id, id);
CREATE INDEX IF NOT EXISTS customer_notifications_push_queue
  ON customer_notifications (id) WHERE push_status IN ('pending', 'failed');

-- -----------------------------------------------------
-- Helpers
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_money(amount NUMERIC) RETURNS TEXT AS $$
  SELECT 'Rs ' || to_char(COALESCE(amount, 0), 'FM999,999,999,990.00');
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION customer_first_name(full_name TEXT) RETURNS TEXT AS $$
  SELECT NULLIF(split_part(btrim(COALESCE(full_name, '')), ' ', 1), '');
$$ LANGUAGE sql IMMUTABLE;

-- Saves one notification per (customer, dedupe key); NOTIFY on commit.
CREATE OR REPLACE FUNCTION customer_notify(
  p_customer INTEGER, p_order INTEGER, p_item INTEGER,
  p_category TEXT, p_event TEXT, p_title TEXT, p_body TEXT,
  p_data JSONB, p_action BOOLEAN, p_dedupe TEXT, p_push BOOLEAN DEFAULT TRUE
) RETURNS BIGINT AS $$
DECLARE
  v_id BIGINT;
BEGIN
  IF p_customer IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO customer_notifications (
    customer_id, order_id, order_item_id, category, event_type, title, body, data,
    action_required, action_state, dedupe_key, push_wanted, push_status
  )
  VALUES (
    p_customer, p_order, p_item, p_category, p_event, left(p_title, 200), left(p_body, 500),
    COALESCE(p_data, '{}'::jsonb), COALESCE(p_action, FALSE),
    CASE WHEN COALESCE(p_action, FALSE) THEN 'pending' END,
    left(p_dedupe, 200), COALESCE(p_push, TRUE),
    CASE WHEN COALESCE(p_push, TRUE) THEN 'pending' ELSE 'skipped' END
  )
  ON CONFLICT (customer_id, dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    PERFORM pg_notify('customer_notification', v_id::text);
  END IF;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify % failed: %', p_event, SQLERRM;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Closes pending actions whose dedupe key starts with p_prefix
-- ('done' = answered, 'expired' = no longer possible)
CREATE OR REPLACE FUNCTION customer_notify_resolve(
  p_customer INTEGER, p_prefix TEXT, p_state TEXT DEFAULT 'done'
) RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_customer IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE customer_notifications
     SET action_state = p_state, action_resolved_at = NOW()
   WHERE customer_id = p_customer
     AND action_state = 'pending'
     AND dedupe_key LIKE p_prefix || '%';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count > 0 THEN
    PERFORM pg_notify('customer_notification', 'changed:' || p_customer::text);
  END IF;
  RETURN v_count;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_resolve % failed: %', p_prefix, SQLERRM;
  RETURN 0;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------
-- Orders: status changes + delivery photo
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_notify_orders() RETURNS trigger AS $$
DECLARE
  v_shop TEXT;
  v_shopper TEXT;
  v_key TEXT := 'order:' || NEW.id || ':';
BEGIN
  BEGIN
    SELECT shop_name INTO v_shop FROM shops WHERE id = NEW.shop_id;
    SELECT customer_first_name(full_name) INTO v_shopper FROM shoppers WHERE id = NEW.shopper_id;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  v_shopper := COALESCE(v_shopper, 'Your shopper');

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'shopper_accepted' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'order.shopper_accepted',
        'Your shopper is assigned',
        v_shopper || ' accepted your order #' || NEW.id || COALESCE(' and is heading to ' || v_shop, '') || '.',
        jsonb_build_object('orderId', NEW.id, 'status', NEW.status), FALSE,
        v_key || 'accepted:' || COALESCE(NEW.shopper_id::text, '0'));
    ELSIF NEW.status = 'shopping' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'order.shopping_started',
        'Shopping has started',
        v_shopper || ' is shopping for your order' || COALESCE(' at ' || v_shop, '') || '. You''ll be asked about any changes.',
        jsonb_build_object('orderId', NEW.id, 'status', NEW.status), FALSE, v_key || 'shopping');
    ELSIF NEW.status = 'out_for_delivery' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'delivery', 'order.out_for_delivery',
        'Your order is on the way',
        v_shopper || ' has left the store with your order #' || NEW.id || '.',
        jsonb_build_object('orderId', NEW.id, 'status', NEW.status), FALSE, v_key || 'out_for_delivery');
    ELSIF NEW.status = 'arrived' THEN
      -- The PIN itself is never put in a notification (or a push)
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'delivery', 'order.arrived',
        'Your shopper has arrived',
        'Share your delivery PIN with ' || v_shopper || ' to receive order #' || NEW.id || '.',
        jsonb_build_object('orderId', NEW.id, 'status', NEW.status, 'pinRequired', TRUE), TRUE, v_key || 'arrived');
    ELSIF NEW.status = 'delivered' THEN
      PERFORM customer_notify_resolve(NEW.customer_id, v_key || 'arrived', 'done');
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'delivery', 'order.delivered',
        'Order delivered',
        'Order #' || NEW.id || ' has been delivered. Enjoy!',
        jsonb_build_object('orderId', NEW.id, 'status', NEW.status), FALSE, v_key || 'delivered');
    ELSIF NEW.status = 'cancelled' THEN
      PERFORM customer_notify(NEW.customer_id, NEW.id, NULL, 'order_updates', 'order.cancelled',
        'Order cancelled',
        'Order #' || NEW.id || ' was cancelled' ||
          CASE WHEN NULLIF(btrim(COALESCE(NEW.cancel_reason, '')), '') IS NOT NULL
               THEN ': ' || left(NEW.cancel_reason, 200) ELSE '.' END,
        jsonb_build_object('orderId', NEW.id, 'status', NEW.status, 'cancelledBy', NEW.cancelled_by), FALSE,
        v_key || 'cancelled');
    END IF;

    -- A finished order has nothing left to answer
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
      jsonb_build_object('orderId', NEW.id), FALSE, v_key || 'delivery_photo');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_orders failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_customer_notify ON orders;
CREATE TRIGGER orders_customer_notify
  AFTER UPDATE OF status, delivery_photo_url ON orders
  FOR EACH ROW EXECUTE FUNCTION customer_notify_orders();

-- -----------------------------------------------------
-- Order items: unavailable -> refunded, replaced
-- (found / done are progress: shown in the order activity, not as
-- one notification per item)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_notify_order_items() RETURNS trigger AS $$
DECLARE
  v_order RECORD;
  v_name TEXT := COALESCE(NULLIF(btrim(NEW.item_name), ''), 'An item');
BEGIN
  IF NEW.shopping_status IS NOT DISTINCT FROM OLD.shopping_status THEN
    RETURN NEW;
  END IF;

  SELECT id, customer_id, payment_method INTO v_order FROM orders WHERE id = NEW.order_id;
  IF v_order.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.shopping_status = 'refunded' THEN
    -- Requests about this item are no longer possible
    PERFORM customer_notify_resolve(v_order.customer_id, 'replacement:item:' || NEW.id || ':', 'expired');
    PERFORM customer_notify_resolve(v_order.customer_id, 'pricereport:item:' || NEW.id || ':', 'expired');

    PERFORM customer_notify(v_order.customer_id, v_order.id, NEW.id, 'refunds', 'item.refunded',
      v_name || ' is unavailable',
      CASE
        WHEN COALESCE(NEW.refund_amount, 0) > 0 AND v_order.payment_method = 'card'
          THEN 'Refund started: ' || customer_money(NEW.refund_amount) || ' will go back to your card. We''ll tell you when it''s done.'
        WHEN COALESCE(NEW.refund_amount, 0) > 0
          THEN 'Removed from your order: you won''t pay ' || customer_money(NEW.refund_amount) || ' for it.'
        ELSE 'Your shopper couldn''t find it, so it was removed from your order.'
      END,
      jsonb_build_object('orderId', v_order.id, 'itemId', NEW.id, 'itemName', NEW.item_name,
                         'refundAmount', NEW.refund_amount, 'paymentMethod', v_order.payment_method,
                         'refundState', CASE WHEN v_order.payment_method = 'card' THEN 'started' ELSE 'removed' END),
      FALSE, 'item:' || NEW.id || ':refunded');
  ELSIF NEW.shopping_status = 'replaced' THEN
    PERFORM customer_notify(v_order.customer_id, v_order.id, NEW.id, 'replacements', 'item.replaced',
      v_name || ' was replaced',
      'Your shopper picked ' || COALESCE(NULLIF(btrim(NEW.replacement_product_name), ''), 'your chosen replacement') ||
        COALESCE(' (' || customer_money(NEW.replacement_product_price) || ')', '') || '.',
      jsonb_build_object('orderId', v_order.id, 'itemId', NEW.id, 'itemName', NEW.item_name,
                         'replacementName', NEW.replacement_product_name, 'replacementPrice', NEW.replacement_product_price),
      FALSE, 'item:' || NEW.id || ':replaced', FALSE);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_order_items failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_items_customer_notify ON order_items;
CREATE TRIGGER order_items_customer_notify
  AFTER UPDATE OF shopping_status ON order_items
  FOR EACH ROW EXECUTE FUNCTION customer_notify_order_items();

-- -----------------------------------------------------
-- Replacement suggestions (shopper photo -> customer decides)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_notify_replacements() RETURNS trigger AS $$
DECLARE
  v_customer INTEGER;
  v_item RECORD;
  v_prefix TEXT := 'replacement:item:' || NEW.original_item_id || ':';
BEGIN
  SELECT customer_id INTO v_customer FROM orders WHERE id = NEW.order_id;
  SELECT id, item_name, image, price, unit_price, quantity INTO v_item FROM order_items WHERE id = NEW.original_item_id;

  IF NEW.status = 'waiting_customer' AND (
       TG_OP = 'INSERT'
       OR OLD.status IS DISTINCT FROM NEW.status
       OR OLD.photo_url IS DISTINCT FROM NEW.photo_url
     ) THEN
    -- A newer photo / option replaces the earlier request
    PERFORM customer_notify_resolve(v_customer, v_prefix, 'expired');
    PERFORM customer_notify(v_customer, NEW.order_id, NEW.original_item_id, 'replacements',
      CASE WHEN COALESCE(NEW.option_number, 1) > 1 THEN 'replacement.another'
           WHEN TG_OP = 'UPDATE' AND OLD.status = 'waiting_customer' THEN 'replacement.updated'
           ELSE 'replacement.requested' END,
      'Approve a replacement for ' || COALESCE(NULLIF(btrim(v_item.item_name), ''), 'an item'),
      CASE WHEN COALESCE(NEW.option_number, 1) > 1
           THEN 'Your shopper found another option. Approve it, ask for another, or get a refund.'
           ELSE 'Your shopper couldn''t find it and suggests a replacement. Approve it, ask for another, or get a refund.' END,
      jsonb_build_object('orderId', NEW.order_id, 'itemId', NEW.original_item_id, 'replacementId', NEW.id,
                         'optionNumber', NEW.option_number, 'photoUrl', NEW.photo_url,
                         'itemName', v_item.item_name, 'itemImage', v_item.image,
                         'itemPrice', COALESCE(v_item.unit_price, v_item.price)),
      TRUE, v_prefix || NEW.id || ':' || md5(COALESCE(NEW.photo_url, '')));
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
        AND NEW.status IN ('customer_accepted', 'customer_rejected', 'customer_requested_another') THEN
    PERFORM customer_notify_resolve(v_customer, v_prefix || NEW.id || ':', 'done');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_replacements failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS replacement_items_customer_notify ON replacement_items;
CREATE TRIGGER replacement_items_customer_notify
  AFTER INSERT OR UPDATE OF status, photo_url ON replacement_items
  FOR EACH ROW EXECUTE FUNCTION customer_notify_replacements();

-- -----------------------------------------------------
-- Extra items (shopper suggests / answers the customer's request)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_notify_item_requests() RETURNS trigger AS $$
DECLARE
  v_customer INTEGER;
  v_name TEXT := COALESCE(NULLIF(btrim(NEW.item_name), ''), 'an item');
BEGIN
  SELECT customer_id INTO v_customer FROM orders WHERE id = NEW.order_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.requested_by = 'shopper' AND NEW.status = 'pending' THEN
      PERFORM customer_notify(v_customer, NEW.order_id, NEW.order_item_id, 'order_updates', 'item_request.proposed',
        'Approve an extra item: ' || v_name,
        'Your shopper suggests adding ' || v_name ||
          COALESCE(' (' || customer_money(NEW.line_total) || ')', '') ||
          COALESCE('. Note: ' || NULLIF(btrim(NEW.note), ''), '') || '.',
        jsonb_build_object('orderId', NEW.order_id, 'requestId', NEW.id, 'itemName', NEW.item_name,
                           'itemImage', NEW.item_image, 'quantity', NEW.quantity, 'lineTotal', NEW.line_total),
        TRUE, 'itemrequest:' || NEW.id || ':pending');
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status OR OLD.status <> 'pending' THEN
    RETURN NEW;
  END IF;

  IF NEW.requested_by = 'shopper' THEN
    PERFORM customer_notify_resolve(v_customer, 'itemrequest:' || NEW.id || ':',
      CASE WHEN NEW.status = 'cancelled' THEN 'expired' ELSE 'done' END);
  ELSIF NEW.status = 'accepted' THEN
    PERFORM customer_notify(v_customer, NEW.order_id, NEW.order_item_id, 'order_updates', 'item_request.accepted',
      v_name || ' added to your order',
      'Your shopper added ' || v_name || COALESCE(' (' || customer_money(NEW.line_total) || ')', '') || '.',
      jsonb_build_object('orderId', NEW.order_id, 'requestId', NEW.id, 'itemName', NEW.item_name, 'lineTotal', NEW.line_total),
      FALSE, 'itemrequest:' || NEW.id || ':accepted');
  ELSIF NEW.status = 'rejected' THEN
    PERFORM customer_notify(v_customer, NEW.order_id, NEW.order_item_id, 'order_updates', 'item_request.rejected',
      v_name || ' couldn''t be added',
      COALESCE(NULLIF(btrim(NEW.reject_reason), ''), 'Your shopper couldn''t add it to your order') || '.',
      jsonb_build_object('orderId', NEW.order_id, 'requestId', NEW.id, 'itemName', NEW.item_name),
      FALSE, 'itemrequest:' || NEW.id || ':rejected');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_item_requests failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_item_requests_customer_notify ON order_item_requests;
CREATE TRIGGER order_item_requests_customer_notify
  AFTER INSERT OR UPDATE OF status ON order_item_requests
  FOR EACH ROW EXECUTE FUNCTION customer_notify_item_requests();

-- -----------------------------------------------------
-- Shelf price differences
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_notify_price_reports() RETURNS trigger AS $$
DECLARE
  v_customer INTEGER;
  v_name TEXT := COALESCE(NULLIF(btrim(NEW.item_name), ''), 'An item');
  v_prefix TEXT := 'pricereport:item:' || NEW.order_item_id || ':';
BEGIN
  SELECT customer_id INTO v_customer FROM orders WHERE id = NEW.order_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending' THEN
      PERFORM customer_notify(v_customer, NEW.order_id, NEW.order_item_id, 'order_updates', 'price_report.pending',
        'Approve a new price for ' || v_name,
        'The shelf price is ' || customer_money(NEW.shelf_unit_price) || ' (you ordered at ' ||
          customer_money(NEW.order_unit_price) || '). Approve the new price or skip the item.',
        jsonb_build_object('orderId', NEW.order_id, 'itemId', NEW.order_item_id, 'reportId', NEW.id,
                           'itemName', NEW.item_name, 'orderUnitPrice', NEW.order_unit_price,
                           'shelfUnitPrice', NEW.shelf_unit_price, 'lineBefore', NEW.line_before,
                           'lineAfter', NEW.line_after, 'photoUrl', NEW.photo_url),
        TRUE, v_prefix || NEW.id);
    ELSIF NEW.status = 'applied' THEN
      PERFORM customer_notify(v_customer, NEW.order_id, NEW.order_item_id, 'order_updates', 'price_report.cheaper',
        v_name || ' is cheaper in store',
        'You pay the lower shelf price: ' || customer_money(NEW.shelf_unit_price) || ' instead of ' ||
          customer_money(NEW.order_unit_price) || '.',
        jsonb_build_object('orderId', NEW.order_id, 'itemId', NEW.order_item_id, 'reportId', NEW.id),
        FALSE, v_prefix || NEW.id || ':applied', FALSE);
    ELSIF NEW.status = 'absorbed' THEN
      PERFORM customer_notify(v_customer, NEW.order_id, NEW.order_item_id, 'order_updates', 'price_report.absorbed',
        v_name || ' costs a little more in store',
        'GetMe covered ' || customer_money(NEW.getme_absorbed) || '. Your price stays the same.',
        jsonb_build_object('orderId', NEW.order_id, 'itemId', NEW.order_item_id, 'reportId', NEW.id),
        FALSE, v_prefix || NEW.id || ':absorbed', FALSE);
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND OLD.status = 'pending' THEN
    PERFORM customer_notify_resolve(v_customer, v_prefix || NEW.id,
      CASE WHEN NEW.status = 'cancelled' THEN 'expired' ELSE 'done' END);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_price_reports failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_item_price_reports_customer_notify ON order_item_price_reports;
CREATE TRIGGER order_item_price_reports_customer_notify
  AFTER INSERT OR UPDATE OF status ON order_item_price_reports
  FOR EACH ROW EXECUTE FUNCTION customer_notify_price_reports();

-- -----------------------------------------------------
-- Shopper chat messages (the chat already sends its own push, so
-- these are saved for the notification centre without a second push)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_notify_chat() RETURNS trigger AS $$
DECLARE
  v_order RECORD;
  v_shopper TEXT;
BEGIN
  IF NEW.sender_type <> 'shopper' THEN
    RETURN NEW;
  END IF;

  SELECT id, customer_id INTO v_order FROM orders WHERE id = NEW.order_id;
  SELECT customer_first_name(full_name) INTO v_shopper FROM shoppers WHERE id = NEW.sender_id;

  PERFORM customer_notify(v_order.customer_id, NEW.order_id, NULL, 'messages', 'chat.message',
    'Message from ' || COALESCE(v_shopper, 'your shopper'),
    left(COALESCE(NULLIF(btrim(NEW.message), ''), 'New message'), 300),
    jsonb_build_object('orderId', NEW.order_id, 'messageId', NEW.id),
    FALSE, 'chat:' || NEW.id, FALSE);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_chat failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_messages_customer_notify ON chat_messages;
CREATE TRIGGER chat_messages_customer_notify
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION customer_notify_chat();

-- -----------------------------------------------------
-- Receipt uploaded (checkout done at a shop)
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_notify_bills() RETURNS trigger AS $$
DECLARE
  v_customer INTEGER;
  v_shop TEXT;
BEGIN
  IF NEW.bill_uploaded_at IS NULL OR (TG_OP = 'UPDATE' AND OLD.bill_uploaded_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  SELECT customer_id INTO v_customer FROM orders WHERE id = NEW.order_id;
  SELECT shop_name INTO v_shop FROM shops WHERE id = NEW.shop_id;

  PERFORM customer_notify(v_customer, NEW.order_id, NULL, 'order_updates', 'order.checkout_done',
    'Checkout complete' || COALESCE(' at ' || v_shop, ''),
    'Your shopper paid and added the receipt. You can see it on your order.',
    jsonb_build_object('orderId', NEW.order_id, 'shopId', NEW.shop_id),
    FALSE, 'order:' || NEW.order_id || ':bill:' || NEW.shop_id, FALSE);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_bills failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_shop_bills_customer_notify ON order_shop_bills;
CREATE TRIGGER order_shop_bills_customer_notify
  AFTER INSERT OR UPDATE OF bill_uploaded_at ON order_shop_bills
  FOR EACH ROW EXECUTE FUNCTION customer_notify_bills();

-- -----------------------------------------------------
-- Card payments, refunds
-- -----------------------------------------------------

CREATE OR REPLACE FUNCTION customer_notify_card_payments() RETURNS trigger AS $$
DECLARE
  v_card TEXT;
BEGIN
  IF NEW.owner_type <> 'customer' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  v_card := COALESCE(initcap(NEW.card_brand) || ' •••• ' || NEW.card_last4, 'your card');

  IF NEW.status = 'paid' AND OLD.status NOT IN ('paid', 'partially_refunded', 'refunded') THEN
    PERFORM customer_notify(NEW.owner_id, NEW.order_id, NULL, 'payments', 'payment.paid',
      'Payment received',
      customer_money(NEW.amount) || ' charged to ' || v_card ||
        COALESCE(' for order #' || NEW.order_id, '') || '.',
      jsonb_build_object('orderId', NEW.order_id, 'paymentId', NEW.id, 'amount', NEW.amount, 'purpose', NEW.purpose),
      FALSE, 'payment:' || NEW.id || ':paid', FALSE);
  ELSIF NEW.status = 'failed' THEN
    PERFORM customer_notify(NEW.owner_id, NEW.order_id, NULL, 'payments', 'payment.failed',
      'Payment didn''t go through',
      customer_money(NEW.amount) || ' on ' || v_card || ' was not charged' ||
        COALESCE(' for order #' || NEW.order_id, '') || '. Try again or use another card.',
      jsonb_build_object('orderId', NEW.order_id, 'paymentId', NEW.id, 'amount', NEW.amount, 'purpose', NEW.purpose),
      FALSE, 'payment:' || NEW.id || ':failed');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_card_payments failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS card_payments_customer_notify ON card_payments;
CREATE TRIGGER card_payments_customer_notify
  AFTER UPDATE OF status ON card_payments
  FOR EACH ROW EXECUTE FUNCTION customer_notify_card_payments();

-- A completed refund: only written once the gateway confirms it
CREATE OR REPLACE FUNCTION customer_notify_refunds() RETURNS trigger AS $$
DECLARE
  v_payment RECORD;
BEGIN
  SELECT id, owner_type, owner_id, order_id, card_brand, card_last4 INTO v_payment
    FROM card_payments WHERE id = NEW.card_payment_id;

  IF v_payment.owner_type IS DISTINCT FROM 'customer' THEN
    RETURN NEW;
  END IF;

  PERFORM customer_notify(v_payment.owner_id, v_payment.order_id, NULL, 'refunds', 'refund.completed',
    'Refund completed',
    customer_money(NEW.amount) || ' was refunded to ' ||
      COALESCE(initcap(v_payment.card_brand) || ' •••• ' || v_payment.card_last4, 'your card') ||
      COALESCE(' for order #' || v_payment.order_id, '') || '. Your bank may take a few days to show it.',
    jsonb_build_object('orderId', v_payment.order_id, 'refundId', NEW.id, 'amount', NEW.amount, 'refundState', 'completed'),
    FALSE, 'refund:' || NEW.id);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_refunds failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS card_payment_refunds_customer_notify ON card_payment_refunds;
CREATE TRIGGER card_payment_refunds_customer_notify
  AFTER INSERT ON card_payment_refunds
  FOR EACH ROW EXECUTE FUNCTION customer_notify_refunds();

-- A refund the gateway refused / didn't answer: GetMe staff resolve it
CREATE OR REPLACE FUNCTION customer_notify_refund_requests() RETURNS trigger AS $$
DECLARE
  v_payment RECORD;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status NOT IN ('refused', 'unknown') THEN
    RETURN NEW;
  END IF;

  SELECT id, owner_type, owner_id, order_id INTO v_payment FROM card_payments WHERE id = NEW.card_payment_id;

  IF v_payment.owner_type IS DISTINCT FROM 'customer' THEN
    RETURN NEW;
  END IF;

  PERFORM customer_notify(v_payment.owner_id, v_payment.order_id, NULL, 'refunds', 'refund.delayed',
    'Your refund is delayed',
    'We couldn''t confirm your ' || customer_money(NEW.amount) || ' refund yet' ||
      COALESCE(' for order #' || v_payment.order_id, '') || '. Our team is checking it - you don''t need to do anything.',
    jsonb_build_object('orderId', v_payment.order_id, 'refundRequestId', NEW.id, 'amount', NEW.amount, 'refundState', 'delayed'),
    FALSE, 'refundrequest:' || NEW.id || ':' || NEW.status);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'customer_notify_refund_requests failed: %', SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS card_payment_refund_requests_customer_notify ON card_payment_refund_requests;
CREATE TRIGGER card_payment_refund_requests_customer_notify
  AFTER UPDATE OF status ON card_payment_refund_requests
  FOR EACH ROW EXECUTE FUNCTION customer_notify_refund_requests();
