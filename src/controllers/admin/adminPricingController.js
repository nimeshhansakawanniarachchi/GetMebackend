const pool = require('../../config/db');

const { readPage, pageMeta } = require('../../utils/pagination');
const { offerStatus, offerLabel } = require('../../pricing/offers');
const { SUSPICIOUS_CHANGE_PERCENT, changePercent } = require('../../pricing/history');
const { toPublicReport, ABSORB_LKR, ABSORB_PERCENT } = require('../orderPriceReportsController');
const { toPriceChange } = require('../shop/shopProductController');

// =====================================================
// PRICING (admin panel "Pricing" page)
// Read-only views across shops + review of shopper price reports.
// Admins never change a shop's prices here: each supermarket
// controls its own (GetMe-Shop); admins can pause offers
// (adminOfferController) and resolve reports.
// =====================================================

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const shopFilter = (req, params, column) => {
  const shopId = toId(req.query.shopId);
  if (!shopId) return '';
  params.push(shopId);
  return ` AND ${column} = $${params.length}`;
};

// A suspicious change: dropped to Rs 0, or moved more than N% either way
const SUSPICIOUS_SQL = `(
  (h.old_price > 0 AND h.new_price = 0)
  OR (h.old_price > 0 AND ABS(h.new_price - h.old_price) / h.old_price * 100 > ${SUSPICIOUS_CHANGE_PERCENT})
)`;

// GET /api/admin/pricing/overview
const getOverview = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM order_item_price_reports WHERE admin_status = 'open') AS open_reports,
        (SELECT COUNT(*)::int FROM order_item_price_reports WHERE status = 'pending') AS waiting_customer,
        (SELECT COALESCE(SUM(getme_absorbed), 0)::float FROM order_item_price_reports
           WHERE status = 'absorbed' AND created_at > NOW() - INTERVAL '30 days') AS absorbed_30d,
        (SELECT COUNT(*)::int FROM product_price_history h
           WHERE h.created_at > NOW() - INTERVAL '30 days' AND ${SUSPICIOUS_SQL}) AS suspicious_30d,
        (SELECT COUNT(*)::int FROM product_price_history WHERE created_at > NOW() - INTERVAL '7 days') AS changes_7d,
        (SELECT COUNT(*)::int FROM products WHERE price <= 0) AS missing_prices,
        (SELECT COUNT(*)::int FROM products WHERE price <= 0 AND is_available AND stock_quantity > 0) AS missing_prices_visible,
        (SELECT COUNT(*)::int FROM product_offers
           WHERE is_active AND NOT paused_by_admin AND starts_at <= NOW() AND (ends_at IS NULL OR ends_at > NOW())) AS live_offers,
        (SELECT COUNT(*)::int FROM product_offers
           WHERE ends_at IS NOT NULL AND ends_at <= NOW() AND ends_at > NOW() - INTERVAL '30 days') AS expired_offers_30d
      `
    );

    const row = result.rows[0];

    return res.json({
      success: true,
      suspiciousPercent: SUSPICIOUS_CHANGE_PERCENT,
      // GetMe absorbs a higher shelf price up to the larger of these per unit
      shelfRule: { absorbLkr: ABSORB_LKR(), absorbPercent: ABSORB_PERCENT() },
      overview: {
        openReports: row.open_reports,
        waitingCustomer: row.waiting_customer,
        absorbed30d: Math.round(row.absorbed_30d * 100) / 100,
        suspicious30d: row.suspicious_30d,
        changes7d: row.changes_7d,
        missingPrices: row.missing_prices,
        missingPricesVisible: row.missing_prices_visible,
        liveOffers: row.live_offers,
        expiredOffers30d: row.expired_offers_30d,
      },
    });
  } catch (error) {
    console.error('❌ admin pricing overview error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load pricing' });
  }
};

// GET /api/admin/pricing/reports?status=open|resolved|all&shopId=&page=
const listReports = async (req, res) => {
  try {
    const paging = readPage(req.query, 25);
    const params = [];
    let where = 'WHERE TRUE';

    if (req.query.status === 'open' || req.query.status === 'resolved') {
      params.push(req.query.status);
      where += ` AND r.admin_status = $${params.length}`;
    }

    where += shopFilter(req, params, 'r.shop_id');

    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM order_item_price_reports r ${where}`, params),
      pool.query(
        `
        SELECT r.*, s.shop_name, sh.full_name AS shopper_name, o.status AS order_status, o.payment_method
        FROM order_item_price_reports r
        LEFT JOIN shops s ON s.id = r.shop_id
        LEFT JOIN shoppers sh ON sh.id = r.shopper_id
        LEFT JOIN orders o ON o.id = r.order_id
        ${where}
        ORDER BY (r.admin_status = 'open') DESC, r.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, paging.pageSize, paging.offset]
      ),
    ]);

    return res.json({
      success: true,
      ...pageMeta(paging, count.rows[0].total),
      reports: rows.rows.map((row) => ({
        ...toPublicReport(row),
        shopName: row.shop_name,
        shopperName: row.shopper_name,
        orderStatus: row.order_status,
        paymentMethod: row.payment_method,
        reviewedAt: row.reviewed_at,
      })),
    });
  } catch (error) {
    console.error('❌ admin price reports error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load price reports' });
  }
};

// PATCH /api/admin/pricing/reports/:id { adminStatus: 'resolved' | 'open', note? }
// Only the review fields change: the order and the shop's prices don't.
const reviewReport = async (req, res) => {
  const id = toId(req.params.id);
  const adminStatus = req.body?.adminStatus;
  const note = req.body?.note ? String(req.body.note).trim().slice(0, 300) : null;

  if (!id || !['resolved', 'open'].includes(adminStatus)) {
    return res.status(400).json({ success: false, message: 'Choose resolved or open' });
  }

  try {
    const result = await pool.query(
      `
      UPDATE order_item_price_reports
      SET admin_status = $2, admin_note = COALESCE($3, admin_note),
        reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id, adminStatus, note, req.admin?.adminId ?? null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    return res.json({
      success: true,
      message: adminStatus === 'resolved' ? 'Marked resolved' : 'Reopened',
      report: toPublicReport(result.rows[0]),
    });
  } catch (error) {
    console.error('❌ admin review price report error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to update the report' });
  }
};

