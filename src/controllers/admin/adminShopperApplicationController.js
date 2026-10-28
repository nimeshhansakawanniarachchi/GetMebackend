const applications = require('../../onboarding/applications');
const { createShopperNotification } = require('../shopperNotificationController');
const { emitToAdmins } = require('../../realtime');

// =====================================================
// ADMIN: SHOPPER APPLICATIONS (phase 34)
//   GET   /api/admin/shopper-applications            ops + support (no identity data)
//   GET   /api/admin/shopper-applications/:id        owner + operations
//   GET   /api/admin/shopper-applications/:id/documents/:docId   owner + operations
//   PATCH /api/admin/shopper-applications/:id        owner + operations
//         { action: start_review | request_info | approve | reject |
//           confirm_phone | delete_documents, reason, items,
//           verifyBankAccount }
// Opening an application or a document is recorded in its history.
// =====================================================

const sendError = (res, error, fallback) => {
  const status = error?.status || 500;

  if (status >= 500) console.error(`❌ ${fallback}:`, error?.message || error);

  return res.status(status).json({
    success: false,
    code: error?.code,
    message: status >= 500 ? fallback : error.message,
  });
};

const adminIdOf = (req) => Number(req.admin?.adminId);

const listApplications = async (req, res) => {
  try {
    return res.json({ success: true, ...(await applications.adminList(req.query)) });
  } catch (error) {
    return sendError(res, error, 'Unable to load applications');
  }
};

const getApplication = async (req, res) => {
  try {
    const detail = await applications.adminDetail(req.params.id);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, application: detail });
  } catch (error) {
    return sendError(res, error, 'Unable to load the application');
  }
};

const getDocument = async (req, res) => {
  try {
    const file = await applications.documentFile(req.params.docId, { applicationId: Number(req.params.id) });

    // Who looked at which identity document
    const pool = require('../../config/db');
    const client = await pool.connect();
    try {
      await applications.addEvent(client, Number(req.params.id), {
        action: 'document_viewed',
        actorType: 'admin',
        actorId: adminIdOf(req),
        note: applications.DOC_TYPES[file.docType]?.label || file.docType,
      });
    } finally {
      client.release();
    }

    res.set('Cache-Control', 'private, no-store');
    res.type(file.mimeType);
    return res.sendFile(file.filePath);
  } catch (error) {
    return sendError(res, error, 'Unable to load the document');
  }
};

const NOTICES = {
  start_review: () => ['Application under review', 'GetMe is reviewing your shopper application.'],
  request_info: (r) => ['More information needed', r.reason || 'GetMe needs more information for your application.'],
  approve: () => ['You are approved', 'Welcome to GetMe! You can now go online and accept orders.'],
  reject: (r) => ['Application not approved', r.reason || 'Your shopper application was not approved.'],
};

const actOnApplication = async (req, res) => {
  const action = String(req.body?.action || '');

  try {
    const result = await applications.adminAction(req.params.id, action, req.body || {}, adminIdOf(req));
    const io = req.app.get('io');

    if (NOTICES[action]) {
      const [title, body] = NOTICES[action](result);
      createShopperNotification({ io, shopperId: result.application.shopperId, type: 'application', title, body }).catch(() => {});
    }

    try {
      io?.to(`shopper:${result.application.shopperId}`).emit('shopper-application-updated', { status: result.application.status });
      emitToAdmins(io, 'admin:shopper-applications-updated', { applicationId: result.application.id, status: result.application.status });
      emitToAdmins(io, 'admin:shoppers-updated', { shopperId: result.application.shopperId, reason: `application_${action}` });
    } catch {
      // best effort
    }

    return res.json({
      success: true,
      message: {
        start_review: 'Marked under review',
        request_info: 'Sent back to the applicant',
        approve: 'Approved. The shopper can go online now.',
        reject: 'Application rejected',
        confirm_phone: 'Phone number confirmed',
        delete_documents: 'Documents deleted',
      }[action],
      application: result.application,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to update the application');
  }
};

module.exports = { listApplications, getApplication, getDocument, actOnApplication };

// PATCH /api/admin/shopper-applications/:id/documents/:docId
//   { decision: accept | reject, note } (phase 36: each document and
//   vehicle photo is accepted one by one before approval)
const reviewApplicationDocument = async (req, res) => {
  try {
    const application = await applications.reviewDocument(req.params.id, req.params.docId, req.body || {}, adminIdOf(req));
    return res.json({ success: true, message: req.body?.decision === 'reject' ? 'Document rejected' : 'Document accepted', application });
  } catch (error) {
    return sendError(res, error, 'Unable to review the document');
  }
};

// GET /api/admin/shoppers/:id/vehicle-records (verified vehicle + history)
const getVehicleRecords = async (req, res) => {
  try {
    return res.json({ success: true, records: await applications.vehicleRecords(req.params.id) });
  } catch (error) {
    return sendError(res, error, 'Unable to load the vehicle records');
  }
};

module.exports.reviewApplicationDocument = reviewApplicationDocument;
module.exports.getVehicleRecords = getVehicleRecords;
