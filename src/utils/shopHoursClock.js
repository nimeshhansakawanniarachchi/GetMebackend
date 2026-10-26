const pool = require('../config/db');
const { broadcastCatalogChange, emitToAdmins } = require('../realtime');
const { recordShopActivity } = require('../middleware/shopAccess');
const { isOpenAt } = require('./shopHours');

// =====================================================
// AUTO OPEN / CLOSE (shops.auto_open + opening_hours)
// Every minute: approved shops with auto open/close follow their
// hours through the existing shops.is_open, which the Customer App
// already respects. A manual open / close (open_override_until)
// holds until the next scheduled change.
// =====================================================

const TICK_MS = 60 * 1000;

const tick = async (io) => {
  const shops = (
    await pool.query(
      `
      SELECT id, is_open, opening_hours, open_override_until
      FROM shops
      WHERE auto_open AND status = 'approved' AND opening_hours IS NOT NULL
      `
    )
  ).rows;

  const now = new Date();

  for (const shop of shops) {
    if (shop.open_override_until && new Date(shop.open_override_until) > now) continue;

    const shouldOpen = isOpenAt(shop.opening_hours, now);
    if (shouldOpen === null) continue;

    if (shouldOpen === shop.is_open && !shop.open_override_until) continue;

    const updated = (
      await pool.query(
        `
        UPDATE shops
        SET is_open = $2, open_override_until = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND auto_open
        RETURNING id, is_open
        `,
        [shop.id, shouldOpen]
      )
    ).rows[0];

    if (!updated || shouldOpen === shop.is_open) continue;

    recordShopActivity({
      shopId: shop.id,
      actor: { type: 'system', name: 'GetMe (opening hours)', role: null },
      action: shouldOpen ? 'shop.auto_open' : 'shop.auto_close',
      entityType: 'shop',
      entityId: shop.id,
      summary: shouldOpen ? 'Opened automatically (opening hours)' : 'Closed automatically (opening hours)',
    });

    broadcastCatalogChange(io, shop.id, 'shop');
    emitToAdmins(io, 'admin:shops-updated', { shopId: shop.id, reason: 'open-changed' });
    io?.to(`shop:${shop.id}`).emit('shop:open-changed', { isOpen: shouldOpen, automatic: true });
  }
};

const startShopHoursClock = (io) => {
  const run = () => tick(io).catch((error) => console.error('❌ SHOP HOURS CLOCK:', error.message));
  run();
  return setInterval(run, TICK_MS);
};

module.exports = { startShopHoursClock, tick };
