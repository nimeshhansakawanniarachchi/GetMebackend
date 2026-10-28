const multer = require('multer');

const registration = require('../../onboarding/adminRegistration');
const { emitToAdmins } = require('../../realtime');

// =====================================================
// ADMIN: REGISTER A SHOPPER (phase 37) - Owner / Operations
//   POST  /api/admin/shopper-registrations                       -> account + application + activation code (shown once)
//   PATCH /api/admin/shopper-registrations/:applicationId/steps   { step, ...fields }
//   POST  /api/admin/shopper-registrations/:applicationId/documents  multipart file + docType
//   POST  /api/admin/shopper-registrations/:applicationId/submit  { consentConfirmed, requestId }
//   POST  /api/admin/shoppers/:id/activation-code                 -> new code (old ones stop working)
// Review + approval use the normal application endpoints
// (maker-checker: the registrar can't accept documents / approve).
// =====================================================

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

const sendError = (res, error, fallback) => {
  if (!error?.status) console.error(`❌ ${fallback}:`, error?.message || error);

  return res.status(error?.status || 500).json({
    success: false,
    code: error?.code,
    field: error?.field,
    message: error?.status ? error.message : fallback,
  });
};

const adminIdOf = (req) => Number(req.admin?.adminId);

const announce = (req, payload) => {
  try {
    emitToAdmins(req.app.get('io'), 'admin:shopper-applications-updated', payload);
    emitToAdmins(req.app.get('io'), 'admin:shoppers-updated', payload);
  } catch {
    // best effort
  }
};

const registerShopper = async (req, res) => {
  try {
    const result = await registration.registerShopper(req.body || {}, adminIdOf(req));
    announce(req, { shopperId: result.shopper.id, reason: 'registered_by_admin' });
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      success: true,
      message: `Shopper ${result.shopper.shopperCode} registered. Add the documents and photos, then submit for review.`,
      ...result,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to register the shopper');
  }
};

const saveStep = async (req, res) => {
  try {
    const result = await registration.saveStepAsAdmin(req.params.applicationId, req.body || {}, adminIdOf(req));
    announce(req, { applicationId: Number(req.params.applicationId), reason: 'edited_by_admin' });
    res.set('Cache-Control', 'no-store');
    return res.json({
      success: true,
      message: result.activation ? 'Mobile number changed. The old activation code no longer works.' : 'Saved',
      ...result,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to save');
  }
};

const uploadDocument = [
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
      const application = await registration.uploadAsAdmin(req.params.applicationId, String(req.body?.docType || ''), req.file);
      return res.status(201).json({ success: true, application });
    } catch (error) {
      return sendError(res, error, 'Unable to upload the document');
    }
  },
];

const submit = async (req, res) => {
  try {
    const application = await registration.submitAsAdmin(req.params.applicationId, req.body || {}, adminIdOf(req));
    announce(req, { applicationId: Number(req.params.applicationId), status: application.status });
    return res.json({ success: true, message: 'Submitted for review', application });
  } catch (error) {
    return sendError(res, error, 'Unable to submit');
  }
};

const activationCode = async (req, res) => {
  try {
    const activation = await registration.issueActivationCode(req.params.id, adminIdOf(req));
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      success: true,
      message: activation.sentBySms ? 'New code sent by SMS (also shown once here)' : 'New code created. It is shown only once: give it to the shopper in person.',
      activation,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to create an activation code');
  }
};

module.exports = { registerShopper, saveStep, uploadDocument, submit, activationCode };
