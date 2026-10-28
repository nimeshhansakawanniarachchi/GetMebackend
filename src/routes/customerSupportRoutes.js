const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const { acceptPhotos } = require('../support/supportPhotos');
const support = require('../controllers/customerSupportController');

// =====================================================
// CUSTOMER SUPPORT CASES + GETME CREDIT (phase 43)
// Mounted at /api/customer. Every route needs the customer's token and
// only works on the customer's own orders / cases.
// =====================================================

const router = express.Router();

router.get('/support/orders/:orderId/eligibility', authMiddleware, support.getEligibility);
router.get('/support/cases', authMiddleware, support.listCases);
router.post('/support/cases', authMiddleware, acceptPhotos, support.createCase);
router.get('/support/cases/:id', authMiddleware, support.getCase);
router.post('/support/cases/:id/messages', authMiddleware, support.addMessage);
router.get('/credit', authMiddleware, support.getCredit);

module.exports = router;
