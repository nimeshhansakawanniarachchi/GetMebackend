const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const pool = require('../config/db');
const applications = require('./applications');
const sms = require('./sms');
const { normalizeSriLankanMobile } = require('../utils/phone');
const { signShopperToken } = require('../utils/shopperSession');

// =====================================================
// ADMIN-MANAGED SHOPPER REGISTRATION (phase 37, 2026-10-28)
// Not a second registration system: an admin (Owner / Operations)
// creates the account and fills the SAME shopper application the app
// uses (applications.saveStep for every step, same documents + vehicle
// photos, same per-document review and approval). Then either
//   * submit for review (consent recorded by the admin), or
//   * "register and approve": the normal review - every document
//     accepted, phone confirmed - by a DIFFERENT admin (the registrar
//     can't accept documents or approve their own registration; the
//     Owner is exempt so a one-person team still works).
// The account gets a Shopper ID from the database and no usable
// password: the shopper activates it with a one-time code (owner's
// choice: shown once to the registering admin to hand over in person,
// also sent by SMS when Notify.lk is configured), then sets their own
// password in the app. Codes are stored as hashes, single use, 72 h,
// 5 tries; a new code revokes the old ones.
// =====================================================

const CODE_TTL_HOURS = 72;
const MAX_TRIES = 5;
// No 0/O/1/I/L: easy to read out and type
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const error = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

const codeHash = (shopperId, code) =>
  crypto
    .createHmac('sha256', crypto.createHash('sha256').update(`getme-activation:${process.env.JWT_SECRET || ''}`).digest())
    .update(`${shopperId}:${String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')}`)
    .digest('hex');

const newCode = () => {
  const chars = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
};

