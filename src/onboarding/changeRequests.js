const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const pool = require('../config/db');
const otp = require('./otp');
const sms = require('./sms');
const applications = require('./applications');
const { encryptIdentity, decryptIdentity, hashIdentity } = require('./identityVault');
const { normalizeSriLankanMobile } = require('../utils/phone');
const { revokeSessions } = require('../utils/shopperSession');

// =====================================================
// SHOPPER PROFILE PROTECTION (phase 35, 2026-10-28)
// Once a shopper is approved, these can't be edited directly; a change
// request goes to Owner / Operations admins (adminAction), and only an
// approved request changes the registered values:
//   vehicle_change   vehicle type, number, make / model, ownership,
//                    driving licence (+ CR, owner letter, licence photos)
//   identity_change  legal name / NIC (+ NIC photos)
//   phone_change     signed in: account password + SMS code to the new
//                    number (and to the current number) when SMS is
//                    configured. Verified + no risk flags -> applied at
//                    once; otherwise (or without SMS) an admin reviews.
//   phone_recovery   signed out, lost phone: identity checked against
//                    the registration + selfie + NIC photo; always an
//                    admin review. Same account, same id.
// A phone change bumps the session version (all older logins end).
// Bank accounts already need admin verification (wallet), so they are
// not duplicated here. Profile photo stays freely editable.
// Every applied change is written to shopper_profile_history.
// =====================================================

const OPEN = ['draft', 'pending_verification', 'pending_review', 'more_info_required'];

const STATUS_LABELS = {
  draft: 'Draft',
  pending_verification: 'Verify your number',
  pending_review: 'Pending review',
  more_info_required: 'More information required',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const TYPE_LABELS = {
  vehicle_change: 'Vehicle change',
  identity_change: 'Name / NIC change',
  phone_change: 'Phone number change',
  phone_recovery: 'Account recovery (lost phone)',
};

const STORAGE_DIR = path.resolve(__dirname, '..', '..', 'private-uploads', 'shopper-change-requests');
const MAX_BYTES = 8 * 1024 * 1024;
const PDF_ALLOWED = ['vehicle_cr', 'owner_letter'];
const ACTIVE_ORDER_STATUSES = ['shopper_accepted', 'shopping', 'out_for_delivery', 'arrived'];

const error = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const statusTokenHash = (token) => crypto.createHash('sha256').update(`getme-recovery:${token}`).digest('hex');
const maskMobile = (mobile) => (mobile ? `${String(mobile).slice(0, 5)}•••${String(mobile).slice(-3)}` : null);
const today = () => applications.isoDate(new Date());

// ---------------------------------------------------
// The registered (protected) profile
// ---------------------------------------------------

const registeredProfile = async (client, shopperId) => {
  const row = (
    await client.query(
      `
      SELECT sh.id, sh.shopper_code, sh.full_name, sh.mobile, sh.email, sh.approval_status, sh.status, sh.created_at,
             sh.vehicle_type, sh.vehicle_number, sh.vehicle_make, sh.vehicle_model, sh.licence_expiry,
             sh.vehicle_restriction, sh.vehicle_restricted_at, sh.password_hash,
             a.id AS application_id, a.is_registered_owner, a.licence_last4, a.nic_last4, a.nic_hash,
             a.date_of_birth, a.status AS application_status
      FROM shoppers sh
      LEFT JOIN shopper_applications a ON a.shopper_id = sh.id
      WHERE sh.id = $1
      `,
      [Number(shopperId)]
    )
  ).rows[0];

  if (!row) throw error(404, 'Shopper not found');

  return row;
};

// Values kept in a request as "before" (no secrets)
const snapshotOf = (row) => ({
  fullName: row.full_name,
  mobile: row.mobile,
  vehicleType: row.vehicle_type || null,
  vehicleLabel: applications.VEHICLES[row.vehicle_type] || null,
  vehicleNumber: row.vehicle_number || null,
  vehicleMake: row.vehicle_make || null,
  vehicleModel: row.vehicle_model || null,
  isRegisteredOwner: row.is_registered_owner ?? null,
  licenceLast4: row.licence_last4 || null,
  licenceExpiry: applications.isoDate(row.licence_expiry),
  nicLast4: row.nic_last4 || null,
});

// Why this shopper can't deliver right now (null = fine)
const eligibilityBlock = (row) => {
  if (row?.vehicle_restriction) {
    return { code: 'VEHICLE_RESTRICTED', message: `Your vehicle is restricted: ${row.vehicle_restriction}. Request a vehicle change or contact GetMe.` };
  }

  const expiry = applications.isoDate(row?.licence_expiry);

  if (expiry && expiry < today()) {
    return { code: 'LICENCE_EXPIRED', message: `Your driving licence expired on ${expiry}. Send a vehicle change request with your renewed licence.` };
  }

  return null;
};

// SQL for the same check (dispatch / offers), alias = shoppers alias
const eligibleSql = (alias = 'sh') =>
  `(${alias}.vehicle_restriction IS NULL AND (${alias}.licence_expiry IS NULL OR ${alias}.licence_expiry >= CURRENT_DATE))`;

// ---------------------------------------------------
// Documents (private, like the application's)
// ---------------------------------------------------

const currentDocuments = async (requestId, client = pool) =>
  (
    await client.query(
      'SELECT * FROM shopper_change_request_documents WHERE request_id = $1 AND replaced_at IS NULL AND deleted_at IS NULL ORDER BY id',
      [requestId]
    )
  ).rows;

const removeFile = (fileName) => {
  try {
    fs.unlinkSync(path.join(STORAGE_DIR, path.basename(fileName)));
  } catch {
    // already gone
  }
};

const storeDocument = async (client, request, docType, file) => {
  if (!applications.DOC_TYPES[docType]) throw error(400, 'Unknown document type', 'INVALID_DOC_TYPE');
  if (!file?.buffer?.length) throw error(400, 'Choose a photo to upload', 'NO_FILE');
  if (file.buffer.length > MAX_BYTES) throw error(413, 'The file is too large (max 8 MB)', 'FILE_TOO_LARGE');

  const mime = applications.sniffMime(file.buffer);

  if (!mime || (mime === 'application/pdf' && !PDF_ALLOWED.includes(docType))) {
    throw error(415, PDF_ALLOWED.includes(docType) ? 'Upload a photo (JPG, PNG, HEIC) or a PDF' : 'Upload a photo (JPG, PNG or HEIC)', 'INVALID_FILE');
  }

  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' }[mime];
  const name = `req${request.id}-${docType}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(STORAGE_DIR, name), file.buffer, { mode: 0o600 });

  const old = (
    await client.query(
      `UPDATE shopper_change_request_documents SET replaced_at = NOW(), deleted_at = NOW()
       WHERE request_id = $1 AND doc_type = $2 AND replaced_at IS NULL AND deleted_at IS NULL
       RETURNING file_name`,
      [request.id, docType]
    )
  ).rows;

  const doc = (
    await client.query(
      `INSERT INTO shopper_change_request_documents (request_id, doc_type, file_name, mime_type, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [request.id, docType, name, mime, file.buffer.length, crypto.createHash('sha256').update(file.buffer).digest('hex')]
    )
  ).rows[0];

  return { doc, oldFiles: old.map((row) => row.file_name), newFile: name };
};

// What a request needs before it can be reviewed
const requiredDocs = (request) => {
  const proposed = request.proposed_values || {};

  if (request.type === 'vehicle_change') {
    const docs = ['vehicle_cr'];
    if (proposed.isRegisteredOwner === false) docs.push('owner_letter');
    if (proposed.licenceChanged || proposed.vehicleTypeChanged) docs.push('licence_front', 'licence_back');
    // New photos of the proposed vehicle, always (phase 36)
    docs.push(...applications.vehiclePhotosFor(proposed.vehicleType));
    return docs;
  }

  if (request.type === 'identity_change') return ['nic_front', 'nic_back'];
  if (request.type === 'phone_recovery') return ['selfie', 'nic_front'];

  return [];
};

