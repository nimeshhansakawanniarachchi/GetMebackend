-- =====================================================
-- PLATFORM PHASE 25 — ledger by category (GetMe fee model, phase 24)
-- Run once: node src/sql/runSql.js src/sql/platform_phase25_ledger_categories.sql
--
-- finance_ledger rows, one per money movement or amount owed:
--   customer_payment       in       card charges (booking + extras)
--   gateway_fee            out      PayHere fee on them (GetMe's cost)
--   customer_refund        out      refunds to the card
--   grocery_expense        accrual  what the shopper paid the store
--   grocery_reimbursement  accrual  of that, payable to the shopper
--                                   (bill approved / reimbursed)
--   delivery_fee           accrual  payable to the shopper
--   priority_fee           accrual  payable to the shopper
--   service_fee            accrual  payable to the shopper
--   tip                    accrual  payable to the shopper (100%)
--   adjustment             accrual  admin adjustment to the shopper
--   commission             accrual  GetMe fee kept (GetMe's income)
--   cash_collected         accrual  cash the shopper holds for GetMe
--   shopper_payout / reimbursement_payout   out   bank transfers
--   cash_deposit           in       shopper paid collected cash in
--   getme_net_revenue      accrual  per finished order: what the
--                                   customer paid (net of refunds)
--                                   - shopper earnings - grocery
--                                   reimbursement - gateway fees
-- =====================================================

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
  -- Shopper paid the supermarket (actual grocery spend)
  SELECT
    sp.created_at, 'grocery_expense', 'accrual',
    sp.order_id, sp.shopper_id, o.customer_id,
    sp.amount_paid, sp.reference, ('Paid at store by ' || sp.method)
  FROM store_payments sp
  LEFT JOIN orders o ON o.id = sp.order_id

  UNION ALL
  -- Grocery reimbursement payable to the shopper (bill approved)
  SELECT
    COALESCE(sp.reimbursed_at, sp.updated_at), 'grocery_reimbursement', 'accrual',
    sp.order_id, sp.shopper_id, o.customer_id,
    sp.amount_paid, sp.reimbursement_reference,
    ('Grocery reimbursement (' || sp.reimbursement_status || ')')
  FROM store_payments sp
  LEFT JOIN orders o ON o.id = sp.order_id
  WHERE sp.reimbursement_status IN ('owed', 'reimbursed')

  UNION ALL
  -- Shopper earnings by category (payable to the shopper)
  SELECT
    se.created_at, c.entry_type, 'accrual',
    se.order_id, se.shopper_id, o.customer_id,
    c.amount, NULL, (c.label || ' (' || se.status || ')')
  FROM shopper_earnings se
  LEFT JOIN orders o ON o.id = se.order_id
  CROSS JOIN LATERAL (
    VALUES
      ('delivery_fee', se.delivery_fee, 'Delivery fee'),
      ('priority_fee', se.priority_fee, 'Priority fee'),
      ('service_fee', se.service_fee, 'Service fee'),
      ('tip', se.tip, 'Tip (100% to shopper)'),
      ('adjustment', se.adjustment, COALESCE('Adjustment: ' || se.adjustment_note, 'Adjustment'))
  ) AS c(entry_type, amount, label)
  WHERE se.status <> 'void' AND c.amount <> 0

  UNION ALL
  -- GetMe fee kept (GetMe's income; charged to the customer)
  SELECT
    COALESCE(o.delivered_at, o.updated_at), 'commission', 'accrual',
    o.id, o.shopper_id, o.customer_id,
    o.getme_fee_kept, NULL, (o.getme_fee_percent || '% GetMe fee')
  FROM orders o
  WHERE o.getme_fee_kept IS NOT NULL AND o.getme_fee_kept > 0

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
  FROM shopper_payouts p

  UNION ALL
  -- GetMe's net revenue per settled order (delivered, or cancelled
  -- with its GetMe fee recorded): customer paid - shopper earnings
  -- - grocery reimbursement - gateway fees. Below the GetMe fee when
  -- a bill came in above the prices the customer was charged.
  SELECT
    COALESCE(o.delivered_at, o.updated_at), 'getme_net_revenue', 'accrual',
    o.id, o.shopper_id, o.customer_id,
    ROUND(
      COALESCE(pay.net_paid, 0) + COALESCE(se.cash_collected, 0)
      - COALESCE(se.net_amount, 0) - COALESCE(gro.reimbursable, 0) - COALESCE(pay.gateway, 0),
      2
    ),
    NULL, 'Customer paid - shopper earnings - groceries - gateway fees'
  FROM orders o
  LEFT JOIN shopper_earnings se ON se.order_id = o.id AND se.status <> 'void'
  LEFT JOIN LATERAL (
    SELECT
      SUM(cp.amount - cp.refunded_amount) AS net_paid,
      SUM(cp.gateway_fee) AS gateway
    FROM card_payments cp
    WHERE cp.order_id = o.id AND cp.purpose IN ('order', 'order_extra')
      AND cp.paid_at IS NOT NULL AND cp.status IN ('paid', 'partially_refunded', 'refunded')
  ) pay ON TRUE
  LEFT JOIN LATERAL (
    SELECT SUM(sp.amount_paid) AS reimbursable
    FROM store_payments sp
    WHERE sp.order_id = o.id AND sp.reimbursement_status IN ('owed', 'held', 'reimbursed')
  ) gro ON TRUE
  WHERE o.getme_fee_kept IS NOT NULL;
