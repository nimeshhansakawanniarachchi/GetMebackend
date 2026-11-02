// =====================================================
// PHASE 62: FASHION REELS - storage, signed media links, validation,
// shared serialisers. Clothing shops only.
//
// Files: private-uploads/reels/<random>.mp4|.mov|.jpg (never public).
// Media is served by GET /api/media/reels/:id/:kind?exp&sig, where the
// signature (HMAC of reel id, kind, CURRENT file name and expiry) is
// handed out only to callers allowed to see that reel: customers for
// published reels, the owning shop, and admins. Replacing a file
// invalidates old links. express sendFile answers Range requests, so
// players can seek / stream.
// =====================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../config/db');
const { readMp4Info } = require('./mp4Info');
const { round2, num, toId, fail, text, loadProductExtras, toProduct, customerVisible } = require('../marketplace/common');

const REELS_DIR = path.join(__dirname, '..', '..', 'private-uploads', 'reels');
fs.mkdirSync(REELS_DIR, { recursive: true });

// Limits (documented in the report / contract)
const LIMITS = {
  videoMaxBytes: 100 * 1024 * 1024,
  coverMaxBytes: 5 * 1024 * 1024,
  minSeconds: 3,
  maxSeconds: 90,
  // portrait only: width / height at most 0.8 (9:16 = 0.5625, 4:5 = 0.8)
  maxAspect: 0.8,
  minHeight: 480,
  codecs: ['avc1', 'avc3', 'hvc1', 'hev1'],
  maxProducts: 12,
  maxHashtags: 10,
  maxReelsPerShop: 300,
  maxUploadsPerDay: 30,
};

// Phase 63: reels serve clothing shops and restaurants (same system)
const REEL_TYPES = ['clothing', 'restaurant'];
const PROMO_TYPES_BY_TYPE = {
  clothing: ['new_arrival', 'collection', 'trending', 'seasonal', 'offer', 'demo', 'outfit', 'other'],
  restaurant: ['new_dish', 'popular_meal', 'fast_food', 'pizza', 'rice_curry', 'dessert', 'beverage',
    'special_menu', 'preparation', 'chef_special', 'offer', 'seasonal', 'other'],
};
const DEFAULT_PROMO = { clothing: 'new_arrival', restaurant: 'new_dish' };
// "New" feed tab per type
const NEW_PROMOS = { clothing: ['new_arrival', 'collection'], restaurant: ['new_dish', 'special_menu', 'chef_special'] };
const PROMO_TYPES = PROMO_TYPES_BY_TYPE.clothing;
const promoTypesFor = (type) => PROMO_TYPES_BY_TYPE[type] || PROMO_TYPES;
const AUDIENCES = ['men', 'women', 'kids', 'unisex'];
const REPORT_REASONS = ['inappropriate', 'misleading', 'counterfeit', 'offensive', 'spam', 'other'];
const REPORTS_TO_HIDE = 3;

const PROMO_LABELS = {
  new_arrival: 'New arrivals',
  collection: 'New collection',
  trending: 'Trending outfit',
  seasonal: 'Seasonal',
  offer: 'Special offer',
  demo: 'Product demo',
  outfit: 'Outfit idea',
  other: 'Fashion',
  // food (phase 63)
  new_dish: 'New dish',
  popular_meal: 'Popular meal',
  fast_food: 'Burgers & fast food',
  pizza: 'Pizza',
  rice_curry: 'Rice & curry',
  dessert: 'Desserts',
  beverage: 'Beverages',
  special_menu: 'Special menu',
  preparation: 'How it\'s made',
  chef_special: "Chef's special",
};
const promoLabelOf = (r) => (r.promo_type === 'other' && r.business_type === 'restaurant' ? 'Food' : PROMO_LABELS[r.promo_type] || null);

// -----------------------------------------------------
// Signed media links
// -----------------------------------------------------

const SIGN_SECRET = () => `${process.env.JWT_SECRET || 'getme'}:reels-media`;
const LINK_HOURS = 6;

const signature = (id, kind, file, exp) =>
  crypto.createHmac('sha256', SIGN_SECRET()).update(`${id}:${kind}:${file}:${exp}`).digest('base64url');

// Expiry rounded up to the hour so the same link is reused (cacheable)
const mediaUrl = (reel, kind) => {
  const file = kind === 'video' ? reel.video_file : reel.cover_file;
  if (!file) return null;
  const exp = Math.ceil((Date.now() / 1000 + LINK_HOURS * 3600) / 3600) * 3600;
  return `/api/media/reels/${Number(reel.id)}/${kind}?exp=${exp}&sig=${signature(reel.id, kind, file, exp)}`;
};