const addEvent = (client, requestId, { action, from = null, to = null, actorType, actorId = null, note = null }) =>
  client.query(
    `INSERT INTO shopper_change_request_events (request_id, action, from_status, to_status, actor_type, actor_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [requestId, action, from, to, actorType, actorId, note ? String(note).slice(0, 500) : null]
  );

const toPublic = (request, docs = [], { basePath = '/api/shopper/profile/change-requests' } = {}) => ({
  id: Number(request.id),
  type: request.type,
  typeLabel: TYPE_LABELS[request.type],
  status: request.status,
  statusLabel: STATUS_LABELS[request.status],
  open: OPEN.includes(request.status),
  editable: ['draft', 'more_info_required'].includes(request.status),
  current: request.current_values || {},
  proposed: {
    ...(request.proposed_values || {}),
    ...(request.proposed_mobile ? { mobile: request.proposed_mobile } : {}),
  },
  verification: {
    passwordConfirmed: Boolean(request.verification?.passwordConfirmedAt),
    currentPhoneVerified: Boolean(request.verification?.currentPhoneVerifiedAt),
    newPhoneVerified: Boolean(request.verification?.newPhoneVerifiedAt),
    smsConfigured: Boolean(request.verification?.smsConfigured),
  },
  requiredDocuments: requiredDocs(request),
  documents: docs.map((doc) => ({
    id: Number(doc.id),
    type: doc.doc_type,
    label: applications.DOC_TYPES[doc.doc_type]?.label || doc.doc_type,
    mimeType: doc.mime_type,
    uploadedAt: doc.uploaded_at,
    reviewStatus: doc.review_status || 'pending',
    reviewNote: doc.review_note || null,
    reviewedAt: doc.reviewed_at || null,
    url: `${basePath}/${request.id}/documents/${doc.id}`,
  })),
  missingDocuments: requiredDocs(request).filter((type) => !docs.some((doc) => doc.doc_type === type && doc.review_status !== 'rejected')),
  note: request.shopper_note || null,
  infoRequest: request.status === 'more_info_required' ? request.info_request || null : null,
  decisionReason: ['rejected', 'more_info_required'].includes(request.status) ? request.decision_reason || null : null,
  submittedAt: request.submitted_at,
  reviewedAt: request.reviewed_at,
  completedAt: request.completed_at,
  createdAt: request.created_at,
});

const RULES = {
  vehicles: Object.entries(applications.VEHICLES).map(([value, label]) => ({ value, label })),
  documentTypes: Object.entries(applications.DOC_TYPES).map(([value, info]) => ({ value, ...info, pdfAllowed: PDF_ALLOWED.includes(value) })),
  maxUploadBytes: MAX_BYTES,
};

// GET /api/shopper/profile/protected
const myOverview = async (shopperId) => {
  await applications.loadSettings();
  const row = await registeredProfile(pool, shopperId);
  const requests = (
    await pool.query('SELECT * FROM shopper_change_requests WHERE shopper_id = $1 ORDER BY created_at DESC, id DESC LIMIT 30', [row.id])
  ).rows;
  const docs = await Promise.all(requests.map((request) => currentDocuments(request.id)));
  const snapshot = snapshotOf(row);

  return {
    profile: {
      shopperCode: row.shopper_code,
      ...snapshot,
      mobile: row.mobile,
      licenceMasked: snapshot.licenceLast4 ? `••••${snapshot.licenceLast4}` : null,
      nicMasked: snapshot.nicLast4 ? `•••••••${snapshot.nicLast4}` : null,
      approvalStatus: row.approval_status,
      restriction: row.vehicle_restriction || null,
    },
    eligibility: eligibilityBlock(row),
    protectedFields: ['fullName', 'nic', 'mobile', 'vehicleType', 'vehicleNumber', 'vehicleMake', 'vehicleModel', 'ownership', 'licence', 'bankAccount'],
    editableFields: ['profilePhoto'],
    requests: requests.map((request, index) => toPublic(request, docs[index])),
    smsConfigured: sms.isConfigured(),
    rules: { ...RULES, vehiclePhotos: require('../pricing/settings').vehiclePhotoRules() },
  };
};

const lockShopper = async (client, shopperId) =>
  (await client.query('SELECT id, approval_status FROM shoppers WHERE id = $1 FOR UPDATE', [Number(shopperId)])).rows[0];

const openRequestOf = async (client, shopperId, type) =>
  (
    await client.query(
      `SELECT * FROM shopper_change_requests
       WHERE shopper_id = $1 AND status = ANY($3)
         AND (CASE WHEN type = 'phone_recovery' THEN 'phone_change' ELSE type END) = (CASE WHEN $2::varchar = 'phone_recovery' THEN 'phone_change' ELSE $2::varchar END)
       FOR UPDATE`,
      [Number(shopperId), type, OPEN]
    )
  ).rows[0] || null;

const requireApproved = (shopper) => {
  if (!shopper) throw error(404, 'Shopper not found');
  if (shopper.approval_status !== 'approved') {
    throw error(409, 'Your account is not approved yet. Update your details in your application.', 'NOT_APPROVED');
  }
};

// ---------------------------------------------------
// Vehicle / identity change requests (signed in, approved shoppers)
// POST /api/shopper/profile/change-requests { type, ...fields }
// Saves a draft (or updates the open draft / more-info request).
// ---------------------------------------------------

const vehicleProposal = (row, input) => {
  const vehicleType = String(input.vehicleType || '');
  const vehicleNumber = applications.normalizeVehicleNumber(input.vehicleNumber);
  const make = clean(input.vehicleMake, 40);
  const model = clean(input.vehicleModel, 60);
  const owner = input.isRegisteredOwner;
  const licenceIn = input.licenceNumber ? applications.normalizeLicence(input.licenceNumber) : null;
  const licenceExpiry = input.licenceExpiry ? applications.isoDate(input.licenceExpiry) : null;

  if (!applications.VEHICLES[vehicleType]) throw error(400, 'Choose your vehicle: Bike, Tuk or Car', 'INVALID_VEHICLE', { field: 'vehicleType' });
  if (!vehicleNumber) throw error(400, 'Enter the vehicle number as on the registration (e.g. WP CAB-1234)', 'INVALID_VEHICLE_NUMBER', { field: 'vehicleNumber' });
  if (make.length < 2) throw error(400, 'Enter the vehicle make (e.g. Honda)', 'INVALID_MAKE', { field: 'vehicleMake' });
  if (model.length < 1) throw error(400, 'Enter the vehicle model (e.g. Dio)', 'INVALID_MODEL', { field: 'vehicleModel' });
  if (typeof owner !== 'boolean') throw error(400, 'Tell us whether the vehicle is registered in your name', 'OWNER_REQUIRED', { field: 'isRegisteredOwner' });
  if (input.licenceNumber && !licenceIn) throw error(400, 'Enter a valid driving licence number (e.g. B1234567)', 'INVALID_LICENCE', { field: 'licenceNumber' });
  if (input.licenceExpiry && !licenceExpiry) throw error(400, 'Enter the licence expiry date', 'INVALID_LICENCE_EXPIRY', { field: 'licenceExpiry' });
  if (licenceExpiry && licenceExpiry <= today()) throw error(400, 'This licence has expired', 'LICENCE_EXPIRED', { field: 'licenceExpiry' });

  const vehicleTypeChanged = vehicleType !== row.vehicle_type;

  // Changing vehicle category needs the licence for it (new licence or
  // photos of the current one)
  if (vehicleTypeChanged && !licenceExpiry && !applications.isoDate(row.licence_expiry)) {
    throw error(400, 'Enter your licence expiry date', 'INVALID_LICENCE_EXPIRY', { field: 'licenceExpiry' });
  }

  const licenceChanged = Boolean(licenceIn || (licenceExpiry && licenceExpiry !== applications.isoDate(row.licence_expiry)));

  const proposed = {
    vehicleType,
    vehicleLabel: applications.VEHICLES[vehicleType],
    vehicleNumber,
    vehicleMake: make,
    vehicleModel: model,
    isRegisteredOwner: owner,
    licenceExpiry: licenceExpiry || applications.isoDate(row.licence_expiry),
    licenceLast4: licenceIn ? licenceIn.slice(-4) : row.licence_last4 || null,
    licenceChanged,
    vehicleTypeChanged,
  };

  const same =
    !vehicleTypeChanged &&
    vehicleNumber === row.vehicle_number &&
    make === (row.vehicle_make || '') &&
    model === (row.vehicle_model || '') &&
    owner === row.is_registered_owner &&
    !licenceChanged;

  if (same) throw error(400, 'Nothing has changed. Update the details you want to change.', 'NO_CHANGE');

  return { proposed, licence: licenceIn };
};

const saveRequest = async (shopperId, input = {}) => {
  const type = String(input.type || '');

  if (!['vehicle_change', 'identity_change'].includes(type)) {
    throw error(400, 'Choose what you want to change', 'INVALID_TYPE');
  }

  const client = await pool.connect();
  let requestId;

  try {
    await client.query('BEGIN');
    requireApproved(await lockShopper(client, shopperId));
    const row = await registeredProfile(client, shopperId);
    const open = await openRequestOf(client, shopperId, type);

    if (open && !['draft', 'more_info_required'].includes(open.status)) {
      throw error(409, `You already have a ${TYPE_LABELS[type].toLowerCase()} request ${STATUS_LABELS[open.status].toLowerCase()}`, 'ALREADY_PENDING');
    }

    let proposed;
    let licence = null;
    let nic = null;

    if (type === 'vehicle_change') {
      ({ proposed, licence } = vehicleProposal(row, input));

      const taken = (
        await client.query(
          "SELECT 1 FROM shoppers WHERE UPPER(vehicle_number) = $1 AND id <> $2 AND approval_status IN ('approved', 'pending')",
          [proposed.vehicleNumber, row.id]
        )
      ).rows.length > 0;

      if (taken) throw error(409, 'This vehicle is registered to another GetMe shopper. Contact GetMe support.', 'VEHICLE_IN_USE', { field: 'vehicleNumber' });
    } else {
      const fullName = clean(input.fullName, 120);
      const nicIn = input.nicNumber ? applications.parseNic(input.nicNumber) : null;

      if (fullName && (fullName.length < 3 || !/^[\p{L} .'-]+$/u.test(fullName) || !/\s/.test(fullName))) {
        throw error(400, 'Enter your full name exactly as on your NIC', 'INVALID_NAME', { field: 'fullName' });
      }

      if (input.nicNumber && !nicIn) throw error(400, 'Enter a valid NIC number', 'INVALID_NIC', { field: 'nicNumber' });

      const dob = applications.isoDate(row.date_of_birth);

      if (nicIn && dob && nicIn.dateOfBirth !== dob) {
        throw error(400, "This NIC number doesn't match your registered date of birth", 'DOB_NIC_MISMATCH', { field: 'nicNumber' });
      }

      if (nicIn) {
        const hash = hashIdentity(nicIn.normalized);
        const taken = (
          await client.query("SELECT 1 FROM shopper_applications WHERE nic_hash = $1 AND shopper_id <> $2 AND status <> 'rejected'", [hash, row.id])
        ).rows.length > 0;

        if (taken) throw error(409, 'This NIC is used on another GetMe shopper account. Contact GetMe support.', 'NIC_IN_USE', { field: 'nicNumber' });
        nic = { normalized: nicIn.normalized, hash };
      }

      const nameChanged = fullName && fullName !== row.full_name;
      const nicChanged = nic && nic.hash !== row.nic_hash;

      if (!nameChanged && !nicChanged) throw error(400, 'Nothing has changed. Enter the new name or NIC number.', 'NO_CHANGE');

      proposed = {
        fullName: nameChanged ? fullName : row.full_name,
        nameChanged: Boolean(nameChanged),
        nicChanged: Boolean(nicChanged),
        nicLast4: nicChanged ? nic.normalized.slice(-4) : row.nic_last4 || null,
      };
    }

    const note = clean(input.note, 500) || null;

    if (open) {
      await client.query(
        `UPDATE shopper_change_requests
         SET proposed_values = $2::jsonb, proposed_licence_encrypted = COALESCE($3, proposed_licence_encrypted),
             proposed_nic_encrypted = COALESCE($4, proposed_nic_encrypted), proposed_nic_hash = COALESCE($5, proposed_nic_hash),
             shopper_note = COALESCE($6, shopper_note), updated_at = NOW()
         WHERE id = $1`,
        [open.id, JSON.stringify(proposed), licence ? encryptIdentity(licence) : null, nic ? encryptIdentity(nic.normalized) : null, nic?.hash || null, note]
      );
      requestId = open.id;
    } else {
      requestId = (
        await client.query(
          `INSERT INTO shopper_change_requests (shopper_id, type, status, current_values, proposed_values,
             proposed_licence_encrypted, proposed_nic_encrypted, proposed_nic_hash, shopper_note)
           VALUES ($1, $2, 'draft', $3::jsonb, $4::jsonb, $5, $6, $7, $8) RETURNING id`,
          [row.id, type, JSON.stringify(snapshotOf(row)), JSON.stringify(proposed), licence ? encryptIdentity(licence) : null, nic ? encryptIdentity(nic.normalized) : null, nic?.hash || null, note]
        )
      ).rows[0].id;
      await addEvent(client, requestId, { action: 'created', to: 'draft', actorType: 'shopper', actorId: row.id });
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') throw error(409, 'You already have an open request of this kind', 'ALREADY_PENDING');
    throw caught;
  } finally {
    client.release();
  }

  return getMyRequest(shopperId, requestId);
};

const getMyRequest = async (shopperId, requestId) => {
  await applications.loadSettings();
  const request = (
    await pool.query('SELECT * FROM shopper_change_requests WHERE id = $1 AND shopper_id = $2', [Number(requestId), Number(shopperId)])
  ).rows[0];

  if (!request) throw error(404, 'Request not found');

  return { request: toPublic(request, await currentDocuments(request.id)) };
};

// POST /api/shopper/profile/change-requests/:id/documents
const uploadMyDocument = async (shopperId, requestId, docType, file) => {
  const client = await pool.connect();
  let stored;

  try {
    await client.query('BEGIN');
    await lockShopper(client, shopperId);
    const request = (
      await client.query('SELECT * FROM shopper_change_requests WHERE id = $1 AND shopper_id = $2 FOR UPDATE', [Number(requestId), Number(shopperId)])
    ).rows[0];

    if (!request || request.type === 'phone_recovery') throw error(404, 'Request not found');
    if (!['draft', 'more_info_required'].includes(request.status)) throw error(409, "This request can't be changed now", 'NOT_EDITABLE');

    stored = await storeDocument(client, request, docType, file);
    await client.query('UPDATE shopper_change_requests SET updated_at = NOW() WHERE id = $1', [request.id]);
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (stored?.newFile) removeFile(stored.newFile);
    throw caught;
  } finally {
    client.release();
  }

  stored.oldFiles.forEach(removeFile);

  return getMyRequest(shopperId, requestId);
};

// POST /api/shopper/profile/change-requests/:id/submit { requestId }
const submitMyRequest = async (shopperId, requestId) => {
  await applications.loadSettings();
  const client = await pool.connect();
  let duplicate = false;

  try {
    await client.query('BEGIN');
    await lockShopper(client, shopperId);
    const request = (
      await client.query('SELECT * FROM shopper_change_requests WHERE id = $1 AND shopper_id = $2 FOR UPDATE', [Number(requestId), Number(shopperId)])
    ).rows[0];

    if (!request || !['vehicle_change', 'identity_change'].includes(request.type)) throw error(404, 'Request not found');

    if (request.status === 'pending_review') {
      duplicate = true;
    } else {
      if (!['draft', 'more_info_required'].includes(request.status)) throw error(409, `This request is ${STATUS_LABELS[request.status].toLowerCase()}`, 'NOT_EDITABLE');

      const docs = await currentDocuments(request.id, client);
      const missing = requiredDocs(request).filter((type) => !docs.some((doc) => doc.doc_type === type && doc.review_status !== 'rejected'));

      if (missing.length) {
        throw error(400, `Upload: ${missing.map((type) => applications.DOC_TYPES[type].label).join(', ')}`, 'DOCUMENTS_MISSING', { missing });
      }

      await client.query(
        "UPDATE shopper_change_requests SET status = 'pending_review', submitted_at = NOW(), info_request = NULL, updated_at = NOW() WHERE id = $1",
        [request.id]
      );
      await addEvent(client, request.id, { action: request.status === 'more_info_required' ? 'resubmitted' : 'submitted', from: request.status, to: 'pending_review', actorType: 'shopper', actorId: Number(shopperId) });
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  return { ...(await getMyRequest(shopperId, requestId)), duplicate };
};

// POST /api/shopper/profile/change-requests/:id/cancel
const cancelMyRequest = async (shopperId, requestId) => {
  const result = await pool.query(
    `UPDATE shopper_change_requests SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND shopper_id = $2 AND status = ANY($3) AND type <> 'phone_recovery'
     RETURNING id, status`,
    [Number(requestId), Number(shopperId), OPEN]
  );

  if (!result.rows[0]) throw error(409, "This request can't be cancelled", 'NOT_CANCELLABLE');

  const client = await pool.connect();
  try {
    await addEvent(client, Number(requestId), { action: 'cancelled', to: 'cancelled', actorType: 'shopper', actorId: Number(shopperId) });
  } finally {
    client.release();
  }

  return getMyRequest(shopperId, requestId);
};

// A shopper (or admin) opening a request document -> { filePath, mimeType, docType }
const documentFile = async (documentId, { shopperId = null, requestId = null } = {}) => {
  const doc = (
    await pool.query(
      `SELECT d.*, r.shopper_id, r.id AS rid FROM shopper_change_request_documents d
       JOIN shopper_change_requests r ON r.id = d.request_id
       WHERE d.id = $1 AND d.replaced_at IS NULL AND d.deleted_at IS NULL`,
      [Number(documentId)]
    )
  ).rows[0];

  if (!doc || (shopperId != null && Number(doc.shopper_id) !== Number(shopperId)) || (requestId != null && Number(doc.rid) !== Number(requestId))) {
    throw error(404, 'Document not found');
  }

  const filePath = path.join(STORAGE_DIR, path.basename(doc.file_name));
  if (!fs.existsSync(filePath)) throw error(404, 'Document file not found');

  return { filePath, mimeType: doc.mime_type, docType: doc.doc_type };
};

// ---------------------------------------------------
// Phone number change (signed in)
//   POST /api/shopper/profile/phone-change { newMobile, password }
//   POST /api/shopper/profile/phone-change/:id/verify { target: new|current, code }
//   POST /api/shopper/profile/phone-change/:id/resend { target }
// ---------------------------------------------------

const riskFlagsFor = async (client, shopperId) => {
  const flags = [];
  const row = (
    await client.query(
      `SELECT sh.created_at,
         (SELECT COUNT(*)::int FROM shopper_profile_history h WHERE h.shopper_id = sh.id AND h.field = 'mobile' AND h.created_at > NOW() - INTERVAL '30 days') AS recent_changes,
         (SELECT COUNT(*)::int FROM shopper_withdrawals w WHERE w.shopper_id = sh.id AND w.status IN ('pending', 'approved', 'processing')) AS open_withdrawals,
         (SELECT COUNT(*)::int FROM shopper_payout_accounts p WHERE p.shopper_id = sh.id AND p.deleted_at IS NULL AND p.created_at > NOW() - INTERVAL '7 days') AS new_accounts
       FROM shoppers sh WHERE sh.id = $1`,
      [shopperId]
    )
  ).rows[0];

  if (new Date(row.created_at) > new Date(Date.now() - 7 * 86400000)) flags.push({ code: 'new_account', label: 'Account is less than 7 days old' });
  if (row.recent_changes > 0) flags.push({ code: 'recent_phone_change', label: 'Phone number already changed in the last 30 days' });
  if (row.open_withdrawals > 0) flags.push({ code: 'open_withdrawal', label: 'A withdrawal is open' });
  if (row.new_accounts > 0) flags.push({ code: 'new_bank_account', label: 'A bank account was added in the last 7 days' });

  return flags;
};

const checkNewMobile = async (client, mobile, shopperId) => {
  if (!mobile) throw error(400, 'Enter a valid Sri Lankan mobile number (e.g. 077 123 4567)', 'INVALID_MOBILE', { field: 'newMobile' });

  const taken = (await client.query('SELECT id FROM shoppers WHERE mobile = $1', [mobile])).rows[0];

  if (taken && Number(taken.id) === Number(shopperId)) {
    throw error(400, 'This is already your registered number', 'SAME_NUMBER', { field: 'newMobile' });
  }

  if (taken) throw error(409, 'This number is already used by another GetMe account', 'MOBILE_TAKEN', { field: 'newMobile' });

  const pending = (
    await client.query(
      "SELECT 1 FROM shopper_change_requests WHERE proposed_mobile = $1 AND shopper_id <> $2 AND status = ANY($3)",
      [mobile, Number(shopperId), OPEN]
    )
  ).rows.length > 0;

  if (pending) throw error(409, 'This number is in another account change request', 'MOBILE_TAKEN', { field: 'newMobile' });
};

// send / configured: in-process tests only (the API always uses sms.js)
const startPhoneChange = async (shopperId, input = {}, { send, configured } = {}) => {
  const newMobile = normalizeSriLankanMobile(input.newMobile);
  const password = String(input.password || '');
  const smsOn = configured ? configured() : sms.isConfigured();
  const client = await pool.connect();
  let requestId;
  let sendTo = null;

  try {
    await client.query('BEGIN');
    const me = await lockShopper(client, shopperId);
    if (!me) throw error(404, 'Shopper not found');
    if (me.approval_status === 'suspended') throw error(403, 'Your account is suspended. Contact GetMe support.', 'SUSPENDED');

    const row = await registeredProfile(client, shopperId);

    // The account holder confirms it's them (password)
    if (!password || !(await bcrypt.compare(password, row.password_hash || ''))) {
      throw error(403, 'Your password is not correct', 'WRONG_PASSWORD', { field: 'password' });
    }

    await checkNewMobile(client, newMobile, shopperId);

    const open = await openRequestOf(client, shopperId, 'phone_change');
    if (open) throw error(409, 'You already have a phone number request open. Finish or cancel it first.', 'ALREADY_PENDING');

    const flags = await riskFlagsFor(client, row.id);
    if (!smsOn) flags.push({ code: 'sms_not_configured', label: 'SMS verification is not set up: call both numbers to confirm' });

    const status = smsOn ? 'pending_verification' : 'pending_review';

    requestId = (
      await client.query(
        `INSERT INTO shopper_change_requests (shopper_id, type, status, current_values, proposed_values, proposed_mobile,
           verification, risk_flags, shopper_note, submitted_at)
         VALUES ($1, 'phone_change', $2::varchar, $3::jsonb, '{}'::jsonb, $4, $5::jsonb, $6::jsonb, $7, CASE WHEN $2::varchar = 'pending_review' THEN NOW() END)
         RETURNING id`,
        [row.id, status, JSON.stringify(snapshotOf(row)), newMobile, JSON.stringify({ passwordConfirmedAt: new Date().toISOString(), smsConfigured: smsOn }), JSON.stringify(flags), clean(input.note, 500) || null]
      )
    ).rows[0].id;

    await addEvent(client, requestId, { action: 'created', to: status, actorType: 'shopper', actorId: row.id, note: 'Password confirmed' });
    await client.query('COMMIT');

    sendTo = smsOn ? { current: row.mobile, next: newMobile } : null;
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') throw error(409, 'You already have a phone number request open', 'ALREADY_PENDING');
    throw caught;
  } finally {
    client.release();
  }

  // Codes to both numbers (outside the transaction)
  if (sendTo) {
    const options = send ? { send, configured: () => true } : {};
    await otp.sendCode(sendTo.next, { ...options, purpose: 'phone_new' });
    await otp.sendCode(sendTo.current, { ...options, purpose: 'phone_current' });
  }

  return getMyRequest(shopperId, requestId);
};

// Puts the new number on the account (same id, same orders / wallet),
// ends every older login, records the change. Inside a transaction.
const applyPhoneChange = async (client, request, { actorType, actorId }) => {
  const mobile = request.proposed_mobile;
  const old = (await client.query('SELECT mobile FROM shoppers WHERE id = $1 FOR UPDATE', [request.shopper_id])).rows[0];
  await checkNewMobile(client, mobile, request.shopper_id);

  await client.query('UPDATE shoppers SET mobile = $2, updated_at = NOW() WHERE id = $1', [request.shopper_id, mobile]);
  await revokeSessions(client, request.shopper_id);
  await client.query(
    `INSERT INTO shopper_profile_history (shopper_id, field, old_value, new_value, change_request_id, changed_by_type, changed_by_id)
     VALUES ($1, 'mobile', $2, $3, $4, $5, $6)`,
    [request.shopper_id, old?.mobile || null, mobile, request.id, actorType, actorId]
  );

  return { oldMobile: old?.mobile || null, newMobile: mobile };
};

const verifyPhoneChange = async (shopperId, requestId, input = {}) => {
  const target = input.target === 'current' ? 'current' : 'new';
  const client = await pool.connect();
  let result = { applied: false };

  try {
    await client.query('BEGIN');
    await lockShopper(client, shopperId);
    const request = (
      await client.query("SELECT * FROM shopper_change_requests WHERE id = $1 AND shopper_id = $2 AND type = 'phone_change' FOR UPDATE", [Number(requestId), Number(shopperId)])
    ).rows[0];

    if (!request) throw error(404, 'Request not found');
    if (request.status !== 'pending_verification') throw error(409, 'This request is not waiting for a code', 'WRONG_STATUS');

    const mobile = target === 'new' ? request.proposed_mobile : request.current_values.mobile;
    // Throws WRONG_CODE / CODE_EXPIRED / TOO_MANY_ATTEMPTS
    await otp.verifyCode(mobile, input.code, { purpose: target === 'new' ? 'phone_new' : 'phone_current' });

    const verification = {
      ...request.verification,
      [target === 'new' ? 'newPhoneVerifiedAt' : 'currentPhoneVerifiedAt']: new Date().toISOString(),
    };

    await client.query('UPDATE shopper_change_requests SET verification = $2::jsonb, updated_at = NOW() WHERE id = $1', [request.id, JSON.stringify(verification)]);
    await addEvent(client, request.id, { action: target === 'new' ? 'new_phone_verified' : 'current_phone_verified', actorType: 'shopper', actorId: Number(shopperId), note: 'SMS code' });

    if (verification.newPhoneVerifiedAt && verification.currentPhoneVerifiedAt) {
      const flags = request.risk_flags || [];

      if (flags.length === 0) {
        // Both numbers verified, nothing unusual: done
        const change = await applyPhoneChange(client, { ...request, verification }, { actorType: 'shopper', actorId: Number(shopperId) });
        await client.query("UPDATE shopper_change_requests SET status = 'approved', submitted_at = COALESCE(submitted_at, NOW()), completed_at = NOW(), updated_at = NOW() WHERE id = $1", [request.id]);
        await addEvent(client, request.id, { action: 'applied', from: 'pending_verification', to: 'approved', actorType: 'system', note: 'Both numbers verified; no risk checks' });
        result = { applied: true, ...change };
      } else {
        await client.query("UPDATE shopper_change_requests SET status = 'pending_review', submitted_at = NOW(), updated_at = NOW() WHERE id = $1", [request.id]);
        await addEvent(client, request.id, { action: 'submitted', from: 'pending_verification', to: 'pending_review', actorType: 'system', note: `Admin review: ${flags.map((flag) => flag.label).join('; ')}` });
      }
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  return { ...(await getMyRequest(shopperId, requestId)), ...result };
};

const resendPhoneCode = async (shopperId, requestId, input = {}, { send } = {}) => {
  const request = (
    await pool.query("SELECT * FROM shopper_change_requests WHERE id = $1 AND shopper_id = $2 AND type = 'phone_change'", [Number(requestId), Number(shopperId)])
  ).rows[0];

  if (!request) throw error(404, 'Request not found');
  if (request.status !== 'pending_verification') throw error(409, 'This request is not waiting for a code', 'WRONG_STATUS');

  const target = input.target === 'current' ? 'current' : 'new';
  const options = send ? { send, configured: () => true } : {};

  return otp.sendCode(target === 'new' ? request.proposed_mobile : request.current_values.mobile, { ...options, purpose: target === 'new' ? 'phone_new' : 'phone_current' });
};

// ---------------------------------------------------
// Lost phone: account recovery (signed out, multipart)
//   POST /api/shopper/account-recovery
//        { registeredMobile, fullName, dateOfBirth, nicNumber, newMobile,
//          note, newPhoneProof? } + files selfie, nic_front
//   GET  /api/shopper/account-recovery/:id?token=
//   POST /api/shopper/account-recovery/:id/documents?token= (more info)
//   POST /api/shopper/account-recovery/:id/resubmit?token=
// Identity is checked against the registration (NIC hash + date of
// birth when on file). Always reviewed by an admin.
// ---------------------------------------------------

const normName = (value) => String(value || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');

const startRecovery = async (input = {}, files = {}) => {
  const registered = normalizeSriLankanMobile(input.registeredMobile);
  const newMobile = normalizeSriLankanMobile(input.newMobile);
  const fullName = clean(input.fullName, 120);
  const dob = applications.isoDate(input.dateOfBirth);
  const nic = applications.parseNic(input.nicNumber);

  if (!registered) throw error(400, 'Enter the mobile number your GetMe account uses', 'INVALID_MOBILE', { field: 'registeredMobile' });
  if (fullName.length < 3) throw error(400, 'Enter your full name as on your NIC', 'INVALID_NAME', { field: 'fullName' });
  if (!dob) throw error(400, 'Enter your date of birth', 'INVALID_DOB', { field: 'dateOfBirth' });
  if (!nic) throw error(400, 'Enter a valid NIC number', 'INVALID_NIC', { field: 'nicNumber' });
  if (nic.dateOfBirth !== dob) throw error(400, "Your NIC number doesn't match the date of birth", 'DOB_NIC_MISMATCH', { field: 'nicNumber' });
  if (!files.selfie || !files.nic_front) throw error(400, 'Take a selfie and a photo of the front of your NIC', 'DOCUMENTS_MISSING');

  const smsOn = sms.isConfigured();
  const client = await pool.connect();
  let requestId;
  let token;
  const written = [];

  try {
    await client.query('BEGIN');

    const shopper = (await client.query('SELECT id FROM shoppers WHERE mobile = $1', [registered])).rows[0];

    // Same answer whether the number exists or the identity is wrong
    const notFound = () => error(404, "We couldn't match these details to a GetMe shopper account. Check them or contact GetMe support.", 'NOT_MATCHED');

    if (!shopper) throw notFound();

    const me = await lockShopper(client, shopper.id);
    if (me.approval_status === 'suspended') throw notFound();

    const row = await registeredProfile(client, shopper.id);
    const nicHash = hashIdentity(nic.normalized);
    const checks = {
      nicOnFile: Boolean(row.nic_hash),
      nicMatches: row.nic_hash ? row.nic_hash === nicHash : null,
      dobOnFile: Boolean(row.date_of_birth),
      dobMatches: row.date_of_birth ? applications.isoDate(row.date_of_birth) === dob : null,
      nameMatches: normName(fullName) === normName(row.full_name),
    };

    // A NIC on file that doesn't match: refused (not sent to admins)
    if (checks.nicMatches === false || checks.dobMatches === false) throw notFound();

    await checkNewMobile(client, newMobile, shopper.id);

    const open = await openRequestOf(client, shopper.id, 'phone_recovery');
    if (open) throw error(409, 'A request to change this account\'s number is already open. Wait for GetMe to contact you.', 'ALREADY_PENDING');

    // The new number proven by SMS code when SMS is set up
    const newVerified = smsOn ? await otp.useProof(client, newMobile, input.newPhoneProof) : false;
    if (smsOn && !newVerified) throw error(400, 'Verify your new number with the SMS code first', 'NEW_PHONE_NOT_VERIFIED', { field: 'newMobile' });

    const flags = [{ code: 'recovery', label: 'Lost phone: confirm identity (compare selfie and NIC with the registration)' }];
    if (!checks.nicOnFile) flags.push({ code: 'no_identity_on_file', label: 'No NIC on file (registered before applications): check the documents carefully' });
    if (!checks.nameMatches) flags.push({ code: 'name_mismatch', label: "Name doesn't match the registered name" });
    if (!smsOn) flags.push({ code: 'sms_not_configured', label: 'SMS verification is not set up: call the new number to confirm' });
    flags.push(...(await riskFlagsFor(client, shopper.id)));

    token = crypto.randomBytes(24).toString('base64url');

    requestId = (
      await client.query(
        `INSERT INTO shopper_change_requests (shopper_id, type, status, current_values, proposed_values, proposed_mobile,
           proposed_nic_encrypted, proposed_nic_hash, verification, risk_flags, shopper_note, status_token_hash, submitted_at)
         VALUES ($1, 'phone_recovery', 'pending_review', $2::jsonb, $3::jsonb, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, NOW())
         RETURNING id`,
        [
          shopper.id,
          JSON.stringify(snapshotOf(row)),
          JSON.stringify({ fullName, dateOfBirth: dob, nicLast4: nic.normalized.slice(-4) }),
          newMobile,
          encryptIdentity(nic.normalized),
          nicHash,
          JSON.stringify({ identityChecks: checks, newPhoneVerifiedAt: newVerified ? new Date().toISOString() : null, smsConfigured: smsOn }),
          JSON.stringify(flags),
          clean(input.note, 500) || null,
          statusTokenHash(token),
        ]
      )
    ).rows[0].id;

    const request = { id: requestId };

    for (const type of ['selfie', 'nic_front', 'nic_back']) {
      if (files[type]) {
        const stored = await storeDocument(client, request, type, files[type]);
        written.push(stored.newFile);
      }
    }

    await addEvent(client, requestId, { action: 'recovery_requested', to: 'pending_review', actorType: 'public', note: `Identity: NIC ${checks.nicOnFile ? 'matches' : 'not on file'}, date of birth ${checks.dobOnFile ? 'matches' : 'not on file'}, name ${checks.nameMatches ? 'matches' : 'differs'}` });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    written.forEach(removeFile);
    if (caught.code === '23505') throw error(409, "A request to change this account's number is already open", 'ALREADY_PENDING');
    throw caught;
  } finally {
    client.release();
  }

  return { reference: requestId, statusToken: token, status: 'pending_review', statusLabel: STATUS_LABELS.pending_review };
};

const recoveryByToken = async (client, requestId, token) => {
  const request = (
    await client.query("SELECT * FROM shopper_change_requests WHERE id = $1 AND type = 'phone_recovery'", [Number(requestId)])
  ).rows[0];

  if (!request || !token || request.status_token_hash !== statusTokenHash(String(token))) {
    throw error(404, 'Request not found');
  }

  return request;
};

const recoveryStatus = async (requestId, token) => {
  const request = await recoveryByToken(pool, requestId, token);
  const docs = await currentDocuments(request.id);

  return {
    reference: Number(request.id),
    status: request.status,
    statusLabel: STATUS_LABELS[request.status],
    newMobileMasked: maskMobile(request.proposed_mobile),
    infoRequest: request.status === 'more_info_required' ? request.info_request : null,
    decisionReason: ['rejected', 'more_info_required'].includes(request.status) ? request.decision_reason : null,
    documents: docs.map((doc) => ({
      type: doc.doc_type,
      label: applications.DOC_TYPES[doc.doc_type]?.label,
      uploadedAt: doc.uploaded_at,
      reviewStatus: doc.review_status || 'pending',
      reviewNote: doc.review_note || null,
    })),
    completedAt: request.completed_at,
  };
};

const recoveryUpload = async (requestId, token, docType, file) => {
  const client = await pool.connect();
  let stored;

  try {
    await client.query('BEGIN');
    const request = await recoveryByToken(client, requestId, token);
    if (request.status !== 'more_info_required') throw error(409, "This request can't be changed now", 'NOT_EDITABLE');
    if (!['selfie', 'nic_front', 'nic_back'].includes(docType)) throw error(400, 'Unknown document type', 'INVALID_DOC_TYPE');
    stored = await storeDocument(client, request, docType, file);
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (stored?.newFile) removeFile(stored.newFile);
    throw caught;
  } finally {
    client.release();
  }

  stored.oldFiles.forEach(removeFile);

  return recoveryStatus(requestId, token);
};

const recoveryResubmit = async (requestId, token) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const request = await recoveryByToken(client, requestId, token);
    if (request.status !== 'more_info_required') throw error(409, 'This request is not waiting for you', 'NOT_EDITABLE');
    await client.query("UPDATE shopper_change_requests SET status = 'pending_review', submitted_at = NOW(), updated_at = NOW() WHERE id = $1", [request.id]);
    await addEvent(client, request.id, { action: 'resubmitted', from: 'more_info_required', to: 'pending_review', actorType: 'public' });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  return recoveryStatus(requestId, token);
};

// ---------------------------------------------------
// Admin (Owner / Operations)
// ---------------------------------------------------

const adminList = async ({ type, status = 'open', q, page = 1, pageSize = 25 } = {}) => {
  const where = [];
  const values = [];

  if (TYPE_LABELS[type]) {
    values.push(type);
    where.push(`r.type = $${values.length}`);
  }

  if (status === 'open') {
    where.push("r.status IN ('pending_review', 'more_info_required', 'pending_verification')");
  } else if (STATUS_LABELS[status]) {
    values.push(status);
    where.push(`r.status = $${values.length}`);
  }

  if (q) {
    values.push(`%${String(q).trim().toLowerCase()}%`);
    where.push(`(LOWER(sh.full_name) LIKE $${values.length} OR sh.mobile LIKE $${values.length} OR r.proposed_mobile LIKE $${values.length})`);
  }

  const size = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const offset = (Math.max(1, Number(page) || 1) - 1) * size;
  const sql = `FROM shopper_change_requests r JOIN shoppers sh ON sh.id = r.shopper_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

  const [rows, count, summary] = await Promise.all([
    pool.query(
      `SELECT r.*, sh.full_name AS shopper_name, sh.mobile AS shopper_mobile, sh.shopper_code ${sql}
       ORDER BY (r.status = 'pending_review') DESC, r.submitted_at ASC NULLS LAST, r.created_at DESC LIMIT ${size} OFFSET ${offset}`,
      values
    ),
    pool.query(`SELECT COUNT(*)::int AS n ${sql}`, values),
    pool.query("SELECT type, status, COUNT(*)::int AS n FROM shopper_change_requests WHERE status <> 'draft' GROUP BY type, status"),
  ]);

  return {
    requests: rows.rows.map((row) => ({
      id: Number(row.id),
      type: row.type,
      typeLabel: TYPE_LABELS[row.type],
      status: row.status,
      statusLabel: STATUS_LABELS[row.status],
      shopperId: Number(row.shopper_id),
      shopperName: row.shopper_name,
      shopperMobile: row.shopper_mobile,
      shopperCode: row.shopper_code,
      riskFlags: (row.risk_flags || []).map((flag) => flag.label),
      // For the list's 'change' column (no secrets: licence / NIC are last 4)
      current: row.current_values || {},
      proposed: { ...(row.proposed_values || {}), ...(row.proposed_mobile ? { mobile: row.proposed_mobile } : {}) },
      submittedAt: row.submitted_at,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
    })),
    total: count.rows[0].n,
    page: Math.max(1, Number(page) || 1),
    pageSize: size,
    summary: summary.rows,
  };
};

