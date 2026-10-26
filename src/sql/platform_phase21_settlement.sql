-- =====================================================
-- PLATFORM PHASE 21 — shopper settlement + finance ledger
-- Run once: node src/sql/runSql.js src/sql/platform_phase21_settlement.sql
--
-- Money per delivered order:
--   customer -> GetMe   card charge at booking (card_payments), or
--                       cash the shopper collected at the door
--   shopper  -> store   groceries, the shopper's own money
--                       (store_payments) - reimbursed separately
--   GetMe    -> shopper delivery earnings = delivery + fast fee
--                       - commission (SHOPPER_COMMISSION_PERCENT,
--                       delivery fees only) + 100% of the tip
--
-- shopper_earnings: one row per delivered order, written when the
-- delivery PIN is confirmed (before that the earning is pending).
--   payable -> held (disputed) -> payable | void ; payable -> paid
-- shopper_payouts: money moved between GetMe and a shopper, recorded
-- with the bank reference. kind earnings / reimbursement go out;
-- cash_deposit comes in (cash the shopper collected for GetMe).
-- =====================================================

CREATE TABLE IF NOT EXISTS shopper_payouts (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('earnings', 'reimbursement', 'cash_deposit')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reference VARCHAR(60) NOT NULL,
  note TEXT,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The same bank transfer can't be recorded twice
  UNIQUE (kind, reference)
);

CREATE INDEX IF NOT EXISTS shopper_payouts_shopper_idx ON shopper_payouts (shopper_id);

CREATE TABLE IF NOT EXISTS shopper_earnings (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders (id),
  shopper_id INTEGER NOT NULL,
  delivery_pay NUMERIC(12, 2) NOT NULL,
  commission_percent NUMERIC(5, 2) NOT NULL,
  commission NUMERIC(12, 2) NOT NULL,
  tip NUMERIC(12, 2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(12, 2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'payable'
    CHECK (status IN ('payable', 'held', 'paid', 'void')),
  dispute_note TEXT,
  payout_id INTEGER REFERENCES shopper_payouts (id),
  -- Cash orders: what the shopper collected at the door for GetMe
  cash_collected NUMERIC(12, 2) NOT NULL DEFAULT 0,
  cash_status VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (cash_status IN ('none', 'due', 'deposited')),
  cash_payout_id INTEGER REFERENCES shopper_payouts (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS shopper_earnings_shopper_idx ON shopper_earnings (shopper_id, status);

-- Grocery reimbursements paid in a batch transfer
ALTER TABLE store_payments
  ADD COLUMN IF NOT EXISTS payout_id INTEGER REFERENCES shopper_payouts (id);

-- =====================================================
-- FINANCE LEDGER (read-only view over the tables above)
-- flow: in = money reaching GetMe, out = money leaving GetMe,
--       accrual = earned / owed but no money moved yet
-- =====================================================

CREATE OR REPLACE VIEW finance_ledger AS
  -- Customer card charges (booking + approved extras)
  SELECT
    cp.paid_at AS entry_at, 'customer_payment'::text AS entry_type, 'in'::text AS flow,
    cp.order_id, NULL::int AS shopper_id, o.customer_id,
    cp.amount::numeric AS amount, cp.gateway_payment_id::text AS reference,
    ('Card ' || COALESCE(cp.card_brand, '') || ' ' || COALESCE(cp.card_last4, ''))::text AS description
  FROM card_payments cp
  LEFT JOIN orders o ON o.id = cp.order_id
  WHERE cp.purpose IN ('order', 'order_extra') AND cp.paid_at IS NOT NULL
    AND cp.status IN ('paid', 'partially_refunded', 'refunded')

  UNION ALL
  -- Refunds back to the customer's card
  SELECT
    r.created_at, 'customer_refund', 'out',
    cp.order_id, NULL, o.customer_id,
    r.amount, r.gateway_refund_id, COALESCE(r.reason, 'Refund')
  FROM card_payment_refunds r
  JOIN card_payments cp ON cp.id = r.card_payment_id
  LEFT JOIN orders o ON o.id = cp.order_id
  WHERE cp.purpose IN ('order', 'order_extra')

  UNION ALL
  -- Shopper paid the supermarket (GetMe owes it back)
  SELECT
    sp.created_at, 'grocery_expense', 'accrual',
    sp.order_id, sp.shopper_id, o.customer_id,
    sp.amount_paid, sp.reference, ('Paid at store by ' || sp.method)
  FROM store_payments sp
  LEFT JOIN orders o ON o.id = sp.order_id

  UNION ALL
  -- Delivery fees charged to the customer (shopper's gross pay)
  SELECT
    se.created_at, 'delivery_fee', 'accrual',
    se.order_id, se.shopper_id, o.customer_id,
    se.delivery_pay, NULL, 'Delivery + fast fee'
  FROM shopper_earnings se
  LEFT JOIN orders o ON o.id = se.order_id
  WHERE se.status <> 'void'

  UNION ALL
  -- GetMe's commission on the delivery fees
  SELECT
    se.created_at, 'commission', 'accrual',
    se.order_id, se.shopper_id, o.customer_id,
    se.commission, NULL, (se.commission_percent || '% of delivery fees')
  FROM shopper_earnings se
  LEFT JOIN orders o ON o.id = se.order_id
  WHERE se.status <> 'void'

  UNION ALL
  -- Service fee kept by GetMe (delivered orders)
  SELECT
    o.delivered_at, 'service_fee', 'accrual',
    o.id, o.shopper_id, o.customer_id,
    o.service_fee, NULL, 'Service fee'
  FROM orders o
  WHERE o.status = 'delivered' AND COALESCE(o.service_fee, 0) > 0

  UNION ALL
  -- Shopper's net delivery earnings (owed until paid out)
  SELECT
    se.created_at, 'shopper_earnings', 'accrual',
    se.order_id, se.shopper_id, o.customer_id,
    se.net_amount, NULL, ('Delivery earnings (' || se.status || ')')
  FROM shopper_earnings se
  LEFT JOIN orders o ON o.id = se.order_id
  WHERE se.status <> 'void'

  UNION ALL
  -- Cash the shopper collected from the customer for GetMe
  SELECT
    se.created_at, 'cash_collected', 'accrual',
    se.order_id, se.shopper_id, o.customer_id,
    se.cash_collected, NULL, 'Cash collected at the door'
  FROM shopper_earnings se
  LEFT JOIN orders o ON o.id = se.order_id
  WHERE se.cash_collected > 0

  UNION ALL
  -- Transfers between GetMe and shoppers (every reimbursement and
  -- earnings payout is recorded here once, with its bank reference)
  SELECT
    p.created_at,
    CASE p.kind
      WHEN 'earnings' THEN 'shopper_payout'
      WHEN 'reimbursement' THEN 'reimbursement_payout'
      ELSE 'cash_deposit'
    END,
    CASE WHEN p.kind = 'cash_deposit' THEN 'in' ELSE 'out' END,
    NULL, p.shopper_id, NULL,
    p.amount, p.reference, COALESCE(p.note, p.kind)
  FROM shopper_payouts p;
