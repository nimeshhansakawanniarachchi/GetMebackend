const pool = require('../config/db');

const { walletFor } = require('../wallet/shopperWallet');
const { emitToAdmins } = require('../realtime');

// =====================================================
// SHOPPER CASH LIMIT (phase 45, sql/platform_phase45_dispatch_control.sql)
//
// "Cash held" = the cash from cash-on-delivery orders the shopper still
// has to hand over to GetMe: wallet.cashShortfall (shopperWallet.js,
// phase 33) - cash collected at the door less what their released
// earnings and approved grocery reimbursements already cover. It is the
// same amount a finance admin records as the cash hand-over
// (recordCashSettlement), which brings it back to 0.
//
// At or over dispatch_settings.shopper_cash_limit (held > 0 and
// held >= limit) a shopper:
//   - is left out of dispatch for cash orders (card orders unaffected)
//   - can't accept a cash order (403 CASH_LIMIT_REACHED)
// Crossing the limit is notified once per crossing (admin payments
// notification + shopper notification); shopper_cash_limit_state keeps
// the last state so repeated checks don't notify again.
// =====================================================

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;
const rs = (value) => `Rs ${Number(value || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DEFAULTS = { shopperCashLimit: 15000, exclusiveOfferMinutes: 3 };

let ioRef = null;
const useIo = (io) => {
  if (io) ioRef = io;
};

// ---------------------------------------------------
// Settings (cached briefly: dispatch reads them every second)
// ---------------------------------------------------

let cache = null;
let cacheAt = 0;
const CACHE_MS = 5000;

const toSettings = (row) => ({
  shopperCashLimit: row ? Number(row.shopper_cash_limit) : DEFAULTS.shopperCashLimit,
  exclusiveOfferMinutes: row ? Number(row.exclusive_offer_minutes) : DEFAULTS.exclusiveOfferMinutes,
  updatedAt: row?.updated_at || null,
  updatedBy: row?.updated_by != null ? Number(row.updated_by) : null,
});

const getSettings = async (client = pool, { fresh = false } = {}) => {
  if (!fresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;

  try {
    const row = (await client.query('SELECT * FROM dispatch_settings WHERE id = 1')).rows[0];
    cache = toSettings(row);
    cacheAt = Date.now();
  } catch (error) {
    // Table missing (migration not run): defaults
    console.error('❌ dispatch settings error:', error.message);
    cache = toSettings(null);
    cacheAt = Date.now();
  }

  return cache;
};

const clearSettingsCache = () => {
  cache = null;
};

// ---------------------------------------------------
// Status of one shopper
// ---------------------------------------------------

const describe = (held, limit) => {
  const reached = held > 0.009 && held >= limit - 0.009;

  return {
    held,
    limit,
    reached,
    // A hand-over settles everything owed (recordCashSettlement), so
    // the shopper hands over what they hold
    handOverAmount: reached ? held : 0,
    remaining: round2(Math.max(0, limit - held)),
    message: reached
      ? `You're holding ${rs(held)} in cash for GetMe (limit ${rs(limit)}). Hand over ${rs(held)} to GetMe to receive cash orders again.`
      : null,
    currency: 'LKR',
  };
};

const statusFor = async (shopperId, client = pool) => {
  const [wallet, settings] = await Promise.all([walletFor(shopperId, client), getSettings(client)]);
  return { ...describe(round2(wallet.cashShortfall), settings.shopperCashLimit), cashDue: wallet.cashDue };
};

// ---------------------------------------------------
// Crossings: notify once per crossing
// ---------------------------------------------------

const shortName = (fullName) => {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
};