const adminDetail = async (requestId) => {
  await applications.loadSettings();
  const request = (
    await pool.query(
      `SELECT r.*, sh.full_name AS shopper_name, sh.mobile AS shopper_mobile, sh.approval_status, ad.full_name AS reviewer_name
       FROM shopper_change_requests r
       JOIN shoppers sh ON sh.id = r.shopper_id
       LEFT JOIN admins ad ON ad.id = r.reviewed_by
       WHERE r.id = $1`,
      [Number(requestId)]
    )
  ).rows[0];

  if (!request) throw error(404, 'Request not found');

  const docs = await currentDocuments(request.id);
  const events = (
    await pool.query(
      `SELECT e.*, ad.full_name AS admin_name FROM shopper_change_request_events e
       LEFT JOIN admins ad ON e.actor_type = 'admin' AND ad.id = e.actor_id
       WHERE e.request_id = $1 ORDER BY e.created_at, e.id`,
      [request.id]
    )
  ).rows;
  const application = (
    await pool.query(
      `SELECT a.id, a.licence_encrypted, a.nic_encrypted,
         (SELECT json_agg(json_build_object('id', d.id, 'type', d.doc_type)) FROM shopper_application_documents d
          WHERE d.application_id = a.id AND d.replaced_at IS NULL AND d.deleted_at IS NULL AND d.doc_type IN ('selfie', 'nic_front', 'licence_front')) AS docs
       FROM shopper_applications a WHERE a.shopper_id = $1`,
      [request.shopper_id]
    )
  ).rows[0];
  const history = (
    await pool.query('SELECT * FROM shopper_profile_history WHERE shopper_id = $1 ORDER BY created_at DESC LIMIT 50', [request.shopper_id])
  ).rows;

  const safeDecrypt = (value) => {
    try {
      return value ? decryptIdentity(value) : null;
    } catch {
      return null;
    }
  };

  return {
    ...toPublic(request, docs, { basePath: '/api/admin/shopper-change-requests' }),
    shopperId: Number(request.shopper_id),
    shopperName: request.shopper_name,
    shopperMobile: request.shopper_mobile,
    shopperApprovalStatus: request.approval_status,
    // Full secrets for the reviewing admin only
    proposedLicenceNumber: safeDecrypt(request.proposed_licence_encrypted),
    proposedNicNumber: safeDecrypt(request.proposed_nic_encrypted),
    currentLicenceNumber: safeDecrypt(application?.licence_encrypted),
    currentNicNumber: safeDecrypt(application?.nic_encrypted),
    verificationDetail: request.verification || {},
    riskFlags: request.risk_flags || [],
    reviewedBy: request.reviewer_name || null,
    // The registration's selfie / NIC / licence to compare with
    registrationDocuments: application
      ? (application.docs || []).map((doc) => ({
          type: doc.type,
          label: applications.DOC_TYPES[doc.type]?.label,
          url: `/api/admin/shopper-applications/${application.id}/documents/${doc.id}`,
        }))
      : [],
    events: events.map((event) => ({
      id: Number(event.id),
      action: event.action,
      from: event.from_status,
      to: event.to_status,
      actorType: event.actor_type,
      actorName: event.actor_type === 'admin' ? event.admin_name || `Admin ${event.actor_id}` : event.actor_type === 'shopper' ? 'Shopper' : event.actor_type === 'public' ? 'Requester (signed out)' : 'System',
      note: event.note,
      at: event.created_at,
    })),
    profileHistory: history.map((item) => ({
      id: Number(item.id),
      field: item.field,
      oldValue: item.old_value,
      newValue: item.new_value,
      changeRequestId: item.change_request_id != null ? Number(item.change_request_id) : null,
      changedByType: item.changed_by_type,
      changedById: item.changed_by_id != null ? Number(item.changed_by_id) : null,
      at: item.created_at,
    })),
  };
};

