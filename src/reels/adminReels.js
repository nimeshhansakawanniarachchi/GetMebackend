// =====================================================
// PHASE 62: FASHION REELS - ADMIN MODERATION (/api/admin/reels...)
// View: shops.view. Approve / reject / remove / restore, reports and
// shop publishing suspension: shops.manage. Changes are audited by the
// existing /api/admin router (auditAdminChanges).
// Only approved (published) videos reach customers.
// =====================================================

const {
  pool,
  linkedProducts,
  linkedCard,
  reelBase,
  removeStored,
  toId,
  fail,
  text,
} = require('./common');

const PAGE = 30;
const STATUSES = ['draft', 'pending_review', 'published', 'rejected', 'removed'];

const adminIdOf = (req) => Number(req.admin?.adminId) || null;

const emitShop = (req, shopId, payload) => {
  try {
    req.app.get('io')?.to(`shop:${shopId}`).emit('reel-updated', payload);
  } catch {
    /* socket is best effort */
  }
};

const adminView = (row, products, reports = []) => ({
  ...reelBase(row),
  status: row.status,
  reviewNote: row.review_note || null,
  removedReason: row.removed_reason || null,
  removedAt: row.removed_at || null,
  submittedAt: row.submitted_at || null,
  reviewedAt: row.reviewed_at || null,
  reviewedBy: row.reviewed_by ? Number(row.reviewed_by) : null,
  reviewedByName: row.reviewer_name || null,
  hiddenByReports: !!row.hidden_by_reports,
  deleted: !!row.deleted_at,
  deletedAt: row.deleted_at || null,
  deletedBy: row.deleted_at ? (row.deleted_by_admin_id ? 'admin' : 'shop') : null,
  deletedReason: row.deleted_reason || null,
  createdAt: row.created_at,
  videoBytes: row.video_bytes != null ? Number(row.video_bytes) : null,
  videoCodec: row.video_codec || null,
  openReports: row.open_reports != null ? Number(row.open_reports) : reports.filter((r) => r.status === 'open').length,
  shop: {
    id: Number(row.shop_id),
    name: row.shop_name,
    logoUrl: row.shop_logo || null,
    status: row.shop_status,
    reelsSuspendedAt: row.reels_suspended_at || null,
    reelsSuspendedReason: row.reels_suspended_reason || null,
  },
  products: (products || []).map(linkedCard),
  reports,
});

const SELECT = `SELECT r.*, s.shop_name, s.image_url AS shop_logo, s.status AS shop_status,
  s.reels_suspended_at, s.reels_suspended_reason,
  (SELECT a.full_name FROM admins a WHERE a.id = r.reviewed_by) AS reviewer_name,
  (SELECT COUNT(*)::int FROM reel_reports rr WHERE rr.reel_id = r.id AND rr.status = 'open') AS open_reports
  FROM fashion_reels r JOIN shops s ON s.id = r.shop_id`;

