const pool = require('../config/db');
const grocery = require('./groceryPayments');

// =====================================================
// ADMIN: supermarket payments (phase 38)
//   GET   /api/admin/grocery-payments                  list + summary (filters)
//   GET   /api/admin/grocery-payments/orders/:orderId  reservations, attempts, store payments, ledger
//   PATCH /api/admin/grocery-payments/:id              { action: reconcile|dispute|resolve_dispute|reverse, ... }
//   PATCH /api/admin/grocery-reservations/:id/limit     { limit | null, note }
//   GET   /api/admin/grocery-payment-methods            methods, per-shop exceptions, settings
//   PATCH /api/admin/grocery-payment-methods/:key       { enabled, instructions }
//   PUT   /api/admin/grocery-payment-methods/:key/shops/:shopId { enabled | null, note }
//   PATCH /api/admin/grocery-payment-settings           { limitBufferPercent, limitBufferMin }
//   GET   /api/admin/getme-cards                        cards + balances
//   POST  /api/admin/getme-cards                        { label, issuer, last4, shopperId?, note }
//   PATCH /api/admin/getme-cards/:id                    { shopperId?, status?, label?, note? }
//   POST  /api/admin/getme-cards/:id/funds              { kind: load|unload, amount, reference, note }
// Nothing here moves money: every action records what was done at the
// bank / till, with a reference, and is audited (adminAccess).
// =====================================================

const { round2, error, clean, addEntry } = grocery;
const store = () => require('../controllers/storePaymentController');
const settlement = () => require('../controllers/settlementController');

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const ATTEMPT_SELECT = `
  SELECT a.*, m.label AS method_label, c.last4 AS card_last4,
         s.shop_name, sh.full_name AS shopper_name, sh.shopper_code, o.status AS order_status,
         (sp.locked_at IS NOT NULL) AS bill_locked, sp.review_status, sp.reimbursement_status,
         COALESCE(jsonb_array_length(sp.duplicate_flags), 0) AS duplicate_count
  FROM grocery_payment_attempts a
  JOIN grocery_payment_methods m ON m.key = a.method
  LEFT JOIN getme_cards c ON c.id = a.card_id
  LEFT JOIN shops s ON s.id = a.shop_id
  LEFT JOIN shoppers sh ON sh.id = a.shopper_id
  LEFT JOIN orders o ON o.id = a.order_id
  LEFT JOIN store_payments sp ON sp.id = a.store_payment_id
`;

// Needs an admin: unverified (no bill / GetMe card not matched to the
// statement), mismatch, disputed, over the limit
// Same receipt photo / till reference as another order (store_payments.duplicate_flags)
const DUPLICATE = "EXISTS (SELECT 1 FROM store_payments d WHERE d.id = a.store_payment_id AND jsonb_array_length(d.duplicate_flags) > 0)";

const FILTERS = {
  attention:
    `(a.status = 'disputed' OR (a.status = 'succeeded' AND (a.reconciliation_status = 'mismatch' OR (a.funding = 'getme' AND a.reconciliation_status = 'unreconciled') OR (a.over_limit AND a.reconciliation_status <> 'resolved') OR (${DUPLICATE} AND a.reconciliation_status <> 'resolved'))))`,
  duplicates: DUPLICATE,
  unverified: "(a.status = 'succeeded' AND a.reconciliation_status IN ('unreconciled', 'mismatch'))",
  pending: "a.status = 'pending'",
  failed: "a.status IN ('failed', 'cancelled')",
  reversed: "a.status = 'reversed'",
  disputed: "a.status = 'disputed'",
  matched: "a.reconciliation_status IN ('matched', 'resolved')",
};

