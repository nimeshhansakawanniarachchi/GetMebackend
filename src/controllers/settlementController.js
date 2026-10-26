const pool = require('../config/db');

const { emitToAdmins, broadcastOrderChange } = require('../realtime');
const { readPage, pageMeta } = require('../utils/pagination');
const { splitShopperPay } = require('./shopperPay');
const { serviceUnitsSql } = require('../pricing/fees');
const { createShopperNotification } = require('./shopperNotificationController');
const { syncOrderReimbursement } = require('./storePaymentController');

// =====================================================
// SHOPPER SETTLEMENT (sql/platform_phase21_settlement.sql)
// Three separate balances per shopper, never netted:
//   earnings      delivery fee + priority fee + service fee (items
//                 bought) + 100% tip + adjustments - nothing deducted
//                 (GetMe's fee is charged to the customer, shopperPay.js),
//                 written when the delivery PIN is confirmed (failed
//                 delivery: the delivery fee only, by refresh below):
//                 awaiting_bills -> payable (every shop's bill
//                 uploaded + approved) -> paid; held (dispute) ->
//                 back to awaiting/payable | void
//   reimbursement groceries the shopper paid for (store_payments):
//                 pending until delivery, then owed (bill approved)
//                 or held (bill under review); paid by payout
//   cash due      cash orders: what the shopper collected at the door
//                 for GetMe; settled by a cash deposit
// Payouts / deposits are recorded with the bank reference
// (UNIQUE kind + reference) and must match the balance the admin
// saw, so the same money can't be paid or recorded twice.
//
// Socket: 'shopper-earnings-updated' -> shopper:{id} and admins.
// =====================================================

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const toId = (value) => {
  const id = Number(value);

  return Number.isInteger(id) && id > 0 ? id : null;
};

const announce = (io, shopperId, payload = {}) => {
  try {
    if (!io) return;

    io.to(`shopper:${shopperId}`).emit('shopper-earnings-updated', { shopperId, ...payload });
    emitToAdmins(io, 'admin:settlement-updated', { shopperId, ...payload });

    if (payload.orderId) {
      broadcastOrderChange(io, payload.orderId, { event: 'shopper-earnings-updated' });
    }
  } catch (error) {
    console.error('❌ SETTLEMENT SOCKET ERROR:', error.message);
  }
};

// =====================================================
// WHAT EACH SIDE GETS FROM A FINISHED ORDER
// p = orders.getme_fee_percent
//   delivered        GetMe keeps getme_fee less the GetMe share of
//                    refunded items (refund = (line + service) x (1+p))
//   cancelled        GetMe keeps p of the groceries bought (+ the
//                    delivery fee on a failed delivery) - what the
//                    customer still pays (paymentService.owedForOrder)
// =====================================================

const refundedUnits = async (db, orderId) =>
  Number(
    (
      await db.query(
        `
        SELECT COALESCE(SUM(${serviceUnitsSql('oi')}), 0)::float AS units
        FROM order_items oi
        WHERE oi.order_id = $1 AND oi.shopping_status = 'refunded'
        `,
        [orderId]
      )
    ).rows[0].units
  ) || 0;

const getmeFeeKept = async (db, order) => {
  const percent = Number(order.getme_fee_percent ?? 15);

  if (order.status === 'delivered') {
    const refunds = Number(
      (
        await db.query(
          `
          SELECT COALESCE(SUM(refund_amount), 0)::float AS total
          FROM order_items
          WHERE order_id = $1 AND shopping_status = 'refunded'
          `,
          [order.id]
        )
      ).rows[0].total
    ) || 0;

    return round2(
      Math.max(0, Number(order.getme_fee || 0) - (refunds * percent) / (100 + percent))
    );
  }

  const groceries = Number(
    (
      await db.query(
        `
        SELECT COALESCE(SUM(COALESCE(price, 0) * COALESCE(quantity, 1)), 0)::float AS total
        FROM order_items
        WHERE order_id = $1 AND shopping_status IN ('found', 'replaced', 'done', 'completed')
        `,
        [order.id]
      )
    ).rows[0].total
  ) || 0;

  const delivery = order.failed_delivery_at ? Number(order.delivery_fee || 0) : 0;

  return round2(((groceries + delivery) * percent) / 100);
};

