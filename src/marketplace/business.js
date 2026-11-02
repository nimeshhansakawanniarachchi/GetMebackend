// =====================================================
// PHASE 59: BUSINESS PROFILE, DOCUMENTS, BRANCHES, OPERATIONS
// Shop portal (/api/shop/...) for every business type.
//   GET  /register/options             (public)
//   GET/PUT /business, PUT /business/cover
//   POST/GET/DELETE /business/documents...   (private files)
//   PUT  /business/bank-account, POST /business/submit
//   GET/POST /branches, POST /branches/:id/switch
//   GET/PUT /operations, POST /operations/pause|resume
// Registration documents are stored in private-uploads/ and only
// streamed to the shop's owner or an admin with shops.manage.
// =====================================================

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const {
  pool,
  PROVINCES,
  BUSINESS_TYPES,
  fail,
  text,
  bool,
  toId,
  typeLabel,
  validProvince,
  normalizeSpecialHours,
  activeMerchantOrders,
  num,
} = require('./common');
const { normalizeSriLankanPhone } = require('../utils/phone');
const { normalizeHours } = require('../utils/shopHours');
const { recordShopActivity } = require('../middleware/shopAccess');
const { emitToAdmins, broadcastCatalogChange } = require('../realtime');

const DOCS_DIR = path.join(__dirname, '..', '..', 'private-uploads', 'business-documents');
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const actorOf = (req) => ({
  type: req.shop.staffId ? 'staff' : 'owner',
  id: req.shop.staffId || req.shop.shopId,
  name: req.shop.actorName || null,
  role: req.shop.role,
});

const log = (req, action, summary, entityType = 'shop', entityId = req.shop.shopId) =>
  recordShopActivity({ shopId: req.shop.shopId, actor: actorOf(req), action, entityType, entityId, summary });

const maskAccount = (number) => {
  const digits = String(number || '');
  return digits.length <= 4 ? digits : `${'•'.repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}`;
};

// -----------------------------------------------------
// Registration options (public)
// -----------------------------------------------------

const registerOptions = async (req, res) => {
  try {
    const [types, docs] = await Promise.all([
      pool.query('SELECT key, label, description FROM business_types WHERE is_active ORDER BY sort'),
      pool.query('SELECT business_type, doc_key, label, description, required FROM business_document_types WHERE is_active ORDER BY sort, id'),
    ]);
    const documentTypes = {};
    for (const type of BUSINESS_TYPES) documentTypes[type] = [];
    for (const row of docs.rows) {
      (documentTypes[row.business_type] = documentTypes[row.business_type] || []).push({
        docKey: row.doc_key, label: row.label, description: row.description || null, required: !!row.required,
      });
    }
    return res.json({
      success: true,
      businessTypes: types.rows.map((t) => ({ key: t.key, label: t.label, description: t.description || null })),
      documentTypes,
      provinces: PROVINCES,
    });
  } catch (error) {
    console.error('❌ REGISTER OPTIONS ERROR:', error.message);
    return fail(res, 500, "Couldn't load the registration options.");
  }
};

// -----------------------------------------------------
// Business profile
// -----------------------------------------------------

const documentsFor = async (shop, client = pool) => {
  const [types, uploads] = await Promise.all([
    client.query(
      'SELECT doc_key, label, description, required FROM business_document_types WHERE business_type = $1 AND is_active ORDER BY sort, id',
      [shop.business_type]
    ),
    client.query('SELECT DISTINCT ON (doc_key) * FROM shop_documents WHERE shop_id = $1 ORDER BY doc_key, id DESC', [shop.id]),
  ]);
  const byKey = new Map(uploads.rows.map((row) => [row.doc_key, row]));
  return types.rows.map((t) => {
    const up = byKey.get(t.doc_key);
    return {
      docKey: t.doc_key,
      label: t.label,
      description: t.description || null,
      required: !!t.required,
      uploaded: up
        ? { id: Number(up.id), originalName: up.original_name || up.file_name, mimeType: up.mime_type, sizeBytes: num(up.size_bytes), status: up.status, reviewNote: up.review_note || null, uploadedAt: up.uploaded_at }
        : null,
    };
  });
};

