// =====================================================
// PHASE 61: MERCHANT TOOLS (shop portal, clothing / restaurant / liquor)
//   GET  /api/shop/shop-categories                 menu sections / collections
//   PUT  /api/shop/shop-categories                 order, description, rename (restaurants)
//   POST /api/shop/shop-categories/availability    a whole section on / off
//   POST /api/shop/merchant-products/discounts     bulk % discount / clear
//   GET  /api/shop/merchant-reports?from&to        sales report
// Every query is scoped to the signed-in shop (req.shop.shopId).
// =====================================================

const { pool, round2, fail, text, toId, colomboDate } = require('./common');
const { recordShopActivity } = require('../middleware/shopAccess');
const { broadcastCatalogChange } = require('../realtime');

const MAX_SECTIONS = 100;

const actorOf = (req) => ({
  type: req.shop.staffId ? 'staff' : 'owner',
  id: req.shop.staffId || req.shop.shopId,
  name: req.shop.actorName || null,
  role: req.shop.role,
});

const log = (req, action, entityType, entityId, summary) =>
  recordShopActivity({ shopId: req.shop.shopId, actor: actorOf(req), action, entityType, entityId, summary });

const changed = (req) => broadcastCatalogChange(req.app.get('io'), req.shop.shopId, 'products');

// -----------------------------------------------------
// Sections (restaurant menu categories / shop collections)
// -----------------------------------------------------

const loadSections = async (shopId, client = pool) => {
  const [saved, used] = await Promise.all([
    client.query('SELECT * FROM shop_categories WHERE shop_id = $1', [shopId]),
    client.query(
      `SELECT category AS name, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_available)::int AS available
       FROM products WHERE shop_id = $1 AND category IS NOT NULL GROUP BY category`,
      [shopId]
    ),
  ]);
  const byKey = new Map();
  for (const row of used.rows) {
    byKey.set(row.name.toLowerCase(), {
      name: row.name, productCount: row.total, availableCount: row.available, sortOrder: null, description: null, saved: false,
    });
  }
  for (const row of saved.rows) {
    const key = row.name.toLowerCase();
    const entry = byKey.get(key) || { name: row.name, productCount: 0, availableCount: 0 };
    byKey.set(key, { ...entry, sortOrder: Number(row.sort_order), description: row.description || null, saved: true });
  }
  return [...byKey.values()].sort(
    (a, b) => (a.sortOrder ?? 100000) - (b.sortOrder ?? 100000) || a.name.localeCompare(b.name)
  );
};

// Section order for a storefront: Map(lowercase name -> { sort, description })
const sectionOrder = async (shopId, client = pool) =>
  new Map(
    (await client.query('SELECT name, sort_order, description FROM shop_categories WHERE shop_id = $1', [shopId])).rows.map((r) => [
      r.name.toLowerCase(),
      { sort: Number(r.sort_order), description: r.description || null },
    ])
  );

const getSections = async (req, res) => {
  try {
    const shop = req.merchantShop;
    return res.json({
      success: true,
      businessType: shop.business_type,
      // Restaurants name their own menu sections; shops use GetMe's
      // category list (renaming would break search filters)
      canRename: shop.business_type === 'restaurant',
      sections: await loadSections(shop.id),
    });
  } catch (error) {
    console.error('❌ SHOP SECTIONS ERROR:', error.message);
    return fail(res, 500, "Couldn't load your sections.");
  }
};

