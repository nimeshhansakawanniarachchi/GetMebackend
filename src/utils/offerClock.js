const pool = require('../config/db');

const { broadcastCatalogChange } = require('../realtime');

// =====================================================
// OFFER CLOCK
// Offers start and end on their own (product_offers.starts_at /
// ends_at) without anyone saving anything, so no request fires a
// catalog update. Every TICK_MS, shops with an offer that started
// or ended since the last tick get one, and customer apps refetch.
// =====================================================

const TICK_MS = 30000;

const startOfferClock = (io) => {
  let since = new Date();

  const tick = async () => {
    const now = new Date();

    try {
      const result = await pool.query(
        `
        SELECT DISTINCT shop_id
        FROM product_offers
        WHERE is_active = TRUE
          AND paused_by_admin = FALSE
          AND (
            (starts_at > $1 AND starts_at <= $2)
            OR (ends_at > $1 AND ends_at <= $2)
          )
        `,
        [since, now]
      );

      result.rows.forEach((row) => broadcastCatalogChange(io, row.shop_id, 'offers'));

      since = now;
    } catch (error) {
      // Keep `since`: the next tick covers this window again
      console.error('❌ offer clock error:', error.message);
    }
  };

  const timer = setInterval(tick, TICK_MS);

  // Don't keep the process alive just for this
  timer.unref?.();

  return timer;
};

module.exports = {
  startOfferClock,
};