// GET /api/admin/pricing/changes?suspicious=1&shopId=&days=30&page=
const listPriceChanges = async (req, res) => {
  try {
    const paging = readPage(req.query, 25);
    const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
    const params = [days];
    let where = "WHERE h.created_at > NOW() - ($1::int * INTERVAL '1 day')";

    if (req.query.suspicious === '1' || req.query.suspicious === 'true') where += ` AND ${SUSPICIOUS_SQL}`;
    where += shopFilter(req, params, 'h.shop_id');

    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM product_price_history h ${where}`, params),
      pool.query(
        `
        SELECT h.*, p.product_name, p.price AS current_price, s.shop_name
        FROM product_price_history h
        LEFT JOIN products p ON p.id = h.product_id
        LEFT JOIN shops s ON s.id = h.shop_id
        ${where}
        ORDER BY h.created_at DESC, h.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, paging.pageSize, paging.offset]
      ),
    ]);

    return res.json({
      success: true,
      ...pageMeta(paging, count.rows[0].total),
      suspiciousPercent: SUSPICIOUS_CHANGE_PERCENT,
      changes: rows.rows.map((row) => {
        const percent = changePercent(row.old_price, row.new_price);

        return {
          ...toPriceChange(row),
          productId: Number(row.product_id),
          productName: row.product_name,
          shopId: Number(row.shop_id),
          shopName: row.shop_name,
          currentPrice: row.current_price != null ? Number(row.current_price) : null,
          suspicious:
            row.old_price != null &&
            ((Number(row.old_price) > 0 && Number(row.new_price) === 0) || (percent != null && Math.abs(percent) > SUSPICIOUS_CHANGE_PERCENT)),
        };
      }),
    });
  } catch (error) {
    console.error('❌ admin price changes error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load price changes' });
  }
};