// =====================================================
// DELIVERED -> EARNING (+ cash collected for cash orders)
// Called after the delivery PIN is confirmed. Once per order.
// =====================================================

const recordDeliveredEarnings = async (order, io) => {
  try {
    // Unavailable (refunded) items take their service fee back
    const units = await refundedUnits(pool, order.id);
    const service = Math.max(
      0,
      Number(order.service_fee || 0) - Number(order.service_fee_per_unit || 0) * units
    );

    const split = splitShopperPay({
      deliveryFee: order.delivery_fee,
      fastFee: order.fast_delivery_fee,
      serviceFee: service,
      tip: order.tip_amount,
    });

    const kept = await getmeFeeKept(pool, { ...order, status: 'delivered' });

    // Cash orders: the customer paid the shopper at the door the
    // order total less refunded (unavailable) items
    let cashCollected = 0;

    if (order.payment_method === 'cash') {
      const refunds = (
        await pool.query(
          `
          SELECT COALESCE(SUM(refund_amount), 0)::float AS total
          FROM order_items
          WHERE order_id = $1 AND shopping_status = 'refunded'
          `,
          [order.id]
        )
      ).rows[0].total;

      cashCollected = round2(Math.max(0, Number(order.total_amount || 0) - Number(refunds || 0)));
    }

    const row = (
      await pool.query(
        `
        INSERT INTO shopper_earnings (
          order_id, shopper_id, delivery_pay, delivery_fee, priority_fee, service_fee,
          commission_percent, commission, tip, net_amount, cash_collected, cash_status, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'awaiting_bills')
        ON CONFLICT (order_id) DO NOTHING
        RETURNING *
        `,
        [
          order.id,
          order.shopper_id,
          split.deliveryPay,
          split.deliveryFee,
          split.priorityFee,
          split.serviceFee,
          // commission = the GetMe fee GetMe keeps (paid by the
          // customer, not taken from the shopper)
          Number(order.getme_fee_percent ?? 15),
          kept,
          split.tip,
          split.net,
          cashCollected,
          cashCollected > 0 ? 'due' : 'none',
        ]
      )
    ).rows[0];

    await pool.query('UPDATE orders SET getme_fee_kept = $2 WHERE id = $1', [order.id, kept]);

    // Payable only once every shop's bill is in and approved
    await refreshOrderSettlement(order.id, io);

    return row || null;
  } catch (error) {
    console.error('❌ RECORD EARNINGS ERROR:', order?.id, error.message);
    return null;
  }
};

// =====================================================
// REFRESH AN ORDER'S SETTLEMENT
// Works out, from the records, what is payable now. Idempotent;
// call after delivery, a store payment / bill / review, a dispute
// release or a cancellation.
//   bills verified = every shop the shopper bought from has a store
//                    payment whose bill is uploaded (locked) and whose
//                    review is ok / approved
//   earnings       awaiting_bills <-> payable (held / paid / void kept)
//   reimbursement  pending until the order is delivered (or
//                  cancelled), then owed (approved) / held (review)
//   cancelled      GetMe fee kept is recorded; a failed delivery
//                  also earns the shopper the delivery fee
// =====================================================

const BOUGHT_STATUSES = ['done', 'found', 'replaced', 'completed'];
const APPROVED_REVIEWS = ['ok', 'approved'];