const listReels = async (req, res) => {
  try {
    const params = [];
    // Phase 62b: ?deleted=1 lists deleted videos (by the shop or an admin)
    const where = [req.query.deleted === '1' ? 'r.deleted_at IS NOT NULL' : 'r.deleted_at IS NULL'];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    // Filters shared by the list and the tab counts (shop, search, upload date)
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    if (toId(req.query.shopId)) add('r.shop_id = ?', toId(req.query.shopId));
    // Phase 63: clothing | restaurant
    if (['clothing', 'restaurant'].includes(req.query.type)) add('r.business_type = ?', req.query.type);
    if (DATE.test(String(req.query.from || ''))) add("(r.created_at AT TIME ZONE 'Asia/Colombo')::date >= ?::date", req.query.from);
    if (DATE.test(String(req.query.to || ''))) add("(r.created_at AT TIME ZONE 'Asia/Colombo')::date <= ?::date", req.query.to);
    const qFilter = text(req.query.q, 60);
    if (qFilter) add('(r.title ILIKE ? OR s.shop_name ILIKE ?)'.replace('?', `$${params.length + 1}`), `%${qFilter}%`);
    const shared = { where: [...where.slice(1)], params: [...params] };
    if (STATUSES.includes(req.query.status)) add('r.status = ?', req.query.status);
    if (req.query.reported === '1') where.push("EXISTS (SELECT 1 FROM reel_reports rr WHERE rr.reel_id = r.id AND rr.status = 'open')");
    if (req.query.hidden === '1') where.push('r.hidden_by_reports');
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM fashion_reels r JOIN shops s ON s.id = r.shop_id WHERE ${where.join(' AND ')}`, params)).rows[0].n);
    const rows = (
      await pool.query(
        `${SELECT} WHERE ${where.join(' AND ')}
         ORDER BY CASE r.status WHEN 'pending_review' THEN 0 ELSE 1 END, COALESCE(r.submitted_at, r.updated_at) DESC
         LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`,
        params
      )
    ).rows;
    const products = await linkedProducts(rows.map((r) => r.id));
    // Tab counts use the same shop / search / date filters as the list
    const sharedWhere = ['r.deleted_at IS NULL', ...shared.where].join(' AND ');
    const counts = (
      await pool.query(
        `SELECT r.status, COUNT(*)::int AS n FROM fashion_reels r JOIN shops s ON s.id = r.shop_id WHERE ${sharedWhere} GROUP BY r.status
         UNION ALL SELECT 'reported', COUNT(*)::int FROM fashion_reels r JOIN shops s ON s.id = r.shop_id
           WHERE ${sharedWhere} AND EXISTS (SELECT 1 FROM reel_reports rr WHERE rr.reel_id = r.id AND rr.status = 'open')
         UNION ALL SELECT 'hidden', COUNT(*)::int FROM fashion_reels r JOIN shops s ON s.id = r.shop_id WHERE ${sharedWhere} AND r.hidden_by_reports
         UNION ALL SELECT 'deleted', COUNT(*)::int FROM fashion_reels r JOIN shops s ON s.id = r.shop_id
           WHERE ${['r.deleted_at IS NOT NULL', ...shared.where].join(' AND ')}`,
        shared.params
      )
    ).rows;
    return res.json({
      success: true,
      page,
      pageSize: PAGE,
      total,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      reels: rows.map((r) => adminView(r, products.get(Number(r.id)))),
    });
  } catch (error) {
    console.error('❌ ADMIN REELS ERROR:', error.message);
    return fail(res, 500, 'Unable to load videos');
  }
};

const loadReel = async (id, client = pool, lock = false) =>
  (await client.query(`${SELECT} WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`, [id])).rows[0] || null;

const reportsOf = async (id) =>
  (
    await pool.query(
      `SELECT rr.*, c.full_name AS customer_name FROM reel_reports rr LEFT JOIN customers c ON c.id = rr.customer_id
       WHERE rr.reel_id = $1 ORDER BY rr.created_at DESC`,
      [id]
    )
  ).rows.map((r) => ({
    id: Number(r.id),
    reason: r.reason,
    details: r.details || null,
    status: r.status,
    customer: r.customer_name || `Customer #${r.customer_id}`,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolutionNote: r.resolution_note || null,
  }));

const fullView = async (row) =>
  adminView(row, (await linkedProducts([row.id])).get(Number(row.id)), await reportsOf(row.id));

const getReel = async (req, res) => {
  try {
    const row = await loadReel(toId(req.params.id));
    if (!row) return fail(res, 404, 'Video not found', 'NOT_FOUND');
    return res.json({ success: true, reel: await fullView(row) });
  } catch (error) {
    console.error('❌ ADMIN REEL ERROR:', error.message);
    return fail(res, 500, 'Unable to load this video');
  }
};

const readReason = (req, min = 5) => {
  const reason = text(req.body?.reason, 500);
  return reason && reason.length >= min ? reason : null;
};

