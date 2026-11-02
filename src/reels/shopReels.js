// =====================================================
// PHASE 62: FASHION REELS - SHOP PORTAL (/api/shop/reels...)
// Clothing shops only; every query is scoped to req.shop.shopId.
// Life cycle: draft -> (submit) pending_review -> (admin) published |
// rejected. Editing the title / caption / hashtags / video / cover of a
// published reel sends it back to review; linking products or changing
// its type does not. Unpublish -> draft. Delete = soft delete + files
// removed from disk.
// =====================================================

const {
  pool,
  LIMITS,
  PROMO_TYPES,
  REEL_TYPES,
  DEFAULT_PROMO,
  promoTypesFor,
  AUDIENCES,
  acceptVideo,
  acceptCover,
  removeFile,
  removeStored,
  readHashtags,
  readProductIds,
  validateProducts,
  saveProducts,
  linkedProducts,
  linkedCard,
  reelBase,
  round2,
  toId,
  fail,
  text,
} = require('./common');
const { recordShopActivity } = require('../middleware/shopAccess');
const adminNotifications = require('../admin/notifications');

const actorOf = (req) => ({
  type: req.shop.staffId ? 'staff' : 'owner',
  id: req.shop.staffId || req.shop.shopId,
  name: req.shop.actorName || null,
  role: req.shop.role,
});
const log = (req, action, id, summary) =>
  recordShopActivity({ shopId: req.shop.shopId, actor: actorOf(req), action, entityType: 'reel', entityId: id, summary });

const filesOf = (req) => ({
  video: req.files?.video?.[0] || null,
  cover: req.files?.cover?.[0] || null,
});
const dropUploads = (req) => {
  const { video, cover } = filesOf(req);
  removeFile(video);
  removeFile(cover);
};

// Guard: clothing shops and restaurants (phase 63) (sets req.reelShop)
const requireClothingShop = async (req, res, next) => {
  try {
    const shop = (
      await pool.query('SELECT id, shop_name, business_type, status, reels_suspended_at, reels_suspended_reason FROM shops WHERE id = $1', [req.shop.shopId])
    ).rows[0];
    if (!shop) {
      dropUploads(req);
      return fail(res, 404, 'Shop not found');
    }
    if (!REEL_TYPES.includes(shop.business_type)) {
      dropUploads(req);
      return fail(res, 403, 'Reels are for clothing shops and restaurants', 'NOT_CLOTHING');
    }
    req.reelShop = shop;
    return next();
  } catch (error) {
    dropUploads(req);
    return next(error);
  }
};

const shopView = (row, products) => ({
  ...reelBase(row),
  status: row.status,
  reviewNote: row.review_note || null,
  removedReason: row.removed_reason || null,
  submittedAt: row.submitted_at || null,
  reviewedAt: row.reviewed_at || null,
  hiddenByReports: !!row.hidden_by_reports,
  videoBytes: row.video_bytes != null ? Number(row.video_bytes) : null,
  videoCodec: row.video_codec || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  products: (products || []).map(linkedCard),
});