const refreshOrderSettlement = async (orderId, io) => {
  const id = Number(orderId);
  const client = await pool.connect();
  let shopperId = null;
  let changed = false;

  try {
    await client.query('BEGIN');

    const order = (
      await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id])
    ).rows[0];

    if (!order) {
      await client.query('ROLLBACK');
      return null;
    }

    shopperId = Number(order.shopper_id) || null;

    if (order.status === 'cancelled') {
      const kept = await getmeFeeKept(client, order);

      if (Number(order.getme_fee_kept) !== kept || order.getme_fee_kept == null) {
        await client.query('UPDATE orders SET getme_fee_kept = $2 WHERE id = $1', [id, kept]);
      }

      // Failed delivery: the shopper still earns the delivery fee
      if (order.failed_delivery_at && shopperId) {
        const split = splitShopperPay({ deliveryFee: order.delivery_fee });

        const inserted = await client.query(
          `
          INSERT INTO shopper_earnings (
            order_id, shopper_id, delivery_pay, delivery_fee, priority_fee, service_fee,
            commission_percent, commission, tip, net_amount, cash_collected, cash_status,
            adjustment_note, status
          )
          VALUES ($1, $2, $3, $3, 0, 0, $4, $5, 0, $6, 0, 'none', 'Failed delivery', 'awaiting_bills')
          ON CONFLICT (order_id) DO NOTHING
          `,
          [id, shopperId, split.deliveryFee, Number(order.getme_fee_percent ?? 15), kept, split.net]
        );

        changed = changed || inserted.rowCount > 0;
      }
    }

    const payments = (
      await client.query('SELECT * FROM store_payments WHERE order_id = $1 FOR UPDATE', [id])
    ).rows;

    const billShops = (
      await client.query(
        `
        SELECT DISTINCT shop_id FROM order_items
        WHERE order_id = $1 AND LOWER(COALESCE(shopping_status, '')) = ANY($2)
        `,
        [id, BOUGHT_STATUSES]
      )
    ).rows.map((row) => Number(row.shop_id));

    const verified = (payment) =>
      Boolean(payment?.locked_at) && APPROVED_REVIEWS.includes(payment.review_status);

    const billsVerified = billShops.every((shopId) =>
      verified(payments.find((payment) => Number(payment.shop_id) === shopId))
    );

    const settled = ['delivered', 'cancelled'].includes(order.status);

    for (const payment of payments) {
      if (payment.reimbursement_status === 'reimbursed') continue;

      const target = !settled ? 'pending' : verified(payment) ? 'owed' : 'held';

      if (target !== payment.reimbursement_status) {
        await client.query(
          'UPDATE store_payments SET reimbursement_status = $2, updated_at = NOW() WHERE id = $1',
          [payment.id, target]
        );
        changed = true;
      }
    }

    const earnings = await client.query(
      `
      UPDATE shopper_earnings
      SET status = $2::varchar, updated_at = NOW()
      WHERE order_id = $1 AND status IN ('awaiting_bills', 'payable') AND status <> $2::varchar
      RETURNING id
      `,
      [id, billsVerified ? 'payable' : 'awaiting_bills']
    );

    changed = changed || earnings.rowCount > 0;

    if (payments.length > 0) {
      await syncOrderReimbursement(client, id);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ REFRESH SETTLEMENT ERROR:', id, error.message);
    return null;
  } finally {
    client.release();
  }

  if (changed && shopperId) {
    announce(io, shopperId, { orderId: id });
  }

  return { changed };
};

// =====================================================
// BALANCES
// =====================================================

const BALANCES_SQL = `
  SELECT
    sh.id AS shopper_id,
    sh.full_name,
    sh.mobile,
    COALESCE(e.awaiting, 0)::float AS earnings_awaiting,
    COALESCE(e.payable, 0)::float AS earnings_payable,
    COALESCE(e.payable_count, 0)::int AS earnings_payable_count,
    COALESCE(e.held, 0)::float AS earnings_held,
    COALESCE(e.held_count, 0)::int AS earnings_held_count,
    COALESCE(e.paid, 0)::float AS earnings_paid,
    COALESCE(g.kept, 0)::float AS commission_total,
    COALESCE(e.cash_due, 0)::float AS cash_due,
    COALESCE(r.owed, 0)::float AS reimbursement_owed,
    COALESCE(r.owed_count, 0)::int AS reimbursement_owed_count,
    COALESCE(r.held, 0)::float AS reimbursement_held,
    COALESCE(r.pending, 0)::float AS reimbursement_pending,
    COALESCE(r.reimbursed, 0)::float AS reimbursement_paid
  FROM shoppers sh
  LEFT JOIN (
    SELECT
      shopper_id,
      SUM(net_amount) FILTER (WHERE status = 'awaiting_bills') AS awaiting,
      SUM(net_amount) FILTER (WHERE status = 'payable') AS payable,
      COUNT(*) FILTER (WHERE status = 'payable') AS payable_count,
      SUM(net_amount) FILTER (WHERE status = 'held') AS held,
      COUNT(*) FILTER (WHERE status = 'held') AS held_count,
      SUM(net_amount) FILTER (WHERE status = 'paid') AS paid,
      SUM(cash_collected) FILTER (WHERE cash_status = 'due') AS cash_due
    FROM shopper_earnings
    GROUP BY shopper_id
  ) e ON e.shopper_id = sh.id
  -- GetMe fee kept on the shopper's finished orders
  LEFT JOIN (
    SELECT shopper_id, SUM(getme_fee_kept) AS kept
    FROM orders
    WHERE shopper_id IS NOT NULL AND getme_fee_kept IS NOT NULL
    GROUP BY shopper_id
  ) g ON g.shopper_id = sh.id
  LEFT JOIN (
    SELECT
      shopper_id,
      SUM(amount_paid) FILTER (WHERE reimbursement_status = 'owed') AS owed,
      COUNT(*) FILTER (WHERE reimbursement_status = 'owed') AS owed_count,
      SUM(amount_paid) FILTER (WHERE reimbursement_status = 'held') AS held,
      SUM(amount_paid) FILTER (WHERE reimbursement_status = 'pending') AS pending,
      SUM(amount_paid) FILTER (WHERE reimbursement_status = 'reimbursed') AS reimbursed
    FROM store_payments
    GROUP BY shopper_id
  ) r ON r.shopper_id = sh.id
`;