// One moderation action with a state check
const act = ({ from, to, needsReason, label }) => async (req, res) => {
  const id = toId(req.params.id);
  const reason = readReason(req);
  if (needsReason && !reason) return fail(res, 400, 'Enter a reason (at least 5 characters). The shop will see it.', 'REASON_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await loadReel(id, client, true);
    if (!row || row.deleted_at) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Video not found', 'NOT_FOUND');
    }
    if (!from.includes(row.status)) {
      await client.query('ROLLBACK');
      return fail(res, 409, `This video is ${row.status.replace('_', ' ')}; it can't be ${label} now`, 'BAD_STATE', { status: row.status });
    }
    if (to === 'published' && !row.video_file) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'This video has no file', 'NO_VIDEO');
    }
    const sets = ['status = $2', 'reviewed_by = $3', 'reviewed_at = NOW()', 'updated_at = NOW()'];
    const params = [id, to, adminIdOf(req)];
    if (to === 'published') sets.push('published_at = COALESCE(published_at, NOW())', 'review_note = NULL', 'hidden_by_reports = FALSE');
    if (to === 'rejected') {
      params.push(reason);
      sets.push(`review_note = $${params.length}`);
    }
    if (to === 'removed') {
      params.push(reason);
      sets.push(`removed_reason = $${params.length}`, 'removed_at = NOW()');
    }
    if (to === 'pending_review') sets.push('removed_reason = NULL', 'removed_at = NULL', 'submitted_at = NOW()');
    await client.query(`UPDATE fashion_reels SET ${sets.join(', ')} WHERE id = $1`, params);
    if (to === 'removed') {
      await client.query(
        `UPDATE reel_reports SET status = 'actioned', resolved_by = $2, resolved_at = NOW(), resolution_note = $3
         WHERE reel_id = $1 AND status = 'open'`,
        [id, adminIdOf(req), reason]
      );
    }
    await client.query('COMMIT');
    emitShop(req, row.shop_id, { reelId: id, title: row.title || null, status: to, note: reason || null });
    return res.json({ success: true, reel: await fullView(await loadReel(id)) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ ADMIN REEL ACTION ERROR:', error.message);
    return fail(res, 500, 'Unable to update the video');
  } finally {
    client.release();
  }
};

const approve = act({ from: ['pending_review'], to: 'published', label: 'approved' });
const reject = act({ from: ['pending_review'], to: 'rejected', needsReason: true, label: 'rejected' });
const remove = act({ from: ['published', 'pending_review', 'draft', 'rejected'], to: 'removed', needsReason: true, label: 'removed' });
// A removed video goes back to review (never straight to customers)
const restore = act({ from: ['removed'], to: 'pending_review', label: 'restored' });

// -----------------------------------------------------
// Reports
// -----------------------------------------------------

const listReports = async (req, res) => {
  try {
    const status = ['open', 'dismissed', 'actioned'].includes(req.query.status) ? req.query.status : 'open';
    const rows = (
      await pool.query(
        `SELECT rr.*, r.title, r.status AS reel_status, r.hidden_by_reports, r.shop_id, r.cover_file, r.video_file, r.id AS rid, r.business_type,
                s.shop_name, c.full_name AS customer_name
         FROM reel_reports rr JOIN fashion_reels r ON r.id = rr.reel_id JOIN shops s ON s.id = r.shop_id
         LEFT JOIN customers c ON c.id = rr.customer_id
         WHERE rr.status = $1 ORDER BY rr.created_at DESC LIMIT 200`,
        [status]
      )
    ).rows;
    return res.json({
      success: true,
      reports: rows.map((r) => ({
        id: Number(r.id),
        reelId: Number(r.reel_id),
        reelTitle: r.title,
        reelStatus: r.reel_status,
        businessType: r.business_type,
        hiddenByReports: !!r.hidden_by_reports,
        coverUrl: reelBase({ ...r, id: r.rid }).coverUrl,
        shop: { id: Number(r.shop_id), name: r.shop_name },
        reason: r.reason,
        details: r.details || null,
        status: r.status,
        customer: r.customer_name || `Customer #${r.customer_id}`,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
        resolutionNote: r.resolution_note || null,
      })),
    });
  } catch (error) {
    console.error('❌ ADMIN REEL REPORTS ERROR:', error.message);
    return fail(res, 500, 'Unable to load reports');
  }
};

