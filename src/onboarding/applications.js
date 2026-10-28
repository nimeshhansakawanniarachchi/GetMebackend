const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const pool = require('../config/db');
const { encryptIdentity, decryptIdentity, hashIdentity } = require('./identityVault');
const { normalizeSriLankanMobile } = require('../utils/phone');

// =====================================================
// SHOPPER APPLICATIONS (phase 34, owner's choices 2026-10-28)
// The step-by-step registration behind the Shopper App's onboarding:
//   1 personal     full name (as on the NIC), date of birth (18+),
//                  email; mobile is the account's, verified
//                  by SMS code when Notify.lk is configured
//   2 identity     NIC number (old 9 digits + V/X or new 12 digits,
//                  date of birth must match it), NIC front + back,
//                  selfie
//   3 vehicle      Bike / Tuk / Car, vehicle number, driving licence
//                  number + expiry + front/back, Certificate of
//                  Registration; owner's letter when not the owner
//   4 address      address, city, district, service area, emergency
//                  contact
//   5 payout       bank account (wallet payout account, encrypted)
//   6 review       terms + privacy consent, submit
// The backend decides what is complete; the app only shows it.
// Editing is allowed in draft / more_info_required.
// Sensitive values never leave this module unmasked except to Owner /
// Operations admins (adminDetail) and are never logged.
// =====================================================

const TERMS_VERSION = '2026-10-28';

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  under_review: 'Under review',
  more_info_required: 'More information required',
  approved: 'Approved',
  rejected: 'Rejected',
};

const EDITABLE = ['draft', 'more_info_required'];

const VEHICLES = {
  motorbike: 'Bike',
  'three-wheeler': 'Tuk',
  car: 'Car',
};

// The 25 districts of Sri Lanka
const DISTRICTS = [
  'Ampara', 'Anuradhapura', 'Badulla', 'Batticaloa', 'Colombo', 'Galle', 'Gampaha', 'Hambantota',
  'Jaffna', 'Kalutara', 'Kandy', 'Kegalle', 'Kilinochchi', 'Kurunegala', 'Mannar', 'Matale',
  'Matara', 'Monaragala', 'Mullaitivu', 'Nuwara Eliya', 'Polonnaruwa', 'Puttalam', 'Ratnapura',
  'Trincomalee', 'Vavuniya',
];

const DOC_TYPES = {
  nic_front: { label: 'NIC (front)', step: 'identity' },
  nic_back: { label: 'NIC (back)', step: 'identity' },
  selfie: { label: 'Selfie', step: 'identity' },
  licence_front: { label: 'Driving licence (front)', step: 'vehicle' },
  licence_back: { label: 'Driving licence (back)', step: 'vehicle' },
  vehicle_cr: { label: 'Certificate of Registration (CR)', step: 'vehicle' },
  owner_letter: { label: "Owner's authorisation letter", step: 'vehicle' },
  // Vehicle photos (phase 36); which ones a vehicle type needs comes
  // from settings.vehiclePhotos
  vehicle_front: { label: 'Vehicle photo (front)', step: 'vehicle', photo: true },
  vehicle_side: { label: 'Vehicle photo (side)', step: 'vehicle', photo: true },
  vehicle_rear: { label: 'Vehicle photo (rear, number plate)', step: 'vehicle', photo: true },
  vehicle_interior: { label: 'Vehicle photo (interior)', step: 'vehicle', photo: true },
};

const FIELD_LABELS = {
  full_name: 'Full name',
  date_of_birth: 'Date of birth',
  email: 'Email',
  nic: 'NIC number',
  vehicle_type: 'Vehicle type',
  vehicle_number: 'Vehicle number',
  is_registered_owner: 'Vehicle ownership',
  licence: 'Driving licence number',
  licence_expiry: 'Licence expiry date',
  address_line: 'Address',
  city: 'City',
  district: 'District',
  emergency_contact: 'Emergency contact',
  payout_account: 'Bank account',
  consent: 'Terms and privacy consent',
};

const STEPS = ['personal', 'identity', 'vehicle', 'address', 'payout', 'review'];

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
// Paper documents may be a PDF scan; photos of the person must be images
const PDF_ALLOWED = ['vehicle_cr', 'owner_letter'];
const MAX_BYTES = 8 * 1024 * 1024;

const STORAGE_DIR = path.resolve(__dirname, '..', '..', 'private-uploads', 'shopper-applications');

const RETENTION_DAYS = 90;

const error = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const isoDate = (value) => {
  if (!value) return null;

  // pg returns a DATE as local midnight: format with local parts (UTC
  // would be the day before in Sri Lanka, +05:30)
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

// ---------------------------------------------------
// NIC (Sri Lanka): old 9 digits + V/X (19YY), new 12 digits (YYYY).
// Day of year > 500 for women. NIC day numbers count February as 29
// days every year.
// -> { normalized, dateOfBirth } | null
// ---------------------------------------------------
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const parseNic = (value) => {
  const raw = String(value || '').replace(/\s+/g, '').toUpperCase();
  let year;
  let days;

  if (/^\d{9}[VX]$/.test(raw)) {
    year = 1900 + Number(raw.slice(0, 2));
    days = Number(raw.slice(2, 5));
  } else if (/^\d{12}$/.test(raw)) {
    year = Number(raw.slice(0, 4));
    days = Number(raw.slice(4, 7));
  } else {
    return null;
  }

  if (days > 500) days -= 500;
  if (days < 1 || days > 366 || year < 1900) return null;

  let month = 0;
  let left = days;

  while (month < 12 && left > MONTH_DAYS[month]) {
    left -= MONTH_DAYS[month];
    month += 1;
  }

  if (month >= 12) return null;

  // Feb 29 in a non-leap year doesn't exist
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  if (month === 1 && left === 29 && !leap) return null;

  return {
    normalized: raw,
    dateOfBirth: `${year}-${String(month + 1).padStart(2, '0')}-${String(left).padStart(2, '0')}`,
  };
};

const ageOn = (dob, now = new Date()) => {
  const birth = new Date(`${dob}T00:00:00Z`);
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate());
  return beforeBirthday ? age - 1 : age;
};

// Sri Lankan vehicle numbers: "WP CAB-1234", "CAB-1234", "AB-1234",
// older "64-1234" / "301-1234"
const normalizeVehicleNumber = (value) => {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const match = raw.match(/^([A-Z]{2})?([A-Z]{2,3}|\d{1,3})(\d{4})$/);

  if (!match) return null;

  return `${match[1] ? `${match[1]} ` : ''}${match[2]}-${match[3]}`;
};