const loadOwn = async (client, shopId, id, lock = false) =>
  (
    await client.query(
      `SELECT * FROM fashion_reels WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
      [id, shopId]
    )
  ).rows[0] || null;

const fullView = async (row) => shopView(row, (await linkedProducts([row.id])).get(Number(row.id)));

// Reads title / caption / hashtags / type / audience from a body
const readFields = (body, existing = null, type = 'clothing') => {
  const out = {};
  if (body.title !== undefined || !existing) {
    const title = text(body.title, 100) || '';
    out.title = title;
  }
  if (body.caption !== undefined) out.caption = text(body.caption, 1000);
  if (body.hashtags !== undefined) out.hashtags = readHashtags(body.hashtags);
  if (body.promoType !== undefined) {
    if (!promoTypesFor(type).includes(body.promoType)) return { error: 'Choose what the video promotes', code: 'BAD_PROMO_TYPE' };
    out.promo_type = body.promoType;
  }
  if (body.audience !== undefined) {
    const audience = body.audience === '' || body.audience == null ? null : String(body.audience);
    if (audience && !AUDIENCES.includes(audience)) return { error: 'Choose men, women, kids or unisex', code: 'BAD_AUDIENCE' };
    out.audience = audience;
  }
  return { value: out };
};

// -----------------------------------------------------
// GET /reels
// -----------------------------------------------------

const listReels = async (req, res) => {
  try {
    const status = ['draft', 'pending_review', 'published', 'rejected', 'removed'].includes(req.query.status) ? req.query.status : null;
    const rows = (
      await pool.query(
        `SELECT * FROM fashion_reels WHERE shop_id = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR status = $2)
         ORDER BY updated_at DESC LIMIT 300`,
        [req.shop.shopId, status]
      )
    ).rows;
    const products = await linkedProducts(rows.map((r) => r.id));
    const counts = (
      await pool.query(
        'SELECT status, COUNT(*)::int AS n FROM fashion_reels WHERE shop_id = $1 AND deleted_at IS NULL GROUP BY status',
        [req.shop.shopId]
      )
    ).rows;
    return res.json({
      success: true,
      limits: LIMITS,
      businessType: req.reelShop.business_type,
      promoTypes: promoTypesFor(req.reelShop.business_type),
      audiences: AUDIENCES,
      suspended: req.reelShop.reels_suspended_at
        ? { at: req.reelShop.reels_suspended_at, reason: req.reelShop.reels_suspended_reason || null }
        : null,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      reels: rows.map((r) => shopView(r, products.get(Number(r.id)))),
    });
  } catch (error) {
    console.error('❌ SHOP REELS ERROR:', error.message);
    return fail(res, 500, "Couldn't load your videos.");
  }
};

const getReel = async (req, res) => {
  try {
    const row = await loadOwn(pool, req.shop.shopId, toId(req.params.id));
    if (!row) return fail(res, 404, 'Video not found', 'NOT_FOUND');
    return res.json({ success: true, reel: await fullView(row) });
  } catch (error) {
    console.error('❌ SHOP REEL ERROR:', error.message);
    return fail(res, 500, "Couldn't load this video.");
  }
};

// -----------------------------------------------------
// POST /reels (multipart: video, cover?, fields) -> draft
// -----------------------------------------------------

const createReel = async (req, res) => {
  const shopId = req.shop.shopId;
  const { video, cover } = filesOf(req);
  try {
    if (req.reelShop.reels_suspended_at) {
      dropUploads(req);
      return fail(res, 403, `Video publishing is suspended for this shop${req.reelShop.reels_suspended_reason ? `: ${req.reelShop.reels_suspended_reason}` : ''}`, 'REELS_SUSPENDED');
    }
    const usage = (
      await pool.query(
        `SELECT COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS total,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')::int AS today
         FROM fashion_reels WHERE shop_id = $1`,
        [shopId]
      )
    ).rows[0];
    if (usage.total >= LIMITS.maxReelsPerShop) {
      dropUploads(req);
      return fail(res, 400, `A shop can keep up to ${LIMITS.maxReelsPerShop} videos. Delete old ones first.`, 'TOO_MANY_REELS');
    }
    if (usage.today >= LIMITS.maxUploadsPerDay) {
      dropUploads(req);
      return fail(res, 429, `You can upload up to ${LIMITS.maxUploadsPerDay} videos a day`, 'UPLOAD_LIMIT');
    }
    const fields = readFields(req.body || {}, null, req.reelShop.business_type);
    if (fields.error) {
      dropUploads(req);
      return fail(res, 400, fields.error, fields.code);
    }
    const ids = readProductIds(req.body?.productIds);
    const checked = await validateProducts(pool, shopId, ids);
    if (checked.error) {
      dropUploads(req);
      return fail(res, 400, checked.error, checked.code);
    }
    const vid = await acceptVideo(video);
    if (vid.error) {
      removeFile(cover);
      return fail(res, 400, vid.error, vid.code, vid.info ? { video: { seconds: vid.info.durationSeconds, width: vid.info.width, height: vid.info.height, codec: vid.info.codec } } : {});
    }
    const cov = await acceptCover(cover);
    if (cov.error) {
      removeStored(vid.value.file);
      return fail(res, 400, cov.error, cov.code);
    }

    const client = await pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      row = (
        await client.query(
          `INSERT INTO fashion_reels (shop_id, business_type, title, caption, hashtags, promo_type, audience,
             video_file, video_mime, video_bytes, video_codec, duration_seconds, width, height,
             cover_file, cover_mime, created_by_staff_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
          [
            shopId, req.reelShop.business_type, fields.value.title || '', fields.value.caption ?? null, fields.value.hashtags || [],
            fields.value.promo_type || DEFAULT_PROMO[req.reelShop.business_type] || 'other', fields.value.audience ?? null,
            vid.value.file, vid.value.mime, vid.value.bytes, vid.value.codec, vid.value.duration, vid.value.width, vid.value.height,
            cov.value?.file || null, cov.value?.mime || null, req.shop.staffId || null,
          ]
        )
      ).rows[0];
      await saveProducts(client, row.id, checked.value);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      removeStored(vid.value.file);
      removeStored(cov.value?.file);
      throw error;
    } finally {
      client.release();
    }
    log(req, 'reel.create', row.id, `Uploaded video "${row.title || `#${row.id}`}" (${Math.round(Number(row.duration_seconds))} s, draft)`);
    return res.status(201).json({ success: true, reel: await fullView(row) });
  } catch (error) {
    console.error('❌ CREATE REEL ERROR:', error.message);
    return fail(res, 500, "Couldn't save the video. Please try again.");
  }
};