// { action: 'dismiss' | 'remove', note }
const resolveReport = async (req, res) => {
  const reportId = toId(req.params.reportId);
  const action = req.body?.action;
  const note = text(req.body?.note, 500);
  if (!['dismiss', 'remove'].includes(action)) return fail(res, 400, 'Choose dismiss or remove', 'VALIDATION');
  if (!note || note.length < 5) return fail(res, 400, 'Enter a note (at least 5 characters)', 'REASON_REQUIRED');
  try {
    const report = (await pool.query('SELECT * FROM reel_reports WHERE id = $1', [reportId])).rows[0];
    if (!report) return fail(res, 404, 'Report not found', 'NOT_FOUND');
    if (report.status !== 'open') return fail(res, 409, 'This report was already handled', 'BAD_STATE');
    if (action === 'remove') {
      req.params.id = String(report.reel_id);
      req.body.reason = note;
      return remove(req, res);
    }
    // Dismiss every open report on this video (one review covers them)
    await pool.query(
      `UPDATE reel_reports SET status = 'dismissed', resolved_by = $2, resolved_at = NOW(), resolution_note = $3
       WHERE reel_id = $1 AND status = 'open'`,
      [report.reel_id, adminIdOf(req), note]
    );
    const shown = (await pool.query('UPDATE fashion_reels SET hidden_by_reports = FALSE, updated_at = NOW() WHERE id = $1 RETURNING shop_id, title, status', [report.reel_id])).rows[0];
    if (shown) emitShop(req, shown.shop_id, { reelId: Number(report.reel_id), title: shown.title || null, status: shown.status, hidden: false });
    return res.json({ success: true, reel: await fullView(await loadReel(report.reel_id)) });
  } catch (error) {
    console.error('❌ ADMIN RESOLVE REPORT ERROR:', error.message);
    return fail(res, 500, 'Unable to resolve the report');
  }
};

// -----------------------------------------------------
// Shop publishing suspension
// -----------------------------------------------------

const suspendShop = async (req, res) => {
  const shopId = toId(req.params.id);
  const reason = readReason(req);
  if (!reason) return fail(res, 400, 'Enter a reason (at least 5 characters). The shop will see it.', 'REASON_REQUIRED');
  const hidePublished = req.body?.hidePublished === true;
  try {
    const shop = (
      await pool.query(
        'UPDATE shops SET reels_suspended_at = NOW(), reels_suspended_reason = $2 WHERE id = $1 RETURNING id, shop_name',
        [shopId, reason]
      )
    ).rows[0];
    if (!shop) return fail(res, 404, 'Shop not found', 'NOT_FOUND');
    let removed = 0;
    // Waiting videos go back to draft; optionally published ones are removed
    await pool.query("UPDATE fashion_reels SET status = 'draft', updated_at = NOW() WHERE shop_id = $1 AND status = 'pending_review' AND deleted_at IS NULL", [shopId]);
    if (hidePublished) {
      removed = (
        await pool.query(
          `UPDATE fashion_reels SET status = 'removed', removed_reason = $2, removed_at = NOW(), reviewed_by = $3, reviewed_at = NOW(), updated_at = NOW()
           WHERE shop_id = $1 AND status = 'published' AND deleted_at IS NULL`,
          [shopId, `Publishing suspended: ${reason}`, adminIdOf(req)]
        )
      ).rowCount;
    }
    emitShop(req, shopId, { suspended: true, reason });
    return res.json({ success: true, shopId, suspended: true, reason, removedPublished: removed });
  } catch (error) {
    console.error('❌ SUSPEND REELS ERROR:', error.message);
    return fail(res, 500, 'Unable to suspend video publishing');
  }
};

