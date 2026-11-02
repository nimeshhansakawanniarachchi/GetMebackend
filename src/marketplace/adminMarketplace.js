// =====================================================
// PHASE 59: ADMIN - MULTI-CATEGORY MARKETPLACE (/api/admin/...)
// Business detail + documents + bank verification, business types /
// commission, categories, required documents, merchant products,
// merchant orders, returns, business payments, reports.
// Permissions reuse the existing catalogue (routes file).
// =====================================================

const {
  pool,
  BUSINESS_TYPES,
  MERCHANT_TYPES,
  round2,
  toId,
  fail,
  text,
  bool,
  num,
  loadProductExtras,
  toProduct,
  allowedVehiclesFor,
  clearTypeCache,
} = require('./common');
const { businessView, streamDocument } = require('./business');
const { stageOf, stageLabelOf } = require('./merchantOrders');
const { recordManualRefund, toSettlement, totalsOf } = require('./returns');
const { emitToAdmins } = require('../realtime');

const adminIdOf = (req) => Number(req.admin?.adminId || req.admin?.id) || null;
const PAGE = 25;
const hasPermission = (req, key) => require('../middleware/adminAccess').adminCan(req, key);

// -----------------------------------------------------
// Business detail, documents, bank
// -----------------------------------------------------

const getBusiness = async (req, res) => {
  try {
    const shop = (await pool.query('SELECT * FROM shops WHERE id = $1', [toId(req.params.id)])).rows[0];
    if (!shop) return fail(res, 404, 'Shop not found', 'NOT_FOUND');
    const mainId = Number(shop.parent_shop_id || shop.id);
    const [business, branches, stats] = await Promise.all([
      businessView(shop, { fullAccount: hasPermission(req, 'finance.view') }),
      pool.query('SELECT id, shop_name, status, city, area, is_open, parent_shop_id FROM shops WHERE (id = $1 OR parent_shop_id = $1) AND id <> $2 ORDER BY id', [mainId, shop.id]),
      pool.query(
        `SELECT COUNT(*)::int AS orders,
                COALESCE(SUM(items_total) FILTER (WHERE status = 'delivered'), 0)::float AS gross,
                AVG(EXTRACT(EPOCH FROM (merchant_ready_at - merchant_accepted_at)) / 60) FILTER (WHERE merchant_ready_at IS NOT NULL AND merchant_accepted_at IS NOT NULL)::float AS avg_prep,
                COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM orders o
         WHERE (o.shop_id = $1 OR EXISTS (SELECT 1 FROM order_shops os WHERE os.order_id = o.id AND os.shop_id = $1))
           AND o.created_at >= NOW() - INTERVAL '30 days' AND o.status NOT IN ('pending_shopper_search')`,
        [shop.id]
      ),
    ]);
    const s = stats.rows[0];
    return res.json({
      success: true,
      business,
      branches: branches.rows.map((b) => ({ id: Number(b.id), shopName: b.shop_name, status: b.status, city: b.city || b.area || null, isOpen: !!b.is_open, isMain: b.parent_shop_id == null })),
      stats: {
        orders30d: Number(s.orders) || 0,
        gross30d: round2(s.gross),
        avgPrepMinutes: s.avg_prep != null ? Math.round(Number(s.avg_prep)) : null,
        cancelRate: Number(s.orders) ? Math.round((Number(s.cancelled) / Number(s.orders)) * 1000) / 10 : 0,
      },
    });
  } catch (error) {
    console.error('❌ ADMIN BUSINESS ERROR:', error.message);
    return fail(res, 500, 'Unable to load the business');
  }
};

const getDocumentFile = async (req, res) => {
  try {
    const row = (await pool.query('SELECT * FROM shop_documents WHERE id = $1 AND shop_id = $2', [toId(req.params.docId), toId(req.params.id)])).rows[0];
    if (!row) return fail(res, 404, 'Document not found', 'NOT_FOUND');
    return streamDocument(res, row);
  } catch (error) {
    console.error('❌ ADMIN DOCUMENT ERROR:', error.message);
    return fail(res, 500, 'Unable to open the document');
  }
};

