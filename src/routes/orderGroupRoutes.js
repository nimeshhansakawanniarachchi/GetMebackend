// =====================================================
// PHASE 65: ONE CHECKOUT FOR EVERY CATEGORY (parent orders)
// customerRouter -> /api/customer, adminRouter -> /api/admin
// New paths only; mounted in app.js after the existing routers.
// =====================================================

const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const { requirePermission: can } = require('../middleware/adminAccess');
const groups = require('../orderGroups/orderGroups');

const customerRouter = express.Router();
customerRouter.post('/order-groups/quote', authMiddleware, groups.getGroupQuote);
customerRouter.post('/order-groups', authMiddleware, groups.createGroup);
customerRouter.get('/order-groups', authMiddleware, groups.listGroups);
customerRouter.get('/order-groups/:id', authMiddleware, groups.getGroup);

const adminRouter = express.Router();
adminRouter.get('/order-groups/:id', requireAdmin, can('orders.view'), groups.adminGetGroup);

module.exports = { customerRouter, adminRouter };
