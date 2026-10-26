-- =====================================================
-- PLATFORM PHASE 23 — commission on delivery + service fees,
-- payouts after delivery + approved bills, gateway fees
-- Run once: node src/sql/runSql.js src/sql/platform_phase23_commission_model.sql
--
-- Per delivered order (src/controllers/shopperPay.js):
--   commission base = delivery fee + fast fee + service fee
--                     (groceries and tip excluded)
--   commission      = SHOPPER_COMMISSION_PERCENT (15) of that base
--   shopper earns   = delivery + fast fee + tip - commission
--   GetMe keeps     = service fee + commission (gateway fee is GetMe's cost)
-- Grocery reimbursement (store_payments) stays a separate record.
--
-- Settlement states (settlementController.refreshOrderSettlement):
--   shopper_earnings.status  awaiting_bills -> payable (every shop
--                            bill uploaded + approved) -> paid
--   store_payments.reimbursement_status  pending (not delivered) ->
--                            owed (delivered + approved) | held (review)
-- =====================================================

ALTER TABLE shopper_earnings DROP CONSTRAINT IF EXISTS shopper_earnings_status_check;
ALTER TABLE shopper_earnings ADD CONSTRAINT shopper_earnings_status_check
  CHECK (status IN ('awaiting_bills', 'payable', 'held', 'paid', 'void'));

ALTER TABLE shopper_earnings
  ADD COLUMN IF NOT EXISTS service_fee NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE store_payments DROP CONSTRAINT IF EXISTS store_payments_reimbursement_status_check;
ALTER TABLE store_payments ADD CONSTRAINT store_payments_reimbursement_status_check
  CHECK (reimbursement_status IN ('pending', 'owed', 'held', 'reimbursed'));

-- PayHere's fee on each card charge (GetMe's cost), fixed at charge
-- time from PAYHERE_FEE_PERCENT
ALTER TABLE card_payments
  ADD COLUMN IF NOT EXISTS gateway_fee NUMERIC(12, 2) NOT NULL DEFAULT 0;

DROP VIEW IF EXISTS finance_ledger;

CREATE VIEW finance_ledger AS
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
  -- PayHere's fee on those charges (GetMe absorbs it)
  SELECT
    cp.paid_at, 'gateway_fee', 'out',
    cp.order_id, NULL, o.customer_id,
    cp.gateway_fee, cp.gateway_payment_id, 'Payment gateway fee'
  FROM card_payments cp
  LEFT JOIN orders o ON o.id = cp.order_id
  WHERE cp.purpose IN ('order', 'order_extra') AND cp.paid_at IS NOT NULL
    AND cp.status IN ('paid', 'partially_refunded', 'refunded') AND cp.gateway_fee > 0

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
  -- Delivery fees charged to the customer
  SELECT
    se.created_at, 'delivery_fee', 'accrual',
    se.order_id, se.shopper_id, o.customer_id,
    se.delivery_pay, NULL, 'Delivery + fast fee'
  FROM shopper_earnings se
  LEFT JOIN orders o ON o.id = se.order_id
  WHERE se.status <> 'void'

  UNION ALL
  -- GetMe's commission on the delivery + service fees
  SELECT
    se.created_at, 'commission', 'accrual',
    se.order_id, se.shopper_id, o.customer_id,
    se.commission, NULL, (se.commission_percent || '% of delivery + service fees')
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