const reviewDocument = async (req, res) => {
  try {
    const status = req.body?.status;
    const note = text(req.body?.note, 500);
    if (!['accepted', 'rejected'].includes(status)) return fail(res, 400, 'Choose accepted or rejected', 'VALIDATION');
    if (status === 'rejected' && !note) return fail(res, 400, 'Tell the business why the document was rejected', 'VALIDATION');
    const row = (
      await pool.query(
        `UPDATE shop_documents SET status = $3, review_note = $4, reviewed_by_admin_id = $5, reviewed_at = NOW()
         WHERE id = $1 AND shop_id = $2 RETURNING *`,
        [toId(req.params.docId), toId(req.params.id), status, note, adminIdOf(req)]
      )
    ).rows[0];
    if (!row) return fail(res, 404, 'Document not found', 'NOT_FOUND');
    req.app.get('io')?.to(`shop:${row.shop_id}`).emit('shop:business-updated', { reason: 'document', docKey: row.doc_key, status });
    emitToAdmins(req.app.get('io'), 'admin:shops-updated', { shopId: Number(row.shop_id), reason: 'document' });
    return res.json({ success: true, document: { id: Number(row.id), docKey: row.doc_key, status: row.status, reviewNote: row.review_note } });
  } catch (error) {
    console.error('❌ ADMIN DOCUMENT REVIEW ERROR:', error.message);
    return fail(res, 500, 'Unable to update the document');
  }
};

const verifyBankAccount = async (req, res) => {
  try {
    const row = (
      await pool.query(
        'UPDATE shop_bank_accounts SET verified_at = NOW(), verified_by_admin_id = $2, updated_at = NOW() WHERE shop_id = $1 RETURNING shop_id',
        [toId(req.params.id), adminIdOf(req)]
      )
    ).rows[0];
    if (!row) return fail(res, 404, 'This business has not added a bank account', 'NOT_FOUND');
    return res.json({ success: true });
  } catch (error) {
    console.error('❌ ADMIN BANK VERIFY ERROR:', error.message);
    return fail(res, 500, 'Unable to verify the bank account');
  }
};

// -----------------------------------------------------
// Business types, categories, document types
// -----------------------------------------------------

const listBusinessTypes = async (req, res) => {
  try {
    const rows = (
      await pool.query(
        `SELECT bt.*, (SELECT COUNT(*)::int FROM shops s WHERE s.business_type = bt.key) AS shop_count,
                (SELECT COUNT(*)::int FROM shops s WHERE s.business_type = bt.key AND s.status = 'approved') AS approved_count
         FROM business_types bt ORDER BY sort`
      )
    ).rows;
    return res.json({
      success: true,
      businessTypes: rows.map((r) => ({
        key: r.key, label: r.label, description: r.description, commissionPercent: Number(r.commission_percent),
        returnWindowDays: Number(r.return_window_days), isActive: !!r.is_active, shopCount: Number(r.shop_count), approvedCount: Number(r.approved_count),
        usesCommission: r.key !== 'grocery',
        // Phase 61: can customers browse / order this category?
        customerOrderingEnabled: !!r.customer_ordering_enabled,
        minCustomerAge: r.min_customer_age != null ? Number(r.min_customer_age) : null,
        complianceNote: r.compliance_note || null,
        orderingChangedAt: r.ordering_changed_at || null,
        allowedVehicles: allowedVehiclesFor(r.key),
        // Switching customer ordering ON needs security.settings + a legal reference
        canEnableOrdering: hasPermission(req, 'security.settings'),
      })),
    });
  } catch (error) {
    console.error('❌ ADMIN BUSINESS TYPES ERROR:', error.message);
    return fail(res, 500, 'Unable to load business types');
  }
};

