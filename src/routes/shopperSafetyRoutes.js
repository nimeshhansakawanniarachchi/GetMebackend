const express = require('express');

const shopperAuthMiddleware = require('../middleware/shopperAuthMiddleware');
const training = require('../compliance/training');
const incidents = require('../compliance/incidents');

// =====================================================
// SHOPPER TRAINING QUIZ + "I NEED HELP" (phase 46)
//   GET  /api/shopper/training            status, rules, questions (no answers)
//   POST /api/shopper/training/submit     { answers: { [questionId]: optionIndex }, questionsVersion }
//   POST /api/shopper/incidents           { type, orderId?, note?, latitude?, longitude?, clientRequestId? }
//   GET  /api/shopper/incidents?active=1  own help requests
//   GET  /api/shopper/incidents/:id       own help request
// Every route needs the shopper's token; incidents are always the
// signed-in shopper's own (an order must be theirs).
// =====================================================

const router = express.Router();

const requireShopper = (req, res, next) => {
  if (!Number(req.shopper?.shopperId)) {
    return res.status(401).json({ success: false, message: 'Shopper authentication required' });
  }
  return next();
};

router.get('/training', shopperAuthMiddleware, requireShopper, training.getTraining);
router.post('/training/submit', shopperAuthMiddleware, requireShopper, training.submitTraining);

router.post('/incidents', shopperAuthMiddleware, requireShopper, incidents.createIncident);
router.get('/incidents', shopperAuthMiddleware, requireShopper, incidents.listMyIncidents);
router.get('/incidents/:id', shopperAuthMiddleware, requireShopper, incidents.getMyIncident);

module.exports = router;