// Records the shopper's state; on a change, notifies (admins on a
// crossing, the shopper both ways). Returns the status. Never throws.
const refreshState = async (shopperId, { io = null, status = null } = {}) => {
  const id = Number(shopperId);
  if (!Number.isInteger(id) || id <= 0) return null;

  try {
    const now = status || (await statusFor(id));

    await pool.query('INSERT INTO shopper_cash_limit_state (shopper_id) VALUES ($1) ON CONFLICT (shopper_id) DO NOTHING', [id]);

    // Only the request that flips the state gets a row back (no
    // double notification when two checks run at once)
    const changed = (
      await pool.query(
        `
        UPDATE shopper_cash_limit_state
        SET over_limit = $2,
            cash_held = $3,
            cash_limit = $4,
            crossings = crossings + CASE WHEN $2 THEN 1 ELSE 0 END,
            crossed_at = CASE WHEN $2 THEN NOW() ELSE crossed_at END,
            cleared_at = CASE WHEN $2 THEN cleared_at ELSE NOW() END,
            updated_at = NOW()
        WHERE shopper_id = $1 AND over_limit IS DISTINCT FROM $2
        RETURNING crossings
        `,
        [id, now.reached, now.held, now.limit]
      )
    ).rows[0];

    if (!changed) {
      // Same side of the limit: keep the amount current (cheap, no notification)
      await pool.query(
        'UPDATE shopper_cash_limit_state SET cash_held = $2, cash_limit = $3, updated_at = NOW() WHERE shopper_id = $1 AND (cash_held IS DISTINCT FROM $2 OR cash_limit IS DISTINCT FROM $3)',
        [id, now.held, now.limit]
      );
      return now;
    }

    const socket = io || ioRef;
    const { createShopperNotification } = require('../controllers/shopperNotificationController');

    if (socket) {
      socket.to(`shopper:${id}`).emit('shopper-earnings-updated', { shopperId: id, cashLimit: now });
      emitToAdmins(socket, 'admin:settlement-updated', { shopperId: id, cashLimit: now });
    }

    if (now.reached) {
      const shopper = (await pool.query('SELECT full_name FROM shoppers WHERE id = $1', [id])).rows[0];
      const name = shortName(shopper?.full_name) || `Shopper #${id}`;

      await require('../admin/notifications').notify({
        category: 'payments',
        event: 'shopper.cash_limit_reached',
        severity: 'warning',
        title: `${name} reached the cash limit`,
        body: `Holding ${rs(now.held)} in cash (limit ${rs(now.limit)}). No cash-on-delivery orders until the cash is handed over.`,
        entityType: 'shopper',
        entityId: id,
        permissions: ['finance.view', 'finance.settlements'],
        dedupe: `shopper.cash_limit:${id}:${changed.crossings}`,
      });

      await createShopperNotification({
        io: socket,
        shopperId: id,
        type: 'cash_limit_reached',
        title: 'Cash limit reached',
        body: `Hand over ${rs(now.held)} to GetMe to receive cash orders again. You can still take card orders.`,
      });
    } else {
      await createShopperNotification({
        io: socket,
        shopperId: id,
        type: 'cash_limit_cleared',
        title: 'You can take cash orders again',
        body: `You're holding ${rs(now.held)} in cash for GetMe (limit ${rs(now.limit)}).`,
      });
    }

    return now;
  } catch (error) {
    console.error('❌ cash limit refresh error:', shopperId, error.message);
    return null;
  }
};

const refreshInBackground = (shopperId, io = null) => {
  refreshState(shopperId, { io }).catch(() => {});
};

// After the limit changed: everyone who holds cash or was over it
const refreshAll = async (io = null) => {
  const ids = (
    await pool.query(
      `
      SELECT shopper_id FROM shopper_earnings WHERE cash_status = 'due' AND cash_collected > 0
      UNION
      SELECT shopper_id FROM shopper_cash_limit_state WHERE over_limit
      `
    )
  ).rows.map((row) => Number(row.shopper_id));

  for (const id of ids) {
    await refreshState(id, { io });
  }

  return ids.length;
};

// ---------------------------------------------------
// Dispatch: leave over-limit shoppers out of cash orders
// shoppers = getEligibleShoppers() rows ({ id, ... })
// ---------------------------------------------------

const isCashOrder = async (orderId, client = pool) =>
  (await client.query('SELECT payment_method FROM orders WHERE id = $1', [orderId])).rows[0]?.payment_method === 'cash';

const dropOverLimit = async (orderId, shoppers, client = pool) => {
  if (!shoppers.length || !(await isCashOrder(orderId, client))) return shoppers;

  const kept = [];

  for (const shopper of shoppers) {
    const status = await statusFor(shopper.id, client);

    if (!status.reached) {
      kept.push(shopper);
    } else {
      // Notify a crossing found here too (outside this transaction;
      // once per crossing). Going back under is noticed by the
      // settlement change that caused it (settlementController.announce)
      refreshState(shopper.id, { status }).catch(() => {});
    }
  }

  return kept;
};

// Many shoppers at once (admin candidate list): Map id -> status
const statusesFor = async (shopperIds, client = pool) => {
  const map = new Map();
  for (const id of shopperIds) map.set(Number(id), await statusFor(id, client));
  return map;
};

// ---------------------------------------------------
// GET /api/shopper/cash-limit (the signed-in shopper only)
// ---------------------------------------------------

const getMyCashLimit = async (req, res) => {
  try {
    const shopperId = Number(req.shopper?.shopperId);
    const status = await statusFor(shopperId);

    // Keeps the crossing state in step (notifies once)
    refreshState(shopperId, { io: req.app.get('io'), status }).catch(() => {});

    return res.json({ success: true, cashLimit: status });
  } catch (error) {
    console.error('❌ my cash limit error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load your cash limit' });
  }
};

module.exports = {
  getMyCashLimit,
  DEFAULTS,
  useIo,
  getSettings,
  clearSettingsCache,
  describe,
  statusFor,
  statusesFor,
  refreshState,
  refreshInBackground,
  refreshAll,
  isCashOrder,
  dropOverLimit,
};