const writeHistory = (client, shopperId, field, oldValue, newValue, requestId, adminId) =>
  client.query(
    `INSERT INTO shopper_profile_history (shopper_id, field, old_value, new_value, change_request_id, changed_by_type, changed_by_id)
     VALUES ($1, $2, $3, $4, $5, 'admin', $6)`,
    [shopperId, field, oldValue == null ? null : String(oldValue).slice(0, 200), newValue == null ? null : String(newValue).slice(0, 200), requestId, adminId]
  );

// The approved request's new values onto the account (transaction)
const applyChange = async (client, request, adminId) => {
  const shopperId = request.shopper_id;
  const row = await registeredProfile(client, shopperId);
  const proposed = request.proposed_values || {};

  if (request.type === 'phone_change' || request.type === 'phone_recovery') {
    return applyPhoneChange(client, request, { actorType: 'admin', actorId: adminId });
  }

  if (request.type === 'vehicle_change') {
    const active = (
      await client.query('SELECT COUNT(*)::int AS n FROM orders WHERE shopper_id = $1 AND status = ANY($2)', [shopperId, ACTIVE_ORDER_STATUSES])
    ).rows[0].n;

    if (active > 0) {
      throw error(409, 'The shopper has an order in progress. Approve the vehicle change after it is delivered.', 'ACTIVE_ORDERS');
    }

    const taken = (
      await client.query("SELECT 1 FROM shoppers WHERE UPPER(vehicle_number) = $1 AND id <> $2 AND approval_status IN ('approved', 'pending')", [proposed.vehicleNumber, shopperId])
    ).rows.length > 0;

    if (taken) throw error(409, 'This vehicle is now registered to another shopper', 'VEHICLE_IN_USE');

    const fields = [
      ['vehicle_type', row.vehicle_type, proposed.vehicleType],
      ['vehicle_number', row.vehicle_number, proposed.vehicleNumber],
      ['vehicle_make', row.vehicle_make, proposed.vehicleMake],
      ['vehicle_model', row.vehicle_model, proposed.vehicleModel],
      ['licence_expiry', applications.isoDate(row.licence_expiry), proposed.licenceExpiry],
    ];

    await client.query(
      `UPDATE shoppers
       SET vehicle_type = $2, vehicle_number = $3, vehicle_make = $4, vehicle_model = $5, licence_expiry = $6,
           vehicle_restriction = NULL, vehicle_restricted_at = NULL, vehicle_restricted_by = NULL, updated_at = NOW()
       WHERE id = $1`,
      [shopperId, proposed.vehicleType, proposed.vehicleNumber, proposed.vehicleMake, proposed.vehicleModel, proposed.licenceExpiry]
    );

    for (const [field, before, after] of fields) {
      if (String(before ?? '') !== String(after ?? '')) await writeHistory(client, shopperId, field, before, after, request.id, adminId);
    }

    if (row.is_registered_owner !== proposed.isRegisteredOwner) {
      await writeHistory(client, shopperId, 'registered_owner', row.is_registered_owner == null ? null : row.is_registered_owner ? 'yes' : 'no', proposed.isRegisteredOwner ? 'yes' : 'no', request.id, adminId);
    }

    if (row.vehicle_restriction) await writeHistory(client, shopperId, 'vehicle_restriction', row.vehicle_restriction, null, request.id, adminId);

    // Keep the registration record in step
    if (row.application_id) {
      await client.query(
        `UPDATE shopper_applications
         SET vehicle_type = $2, vehicle_number = $3, is_registered_owner = $4, licence_expiry = $5,
             licence_encrypted = COALESCE($6, licence_encrypted), licence_last4 = COALESCE($7, licence_last4), updated_at = NOW()
         WHERE id = $1`,
        [row.application_id, proposed.vehicleType, proposed.vehicleNumber, proposed.isRegisteredOwner, proposed.licenceExpiry, request.proposed_licence_encrypted || null, request.proposed_licence_encrypted ? proposed.licenceLast4 : null]
      );
      if (request.proposed_licence_encrypted) {
        await writeHistory(client, shopperId, 'licence_number', row.licence_last4 ? `••••${row.licence_last4}` : null, `••••${proposed.licenceLast4}`, request.id, adminId);
      }
    }

    // The verified vehicle record (the previous one kept as history)
    await applications.recordVerifiedVehicle(client, {
      shopperId,
      sourceType: 'change_request',
      sourceId: request.id,
      vehicle: proposed,
      documents: (request.acceptedDocuments || []).map((doc) => ({ id: Number(doc.id), type: doc.doc_type })),
      adminId,
    });

    return { vehicle: proposed };
  }

  if (request.type === 'identity_change') {
    if (proposed.nameChanged) {
      await client.query('UPDATE shoppers SET full_name = $2, updated_at = NOW() WHERE id = $1', [shopperId, proposed.fullName]);
      if (row.application_id) await client.query('UPDATE shopper_applications SET full_name = $2, updated_at = NOW() WHERE id = $1', [row.application_id, proposed.fullName]);
      await writeHistory(client, shopperId, 'full_name', row.full_name, proposed.fullName, request.id, adminId);
    }

    if (proposed.nicChanged && request.proposed_nic_encrypted) {
      if (!row.application_id) throw error(409, 'This shopper has no registration record to hold a NIC', 'NO_APPLICATION');
      await client.query(
        'UPDATE shopper_applications SET nic_encrypted = $2, nic_hash = $3, nic_last4 = $4, updated_at = NOW() WHERE id = $1',
        [row.application_id, request.proposed_nic_encrypted, request.proposed_nic_hash, proposed.nicLast4]
      );
      await writeHistory(client, shopperId, 'nic', row.nic_last4 ? `•••••••${row.nic_last4}` : null, `•••••••${proposed.nicLast4}`, request.id, adminId);
    }

    return { identity: proposed };
  }

  throw error(400, 'Unknown request type');
};