const toBalance = (row) => ({
  shopperId: Number(row.shopper_id),
  name: row.full_name,
  mobile: row.mobile,
  earningsAwaiting: row.earnings_awaiting,
  earningsPayable: row.earnings_payable,
  earningsPayableCount: row.earnings_payable_count,
  earningsHeld: row.earnings_held,
  earningsHeldCount: row.earnings_held_count,
  earningsPaid: row.earnings_paid,
  commissionTotal: row.commission_total,
  cashDue: row.cash_due,
  reimbursementOwed: row.reimbursement_owed,
  reimbursementOwedCount: row.reimbursement_owed_count,
  reimbursementHeld: row.reimbursement_held,
  reimbursementPending: row.reimbursement_pending,
  reimbursementPaid: row.reimbursement_paid,
});

// GET /api/admin/settlements
const listSettlements = async (req, res) => {
  try {
    const rows = (
      await pool.query(
        `
        SELECT * FROM (${BALANCES_SQL}) b
        WHERE earnings_awaiting + earnings_payable + earnings_held + cash_due + reimbursement_owed
              + reimbursement_held + reimbursement_pending + earnings_paid + reimbursement_paid > 0
        ORDER BY (earnings_payable + reimbursement_owed) DESC, full_name
        `
      )
    ).rows.map(toBalance);

    const sum = (key) => round2(rows.reduce((total, row) => total + Number(row[key] || 0), 0));

    const [payouts, earnings] = await Promise.all([
      pool.query(
        `
        SELECT p.*, sh.full_name
        FROM shopper_payouts p
        LEFT JOIN shoppers sh ON sh.id = p.shopper_id
        ORDER BY p.created_at DESC
        LIMIT 20
        `
      ),
      pool.query(
        `
        SELECT se.*, sh.full_name, o.delivered_at
        FROM shopper_earnings se
        LEFT JOIN shoppers sh ON sh.id = se.shopper_id
        LEFT JOIN orders o ON o.id = se.order_id
        WHERE se.status IN ('awaiting_bills', 'payable', 'held')
        ORDER BY (se.status = 'held') DESC, se.created_at DESC
        LIMIT 100
        `
      ),
    ]);

    return res.json({
      success: true,
      summary: {
        earningsAwaiting: sum('earningsAwaiting'),
        earningsPayable: sum('earningsPayable'),
        earningsHeld: sum('earningsHeld'),
        reimbursementOwed: sum('reimbursementOwed'),
        cashDue: sum('cashDue'),
        commissionTotal: sum('commissionTotal'),
      },
      shoppers: rows,
      openEarnings: earnings.rows.map((row) => ({
        orderId: Number(row.order_id),
        shopperId: Number(row.shopper_id),
        shopperName: row.full_name,
        deliveryPay: Number(row.delivery_pay),
        deliveryFee: Number(row.delivery_fee),
        priorityFee: Number(row.priority_fee),
        serviceFee: Number(row.service_fee),
        commission: Number(row.commission),
        commissionPercent: Number(row.commission_percent),
        tip: Number(row.tip),
        adjustment: Number(row.adjustment),
        adjustmentNote: row.adjustment_note,
        netAmount: Number(row.net_amount),
        status: row.status,
        disputeNote: row.dispute_note,
        cashCollected: Number(row.cash_collected),
        deliveredAt: row.delivered_at,
      })),
      recentPayouts: payouts.rows.map((row) => ({
        id: Number(row.id),
        shopperId: Number(row.shopper_id),
        shopperName: row.full_name,
        kind: row.kind,
        amount: Number(row.amount),
        reference: row.reference,
        note: row.note,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ LIST SETTLEMENTS ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load settlements' });
  }
};

// =====================================================
// PAYOUT / DEPOSIT
// POST /api/admin/settlements/shoppers/:shopperId/payouts
// { kind: earnings | reimbursement | cash_deposit, amount, reference, note }
// amount = the balance the admin saw; 409 if it changed meanwhile.
// =====================================================

const PAYOUT_KINDS = {
  earnings: {
    rows: `
      SELECT id, order_id, net_amount AS amount FROM shopper_earnings
      WHERE shopper_id = $1 AND status = 'payable' FOR UPDATE`,
    settle: `
      UPDATE shopper_earnings
      SET status = 'paid', payout_id = $2, paid_at = NOW(), updated_at = NOW()
      WHERE id = ANY($1)`,
    title: (amount) => `Paid out Rs ${amount.toFixed(2)}`,
    label: 'delivery earnings',
  },
  reimbursement: {
    rows: `
      SELECT id, order_id, amount_paid AS amount FROM store_payments
      WHERE shopper_id = $1 AND reimbursement_status = 'owed' FOR UPDATE`,
    settle: `
      UPDATE store_payments
      SET reimbursement_status = 'reimbursed', payout_id = $2, reimbursement_reference = $3,
          reimbursed_at = NOW(), reimbursed_by = $4, updated_at = NOW()
      WHERE id = ANY($1)`,
    title: (amount) => `Reimbursed Rs ${amount.toFixed(2)}`,
    label: 'grocery reimbursements',
  },
  cash_deposit: {
    rows: `
      SELECT id, order_id, cash_collected AS amount FROM shopper_earnings
      WHERE shopper_id = $1 AND cash_status = 'due' FOR UPDATE`,
    settle: `
      UPDATE shopper_earnings
      SET cash_status = 'deposited', cash_payout_id = $2, updated_at = NOW()
      WHERE id = ANY($1)`,
    title: (amount) => `Cash deposit of Rs ${amount.toFixed(2)} received`,
    label: 'cash collected',
  },
};

const recordPayout = async (req, res) => {
  const shopperId = toId(req.params.shopperId);
  const kind = req.body?.kind;
  const spec = PAYOUT_KINDS[kind];
  const amount = round2(req.body?.amount);
  const reference = String(req.body?.reference || '').trim().slice(0, 60);
  const note = String(req.body?.note || '').trim().slice(0, 300) || null;

  if (!shopperId || !spec) {
    return res.status(400).json({ success: false, message: 'Choose a shopper and what is being settled' });
  }

  if (reference.length < 3) {
    return res.status(400).json({ success: false, message: 'Enter the bank transfer reference' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const rows = (await client.query(spec.rows, [shopperId])).rows;
    const total = round2(rows.reduce((sum, row) => sum + Number(row.amount), 0));

    if (rows.length === 0 || !(total > 0)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: `No ${spec.label} to settle for this shopper` });
    }

    if (Math.abs(total - amount) > 0.009) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        code: 'AMOUNT_CHANGED',
        message: `The balance is now Rs ${total.toFixed(2)}. Refresh and check before recording.`,
        amount: total,
      });
    }

    let payout;

    try {
      payout = (
        await client.query(
          `
          INSERT INTO shopper_payouts (shopper_id, kind, amount, reference, note, created_by)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *
          `,
          [shopperId, kind, total, reference, note, req.admin.adminId]
        )
      ).rows[0];
    } catch (error) {
      if (error.code === '23505') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          code: 'DUPLICATE_REFERENCE',
          message: 'This bank reference is already recorded',
        });
      }

      throw error;
    }

    const ids = rows.map((row) => row.id);

    await client.query(
      spec.settle,
      kind === 'reimbursement' ? [ids, payout.id, reference, req.admin.adminId] : [ids, payout.id]
    );

    if (kind === 'reimbursement') {
      for (const orderId of new Set(rows.map((row) => row.order_id))) {
        await syncOrderReimbursement(client, orderId);
      }
    }

    await client.query('COMMIT');

    const io = req.app.get('io');

    announce(io, shopperId, { kind, payoutId: payout.id });

    createShopperNotification({
      io,
      shopperId,
      type: kind === 'cash_deposit' ? 'cash_deposit' : 'payout',
      title: spec.title(total),
      body: `${rows.length} ${rows.length === 1 ? 'order' : 'orders'} · reference ${reference}`,
    });

    return res.status(201).json({
      success: true,
      message: `${spec.title(total)} recorded`,
      payout: { id: payout.id, kind, amount: total, reference, orders: rows.map((row) => Number(row.order_id)) },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ RECORD PAYOUT ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to record the payout' });
  } finally {
    client.release();
  }
};

// =====================================================
// DISPUTES
// PATCH /api/admin/settlements/earnings/:orderId/dispute { note }
// PATCH /api/admin/settlements/earnings/:orderId/resolve { action: release|void, note }
// =====================================================

const disputeEarning = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const note = String(req.body?.note || '').trim().slice(0, 300);

  if (!orderId || note.length < 3) {
    return res.status(400).json({ success: false, message: 'Say what the dispute is about' });
  }

  try {
    const row = (
      await pool.query(
        `
        UPDATE shopper_earnings
        SET status = 'held', dispute_note = $2, updated_at = NOW()
        WHERE order_id = $1 AND status IN ('awaiting_bills', 'payable')
        RETURNING *
        `,
        [orderId, note]
      )
    ).rows[0];

    if (!row) {
      return res.status(409).json({ success: false, message: 'Only unpaid earnings can be put on hold' });
    }

    const io = req.app.get('io');

    announce(io, Number(row.shopper_id), { orderId, status: 'held' });

    createShopperNotification({
      io,
      shopperId: row.shopper_id,
      type: 'earnings_held',
      title: `Earnings for order #${orderId} on hold`,
      body: note,
      orderId,
    });

    return res.json({ success: true, message: 'Earnings put on hold' });
  } catch (error) {
    console.error('❌ DISPUTE EARNING ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update the earnings' });
  }
};

