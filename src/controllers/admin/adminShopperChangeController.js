const changes = require('../../onboarding/changeRequests');
const { createShopperNotification } = require('../shopperNotificationController');
const { emitToAdmins } = require('../../realtime');
const { disconnectShopper } = require('../../utils/shopperSession');

// =====================================================
// ADMIN: SHOPPER CHANGE REQUESTS (phase 35) - Owner / Operations
//   GET   /api/admin/shopper-change-requests?type=&status=open|...&q=
//   GET   /api/admin/shopper-change-requests/:id
//   GET   /api/admin/shopper-change-requests/:id/documents/:docId
//   PATCH /api/admin/shopper-change-requests/:id  { action: approve | reject | request_info, reason, items }
//   PATCH /api/admin/shoppers/:id/vehicle-restriction { restricted, reason }
//   GET   /api/admin/shoppers/:id/profile-history
// =====================================================

const sendError = (res, error, fallback) => {
  if (!error?.status) console.error(`❌ ${fallback}:`, error?.message || error);

  return res.status(error?.status || 500).json({
    success: false,
    code: error?.code,
    message: error?.status ? error.message : fallback,
  });
};

const adminIdOf = (req) => Number(req.admin?.adminId);

const listRequests = async (req, res) => {
  try {
    return res.json({ success: true, ...(await changes.adminList(req.query)) });
  } catch (error) {
    return sendError(res, error, 'Unable to load change requests');
  }
};

const getRequest = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, request: await changes.adminDetail(req.params.id) });
  } catch (error) {
    return sendError(res, error, 'Unable to load the request');
  }
};

const getDocument = async (req, res) => {
  try {
    const file = await changes.documentFile(req.params.docId, { requestId: req.params.id });
    res.set('Cache-Control', 'private, no-store');
    res.type(file.mimeType);
    return res.sendFile(file.filePath);
  } catch (error) {
    return sendError(res, error, 'Unable to load the document');
  }
};

const NOTICES = {
  approve: (r) => [`${changes.TYPE_LABELS[r.type]} approved`, r.type === 'vehicle_change' ? 'Your registered vehicle was updated.' : r.type === 'identity_change' ? 'Your registered name / NIC was updated.' : 'Your phone number was changed. Sign in again with the new number.'],
  reject: (r) => [`${changes.TYPE_LABELS[r.type]} not approved`, r.request.decisionReason || 'Your request was not approved.'],
  request_info: (r) => ['More information needed', r.request.decisionReason || 'GetMe needs more information for your request.'],
};

const actOnRequest = async (req, res) => {
  const action = String(req.body?.action || '');

  try {
    const result = await changes.adminAction(req.params.id, action, req.body || {}, adminIdOf(req));
    const io = req.app.get('io');

    // A changed number ends every older login (sockets too)
    if (action === 'approve' && ['phone_change', 'phone_recovery'].includes(result.type)) {
      disconnectShopper(io, result.shopperId);
    }

    if (NOTICES[action]) {
      const [title, body] = NOTICES[action](result);
      createShopperNotification({ io, shopperId: result.shopperId, type: 'account', title, body }).catch(() => {});
    }

    try {
      io?.to(`shopper:${result.shopperId}`).emit('shopper-profile-updated', { requestId: Number(req.params.id), status: result.request.status });
      emitToAdmins(io, 'admin:shopper-change-requests-updated', { requestId: Number(req.params.id), status: result.request.status });
      emitToAdmins(io, 'admin:shoppers-updated', { shopperId: result.shopperId, reason: `change_${action}` });
    } catch {
      // best effort
    }

    return res.json({
      success: true,
      message: { approve: 'Approved and applied', reject: 'Request rejected', request_info: 'Sent back to the shopper' }[action],
      request: result.request,
    });
  } catch (error) {
    return sendError(res, error, 'Unable to update the request');
  }
};

const setVehicleRestriction = async (req, res) => {
  try {
    const result = await changes.setVehicleRestriction(req.params.id, req.body || {}, adminIdOf(req));
    const io = req.app.get('io');

    createShopperNotification({
      io,
      shopperId: Number(req.params.id),
      type: 'account',
      title: result.restricted ? 'Vehicle restricted' : 'Vehicle restriction lifted',
      body: result.restricted ? `${result.reason}. You can't go online until this is resolved.` : 'You can go online again.',
    }).catch(() => {});

    try {
      io?.to(`shopper:${req.params.id}`).emit('shopper-profile-updated', { restriction: result.reason });
      emitToAdmins(io, 'admin:shoppers-updated', { shopperId: Number(req.params.id), reason: 'vehicle_restriction' });
    } catch {
      // best effort
    }

    return res.json({ success: true, message: result.restricted ? 'Vehicle restricted' : 'Restriction lifted', ...result });
  } catch (error) {
    return sendError(res, error, 'Unable to update the restriction');
  }
};

const getProfileHistory = async (req, res) => {
  try {
    return res.json({ success: true, history: await changes.profileHistory(req.params.id) });
  } catch (error) {
    return sendError(res, error, 'Unable to load the history');
  }
};

module.exports = { listRequests, getRequest, getDocument, actOnRequest, setVehicleRestriction, getProfileHistory };

// PATCH /api/admin/shopper-change-requests/:id/documents/:docId
//   { decision: accept | reject, note } (phase 36)
const reviewRequestDocument = async (req, res) => {
  try {
    const request = await changes.reviewDocument(req.params.id, req.params.docId, req.body || {}, adminIdOf(req));
    return res.json({ success: true, message: req.body?.decision === 'reject' ? 'Document rejected' : 'Document accepted', request });
  } catch (error) {
    return sendError(res, error, 'Unable to review the document');
  }
};

module.exports.reviewRequestDocument = reviewRequestDocument;