const updateBusinessType = async (req, res) => {
  try {
    const key = req.params.key;
    if (!BUSINESS_TYPES.includes(key)) return fail(res, 404, 'Unknown business type', 'NOT_FOUND');
    const current = (await pool.query('SELECT * FROM business_types WHERE key = $1', [key])).rows[0];
    const commission = req.body?.commissionPercent === undefined ? Number(current.commission_percent) : Number(req.body.commissionPercent);
    const windowDays = req.body?.returnWindowDays === undefined ? Number(current.return_window_days) : Number(req.body.returnWindowDays);
    const active = req.body?.isActive === undefined ? current.is_active : bool(req.body.isActive);
    if (!Number.isFinite(commission) || commission < 0 || commission > 50) return fail(res, 400, 'Commission must be 0 to 50%', 'VALIDATION');
    if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > 60) return fail(res, 400, 'Return window must be 0 to 60 days', 'VALIDATION');
    if (key === 'grocery' && !active) return fail(res, 400, 'Grocery shops cannot be switched off', 'VALIDATION');

    // Phase 61: customer ordering for a category (liquor starts OFF).
    // Turning it ON is a legal decision: security.settings permission
    // and a written approval reference are required, and it is audited.
    let ordering = current.customer_ordering_enabled;
    let note = current.compliance_note;
    let orderingChanged = false;
    if (req.body?.customerOrderingEnabled !== undefined) {
      const wanted = bool(req.body.customerOrderingEnabled);
      if (wanted !== current.customer_ordering_enabled) {
        if (key === 'grocery' && !wanted) return fail(res, 400, 'Grocery ordering cannot be switched off here', 'VALIDATION');
        if (wanted) {
          if (!hasPermission(req, 'security.settings')) {
            return fail(res, 403, 'Only an owner / super admin can open a category to customers', 'FORBIDDEN');
          }
          const reference = text(req.body?.legalReference, 600);
          if (current.min_customer_age && (!reference || reference.length < 15)) {
            return fail(res, 400, 'Enter the legal approval you are relying on (licence / ruling / legal advice reference, at least 15 characters)', 'LEGAL_REFERENCE_REQUIRED');
          }
          if (reference) note = `Opened ${new Date().toISOString().slice(0, 10)}: ${reference}`.slice(0, 600);
        }
        ordering = wanted;
        orderingChanged = true;
      }
    }

    await pool.query(
      `UPDATE business_types SET commission_percent = $2, return_window_days = $3, is_active = $4,
              customer_ordering_enabled = $5, compliance_note = $6,
              ordering_changed_at = CASE WHEN $7 THEN NOW() ELSE ordering_changed_at END,
              ordering_changed_by = CASE WHEN $7 THEN $8 ELSE ordering_changed_by END,
              updated_at = NOW() WHERE key = $1`,
      [key, round2(commission), windowDays, active, ordering, note, orderingChanged, Number(req.admin?.adminId || req.admin?.id) || null]
    );
    clearTypeCache();
    if (orderingChanged) {
      req.app.get('io')?.to('customers').emit('marketplace-categories-updated', { key, customerOrderingEnabled: ordering, at: Date.now() });
    }
    return listBusinessTypes(req, res);
  } catch (error) {
    console.error('❌ ADMIN UPDATE BUSINESS TYPE ERROR:', error.message);
    return fail(res, 500, 'Unable to save the business type');
  }
};

const listCategories = async (req, res) => {
  try {
    const type = BUSINESS_TYPES.includes(req.query.type) ? req.query.type : null;
    const rows = (
      await pool.query(
        'SELECT * FROM marketplace_categories WHERE ($1::text IS NULL OR business_type = $1) ORDER BY business_type, sort, name',
        [type]
      )
    ).rows;
    const toCat = (r) => ({ id: Number(r.id), businessType: r.business_type, parentId: num(r.parent_id), name: r.name, sort: Number(r.sort), isActive: !!r.is_active });
    const parents = rows.filter((r) => !r.parent_id);
    return res.json({
      success: true,
      categories: parents.map((p) => ({ ...toCat(p), subcategories: rows.filter((r) => Number(r.parent_id) === Number(p.id)).map(toCat) })),
    });
  } catch (error) {
    console.error('❌ ADMIN CATEGORIES ERROR:', error.message);
    return fail(res, 500, 'Unable to load categories');
  }
};

const createCategory = async (req, res) => {
  try {
    const type = req.body?.businessType;
    const name = text(req.body?.name, 60);
    const parentId = toId(req.body?.parentId);
    if (!BUSINESS_TYPES.includes(type)) return fail(res, 400, 'Choose a business type', 'VALIDATION');
    if (!name) return fail(res, 400, 'Enter a category name', 'VALIDATION');
    if (parentId) {
      const parent = (await pool.query('SELECT * FROM marketplace_categories WHERE id = $1', [parentId])).rows[0];
      if (!parent || parent.business_type !== type || parent.parent_id) return fail(res, 400, 'Choose a top-level category of the same business type', 'VALIDATION');
    }
    const row = (
      await pool.query(
        `INSERT INTO marketplace_categories (business_type, parent_id, name, sort)
         VALUES ($1::varchar, $2::int, $3::varchar, COALESCE((SELECT MAX(sort) + 1 FROM marketplace_categories WHERE business_type = $1::varchar AND COALESCE(parent_id, 0) = COALESCE($2::int, 0)), 0))
         RETURNING *`,
        [type, parentId, name]
      )
    ).rows[0];
    return res.status(201).json({ success: true, category: { id: Number(row.id), businessType: row.business_type, parentId: num(row.parent_id), name: row.name, sort: Number(row.sort), isActive: true } });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'That category already exists', 'DUPLICATE');
    console.error('❌ ADMIN CREATE CATEGORY ERROR:', error.message);
    return fail(res, 500, 'Unable to add the category');
  }
};

