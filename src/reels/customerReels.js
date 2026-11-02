// =====================================================
// PHASE 62: FASHION REELS - CUSTOMER (/api/customer/reels..., auth)
// Feed tabs: for_you (engagement / age ranking), following (shops the
// customer follows, newest first), new_arrivals (new arrival /
// collection videos, newest first). Optional ?shopId= (a shop's videos)
// and ?audience=. Paged (pageSize <= 10): the app loads the next page
// as the viewer nears the end, never every video at once.
// Only status 'published', not hidden by reports, not deleted, from an
// approved clothing shop. Linked products are listed only while they
// can actually be bought (available + in stock).
// =====================================================

const {
  pool,
  REPORT_REASONS,
  REPORTS_TO_HIDE,
  PROMO_LABELS,
  AUDIENCES,
  REEL_TYPES,
  NEW_PROMOS,
  linkedProducts,
  productCard,
  reelBase,
  colomboDay,
  toId,
  fail,
  text,
  customerVisible,
} = require('./common');
const { customerTypeBlock } = require('../marketplace/common');
const adminNotifications = require('../admin/notifications');

const PAGE_MAX = 10;
const VISIBLE = `r.status = 'published' AND r.deleted_at IS NULL AND NOT r.hidden_by_reports
  AND s.status = 'approved' AND s.business_type IN ('clothing', 'restaurant') AND r.business_type = s.business_type
  AND r.video_file IS NOT NULL`;

// Restaurants deliver locally: with an address, only kitchens within this
// straight-line distance are shown (same radius as restaurant discovery)
const RESTAURANT_RADIUS_KM = 10;

const customerIdOf = (req) => Number(req.customer.customerId);

const feedCards = async (rows, customerId) => {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const shopIds = [...new Set(rows.map((r) => Number(r.shop_id)))];
  const [products, liked, followed, followers] = await Promise.all([
    linkedProducts(ids),
    pool.query('SELECT reel_id FROM reel_likes WHERE customer_id = $1 AND reel_id = ANY($2)', [customerId, ids]),
    pool.query('SELECT shop_id FROM shop_follows WHERE customer_id = $1 AND shop_id = ANY($2)', [customerId, shopIds]),
    pool.query('SELECT shop_id, COUNT(*)::int AS n FROM shop_follows WHERE shop_id = ANY($1) GROUP BY shop_id', [shopIds]),
  ]);
  const likedSet = new Set(liked.rows.map((r) => Number(r.reel_id)));
  const followedSet = new Set(followed.rows.map((r) => Number(r.shop_id)));
  const followerCount = new Map(followers.rows.map((r) => [Number(r.shop_id), r.n]));
  return rows.map((r) => {
    const all = products.get(Number(r.id)) || [];
    const sellable = all.filter(({ view }) => customerVisible(view));
    return {
      ...reelBase(r),
      likedByMe: likedSet.has(Number(r.id)),
      shop: {
        id: Number(r.shop_id),
        name: r.shop_name,
        logoUrl: r.shop_logo || null,
        city: r.shop_city || r.shop_area || null,
        district: r.shop_district || null,
        // Phase 63: order-readiness hints (checkout still re-checks everything)
        isOpen: !!r.shop_is_open,
        ordersPaused: !!(r.shop_paused_until && new Date(r.shop_paused_until) > new Date()),
        offersDelivery: r.shop_offers_delivery !== false,
        offersPickup: !!r.shop_offers_pickup,
        prepMinutes: r.shop_prep_minutes != null ? Number(r.shop_prep_minutes) : null,
        businessType: r.business_type || 'clothing',
        distanceKm: r.distance_km != null ? Number(Number(r.distance_km).toFixed(1)) : null,
        followedByMe: followedSet.has(Number(r.shop_id)),
        followers: followerCount.get(Number(r.shop_id)) || 0,
      },
      products: sellable.map(({ view }) => productCard(view)),
      // linked items that can't be bought right now (sold out / removed)
      unavailableProducts: all.length - sellable.length,
    };
  });
};

// -----------------------------------------------------
// GET /reels/feed
// -----------------------------------------------------