const listPayments = async (query = {}) => {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(5, Number.parseInt(query.pageSize, 10) || 25));
  const where = [FILTERS[query.status] || 'TRUE'];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (toId(query.orderId)) add('a.order_id = ?::int', toId(query.orderId));
  if (toId(query.shopId)) add('a.shop_id = ?::int', toId(query.shopId));
  if (toId(query.shopperId)) add('a.shopper_id = ?::int', toId(query.shopperId));
  if (['shopper', 'getme'].includes(query.funding)) add('a.funding = ?::varchar', query.funding);
  if (query.method) add('a.method = ?::varchar', String(query.method).slice(0, 30));

  const sql = where.join(' AND ');
  const [count, rows, summary] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM grocery_payment_attempts a WHERE ${sql}`, params),
    pool.query(`${ATTEMPT_SELECT} WHERE ${sql} ORDER BY a.updated_at DESC, a.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      pageSize,
      (page - 1) * pageSize,
    ]),
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM grocery_reservations WHERE status IN ('active', 'captured'))::int AS open_reservations,
        (SELECT COALESCE(SUM(limit_amount - captured_amount), 0) FROM grocery_reservations WHERE status = 'active')::float AS reserved_unspent,
        (SELECT COUNT(*) FROM grocery_payment_attempts a WHERE ${FILTERS.attention})::int AS attention,
        (SELECT COUNT(*) FROM grocery_payment_attempts WHERE status = 'pending')::int AS pending,
        (SELECT COUNT(*) FROM grocery_payment_attempts WHERE status = 'failed' AND created_at > NOW() - INTERVAL '7 days')::int AS failed_7d,
        (SELECT COUNT(*) FROM grocery_payment_attempts WHERE status = 'disputed')::int AS disputed,
        (SELECT COUNT(*) FROM grocery_payment_attempts a WHERE ${DUPLICATE})::int AS duplicates,
        (SELECT COALESCE(SUM(amount), 0) FROM grocery_payment_attempts WHERE status = 'succeeded' AND funding = 'shopper' AND paid_at >= date_trunc('month', NOW()))::float AS shopper_funded_month,
        (SELECT COALESCE(SUM(amount), 0) FROM grocery_payment_attempts WHERE status = 'succeeded' AND funding = 'getme' AND paid_at >= date_trunc('month', NOW()))::float AS getme_funded_month,
        (SELECT COALESCE(SUM(amount - expected_amount), 0) FROM grocery_payment_attempts WHERE status = 'succeeded' AND paid_at >= date_trunc('month', NOW()))::float AS variance_month
    `),
  ]);

  return {
    summary: summary.rows[0],
    payments: rows.rows.map(grocery.publicAttempt),
    page,
    pageSize,
    total: count.rows[0].total,
  };
};

const orderDetail = async (orderId) => {
  const id = toId(orderId);
  if (!id) throw error(400, 'Invalid order');
  await grocery.syncOrder(id);

  const order = (await pool.query('SELECT id, status, payment_method, shopper_id, items_total FROM orders WHERE id = $1', [id])).rows[0];
  if (!order) throw error(404, 'Order not found');

  const [reservations, attempts, payments, ledger] = await Promise.all([
    pool.query('SELECT r.*, s.shop_name FROM grocery_reservations r LEFT JOIN shops s ON s.id = r.shop_id WHERE r.order_id = $1 ORDER BY r.shop_id', [id]),
    pool.query(`${ATTEMPT_SELECT} WHERE a.order_id = $1 ORDER BY a.id`, [id]),
    pool.query('SELECT sp.*, s.shop_name FROM store_payments sp LEFT JOIN shops s ON s.id = sp.shop_id WHERE sp.order_id = $1 ORDER BY sp.shop_id', [id]),
    pool.query(
      `SELECT e.*, ad.full_name AS admin_name FROM grocery_ledger_entries e
       LEFT JOIN admins ad ON e.actor_type = 'admin' AND ad.id = e.actor_id
       WHERE e.order_id = $1 ORDER BY e.created_at, e.id`,
      [id]
    ),
  ]);

  return {
    order: { id: Number(order.id), status: order.status, paymentMethod: order.payment_method, shopperId: order.shopper_id != null ? Number(order.shopper_id) : null },
    reservations: reservations.rows.map((row) => ({ ...grocery.publicReservation(row), shopName: row.shop_name })),
    attempts: attempts.rows.map(grocery.publicAttempt),
    storePayments: payments.rows.map((row) => ({ ...store().toPublic(row), fundedBy: row.funded_by, shopName: row.shop_name })),
    ledger: ledger.rows.map((row) => ({
      id: Number(row.id),
      type: row.entry_type,
      shopId: row.shop_id != null ? Number(row.shop_id) : null,
      attemptId: row.attempt_id != null ? Number(row.attempt_id) : null,
      cardId: row.card_id != null ? Number(row.card_id) : null,
      amount: round2(row.amount),
      actorType: row.actor_type,
      actorName: row.actor_type === 'admin' ? row.admin_name || `Admin ${row.actor_id}` : row.actor_type === 'shopper' ? 'Shopper' : 'System',
      note: row.note,
      at: row.created_at,
    })),
  };
};

// PATCH /api/admin/grocery-payments/:id
//   reconcile        { result: matched|mismatch|resolved, note, statementReference }
//                    (GetMe card 'matched' needs the bank statement reference)
//   dispute          { note }            succeeded -> disputed
//   resolve_dispute  { outcome: succeeded|reversed, note }
//   reverse          { note }            before the bill photo only
const adminAction = async (attemptId, input = {}, adminId) => {
  const id = toId(attemptId);
  if (!id) throw error(400, 'Invalid payment');
  const action = String(input.action || '');
  const note = clean(input.note, 300);
  const peek = (await pool.query('SELECT order_id FROM grocery_payment_attempts WHERE id = $1', [id])).rows[0];
  if (!peek) throw error(404, 'Payment not found');

  const client = await pool.connect();
  let message;

  try {
    await client.query('BEGIN');
    const order = (await client.query('SELECT id, status FROM orders WHERE id = $1 FOR UPDATE', [peek.order_id])).rows[0];
    const attempt = (await client.query('SELECT * FROM grocery_payment_attempts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    const entry = { orderId: attempt.order_id, shopId: attempt.shop_id, shopperId: attempt.shopper_id, reservationId: attempt.reservation_id, attemptId: attempt.id, cardId: attempt.card_id, actorType: 'admin', actorId: adminId };

    if (action === 'reconcile') {
      const result = String(input.result || '');
      const statementReference = clean(input.statementReference, 60) || null;
      if (!['matched', 'mismatch', 'resolved'].includes(result)) throw error(400, 'Choose matched, mismatch or resolved');
      if (!['succeeded', 'disputed'].includes(attempt.status)) throw error(409, 'Only a completed payment can be reconciled', 'WRONG_STATUS');
      if (result !== 'matched' && note.length < 3) throw error(400, 'Say what you found', 'NOTE_REQUIRED');
      if (result === 'matched') {
        const bill = attempt.store_payment_id
          ? (await client.query('SELECT locked_at FROM store_payments WHERE id = $1', [attempt.store_payment_id])).rows[0]
          : null;
        if (!bill?.locked_at) throw error(409, "The bill photo isn't uploaded yet, so the payment can't be matched", 'NO_RECEIPT');
        if (attempt.funding === 'getme' && (!statementReference || statementReference.length < 3)) {
          throw error(400, 'Enter the bank statement reference of this card transaction', 'STATEMENT_REQUIRED', { field: 'statementReference' });
        }
      }

      await client.query(
        `UPDATE grocery_payment_attempts
         SET reconciliation_status = $2, reconciliation_note = $3, statement_reference = COALESCE($4, statement_reference),
             verification = CASE WHEN $4::varchar IS NOT NULL THEN 'statement' ELSE verification END,
             reconciled_by = $5, reconciled_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [id, result, note || null, statementReference, adminId]
      );
      await addEntry(client, { ...entry, type: 'reconcile', amount: attempt.amount, note: `${result}${statementReference ? ` (statement ${statementReference})` : ''}${note ? `: ${note}` : ''}` });
      message = result === 'matched' ? 'Marked as matched' : result === 'resolved' ? 'Marked as resolved' : 'Marked as a mismatch';
    } else if (action === 'dispute') {
      if (attempt.status !== 'succeeded') throw error(409, 'Only a completed payment can be disputed', 'WRONG_STATUS');
      if (note.length < 3) throw error(400, 'Say what is disputed', 'NOTE_REQUIRED');
      await client.query("UPDATE grocery_payment_attempts SET status = 'disputed', reconciliation_status = 'mismatch', reconciliation_note = $2, reconciled_by = $3, reconciled_at = NOW(), updated_at = NOW() WHERE id = $1", [id, note, adminId]);
      await addEntry(client, { ...entry, type: 'dispute', amount: attempt.amount, note });
      message = 'Marked as disputed';
    } else if (action === 'resolve_dispute') {
      const outcome = String(input.outcome || '');
      if (attempt.status !== 'disputed') throw error(409, 'This payment is not disputed', 'WRONG_STATUS');
      if (note.length < 3) throw error(400, 'Say how it was resolved', 'NOTE_REQUIRED');
      if (outcome === 'succeeded') {
        await client.query("UPDATE grocery_payment_attempts SET status = 'succeeded', reconciliation_status = 'resolved', reconciliation_note = $2, reconciled_by = $3, reconciled_at = NOW(), updated_at = NOW() WHERE id = $1", [id, note, adminId]);
        await addEntry(client, { ...entry, type: 'reconcile', amount: attempt.amount, note: `Dispute resolved, payment stands: ${note}` });
        message = 'Dispute resolved: the payment stands';
      } else if (outcome === 'reversed') {
        message = (await grocery.reverseAttempt(client, { order, attempt, why: `Dispute: ${note}`, actorType: 'admin', actorId: adminId })).message;
      } else {
        throw error(400, 'Choose succeeded or reversed');
      }
    } else if (action === 'reverse') {
      if (note.length < 3) throw error(400, 'Say why the payment is reversed', 'NOTE_REQUIRED');
      message = (await grocery.reverseAttempt(client, { order, attempt, why: note, actorType: 'admin', actorId: adminId })).message;
    } else {
      throw error(400, 'Unknown action');
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  await settlement().refreshOrderSettlement(peek.order_id, null);
  return { message, payment: await grocery.attemptView(pool, id) };
};