const REVIEW_TRANSITIONS = {
  request_info: { from: ['pending_review'], to: 'more_info_required' },
  approve: { from: ['pending_review'], to: 'approved' },
  reject: { from: ['pending_review', 'more_info_required', 'pending_verification'], to: 'rejected' },
};

// PATCH /api/admin/shopper-change-requests/:id { action, reason, items }
const adminAction = async (requestId, action, input = {}, adminId) => {
  await applications.loadSettings();
  const rule = REVIEW_TRANSITIONS[action];
  if (!rule) throw error(400, 'Unknown action');

  const reason = clean(input.reason, 500);
  if ((action === 'reject' || action === 'request_info') && reason.length < 5) {
    throw error(400, action === 'reject' ? 'Give the reason for rejecting (the shopper sees it)' : 'Explain what the shopper must add', 'REASON_REQUIRED');
  }

  const client = await pool.connect();
  let applied = null;
  let request;

  try {
    await client.query('BEGIN');
    const peek = (await client.query('SELECT shopper_id FROM shopper_change_requests WHERE id = $1', [Number(requestId)])).rows[0];
    if (!peek) throw error(404, 'Request not found');

    await lockShopper(client, peek.shopper_id);
    request = (await client.query('SELECT * FROM shopper_change_requests WHERE id = $1 FOR UPDATE', [Number(requestId)])).rows[0];

    if (!rule.from.includes(request.status)) {
      throw error(409, `This request is ${STATUS_LABELS[request.status].toLowerCase()}; it can't be ${{ request_info: 'sent back', approve: 'approved', reject: 'rejected' }[action]} now`, 'WRONG_STATUS');
    }

    if (action === 'request_info' && request.type === 'phone_change') {
      throw error(409, 'Phone changes have nothing to upload: approve or reject', 'NOT_SUPPORTED');
    }

    if (action === 'approve') {
      const docs = await currentDocuments(request.id, client);
      const missing = requiredDocs(request).filter((type) => !docs.some((doc) => doc.doc_type === type));
      if (missing.length) throw error(409, 'Documents are missing', 'DOCUMENTS_MISSING');

      // Every required document / photo accepted one by one (phase 36)
      const notAccepted = requiredDocs(request).filter((type) => docs.find((doc) => doc.doc_type === type)?.review_status !== 'accepted');
      if (notAccepted.length) {
        throw error(409, `Review and accept every document first: ${notAccepted.map((type) => applications.DOC_TYPES[type]?.label || type).join(', ')}`, 'DOCUMENTS_NOT_REVIEWED');
      }
      request.acceptedDocuments = docs;
      applied = await applyChange(client, request, adminId);
    }

    const infoRequest =
      action === 'request_info'
        ? {
            message: reason,
            items: (Array.isArray(input.items) ? input.items : [])
              .map(String)
              .filter((key) => applications.DOC_TYPES[key])
              .map((key) => ({ key, label: applications.DOC_TYPES[key].label })),
            requestedAt: new Date().toISOString(),
          }
        : null;

    await client.query(
      `UPDATE shopper_change_requests
       SET status = $2::varchar,
           info_request = CASE WHEN $2::varchar = 'more_info_required' THEN $3::jsonb ELSE info_request END,
           decision_reason = $4::varchar,
           reviewed_by = $5::int, reviewed_at = NOW(),
           completed_at = CASE WHEN $2::varchar = 'approved' THEN NOW() ELSE completed_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [request.id, rule.to, infoRequest ? JSON.stringify(infoRequest) : null, reason || null, adminId]
    );

    await addEvent(client, request.id, { action, from: request.status, to: rule.to, actorType: 'admin', actorId: adminId, note: reason || (action === 'approve' ? 'Approved and applied' : null) });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') throw error(409, 'That number or value is already used by another account', 'DUPLICATE');
    throw caught;
  } finally {
    client.release();
  }

  // Tell the shopper on the numbers we have (SMS only when configured)
  if (action === 'approve' && applied?.newMobile && sms.isConfigured()) {
    const text = 'Your GetMe shopper account number was changed. If this was not you, contact GetMe support now.';
    await Promise.allSettled([sms.sendSms(applied.oldMobile, text), sms.sendSms(applied.newMobile, text)]);
  }

  return { applied, request: await adminDetail(requestId), shopperId: Number(request.shopper_id), type: request.type };
};

// PATCH /api/admin/shoppers/:id/vehicle-restriction { restricted, reason }
const setVehicleRestriction = async (shopperId, input = {}, adminId) => {
  const restricted = input.restricted !== false;
  const reason = clean(input.reason, 300);

  if (restricted && reason.length < 5) throw error(400, 'Give the reason (the shopper sees it)', 'REASON_REQUIRED');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const before = (await client.query('SELECT vehicle_restriction FROM shoppers WHERE id = $1 FOR UPDATE', [Number(shopperId)])).rows[0];
    if (!before) throw error(404, 'Shopper not found');

    await client.query(
      `UPDATE shoppers
       SET vehicle_restriction = $2, vehicle_restricted_at = CASE WHEN $2::varchar IS NULL THEN NULL ELSE NOW() END,
           vehicle_restricted_by = CASE WHEN $2::varchar IS NULL THEN NULL ELSE $3::int END,
           status = CASE WHEN $2::varchar IS NULL THEN status ELSE 'offline' END, updated_at = NOW()
       WHERE id = $1`,
      [Number(shopperId), restricted ? reason : null, adminId]
    );
    await writeHistory(client, Number(shopperId), 'vehicle_restriction', before.vehicle_restriction, restricted ? reason : null, null, adminId);
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  return { restricted, reason: restricted ? reason : null };
};

const profileHistory = async (shopperId) =>
  (
    await pool.query(
      `SELECT h.*, ad.full_name AS admin_name FROM shopper_profile_history h
       LEFT JOIN admins ad ON h.changed_by_type = 'admin' AND ad.id = h.changed_by_id
       WHERE h.shopper_id = $1 ORDER BY h.created_at DESC, h.id DESC LIMIT 100`,
      [Number(shopperId)]
    )
  ).rows.map((item) => ({
    id: Number(item.id),
    field: item.field,
    oldValue: item.old_value,
    newValue: item.new_value,
    changeRequestId: item.change_request_id != null ? Number(item.change_request_id) : null,
    changedBy: item.changed_by_type === 'admin' ? item.admin_name || `Admin ${item.changed_by_id}` : item.changed_by_type === 'shopper' ? 'Shopper (verified by SMS)' : 'System',
    at: item.created_at,
  }));

// PATCH /api/admin/shopper-change-requests/:id/documents/:docId
//   { decision: accept | reject, note }
const reviewDocument = async (requestId, documentId, input = {}, adminId) => {
  const decision = String(input.decision || '');
  const note = clean(input.note, 300);

  if (!['accept', 'reject'].includes(decision)) throw error(400, 'Choose accept or reject', 'INVALID_DECISION');
  if (decision === 'reject' && note.length < 3) throw error(400, 'Say what is wrong with it (the shopper sees it)', 'REASON_REQUIRED');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const request = (await client.query('SELECT * FROM shopper_change_requests WHERE id = $1 FOR UPDATE', [Number(requestId)])).rows[0];
    if (!request) throw error(404, 'Request not found');
    if (!['pending_review', 'more_info_required'].includes(request.status)) {
      throw error(409, `Documents are reviewed while the request is pending (it is ${STATUS_LABELS[request.status].toLowerCase()})`, 'WRONG_STATUS');
    }

    const doc = (
      await client.query(
        `UPDATE shopper_change_request_documents
         SET review_status = $3, review_note = $4, reviewed_by = $5, reviewed_at = NOW()
         WHERE id = $1 AND request_id = $2 AND replaced_at IS NULL AND deleted_at IS NULL
         RETURNING doc_type`,
        [Number(documentId), request.id, decision === 'accept' ? 'accepted' : 'rejected', note || null, adminId]
      )
    ).rows[0];

    if (!doc) throw error(404, 'Document not found');

    await addEvent(client, request.id, {
      action: decision === 'accept' ? 'document_accepted' : 'document_rejected',
      actorType: 'admin',
      actorId: adminId,
      note: `${applications.DOC_TYPES[doc.doc_type]?.label || doc.doc_type}${note ? `: ${note}` : ''}`,
    });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  return adminDetail(requestId);
};

module.exports = {
  reviewDocument,
  STATUS_LABELS,
  TYPE_LABELS,
  eligibilityBlock,
  eligibleSql,
  myOverview,
  saveRequest,
  getMyRequest,
  uploadMyDocument,
  submitMyRequest,
  cancelMyRequest,
  documentFile,
  startPhoneChange,
  verifyPhoneChange,
  resendPhoneCode,
  startRecovery,
  recoveryStatus,
  recoveryUpload,
  recoveryResubmit,
  adminList,
  adminDetail,
  adminAction,
  setVehicleRestriction,
  profileHistory,
};
