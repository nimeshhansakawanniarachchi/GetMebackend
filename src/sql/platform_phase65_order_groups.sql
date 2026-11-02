-- =====================================================
-- PHASE 65: ONE CHECKOUT FOR EVERY CATEGORY (2026-11-02)
-- Additive only. Existing orders, payments and refunds are untouched.
--
-- order_groups = the customer's ONE purchase ("parent order", GM-1001):
--   one Place Order, one reference, one card charge (card) for
--   everything. Its child orders are ordinary rows in `orders`
--   (grocery: one order for every supermarket, restaurant / clothing:
--   one order per store), each following its own existing workflow.
--   orders.order_group_id links a child to its parent (NULL = an order
--   placed the old way, which keeps working exactly as before).
--
-- One card charge for the parent: card_payments row with purpose
-- 'order_group' and order_group_id set (order_id NULL). Each child's
-- share is a card_payment_allocations row. Refunds for one child are
-- taken from that share only: a refund request / refund remembers the
-- child (order_id), so a child's refunded amount is always the sum of
-- its own refunds (no second counter that could drift).
-- =====================================================

CREATE TABLE IF NOT EXISTS order_groups (
  id SERIAL PRIMARY KEY,
  -- customer-facing reference, e.g. GM-1001 (set right after insert)
  reference VARCHAR(20) UNIQUE,
  customer_id INTEGER NOT NULL,
  payment_method VARCHAR(10) NOT NULL CHECK (payment_method IN ('card', 'cash')),
  payment_card_id INTEGER,
  -- placing:  children being created / card being charged
  -- placed:   every child created and booked (card paid if card)
  -- payment_failed: the card was declined; every child was cancelled
  -- failed:   could not be completed (children cancelled, any charge refunded)
  state VARCHAR(16) NOT NULL DEFAULT 'placing'
    CHECK (state IN ('placing', 'placed', 'payment_failed', 'failed')),
  state_message VARCHAR(300),
  items_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  delivery_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  fees_total NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  delivery_address VARCHAR(500),
  delivery_latitude NUMERIC(10, 7),
  delivery_longitude NUMERIC(10, 7),
  client_request_id VARCHAR(64),
  card_payment_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_groups_customer ON order_groups (customer_id, id DESC);

-- Same "Place order" request twice (double tap / retry) = the same parent
CREATE UNIQUE INDEX IF NOT EXISTS order_groups_request
  ON order_groups (customer_id, client_request_id) WHERE client_request_id IS NOT NULL;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_group_id INTEGER;
CREATE INDEX IF NOT EXISTS orders_order_group ON orders (order_group_id) WHERE order_group_id IS NOT NULL;

-- One charge for a parent order
ALTER TABLE card_payments ADD COLUMN IF NOT EXISTS order_group_id INTEGER;
CREATE INDEX IF NOT EXISTS card_payments_order_group ON card_payments (order_group_id) WHERE order_group_id IS NOT NULL;

ALTER TABLE card_payments DROP CONSTRAINT IF EXISTS card_payments_purpose_check;
ALTER TABLE card_payments ADD CONSTRAINT card_payments_purpose_check
  CHECK (purpose IN ('order', 'order_extra', 'store_bill', 'order_group'));

-- Each child's share of the parent's one charge
CREATE TABLE IF NOT EXISTS card_payment_allocations (
  id SERIAL PRIMARY KEY,
  card_payment_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (card_payment_id, order_id)
);

CREATE INDEX IF NOT EXISTS card_payment_allocations_order ON card_payment_allocations (order_id);

-- Which child a refund of a shared charge belongs to (NULL = the whole payment / old refunds)
ALTER TABLE card_payment_refund_requests ADD COLUMN IF NOT EXISTS order_id INTEGER;
ALTER TABLE card_payment_refunds ADD COLUMN IF NOT EXISTS order_id INTEGER;
CREATE INDEX IF NOT EXISTS card_payment_refunds_order ON card_payment_refunds (card_payment_id, order_id);

-- 2026-11-02 (user request): no vehicle choice in checkout. A purchase with
-- groceries waits for the ORIGINAL "Choose a vehicle" step ('awaiting_vehicle');
-- that booking books every child and charges once.
ALTER TABLE order_groups DROP CONSTRAINT IF EXISTS order_groups_state_check;
ALTER TABLE order_groups ADD CONSTRAINT order_groups_state_check
  CHECK (state IN ('placing', 'awaiting_vehicle', 'placed', 'payment_failed', 'failed'));