const operationsOf = async (shop) => ({
  isOpen: !!shop.is_open,
  autoOpen: !!shop.auto_open,
  openingHours: shop.opening_hours || null,
  specialHours: Array.isArray(shop.special_hours) ? shop.special_hours : [],
  defaultPrepMinutes: Number(shop.default_prep_minutes) || 20,
  maxActiveOrders: shop.max_active_orders != null ? Number(shop.max_active_orders) : null,
  ordersPaused: !!(shop.orders_paused_until && new Date(shop.orders_paused_until) > new Date()),
  pausedUntil: shop.orders_paused_until && new Date(shop.orders_paused_until) > new Date() ? shop.orders_paused_until : null,
  activeOrders: await activeMerchantOrders(shop.id),
  offersDelivery: shop.offers_delivery !== false,
  offersPickup: !!shop.offers_pickup,
});

const businessView = async (shop, { fullAccount = false } = {}) => {
  const [documents, bank] = await Promise.all([
    documentsFor(shop),
    pool.query('SELECT * FROM shop_bank_accounts WHERE shop_id = $1', [shop.id]),
  ]);
  const b = bank.rows[0];
  const missing = documents.filter((d) => d.required && (!d.uploaded || d.uploaded.status === 'rejected')).map((d) => d.docKey);
  return {
    id: Number(shop.id),
    shopName: shop.shop_name,
    businessType: shop.business_type,
    businessTypeLabel: typeLabel(shop.business_type),
    status: shop.status,
    statusReason: shop.status_reason || null,
    submittedAt: shop.submitted_at || null,
    reviewedAt: shop.reviewed_at || null,
    ownerName: shop.owner_name || null,
    email: shop.email,
    mobile: shop.mobile || null,
    contactPhone: shop.contact_phone || null,
    contactEmail: shop.contact_email || null,
    address: shop.address || null,
    latitude: num(shop.latitude),
    longitude: num(shop.longitude),
    province: shop.province || null,
    district: shop.district || null,
    city: shop.city || shop.area || null,
    businessRegNo: shop.business_reg_no || null,
    description: shop.description || null,
    logoUrl: shop.image_url || null,
    coverUrl: shop.cover_url || null,
    offersDelivery: shop.offers_delivery !== false,
    offersPickup: !!shop.offers_pickup,
    openingHours: shop.opening_hours || null,
    autoOpen: !!shop.auto_open,
    isOpen: !!shop.is_open,
    parentShopId: num(shop.parent_shop_id),
    isBranch: shop.parent_shop_id != null,
    documents,
    missingDocuments: missing,
    bankAccount: b
      ? {
          bankName: b.bank_name,
          branchName: b.branch_name || null,
          accountName: b.account_name,
          accountNumberMasked: maskAccount(b.account_number),
          ...(fullAccount ? { accountNumber: b.account_number } : {}),
          verified: !!b.verified_at,
          verifiedAt: b.verified_at || null,
        }
      : null,
    canSubmit: ['pending', 'rejected'].includes(shop.status) && missing.length === 0 && shop.latitude != null,
    operations: await operationsOf(shop),
    // Phase 60: store-managed delivery (districts, fees, days)
    shopDelivery: await (async () => {
      const { districts, ...view } = await require('./shopDelivery').viewOf(shop.id);
      return view;
    })(),
  };
};

const loadShop = async (shopId, client = pool) =>
  (await client.query('SELECT * FROM shops WHERE id = $1', [shopId])).rows[0] || null;

const getBusiness = async (req, res) => {
  try {
    const shop = await loadShop(req.shop.shopId);
    if (!shop) return fail(res, 404, 'Shop not found');
    return res.json({ success: true, business: await businessView(shop) });
  } catch (error) {
    console.error('❌ GET BUSINESS ERROR:', error.message);
    return fail(res, 500, "Couldn't load your business details.");
  }
};