// POST /api/admin/shopper-registrations
// { fullName, mobile, email, dateOfBirth, nicNumber, vehicleType,
//   vehicleNumber, isRegisteredOwner, licenceNumber, licenceExpiry,
//   addressLine, city, district, serviceArea, emergencyName,
//   emergencyPhone, emergencyRelation, bankName, otherBankName,
//   branchName, accountHolderName, accountNumber, accountNumberConfirm }
// -> { application (admin view), shopper, activation: { code, expiresAt, sentBySms } }
const registerShopper = async (input = {}, adminId) => {
  // Everything that can be checked before creating anything
  const personal = applications.validatePersonal(input);
  const mobile = normalizeSriLankanMobile(input.mobile);

  if (!mobile) throw error(400, 'Enter a valid Sri Lankan mobile number (e.g. 077 123 4567)', 'INVALID_MOBILE', { field: 'mobile' });

  const nic = applications.parseNic(input.nicNumber);
  if (!nic) throw error(400, 'Enter a valid NIC number', 'INVALID_NIC', { field: 'nicNumber' });
  if (nic.dateOfBirth !== personal.dateOfBirth) throw error(400, "The NIC number doesn't match the date of birth", 'DOB_NIC_MISMATCH', { field: 'nicNumber' });

  const taken = (
    await pool.query('SELECT 1 FROM shoppers WHERE mobile = $1 OR LOWER(email) = $2 LIMIT 1', [mobile, personal.email])
  ).rows.length > 0;

  if (taken) throw error(409, 'This mobile number or email already has a GetMe shopper account', 'ALREADY_REGISTERED', { field: 'mobile' });

  const nicTaken = (
    await pool.query("SELECT 1 FROM shopper_applications WHERE nic_hash = $1 AND status <> 'rejected'", [require('./identityVault').hashIdentity(nic.normalized)])
  ).rows.length > 0;

  if (nicTaken) throw error(409, 'This NIC is already used on another GetMe shopper application', 'NIC_IN_USE', { field: 'nicNumber' });

  // 1) the account + an empty application (one transaction)
  const client = await pool.connect();
  let shopper;

  try {
    await client.query('BEGIN');

    // No usable password until the shopper activates (random, never told)
    const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

    shopper = (
      await client.query(
        `INSERT INTO shoppers (full_name, mobile, email, password_hash, status, approval_status,
           registration_channel, registered_by_admin, activated_at)
         VALUES ($1, $2, $3, $4, 'offline', 'pending', 'admin', $5, NULL)
         RETURNING id, shopper_code, full_name, mobile, email, created_at`,
        [personal.fullName, mobile, personal.email, unusable, adminId]
      )
    ).rows[0];

    const app = (
      await client.query(
        `INSERT INTO shopper_applications (shopper_id, full_name, date_of_birth, email, created_by_admin)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [shopper.id, personal.fullName, personal.dateOfBirth, personal.email, adminId]
      )
    ).rows[0];

    await applications.addEvent(client, app.id, { action: 'registered_by_admin', to: 'draft', actorType: 'admin', actorId: adminId, note: `Account ${shopper.shopper_code} created by an admin` });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') throw error(409, 'This mobile number or email already has a GetMe shopper account', 'ALREADY_REGISTERED');
    throw caught;
  } finally {
    client.release();
  }

  // 2) the application steps, with the same rules as the app. Any
  // failure removes the new account so nothing half-made is left
  try {
    await applications.saveStep(shopper.id, { step: 'identity', nicNumber: input.nicNumber });
    await applications.saveStep(shopper.id, {
      step: 'vehicle',
      vehicleType: input.vehicleType,
      vehicleNumber: input.vehicleNumber,
      isRegisteredOwner: input.isRegisteredOwner,
      licenceNumber: input.licenceNumber,
      licenceExpiry: input.licenceExpiry,
    });
    await applications.saveStep(shopper.id, {
      step: 'address',
      addressLine: input.addressLine,
      city: input.city,
      district: input.district,
      serviceArea: input.serviceArea,
      emergencyName: input.emergencyName,
      emergencyPhone: input.emergencyPhone,
      emergencyRelation: input.emergencyRelation,
    });
    await applications.saveStep(shopper.id, {
      step: 'payout',
      bankName: input.bankName,
      otherBankName: input.otherBankName,
      branchName: input.branchName,
      accountHolderName: input.accountHolderName,
      accountNumber: input.accountNumber,
      accountNumberConfirm: input.accountNumberConfirm,
    });

    // Make / model kept on the account (the application has no column)
    if (input.vehicleMake || input.vehicleModel) {
      await pool.query('UPDATE shoppers SET vehicle_make = $2, vehicle_model = $3 WHERE id = $1', [
        shopper.id,
        String(input.vehicleMake || '').trim().slice(0, 40) || null,
        String(input.vehicleModel || '').trim().slice(0, 60) || null,
      ]);
    }
  } catch (caught) {
    await pool.query('DELETE FROM shopper_payout_accounts WHERE shopper_id = $1', [shopper.id]).catch(() => {});
    await pool.query('DELETE FROM shoppers WHERE id = $1', [shopper.id]).catch(() => {});
    throw caught;
  }

  const activation = await issueActivationCode(shopper.id, adminId);
  const app = (await pool.query('SELECT id FROM shopper_applications WHERE shopper_id = $1', [shopper.id])).rows[0];

  return {
    shopper: { id: shopper.id, shopperCode: shopper.shopper_code, fullName: shopper.full_name, mobile: shopper.mobile, email: shopper.email, createdAt: shopper.created_at },
    application: await applications.adminDetail(app.id),
    activation,
  };
};

// An admin-created application the admin may still edit / upload to
const adminDraft = async (applicationId) => {
  const app = (await pool.query('SELECT * FROM shopper_applications WHERE id = $1', [Number(applicationId)])).rows[0];

  if (!app) throw error(404, 'Application not found');
  if (!app.created_by_admin) {
    throw error(409, 'The shopper filled in this application in the app; only they can change it', 'NOT_ADMIN_REGISTERED');
  }

  return app;
};

const STEP_NAMES = {
  personal: 'personal details',
  mobile: 'mobile number',
  identity: 'NIC',
  vehicle: 'vehicle and licence',
  address: 'address and emergency contact',
  payout: 'bank account',
};

const editEvent = async (applicationId, adminId, note) => {
  const client = await pool.connect();
  try {
    await applications.addEvent(client, applicationId, { action: 'edited_by_admin', actorType: 'admin', actorId: adminId, note });
  } finally {
    client.release();
  }
};

// The sign-in mobile of an account that is not activated yet. The phone
// must be confirmed again, and the old activation codes stop working: a
// new one is issued for the corrected number (shown once, SMS if set up).
// Activated accounts change their number through the phone-change flow.
const changeMobile = async (app, input, adminId) => {
  const mobile = normalizeSriLankanMobile(input.mobile);

  if (!mobile) throw error(400, 'Enter a valid Sri Lankan mobile number (e.g. 077 123 4567)', 'INVALID_MOBILE', { field: 'mobile' });
  if (!['draft', 'more_info_required'].includes(app.status)) {
    throw error(409, "This application can't be changed now", 'NOT_EDITABLE');
  }

  const client = await pool.connect();
  let changed = false;

  try {
    await client.query('BEGIN');
    const shopper = (await client.query('SELECT id, mobile, activated_at FROM shoppers WHERE id = $1 FOR UPDATE', [app.shopper_id])).rows[0];

    if (shopper.activated_at) {
      throw error(409, 'The shopper has activated the account. Change the number through a phone change request.', 'ALREADY_ACTIVE', { field: 'mobile' });
    }

    if (shopper.mobile !== mobile) {
      const taken = (await client.query('SELECT 1 FROM shoppers WHERE mobile = $1 AND id <> $2', [mobile, shopper.id])).rows.length > 0;
      if (taken) throw error(409, 'This mobile number already has a GetMe shopper account', 'MOBILE_TAKEN', { field: 'mobile' });

      const emergency = (await client.query('SELECT emergency_phone FROM shopper_applications WHERE id = $1', [app.id])).rows[0]?.emergency_phone;
      if (emergency === mobile) throw error(400, 'The emergency contact must be someone else', 'EMERGENCY_IS_SELF', { field: 'mobile' });

      await client.query('UPDATE shoppers SET mobile = $2, updated_at = NOW() WHERE id = $1', [shopper.id, mobile]);
      await client.query('UPDATE shopper_applications SET phone_verified_at = NULL, phone_verified_by = NULL, updated_at = NOW() WHERE id = $1', [app.id]);
      await client.query('UPDATE shopper_activation_codes SET revoked_at = NOW() WHERE shopper_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [shopper.id]);
      await applications.addEvent(client, app.id, {
        action: 'edited_by_admin',
        actorType: 'admin',
        actorId: adminId,
        note: `Changed the mobile number to ${mobile.slice(0, -4).replace(/\d/g, '•')}${mobile.slice(-4)}; phone to be confirmed again`,
      });
      changed = true;
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') throw error(409, 'This mobile number already has a GetMe shopper account', 'MOBILE_TAKEN', { field: 'mobile' });
    throw caught;
  } finally {
    client.release();
  }

  return changed ? issueActivationCode(app.shopper_id, adminId) : null;
};

// PATCH /api/admin/shopper-registrations/:applicationId/steps { step, ...fields }
// -> { application, activation? } (a new code only after a mobile change)
// Same rules as the app (applications.saveStep). Every edit is recorded,
// and an admin who edits can't approve the registration (maker-checker).
const saveStepAsAdmin = async (applicationId, input = {}, adminId) => {
  const app = await adminDraft(applicationId);
  const step = String(input?.step || '');

  if (step === 'mobile') {
    const activation = await changeMobile(app, input, adminId);
    return { application: await applications.adminDetail(app.id), activation };
  }

  await applications.saveStep(app.shopper_id, input || {});

  // Not approved or activated yet: keep the account's name / email in
  // step with the application (approval copies them anyway). Once the
  // shopper has activated, their sign-in email changes only at approval.
  if (step === 'personal') {
    const fresh = (await pool.query('SELECT full_name, email FROM shopper_applications WHERE id = $1', [app.id])).rows[0];
    await pool.query(
      "UPDATE shoppers SET full_name = $2, email = COALESCE($3, email), updated_at = NOW() WHERE id = $1 AND approval_status <> 'approved' AND activated_at IS NULL",
      [app.shopper_id, fresh.full_name, fresh.email]
    );
  }

  if (step === 'vehicle' && ('vehicleMake' in input || 'vehicleModel' in input)) {
    await pool.query("UPDATE shoppers SET vehicle_make = $2, vehicle_model = $3 WHERE id = $1 AND approval_status <> 'approved'", [
      app.shopper_id,
      String(input.vehicleMake || '').trim().slice(0, 40) || null,
      String(input.vehicleModel || '').trim().slice(0, 60) || null,
    ]);
  }

  await editEvent(app.id, adminId, `Edited the ${STEP_NAMES[step] || step}`);

  return { application: await applications.adminDetail(app.id), activation: null };
};

// POST /api/admin/shopper-registrations/:applicationId/documents (file + docType)
const uploadAsAdmin = async (applicationId, docType, file) => {
  const app = await adminDraft(applicationId);
  await applications.uploadDocument(app.shopper_id, docType, file);
  return applications.adminDetail(app.id);
};

// POST /api/admin/shopper-registrations/:applicationId/submit
//   { consentConfirmed: true, requestId }  (the shopper accepted the
//   terms + privacy notice on paper / in person; recorded with the admin)
const submitAsAdmin = async (applicationId, input = {}, adminId) => {
  const app = await adminDraft(applicationId);

  if (input.consentConfirmed !== true) {
    throw error(400, 'Confirm the shopper accepted the shopper terms and the privacy notice', 'CONSENT_REQUIRED');
  }

  const result = await applications.submit(app.shopper_id, { acceptTerms: true, acceptPrivacy: true, requestId: input.requestId });

  if (!result.duplicate) {
    const client = await pool.connect();
    try {
      await client.query('UPDATE shopper_applications SET consent_recorded_by = $2 WHERE id = $1', [app.id, adminId]);
      await applications.addEvent(client, app.id, { action: 'submitted_by_admin', actorType: 'admin', actorId: adminId, note: 'Terms and privacy notice accepted in person' });
    } finally {
      client.release();
    }
  }

  return applications.adminDetail(app.id);
};

// ---------------------------------------------------
// Activation
// ---------------------------------------------------

// POST /api/admin/shoppers/:id/activation-code -> { code (shown once), expiresAt, sentBySms }
const issueActivationCode = async (shopperId, adminId) => {
  const shopper = (await pool.query('SELECT id, mobile, activated_at, approval_status FROM shoppers WHERE id = $1', [Number(shopperId)])).rows[0];

  if (!shopper) throw error(404, 'Shopper not found');
  if (shopper.activated_at) throw error(409, 'This account is already activated', 'ALREADY_ACTIVE');
  if (shopper.approval_status === 'suspended') throw error(409, 'This account is suspended', 'SUSPENDED');

  const code = newCode();
  const client = await pool.connect();
  let row;

  try {
    await client.query('BEGIN');
    await client.query('UPDATE shopper_activation_codes SET revoked_at = NOW() WHERE shopper_id = $1 AND used_at IS NULL AND revoked_at IS NULL', [shopper.id]);
    row = (
      await client.query(
        `INSERT INTO shopper_activation_codes (shopper_id, code_hash, expires_at, created_by)
         VALUES ($1, $2, NOW() + ($3 || ' hours')::interval, $4) RETURNING id, expires_at`,
        [shopper.id, codeHash(shopper.id, code), String(CODE_TTL_HOURS), adminId]
      )
    ).rows[0];
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  let sentBySms = false;

  if (sms.isConfigured()) {
    try {
      await sms.sendSms(shopper.mobile, `Your GetMe shopper activation code is ${code}. Open the GetMe Shopper app, tap Activate account and set your password. It expires in ${CODE_TTL_HOURS} hours.`);
      sentBySms = true;
      await pool.query('UPDATE shopper_activation_codes SET sent_by_sms = TRUE WHERE id = $1', [row.id]);
    } catch {
      sentBySms = false;
    }
  }

  // The code itself is only in this response (never stored or logged)
  return { code, expiresAt: row.expires_at, sentBySms };
};

// POST /api/shopper/auth/activate { mobile, code, password, confirmPassword }
const activateAccount = async (input = {}) => {
  const mobile = normalizeSriLankanMobile(input.mobile);
  const password = String(input.password || '');

  if (!mobile) throw error(400, 'Enter your registered mobile number', 'INVALID_MOBILE', { field: 'mobile' });
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw error(400, 'Use at least 8 characters with letters and numbers', 'WEAK_PASSWORD', { field: 'password' });
  }
  if (password !== String(input.confirmPassword || '')) throw error(400, "The passwords don't match", 'PASSWORD_MISMATCH', { field: 'confirmPassword' });

  const client = await pool.connect();
  let shopper;

  try {
    await client.query('BEGIN');
    shopper = (await client.query('SELECT * FROM shoppers WHERE mobile = $1 FOR UPDATE', [mobile])).rows[0];

    const invalid = () => error(400, "This code isn't valid. Check it, or ask GetMe for a new one.", 'INVALID_CODE');

    if (!shopper || shopper.activated_at) throw invalid();

    const code = (
      await client.query(
        'SELECT * FROM shopper_activation_codes WHERE shopper_id = $1 AND used_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
        [shopper.id]
      )
    ).rows[0];

    if (!code) throw invalid();
    if (new Date(code.expires_at) < new Date()) throw error(400, 'This code has expired. Ask GetMe for a new one.', 'CODE_EXPIRED');
    if (code.attempts >= MAX_TRIES) throw error(429, 'Too many wrong codes. Ask GetMe for a new one.', 'TOO_MANY_ATTEMPTS');

    const given = codeHash(shopper.id, input.code);

    if (!crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(code.code_hash, 'hex'))) {
      await client.query('UPDATE shopper_activation_codes SET attempts = attempts + 1 WHERE id = $1', [code.id]);
      await client.query('COMMIT');
      throw invalid();
    }

    const hash = await bcrypt.hash(password, 10);
    await client.query('UPDATE shopper_activation_codes SET used_at = NOW() WHERE id = $1', [code.id]);
    await client.query('UPDATE shoppers SET password_hash = $2, activated_at = NOW(), updated_at = NOW() WHERE id = $1', [shopper.id, hash]);

    const app = (await client.query('SELECT id FROM shopper_applications WHERE shopper_id = $1', [shopper.id])).rows[0];
    if (app) await applications.addEvent(client, app.id, { action: 'account_activated', actorType: 'shopper', actorId: shopper.id, note: 'Activation code; password set by the shopper' });

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  const fresh = (await pool.query('SELECT id, shopper_code, full_name, mobile, email, status, approval_status, auth_version FROM shoppers WHERE id = $1', [shopper.id])).rows[0];

  return {
    token: signShopperToken(fresh),
    shopper: {
      id: fresh.id,
      shopperCode: fresh.shopper_code,
      fullName: fresh.full_name,
      mobile: fresh.mobile,
      email: fresh.email,
      status: fresh.status,
      approvalStatus: fresh.approval_status,
    },
  };
};

module.exports = {
  registerShopper,
  saveStepAsAdmin,
  uploadAsAdmin,
  submitAsAdmin,
  issueActivationCode,
  activateAccount,
};