// GET /api/admin/pricing/expired-offers?shopId=&days=30&page=
// Offers that ended in the last N days (newest first)
const listExpiredOffers = async (req, res) => {
  try {
    const paging = readPage(req.query, 25);
    const days = Math.min(365, Math.max(1, Number.parseInt(req.query.days, 10) || 30));
    const params = [days];
    let where = "WHERE o.ends_at IS NOT NULL AND o.ends_at <= NOW() AND o.ends_at > NOW() - ($1::int * INTERVAL '1 day')";

    where += shopFilter(req, params, 'o.shop_id');

    const [count, rows] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM product_offers o ${where}`, params),
      pool.query(
        `
        SELECT o.*, s.shop_name, p.product_name, p.price AS product_price
        FROM product_offers o
        LEFT JOIN shops s ON s.id = o.shop_id
        LEFT JOIN products p ON p.id = o.product_id
        ${where}
        ORDER BY o.ends_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, paging.pageSize, paging.offset]
      ),
    ]);

    return res.json({
      success: true,
      ...pageMeta(paging, count.rows[0].total),
      offers: rows.rows.map((row) => ({
        id: Number(row.id),
        shopId: Number(row.shop_id),
        shopName: row.shop_name,
        scope: row.scope,
        productName: row.product_name,
        category: row.category,
        label: offerLabel(row),
        discountType: row.discount_type,
        discountValue: Number(row.discount_value),
        productPrice: row.product_price != null ? Number(row.product_price) : null,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        status: offerStatus(row),
        source: row.source,
      })),
    });
  } catch (error) {
    console.error('❌ admin expired offers error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load expired offers' });
  }
};

// GET /api/admin/products/:id/price-history
const getProductPriceHistory = async (req, res) => {
  const productId = toId(req.params.id);

  if (!productId) {
    return res.status(400).json({ success: false, message: 'Invalid product ID' });
  }

  try {
    const product = (
      await pool.query('SELECT p.*, s.shop_name FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = $1', [productId])
    ).rows[0];

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const [prices, offers, reports] = await Promise.all([
      pool.query('SELECT * FROM product_price_history WHERE product_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100', [productId]),
      pool.query(
        `
        SELECT h.*, o.scope, o.category
        FROM product_offer_history h
        LEFT JOIN product_offers o ON o.id = h.offer_id
        WHERE h.shop_id = $1
          AND (
            (h.after->>'productId')::int = $2 OR (h.before->>'productId')::int = $2
            OR COALESCE(h.after->>'scope', h.before->>'scope') = 'shop'
            OR (COALESCE(h.after->>'scope', h.before->>'scope') = 'category'
                AND LOWER(TRIM(COALESCE(h.after->>'category', h.before->>'category'))) = LOWER(TRIM($3)))
          )
        ORDER BY h.created_at DESC
        LIMIT 100
        `,
        [product.shop_id, productId, product.category || '']
      ),
      pool.query('SELECT * FROM order_item_price_reports WHERE product_id = $1 ORDER BY created_at DESC LIMIT 50', [productId]),
    ]);

    return res.json({
      success: true,
      product: {
        id: Number(product.id),
        shopId: Number(product.shop_id),
        shopName: product.shop_name,
        productName: product.product_name,
        category: product.category,
        price: Number(product.price),
        priceUpdatedAt: product.price_updated_at,
      },
      prices: prices.rows.map(toPriceChange),
      offerChanges: offers.rows.map((row) => ({
        id: Number(row.id),
        offerId: Number(row.offer_id),
        action: row.action,
        before: row.before,
        after: row.after,
        actorType: row.actor_type,
        actorName: row.actor_name,
        at: row.created_at,
      })),
      shelfReports: reports.rows.map(toPublicReport),
    });
  } catch (error) {
    console.error('❌ admin product price history error:', error.message);
    return res.status(500).json({ success: false, message: 'Unable to load the price history' });
  }
};

module.exports = {
  getOverview,
  listReports,
  reviewReport,
  listPriceChanges,
  listExpiredOffers,
  getProductPriceHistory,
};
