// =====================================================
// PHASE 62: FASHION REELS ROUTES
//   /api/media/reels/:id/:kind      signed media (video / cover)
//   /api/customer/reels...          feed, events, reports, follows (auth)
//   /api/shop/reels...              clothing shop management (manager+)
//   /api/admin/reels...             moderation
// Contract: code-backups/reports/p62-fashion-reels-api-contract.md
// =====================================================

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const authMiddleware = require('../middleware/authMiddleware');
const shopAuthMiddleware = require('../middleware/shopAuthMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const { requirePermission: can } = require('../middleware/adminAccess');
const { allowShopRoles } = require('../middleware/shopAccess');

const { REELS_DIR, LIMITS, serveMedia } = require('../reels/common');
const shop = require('../reels/shopReels');
const customer = require('../reels/customerReels');
const admin = require('../reels/adminReels');

// Uploads land in the private reels folder under a random temporary
// name; the controllers check the real content (MP4 / MOV boxes, image
// bytes), then rename or delete them
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-m4v', 'application/octet-stream', ''];
const VIDEO_EXT = ['.mp4', '.mov', '.m4v'];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

const reelUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, REELS_DIR),
    filename: (req, file, cb) => cb(null, `tmp-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`),
  }),
  limits: { fileSize: LIMITS.videoMaxBytes, files: 2, fields: 20 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video') {
      const ext = path.extname(file.originalname || '').toLowerCase();
      return VIDEO_TYPES.includes(file.mimetype || '') && (VIDEO_EXT.includes(ext) || file.mimetype?.startsWith('video/'))
        ? cb(null, true)
        : cb(Object.assign(new Error('Upload an MP4 or MOV video'), { status: 400 }));
    }
    if (file.fieldname === 'cover') {
      return IMAGE_TYPES.includes(file.mimetype)
        ? cb(null, true)
        : cb(Object.assign(new Error('The cover must be a JPG, PNG or WEBP image'), { status: 400 }));
    }
    return cb(Object.assign(new Error('Unexpected file'), { status: 400 }));
  },
});

const fields = reelUpload.fields([{ name: 'video', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);
const upload = (req, res, next) =>
  fields(req, res, (error) => {
    if (!error) return next();
    const fs = require('fs');
    for (const group of Object.values(req.files || {})) for (const f of group) fs.promises.unlink(f.path).catch(() => {});
    const message = error.code === 'LIMIT_FILE_SIZE' ? 'The video is larger than 100 MB' :
      error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE' ? 'Too many files' : error.message || 'Upload failed';
    return res.status(400).json({ success: false, code: error.code === 'LIMIT_FILE_SIZE' ? 'VIDEO_TOO_LARGE' : 'BAD_UPLOAD', message });
  });

// -----------------------------------------------------
// Media
// -----------------------------------------------------

const mediaRouter = express.Router();
mediaRouter.get('/reels/:id/:kind', serveMedia);

// -----------------------------------------------------
// Customer
// -----------------------------------------------------

const customerRouter = express.Router();
customerRouter.get('/reels/feed', authMiddleware, customer.getFeed);
customerRouter.get('/reels/following-shops', authMiddleware, customer.listFollowing);
customerRouter.get('/reels/:id', authMiddleware, customer.getReel);
customerRouter.post('/reels/:id/view', authMiddleware, customer.recordView);
customerRouter.post('/reels/:id/like', authMiddleware, customer.setLike(true));
customerRouter.delete('/reels/:id/like', authMiddleware, customer.setLike(false));
customerRouter.post('/reels/:id/share', authMiddleware, customer.recordEvent('share'));
customerRouter.post('/reels/:id/product-click', authMiddleware, customer.recordEvent('product_click'));
customerRouter.post('/reels/:id/add-to-cart', authMiddleware, customer.recordEvent('add_to_cart'));
// Phase 63: the customer opened the shop / restaurant from the video
customerRouter.post('/reels/:id/profile-visit', authMiddleware, customer.recordEvent('profile_visit'));
customerRouter.post('/reels/:id/report', authMiddleware, customer.reportReel);
customerRouter.get('/shops/:shopId/follow', authMiddleware, customer.followState);
customerRouter.post('/shops/:shopId/follow', authMiddleware, customer.setFollow(true));
customerRouter.delete('/shops/:shopId/follow', authMiddleware, customer.setFollow(false));

// -----------------------------------------------------
// Shop portal (clothing shops; manager or owner)
// -----------------------------------------------------

const shopRouter = express.Router();
const skipGenericAudit = (req, res, next) => {
  res.locals.skipShopAudit = true;
  next();
};
const MANAGER = allowShopRoles('manager');
// upload runs after auth so strangers can't fill the disk
const reelShop = [shopAuthMiddleware, skipGenericAudit, MANAGER];

shopRouter.get('/reels', reelShop, shop.requireClothingShop, shop.listReels);
shopRouter.get('/reels/analytics', reelShop, shop.requireClothingShop, shop.analytics);
shopRouter.post('/reels', reelShop, upload, shop.requireClothingShop, shop.createReel);
shopRouter.get('/reels/:id', reelShop, shop.requireClothingShop, shop.getReel);
shopRouter.put('/reels/:id', reelShop, shop.requireClothingShop, shop.updateReel);
shopRouter.put('/reels/:id/video', reelShop, upload, shop.requireClothingShop, shop.replaceMedia('video'));
shopRouter.put('/reels/:id/cover', reelShop, upload, shop.requireClothingShop, shop.replaceMedia('cover'));
shopRouter.post('/reels/:id/submit', reelShop, shop.requireClothingShop, shop.submitReel);
shopRouter.post('/reels/:id/unpublish', reelShop, shop.requireClothingShop, shop.unpublishReel);
shopRouter.delete('/reels/:id', reelShop, shop.requireClothingShop, shop.deleteReel);

// -----------------------------------------------------
// Admin
// -----------------------------------------------------

const adminRouter = express.Router();
const adminAuth = [requireAdmin];
adminRouter.get('/reels', adminAuth, can('shops.view'), admin.listReels);
adminRouter.get('/reels/reports', adminAuth, can('shops.view'), admin.listReports);
adminRouter.get('/shops/:id/reels', adminAuth, can('shops.view'), admin.listShopReels);
adminRouter.post('/reels/reports/:reportId/resolve', adminAuth, can('shops.manage'), admin.resolveReport);
adminRouter.get('/reels/:id', adminAuth, can('shops.view'), admin.getReel);
adminRouter.post('/reels/:id/approve', adminAuth, can('shops.manage'), admin.approve);
adminRouter.post('/reels/:id/reject', adminAuth, can('shops.manage'), admin.reject);
adminRouter.post('/reels/:id/remove', adminAuth, can('shops.manage'), admin.remove);
adminRouter.post('/reels/:id/restore', adminAuth, can('shops.manage'), admin.restore);
adminRouter.delete('/reels/:id', adminAuth, can('shops.manage'), admin.deleteReel);
adminRouter.post('/shops/:id/reels-suspend', adminAuth, can('shops.manage'), admin.suspendShop);
adminRouter.post('/shops/:id/reels-unsuspend', adminAuth, can('shops.manage'), admin.unsuspendShop);

module.exports = { mediaRouter, customerRouter, shopRouter, adminRouter };