const updateCategory = async (req, res) => {
  try {
    const current = (await pool.query('SELECT * FROM marketplace_categories WHERE id = $1', [toId(req.params.id)])).rows[0];
    if (!current) return fail(res, 404, 'Category not found', 'NOT_FOUND');
    const name = req.body?.name === undefined ? current.name : text(req.body.name, 60);
    if (!name) return fail(res, 400, 'Enter a category name', 'VALIDATION');
    const sort = req.body?.sort === undefined ? current.sort : Number(req.body.sort);
    if (!Number.isInteger(sort) || sort < 0 || sort > 10000) return fail(res, 400, 'Enter a valid order number', 'VALIDATION');
    const row = (
      await pool.query(
        'UPDATE marketplace_categories SET name = $2, is_active = $3, sort = $4 WHERE id = $1 RETURNING *',
        [current.id, name, req.body?.isActive === undefined ? current.is_active : bool(req.body.isActive), sort]
      )
    ).rows[0];
    return res.json({ success: true, category: { id: Number(row.id), businessType: row.business_type, parentId: num(row.parent_id), name: row.name, sort: Number(row.sort), isActive: !!row.is_active } });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'That category already exists', 'DUPLICATE');
    console.error('❌ ADMIN UPDATE CATEGORY ERROR:', error.message);
    return fail(res, 500, 'Unable to save the category');
  }
};

const toDocType = (r) => ({
  id: Number(r.id), businessType: r.business_type, docKey: r.doc_key, label: r.label, description: r.description || null,
  required: !!r.required, isActive: !!r.is_active, sort: Number(r.sort),
});

const listDocumentTypes = async (req, res) => {
  try {
    const type = BUSINESS_TYPES.includes(req.query.type) ? req.query.type : null;
    const rows = (await pool.query('SELECT * FROM business_document_types WHERE ($1::text IS NULL OR business_type = $1) ORDER BY business_type, sort, id', [type])).rows;
    return res.json({ success: true, documentTypes: rows.map(toDocType) });
  } catch (error) {
    console.error('❌ ADMIN DOC TYPES ERROR:', error.message);
    return fail(res, 500, 'Unable to load document types');
  }
};

const createDocumentType = async (req, res) => {
  try {
    const type = req.body?.businessType;
    const label = text(req.body?.label, 100);
    const key = String(req.body?.docKey || label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    if (!BUSINESS_TYPES.includes(type)) return fail(res, 400, 'Choose a business type', 'VALIDATION');
    if (!label) return fail(res, 400, 'Enter the document name', 'VALIDATION');
    if (!key) return fail(res, 400, 'Enter a document key', 'VALIDATION');
    const row = (
      await pool.query(
        `INSERT INTO business_document_types (business_type, doc_key, label, description, required, sort)
         VALUES ($1::varchar, $2, $3, $4, $5, COALESCE((SELECT MAX(sort) + 1 FROM business_document_types WHERE business_type = $1::varchar), 1)) RETURNING *`,
        [type, key, label, text(req.body?.description, 300), bool(req.body?.required, true)]
      )
    ).rows[0];
    return res.status(201).json({ success: true, documentType: toDocType(row) });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'That document already exists for this business type', 'DUPLICATE');
    console.error('❌ ADMIN CREATE DOC TYPE ERROR:', error.message);
    return fail(res, 500, 'Unable to add the document type');
  }
};

const updateDocumentType = async (req, res) => {
  try {
    const current = (await pool.query('SELECT * FROM business_document_types WHERE id = $1', [toId(req.params.id)])).rows[0];
    if (!current) return fail(res, 404, 'Document type not found', 'NOT_FOUND');
    const label = req.body?.label === undefined ? current.label : text(req.body.label, 100);
    if (!label) return fail(res, 400, 'Enter the document name', 'VALIDATION');
    const row = (
      await pool.query(
        'UPDATE business_document_types SET label = $2, description = $3, required = $4, is_active = $5 WHERE id = $1 RETURNING *',
        [
          current.id,
          label,
          req.body?.description === undefined ? current.description : text(req.body.description, 300),
          req.body?.required === undefined ? current.required : bool(req.body.required),
          req.body?.isActive === undefined ? current.is_active : bool(req.body.isActive),
        ]
      )
    ).rows[0];
    return res.json({ success: true, documentType: toDocType(row) });
  } catch (error) {
    console.error('❌ ADMIN UPDATE DOC TYPE ERROR:', error.message);
    return fail(res, 500, 'Unable to save the document type');
  }
};

// -----------------------------------------------------
// Products (clothing variants / restaurant menus)
// -----------------------------------------------------