const serveMedia = async (req, res) => {
  try {
    const id = toId(req.params.id);
    const kind = req.params.kind;
    const exp = Number(req.query.exp);
    const sig = String(req.query.sig || '');
    if (!id || !['video', 'cover'].includes(kind) || !Number.isFinite(exp) || !sig) return res.status(404).end();
    if (exp < Date.now() / 1000) return res.status(410).json({ success: false, code: 'LINK_EXPIRED', message: 'This link has expired. Reload the page.' });
    const reel = (await pool.query('SELECT id, video_file, video_mime, cover_file, cover_mime, deleted_at FROM fashion_reels WHERE id = $1', [id])).rows[0];
    const file = reel && !reel.deleted_at ? (kind === 'video' ? reel.video_file : reel.cover_file) : null;
    if (!file) return res.status(404).end();
    const expected = signature(id, kind, file, exp);
    if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return res.status(403).end();
    const full = path.join(REELS_DIR, path.basename(file));
    if (!fs.existsSync(full)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3600');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('X-Content-Type-Options', 'nosniff');
    res.type(kind === 'video' ? reel.video_mime || 'video/mp4' : reel.cover_mime || 'image/jpeg');
    return res.sendFile(full, { acceptRanges: true, dotfiles: 'deny' });
  } catch (error) {
    console.error('❌ REEL MEDIA ERROR:', error.message);
    return res.status(500).end();
  }
};

// -----------------------------------------------------
// Upload validation (server side, by content)
// -----------------------------------------------------

const removeFile = (file) => {
  if (file?.path) fs.promises.unlink(file.path).catch(() => {});
};

const removeStored = (name) => {
  if (name) fs.promises.unlink(path.join(REELS_DIR, path.basename(name))).catch(() => {});
};

const sniffImage = async (filePath) => {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const b = Buffer.alloc(12);
    await handle.read(b, 0, 12, 0);
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
    if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
    return null;
  } finally {
    await handle.close();
  }
};

// Renames the stored file to a random name with the real extension
const finalName = async (file, ext) => {
  const name = `reel-${Date.now()}-${crypto.randomBytes(9).toString('hex')}${ext}`;
  await fs.promises.rename(file.path, path.join(REELS_DIR, name));
  return name;
};

// -> { value: { file, mime, bytes, codec, duration, width, height } } | { error, code }
const acceptVideo = async (file) => {
  if (!file) return { error: 'Choose a video to upload', code: 'VIDEO_REQUIRED' };
  let info;
  try {
    info = await readMp4Info(file.path);
  } catch (error) {
    removeFile(file);
    return { error: 'This file is not a video we can use. Upload an MP4 or MOV video.', code: 'BAD_VIDEO' };
  }
  const reject = (error, code) => {
    removeFile(file);
    return { error, code, info };
  };
  if (info.bytes > LIMITS.videoMaxBytes) return reject('The video is larger than 100 MB', 'VIDEO_TOO_LARGE');
  if (!info.durationSeconds || info.durationSeconds < LIMITS.minSeconds) return reject(`The video must be at least ${LIMITS.minSeconds} seconds long`, 'VIDEO_TOO_SHORT');
  if (info.durationSeconds > LIMITS.maxSeconds) return reject(`The video can be at most ${LIMITS.maxSeconds} seconds long`, 'VIDEO_TOO_LONG');
  if (!info.width || !info.height || info.width / info.height > LIMITS.maxAspect) {
    return reject('Upload a vertical (portrait) video, ideally 9:16 like TikTok or Reels', 'VIDEO_NOT_VERTICAL');
  }
  if (info.height < LIMITS.minHeight) return reject(`The video is too small (at least ${LIMITS.minHeight} px tall)`, 'VIDEO_TOO_SMALL');
  if (!LIMITS.codecs.includes(info.codec)) {
    return reject('This video format is not supported. Export it as an H.264 (or HEVC) MP4.', 'VIDEO_CODEC');
  }
  const name = await finalName(file, info.container === 'mov' ? '.mov' : '.mp4');
  return {
    value: {
      file: name,
      mime: info.container === 'mov' ? 'video/quicktime' : 'video/mp4',
      bytes: info.bytes,
      codec: info.codec,
      duration: info.durationSeconds,
      width: info.width,
      height: info.height,
    },
  };
};

const acceptCover = async (file) => {
  if (!file) return { value: null };
  if (file.size > LIMITS.coverMaxBytes) {
    removeFile(file);
    return { error: 'The cover image must be 5 MB or smaller', code: 'COVER_TOO_LARGE' };
  }
  const kind = await sniffImage(file.path).catch(() => null);
  if (!kind) {
    removeFile(file);
    return { error: 'The cover must be a JPG, PNG or WEBP image', code: 'BAD_COVER' };
  }
  return { value: { file: await finalName(file, kind.ext), mime: kind.mime } };
};

// -----------------------------------------------------
// Fields
// -----------------------------------------------------

const readHashtags = (value) => {
  const list = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const tags = [];
  for (const raw of list) {
    const tag = String(raw || '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 40);
    if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags.slice(0, LIMITS.maxHashtags);
};

const readProductIds = (value) => {
  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      list = value.split(',');
    }
  }
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(toId).filter(Boolean))];
};

