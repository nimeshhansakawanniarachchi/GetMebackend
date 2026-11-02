const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const activity = require('../customerActivity/customerController');

const router = express.Router();

// ==================================================
// CUSTOMER ACTIVITY + LOCATION SHARING (phase 51)
// Location points are refused unless the customer turned location
// sharing on (consent) - see src/customerActivity/customerController.js
// ==================================================

router.get('/activity/location-settings', authMiddleware, activity.getLocationSettings);
router.put('/activity/location-consent', authMiddleware, activity.setLocationConsent);
router.post('/activity/location-permission', authMiddleware, activity.reportLocationPermission);
router.post('/activity/locations', authMiddleware, activity.recordLocations);
router.post('/activity/tracking/stop', authMiddleware, activity.stopTracking);
router.post('/activity/events', authMiddleware, activity.recordEvents);

module.exports = router;