const resolveEarning = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const action = req.body?.action;
  const note = String(req.body?.note || '').trim().slice(0, 300) || null;

  if (!orderId || !['release', 'void'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Choose release or void' });
  }

  if (action === 'void' && !note) {
    return res.status(400).json({ success: false, message: 'Say why the earnings are cancelled' });
  }

  try {
    const row = (
      await pool.query(
        `
        UPDATE shopper_earnings
        SET status = $2::varchar, dispute_note = COALESCE($3, dispute_note), updated_at = NOW()
        WHERE order_id = $1 AND status = 'held'
        RETURNING *
        `,
        // Released earnings go back through the bill check
        [orderId, action === 'release' ? 'awaiting_bills' : 'void', note]
      )
    ).rows[0];

    if (!row) {
      return res.status(409).json({ success: false, message: 'These earnings are not on hold' });
    }

    const io = req.app.get('io');

    if (action === 'release') {
      await refreshOrderSettlement(orderId, io);
    }

    announce(io, Number(row.shopper_id), { orderId, status: row.status });

    createShopperNotification({
      io,
      shopperId: row.shopper_id,
      type: action === 'release' ? 'earnings_released' : 'earnings_void',
      title:
        action === 'release'
          ? `Earnings for order #${orderId} released`
          : `Earnings for order #${orderId} cancelled`,
      body: note,
      orderId,
    });

    return res.json({
      success: true,
      message: action === 'release' ? 'Earnings released for payout' : 'Earnings cancelled',
    });
  } catch (error) {
    console.error('❌ RESOLVE EARNING ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update the earnings' });
  }
};