// PATCH /api/admin/grocery-reservations/:id/limit { limit (null = back to computed), note }
const changeLimit = async (reservationId, input = {}, adminId) => {
  const id = toId(reservationId);
  const note = clean(input.note, 300);
  const clear = input.limit === null;
  const limit = round2(input.limit);

  if (!id) throw error(400, 'Invalid reservation');
  if (!clear && !(limit > 0)) throw error(400, 'Enter the new limit', 'INVALID_LIMIT', { field: 'limit' });
  if (note.length < 3) throw error(400, 'Say why the limit changes', 'NOTE_REQUIRED', { field: 'note' });

  const peek = (await pool.query('SELECT order_id FROM grocery_reservations WHERE id = $1', [id])).rows[0];
  if (!peek) throw error(404, 'Reservation not found');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [peek.order_id]);
    const reservation = (await client.query('SELECT * FROM grocery_reservations WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!['active', 'captured'].includes(reservation.status)) throw error(409, 'This order + shop is finished; its limit is closed', 'CLOSED');

    const settings = await grocery.loadSettings(client);
    const next = clear ? grocery.limitFor(round2(reservation.estimate_amount), settings) : limit;
    const pending = (await client.query("SELECT * FROM grocery_payment_attempts WHERE reservation_id = $1 AND status = 'pending' FOR UPDATE", [id])).rows[0];

    // A pending GetMe card payment holds the limit on the card
    if (pending?.card_id && next > round2(pending.limit_amount)) {
      await client.query('SELECT id FROM getme_cards WHERE id = $1 FOR UPDATE', [pending.card_id]);
      const balance = await grocery.cardBalance(client, pending.card_id);
      if (balance.available + 0.005 < next - round2(pending.limit_amount)) {
        throw error(409, `The GetMe card has only Rs ${balance.available.toFixed(2)} free. Add funds first.`, 'CARD_FUNDS_LOW');
      }
    }

    await client.query(
      'UPDATE grocery_reservations SET limit_amount = $2, limit_override = $3, limit_note = $4, limit_set_by = $5, updated_at = NOW() WHERE id = $1',
      [id, next, clear ? null : next, note, adminId]
    );
    if (pending) await client.query('UPDATE grocery_payment_attempts SET limit_amount = $2, updated_at = NOW() WHERE id = $1', [pending.id, next]);
    await addEntry(client, {
      type: 'limit_change',
      orderId: reservation.order_id,
      shopId: reservation.shop_id,
      shopperId: reservation.shopper_id,
      reservationId: id,
      amount: next,
      actorType: 'admin',
      actorId: adminId,
      note: `Limit Rs ${round2(reservation.limit_amount).toFixed(2)} -> Rs ${next.toFixed(2)}${clear ? ' (back to the computed limit)' : ''}: ${note}`,
    });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  return grocery.publicReservation((await pool.query('SELECT * FROM grocery_reservations WHERE id = $1', [id])).rows[0]);
};

// ---------------------------------------------------
// Methods + settings
// ---------------------------------------------------

const methodsConfig = async () => {
  const [methods, overrides, settings, cards, shops] = await Promise.all([
    pool.query('SELECT * FROM grocery_payment_methods ORDER BY sort_order, key'),
    pool.query('SELECT o.*, s.shop_name FROM grocery_shop_payment_methods o LEFT JOIN shops s ON s.id = o.shop_id ORDER BY s.shop_name'),
    grocery.loadSettings(),
    pool.query("SELECT COUNT(*) FILTER (WHERE status = 'active' AND shopper_id IS NOT NULL)::int AS assigned, COUNT(*) FILTER (WHERE status <> 'retired')::int AS total FROM getme_cards"),
    pool.query('SELECT id, shop_name FROM shops ORDER BY shop_name'),
  ]);

  return {
    methods: methods.rows.map((row) => ({
      key: row.key,
      label: row.label,
      funding: row.funding,
      integration: row.integration,
      enabled: row.enabled,
      operational: row.integration === 'manual' ? row.enabled : row.integration === 'card_program' ? row.enabled && cards.rows[0].assigned > 0 : false,
      icon: row.icon,
      instructions: row.instructions,
      requirement: row.requirement,
      updatedAt: row.updated_at,
      shopExceptions: overrides.rows
        .filter((o) => o.method_key === row.key)
        .map((o) => ({ shopId: Number(o.shop_id), shopName: o.shop_name, enabled: o.enabled, note: o.note })),
    })),
    settings,
    cards: cards.rows[0],
    shops: shops.rows.map((s) => ({ id: Number(s.id), name: s.shop_name })),
  };
};

const updateMethod = async (key, input = {}, adminId) => {
  const method = (await pool.query('SELECT * FROM grocery_payment_methods WHERE key = $1', [String(key)])).rows[0];
  if (!method) throw error(404, 'Payment method not found');

  if (input.enabled === true && method.integration === 'not_available') {
    throw error(409, `${method.label} can't be switched on: ${method.requirement}`, 'NOT_AVAILABLE');
  }

  const enabled = typeof input.enabled === 'boolean' ? input.enabled : method.enabled;
  const instructions = input.instructions !== undefined ? clean(input.instructions, 600) || null : method.instructions;

  await pool.query('UPDATE grocery_payment_methods SET enabled = $2, instructions = $3, updated_by = $4, updated_at = NOW() WHERE key = $1', [
    method.key,
    enabled,
    instructions,
    adminId,
  ]);

  return methodsConfig();
};

const setShopException = async (key, shopId, input = {}, adminId) => {
  const method = (await pool.query('SELECT * FROM grocery_payment_methods WHERE key = $1', [String(key)])).rows[0];
  const shop = toId(shopId);
  if (!method) throw error(404, 'Payment method not found');
  if (!shop || !(await pool.query('SELECT 1 FROM shops WHERE id = $1', [shop])).rows.length) throw error(404, 'Shop not found');

  if (input.enabled === null) {
    await pool.query('DELETE FROM grocery_shop_payment_methods WHERE shop_id = $1 AND method_key = $2', [shop, method.key]);
  } else {
    if (typeof input.enabled !== 'boolean') throw error(400, 'Choose on, off or default');
    if (input.enabled && method.integration === 'not_available') throw error(409, `${method.label} can't be switched on`, 'NOT_AVAILABLE');
    await pool.query(
      `INSERT INTO grocery_shop_payment_methods (shop_id, method_key, enabled, note, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (shop_id, method_key) DO UPDATE SET enabled = EXCLUDED.enabled, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [shop, method.key, input.enabled, clean(input.note, 200) || null, adminId]
    );
  }

  return methodsConfig();
};

const updateSettings = async (input = {}, adminId) => {
  const percent = Number(input.limitBufferPercent);
  const min = Number(input.limitBufferMin);
  if (!(percent >= 0 && percent <= 100)) throw error(400, 'The buffer must be 0 to 100 %', 'INVALID', { field: 'limitBufferPercent' });
  if (!(min >= 0 && min <= 100000)) throw error(400, 'Enter a minimum buffer from Rs 0 to Rs 100,000', 'INVALID', { field: 'limitBufferMin' });

  await pool.query('UPDATE grocery_payment_settings SET limit_buffer_percent = $1, limit_buffer_min = $2, updated_by = $3, updated_at = NOW() WHERE id = 1', [
    round2(percent),
    round2(min),
    adminId,
  ]);

  return methodsConfig();
};

// ---------------------------------------------------
// GetMe company cards (bank name + last 4 only)
// ---------------------------------------------------

const publicCard = async (row) => {
  const balance = await grocery.cardBalance(pool, row.id);
  const loads = (await pool.query('SELECT l.*, ad.full_name AS admin_name FROM getme_card_loads l LEFT JOIN admins ad ON ad.id = l.created_by WHERE card_id = $1 ORDER BY l.created_at DESC LIMIT 10', [row.id])).rows;
  return {
    id: Number(row.id),
    label: row.label,
    issuer: row.issuer,
    last4: row.last4,
    status: row.status,
    note: row.note,
    shopperId: row.shopper_id != null ? Number(row.shopper_id) : null,
    shopperName: row.shopper_name || null,
    shopperCode: row.shopper_code || null,
    balance,
    recentFunds: loads.map((l) => ({ id: Number(l.id), kind: l.kind, amount: round2(l.amount), reference: l.reference, note: l.note, by: l.admin_name, at: l.created_at })),
    createdAt: row.created_at,
  };
};

const cardRow = async (id) =>
  (
    await pool.query(
      'SELECT c.*, sh.full_name AS shopper_name, sh.shopper_code FROM getme_cards c LEFT JOIN shoppers sh ON sh.id = c.shopper_id WHERE c.id = $1',
      [id]
    )
  ).rows[0];

const listCards = async () => {
  const rows = (
    await pool.query("SELECT c.*, sh.full_name AS shopper_name, sh.shopper_code FROM getme_cards c LEFT JOIN shoppers sh ON sh.id = c.shopper_id ORDER BY (c.status = 'retired'), c.created_at DESC")
  ).rows;
  return Promise.all(rows.map(publicCard));
};

const checkShopper = async (client, shopperId) => {
  if (shopperId == null) return null;
  const id = toId(shopperId);
  const shopper = id && (await client.query('SELECT id, approval_status FROM shoppers WHERE id = $1', [id])).rows[0];
  if (!shopper) throw error(404, 'Shopper not found', 'SHOPPER_NOT_FOUND', { field: 'shopperId' });
  if (shopper.approval_status !== 'approved') throw error(409, 'Only approved shoppers can hold a GetMe card', 'NOT_APPROVED', { field: 'shopperId' });
  return id;
};

const createCard = async (input = {}, adminId) => {
  const label = clean(input.label, 60);
  const issuer = clean(input.issuer, 80);
  const last4 = String(input.last4 ?? '').trim();

  // Never a card number, expiry or CVV: last 4 digits only
  if (/\d{5,}/.test(String(input.last4 ?? '').replace(/[\s-]/g, ''))) {
    throw error(400, 'Enter only the last 4 digits of the card, never the full number', 'FULL_CARD_NUMBER', { field: 'last4' });
  }
  if (label.length < 2) throw error(400, 'Name the card (e.g. Grocery card 1)', 'INVALID', { field: 'label' });
  if (issuer.length < 2) throw error(400, 'Enter the issuing bank', 'INVALID', { field: 'issuer' });
  if (!/^\d{4}$/.test(last4)) throw error(400, 'Enter the last 4 digits of the card', 'INVALID', { field: 'last4' });

  const shopperId = await checkShopper(pool, input.shopperId);

  try {
    const row = (
      await pool.query('INSERT INTO getme_cards (label, issuer, last4, shopper_id, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
        label,
        issuer,
        last4,
        shopperId,
        clean(input.note, 300) || null,
        adminId,
      ])
    ).rows[0];
    return publicCard(await cardRow(row.id));
  } catch (caught) {
    if (caught.code === '23505') {
      throw error(409, caught.constraint === 'getme_cards_shopper_active_idx' ? 'This shopper already has an active GetMe card' : 'This card is already registered', 'DUPLICATE');
    }
    throw caught;
  }
};

const updateCard = async (cardId, input = {}) => {
  const id = toId(cardId);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const card = id && (await client.query('SELECT * FROM getme_cards WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!card) throw error(404, 'Card not found');
    if (card.status === 'retired') throw error(409, 'A retired card can no longer change', 'RETIRED');

    const pending = (await client.query("SELECT 1 FROM grocery_payment_attempts WHERE card_id = $1 AND status = 'pending'", [id])).rows.length > 0;
    const shopperChange = input.shopperId !== undefined && (input.shopperId == null ? null : toId(input.shopperId)) !== (card.shopper_id != null ? Number(card.shopper_id) : null);
    const status = input.status !== undefined ? String(input.status) : card.status;

    if (!['active', 'frozen', 'retired'].includes(status)) throw error(400, 'Choose active, frozen or retired');
    if (pending && (shopperChange || status !== 'active')) {
      throw error(409, 'A payment with this card is in progress. Wait until the shopper reports it.', 'PAYMENT_IN_PROGRESS');
    }

    const shopperId = shopperChange ? await checkShopper(client, input.shopperId) : card.shopper_id;

    if (status === 'retired') {
      const balance = await grocery.cardBalance(client, id);
      if (balance.available > 0.005) throw error(409, `Take the Rs ${balance.available.toFixed(2)} still on the card back first (record an unload)`, 'FUNDS_LEFT');
    }

    await client.query(
      'UPDATE getme_cards SET shopper_id = $2, status = $3, label = $4, note = $5, updated_at = NOW() WHERE id = $1',
      [id, status === 'retired' ? null : shopperId, status, clean(input.label ?? card.label, 60) || card.label, input.note !== undefined ? clean(input.note, 300) || null : card.note]
    );
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') throw error(409, 'This shopper already has an active GetMe card', 'DUPLICATE');
    throw caught;
  } finally {
    client.release();
  }

  return publicCard(await cardRow(id));
};

// POST /api/admin/getme-cards/:id/funds { kind: load|unload, amount, reference, note }
// Records money GetMe put on / took off the card AT THE BANK. It does
// not move money itself.
const recordFunds = async (cardId, input = {}, adminId) => {
  const id = toId(cardId);
  const kind = String(input.kind || '');
  const amount = round2(input.amount);
  const reference = clean(input.reference, 60);

  if (!['load', 'unload'].includes(kind)) throw error(400, 'Choose add or remove funds');
  if (!(amount > 0) || amount > 5000000) throw error(400, 'Enter an amount from Rs 1 to Rs 5,000,000', 'INVALID', { field: 'amount' });
  if (reference.length < 3) throw error(400, 'Enter the bank reference of this load', 'INVALID', { field: 'reference' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const card = id && (await client.query('SELECT * FROM getme_cards WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!card) throw error(404, 'Card not found');
    if (card.status === 'retired') throw error(409, 'This card is retired', 'RETIRED');

    if (kind === 'unload') {
      const balance = await grocery.cardBalance(client, id);
      if (amount > balance.available + 0.005) throw error(409, `Only Rs ${balance.available.toFixed(2)} is free on the card`, 'INSUFFICIENT');
    }

    await client.query('INSERT INTO getme_card_loads (card_id, kind, amount, reference, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [
      id,
      kind,
      amount,
      reference,
      clean(input.note, 300) || null,
      adminId,
    ]);
    await addEntry(client, { type: kind === 'load' ? 'card_load' : 'card_unload', cardId: id, amount, actorType: 'admin', actorId: adminId, note: `Bank reference ${reference}` });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') throw error(409, 'This bank reference is already recorded for the card', 'DUPLICATE_REFERENCE', { field: 'reference' });
    throw caught;
  } finally {
    client.release();
  }

  return publicCard(await cardRow(id));
};

module.exports = {
  listPayments,
  orderDetail,
  adminAction,
  changeLimit,
  methodsConfig,
  updateMethod,
  setShopException,
  updateSettings,
  listCards,
  createCard,
  updateCard,
  recordFunds,
};