const listProducts = async (req, res) => {
  try {
    const type = MERCHANT_TYPES.includes(req.query.type) ? req.query.type : null;
    const shopId = toId(req.query.shopId);
    const search = text(req.query.search, 60);
    const page = Math.max(1, Number(req.query.page) || 1);
    const params = [MERCHANT_TYPES];
    const where = ['s.business_type = ANY($1)'];
    if (type) { params.push(type); where.push(`s.business_type = $${params.length}`); }
    if (shopId) { params.push(shopId); where.push(`p.shop_id = $${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`(p.product_name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`); }
    const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM products p JOIN shops s ON s.id = p.shop_id WHERE ${where.join(' AND ')}`, params)).rows[0].n);
    const rows = (
      await pool.query(
        `SELECT p.*, s.shop_name, s.business_type,
                (SELECT COUNT(*)::int FROM product_variants v WHERE v.product_id = p.id) AS variant_count,
                (SELECT COUNT(*)::int FROM product_option_groups g WHERE g.product_id = p.id) AS group_count
         FROM products p JOIN shops s ON s.id = p.shop_id
         WHERE ${where.join(' AND ')}
         ORDER BY p.updated_at DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`,
        params
      )
    ).rows;
    return res.json({
      success: true,
      page, pageSize: PAGE, total,
      products: rows.map((p) => ({
        id: Number(p.id), shopId: Number(p.shop_id), shopName: p.shop_name, businessType: p.business_type,
        name: p.product_name, category: p.category, subcategory: p.subcategory || null,
        price: round2(p.price), discountPrice: p.discount_price != null ? round2(p.discount_price) : null,
        imageUrl: p.image_url || null, isAvailable: !!p.is_available, isFeatured: !!p.is_featured,
        stockTotal: Number(p.stock_quantity) || 0, variantCount: Number(p.variant_count), optionGroupCount: Number(p.group_count),
        updatedAt: p.updated_at,
      })),
    });
  } catch (error) {
    console.error('❌ ADMIN MARKETPLACE PRODUCTS ERROR:', error.message);
    return fail(res, 500, 'Unable to load products');
  }
};

const getProduct = async (req, res) => {
  try {
    const row = (await pool.query('SELECT p.*, s.shop_name, s.business_type FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = $1', [toId(req.params.id)])).rows[0];
    if (!row) return fail(res, 404, 'Product not found', 'NOT_FOUND');
    const view = toProduct(row, await loadProductExtras([row.id]), { business_type: row.business_type }, { forMerchant: true });
    return res.json({ success: true, product: { ...view, shopName: row.shop_name } });
  } catch (error) {
    console.error('❌ ADMIN MARKETPLACE PRODUCT ERROR:', error.message);
    return fail(res, 500, 'Unable to load the product');
  }
};

const patchProduct = async (req, res) => {
  try {
    if (typeof req.body?.isAvailable !== 'boolean') return fail(res, 400, 'Send isAvailable true or false', 'VALIDATION');
    const row = (
      await pool.query('UPDATE products SET is_available = $2, updated_at = NOW() WHERE id = $1 RETURNING id, shop_id', [toId(req.params.id), req.body.isAvailable])
    ).rows[0];
    if (!row) return fail(res, 404, 'Product not found', 'NOT_FOUND');
    require('../realtime').broadcastCatalogChange(req.app.get('io'), row.shop_id, 'products');
    return res.json({ success: true });
  } catch (error) {
    console.error('❌ ADMIN MARKETPLACE PRODUCT PATCH ERROR:', error.message);
    return fail(res, 500, 'Unable to update the product');
  }
};

// -----------------------------------------------------
// Merchant orders, returns
// -----------------------------------------------------