// =====================================================
// ADJUSTMENT
// PATCH /api/admin/settlements/earnings/:orderId/adjust { amount, note }
// Sets the order's adjustment (replaces any earlier one; negative
// takes money off, never below zero) on unpaid earnings.
// =====================================================

const adjustEarning = async (req, res) => {
  const orderId = toId(req.params.orderId);
  const amount = round2(req.body?.amount);
  const note = String(req.body?.note || '').trim().slice(0, 300);

  if (!orderId || !Number.isFinite(amount) || Math.abs(amount) > 100000) {
    return res.status(400).json({ success: false, message: 'Enter an adjustment amount' });
  }

  if (note.length < 3) {
    return res.status(400).json({ success: false, message: 'Say what the adjustment is for' });
  }

  try {
    const row = (
      await pool.query(
        `
        UPDATE shopper_earnings
        SET net_amount = net_amount - adjustment + $2::numeric,
            adjustment = $2::numeric,
            adjustment_note = $3,
            updated_at = NOW()
        WHERE order_id = $1
          AND status IN ('awaiting_bills', 'payable', 'held')
          AND net_amount - adjustment + $2::numeric >= 0
        RETURNING *
        `,
        [orderId, amount, note]
      )
    ).rows[0];

    if (!row) {
      return res.status(409).json({
        success: false,
        message: 'Only unpaid earnings can be adjusted, and not below zero',
      });
    }

    const io = req.app.get('io');

    announce(io, Number(row.shopper_id), { orderId, status: row.status });

    createShopperNotification({
      io,
      shopperId: row.shopper_id,
      type: 'earnings_adjusted',
      title: `Earnings for order #${orderId} adjusted`,
      body: `${amount >= 0 ? '+' : '-'}Rs ${Math.abs(amount).toFixed(2)} · ${note}`,
      orderId,
    });

    return res.json({ success: true, message: 'Adjustment saved', netAmount: Number(row.net_amount) });
  } catch (error) {
    console.error('❌ ADJUST EARNING ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update the earnings' });
  }
};