// -----------------------------------------------------
// PUT /reels/:id (json) - fields + products
// -----------------------------------------------------

const CONTENT_FIELDS = ['title', 'caption', 'hashtags'];

const backToReview = async (client, row) => {
  if (row.status !== 'published' && row.status !== 'rejected') return row.status;
  // a published reel goes back to review; a rejected one stays rejected
  // until the shop submits it again
  return row.status === 'published' ? 'pending_review' : row.status;
};

const updateReel = async (req, res) => {
  const id = toId(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await loadOwn(client, req.shop.shopId, id, true);
    if (!row) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Video not found', 'NOT_FOUND');
    }
    if (row.status === 'removed') {
      await client.query('ROLLBACK');
      return fail(res, 409, 'GetMe removed this video. It can no longer be edited.', 'REEL_REMOVED');
    }
    const fields = readFields(req.body || {}, row, req.reelShop.business_type);
    if (fields.error) {
      await client.query('ROLLBACK');
      return fail(res, 400, fields.error, fields.code);
    }
    const contentChanged = CONTENT_FIELDS.some((key) => {
      if (fields.value[key] === undefined) return false;
      const before = key === 'hashtags' ? JSON.stringify(row.hashtags || []) : row[key] ?? null;
      const after = key === 'hashtags' ? JSON.stringify(fields.value[key]) : fields.value[key] ?? null;
      return before !== after;
    });
    const sets = [];
    const params = [id];
    for (const [key, value] of Object.entries(fields.value)) {
      params.push(value);
      sets.push(`${key} = $${params.length}`);
    }
    let status = row.status;
    if (contentChanged && row.status === 'published') {
      status = await backToReview(client, row);
      params.push(status);
      sets.push(`status = $${params.length}`, 'submitted_at = NOW()');
    }
    if (req.body?.productIds !== undefined) {
      const checked = await validateProducts(client, req.shop.shopId, readProductIds(req.body.productIds));
      if (checked.error) {
        await client.query('ROLLBACK');
        return fail(res, 400, checked.error, checked.code);
      }
      await saveProducts(client, id, checked.value);
    }
    if (sets.length) await client.query(`UPDATE fashion_reels SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
    else await client.query('UPDATE fashion_reels SET updated_at = NOW() WHERE id = $1', [id]);
    await client.query('COMMIT');
    const fresh = await loadOwn(pool, req.shop.shopId, id);
    log(req, 'reel.update', id, `Edited video "${fresh.title || `#${id}`}"${status !== row.status ? ' (sent back to review)' : ''}`);
    if (status === 'pending_review' && row.status === 'published') notifySubmitted(req.reelShop, fresh);
    return res.json({ success: true, backToReview: status !== row.status, reel: await fullView(fresh) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ UPDATE REEL ERROR:', error.message);
    return fail(res, 500, "Couldn't save the changes.");
  } finally {
    client.release();
  }
};

// PUT /reels/:id/video and /reels/:id/cover (multipart)
const replaceMedia = (kind) => async (req, res) => {
  const id = toId(req.params.id);
  const { video, cover } = filesOf(req);
  try {
    const row = await loadOwn(pool, req.shop.shopId, id);
    if (!row) {
      dropUploads(req);
      return fail(res, 404, 'Video not found', 'NOT_FOUND');
    }
    if (row.status === 'removed') {
      dropUploads(req);
      return fail(res, 409, 'GetMe removed this video. It can no longer be edited.', 'REEL_REMOVED');
    }
    let updated;
    if (kind === 'video') {
      removeFile(cover);
      const vid = await acceptVideo(video);
      if (vid.error) {
        return fail(res, 400, vid.error, vid.code, vid.info ? { video: { seconds: vid.info.durationSeconds, width: vid.info.width, height: vid.info.height, codec: vid.info.codec } } : {});
      }
      updated = (
        await pool.query(
          `UPDATE fashion_reels SET video_file = $2, video_mime = $3, video_bytes = $4, video_codec = $5,
             duration_seconds = $6, width = $7, height = $8,
             status = CASE WHEN status = 'published' THEN 'pending_review' ELSE status END,
             submitted_at = CASE WHEN status = 'published' THEN NOW() ELSE submitted_at END,
             updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [id, vid.value.file, vid.value.mime, vid.value.bytes, vid.value.codec, vid.value.duration, vid.value.width, vid.value.height]
        )
      ).rows[0];
      removeStored(row.video_file);
    } else {
      removeFile(video);
      if (!cover) return fail(res, 400, 'Choose a cover image', 'COVER_REQUIRED');
      const cov = await acceptCover(cover);
      if (cov.error) return fail(res, 400, cov.error, cov.code);
      updated = (
        await pool.query(
          `UPDATE fashion_reels SET cover_file = $2, cover_mime = $3,
             status = CASE WHEN status = 'published' THEN 'pending_review' ELSE status END,
             submitted_at = CASE WHEN status = 'published' THEN NOW() ELSE submitted_at END,
             updated_at = NOW()
           WHERE id = $1 RETURNING *`,
          [id, cov.value.file, cov.value.mime]
        )
      ).rows[0];
      removeStored(row.cover_file);
    }
    log(req, `reel.${kind}`, id, `Replaced the ${kind} of "${updated.title || `#${id}`}"`);
    if (row.status === 'published') notifySubmitted(req.reelShop, updated);
    return res.json({ success: true, backToReview: row.status === 'published', reel: await fullView(updated) });
  } catch (error) {
    dropUploads(req);
    console.error('❌ REPLACE REEL MEDIA ERROR:', error.message);
    return fail(res, 500, `Couldn't replace the ${kind}.`);
  }
};

