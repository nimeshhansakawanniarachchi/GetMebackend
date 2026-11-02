var express = require('express');
var router = express.Router();

// API server: no web pages here (the old jade welcome page was removed)
router.get('/', function (req, res) {
  res.json({ success: true, service: 'GetMe API' });
});

module.exports = router;