// =====================================================
// LEDGER
// GET /api/admin/ledger?orderId=&shopperId=&type=&page=
// =====================================================

const LEDGER_TYPES = [
  'customer_payment',
  'customer_refund',
  'gateway_fee',
  'grocery_expense',
  'grocery_reimbursement',
  'delivery_fee',
  'priority_fee',
  'service_fee',
  'tip',
  'adjustment',
  'commission',
  'cash_collected',
  'shopper_payout',
  'reimbursement_payout',
  'cash_deposit',
  'getme_net_revenue',
];

const getLedger = async (req, res) => {
  try {
    const paging = readPage(req.query, 50);
    const where = [];
    const values = [];

    const orderId = toId(req.query.orderId);
    const shopperId = toId(req.query.shopperId);

    if (orderId) {
      values.push(orderId);
      where.push(`order_id = $${values.length}`);
    }

    if (shopperId) {
      values.push(shopperId);
      where.push(`shopper_id = $${values.length}`);
    }

    if (LEDGER_TYPES.includes(req.query.type)) {
      values.push(req.query.type);
      where.push(`entry_type = $${values.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [count, rows, totals] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM finance_ledger ${whereSql}`, values),
      pool.query(
        `
        SELECT * FROM finance_ledger ${whereSql}
        ORDER BY entry_at DESC NULLS LAST
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
        `,
        [...values, paging.pageSize, paging.offset]
      ),
      pool.query(
        `
        SELECT entry_type, flow, COALESCE(SUM(amount), 0)::float AS total
        FROM finance_ledger ${whereSql}
        GROUP BY entry_type, flow
        `,
        values
      ),
    ]);

    return res.json({
      success: true,
      types: LEDGER_TYPES,
      totals: totals.rows.map((row) => ({ type: row.entry_type, flow: row.flow, total: row.total })),
      entries: rows.rows.map((row) => ({
        at: row.entry_at,
        type: row.entry_type,
        flow: row.flow,
        orderId: row.order_id != null ? Number(row.order_id) : null,
        shopperId: row.shopper_id != null ? Number(row.shopper_id) : null,
        customerId: row.customer_id != null ? Number(row.customer_id) : null,
        amount: Number(row.amount),
        reference: row.reference,
        description: row.description,
      })),
      ...pageMeta(paging, count.rows[0].total),
    });
  } catch (error) {
    console.error('❌ LEDGER ERROR:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the ledger' });
  }
};

// Shopper's own balances (Earnings screen)
const shopperBalances = async (shopperId) => {
  const row = (
    await pool.query(`SELECT * FROM (${BALANCES_SQL}) b WHERE shopper_id = $1`, [shopperId])
  ).rows[0];

  return row ? toBalance(row) : null;
};

module.exports = {
  recordDeliveredEarnings,
  refreshOrderSettlement,
  listSettlements,
  recordPayout,
  disputeEarning,
  resolveEarning,
  adjustEarning,
  getLedger,
  shopperBalances,
};