// -----------------------------------------------------
// Submit / unpublish / delete
// -----------------------------------------------------

const notifySubmitted = (shop, reel) =>
  adminNotifications.notify({
    category: 'shops',
    event: 'reel.submitted',
    severity: 'info',
    title: `Video to review: ${shop.shop_name}`,
    body: reel.title || null,
    entityType: 'reel',
    entityId: reel.id,
    permissions: ['shops.manage'],
    dedupe: `reel.submitted:${reel.id}:${new Date(reel.submitted_at || Date.now()).getTime()}`,
  });

const submitReel = async (req, res) => {
  const id = toId(req.params.id);
  try {
    const shop = req.reelShop;
    if (shop.reels_suspended_at) {
      return fail(res, 403, `Video publishing is suspended for this shop${shop.reels_suspended_reason ? `: ${shop.reels_suspended_reason}` : ''}`, 'REELS_SUSPENDED');
    }
    if (shop.status !== 'approved') return fail(res, 403, 'Your shop must be approved by GetMe before you publish videos', 'SHOP_NOT_APPROVED');
    const row = await loadOwn(pool, req.shop.shopId, id);
    if (!row) return fail(res, 404, 'Video not found', 'NOT_FOUND');
    if (!['draft', 'rejected'].includes(row.status)) {
      return fail(res, 409, row.status === 'pending_review' ? 'This video is already waiting for review' : 'This video cannot be submitted now', 'BAD_STATE');
    }
    if (!row.video_file) return fail(res, 400, 'Upload the video first', 'VIDEO_REQUIRED');
    if (!row.title || row.title.trim().length < 3) return fail(res, 400, 'Add a title (at least 3 characters)', 'TITLE_REQUIRED');
    const linked = (await pool.query('SELECT COUNT(*)::int AS n FROM reel_products WHERE reel_id = $1', [id])).rows[0].n;
    if (!linked) return fail(res, 400, 'Link at least one product so customers can shop the video', 'PRODUCTS_REQUIRED');
    const updated = (
      await pool.query(
        `UPDATE fashion_reels SET status = 'pending_review', submitted_at = NOW(), review_note = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id]
      )
    ).rows[0];
    log(req, 'reel.submit', id, `Sent "${updated.title}" to GetMe for review`);
    notifySubmitted(shop, updated);
    return res.json({ success: true, reel: await fullView(updated) });
  } catch (error) {
    console.error('❌ SUBMIT REEL ERROR:', error.message);
    return fail(res, 500, "Couldn't submit the video.");
  }
};

const unpublishReel = async (req, res) => {
  const id = toId(req.params.id);
  try {
    const row = await loadOwn(pool, req.shop.shopId, id);
    if (!row) return fail(res, 404, 'Video not found', 'NOT_FOUND');
    if (!['published', 'pending_review'].includes(row.status)) return fail(res, 409, 'Only published or waiting videos can be taken down', 'BAD_STATE');
    const updated = (
      await pool.query("UPDATE fashion_reels SET status = 'draft', updated_at = NOW() WHERE id = $1 RETURNING *", [id])
    ).rows[0];
    log(req, 'reel.unpublish', id, `Took down "${updated.title}" (now a draft)`);
    return res.json({ success: true, reel: await fullView(updated) });
  } catch (error) {
    console.error('❌ UNPUBLISH REEL ERROR:', error.message);
    return fail(res, 500, "Couldn't take the video down.");
  }
};

const deleteReel = async (req, res) => {
  const id = toId(req.params.id);
  try {
    const row = await loadOwn(pool, req.shop.shopId, id);
    if (!row) return fail(res, 404, 'Video not found', 'NOT_FOUND');
    await pool.query(
      'UPDATE fashion_reels SET deleted_at = NOW(), video_file = NULL, cover_file = NULL, updated_at = NOW() WHERE id = $1',
      [id]
    );
    removeStored(row.video_file);
    removeStored(row.cover_file);
    log(req, 'reel.delete', id, `Deleted video "${row.title || `#${id}`}"`);
    return res.json({ success: true });
  } catch (error) {
    console.error('❌ DELETE REEL ERROR:', error.message);
    return fail(res, 500, "Couldn't delete the video.");
  }
};

// -----------------------------------------------------
// GET /reels/analytics?from&to
// -----------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const analytics = async (req, res) => {
  const shopId = req.shop.shopId;
  const colombo = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const to = DATE.test(String(req.query.to || '')) ? String(req.query.to) : colombo(new Date());
  const from = DATE.test(String(req.query.from || '')) ? String(req.query.from) : colombo(new Date(Date.now() - 29 * 86400000));
  if (from > to) return fail(res, 400, 'The start date is after the end date', 'VALIDATION');
  const days = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
  if (days > 366) return fail(res, 400, 'Choose at most one year', 'VALIDATION');
  const inRange = (col) => `(${col} AT TIME ZONE 'Asia/Colombo')::date BETWEEN $2::date AND $3::date`;
  const params = [shopId, from, to];
  try {
    const [views, likes, events, orders, daily, perReel] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS n, COUNT(DISTINCT v.viewer_key)::int AS viewers FROM reel_views v JOIN fashion_reels r ON r.id = v.reel_id
         WHERE r.shop_id = $1 AND r.deleted_at IS NULL AND v.view_day BETWEEN $2::date AND $3::date`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::int AS n FROM reel_likes l JOIN fashion_reels r ON r.id = l.reel_id WHERE r.shop_id = $1 AND r.deleted_at IS NULL AND ${inRange('l.created_at')}`,
        params
      ),
      pool.query(
        `SELECT e.event_type, COUNT(*)::int AS n FROM reel_events e JOIN fashion_reels r ON r.id = e.reel_id
         WHERE r.shop_id = $1 AND r.deleted_at IS NULL AND e.counted AND ${inRange('e.created_at')} GROUP BY e.event_type`,
        params
      ),
      // Orders: confirmed (sent to the store) orders with a line bought
      // from one of this shop's videos (validated at checkout)
      pool.query(
        `SELECT COUNT(DISTINCT o.id)::int AS placed,
                COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'delivered')::int AS completed,
                COALESCE(SUM(oi.line_total) FILTER (WHERE o.status = 'delivered'), 0) AS revenue,
                COALESCE(SUM(oi.quantity) FILTER (WHERE o.status <> 'cancelled'), 0) AS units
         FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN fashion_reels r ON r.id = oi.source_reel_id
         WHERE r.shop_id = $1 AND r.deleted_at IS NULL AND o.shopper_search_started_at IS NOT NULL AND o.status <> 'cancelled'
           AND ${inRange('o.shopper_search_started_at')}`,
        params
      ),
      pool.query(
        `SELECT v.view_day::text AS day, COUNT(*)::int AS views FROM reel_views v JOIN fashion_reels r ON r.id = v.reel_id
         WHERE r.shop_id = $1 AND r.deleted_at IS NULL AND v.view_day BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 1`,
        params
      ),
      pool.query(
        `SELECT r.id, r.title, r.status, r.view_count, r.like_count, r.share_count, r.product_click_count, r.add_to_cart_count, r.profile_visit_count,
                r.published_at,
                (SELECT COUNT(DISTINCT oi.order_id)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE oi.source_reel_id = r.id AND o.shopper_search_started_at IS NOT NULL AND o.status <> 'cancelled') AS orders,
                (SELECT COALESCE(SUM(oi.line_total), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE oi.source_reel_id = r.id AND o.status = 'delivered') AS revenue
         FROM fashion_reels r WHERE r.shop_id = $1 AND r.deleted_at IS NULL
         ORDER BY r.view_count DESC, r.id DESC LIMIT 100`,
        [shopId]
      ),
    ]);
    const ev = Object.fromEntries(events.rows.map((r) => [r.event_type, r.n]));
    const byDay = new Map(daily.rows.map((r) => [r.day, r.views]));
    const series = [];
    for (let i = 0; i < days; i += 1) {
      const day = new Date(new Date(`${from}T00:00:00Z`).getTime() + i * 86400000).toISOString().slice(0, 10);
      series.push({ date: day, views: byDay.get(day) || 0 });
    }
    const o = orders.rows[0];
    return res.json({
      success: true,
      range: { from, to, days },
      viewRule: 'A view counts when a signed-in customer watches at least 2 seconds (or half of a shorter video); one view per customer per video per day.',
      totals: {
        views: views.rows[0].n,
        uniqueViewers: views.rows[0].viewers,
        likes: likes.rows[0].n,
        shares: ev.share || 0,
        productClicks: ev.product_click || 0,
        addToCart: ev.add_to_cart || 0,
        profileVisits: ev.profile_visit || 0,
        ordersPlaced: o.placed,
        ordersCompleted: o.completed,
        revenue: round2(o.revenue),
      },
      daily: series,
      reels: perReel.rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        status: r.status,
        publishedAt: r.published_at,
        views: r.view_count,
        likes: r.like_count,
        shares: r.share_count,
        productClicks: r.product_click_count,
        addToCart: r.add_to_cart_count,
        profileVisits: r.profile_visit_count,
        orders: r.orders,
        revenue: round2(r.revenue),
      })),
    });
  } catch (error) {
    console.error('❌ REEL ANALYTICS ERROR:', error.message);
    return fail(res, 500, "Couldn't load video analytics.");
  }
};

module.exports = {
  requireClothingShop,
  listReels,
  getReel,
  createReel,
  updateReel,
  replaceMedia,
  submitReel,
  unpublishReel,
  deleteReel,
  analytics,
};