const getFeed = async (req, res) => {
  try {
    // Phase 63: ?type=clothing (default) | restaurant
    const type = REEL_TYPES.includes(req.query.type) ? req.query.type : 'clothing';
    const block = await customerTypeBlock(type);
    if (block) return fail(res, block.status, block.message, block.code);
    const customerId = customerIdOf(req);
    // 'new' = new arrivals (clothing) / new food (restaurants); 'popular' = most engaged
    const rawTab = req.query.tab === 'new_arrivals' || req.query.tab === 'new_food' ? 'new' : req.query.tab;
    const tab = ['for_you', 'following', 'new', 'popular'].includes(rawTab) ? rawTab : 'for_you';
    const latitude = req.query.latitude == null || req.query.latitude === '' ? NaN : Number(req.query.latitude);
    const longitude = req.query.longitude == null || req.query.longitude === '' ? NaN : Number(req.query.longitude);
    const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
    const page = Math.max(1, Math.min(500, Number(req.query.page) || 1));
    const pageSize = Math.max(1, Math.min(PAGE_MAX, Number(req.query.pageSize) || 5));
    const shopId = toId(req.query.shopId);
    const audience = AUDIENCES.includes(req.query.audience) ? req.query.audience : null;

    const params = [customerId];
    // ($1 is always referenced, so every tab binds the same first parameter)
    const where = [VISIBLE, '$1::int > 0'];
    params.push(type);
    where.push(`r.business_type = $${params.length}`);
    let distanceSql = 'NULL::float';
    if (hasLocation) {
      params.push(latitude, longitude);
      const la = `$${params.length - 1}`;
      const lo = `$${params.length}`;
      distanceSql = `(6371 * acos(LEAST(1, GREATEST(-1, cos(radians(${la})) * cos(radians(s.latitude)) * cos(radians(s.longitude) - radians(${lo})) + sin(radians(${la})) * sin(radians(s.latitude))))))`;
      if (type === 'restaurant') where.push(`${distanceSql} <= ${RESTAURANT_RADIUS_KM}`);
    }
    if (shopId) {
      params.push(shopId);
      where.push(`r.shop_id = $${params.length}`);
    }
    if (audience) {
      params.push(audience);
      where.push(`(r.audience = $${params.length} OR r.audience = 'unisex' OR r.audience IS NULL)`);
    }
    if (tab === 'following') where.push('EXISTS (SELECT 1 FROM shop_follows f WHERE f.shop_id = r.shop_id AND f.customer_id = $1)');
    if (tab === 'new') {
      params.push(NEW_PROMOS[type]);
      where.push(`r.promo_type = ANY($${params.length}::text[])`);
    }

    // For you: engagement per hour of age (decays), small boost for shops
    // the customer follows, watched-today reels sink
    const ranked = tab === 'for_you' && !shopId;
    if (ranked) params.push(`c:${customerId}`);
    const viewerP = `$${params.length}`;
    const orderBy = ranked
      ? `((r.like_count * 3 + r.share_count * 5 + r.product_click_count * 2 + r.view_count * 0.2 + 1)
           / POWER(EXTRACT(EPOCH FROM (NOW() - r.published_at)) / 3600 + 2, 1.3))
         * (CASE WHEN EXISTS (SELECT 1 FROM shop_follows f WHERE f.shop_id = r.shop_id AND f.customer_id = $1) THEN 1.5 ELSE 1 END)
         * (CASE WHEN EXISTS (SELECT 1 FROM reel_views v WHERE v.reel_id = r.id AND v.viewer_key = ${viewerP}) THEN 0.3 ELSE 1 END) DESC,
         r.id DESC`
      : tab === 'popular'
        ? '(r.like_count * 3 + r.share_count * 5 + r.product_click_count * 2 + r.profile_visit_count + r.view_count * 0.2) DESC, r.published_at DESC, r.id DESC'
        : 'r.published_at DESC, r.id DESC';

    const rows = (
      await pool.query(
        `SELECT r.*, s.shop_name, s.image_url AS shop_logo, s.city AS shop_city, s.area AS shop_area, s.district AS shop_district,
                s.is_open AS shop_is_open, s.orders_paused_until AS shop_paused_until, s.offers_pickup AS shop_offers_pickup,
                s.offers_delivery AS shop_offers_delivery, s.default_prep_minutes AS shop_prep_minutes,
                ${distanceSql} AS distance_km, COUNT(*) OVER () AS total
         FROM fashion_reels r JOIN shops s ON s.id = r.shop_id
         WHERE ${where.join(' AND ')}
         ORDER BY ${orderBy}
         LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params
      )
    ).rows;
    const total = rows.length ? Number(rows[0].total) : 0;
    return res.json({
      success: true,
      type,
      tab,
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
      reels: await feedCards(rows, customerId),
    });
  } catch (error) {
    console.error('❌ REEL FEED ERROR:', error.message);
    return fail(res, 500, "Couldn't load videos. Please try again.");
  }
};

const visibleReel = async (id) =>
  (
    await pool.query(
      `SELECT r.*, s.shop_name, s.image_url AS shop_logo, s.city AS shop_city, s.area AS shop_area, s.district AS shop_district,
                s.is_open AS shop_is_open, s.orders_paused_until AS shop_paused_until, s.offers_pickup AS shop_offers_pickup,
                s.offers_delivery AS shop_offers_delivery, s.default_prep_minutes AS shop_prep_minutes
       FROM fashion_reels r JOIN shops s ON s.id = r.shop_id WHERE r.id = $1 AND ${VISIBLE}`,
      [id]
    )
  ).rows[0] || null;

const getReel = async (req, res) => {
  try {
    const row = await visibleReel(toId(req.params.id));
    if (!row) return fail(res, 404, 'This video is not available', 'NOT_FOUND');
    return res.json({ success: true, reel: (await feedCards([row], customerIdOf(req)))[0] });
  } catch (error) {
    console.error('❌ REEL ERROR:', error.message);
    return fail(res, 500, "Couldn't load this video.");
  }
};

// -----------------------------------------------------
// Views: watched >= 2 s (or half of a shorter video), once per viewer
// per reel per Colombo day
// -----------------------------------------------------

const recordView = async (req, res) => {
  try {
    const row = await visibleReel(toId(req.params.id));
    if (!row) return fail(res, 404, 'This video is not available', 'NOT_FOUND');
    const watchedMs = Math.max(0, Math.min(10 * 60 * 1000, Math.round(Number(req.body?.watchedMs) || 0)));
    const needed = Math.min(2000, Math.round(Number(row.duration_seconds || 0) * 500));
    if (watchedMs < needed) return res.json({ success: true, counted: false, reason: 'too_short', neededMs: needed, views: row.view_count });
    const inserted = await pool.query(
      `INSERT INTO reel_views (reel_id, viewer_key, view_day, watched_ms) VALUES ($1, $2, $3, $4)
       ON CONFLICT (reel_id, viewer_key, view_day) DO UPDATE SET watched_ms = GREATEST(reel_views.watched_ms, EXCLUDED.watched_ms)
       RETURNING (xmax = 0) AS fresh`,
      [row.id, `c:${customerIdOf(req)}`, colomboDay(), watchedMs]
    );
    let views = Number(row.view_count);
    if (inserted.rows[0]?.fresh) {
      views = (await pool.query('UPDATE fashion_reels SET view_count = view_count + 1 WHERE id = $1 RETURNING view_count', [row.id])).rows[0].view_count;
    }
    return res.json({ success: true, counted: !!inserted.rows[0]?.fresh, views });
  } catch (error) {
    console.error('❌ REEL VIEW ERROR:', error.message);
    return fail(res, 500, "Couldn't record the view.");
  }
};

// -----------------------------------------------------
// Likes
// -----------------------------------------------------

const setLike = (like) => async (req, res) => {
  const client = await pool.connect();
  try {
    const row = await visibleReel(toId(req.params.id));
    if (!row) return fail(res, 404, 'This video is not available', 'NOT_FOUND');
    await client.query('BEGIN');
    const changed = like
      ? (await client.query('INSERT INTO reel_likes (reel_id, customer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.id, customerIdOf(req)])).rowCount
      : (await client.query('DELETE FROM reel_likes WHERE reel_id = $1 AND customer_id = $2', [row.id, customerIdOf(req)])).rowCount;
    const likes = changed
      ? (await client.query(`UPDATE fashion_reels SET like_count = GREATEST(0, like_count ${like ? '+' : '-'} 1) WHERE id = $1 RETURNING like_count`, [row.id])).rows[0].like_count
      : Number(row.like_count);
    await client.query('COMMIT');
    return res.json({ success: true, liked: like, likes });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ REEL LIKE ERROR:', error.message);
    return fail(res, 500, "Couldn't save that.");
  } finally {
    client.release();
  }
};

// -----------------------------------------------------
// Share / product click / add to cart events
// Every event is stored; the counter shown to shops counts one per
// customer per video (per product for clicks / adds) per 10 minutes, so
// tapping again and again doesn't inflate it.
// -----------------------------------------------------

const COUNTER = { share: 'share_count', product_click: 'product_click_count', add_to_cart: 'add_to_cart_count', profile_visit: 'profile_visit_count' };

const recordEvent = (type) => async (req, res) => {
  try {
    const row = await visibleReel(toId(req.params.id));
    if (!row) return fail(res, 404, 'This video is not available', 'NOT_FOUND');
    const customerId = customerIdOf(req);
    let productId = null;
    if (type !== 'share' && type !== 'profile_visit') {
      productId = toId(req.body?.productId);
      const linked = productId
        ? (await pool.query('SELECT 1 FROM reel_products WHERE reel_id = $1 AND product_id = $2', [row.id, productId])).rows[0]
        : null;
      if (!linked) return fail(res, 400, 'That product is not in this video', 'PRODUCT_NOT_LINKED');
    }
    const recent = (
      await pool.query(
        `SELECT 1 FROM reel_events WHERE reel_id = $1 AND customer_id = $2 AND event_type = $3
           AND product_id IS NOT DISTINCT FROM $4 AND created_at >= NOW() - INTERVAL '10 minutes' LIMIT 1`,
        [row.id, customerId, type, productId]
      )
    ).rows[0];
    const counted = !recent;
    await pool.query('INSERT INTO reel_events (reel_id, customer_id, event_type, product_id, counted) VALUES ($1, $2, $3, $4, $5)', [row.id, customerId, type, productId, counted]);
    const value = counted
      ? (await pool.query(`UPDATE fashion_reels SET ${COUNTER[type]} = ${COUNTER[type]} + 1 WHERE id = $1 RETURNING ${COUNTER[type]} AS n`, [row.id])).rows[0].n
      : Number(row[COUNTER[type]]);
    return res.json({ success: true, counted, count: value });
  } catch (error) {
    console.error('❌ REEL EVENT ERROR:', error.message);
    return fail(res, 500, "Couldn't record that.");
  }
};

// -----------------------------------------------------
// Reports (moderation). REPORTS_TO_HIDE different customers -> the video
// is hidden from the feed until an admin reviews it.
// -----------------------------------------------------

const reportReel = async (req, res) => {
  try {
    const row = await visibleReel(toId(req.params.id));
    if (!row) return fail(res, 404, 'This video is not available', 'NOT_FOUND');
    const reason = String(req.body?.reason || '');
    if (!REPORT_REASONS.includes(reason)) return fail(res, 400, 'Choose a reason', 'BAD_REASON');
    const details = text(req.body?.details, 500);
    if (reason === 'other' && (!details || details.length < 5)) return fail(res, 400, 'Tell us what is wrong (at least 5 characters)', 'DETAILS_REQUIRED');
    const inserted = await pool.query(
      `INSERT INTO reel_reports (reel_id, customer_id, reason, details) VALUES ($1, $2, $3, $4)
       ON CONFLICT (reel_id, customer_id) DO NOTHING RETURNING id`,
      [row.id, customerIdOf(req), reason, details]
    );
    if (!inserted.rows.length) return fail(res, 409, 'You already reported this video. GetMe will review it.', 'ALREADY_REPORTED');
    const open = (await pool.query("SELECT COUNT(*)::int AS n FROM reel_reports WHERE reel_id = $1 AND status = 'open'", [row.id])).rows[0].n;
    let hidden = false;
    if (open >= REPORTS_TO_HIDE) {
      hidden = (await pool.query('UPDATE fashion_reels SET hidden_by_reports = TRUE, updated_at = NOW() WHERE id = $1 AND NOT hidden_by_reports RETURNING id', [row.id])).rowCount > 0;
      if (hidden) {
        try {
          req.app.get('io')?.to(`shop:${row.shop_id}`).emit('reel-updated', { reelId: Number(row.id), title: row.title || null, status: row.status, hidden: true });
        } catch {
          /* best effort */
        }
      }
    }
    adminNotifications.notify({
      category: 'shops',
      event: 'reel.reported',
      severity: hidden ? 'warning' : 'info',
      title: hidden ? `Video hidden after ${open} reports: ${row.shop_name}` : `Video reported (${reason}): ${row.shop_name}`,
      body: row.title || null,
      entityType: 'reel',
      entityId: row.id,
      permissions: ['shops.manage'],
      dedupe: `reel.reported:${row.id}:${open}`,
    });
    return res.status(201).json({ success: true, message: 'Thanks. GetMe will review this video.' });
  } catch (error) {
    console.error('❌ REEL REPORT ERROR:', error.message);
    return fail(res, 500, "Couldn't send the report.");
  }
};

// -----------------------------------------------------
// Follow shops (any approved shop)
// -----------------------------------------------------

const setFollow = (follow) => async (req, res) => {
  try {
    const shopId = toId(req.params.shopId);
    const shop = (await pool.query("SELECT id FROM shops WHERE id = $1 AND status = 'approved'", [shopId])).rows[0];
    if (!shop) return fail(res, 404, 'Shop not found', 'NOT_FOUND');
    if (follow) await pool.query('INSERT INTO shop_follows (shop_id, customer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [shopId, customerIdOf(req)]);
    else await pool.query('DELETE FROM shop_follows WHERE shop_id = $1 AND customer_id = $2', [shopId, customerIdOf(req)]);
    const followers = (await pool.query('SELECT COUNT(*)::int AS n FROM shop_follows WHERE shop_id = $1', [shopId])).rows[0].n;
    return res.json({ success: true, following: follow, followers });
  } catch (error) {
    console.error('❌ SHOP FOLLOW ERROR:', error.message);
    return fail(res, 500, "Couldn't save that.");
  }
};

const listFollowing = async (req, res) => {
  try {
    const rows = (
      await pool.query(
        `SELECT s.id, s.shop_name, s.image_url, s.business_type, s.city, s.area, s.district, f.created_at
         FROM shop_follows f JOIN shops s ON s.id = f.shop_id
         WHERE f.customer_id = $1 AND s.status = 'approved' ORDER BY f.created_at DESC LIMIT 200`,
        [customerIdOf(req)]
      )
    ).rows;
    return res.json({
      success: true,
      shops: rows.map((s) => ({
        id: Number(s.id), name: s.shop_name, logoUrl: s.image_url || null, businessType: s.business_type,
        city: s.city || s.area || null, district: s.district || null, followedAt: s.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ FOLLOWING ERROR:', error.message);
    return fail(res, 500, "Couldn't load the shops you follow.");
  }
};

const followState = async (req, res) => {
  try {
    const shopId = toId(req.params.shopId);
    const [mine, total, reels] = await Promise.all([
      pool.query('SELECT 1 FROM shop_follows WHERE shop_id = $1 AND customer_id = $2', [shopId, customerIdOf(req)]),
      pool.query('SELECT COUNT(*)::int AS n FROM shop_follows WHERE shop_id = $1', [shopId]),
      pool.query(`SELECT COUNT(*)::int AS n FROM fashion_reels r JOIN shops s ON s.id = r.shop_id WHERE r.shop_id = $1 AND ${VISIBLE}`, [shopId]),
    ]);
    return res.json({ success: true, following: !!mine.rows.length, followers: total.rows[0].n, reels: reels.rows[0].n });
  } catch (error) {
    console.error('❌ FOLLOW STATE ERROR:', error.message);
    return fail(res, 500, "Couldn't load this shop.");
  }
};

// Checkout attribution: { reelId -> Set(productId) } that may be credited
// (published, visible, same shop, product linked)
const attributableReels = async (client, shopId, reelIds) => {
  const ids = [...new Set(reelIds.map(toId).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const rows = (
    await client.query(
      `SELECT rp.reel_id, rp.product_id FROM reel_products rp
       JOIN fashion_reels r ON r.id = rp.reel_id JOIN shops s ON s.id = r.shop_id
       WHERE rp.reel_id = ANY($1) AND r.shop_id = $2 AND ${VISIBLE}`,
      [ids, shopId]
    )
  ).rows;
  for (const row of rows) {
    if (!map.has(Number(row.reel_id))) map.set(Number(row.reel_id), new Set());
    map.get(Number(row.reel_id)).add(Number(row.product_id));
  }
  return map;
};

module.exports = {
  getFeed,
  getReel,
  recordView,
  setLike,
  recordEvent,
  reportReel,
  setFollow,
  listFollowing,
  followState,
  attributableReels,
  PROMO_LABELS,
};
