const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const db = require('../config/db');
const loginRateLimit = require('../middleware/loginRateLimit');
const shopperAuthMiddleware = require('../middleware/shopperAuthMiddleware');
const { emitToAdmins } = require('../realtime');
const { normalizeSriLankanMobile } = require('../utils/phone');
const otp = require('../onboarding/otp');
const { signShopperToken } = require('../utils/shopperSession');
const applications = require('../onboarding/applications');

// =====================================================
// SHOPPER REGISTRATION + APPLICATION (phase 34)
// Public (rate limited):
//   POST /api/shopper/register/otp/send    { mobile }
//   POST /api/shopper/register/otp/verify  { mobile, code } -> { proof }
//   POST /api/shopper/register/start
//        { fullName, mobile, email?, dateOfBirth, password,
//          confirmPassword, phoneProof? } -> { token, shopper, ... }
//        (creates the account + its application; the phone counts as
//        verified only with a proof from a correct SMS code)
// Signed-in applicant:
//   GET   /api/shopper/application
//   PATCH /api/shopper/application                 { step, ...fields }
//   POST  /api/shopper/application/documents       multipart file + docType
//   GET   /api/shopper/application/documents/:id   (the applicant's own file)
//   POST  /api/shopper/application/submit          { acceptTerms, acceptPrivacy, requestId }
// Never logs NIC, licence, bank or OTP values.
// =====================================================

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

const shopperIdOf = (req) => Number(req.shopper?.shopperId);

const sendError = (res, error, fallback) => {
  const status = error?.status || 500;

  if (!error?.status) {
    console.error(`❌ ${fallback}:`, error?.message || error);
  }

  return res.status(status).json({
    success: false,
    code: error?.code,
    field: error?.field,
    steps: error?.steps,
    retryInSeconds: error?.retryInSeconds,
    attemptsLeft: error?.attemptsLeft,
    // Only our own errors (with a status) are shown; never database text
    message: error?.status ? error.message : fallback,
  });
};

const announce = (req, shopperId, reason) => {
  try {
    emitToAdmins(req.app.get('io'), 'admin:shopper-applications-updated', { shopperId, reason });
    emitToAdmins(req.app.get('io'), 'admin:shoppers-updated', { shopperId, reason });
  } catch {
    // sockets are best effort
  }
};

// ---------------- OTP ----------------

router.post('/register/otp/send', loginRateLimit, async (req, res) => {
  const mobile = normalizeSriLankanMobile(req.body?.mobile);

  if (!mobile) {
    return res.status(400).json({ success: false, field: 'mobile', message: 'Enter a valid Sri Lankan mobile number (e.g. 077 123 4567)' });
  }

  try {
    const taken = (await db.query('SELECT 1 FROM shoppers WHERE mobile = $1', [mobile])).rows.length > 0;

    if (taken) {
      return res.status(409).json({ success: false, code: 'MOBILE_TAKEN', field: 'mobile', message: 'This number already has a GetMe shopper account. Sign in instead.' });
    }

    const result = await otp.sendCode(mobile);
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to send the code');
  }
});

router.post('/register/otp/verify', loginRateLimit, async (req, res) => {
  const mobile = normalizeSriLankanMobile(req.body?.mobile);

  if (!mobile) {
    return res.status(400).json({ success: false, field: 'mobile', message: 'Enter a valid Sri Lankan mobile number' });
  }

  try {
    const result = await otp.verifyCode(mobile, req.body?.code);
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to check the code');
  }
});

// ---------------- Account (step 1) ----------------

