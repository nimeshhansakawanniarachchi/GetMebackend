const express = require('express');
const multer = require('multer');

// Keyed by account, not just IP (see the middleware)
const loginRateLimit = require('../middleware/accountChangeRateLimit');
const shopperAuthMiddleware = require('../middleware/shopperAuthMiddleware');
const { emitToAdmins } = require('../realtime');
const { normalizeSriLankanMobile } = require('../utils/phone');
const { signShopperToken, disconnectShopper } = require('../utils/shopperSession');
const changes = require('../onboarding/changeRequests');
const otp = require('../onboarding/otp');
const db = require('../config/db');

// =====================================================
// SHOPPER PROFILE PROTECTION (phase 35)
// Signed in:
//   GET  /api/shopper/profile/protected            registered values + requests
//   POST /api/shopper/profile/change-requests       { type: vehicle_change | identity_change, ...fields }
//   GET  /api/shopper/profile/change-requests/:id
//   POST /api/shopper/profile/change-requests/:id/documents   multipart file + docType
//   GET  /api/shopper/profile/change-requests/:id/documents/:docId
//   POST /api/shopper/profile/change-requests/:id/submit
//   POST /api/shopper/profile/change-requests/:id/cancel
//   POST /api/shopper/profile/phone-change          { newMobile, password, note }
//   POST /api/shopper/profile/phone-change/:id/verify { target: new|current, code }
//   POST /api/shopper/profile/phone-change/:id/resend { target }
// Signed out (lost phone, rate limited):
//   POST /api/shopper/account-recovery/otp/send     { newMobile }
//   POST /api/shopper/account-recovery/otp/verify   { newMobile, code } -> { proof }
//   POST /api/shopper/account-recovery              multipart fields + selfie, nic_front[, nic_back]
//   GET  /api/shopper/account-recovery/:id?token=
//   POST /api/shopper/account-recovery/:id/documents?token=   file + docType
//   POST /api/shopper/account-recovery/:id/resubmit?token=
// =====================================================

const router = express.Router();

const memory = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 3 } });

const shopperIdOf = (req) => Number(req.shopper?.shopperId);

const sendError = (res, error, fallback) => {
  if (!error?.status) console.error(`❌ ${fallback}:`, error?.message || error);

  return res.status(error?.status || 500).json({
    success: false,
    code: error?.code,
    field: error?.field,
    missing: error?.missing,
    retryInSeconds: error?.retryInSeconds,
    attemptsLeft: error?.attemptsLeft,
    // Only our own errors are shown (never database text)
    message: error?.status ? error.message : fallback,
  });
};

const withUpload = (handler) => (req, res, next) =>
  handler(req, res, (error) => {
    if (error) {
      return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        success: false,
        code: error.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED',
        message: error.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (max 8 MB)' : 'The upload failed. Try again.',
      });
    }
    return next();
  });

const toAdmins = (req, payload) => {
  try {
    emitToAdmins(req.app.get('io'), 'admin:shopper-change-requests-updated', payload);
  } catch {
    // best effort
  }
};

// ---------------- signed in ----------------

router.get('/profile/protected', shopperAuthMiddleware, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...(await changes.myOverview(shopperIdOf(req))) });
  } catch (error) {
    return sendError(res, error, 'Unable to load your profile');
  }
});

router.post('/profile/change-requests', shopperAuthMiddleware, async (req, res) => {
  try {
    return res.status(201).json({ success: true, message: 'Saved. Upload the documents, then send the request.', ...(await changes.saveRequest(shopperIdOf(req), req.body || {})) });
  } catch (error) {
    return sendError(res, error, 'Unable to save the request');
  }
});

router.get('/profile/change-requests/:id', shopperAuthMiddleware, async (req, res) => {
  try {
    return res.json({ success: true, ...(await changes.getMyRequest(shopperIdOf(req), req.params.id)) });
  } catch (error) {
    return sendError(res, error, 'Unable to load the request');
  }
});

router.post('/profile/change-requests/:id/documents', shopperAuthMiddleware, withUpload(memory.single('file')), async (req, res) => {
  try {
    return res.status(201).json({ success: true, ...(await changes.uploadMyDocument(shopperIdOf(req), req.params.id, String(req.body?.docType || ''), req.file)) });
  } catch (error) {
    return sendError(res, error, 'Unable to upload the document');
  }
});

router.get('/profile/change-requests/:id/documents/:docId', shopperAuthMiddleware, async (req, res) => {
  try {
    const file = await changes.documentFile(req.params.docId, { shopperId: shopperIdOf(req), requestId: req.params.id });
    res.set('Cache-Control', 'private, no-store');
    res.type(file.mimeType);
    return res.sendFile(file.filePath);
  } catch (error) {
    return sendError(res, error, 'Unable to load the document');
  }
});