const putSections = async (req, res) => {
  const shop = req.merchantShop;
  const list = Array.isArray(req.body?.sections) ? req.body.sections : null;
  if (!list) return fail(res, 400, 'Send the list of sections', 'VALIDATION');
  if (list.length > MAX_SECTIONS) return fail(res, 400, `At most ${MAX_SECTIONS} sections`, 'VALIDATION');

  const clean = [];
  const seen = new Set();
  for (const [i, raw] of list.entries()) {
    const name = text(raw?.name, 60);
    if (!name || name.length < 2) return fail(res, 400, 'Each section needs a name (at least 2 characters)', 'VALIDATION');
    const key = name.toLowerCase();
    if (seen.has(key)) return fail(res, 400, `"${name}" is listed twice`, 'VALIDATION');
    seen.add(key);
    const renameFrom = text(raw?.renameFrom, 60);
    if (renameFrom && renameFrom.toLowerCase() !== key && shop.business_type !== 'restaurant') {
      return fail(res, 400, 'Only restaurants can rename sections. Shops use GetMe categories.', 'RENAME_NOT_ALLOWED');
    }
    clean.push({ name, sortOrder: i, description: text(raw?.description, 200), renameFrom: renameFrom && renameFrom.toLowerCase() !== key ? renameFrom : null });
  }

  const client = await pool.connect();
  let renamed = 0;
  try {
    await client.query('BEGIN');
    for (const row of clean.filter((r) => r.renameFrom)) {
      const result = await client.query(
        'UPDATE products SET category = $3, updated_at = NOW() WHERE shop_id = $1 AND lower(category) = lower($2)',
        [shop.id, row.renameFrom, row.name]
      );
      renamed += result.rowCount;
    }
    await client.query('DELETE FROM shop_categories WHERE shop_id = $1', [shop.id]);
    for (const row of clean) {
      await client.query(
        'INSERT INTO shop_categories (shop_id, name, sort_order, description) VALUES ($1, $2, $3, $4)',
        [shop.id, row.name, row.sortOrder, row.description]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ SAVE SECTIONS ERROR:', error.message);
    return fail(res, 500, "Couldn't save your sections. Please try again.");
  } finally {
    client.release();
  }

  log(req, 'sections.update', 'shop', shop.id, `Updated ${shop.business_type === 'restaurant' ? 'menu sections' : 'collections'} (${clean.length})${renamed ? `, renamed on ${renamed} items` : ''}`);
  changed(req);
  return res.json({ success: true, renamedProducts: renamed, sections: await loadSections(shop.id) });
};

// A whole section on / off (e.g. "Breakfast" after 11:00)
const setSectionAvailability = async (req, res) => {
  const shop = req.merchantShop;
  const name = text(req.body?.name, 60);
  if (!name) return fail(res, 400, 'Choose a section', 'VALIDATION');
  if (typeof req.body?.isAvailable !== 'boolean') return fail(res, 400, 'Choose on or off', 'VALIDATION');
  try {
    const result = await pool.query(
      'UPDATE products SET is_available = $3, updated_at = NOW() WHERE shop_id = $1 AND lower(category) = lower($2) AND is_available <> $3',
      [shop.id, name, req.body.isAvailable]
    );
    log(req, 'sections.availability', 'shop', shop.id, `${req.body.isAvailable ? 'Turned on' : 'Turned off'} "${name}" (${result.rowCount} items)`);
    if (result.rowCount) changed(req);
    return res.json({ success: true, changed: result.rowCount, sections: await loadSections(shop.id) });
  } catch (error) {
    console.error('❌ SECTION AVAILABILITY ERROR:', error.message);
    return fail(res, 500, "Couldn't update the section.");
  }
};

// -----------------------------------------------------
// Bulk discounts
// -----------------------------------------------------

const bulkDiscount = async (req, res) => {
  const shop = req.merchantShop;
  const ids = Array.isArray(req.body?.productIds) ? [...new Set(req.body.productIds.map(toId).filter(Boolean))] : [];
  if (!ids.length) return fail(res, 400, 'Choose at least one product', 'VALIDATION');
  if (ids.length > 500) return fail(res, 400, 'Choose at most 500 products at a time', 'VALIDATION');
  const clear = req.body?.clear === true;
  const percent = Number(req.body?.percent);
  if (!clear && (!Number.isFinite(percent) || percent < 1 || percent > 90)) {
    return fail(res, 400, 'Enter a discount between 1% and 90%', 'VALIDATION');
  }

  const client = await pool.connect();
  let products = 0;
  let variants = 0;
  try {
    await client.query('BEGIN');
    const own = (await client.query('SELECT id FROM products WHERE shop_id = $1 AND id = ANY($2) FOR UPDATE', [shop.id, ids])).rows.map((r) => Number(r.id));
    if (own.length !== ids.length) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Some products are not in your catalogue', 'NOT_FOUND');
    }
    if (clear) {
      products = (await client.query('UPDATE products SET discount_price = NULL, updated_at = NOW() WHERE id = ANY($1) AND discount_price IS NOT NULL', [own])).rowCount;
      variants = (await client.query('UPDATE product_variants SET discount_price = NULL, updated_at = NOW() WHERE product_id = ANY($1) AND discount_price IS NOT NULL', [own])).rowCount;
    } else {
      const factor = (100 - percent) / 100;
      // Rounded to the rupee; always below the price (CHECK constraints)
      products = (
        await client.query(
          `UPDATE products SET discount_price = LEAST(price - 1, GREATEST(0, ROUND(price * $2))), updated_at = NOW()
           WHERE id = ANY($1) AND price >= 2`,
          [own, factor]
        )
      ).rowCount;
      // Variants with their own price get their own discount; the rest
      // inherit the product's discount
      variants = (
        await client.query(
          `UPDATE product_variants SET
             discount_price = CASE WHEN price IS NOT NULL AND price >= 2 THEN LEAST(price - 1, GREATEST(0, ROUND(price * $2))) ELSE NULL END,
             updated_at = NOW()
           WHERE product_id = ANY($1)`,
          [own, factor]
        )
      ).rowCount;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ BULK DISCOUNT ERROR:', error.message);
    return fail(res, 500, "Couldn't update the discounts. Please try again.");
  } finally {
    client.release();
  }
  log(req, clear ? 'product.discount_clear' : 'product.discount_bulk', 'product', null,
    clear ? `Removed discounts from ${ids.length} products` : `${percent}% off on ${ids.length} products`);
  changed(req);
  return res.json({ success: true, updatedProducts: products, updatedVariants: variants });
};

// -----------------------------------------------------
// Sales report
// -----------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const readRange = (query) => {
  const today = colomboDate();
  const to = DATE.test(String(query.to || '')) ? String(query.to) : today;
  const defaultFrom = colomboDate(new Date(Date.now() - 29 * 86400000));
  const from = DATE.test(String(query.from || '')) ? String(query.from) : defaultFrom;
  if (from > to) return { error: 'The start date is after the end date' };
  const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > 366) return { error: 'Choose at most one year' };
  return { from, to, days };
};