const unsuspendShop = async (req, res) => {
  const shopId = toId(req.params.id);
  try {
    const shop = (
      await pool.query('UPDATE shops SET reels_suspended_at = NULL, reels_suspended_reason = NULL WHERE id = $1 RETURNING id', [shopId])
    ).rows[0];
    if (!shop) return fail(res, 404, 'Shop not found', 'NOT_FOUND');
    emitShop(req, shopId, { suspended: false });
    return res.json({ success: true, shopId, suspended: false });
  } catch (error) {
    console.error('❌ UNSUSPEND REELS ERROR:', error.message);
    return fail(res, 500, 'Unable to restore video publishing');
  }
};

// -----------------------------------------------------
// DELETE /reels/:id {reason} - permanent: the video and cover files are
// removed from disk and the video can never be shown again. The record
// (shop, title, counts, reports, reason) stays for the audit trail.
// Prefer "remove" for normal moderation (it can be restored).
// -----------------------------------------------------

const deleteReel = async (req, res) => {
  const id = toId(req.params.id);
  const reason = readReason(req);
  if (!reason) return fail(res, 400, 'Enter a reason (at least 5 characters). The shop will see it.', 'REASON_REQUIRED');
  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN');
    row = await loadReel(id, client, true);
    if (!row) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'Video not found', 'NOT_FOUND');
    }
    if (row.deleted_at) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'This video was already deleted', 'BAD_STATE', { status: 'deleted' });
    }
    await client.query(
      `UPDATE fashion_reels SET deleted_at = NOW(), deleted_by_admin_id = $2, deleted_reason = $3,
         status = 'removed', removed_at = COALESCE(removed_at, NOW()), removed_reason = COALESCE(removed_reason, $3),
         video_file = NULL, cover_file = NULL, reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, adminIdOf(req), reason]
    );
    await client.query(
      `UPDATE reel_reports SET status = 'actioned', resolved_by = $2, resolved_at = NOW(), resolution_note = $3
       WHERE reel_id = $1 AND status = 'open'`,
      [id, adminIdOf(req), `Deleted: ${reason}`]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ ADMIN DELETE REEL ERROR:', error.message);
    return fail(res, 500, 'Unable to delete the video');
  } finally {
    client.release();
  }
  removeStored(row.video_file);
  removeStored(row.cover_file);
  emitShop(req, row.shop_id, { reelId: id, title: row.title || null, status: 'deleted', note: reason });
  return res.json({ success: true, reel: await fullView(await loadReel(id)) });
};

// -----------------------------------------------------
// GET /shops/:id/reels - one shop's videos for its Shop Details page.
// The shop id is taken from the shop RECORD loaded here (404 when the
// shop doesn't exist); any shopId in the query string is ignored, so the
// list can never show another shop's videos. Same filters / tabs / rows
// as GET /reels (same records, same moderation actions).
// -----------------------------------------------------

const listShopReels = async (req, res) => {
  try {
    const shop = (
      await pool.query(
        'SELECT id, shop_name, business_type, status, image_url, reels_suspended_at, reels_suspended_reason FROM shops WHERE id = $1',
        [toId(req.params.id)]
      )
    ).rows[0];
    if (!shop) return fail(res, 404, 'Shop not found', 'NOT_FOUND');
    const query = { ...req.query, shopId: String(shop.id) };
    const shopInfo = {
      id: Number(shop.id),
      name: shop.shop_name,
      businessType: shop.business_type,
      status: shop.status,
      logoUrl: shop.image_url || null,
      usesReels: ['clothing', 'restaurant'].includes(shop.business_type),
      reelsSuspendedAt: shop.reels_suspended_at || null,
      reelsSuspendedReason: shop.reels_suspended_reason || null,
    };
    // listReels answers through res: add the shop to a successful answer
    const proxy = {
      status: (code) => ({ json: (body) => res.status(code).json(body) }),
      json: (body) => res.json(body && body.success ? { ...body, shop: shopInfo } : body),
    };
    return listReels({ ...req, query }, proxy);
  } catch (error) {
    console.error('❌ ADMIN SHOP REELS ERROR:', error.message);
    return fail(res, 500, "Unable to load this shop's videos");
  }
};

module.exports = { listReels, listShopReels, getReel, approve, reject, remove, restore, deleteReel, listReports, resolveReport, suspendShop, unsuspendShop };