// Products must belong to the shop (any availability: shops may link a
// product before it is back in stock; customers only ever see sellable ones)
const validateProducts = async (client, shopId, ids) => {
  if (ids.length > LIMITS.maxProducts) return { error: `Link at most ${LIMITS.maxProducts} products`, code: 'TOO_MANY_PRODUCTS' };
  if (!ids.length) return { value: [] };
  const own = (await client.query('SELECT id FROM products WHERE shop_id = $1 AND id = ANY($2)', [shopId, ids])).rows.map((r) => Number(r.id));
  if (own.length !== ids.length) return { error: 'Some products are not in your catalogue', code: 'PRODUCT_NOT_YOURS' };
  return { value: ids };
};

const saveProducts = async (client, reelId, ids) => {
  await client.query('DELETE FROM reel_products WHERE reel_id = $1', [reelId]);
  for (const [i, id] of ids.entries()) {
    await client.query('INSERT INTO reel_products (reel_id, product_id, sort) VALUES ($1, $2, $3)', [reelId, id, i]);
  }
};

// -----------------------------------------------------
// Products of reels (cards)
// -----------------------------------------------------

// Map reelId -> [product rows in order] (all, any availability)
const linkedProducts = async (reelIds, client = pool) => {
  const ids = [...new Set(reelIds.map(Number).filter(Boolean))];
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = (
    await client.query(
      `SELECT rp.reel_id, rp.sort, p.*, s.business_type, s.status AS shop_status
       FROM reel_products rp JOIN products p ON p.id = rp.product_id JOIN shops s ON s.id = p.shop_id
       WHERE rp.reel_id = ANY($1) ORDER BY rp.reel_id, rp.sort`,
      [ids]
    )
  ).rows;
  const extras = await loadProductExtras(rows.map((r) => r.id), client);
  for (const row of rows) {
    const view = toProduct(row, extras, { business_type: row.business_type });
    map.get(Number(row.reel_id))?.push({ view, row });
  }
  return map;
};

const productCard = (view) => {
  const inStockVariants = view.variants.filter((v) => v.inStock);
  return {
    productId: view.id,
    name: view.name,
    brand: view.brand,
    imageUrl: view.imageUrl,
    price: view.price,
    discountPrice: view.discountPrice,
    priceFrom: inStockVariants.length ? Math.min(...inStockVariants.map((v) => v.effectivePrice)) : view.effectivePrice,
    hasVariants: view.hasVariants,
    sizes: view.sizes,
    colours: view.colours,
    inStock: view.inStock,
    lowStock: view.businessType !== 'restaurant' && view.inStock && view.stock <= 5,
    // Phase 63: food items (add-ons open the item sheet)
    businessType: view.businessType,
    description: view.description ? String(view.description).slice(0, 160) : null,
    hasOptions: (view.optionGroups || []).length > 0,
    requiredOptions: (view.optionGroups || []).some((g) => g.required),
    foodType: view.foodType || null,
    prepMinutes: view.prepMinutes ?? null,
  };
};

// Shop-side / admin view of a linked product
const linkedCard = ({ view }) => ({
  ...productCard(view),
  isAvailable: view.isAvailable,
  sellable: customerVisible(view),
});

const reelBase = (r) => ({
  id: Number(r.id),
  shopId: Number(r.shop_id),
  businessType: r.business_type || 'clothing',
  title: r.title,
  caption: r.caption || null,
  hashtags: r.hashtags || [],
  promoType: r.promo_type,
  promoLabel: promoLabelOf(r),
  audience: r.audience || null,
  durationSeconds: r.duration_seconds != null ? Number(r.duration_seconds) : null,
  width: num(r.width),
  height: num(r.height),
  videoUrl: mediaUrl(r, 'video'),
  coverUrl: mediaUrl(r, 'cover'),
  publishedAt: r.published_at || null,
  counts: {
    views: Number(r.view_count) || 0,
    likes: Number(r.like_count) || 0,
    shares: Number(r.share_count) || 0,
    productClicks: Number(r.product_click_count) || 0,
    addToCart: Number(r.add_to_cart_count) || 0,
    profileVisits: Number(r.profile_visit_count) || 0,
  },
});

const colomboDay = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

module.exports = {
  pool,
  REELS_DIR,
  LIMITS,
  PROMO_TYPES,
  PROMO_LABELS,
  REEL_TYPES,
  PROMO_TYPES_BY_TYPE,
  DEFAULT_PROMO,
  NEW_PROMOS,
  promoTypesFor,
  AUDIENCES,
  REPORT_REASONS,
  REPORTS_TO_HIDE,
  mediaUrl,
  serveMedia,
  acceptVideo,
  acceptCover,
  removeFile,
  removeStored,
  readHashtags,
  readProductIds,
  validateProducts,
  saveProducts,
  linkedProducts,
  productCard,
  linkedCard,
  reelBase,
  colomboDay,
  round2,
  num,
  toId,
  fail,
  text,
  customerVisible,
};
