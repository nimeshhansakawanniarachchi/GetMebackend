const express = require('express');
const path = require('path');
const crypto = require('crypto');

const shopperAuthMiddleware = require('../middleware/shopperAuthMiddleware');
// Checks each stored file's real type (security review B-02)
const multer = require('../middleware/verifiedMulter');
const fuel = require('../fuel/fuelPayments');

const router = express.Router();

// =====================================================
// FUEL STATION PAYMENTS (phase 54) - the shopper's own expense
//   GET  /fuel/stations?latitude=&longitude=
//   GET  /fuel/payments            history (own)
//   GET  /fuel/payments/:id        details + receipt + status history
//   POST /fuel/payments            { requestId, stationId, fuelType, litres|amount,
//                                    vehicleReg?, paymentMethod, payerApp?, qrPayload? }
//   POST /fuel/payments/:id/report { amountPaid, reference?, payerApp? }
//   POST /fuel/payments/:id/receipt  multipart "receipt" (photo)
//   POST /fuel/payments/:id/cancel
// =====================================================

const RECEIPT_DIR = path.resolve(__dirname, '..', 'uploads', 'fuel-receipts');
require('fs').mkdirSync(RECEIPT_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RECEIPT_DIR),
    // Random, unguessable names (the folder is private anyway)
    filename: (req, file, cb) => cb(null, `fuel-${crypto.randomBytes(12).toString('hex')}.jpg`),
  }),
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(String(file.mimetype).toLowerCase())),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

const shopperIdOf = (req) => Number(req.shopper?.shopperId);

const send = (handler, okStatus = 200) => async (req, res) => {
  try {
    const result = await handler(req);
    // 201 for a new record, 200 when the same requestId came again
    const status = okStatus === 201 && result?.duplicate ? 200 : okStatus;
    return res.status(status).json({ success: true, ...result });
  } catch (caught) {
    if (!caught.status) console.error('❌ fuel payment error:', caught.message);
    return res.status(caught.status || 500).json({
      success: false,
      code: caught.code || 'SERVER_ERROR',
      message: caught.status ? caught.message : 'Unable to save the fuel payment',
      ...(caught.extra || {}),
    });
  }
};

router.get('/fuel/stations', shopperAuthMiddleware, send((req) => fuel.listStations(req.query)));
router.get('/fuel/payments', shopperAuthMiddleware, send((req) => fuel.listOwn({ shopperId: shopperIdOf(req), query: req.query })));
router.get('/fuel/payments/:id', shopperAuthMiddleware, send((req) => fuel.getOwn({ shopperId: shopperIdOf(req), id: req.params.id })));
// Phase 56: authBaseUrl = where the TEST SIMULATOR's approval page lives
// (a real bank sends its own page); the simulator outcome header works
// only with the simulator
router.post('/fuel/payments', shopperAuthMiddleware, send((req) => fuel.startPayment({
  shopperId: shopperIdOf(req),
  body: req.body,
  authBaseUrl: require('../payments/payhere').publicBaseUrl(req),
  testOutcome: req.get('X-GetMe-Simulator-Outcome') || null,
}), 201));
router.post('/fuel/payments/:id/report', shopperAuthMiddleware, send((req) => fuel.reportPayment({ shopperId: shopperIdOf(req), id: req.params.id, body: req.body })));
router.post('/fuel/payments/:id/cancel', shopperAuthMiddleware, send((req) => fuel.cancelPayment({ shopperId: shopperIdOf(req), id: req.params.id })));
router.post(
  '/fuel/payments/:id/receipt',
  shopperAuthMiddleware,
  fuel.requireOwnOpenPayment,
  upload.single('receipt'),
  send((req) => fuel.saveReceipt({ shopperId: shopperIdOf(req), id: req.params.id, file: req.file }))
);

module.exports = router;