const putBusiness = async (req, res) => {
  try {
    const body = req.body || {};
    const shop = await loadShop(req.shop.shopId);
    if (!shop) return fail(res, 404, 'Shop not found');

    const place = validProvince(text(body.province, 40) ?? shop.province, text(body.district, 40) ?? shop.district);
    if (place.error) return fail(res, 400, place.error, 'VALIDATION');

    let contactPhone = shop.contact_phone;
    if (body.contactPhone !== undefined) {
      contactPhone = text(body.contactPhone, 20) ? normalizeSriLankanPhone(body.contactPhone) : null;
      if (text(body.contactPhone, 20) && !contactPhone) return fail(res, 400, 'Enter a valid contact phone number', 'VALIDATION');
    }
    let contactEmail = shop.contact_email;
    if (body.contactEmail !== undefined) {
      contactEmail = text(body.contactEmail, 150);
      if (contactEmail && !EMAIL_PATTERN.test(contactEmail)) return fail(res, 400, 'Enter a valid contact email', 'VALIDATION');
    }
    const offersDelivery = body.offersDelivery === undefined ? shop.offers_delivery : bool(body.offersDelivery);
    const offersPickup = body.offersPickup === undefined ? shop.offers_pickup : bool(body.offersPickup);
    if (!offersDelivery && !offersPickup) return fail(res, 400, 'Offer delivery, pickup or both', 'VALIDATION');

    const ownerName = body.ownerName === undefined ? shop.owner_name : text(body.ownerName, 120);
    if (shop.business_type !== 'grocery' && (!ownerName || ownerName.length < 3)) {
      return fail(res, 400, "Enter the owner's full name", 'VALIDATION');
    }

    const updated = (
      await pool.query(
        `UPDATE shops SET owner_name = $2, description = $3, province = $4, district = $5, city = $6,
                business_reg_no = $7, contact_phone = $8, contact_email = $9, offers_delivery = $10, offers_pickup = $11,
                updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [
          shop.id,
          ownerName,
          body.description === undefined ? shop.description : text(body.description, 600),
          place.province,
          place.district,
          body.city === undefined ? shop.city : text(body.city, 80),
          body.businessRegNo === undefined ? shop.business_reg_no : text(body.businessRegNo, 40),
          contactPhone,
          contactEmail,
          offersDelivery,
          offersPickup,
        ]
      )
    ).rows[0];
    log(req, 'business.updated', 'Updated business details');
    broadcastCatalogChange(req.app.get('io'), shop.id, 'shop');
    return res.json({ success: true, business: await businessView(updated) });
  } catch (error) {
    console.error('❌ PUT BUSINESS ERROR:', error.message);
    return fail(res, 500, "Couldn't save your business details.");
  }
};

const putCover = async (req, res) => {
  try {
    if (!req.file) return fail(res, 400, 'Choose a cover photo', 'VALIDATION');
    const url = `/uploads/shops/${path.basename(req.file.filename)}`;
    await pool.query('UPDATE shops SET cover_url = $2, updated_at = NOW() WHERE id = $1', [req.shop.shopId, url]);
    log(req, 'business.cover', 'Changed the cover photo');
    broadcastCatalogChange(req.app.get('io'), req.shop.shopId, 'shop');
    return res.json({ success: true, coverUrl: url });
  } catch (error) {
    console.error('❌ COVER ERROR:', error.message);
    return fail(res, 500, "Couldn't save the cover photo.");
  }
};

// -----------------------------------------------------
// Documents (private)
// -----------------------------------------------------

fs.mkdirSync(DOCS_DIR, { recursive: true });

const removeFile = (filePath) => {
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    // already gone
  }
};

const uploadDocument = async (req, res) => {
  const file = req.file;
  try {
    if (!file) return fail(res, 400, 'Choose a file (PDF, JPG, PNG or WEBP, up to 8 MB)', 'VALIDATION');
    const docKey = text(req.body?.docKey, 40);
    const shop = await loadShop(req.shop.shopId);
    const type = docKey
      ? (await pool.query('SELECT 1 FROM business_document_types WHERE business_type = $1 AND doc_key = $2 AND is_active', [shop.business_type, docKey])).rows[0]
      : null;
    if (!type) {
      removeFile(file.path);
      return fail(res, 400, 'Choose which document this is', 'BAD_DOC_KEY');
    }
    const current = (await pool.query('SELECT * FROM shop_documents WHERE shop_id = $1 AND doc_key = $2 ORDER BY id DESC LIMIT 1', [shop.id, docKey])).rows[0];
    if (current?.status === 'accepted') {
      removeFile(file.path);
      return fail(res, 409, 'GetMe already accepted this document. Contact support to change it.', 'ALREADY_ACCEPTED');
    }
    const row = (
      await pool.query(
        `INSERT INTO shop_documents (shop_id, doc_key, file_name, original_name, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [shop.id, docKey, path.basename(file.filename), text(file.originalname, 200), file.mimetype, file.size]
      )
    ).rows[0];
    // The earlier, not-accepted upload is replaced
    if (current) {
      await pool.query('DELETE FROM shop_documents WHERE id = $1', [current.id]);
      removeFile(path.join(DOCS_DIR, current.file_name));
    }
    log(req, 'business.document', `Uploaded ${docKey.replace(/_/g, ' ')}`);
    return res.status(201).json({
      success: true,
      document: { id: Number(row.id), docKey, originalName: row.original_name, mimeType: row.mime_type, sizeBytes: num(row.size_bytes), status: row.status, uploadedAt: row.uploaded_at },
    });
  } catch (error) {
    if (file) removeFile(file.path);
    console.error('❌ DOCUMENT UPLOAD ERROR:', error.message);
    return fail(res, 500, "Couldn't save the document. Please try again.");
  }
};

const streamDocument = (res, row) => {
  const filePath = path.join(DOCS_DIR, path.basename(row.file_name));
  if (!fs.existsSync(filePath)) return fail(res, 404, 'File not found', 'NOT_FOUND');
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${String(row.original_name || row.file_name).replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return fs.createReadStream(filePath).pipe(res);
};

const getDocumentFile = async (req, res) => {
  try {
    const row = (await pool.query('SELECT * FROM shop_documents WHERE id = $1 AND shop_id = $2', [toId(req.params.id), req.shop.shopId])).rows[0];
    if (!row) return fail(res, 404, 'Document not found', 'NOT_FOUND');
    return streamDocument(res, row);
  } catch (error) {
    console.error('❌ DOCUMENT FILE ERROR:', error.message);
    return fail(res, 500, "Couldn't open the document.");
  }
};

const deleteDocument = async (req, res) => {
  try {
    const row = (await pool.query('SELECT * FROM shop_documents WHERE id = $1 AND shop_id = $2', [toId(req.params.id), req.shop.shopId])).rows[0];
    if (!row) return fail(res, 404, 'Document not found', 'NOT_FOUND');
    if (row.status === 'accepted') return fail(res, 409, 'GetMe already accepted this document.', 'ALREADY_ACCEPTED');
    await pool.query('DELETE FROM shop_documents WHERE id = $1', [row.id]);
    removeFile(path.join(DOCS_DIR, row.file_name));
    log(req, 'business.document_removed', `Removed ${row.doc_key.replace(/_/g, ' ')}`);
    return res.json({ success: true });
  } catch (error) {
    console.error('❌ DOCUMENT DELETE ERROR:', error.message);
    return fail(res, 500, "Couldn't remove the document.");
  }
};

// -----------------------------------------------------
// Bank account + submit for review
// -----------------------------------------------------

const putBankAccount = async (req, res) => {
  try {
    const bankName = text(req.body?.bankName, 80);
    const accountName = text(req.body?.accountName, 120);
    const accountNumber = String(req.body?.accountNumber || '').replace(/[\s-]/g, '');
    if (!bankName) return fail(res, 400, 'Enter the bank name', 'VALIDATION');
    if (!accountName) return fail(res, 400, 'Enter the account holder name', 'VALIDATION');
    if (!/^\d{6,20}$/.test(accountNumber)) return fail(res, 400, 'Enter the account number (6 to 20 digits)', 'VALIDATION');
    await pool.query(
      `INSERT INTO shop_bank_accounts (shop_id, bank_name, branch_name, account_name, account_number)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (shop_id) DO UPDATE SET bank_name = $2, branch_name = $3, account_name = $4, account_number = $5,
         verified_at = NULL, verified_by_admin_id = NULL, updated_at = NOW()`,
      [req.shop.shopId, bankName, text(req.body?.branchName, 80), accountName, accountNumber]
    );
    log(req, 'business.bank_account', 'Updated the payout bank account');
    return res.json({ success: true, business: await businessView(await loadShop(req.shop.shopId)) });
  } catch (error) {
    console.error('❌ BANK ACCOUNT ERROR:', error.message);
    return fail(res, 500, "Couldn't save the bank account.");
  }
};

const submitForReview = async (req, res) => {
  try {
    const shop = await loadShop(req.shop.shopId);
    if (!['pending', 'rejected'].includes(shop.status)) {
      return fail(res, 409, shop.status === 'under_review' ? 'Your business is already under review.' : 'Your business has already been reviewed.', 'ORDER_STATE');
    }
    const view = await businessView(shop);
    if (view.missingDocuments.length) {
      const labels = view.documents.filter((d) => view.missingDocuments.includes(d.docKey)).map((d) => d.label);
      return fail(res, 400, `Upload these documents first: ${labels.join(', ')}`, 'MISSING_DOCUMENTS', { missing: view.missingDocuments });
    }
    if (shop.latitude == null || shop.longitude == null) {
      return fail(res, 400, 'Set your business location on the map first (Profile page).', 'LOCATION_REQUIRED');
    }
    const updated = (
      await pool.query(
        `UPDATE shops SET status = 'under_review', submitted_at = NOW(), status_reason = NULL, updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'rejected') RETURNING *`,
        [shop.id]
      )
    ).rows[0];
    if (!updated) return fail(res, 409, 'Your business status just changed. Reload the page.', 'ORDER_STATE');
    log(req, 'business.submitted', 'Sent the business for review');
    emitToAdmins(req.app.get('io'), 'admin:shops-updated', { shopId: shop.id, reason: 'submitted' });
    // Admin notification centre (phase 41); never blocks the answer
    require('../admin/notifications').notify({
      category: 'shops',
      event: 'shop.submitted',
      severity: 'info',
      title: `${typeLabel(shop.business_type)} sent for review`,
      body: `${shop.shop_name} uploaded its documents and is waiting for approval.`,
      entityType: 'shop',
      entityId: shop.id,
      permissions: ['shops.view'],
      dedupe: `shop.submitted:${shop.id}:${new Date(updated.submitted_at).getTime()}`,
    });
    return res.json({ success: true, business: await businessView(updated) });
  } catch (error) {
    console.error('❌ SUBMIT REVIEW ERROR:', error.message);
    return fail(res, 500, "Couldn't send your business for review.");
  }
};

// -----------------------------------------------------
// Branches
// -----------------------------------------------------

const mainShopIdOf = (shop) => Number(shop.parent_shop_id || shop.id);

const listBranches = async (req, res) => {
  try {
    const shop = await loadShop(req.shop.shopId);
    const mainId = mainShopIdOf(shop);
    const rows = (
      await pool.query(
        `SELECT id, shop_name, status, address, city, area, is_open, created_at, parent_shop_id
         FROM shops WHERE id = $1 OR parent_shop_id = $1 ORDER BY (parent_shop_id IS NOT NULL), id`,
        [mainId]
      )
    ).rows;
    const main = rows.find((r) => Number(r.id) === mainId);
    return res.json({
      success: true,
      currentShopId: Number(shop.id),
      main: main ? { id: Number(main.id), shopName: main.shop_name, status: main.status, address: main.address, city: main.city || main.area || null, isOpen: !!main.is_open } : null,
      branches: rows.filter((r) => Number(r.id) !== mainId).map((r) => ({
        id: Number(r.id), shopName: r.shop_name, status: r.status, address: r.address || null, city: r.city || r.area || null, isOpen: !!r.is_open, createdAt: r.created_at,
      })),
    });
  } catch (error) {
    console.error('❌ BRANCHES ERROR:', error.message);
    return fail(res, 500, "Couldn't load branches.");
  }
};

const createBranch = async (req, res) => {
  try {
    const shop = await loadShop(req.shop.shopId);
    const main = await loadShop(mainShopIdOf(shop));
    const body = req.body || {};
    const shopName = text(body.shopName, 200);
    const email = text(body.email, 150)?.toLowerCase();
    const mobile = normalizeSriLankanPhone(body.mobile);
    const address = text(body.address, 500);
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (!shopName || shopName.length < 2) return fail(res, 400, 'Enter the branch name', 'VALIDATION');
    if (!email || !EMAIL_PATTERN.test(email)) return fail(res, 400, 'Enter a valid email for the branch', 'VALIDATION');
    if (!mobile) return fail(res, 400, 'Enter a valid branch phone number', 'VALIDATION');
    if (!address) return fail(res, 400, 'Enter the branch address', 'VALIDATION');
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
      return fail(res, 400, 'Set the branch location on the map', 'VALIDATION');
    }
    const place = validProvince(text(body.province, 40), text(body.district, 40));
    if (place.error) return fail(res, 400, place.error, 'VALIDATION');
    let hours = null;
    if (body.openingHours) {
      const parsed = normalizeHours(body.openingHours);
      if (parsed.error) return fail(res, 400, parsed.error, 'VALIDATION');
      hours = parsed.hours;
    }
    const count = Number((await pool.query('SELECT COUNT(*)::int AS n FROM shops WHERE parent_shop_id = $1', [main.id])).rows[0].n);
    if (count >= 50) return fail(res, 400, 'A business can have at most 50 branches', 'TOO_MANY');
    if ((await pool.query('SELECT 1 FROM shops WHERE email = $1', [email])).rows.length) {
      return fail(res, 409, 'A shop with this email already exists', 'EMAIL_TAKEN');
    }
    const password = String(body.password || '');
    if (password && password.length < 8) return fail(res, 400, 'The branch password must be at least 8 characters', 'VALIDATION');
    const hash = await bcrypt.hash(password || crypto.randomBytes(24).toString('hex'), 10);

    const branch = (
      await pool.query(
        `INSERT INTO shops (shop_name, email, mobile, address, latitude, longitude, password_hash, status, business_type,
                            owner_name, province, district, city, area, business_reg_no, offers_delivery, offers_pickup,
                            description, opening_hours, auto_open, parent_shop_id, default_prep_minutes, brand_color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [
          shopName, email, mobile, address, latitude, longitude, hash, main.business_type,
          main.owner_name, place.province || main.province, place.district || main.district, text(body.city, 80),
          main.business_reg_no, main.offers_delivery, main.offers_pickup, main.description,
          hours, hours != null, main.id, main.default_prep_minutes, main.brand_color,
        ]
      )
    ).rows[0];
    log(req, 'branch.created', `Added branch ${shopName}`, 'shop', branch.id);
    emitToAdmins(req.app.get('io'), 'admin:shops-updated', { shopId: branch.id, reason: 'registered' });
    return res.status(201).json({
      success: true,
      branch: { id: Number(branch.id), shopName: branch.shop_name, status: branch.status, address: branch.address, city: branch.city, isOpen: !!branch.is_open, createdAt: branch.created_at },
    });
  } catch (error) {
    if (error.code === '23505') return fail(res, 409, 'A shop with this email already exists', 'EMAIL_TAKEN');
    console.error('❌ CREATE BRANCH ERROR:', error.message);
    return fail(res, 500, "Couldn't add the branch.");
  }
};

const switchBranch = async (req, res) => {
  try {
    const shop = await loadShop(req.shop.shopId);
    const mainId = mainShopIdOf(shop);
    const target = (await pool.query('SELECT * FROM shops WHERE id = $1 AND (id = $2 OR parent_shop_id = $2)', [toId(req.params.id), mainId])).rows[0];
    if (!target) return fail(res, 404, 'Branch not found', 'NOT_FOUND');
    if (['rejected', 'suspended'].includes(target.status)) {
      return fail(res, 403, `This branch is ${target.status}. Contact GetMe support.`, 'BRANCH_BLOCKED');
    }
    const { signShopToken } = require('../controllers/shop/shopAccountController');
    const { toShop } = require('../controllers/shop/shopFormat');
    log(req, 'branch.switched', `Switched to ${target.shop_name}`, 'shop', target.id);
    return res.json({ success: true, token: signShopToken(target), shop: toShop(target) });
  } catch (error) {
    console.error('❌ SWITCH BRANCH ERROR:', error.message);
    return fail(res, 500, "Couldn't switch branch.");
  }
};

// -----------------------------------------------------
// Operations (restaurant mostly)
// -----------------------------------------------------

const getOperations = async (req, res) => {
  try {
    return res.json({ success: true, operations: await operationsOf(await loadShop(req.shop.shopId)) });
  } catch (error) {
    console.error('❌ OPERATIONS ERROR:', error.message);
    return fail(res, 500, "Couldn't load operations.");
  }
};

const putOperations = async (req, res) => {
  try {
    const body = req.body || {};
    const shop = await loadShop(req.shop.shopId);
    const prep = body.defaultPrepMinutes === undefined ? Number(shop.default_prep_minutes) : Number(body.defaultPrepMinutes);
    if (!Number.isInteger(prep) || prep < 1 || prep > 240) return fail(res, 400, 'Preparation time must be 1 to 240 minutes', 'VALIDATION');
    let capacity = shop.max_active_orders;
    if (body.maxActiveOrders !== undefined) {
      capacity = body.maxActiveOrders === null || body.maxActiveOrders === '' ? null : Number(body.maxActiveOrders);
      if (capacity != null && (!Number.isInteger(capacity) || capacity < 1 || capacity > 500)) {
        return fail(res, 400, 'Maximum active orders must be 1 to 500, or empty for no limit', 'VALIDATION');
      }
    }
    let special = shop.special_hours || [];
    if (body.specialHours !== undefined) {
      const parsed = normalizeSpecialHours(body.specialHours);
      if (parsed.error) return fail(res, 400, parsed.error, 'VALIDATION');
      special = parsed.value;
    }
    const updated = (
      await pool.query(
        'UPDATE shops SET default_prep_minutes = $2, max_active_orders = $3, special_hours = $4, updated_at = NOW() WHERE id = $1 RETURNING *',
        [shop.id, prep, capacity, JSON.stringify(special)]
      )
    ).rows[0];
    log(req, 'operations.updated', 'Updated preparation time, capacity or special hours');
    broadcastCatalogChange(req.app.get('io'), shop.id, 'shop');
    return res.json({ success: true, operations: await operationsOf(updated) });
  } catch (error) {
    console.error('❌ PUT OPERATIONS ERROR:', error.message);
    return fail(res, 500, "Couldn't save operations.");
  }
};

const pauseOrders = async (req, res) => {
  try {
    const minutes = Number(req.body?.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) return fail(res, 400, 'Pause for 5 to 480 minutes', 'VALIDATION');
    const updated = (
      await pool.query(
        `UPDATE shops SET orders_paused_until = NOW() + make_interval(mins => $2), updated_at = NOW() WHERE id = $1 RETURNING *`,
        [req.shop.shopId, minutes]
      )
    ).rows[0];
    log(req, 'operations.paused', `Paused new orders for ${minutes} minutes`);
    broadcastCatalogChange(req.app.get('io'), req.shop.shopId, 'shop');
    return res.json({ success: true, operations: await operationsOf(updated) });
  } catch (error) {
    console.error('❌ PAUSE ERROR:', error.message);
    return fail(res, 500, "Couldn't pause orders.");
  }
};

const resumeOrders = async (req, res) => {
  try {
    const updated = (
      await pool.query('UPDATE shops SET orders_paused_until = NULL, updated_at = NOW() WHERE id = $1 RETURNING *', [req.shop.shopId])
    ).rows[0];
    log(req, 'operations.resumed', 'Resumed new orders');
    broadcastCatalogChange(req.app.get('io'), req.shop.shopId, 'shop');
    return res.json({ success: true, operations: await operationsOf(updated) });
  } catch (error) {
    console.error('❌ RESUME ERROR:', error.message);
    return fail(res, 500, "Couldn't resume orders.");
  }
};

module.exports = {
  DOCS_DIR,
  registerOptions,
  getBusiness,
  putBusiness,
  putCover,
  uploadDocument,
  getDocumentFile,
  deleteDocument,
  streamDocument,
  putBankAccount,
  submitForReview,
  listBranches,
  createBranch,
  switchBranch,
  getOperations,
  putOperations,
  pauseOrders,
  resumeOrders,
  businessView,
  documentsFor,
  maskAccount,
};