const listOrders = async (req, res) => {
  try {
    const params = [];
    const where = ["o.business_type <> 'grocery'"];
    const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
    if (MERCHANT_TYPES.includes(req.query.type)) add('o.business_type = ?', req.query.type);
    if (req.query.merchantStatus) add('o.merchant_status = ?', String(req.query.merchantStatus));
    if (toId(req.query.shopId)) add('o.shop_id = ?', toId(req.query.shopId));
    // Phase 61: delivery management
    if (['delivery', 'pickup', 'shop_delivery'].includes(req.query.fulfilment)) add('o.fulfilment_method = ?', req.query.fulfilment);
    if (req.query.view === 'in_delivery') {
      where.push("o.status IN ('waiting_for_shopper', 'shopper_accepted', 'out_for_delivery', 'arrived', 'shop_shipping', 'awaiting_pickup')");
    } else if (req.query.view === 'needs_rider') {
      where.push("o.status = 'waiting_for_shopper' AND o.shopper_id IS NULL");
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) add("o.created_at >= (?::date AT TIME ZONE 'Asia/Colombo')", req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) add("o.created_at < ((?::date + 1) AT TIME ZONE 'Asia/Colombo')", req.query.to);
    const page = Math.max(1, Number(req.query.page) || 1);
    const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM orders o WHERE ${where.join(' AND ')}`, params)).rows[0].n);
    const rows = (
      await pool.query(
        `SELECT o.id, o.created_at, o.business_type, o.fulfilment_method, o.status, o.merchant_status, o.total_amount, o.items_total,
                o.payment_method, o.payment_status, o.shop_id, s.shop_name, c.full_name AS customer_name, o.merchant_accepted_at, o.merchant_ready_at,
                o.commission_amount, o.shopper_id, o.preferred_vehicle_type, o.courier_name, o.tracking_number, o.delivery_district,
                o.ship_min_days, o.ship_max_days, o.merchant_shipped_at, o.out_for_delivery_at, o.delivered_at, o.min_customer_age,
                sh.full_name AS shopper_name, sh.vehicle_type AS shopper_vehicle
         FROM orders o JOIN shops s ON s.id = o.shop_id LEFT JOIN customers c ON c.id = o.customer_id
         LEFT JOIN shoppers sh ON sh.id = o.shopper_id
         WHERE ${where.join(' AND ')}
         ORDER BY o.created_at DESC LIMIT ${PAGE} OFFSET ${(page - 1) * PAGE}`,
        params
      )
    ).rows;
    return res.json({
      success: true, page, pageSize: PAGE, total,
      orders: rows.map((o) => ({
        id: Number(o.id), createdAt: o.created_at, businessType: o.business_type, fulfilment: o.fulfilment_method,
        status: o.status, merchantStatus: o.merchant_status, stage: stageOf(o), stageLabel: stageLabelOf(o),
        totalAmount: round2(o.total_amount), itemsTotal: round2(o.items_total), commissionAmount: round2(o.commission_amount),
        paymentMethod: o.payment_method, paymentStatus: o.payment_status || null,
        shopId: Number(o.shop_id), shopName: o.shop_name, customerName: o.customer_name || null,
        prepMinutesActual: o.merchant_ready_at && o.merchant_accepted_at ? Math.round((new Date(o.merchant_ready_at) - new Date(o.merchant_accepted_at)) / 60000) : null,
        // Phase 61: delivery management
        delivery: {
          method: o.fulfilment_method,
          allowedVehicles: o.fulfilment_method === 'delivery' ? allowedVehiclesFor(o.business_type) : null,
          rider: o.shopper_id ? { id: Number(o.shopper_id), name: o.shopper_name || null, vehicleType: o.shopper_vehicle || null } : null,
          courierName: o.courier_name || null,
          trackingNumber: o.tracking_number || null,
          district: o.delivery_district || null,
          shipDays: o.ship_min_days != null ? { min: Number(o.ship_min_days), max: Number(o.ship_max_days) } : null,
          shippedAt: o.merchant_shipped_at || null,
          outForDeliveryAt: o.out_for_delivery_at || null,
          deliveredAt: o.delivered_at || null,
        },
        ageCheckMinAge: o.min_customer_age != null ? Number(o.min_customer_age) : null,
      })),
    });
  } catch (error) {
    console.error('❌ ADMIN MERCHANT ORDERS ERROR:', error.message);
    return fail(res, 500, 'Unable to load merchant orders');
  }
};

const listReturns = async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    const shopId = toId(req.query.shopId);
    const rows = (
      await pool.query(
        `SELECT r.*, oi.item_name, oi.variant_label, s.shop_name, c.full_name AS customer_name, o.payment_method
         FROM merchant_return_requests r
         JOIN order_items oi ON oi.id = r.order_item_id
         JOIN shops s ON s.id = r.shop_id
         JOIN orders o ON o.id = r.order_id
         LEFT JOIN customers c ON c.id = r.customer_id
         WHERE ($1::text IS NULL OR r.status = $1) AND ($2::int IS NULL OR r.shop_id = $2)
         ORDER BY r.id DESC LIMIT 300`,
        [status, shopId]
      )
    ).rows;
    return res.json({
      success: true,
      returns: rows.map((r) => ({
        id: Number(r.id), orderId: Number(r.order_id), orderItemId: Number(r.order_item_id), shopId: Number(r.shop_id), shopName: r.shop_name,
        customerName: r.customer_name || null, itemName: r.item_name, variantLabel: r.variant_label || null, quantity: Number(r.quantity),
        reasonCode: r.reason_code, reasonText: r.reason_text || null, photoUrls: Array.isArray(r.photo_urls) ? r.photo_urls : [],
        status: r.status, merchantNote: r.merchant_note || null, refundAmount: num(r.refund_amount), refundMethod: r.refund_method || null,
        refundReference: r.refund_reference || null, paymentMethod: r.payment_method,
        createdAt: r.created_at, decidedAt: r.decided_at, receivedAt: r.received_at, refundedAt: r.refunded_at,
      })),
    });
  } catch (error) {
    console.error('❌ ADMIN RETURNS ERROR:', error.message);
    return fail(res, 500, 'Unable to load returns');
  }
};

const actOnReturn = async (req, res) => {
  if (req.body?.action !== 'refunded') return fail(res, 400, "Only 'refunded' can be recorded here", 'VALIDATION');
  const result = await recordManualRefund({
    returnId: toId(req.params.id),
    method: req.body?.method,
    reference: req.body?.reference,
    adminId: adminIdOf(req),
    io: req.app.get('io'),
  });
  if (result.error) return fail(res, result.error[0], result.error[1]);
  return res.json({ success: true, returnRequest: result.returnRequest });
};

// -----------------------------------------------------
// Business payments (merchant settlements)
// -----------------------------------------------------

const listSettlements = async (req, res) => {
  try {
    const status = req.query.status;
    const shopId = toId(req.query.shopId);
    const params = [];
    const where = ['TRUE'];
    if (shopId) { params.push(shopId); where.push(`ms.shop_id = $${params.length}`); }
    if (status === 'payable') where.push("ms.status = 'pending' AND ms.payable_after <= NOW()");
    else if (status === 'pending') where.push("ms.status = 'pending' AND ms.payable_after > NOW()");
    else if (['paid', 'held'].includes(status)) { params.push(status); where.push(`ms.status = $${params.length}`); }
    const rows = (
      await pool.query(
        `SELECT ms.*, s.shop_name, (SELECT bank_name || ' ' || right(account_number, 4) FROM shop_bank_accounts b WHERE b.shop_id = ms.shop_id) AS bank,
                (SELECT verified_at IS NOT NULL FROM shop_bank_accounts b WHERE b.shop_id = ms.shop_id) AS bank_verified
         FROM merchant_settlements ms JOIN shops s ON s.id = ms.shop_id
         WHERE ${where.join(' AND ')} ORDER BY ms.id DESC LIMIT 500`,
        params
      )
    ).rows;
    const all = (await pool.query(`SELECT ms.* FROM merchant_settlements ms ${shopId ? 'WHERE ms.shop_id = $1' : ''}`, shopId ? [shopId] : [])).rows;
    return res.json({
      success: true,
      settlements: rows.map((r) => ({ ...toSettlement(r), bank: r.bank || null, bankVerified: !!r.bank_verified })),
      totals: totalsOf(all),
    });
  } catch (error) {
    console.error('❌ ADMIN SETTLEMENTS ERROR:', error.message);
    return fail(res, 500, 'Unable to load business payments');
  }
};

const paySettlements = async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(toId).filter(Boolean))] : [];
  const reference = text(req.body?.reference, 120);
  if (!ids.length) return fail(res, 400, 'Choose at least one payment', 'VALIDATION');
  if (!reference) return fail(res, 400, 'Enter the bank transfer reference', 'VALIDATION');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = (await client.query('SELECT * FROM merchant_settlements WHERE id = ANY($1) FOR UPDATE', [ids])).rows;
    const notPayable = rows.filter((r) => !(r.status === 'pending' && new Date(r.payable_after) <= new Date()) || r.cash_collected_by === 'merchant');
    if (rows.length !== ids.length || notPayable.length) {
      await client.query('ROLLBACK');
      return fail(res, 409, 'Only payable settlements can be paid (not pending, held, paid, or store-collected cash).', 'NOT_PAYABLE');
    }
    await client.query(
      `UPDATE merchant_settlements SET status = 'paid', paid_at = NOW(), paid_reference = $2, paid_by_admin_id = $3, updated_at = NOW() WHERE id = ANY($1)`,
      [ids, reference, adminIdOf(req)]
    );
    await client.query('COMMIT');
    const shops = [...new Set(rows.map((r) => Number(r.shop_id)))];
    shops.forEach((shopId) => req.app.get('io')?.to(`shop:${shopId}`).emit('shop:settlements-updated', { reason: 'paid' }));
    return res.json({ success: true, paid: ids.length, total: round2(rows.reduce((sum, r) => sum + Number(r.net_amount), 0)) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ ADMIN PAY SETTLEMENTS ERROR:', error.message);
    return fail(res, 500, 'Unable to record the payment');
  } finally {
    client.release();
  }
};

const holdSettlement = async (req, res) => {
  const reason = text(req.body?.reason, 300);
  if (!reason) return fail(res, 400, 'Enter why the payment is held', 'VALIDATION');
  const row = (
    await pool.query(
      `UPDATE merchant_settlements SET status = 'held', hold_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING *`,
      [toId(req.params.id), reason]
    )
  ).rows[0];
  if (!row) return fail(res, 409, 'Only unpaid settlements can be held', 'ORDER_STATE');
  return res.json({ success: true, settlement: toSettlement(row) });
};

const releaseSettlement = async (req, res) => {
  const row = (
    await pool.query(
      `UPDATE merchant_settlements SET status = 'pending', hold_reason = NULL, updated_at = NOW() WHERE id = $1 AND status = 'held' RETURNING *`,
      [toId(req.params.id)]
    )
  ).rows[0];
  if (!row) return fail(res, 409, 'Only held settlements can be released', 'ORDER_STATE');
  return res.json({ success: true, settlement: toSettlement(row) });
};

// -----------------------------------------------------
// Reports
// -----------------------------------------------------

const reports = async (req, res) => {
  try {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to : null;
    const type = BUSINESS_TYPES.includes(req.query.type) ? req.query.type : null;
    const params = [from, to, type];
    const range = `($1::date IS NULL OR o.created_at >= ($1::date AT TIME ZONE 'Asia/Colombo'))
                   AND ($2::date IS NULL OR o.created_at < (($2::date + 1) AT TIME ZONE 'Asia/Colombo'))
                   AND ($3::text IS NULL OR o.business_type = $3)
                   AND o.status NOT IN ('pending_shopper_search', 'shopper_search_cancelled')`;
    const byType = (
      await pool.query(
        `SELECT o.business_type AS type, COUNT(*)::int AS orders,
                COUNT(*) FILTER (WHERE o.status = 'delivered')::int AS completed,
                COUNT(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
                COALESCE(SUM(o.items_total) FILTER (WHERE o.status = 'delivered'), 0)::float AS gross,
                COALESCE(SUM(CASE WHEN o.business_type = 'grocery' THEN COALESCE(o.getme_fee_kept, o.getme_fee) ELSE o.commission_amount END)
                         FILTER (WHERE o.status = 'delivered'), 0)::float AS commission
         FROM orders o WHERE ${range} GROUP BY o.business_type ORDER BY o.business_type`,
        params
      )
    ).rows;
    const top = (
      await pool.query(
        `SELECT o.shop_id, s.shop_name, o.business_type AS type, COUNT(*)::int AS orders,
                COALESCE(SUM(o.items_total) FILTER (WHERE o.status = 'delivered'), 0)::float AS gross,
                COALESCE(SUM(o.commission_amount) FILTER (WHERE o.status = 'delivered'), 0)::float AS commission,
                AVG(EXTRACT(EPOCH FROM (o.merchant_ready_at - o.merchant_accepted_at)) / 60)
                  FILTER (WHERE o.merchant_ready_at IS NOT NULL AND o.merchant_accepted_at IS NOT NULL)::float AS avg_prep
         FROM orders o JOIN shops s ON s.id = o.shop_id
         WHERE ${range}
         GROUP BY o.shop_id, s.shop_name, o.business_type ORDER BY gross DESC LIMIT 20`,
        params
      )
    ).rows;
    return res.json({
      success: true,
      byType: byType.map((r) => ({ type: r.type, orders: r.orders, completed: r.completed, cancelled: r.cancelled, gross: round2(r.gross), commission: round2(r.commission) })),
      topShops: top.map((r) => ({
        shopId: Number(r.shop_id), shopName: r.shop_name, type: r.type, orders: r.orders, gross: round2(r.gross),
        commission: round2(r.commission), avgPrepMinutes: r.avg_prep != null ? Math.round(r.avg_prep) : null,
      })),
    });
  } catch (error) {
    console.error('❌ ADMIN MARKETPLACE REPORTS ERROR:', error.message);
    return fail(res, 500, 'Unable to load the report');
  }
};

module.exports = {
  getBusiness,
  getDocumentFile,
  reviewDocument,
  verifyBankAccount,
  listBusinessTypes,
  updateBusinessType,
  listCategories,
  createCategory,
  updateCategory,
  listDocumentTypes,
  createDocumentType,
  updateDocumentType,
  listProducts,
  getProduct,
  patchProduct,
  listOrders,
  listReturns,
  actOnReturn,
  listSettlements,
  paySettlements,
  holdSettlement,
  releaseSettlement,
  reports,
};