router.post('/profile/change-requests/:id/submit', shopperAuthMiddleware, async (req, res) => {
  try {
    const result = await changes.submitMyRequest(shopperIdOf(req), req.params.id);
    if (!result.duplicate) toAdmins(req, { requestId: Number(req.params.id), status: 'pending_review' });
    return res.json({ success: true, message: result.duplicate ? 'Already sent' : 'Request sent. GetMe will review it.', ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to send the request');
  }
});

router.post('/profile/change-requests/:id/cancel', shopperAuthMiddleware, async (req, res) => {
  try {
    const result = await changes.cancelMyRequest(shopperIdOf(req), req.params.id);
    toAdmins(req, { requestId: Number(req.params.id), status: 'cancelled' });
    return res.json({ success: true, message: 'Request cancelled', ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to cancel the request');
  }
});

router.post('/profile/phone-change', shopperAuthMiddleware, loginRateLimit, async (req, res) => {
  try {
    const result = await changes.startPhoneChange(shopperIdOf(req), req.body || {});
    toAdmins(req, { requestId: result.request.id, status: result.request.status });
    return res.status(201).json({
      success: true,
      message:
        result.request.status === 'pending_verification'
          ? 'We sent a code to your new number and to your current number.'
          : 'SMS verification is not set up yet, so GetMe will call you to confirm the change. Your number stays the same until then.',
      ...result,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to start the phone number change');
  }
});

router.post('/profile/phone-change/:id/verify', shopperAuthMiddleware, loginRateLimit, async (req, res) => {
  try {
    const result = await changes.verifyPhoneChange(shopperIdOf(req), req.params.id, req.body || {});

    if (result.applied) {
      // Older logins end; this phone gets a fresh token
      const shopper = (await db.query('SELECT id, email, auth_version FROM shoppers WHERE id = $1', [shopperIdOf(req)])).rows[0];
      disconnectShopper(req.app.get('io'), shopperIdOf(req));
      return res.json({ success: true, message: 'Your phone number was changed. Other devices were signed out.', token: signShopperToken(shopper), ...result });
    }

    toAdmins(req, { requestId: Number(req.params.id), status: result.request.status });
    return res.json({ success: true, ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to check the code');
  }
});

router.post('/profile/phone-change/:id/resend', shopperAuthMiddleware, loginRateLimit, async (req, res) => {
  try {
    return res.json({ success: true, ...(await changes.resendPhoneCode(shopperIdOf(req), req.params.id, req.body || {})) });
  } catch (error) {
    return sendError(res, error, 'Unable to send the code');
  }
});

// ---------------- signed out: lost phone ----------------

router.post('/account-recovery/otp/send', loginRateLimit, async (req, res) => {
  const mobile = normalizeSriLankanMobile(req.body?.newMobile);
  if (!mobile) return res.status(400).json({ success: false, field: 'newMobile', message: 'Enter a valid Sri Lankan mobile number' });

  try {
    return res.json({ success: true, ...(await otp.sendCode(mobile, { purpose: 'recovery_new' })) });
  } catch (error) {
    return sendError(res, error, 'Unable to send the code');
  }
});

router.post('/account-recovery/otp/verify', loginRateLimit, async (req, res) => {
  const mobile = normalizeSriLankanMobile(req.body?.newMobile);
  if (!mobile) return res.status(400).json({ success: false, field: 'newMobile', message: 'Enter a valid Sri Lankan mobile number' });

  try {
    return res.json({ success: true, ...(await otp.verifyCode(mobile, req.body?.code, { purpose: 'recovery_new' })) });
  } catch (error) {
    return sendError(res, error, 'Unable to check the code');
  }
});

router.post(
  '/account-recovery',
  loginRateLimit,
  withUpload(memory.fields([{ name: 'selfie', maxCount: 1 }, { name: 'nic_front', maxCount: 1 }, { name: 'nic_back', maxCount: 1 }])),
  async (req, res) => {
    try {
      const files = Object.fromEntries(Object.entries(req.files || {}).map(([key, list]) => [key, list[0]]));
      const result = await changes.startRecovery(req.body || {}, files);
      toAdmins(req, { requestId: result.reference, status: 'pending_review', type: 'phone_recovery' });
      return res.status(201).json({
        success: true,
        message: 'Request received. GetMe will check your identity and contact you on your new number. Keep the reference and status code to check progress.',
        ...result,
      });
    } catch (error) {
      return sendError(res, error, 'Unable to send the recovery request');
    }
  }
);

router.get('/account-recovery/:id', loginRateLimit, async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, ...(await changes.recoveryStatus(req.params.id, req.query.token)) });
  } catch (error) {
    return sendError(res, error, 'Unable to load the request');
  }
});

router.post('/account-recovery/:id/documents', loginRateLimit, withUpload(memory.single('file')), async (req, res) => {
  try {
    return res.status(201).json({ success: true, ...(await changes.recoveryUpload(req.params.id, req.query.token, String(req.body?.docType || ''), req.file)) });
  } catch (error) {
    return sendError(res, error, 'Unable to upload the document');
  }
});

router.post('/account-recovery/:id/resubmit', loginRateLimit, async (req, res) => {
  try {
    const result = await changes.recoveryResubmit(req.params.id, req.query.token);
    toAdmins(req, { requestId: Number(req.params.id), status: 'pending_review', type: 'phone_recovery' });
    return res.json({ success: true, message: 'Sent back to GetMe', ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to resubmit');
  }
});

module.exports = router;