router.post('/register/start', loginRateLimit, async (req, res) => {
  const mobile = normalizeSriLankanMobile(req.body?.mobile);
  const password = String(req.body?.password || '');
  const confirmPassword = String(req.body?.confirmPassword || '');

  let personal;

  try {
    personal = applications.validatePersonal(req.body || {});
  } catch (error) {
    return sendError(res, error, 'Registration failed');
  }

  if (!mobile) {
    return res.status(400).json({ success: false, field: 'mobile', message: 'Enter a valid Sri Lankan mobile number (e.g. 077 123 4567)' });
  }

  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return res.status(400).json({ success: false, field: 'password', message: 'Use at least 8 characters with letters and numbers' });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({ success: false, field: 'confirmPassword', message: "The passwords don't match" });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    const existing = (
      await client.query(
        'SELECT id FROM shoppers WHERE mobile = $1 OR ($2::text IS NOT NULL AND LOWER(email) = $2) LIMIT 1',
        [mobile, personal.email]
      )
    ).rows[0];

    if (existing) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, code: 'ALREADY_REGISTERED', message: 'This mobile number or email already has a GetMe shopper account. Sign in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const shopper = (
      await client.query(
        `
        INSERT INTO shoppers (full_name, mobile, email, password_hash, status, approval_status)
        VALUES ($1, $2, $3, $4, 'offline', 'pending')
        RETURNING id, full_name, mobile, email, status, approval_status, created_at
        `,
        [personal.fullName, mobile, personal.email, passwordHash]
      )
    ).rows[0];

    await client.query(
      `
      INSERT INTO shopper_applications (shopper_id, full_name, date_of_birth, email)
      VALUES ($1, $2, $3, $4)
      `,
      [shopper.id, personal.fullName, personal.dateOfBirth, personal.email]
    );

    const app = (await client.query('SELECT id FROM shopper_applications WHERE shopper_id = $1', [shopper.id])).rows[0];
    await applications.addEvent(client, app.id, { action: 'account_created', to: 'draft', actorType: 'shopper', actorId: shopper.id });

    // Phone verified only with a fresh proof from a correct SMS code
    const verified = await otp.useProof(client, mobile, req.body?.phoneProof);

    if (verified) {
      await applications.markPhoneVerified(client, shopper.id, 'otp');
      await applications.addEvent(client, app.id, { action: 'phone_verified', actorType: 'shopper', actorId: shopper.id, note: 'SMS code' });
    }

    await client.query('COMMIT');

    const token = signShopperToken({ ...shopper, auth_version: 0 });

    announce(req, shopper.id, 'registered');

    return res.status(201).json({
      success: true,
      message: 'Account created. Continue your application.',
      token,
      shopper: {
        id: shopper.id,
        fullName: shopper.full_name,
        mobile: shopper.mobile,
        email: shopper.email,
        status: shopper.status,
        approvalStatus: shopper.approval_status,
        createdAt: shopper.created_at,
      },
      phoneVerified: verified,
      ...(await applications.getForShopper(shopper.id)),
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (error.code === '23505') {
      return res.status(409).json({ success: false, code: 'ALREADY_REGISTERED', message: 'This mobile number or email already has a GetMe shopper account. Sign in instead.' });
    }

    return sendError(res, error, 'Registration failed');
  } finally {
    client.release();
  }
});

// ---------------- Activation of an admin-registered account (phase 37) ----------------
// POST /api/shopper/auth/activate { mobile, code, password, confirmPassword } -> { token, shopper }

router.post('/auth/activate', loginRateLimit, async (req, res) => {
  try {
    const result = await require('../onboarding/adminRegistration').activateAccount(req.body || {});
    return res.json({ success: true, message: 'Your account is active. Welcome to GetMe!', ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to activate the account');
  }
});

// ---------------- Application (signed in) ----------------

router.get('/application', shopperAuthMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...(await applications.getForShopper(shopperIdOf(req))) });
  } catch (error) {
    return sendError(res, error, 'Unable to load your application');
  }
});

router.patch('/application', shopperAuthMiddleware, async (req, res) => {
  try {
    return res.json({ success: true, message: 'Saved', ...(await applications.saveStep(shopperIdOf(req), req.body || {})) });
  } catch (error) {
    return sendError(res, error, 'Unable to save');
  }
});

router.post(
  '/application/documents',
  shopperAuthMiddleware,
  (req, res, next) =>
    upload.single('file')(req, res, (error) => {
      if (error) {
        return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
          success: false,
          code: error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED',
          message: error.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (max 8 MB)' : 'The upload failed. Try again.',
        });
      }
      return next();
    }),
  async (req, res) => {
    try {
      const document = await applications.uploadDocument(shopperIdOf(req), String(req.body?.docType || ''), req.file);
      return res.status(201).json({ success: true, document, ...(await applications.getForShopper(shopperIdOf(req))) });
    } catch (error) {
      return sendError(res, error, 'Unable to upload the document');
    }
  }
);

router.get('/application/documents/:id', shopperAuthMiddleware, async (req, res) => {
  try {
    const file = await applications.documentFile(req.params.id, { shopperId: shopperIdOf(req) });
    res.set('Cache-Control', 'private, no-store');
    res.type(file.mimeType);
    return res.sendFile(file.filePath);
  } catch (error) {
    return sendError(res, error, 'Unable to load the document');
  }
});

router.post('/application/submit', shopperAuthMiddleware, async (req, res) => {
  try {
    const result = await applications.submit(shopperIdOf(req), req.body || {});

    if (!result.duplicate) announce(req, shopperIdOf(req), 'application_submitted');

    return res.json({
      success: true,
      message: result.duplicate ? 'Already submitted' : 'Application submitted. GetMe will review it and let you know.',
      ...result,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to submit');
  }
});

module.exports = router;