// Driving licence numbers: a letter + digits (e.g. B1234567) or digits
const normalizeLicence = (value) => {
  const raw = String(value || '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z]?\d{5,12}$/.test(raw) ? raw : null;
};

// ---------------------------------------------------
// Records
// ---------------------------------------------------

const currentDocuments = async (applicationId, client = pool) =>
  (
    await client.query(
      `
      SELECT * FROM shopper_application_documents
      WHERE application_id = $1 AND replaced_at IS NULL AND deleted_at IS NULL
      ORDER BY id
      `,
      [applicationId]
    )
  ).rows;

// Photos a vehicle type needs (settings.vehiclePhotos; callers load the
// settings first so the rules are current)
const vehiclePhotosFor = (vehicleType) =>
  (vehicleType && require('../pricing/settings').vehiclePhotoRules()[vehicleType]) || [];

const requiredDocs = (app) => {
  const docs = ['nic_front', 'nic_back', 'selfie', 'licence_front', 'licence_back', 'vehicle_cr'];
  if (app.is_registered_owner === false) docs.push('owner_letter');
  docs.push(...vehiclePhotosFor(app.vehicle_type));
  return docs;
};

const loadSettings = () => require('../pricing/settings').getPricingSettings().catch(() => null);

// What is still missing per step (the server's view of "complete")
const stepStatus = (app, docs, payoutAccount) => {
  // A rejected document counts as missing until it is replaced (phase 36)
  const have = new Set(docs.filter((doc) => doc.review_status !== 'rejected').map((doc) => doc.doc_type));
  const missingDocs = (types) => types.filter((type) => !have.has(type));

  const personal = [];
  if (!app.full_name) personal.push('full_name');
  if (!app.date_of_birth) personal.push('date_of_birth');

  const identity = [];
  if (!app.nic_hash) identity.push('nic');
  identity.push(...missingDocs(['nic_front', 'nic_back', 'selfie']));

  const vehicle = [];
  if (!app.vehicle_type) vehicle.push('vehicle_type');
  if (!app.vehicle_number) vehicle.push('vehicle_number');
  if (app.is_registered_owner == null) vehicle.push('is_registered_owner');
  if (!app.licence_encrypted) vehicle.push('licence');
  if (!app.licence_expiry) vehicle.push('licence_expiry');
  vehicle.push(...missingDocs(requiredDocs(app).filter((type) => DOC_TYPES[type].step === 'vehicle')));

  const address = [];
  if (!app.address_line) address.push('address_line');
  if (!app.city) address.push('city');
  if (!app.district) address.push('district');
  if (!app.emergency_name || !app.emergency_phone) address.push('emergency_contact');

  const payout = [];
  if (!payoutAccount) payout.push('payout_account');

  const review = [];
  if (!app.terms_accepted_at || !app.privacy_accepted_at) review.push('consent');

  const steps = { personal, identity, vehicle, address, payout, review };

  return STEPS.map((key) => ({
    key,
    complete: steps[key].length === 0,
    missing: steps[key].map((item) => ({ key: item, label: DOC_TYPES[item]?.label || FIELD_LABELS[item] || item })),
  }));
};

const payoutAccountOf = async (app, client = pool) =>
  app.payout_account_id
    ? (
        await client.query(
          'SELECT * FROM shopper_payout_accounts WHERE id = $1 AND shopper_id = $2 AND deleted_at IS NULL',
          [app.payout_account_id, app.shopper_id]
        )
      ).rows[0] || null
    : null;

const publicDocument = (doc, basePath) => ({
  id: Number(doc.id),
  type: doc.doc_type,
  label: DOC_TYPES[doc.doc_type]?.label || doc.doc_type,
  mimeType: doc.mime_type,
  sizeBytes: Number(doc.size_bytes),
  uploadedAt: doc.uploaded_at,
  // Reviewed one by one by an admin (phase 36): an upload is not a
  // verified document until it is accepted
  reviewStatus: doc.review_status || 'pending',
  reviewNote: doc.review_note || null,
  reviewedAt: doc.reviewed_at || null,
  // Authenticated download (never a public /uploads link)
  url: `${basePath}/${doc.id}`,
});

const publicAccount = (row) =>
  row
    ? {
        id: Number(row.id),
        bankName: row.bank_name,
        branchName: row.branch_name,
        accountHolderName: row.account_holder_name,
        accountLast4: row.account_last4,
        accountNumberMasked: `•••• ${row.account_last4}`,
        status: row.status,
        statusNote: row.status_note || null,
      }
    : null;

// The applicant's own view (NIC / licence masked)
const toApplicantView = (app, docs, payoutAccount) => ({
  id: Number(app.id),
  status: app.status,
  statusLabel: STATUS_LABELS[app.status] || app.status,
  editable: EDITABLE.includes(app.status),
  personal: {
    fullName: app.full_name || '',
    dateOfBirth: isoDate(app.date_of_birth),
    email: app.email || '',
    phoneVerified: Boolean(app.phone_verified_at),
    phoneVerifiedBy: app.phone_verified_by || null,
  },
  identity: {
    nicMasked: app.nic_last4 ? `•••••••${app.nic_last4}` : null,
  },
  vehicle: {
    vehicleType: app.vehicle_type || null,
    vehicleLabel: VEHICLES[app.vehicle_type] || null,
    vehicleNumber: app.vehicle_number || '',
    isRegisteredOwner: app.is_registered_owner,
    licenceMasked: app.licence_last4 ? `••••${app.licence_last4}` : null,
    licenceExpiry: isoDate(app.licence_expiry),
  },
  address: {
    addressLine: app.address_line || '',
    city: app.city || '',
    district: app.district || '',
    serviceArea: app.service_area || '',
    emergencyName: app.emergency_name || '',
    emergencyPhone: app.emergency_phone || '',
    emergencyRelation: app.emergency_relation || '',
  },
  payoutAccount: publicAccount(payoutAccount),
  consent: {
    termsAccepted: Boolean(app.terms_accepted_at),
    privacyAccepted: Boolean(app.privacy_accepted_at),
    termsVersion: app.terms_version || null,
  },
  documents: docs.map((doc) => publicDocument(doc, '/api/shopper/application/documents')),
  requiredDocuments: requiredDocs(app),
  steps: stepStatus(app, docs, payoutAccount),
  infoRequest: app.status === 'more_info_required' ? app.info_request || null : null,
  decisionReason: ['rejected', 'more_info_required'].includes(app.status) ? app.decision_reason || null : null,
  submittedAt: app.submitted_at,
  reviewedAt: app.reviewed_at,
  documentsDeleted: Boolean(app.documents_deleted_at),
  updatedAt: app.updated_at,
});

const RULES = {
  termsVersion: TERMS_VERSION,
  vehicles: Object.entries(VEHICLES).map(([value, label]) => ({ value, label })),
  districts: DISTRICTS,
  documentTypes: Object.entries(DOC_TYPES).map(([value, info]) => ({ value, ...info, pdfAllowed: PDF_ALLOWED.includes(value) })),
  maxUploadBytes: MAX_BYTES,
  minimumAge: 18,
  steps: STEPS,
};

const addEvent = (client, applicationId, { action, from = null, to = null, actorType, actorId = null, note = null }) =>
  client.query(
    `
    INSERT INTO shopper_application_events (application_id, action, from_status, to_status, actor_type, actor_id, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [applicationId, action, from, to, actorType, actorId, note ? String(note).slice(0, 500) : null]
  );

const lockApplication = async (client, shopperId) =>
  (await client.query('SELECT * FROM shopper_applications WHERE shopper_id = $1 FOR UPDATE', [Number(shopperId)])).rows[0] || null;

// A pending shopper always has an application (created on first
// look); approved shoppers from before phase 34 don't need one
const ensureApplication = async (shopperId, client = pool) => {
  const shopper = (
    await client.query('SELECT id, shopper_code, full_name, email, approval_status FROM shoppers WHERE id = $1', [Number(shopperId)])
  ).rows[0];

  if (!shopper) throw error(404, 'Shopper not found');

  const existing = (await client.query('SELECT * FROM shopper_applications WHERE shopper_id = $1', [shopper.id])).rows[0];

  if (existing || shopper.approval_status === 'approved' || shopper.approval_status === 'suspended') {
    return { shopper, application: existing || null };
  }

  const created = (
    await client.query(
      `
      INSERT INTO shopper_applications (shopper_id, full_name, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (shopper_id) DO UPDATE SET updated_at = shopper_applications.updated_at
      RETURNING *
      `,
      [shopper.id, shopper.full_name || null, shopper.email || null]
    )
  ).rows[0];

  return { shopper, application: created };
};

// GET /api/shopper/application
const getForShopper = async (shopperId) => {
  await loadSettings();
  const { shopper, application } = await ensureApplication(shopperId);

  if (!application) {
    // Approved before phase 34 (or suspended): nothing to fill in
    return { required: false, approvalStatus: shopper.approval_status, application: null, rules: RULES };
  }

  const docs = await currentDocuments(application.id);
  const payoutAccount = await payoutAccountOf(application);

  return {
    required: application.status !== 'approved',
    approvalStatus: shopper.approval_status,
    shopperCode: shopper.shopper_code || null,
    application: toApplicantView(application, docs, payoutAccount),
    rules: { ...RULES, banks: require('../wallet/shopperWallet').BANKS, vehiclePhotos: require('../pricing/settings').vehiclePhotoRules() },
    smsConfigured: require('./sms').isConfigured(),
  };
};

// ---------------------------------------------------
// Saving a step (PATCH /api/shopper/application { step, ...fields })
// ---------------------------------------------------

const validatePersonal = (input) => {
  const fullName = clean(input.fullName, 120);
  const dateOfBirth = isoDate(input.dateOfBirth);
  const email = clean(input.email, 160).toLowerCase();

  if (fullName.length < 3 || !/^[\p{L} .'-]+$/u.test(fullName) || !/\s/.test(fullName)) {
    throw error(400, 'Enter your full name exactly as on your NIC (first name and surname)', 'INVALID_NAME', { field: 'fullName' });
  }

  if (!dateOfBirth) {
    throw error(400, 'Enter your date of birth', 'INVALID_DOB', { field: 'dateOfBirth' });
  }

  const age = ageOn(dateOfBirth);

  if (age < RULES.minimumAge) {
    throw error(400, `You must be at least ${RULES.minimumAge} years old to shop for GetMe`, 'TOO_YOUNG', { field: 'dateOfBirth' });
  }

  if (age > 100) {
    throw error(400, 'Check your date of birth', 'INVALID_DOB', { field: 'dateOfBirth' });
  }

  // Required: it is the account's sign-in email (shoppers.email)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw error(400, 'Enter a valid email address', 'INVALID_EMAIL', { field: 'email' });
  }

  return { fullName, dateOfBirth, email: email || null };
};

const saveStep = async (shopperId, input = {}) => {
  const step = String(input.step || '');

  if (!['personal', 'identity', 'vehicle', 'address', 'payout'].includes(step)) {
    throw error(400, 'Unknown step');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureApplication(shopperId, client);
    const app = await lockApplication(client, shopperId);

    if (!app) throw error(409, 'Your account is already approved', 'NOT_REQUIRED');

    if (!EDITABLE.includes(app.status)) {
      throw error(409, `Your application is ${STATUS_LABELS[app.status].toLowerCase()} and can't be changed now`, 'NOT_EDITABLE');
    }

    if (step === 'personal') {
      const { fullName, dateOfBirth, email } = validatePersonal(input);

      // The NIC already given must still match the date of birth
      if (app.nic_encrypted) {
        const nic = parseNic(decryptIdentity(app.nic_encrypted));
        if (nic && nic.dateOfBirth !== dateOfBirth) {
          throw error(400, "Your date of birth doesn't match your NIC number", 'DOB_NIC_MISMATCH', { field: 'dateOfBirth' });
        }
      }

      if (email) {
        const taken = (
          await client.query('SELECT 1 FROM shoppers WHERE LOWER(email) = $1 AND id <> $2', [email, app.shopper_id])
        ).rows.length > 0;

        if (taken) throw error(409, 'This email is used by another account', 'EMAIL_TAKEN', { field: 'email' });
      }

      await client.query(
        'UPDATE shopper_applications SET full_name = $2, date_of_birth = $3, email = $4, updated_at = NOW() WHERE id = $1',
        [app.id, fullName, dateOfBirth, email]
      );
    }

    if (step === 'identity') {
      const nic = parseNic(input.nicNumber);

      if (!nic) {
        throw error(400, 'Enter a valid NIC number (e.g. 199012345678 or 901234567V)', 'INVALID_NIC', { field: 'nicNumber' });
      }

      const dob = isoDate(app.date_of_birth);

      if (dob && nic.dateOfBirth !== dob) {
        throw error(400, "This NIC number doesn't match your date of birth. Check both.", 'DOB_NIC_MISMATCH', { field: 'nicNumber' });
      }

      const nicHash = hashIdentity(nic.normalized);
      const taken = (
        await client.query(
          "SELECT 1 FROM shopper_applications WHERE nic_hash = $1 AND id <> $2 AND status <> 'rejected'",
          [nicHash, app.id]
        )
      ).rows.length > 0;

      if (taken) {
        throw error(409, 'This NIC is already used on another GetMe shopper application. Contact GetMe support.', 'NIC_IN_USE', { field: 'nicNumber' });
      }

      await client.query(
        'UPDATE shopper_applications SET nic_encrypted = $2, nic_hash = $3, nic_last4 = $4, updated_at = NOW() WHERE id = $1',
        [app.id, encryptIdentity(nic.normalized), nicHash, nic.normalized.slice(-4)]
      );
    }

    if (step === 'vehicle') {
      const vehicleType = String(input.vehicleType || '');
      const vehicleNumber = normalizeVehicleNumber(input.vehicleNumber);
      const licence = normalizeLicence(input.licenceNumber);
      const licenceExpiry = isoDate(input.licenceExpiry);
      const owner = input.isRegisteredOwner;

      if (!VEHICLES[vehicleType]) throw error(400, 'Choose your vehicle: Bike, Tuk or Car', 'INVALID_VEHICLE', { field: 'vehicleType' });
      if (!vehicleNumber) throw error(400, 'Enter the vehicle number as on the registration (e.g. WP CAB-1234)', 'INVALID_VEHICLE_NUMBER', { field: 'vehicleNumber' });
      if (typeof owner !== 'boolean') throw error(400, 'Tell us whether the vehicle is registered in your name', 'OWNER_REQUIRED', { field: 'isRegisteredOwner' });
      if (!licence) throw error(400, 'Enter your driving licence number (e.g. B1234567)', 'INVALID_LICENCE', { field: 'licenceNumber' });
      if (!licenceExpiry) throw error(400, 'Enter the licence expiry date', 'INVALID_LICENCE_EXPIRY', { field: 'licenceExpiry' });
      if (licenceExpiry <= new Date().toISOString().slice(0, 10)) {
        throw error(400, 'Your driving licence has expired. Renew it before applying.', 'LICENCE_EXPIRED', { field: 'licenceExpiry' });
      }

      await client.query(
        `
        UPDATE shopper_applications
        SET vehicle_type = $2, vehicle_number = $3, is_registered_owner = $4,
            licence_encrypted = $5, licence_last4 = $6, licence_expiry = $7, updated_at = NOW()
        WHERE id = $1
        `,
        [app.id, vehicleType, vehicleNumber, owner, encryptIdentity(licence), licence.slice(-4), licenceExpiry]
      );
    }

    if (step === 'address') {
      const addressLine = clean(input.addressLine, 200);
      const city = clean(input.city, 80);
      const district = clean(input.district, 40);
      const serviceArea = clean(input.serviceArea, 120);
      const emergencyName = clean(input.emergencyName, 120);
      const emergencyPhone = normalizeSriLankanMobile(input.emergencyPhone);
      const emergencyRelation = clean(input.emergencyRelation, 40);

      if (addressLine.length < 5) throw error(400, 'Enter your home address', 'INVALID_ADDRESS', { field: 'addressLine' });
      if (city.length < 2) throw error(400, 'Enter your city or town', 'INVALID_CITY', { field: 'city' });
      if (!DISTRICTS.includes(district)) throw error(400, 'Choose your district', 'INVALID_DISTRICT', { field: 'district' });
      if (emergencyName.length < 3) throw error(400, 'Enter an emergency contact name', 'INVALID_EMERGENCY_NAME', { field: 'emergencyName' });
      if (!emergencyPhone) throw error(400, 'Enter a valid Sri Lankan mobile number for your emergency contact', 'INVALID_EMERGENCY_PHONE', { field: 'emergencyPhone' });

      const own = (await client.query('SELECT mobile FROM shoppers WHERE id = $1', [app.shopper_id])).rows[0];

      if (own?.mobile === emergencyPhone) {
        throw error(400, 'Your emergency contact must be someone else', 'EMERGENCY_IS_SELF', { field: 'emergencyPhone' });
      }

      await client.query(
        `
        UPDATE shopper_applications
        SET address_line = $2, city = $3, district = $4, service_area = $5,
            emergency_name = $6, emergency_phone = $7, emergency_relation = $8, updated_at = NOW()
        WHERE id = $1
        `,
        [app.id, addressLine, city, district, serviceArea || district, emergencyName, emergencyPhone, emergencyRelation || null]
      );
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  // Bank account: the wallet's encrypted payout accounts (verified by
  // an admin with the application). Outside the transaction above:
  // addAccount locks the shopper itself.
  if (step === 'payout') {
    const wallet = require('../wallet/shopperWallet');
    const app = (await pool.query('SELECT * FROM shopper_applications WHERE shopper_id = $1', [Number(shopperId)])).rows[0];

    if (!EDITABLE.includes(app.status)) throw error(409, "Your application can't be changed now", 'NOT_EDITABLE');

    // Same account number as the one already given: correct its bank /
    // branch / holder (re-adding it would fail as "already saved")
    if (app.payout_account_id && (await wallet.updatePendingAccountDetails(shopperId, app.payout_account_id, input))) {
      await pool.query('UPDATE shopper_applications SET updated_at = NOW() WHERE id = $1', [app.id]);
      return getForShopper(shopperId);
    }

    const account = await wallet.addAccount(shopperId, input);
    const previous = app.payout_account_id;

    await pool.query('UPDATE shopper_applications SET payout_account_id = $2, updated_at = NOW() WHERE id = $1', [app.id, account.id]);

    if (previous && previous !== account.id) {
      await wallet.removeAccount(shopperId, previous).catch(() => {});
    }
  }

  return getForShopper(shopperId);
};

// ---------------------------------------------------
// Documents (POST /api/shopper/application/documents, multipart:
// file + docType). Stored outside the public uploads; replacing a
// document deletes the old file.
// ---------------------------------------------------

const sniffMime = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.slice(4, 8).toString() === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heif)/.test(buffer.slice(8, 12).toString())) return 'image/heic';
  if (buffer.length >= 5 && buffer.slice(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
};

const removeFile = (fileName) => {
  try {
    fs.unlinkSync(path.join(STORAGE_DIR, path.basename(fileName)));
  } catch {
    // already gone
  }
};

const uploadDocument = async (shopperId, docType, file) => {
  if (!DOC_TYPES[docType]) throw error(400, 'Unknown document type', 'INVALID_DOC_TYPE');
  if (!file?.buffer?.length) throw error(400, 'Choose a photo to upload', 'NO_FILE');
  if (file.buffer.length > MAX_BYTES) throw error(413, 'The file is too large (max 8 MB)', 'FILE_TOO_LARGE');

  // The file's real type (not the name or the header the app sent)
  const mime = sniffMime(file.buffer);

  if (!mime || (mime === 'application/pdf' && !PDF_ALLOWED.includes(docType))) {
    throw error(
      415,
      PDF_ALLOWED.includes(docType) ? 'Upload a photo (JPG, PNG, HEIC) or a PDF' : 'Upload a photo (JPG, PNG or HEIC)',
      'INVALID_FILE'
    );
  }

  const client = await pool.connect();
  let written = null;

  try {
    await client.query('BEGIN');
    await ensureApplication(shopperId, client);
    const app = await lockApplication(client, shopperId);

    if (!app) throw error(409, 'Your account is already approved', 'NOT_REQUIRED');
    if (!EDITABLE.includes(app.status)) throw error(409, "Your application can't be changed now", 'NOT_EDITABLE');

    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' }[mime];
    written = `app${app.id}-${docType}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(STORAGE_DIR, written), file.buffer, { mode: 0o600 });

    const old = (
      await client.query(
        `
        UPDATE shopper_application_documents
        SET replaced_at = NOW()
        WHERE application_id = $1 AND doc_type = $2 AND replaced_at IS NULL AND deleted_at IS NULL
        RETURNING file_name
        `,
        [app.id, docType]
      )
    ).rows;

    const doc = (
      await client.query(
        `
        INSERT INTO shopper_application_documents (application_id, doc_type, file_name, mime_type, size_bytes, sha256)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
        `,
        [app.id, docType, written, mime, file.buffer.length, crypto.createHash('sha256').update(file.buffer).digest('hex')]
      )
    ).rows[0];

    await client.query('UPDATE shopper_applications SET updated_at = NOW() WHERE id = $1', [app.id]);
    await client.query('COMMIT');

    // Old versions aren't kept (data minimisation)
    old.forEach((row) => removeFile(row.file_name));
    if (old.length) {
      await pool.query(
        'UPDATE shopper_application_documents SET deleted_at = NOW() WHERE application_id = $1 AND doc_type = $2 AND replaced_at IS NOT NULL AND deleted_at IS NULL',
        [app.id, docType]
      );
    }

    return publicDocument(doc, '/api/shopper/application/documents');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (written) removeFile(written);
    throw caught;
  } finally {
    client.release();
  }
};

// A document's file for the applicant (shopperId) or an admin (null)
// -> { filePath, mimeType, docType }
const documentFile = async (documentId, { shopperId = null, applicationId = null } = {}) => {
  const doc = (
    await pool.query(
      `
      SELECT d.*, a.shopper_id FROM shopper_application_documents d
      JOIN shopper_applications a ON a.id = d.application_id
      WHERE d.id = $1 AND d.replaced_at IS NULL AND d.deleted_at IS NULL
      `,
      [Number(documentId)]
    )
  ).rows[0];

  if (!doc || (shopperId != null && Number(doc.shopper_id) !== Number(shopperId)) || (applicationId != null && Number(doc.application_id) !== Number(applicationId))) {
    throw error(404, 'Document not found');
  }

  const filePath = path.join(STORAGE_DIR, path.basename(doc.file_name));

  if (!fs.existsSync(filePath)) throw error(404, 'Document file not found');

  return { filePath, mimeType: doc.mime_type, docType: doc.doc_type };
};

// ---------------------------------------------------
// Submit (POST /api/shopper/application/submit
//   { acceptTerms, acceptPrivacy, requestId })
// ---------------------------------------------------

const submit = async (shopperId, input = {}) => {
  await loadSettings();
  const requestId = input.requestId ? String(input.requestId).slice(0, 64) : null;
  const client = await pool.connect();
  let duplicate = false;

  try {
    await client.query('BEGIN');
    await ensureApplication(shopperId, client);
    const app = await lockApplication(client, shopperId);

    if (!app) throw error(409, 'Your account is already approved', 'NOT_REQUIRED');

    // A retried submit (same request) is answered with the same result
    if (requestId && app.last_submit_request_id === requestId && app.status === 'submitted') {
      duplicate = true;
    } else {
      if (!EDITABLE.includes(app.status)) {
        throw error(409, `Your application is already ${STATUS_LABELS[app.status].toLowerCase()}`, 'ALREADY_SUBMITTED');
      }

      if (input.acceptTerms !== true || input.acceptPrivacy !== true) {
        throw error(400, 'Accept the shopper terms and the privacy notice to submit', 'CONSENT_REQUIRED');
      }

      await client.query(
        `UPDATE shopper_applications
         SET terms_accepted_at = NOW(), privacy_accepted_at = NOW(), terms_version = $2 WHERE id = $1`,
        [app.id, TERMS_VERSION]
      );

      const fresh = (await client.query('SELECT * FROM shopper_applications WHERE id = $1', [app.id])).rows[0];
      const docs = await currentDocuments(app.id, client);
      const account = await payoutAccountOf(fresh, client);
      const incomplete = stepStatus(fresh, docs, account).filter((step) => !step.complete);

      if (incomplete.length > 0) {
        throw error(400, 'Some details are still missing', 'INCOMPLETE', {
          steps: incomplete.map((step) => ({ key: step.key, missing: step.missing })),
        });
      }

      await client.query(
        `
        UPDATE shopper_applications
        SET status = 'submitted', submitted_at = NOW(), submit_count = submit_count + 1,
            last_submit_request_id = $2, info_request = NULL, updated_at = NOW()
        WHERE id = $1
        `,
        [app.id, requestId]
      );

      await addEvent(client, app.id, {
        action: app.status === 'more_info_required' ? 'resubmitted' : 'submitted',
        from: app.status,
        to: 'submitted',
        actorType: 'shopper',
        actorId: Number(shopperId),
      });
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  return { ...(await getForShopper(shopperId)), duplicate };
};

// ---------------------------------------------------
// Admin
// ---------------------------------------------------

// Admins who entered or changed an application's details for the
// shopper (registered it, or edited a step on the registration page)
const EDIT_ACTIONS = ['registered_by_admin', 'edited_by_admin'];

const editorAdminIds = async (client, app) => {
  const rows = (
    await client.query(
      "SELECT DISTINCT actor_id FROM shopper_application_events WHERE application_id = $1 AND actor_type = 'admin' AND action = ANY($2)",
      [app.id, EDIT_ACTIONS]
    )
  ).rows;
  const ids = rows.map((row) => Number(row.actor_id));
  if (app.created_by_admin != null && !ids.includes(Number(app.created_by_admin))) ids.push(Number(app.created_by_admin));
  return ids;
};

// Maker-checker (owner's choice 2026-10-28): the admin who registered a
// shopper - or edited the registration's details - can't accept its
// documents or approve it; the Owner is exempt
const registeredByThisAdmin = async (client, app, adminId) =>
  (await editorAdminIds(client, app)).includes(Number(adminId)) &&
  (await client.query('SELECT role FROM admins WHERE id = $1', [Number(adminId)])).rows[0]?.role !== 'owner';

const SELF_REVIEW_MESSAGE = 'You registered or edited this shopper, so another admin must check the documents and approve it';

const ADMIN_TRANSITIONS = {
  start_review: { from: ['submitted'], to: 'under_review' },
  request_info: { from: ['submitted', 'under_review'], to: 'more_info_required' },
  approve: { from: ['submitted', 'under_review'], to: 'approved' },
  reject: { from: ['submitted', 'under_review', 'more_info_required'], to: 'rejected' },
};

const toAdminRow = (row) => ({
  id: Number(row.id),
  shopperId: Number(row.shopper_id),
  shopperCode: row.shopper_code || null,
  registrationChannel: row.registration_channel || 'app',
  registeredBy: row.registered_by_name || null,
  activated: row.activated_at ? true : row.registration_channel ? false : null,
  activatedAt: row.activated_at || null,
  fullName: row.full_name || row.account_name || null,
  mobile: row.mobile || null,
  district: row.district || null,
  vehicleType: row.vehicle_type || null,
  vehicleLabel: VEHICLES[row.vehicle_type] || null,
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
  phoneVerified: Boolean(row.phone_verified_at),
  submittedAt: row.submitted_at,
  reviewedAt: row.reviewed_at,
  submitCount: Number(row.submit_count || 0),
  updatedAt: row.updated_at,
  createdAt: row.created_at,
});

// No NIC / documents / bank details here (Support can see the list)
const adminList = async ({ status, q, page = 1, pageSize = 25 } = {}) => {
  const where = [];
  const values = [];

  if (status === 'open') {
    where.push("a.status IN ('submitted', 'under_review')");
  } else if (STATUS_LABELS[status]) {
    values.push(status);
    where.push(`a.status = $${values.length}`);
  }

  if (q) {
    values.push(`%${String(q).trim().toLowerCase()}%`);
    where.push(`(LOWER(COALESCE(a.full_name, sh.full_name)) LIKE $${values.length} OR LOWER(sh.shopper_code) LIKE $${values.length} OR sh.mobile LIKE $${values.length} OR CAST(a.id AS TEXT) = TRIM(LOWER($${values.length}), '%'))`);
  }

  const size = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const offset = (Math.max(1, Number(page) || 1) - 1) * size;
  const sql = `FROM shopper_applications a JOIN shoppers sh ON sh.id = a.shopper_id LEFT JOIN admins rg ON rg.id = a.created_by_admin ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;

  const [rows, count, summary] = await Promise.all([
    pool.query(
      `SELECT a.*, sh.mobile, sh.full_name AS account_name, sh.shopper_code, sh.registration_channel, sh.activated_at, rg.full_name AS registered_by_name ${sql}
       ORDER BY (a.status IN ('submitted', 'under_review')) DESC, a.submitted_at ASC NULLS LAST, a.updated_at DESC
       LIMIT ${size} OFFSET ${offset}`,
      values
    ),
    pool.query(`SELECT COUNT(*)::int AS n ${sql}`, values),
    pool.query('SELECT status, COUNT(*)::int AS n FROM shopper_applications GROUP BY status'),
  ]);

  return {
    applications: rows.rows.map(toAdminRow),
    total: count.rows[0].n,
    page: Math.max(1, Number(page) || 1),
    pageSize: size,
    summary: Object.fromEntries(summary.rows.map((row) => [row.status, row.n])),
  };
};

// Full detail for Owner / Operations (NIC, licence, bank number)
const adminDetail = async (applicationId) => {
  await loadSettings();
  const app = (
    await pool.query(
      `SELECT a.*, sh.mobile, sh.full_name AS account_name, sh.approval_status, sh.created_at AS account_created_at,
              sh.shopper_code, sh.registration_channel, sh.activated_at, sh.vehicle_make, sh.vehicle_model,
              rg.full_name AS registered_by_name, cr.full_name AS consent_recorded_by_name
       FROM shopper_applications a JOIN shoppers sh ON sh.id = a.shopper_id
       LEFT JOIN admins rg ON rg.id = a.created_by_admin
       LEFT JOIN admins cr ON cr.id = a.consent_recorded_by
       WHERE a.id = $1`,
      [Number(applicationId)]
    )
  ).rows[0];

  if (!app) throw error(404, 'Application not found');

  const docs = await currentDocuments(app.id);
  const account = await payoutAccountOf(app);
  const events = (
    await pool.query(
      `SELECT e.*, ad.full_name AS admin_name FROM shopper_application_events e
       LEFT JOIN admins ad ON e.actor_type = 'admin' AND ad.id = e.actor_id
       WHERE e.application_id = $1 ORDER BY e.created_at, e.id`,
      [app.id]
    )
  ).rows;
  const reviewer = app.reviewed_by
    ? (await pool.query('SELECT full_name FROM admins WHERE id = $1', [app.reviewed_by])).rows[0]
    : null;

  let accountNumber = null;

  if (account) {
    try {
      accountNumber = require('../wallet/accountVault').decryptAccountNumber(account.account_number_encrypted);
    } catch {
      accountNumber = null;
    }
  }

  const nic = app.nic_encrypted ? decryptIdentity(app.nic_encrypted) : null;
  const nicInfo = nic ? parseNic(nic) : null;

  return {
    ...toAdminRow(app),
    accountName: app.account_name,
    approvalStatus: app.approval_status,
    accountCreatedAt: app.account_created_at,
    registeredByAdminId: app.created_by_admin != null ? Number(app.created_by_admin) : null,
    // Registrar + admins who edited the details (maker-checker)
    editorAdminIds: await editorAdminIds(pool, app),
    consentRecordedBy: app.consent_recorded_by_name || null,
    personal: {
      fullName: app.full_name,
      dateOfBirth: isoDate(app.date_of_birth),
      age: app.date_of_birth ? ageOn(isoDate(app.date_of_birth)) : null,
      email: app.email,
      mobile: app.mobile,
      phoneVerified: Boolean(app.phone_verified_at),
      phoneVerifiedBy: app.phone_verified_by,
      phoneVerifiedAt: app.phone_verified_at,
    },
    identity: {
      nicNumber: nic,
      nicDateOfBirth: nicInfo?.dateOfBirth || null,
      nicMatchesDob: nicInfo ? nicInfo.dateOfBirth === isoDate(app.date_of_birth) : null,
    },
    vehicle: {
      vehicleType: app.vehicle_type,
      vehicleLabel: VEHICLES[app.vehicle_type] || null,
      vehicleNumber: app.vehicle_number,
      isRegisteredOwner: app.is_registered_owner,
      licenceNumber: app.licence_encrypted ? decryptIdentity(app.licence_encrypted) : null,
      licenceExpiry: isoDate(app.licence_expiry),
      vehicleMake: app.vehicle_make || null,
      vehicleModel: app.vehicle_model || null,
    },
    address: {
      addressLine: app.address_line,
      city: app.city,
      district: app.district,
      serviceArea: app.service_area,
      emergencyName: app.emergency_name,
      emergencyPhone: app.emergency_phone,
      emergencyRelation: app.emergency_relation,
    },
    payoutAccount: account ? { ...publicAccount(account), accountNumber } : null,
    consent: {
      termsAcceptedAt: app.terms_accepted_at,
      privacyAcceptedAt: app.privacy_accepted_at,
      termsVersion: app.terms_version,
    },
    documents: docs.map((doc) => publicDocument(doc, `/api/admin/shopper-applications/${app.id}/documents`)),
    requiredDocuments: requiredDocs(app),
    steps: stepStatus(app, docs, account),
    infoRequest: app.info_request || null,
    decisionReason: app.decision_reason || null,
    reviewedBy: reviewer?.full_name || null,
    documentsDeletedAt: app.documents_deleted_at,
    events: events.map((event) => ({
      id: Number(event.id),
      action: event.action,
      from: event.from_status,
      to: event.to_status,
      actorType: event.actor_type,
      actorId: event.actor_id != null ? Number(event.actor_id) : null,
      actorName: event.actor_type === 'admin' ? event.admin_name || `Admin ${event.actor_id}` : event.actor_type === 'shopper' ? 'Applicant' : 'System',
      note: event.note,
      at: event.created_at,
    })),
  };
};

// PATCH /api/admin/shopper-applications/:id
//   { action: start_review | request_info | approve | reject |
//     confirm_phone | delete_documents, reason, items, verifyBankAccount }
const adminAction = async (applicationId, action, input = {}, adminId) => {
  await loadSettings();
  const reason = clean(input.reason, 500);
  const client = await pool.connect();
  let result;

  try {
    await client.query('BEGIN');

    const peek = (await client.query('SELECT shopper_id FROM shopper_applications WHERE id = $1', [Number(applicationId)])).rows[0];
    if (!peek) throw error(404, 'Application not found');

    // Same lock order as the shopper's own changes
    await client.query('SELECT id FROM shoppers WHERE id = $1 FOR UPDATE', [peek.shopper_id]);
    const app = await lockApplication(client, peek.shopper_id);

    if (action === 'confirm_phone') {
      if (app.phone_verified_at) throw error(409, 'The phone number is already verified', 'ALREADY_VERIFIED');
      await client.query(
        "UPDATE shopper_applications SET phone_verified_at = NOW(), phone_verified_by = 'admin', updated_at = NOW() WHERE id = $1",
        [app.id]
      );
      await addEvent(client, app.id, { action: 'phone_confirmed', actorType: 'admin', actorId: adminId, note: reason || 'Confirmed by phone call' });
      result = { action, status: app.status };
    } else if (action === 'delete_documents') {
      if (app.status === 'approved' && reason.length < 3) {
        throw error(400, "Give a reason for deleting an approved shopper's documents", 'REASON_REQUIRED');
      }
      const deleted = await deleteApplicationDocuments(client, app.id);
      await addEvent(client, app.id, { action: 'documents_deleted', actorType: 'admin', actorId: adminId, note: reason || `${deleted} document(s) deleted on request` });
      result = { action, status: app.status, deleted };
    } else {
      const rule = ADMIN_TRANSITIONS[action];

      if (!rule) throw error(400, 'Unknown action');

      if (!rule.from.includes(app.status)) {
        throw error(409, `This application is ${STATUS_LABELS[app.status].toLowerCase()}; it can't be ${{ start_review: 'put under review', request_info: 'sent back', approve: 'approved', reject: 'rejected' }[action]} now`, 'WRONG_STATUS');
      }

      let infoRequest = null;

      if (action === 'request_info') {
        const items = Array.isArray(input.items)
          ? [...new Set(input.items.map(String))].filter((item) => DOC_TYPES[item] || FIELD_LABELS[item])
          : [];
        if (reason.length < 5) throw error(400, 'Explain what the applicant must add or fix', 'REASON_REQUIRED');
        infoRequest = {
          message: reason,
          items: items.map((key) => ({ key, label: DOC_TYPES[key]?.label || FIELD_LABELS[key] })),
          requestedAt: new Date().toISOString(),
        };
      }

      if (action === 'reject' && reason.length < 5) {
        throw error(400, 'Give the reason for rejecting the application (the applicant sees it)', 'REASON_REQUIRED');
      }

      if (action === 'approve') {
        if (await registeredByThisAdmin(client, app, adminId)) throw error(403, SELF_REVIEW_MESSAGE, 'SELF_APPROVAL');

        const docs = await currentDocuments(app.id, client);
        const account = await payoutAccountOf(app, client);
        const incomplete = stepStatus(app, docs, account).filter((step) => !step.complete);

        if (incomplete.length) throw error(409, 'The application is incomplete', 'INCOMPLETE');
        if (!app.phone_verified_at) {
          throw error(409, 'Confirm the phone number first (call the applicant), then approve', 'PHONE_NOT_VERIFIED');
        }

        // Every required document / photo must be accepted one by one
        const notAccepted = requiredDocs(app).filter((type) => docs.find((doc) => doc.doc_type === type)?.review_status !== 'accepted');

        if (notAccepted.length) {
          throw error(409, `Review and accept every document first: ${notAccepted.map((type) => DOC_TYPES[type].label).join(', ')}`, 'DOCUMENTS_NOT_REVIEWED', { notAccepted });
        }

        await client.query(
          `UPDATE shoppers SET approval_status = 'approved', full_name = $2, vehicle_type = $3, vehicle_number = $4,
             email = COALESCE($5, email), licence_expiry = $6, updated_at = NOW()
           WHERE id = $1`,
          [app.shopper_id, app.full_name, app.vehicle_type, app.vehicle_number, app.email, app.licence_expiry]
        );

        await recordVerifiedVehicle(client, {
          shopperId: app.shopper_id,
          sourceType: 'application',
          sourceId: app.id,
          vehicle: {
            vehicleType: app.vehicle_type,
            vehicleNumber: app.vehicle_number,
            isRegisteredOwner: app.is_registered_owner,
            licenceExpiry: isoDate(app.licence_expiry),
          },
          documents: docs.filter((doc) => DOC_TYPES[doc.doc_type].step === 'vehicle').map((doc) => ({ id: Number(doc.id), type: doc.doc_type })),
          adminId,
        });

        if (input.verifyBankAccount !== false && account && account.status !== 'verified') {
          await client.query(
            `UPDATE shopper_payout_accounts
             SET status = 'verified', status_note = 'Verified with the shopper application', reviewed_by = $2, reviewed_at = NOW(), updated_at = NOW()
             WHERE id = $1`,
            [account.id, adminId]
          );
        }
      }

      if (action === 'reject') {
        await client.query("UPDATE shoppers SET approval_status = 'rejected', status = 'offline', updated_at = NOW() WHERE id = $1", [app.shopper_id]);
      }

      await client.query(
        `
        UPDATE shopper_applications
        SET status = $2::varchar,
            info_request = CASE WHEN $2::varchar = 'more_info_required' THEN $3::jsonb ELSE info_request END,
            decision_reason = CASE WHEN $2::varchar IN ('rejected', 'more_info_required') THEN $4::varchar WHEN $2::varchar = 'approved' THEN NULL ELSE decision_reason END,
            reviewed_at = CASE WHEN $2::varchar IN ('approved', 'rejected', 'more_info_required') THEN NOW() ELSE reviewed_at END,
            reviewed_by = $5::int,
            updated_at = NOW()
        WHERE id = $1
        `,
        [app.id, rule.to, infoRequest ? JSON.stringify(infoRequest) : null, reason || null, adminId]
      );

      await addEvent(client, app.id, {
        action,
        from: app.status,
        to: rule.to,
        actorType: 'admin',
        actorId: adminId,
        note: reason || (action === 'approve' ? (input.verifyBankAccount !== false ? 'Approved; bank account verified' : 'Approved') : null),
      });

      result = { action, status: rule.to, from: app.status, shopperId: Number(app.shopper_id), reason };
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  return { ...result, application: await adminDetail(applicationId) };
};

// ---------------------------------------------------
// Per-document review (phase 36)
// PATCH /api/admin/shopper-applications/:id/documents/:docId
//   { decision: accept | reject, note }  (note required to reject; the
//   applicant sees it and uploads a new one)
// ---------------------------------------------------

const reviewDocument = async (applicationId, documentId, input = {}, adminId) => {
  const decision = String(input.decision || '');
  const note = clean(input.note, 300);

  if (!['accept', 'reject'].includes(decision)) throw error(400, 'Choose accept or reject', 'INVALID_DECISION');
  if (decision === 'reject' && note.length < 3) throw error(400, 'Say what is wrong with it (the applicant sees it)', 'REASON_REQUIRED');

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const app = (await client.query('SELECT * FROM shopper_applications WHERE id = $1 FOR UPDATE', [Number(applicationId)])).rows[0];
    if (!app) throw error(404, 'Application not found');
    if (await registeredByThisAdmin(client, app, adminId)) throw error(403, SELF_REVIEW_MESSAGE, 'SELF_APPROVAL');
    if (!['submitted', 'under_review', 'more_info_required'].includes(app.status)) {
      throw error(409, `Documents are reviewed while the application is in review (it is ${STATUS_LABELS[app.status].toLowerCase()})`, 'WRONG_STATUS');
    }

    const doc = (
      await client.query(
        `UPDATE shopper_application_documents
         SET review_status = $3, review_note = $4, reviewed_by = $5, reviewed_at = NOW()
         WHERE id = $1 AND application_id = $2 AND replaced_at IS NULL AND deleted_at IS NULL
         RETURNING doc_type`,
        [Number(documentId), app.id, decision === 'accept' ? 'accepted' : 'rejected', note || null, adminId]
      )
    ).rows[0];

    if (!doc) throw error(404, 'Document not found');

    await addEvent(client, app.id, {
      action: decision === 'accept' ? 'document_accepted' : 'document_rejected',
      actorType: 'admin',
      actorId: adminId,
      note: `${DOC_TYPES[doc.doc_type]?.label || doc.doc_type}${note ? `: ${note}` : ''}`,
    });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  return adminDetail(applicationId);
};

// The verified vehicle after an approval (the previous one is kept,
// marked superseded). Inside the caller's transaction.
const recordVerifiedVehicle = async (client, { shopperId, sourceType, sourceId, vehicle, documents, adminId }) => {
  const created = (
    await client.query(
      `INSERT INTO shopper_vehicle_records (shopper_id, source_type, source_id, vehicle_type, vehicle_number, vehicle_make,
         vehicle_model, is_registered_owner, licence_expiry, documents, approved_by, superseded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NOW())
       RETURNING id`,
      [shopperId, sourceType, sourceId, vehicle.vehicleType || null, vehicle.vehicleNumber || null, vehicle.vehicleMake || null,
        vehicle.vehicleModel || null, vehicle.isRegisteredOwner ?? null, vehicle.licenceExpiry || null, JSON.stringify(documents || []), adminId]
    )
  ).rows[0];

  // Swap the current record (one current per shopper)
  await client.query(
    'UPDATE shopper_vehicle_records SET superseded_at = NOW(), superseded_by = $2 WHERE shopper_id = $1 AND superseded_at IS NULL',
    [shopperId, created.id]
  );
  await client.query('UPDATE shopper_vehicle_records SET superseded_at = NULL WHERE id = $1', [created.id]);

  return created.id;
};

// GET /api/admin/shoppers/:id/vehicle-records -> current first
const vehicleRecords = async (shopperId) =>
  (
    await pool.query(
      `SELECT r.*, ad.full_name AS admin_name FROM shopper_vehicle_records r
       LEFT JOIN admins ad ON ad.id = r.approved_by
       WHERE r.shopper_id = $1 ORDER BY (r.superseded_at IS NULL) DESC, r.approved_at DESC, r.id DESC`,
      [Number(shopperId)]
    )
  ).rows.map((row) => ({
    id: Number(row.id),
    current: !row.superseded_at,
    sourceType: row.source_type,
    sourceId: Number(row.source_id),
    vehicleType: row.vehicle_type,
    vehicleLabel: VEHICLES[row.vehicle_type] || null,
    vehicleNumber: row.vehicle_number,
    vehicleMake: row.vehicle_make,
    vehicleModel: row.vehicle_model,
    isRegisteredOwner: row.is_registered_owner,
    licenceExpiry: isoDate(row.licence_expiry),
    documents: (row.documents || []).map((doc) => ({
      id: Number(doc.id),
      type: doc.type,
      label: DOC_TYPES[doc.type]?.label || doc.type,
      url: row.source_type === 'application'
        ? `/api/admin/shopper-applications/${row.source_id}/documents/${doc.id}`
        : `/api/admin/shopper-change-requests/${row.source_id}/documents/${doc.id}`,
    })),
    approvedBy: row.admin_name || null,
    approvedAt: row.approved_at,
    supersededAt: row.superseded_at,
  }));

// ---------------------------------------------------
// Retention (owner's choice): documents of rejected applications and
// of drafts untouched for 90 days are deleted; the application record
// and its history stay. Runs daily (app.js) and on demand.
// ---------------------------------------------------

const deleteApplicationDocuments = async (client, applicationId) => {
  const docs = (
    await client.query(
      'UPDATE shopper_application_documents SET deleted_at = NOW() WHERE application_id = $1 AND deleted_at IS NULL RETURNING file_name',
      [applicationId]
    )
  ).rows;

  await client.query('UPDATE shopper_applications SET documents_deleted_at = NOW(), updated_at = NOW() WHERE id = $1', [applicationId]);
  docs.forEach((doc) => removeFile(doc.file_name));

  return docs.length;
};

const retentionSweep = async ({ days = RETENTION_DAYS } = {}) => {
  const due = (
    await pool.query(
      `
      SELECT DISTINCT a.id, a.status FROM shopper_applications a
      JOIN shopper_application_documents d ON d.application_id = a.id AND d.deleted_at IS NULL
      WHERE (a.status = 'rejected' AND COALESCE(a.reviewed_at, a.updated_at) < NOW() - ($1 || ' days')::interval)
         OR (a.status = 'draft' AND a.updated_at < NOW() - ($1 || ' days')::interval)
      `,
      [String(days)]
    )
  ).rows;

  let deleted = 0;

  for (const app of due) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      const count = await deleteApplicationDocuments(client, app.id);
      await addEvent(client, app.id, {
        action: 'documents_deleted',
        actorType: 'system',
        note: `${count} document(s) deleted after ${days} days (${app.status === 'rejected' ? 'rejected application' : 'unfinished draft'})`,
      });
      await client.query('COMMIT');
      deleted += count;
    } catch (caught) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('❌ APPLICATION RETENTION ERROR:', app.id, caught.message);
    } finally {
      client.release();
    }
  }

  return { applications: due.length, documents: deleted };
};

// Account creation at step 1 marks the phone verified (OTP proof)
const markPhoneVerified = (client, shopperId, method) =>
  client.query(
    'UPDATE shopper_applications SET phone_verified_at = NOW(), phone_verified_by = $2, updated_at = NOW() WHERE shopper_id = $1',
    [Number(shopperId), method]
  );

module.exports = {
  reviewDocument,
  recordVerifiedVehicle,
  vehicleRecords,
  vehiclePhotosFor,
  loadSettings,
  // shared with onboarding/changeRequests.js (phase 35)
  VEHICLES,
  DISTRICTS,
  normalizeLicence,
  sniffMime,
  isoDate,
  ageOn,
  STATUS_LABELS,
  DOC_TYPES,
  RULES,
  parseNic,
  normalizeVehicleNumber,
  ensureApplication,
  validatePersonal,
  getForShopper,
  saveStep,
  uploadDocument,
  documentFile,
  submit,
  adminList,
  adminDetail,
  adminAction,
  retentionSweep,
  markPhoneVerified,
  addEvent,
};