const getReport = async (req, res) => {
  const shop = req.merchantShop;
  const range = readRange(req.query);
  if (range.error) return fail(res, 400, range.error, 'VALIDATION');
  // Orders the customer confirmed (sent to the store) in the range, by
  // Colombo date of confirmation
  const base = `FROM orders o
    WHERE o.shop_id = $1 AND o.business_type <> 'grocery'
      AND o.shopper_search_started_at IS NOT NULL
      AND (o.shopper_search_started_at AT TIME ZONE 'Asia/Colombo')::date BETWEEN $2::date AND $3::date`;
  const params = [shop.id, range.from, range.to];
  try {
    const [totals, daily, top, fulfilment, hours, settle] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS placed,
           COUNT(*) FILTER (WHERE o.status = 'delivered')::int AS completed,
           COUNT(*) FILTER (WHERE o.merchant_status = 'rejected')::int AS rejected,
           COUNT(*) FILTER (WHERE o.status = 'cancelled' AND o.merchant_status <> 'rejected')::int AS cancelled,
           COUNT(*) FILTER (WHERE o.merchant_accepted_at IS NOT NULL)::int AS accepted,
           COALESCE(SUM(o.items_total) FILTER (WHERE o.status = 'delivered'), 0) AS gross_sales,
           COALESCE(SUM(o.commission_amount) FILTER (WHERE o.status = 'delivered'), 0) AS commission,
           COALESCE(SUM(o.delivery_fee) FILTER (WHERE o.status = 'delivered' AND o.fulfilment_method = 'shop_delivery'), 0) AS store_delivery_fees,
           AVG(EXTRACT(EPOCH FROM (o.merchant_accepted_at - o.shopper_search_started_at)) / 60)
             FILTER (WHERE o.merchant_accepted_at IS NOT NULL) AS avg_accept_minutes,
           AVG(EXTRACT(EPOCH FROM (o.merchant_ready_at - o.merchant_accepted_at)) / 60)
             FILTER (WHERE o.merchant_ready_at IS NOT NULL AND o.merchant_accepted_at IS NOT NULL) AS avg_prep_minutes
         ${base}`,
        params
      ),
      pool.query(
        `SELECT (o.shopper_search_started_at AT TIME ZONE 'Asia/Colombo')::date::text AS day,
                COUNT(*)::int AS orders,
                COUNT(*) FILTER (WHERE o.status = 'delivered')::int AS completed,
                COALESCE(SUM(o.items_total) FILTER (WHERE o.status = 'delivered'), 0) AS sales
         ${base} GROUP BY 1 ORDER BY 1`,
        params
      ),
      pool.query(
        `SELECT oi.item_name, oi.product_id,
                SUM(oi.quantity - COALESCE(oi.returned_quantity, 0))::numeric AS quantity,
                SUM(COALESCE(oi.line_total, oi.price * oi.quantity)) AS sales
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.id IN (SELECT o.id ${base}) AND o.status = 'delivered'
         GROUP BY oi.item_name, oi.product_id ORDER BY quantity DESC, sales DESC LIMIT 10`,
        params
      ),
      pool.query(
        `SELECT o.fulfilment_method AS method, COUNT(*)::int AS orders,
                COALESCE(SUM(o.items_total) FILTER (WHERE o.status = 'delivered'), 0) AS sales
         ${base} GROUP BY 1 ORDER BY 2 DESC`,
        params
      ),
      pool.query(
        `SELECT EXTRACT(HOUR FROM o.shopper_search_started_at AT TIME ZONE 'Asia/Colombo')::int AS hour, COUNT(*)::int AS orders
         ${base} GROUP BY 1 ORDER BY 1`,
        params
      ),
      pool.query(
        `SELECT COALESCE(SUM(ms.net_amount), 0) AS net, COALESCE(SUM(ms.refunds_amount), 0) AS refunds,
                COALESCE(SUM(ms.net_amount) FILTER (WHERE ms.status = 'paid'), 0) AS paid
         FROM merchant_settlements ms WHERE ms.order_id IN (SELECT o.id ${base})`,
        params
      ),
    ]);

    const t = totals.rows[0];
    const decided = Number(t.accepted) + Number(t.rejected);
    // Every day in the range, zeros included (charts)
    const byDay = new Map(daily.rows.map((r) => [r.day, r]));
    const series = [];
    for (let i = 0; i < range.days; i += 1) {
      const day = new Date(new Date(`${range.from}T00:00:00Z`).getTime() + i * 86400000).toISOString().slice(0, 10);
      const row = byDay.get(day);
      series.push({ date: day, orders: row ? row.orders : 0, completed: row ? row.completed : 0, sales: row ? round2(row.sales) : 0 });
    }
    const s = settle.rows[0];
    return res.json({
      success: true,
      businessType: shop.business_type,
      range,
      totals: {
        ordersPlaced: Number(t.placed),
        completed: Number(t.completed),
        rejected: Number(t.rejected),
        cancelled: Number(t.cancelled),
        grossSales: round2(t.gross_sales),
        averageOrderValue: Number(t.completed) ? round2(Number(t.gross_sales) / Number(t.completed)) : 0,
        commission: round2(t.commission),
        storeDeliveryFees: round2(t.store_delivery_fees),
        refunds: round2(s.refunds),
        netPayout: round2(s.net),
        paidOut: round2(s.paid),
        acceptanceRate: decided ? Math.round((Number(t.accepted) / decided) * 1000) / 10 : null,
        avgAcceptMinutes: t.avg_accept_minutes != null ? Math.round(Number(t.avg_accept_minutes) * 10) / 10 : null,
        avgPrepMinutes: t.avg_prep_minutes != null ? Math.round(Number(t.avg_prep_minutes) * 10) / 10 : null,
      },
      daily: series,
      topItems: top.rows.map((r) => ({ productId: r.product_id ? Number(r.product_id) : null, name: r.item_name, quantity: Number(r.quantity), sales: round2(r.sales) })),
      byFulfilment: fulfilment.rows.map((r) => ({ method: r.method, orders: r.orders, sales: round2(r.sales) })),
      byHour: hours.rows.map((r) => ({ hour: r.hour, orders: r.orders })),
    });
  } catch (error) {
    console.error('❌ MERCHANT REPORT ERROR:', error.message);
    return fail(res, 500, "Couldn't build the report. Please try again.");
  }
};

module.exports = { getSections, putSections, setSectionAvailability, bulkDiscount, getReport, sectionOrder, loadSections };
