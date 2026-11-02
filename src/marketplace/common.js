// =====================================================
// PHASE 59: MARKETPLACE - shared helpers
// Business types, product serialisation (variants / images / menu
// options), store availability (open, paused, capacity, special
// hours) used by the customer, shop-portal, shopper and admin APIs.
// =====================================================

const pool = require('../config/db');
const { DAYS, isOpenAt, nextChange, normalizeHours } = require('../utils/shopHours');

const BUSINESS_TYPES = ['grocery', 'clothing', 'restaurant', 'liquor'];
const MERCHANT_TYPES = ['clothing', 'restaurant', 'liquor'];
// Phase 61: stock-counted stores (variants, stock taken at checkout)
const RETAIL_TYPES = ['clothing', 'liquor'];
const isRetail = (type) => RETAIL_TYPES.includes(type);

// Phase 61: vehicles allowed to deliver a business type's orders.
// Restaurants: Bike only (user requirement, do not change without an
// explicit new requirement). Types not listed: any vehicle.
const VEHICLE_RULES = { restaurant: ['motorbike'] };
const allowedVehiclesFor = (type) => VEHICLE_RULES[type] || null;

const MERCHANT_STATUSES = ['new', 'accepted', 'preparing', 'ready', 'picked_up', 'completed', 'rejected', 'cancelled'];
// Merchant orders the store is still working on (capacity, tabs)
const MERCHANT_ACTIVE = ['new', 'accepted', 'preparing', 'ready'];

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

const toId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const fail = (res, status, message, code, extra = {}) =>
  res.status(status).json({ success: false, ...(code ? { code } : {}), message, ...extra });

const text = (value, max) => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

const bool = (value, fallback = false) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

const money = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 10000000 ? round2(n) : undefined;
};

const num = (value) => (value === null || value === undefined ? null : Number(value));

const typeLabel = (type) =>
  ({ grocery: 'Grocery shop', clothing: 'Clothing shop', restaurant: 'Restaurant', liquor: 'Liquor store' })[type] || type;

// -----------------------------------------------------
// Phase 61: which categories customers may browse / order
// (business_types.customer_ordering_enabled; liquor is off until an
// admin records legal approval). Cached briefly.
// -----------------------------------------------------

let typeCache = { at: 0, rows: null };
const TYPE_CACHE_MS = 15000;

const customerTypeRules = async ({ fresh = false } = {}) => {
  if (!fresh && typeCache.rows && Date.now() - typeCache.at < TYPE_CACHE_MS) return typeCache.rows;
  const rows = (
    await pool.query(
      'SELECT key, label, is_active, customer_ordering_enabled, min_customer_age, compliance_note FROM business_types ORDER BY sort'
    )
  ).rows;
  const map = new Map(
    rows.map((r) => [
      r.key,
      {
        key: r.key,
        label: r.label,
        open: !!r.is_active && !!r.customer_ordering_enabled,
        minAge: r.min_customer_age != null ? Number(r.min_customer_age) : null,
        note: r.compliance_note || null,
      },
    ])
  );
  typeCache = { at: Date.now(), rows: map };
  return map;
};

const clearTypeCache = () => {
  typeCache = { at: 0, rows: null };
};

const CATEGORY_CLOSED_MESSAGE = {
  liquor: 'Liquor ordering is not available on GetMe yet. It will open only after legal approval.',
};

// null when customers may use this type, else { status, code, message }
const customerTypeBlock = async (type) => {
  const rule = (await customerTypeRules()).get(type);
  if (rule && rule.open) return null;
  return {
    status: 403,
    code: 'CATEGORY_NOT_AVAILABLE',
    message: CATEGORY_CLOSED_MESSAGE[type] || 'This category is not available on GetMe right now.',
  };
};

// Merchant types customers can use now
const openMerchantTypes = async () => {
  const rules = await customerTypeRules();
  return MERCHANT_TYPES.filter((type) => rules.get(type)?.open);
};

// Sri Lanka provinces -> districts (registration dropdowns)
const PROVINCES = [
  { name: 'Western', districts: ['Colombo', 'Gampaha', 'Kalutara'] },
  { name: 'Central', districts: ['Kandy', 'Matale', 'Nuwara Eliya'] },
  { name: 'Southern', districts: ['Galle', 'Matara', 'Hambantota'] },
  { name: 'Northern', districts: ['Jaffna', 'Kilinochchi', 'Mannar', 'Vavuniya', 'Mullaitivu'] },
  { name: 'Eastern', districts: ['Batticaloa', 'Ampara', 'Trincomalee'] },
  { name: 'North Western', districts: ['Kurunegala', 'Puttalam'] },
  { name: 'North Central', districts: ['Anuradhapura', 'Polonnaruwa'] },
  { name: 'Uva', districts: ['Badulla', 'Monaragala'] },
  { name: 'Sabaragamuwa', districts: ['Ratnapura', 'Kegalle'] },
];

const validProvince = (province, district) => {
  if (!province && !district) return { province: null, district: null };
  const p = PROVINCES.find((row) => row.name.toLowerCase() === String(province || '').trim().toLowerCase());
  if (!p) return { error: 'Choose a province from the list' };
  if (!district) return { province: p.name, district: null };
  const d = p.districts.find((name) => name.toLowerCase() === String(district).trim().toLowerCase());
  if (!d) return { error: `Choose a district in the ${p.name} Province` };
  return { province: p.name, district: d };
};

// -----------------------------------------------------
// Opening hours with special (holiday) dates
// -----------------------------------------------------

const colomboDate = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

const colomboWeekday = (date = new Date()) =>
  DAYS.indexOf(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', weekday: 'short' }).format(date).toLowerCase().slice(0, 3)
  );

const specialFor = (specialHours, date = new Date()) => {
  const list = Array.isArray(specialHours) ? specialHours : [];
  const today = colomboDate(date);
  return list.find((row) => row && row.date === today) || null;
};

// Regular hours with today's entry replaced by a special date
const effectiveHours = (openingHours, specialHours, date = new Date()) => {
  const special = specialFor(specialHours, date);
  if (!special) return openingHours || null;
  const base = openingHours && typeof openingHours === 'object' ? { ...openingHours } : {};
  for (const day of DAYS) if (!base[day]) base[day] = { closed: true, open: null, close: null };
  base[DAYS[colomboWeekday(date)]] = special.closed
    ? { closed: true, open: null, close: null }
    : { closed: false, open: special.open, close: special.close };
  return base;
};

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Validates and cleans a special-hours list (future dates, max 60)
const normalizeSpecialHours = (input) => {
  if (input == null) return { value: [] };
  if (!Array.isArray(input)) return { error: 'Special hours must be a list' };
  const today = colomboDate();
  const seen = new Set();
  const value = [];

  for (const raw of input) {
    const date = String(raw?.date || '').trim();
    if (!DATE.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
      return { error: `"${date || 'a date'}" is not a valid date (YYYY-MM-DD)` };
    }
    if (date < today) continue;
    if (seen.has(date)) return { error: `${date} is listed twice` };
    seen.add(date);
    const closed = raw?.closed === true || raw?.closed === 'true';
    const open = String(raw?.open || '').trim();
    const close = String(raw?.close || '').trim();
    if (!closed && (!TIME.test(open) || !TIME.test(close))) {
      return { error: `Enter opening and closing times (HH:MM) for ${date}, or mark it closed` };
    }
    value.push({ date, closed, open: closed ? null : open, close: closed ? null : close, note: text(raw?.note, 80) });
  }

  if (value.length > 60) return { error: 'Add at most 60 special dates' };
  value.sort((a, b) => a.date.localeCompare(b.date));
  return { value };
};

const todayHours = (shop, date = new Date()) => {
  const special = specialFor(shop.special_hours, date);
  if (special) return { closed: special.closed, open: special.open, close: special.close, special: true, note: special.note || null };
  const day = shop.opening_hours?.[DAYS[colomboWeekday(date)]];
  if (!day) return null;
  return { closed: !!day.closed, open: day.open || null, close: day.close || null, special: false, note: null };
};

// -----------------------------------------------------
// Store availability for ordering
// -----------------------------------------------------

const activeMerchantOrders = async (shopId, client = pool) =>
  Number(
    (
      await client.query(
        `SELECT COUNT(*)::int AS n FROM orders
         WHERE shop_id = $1 AND business_type <> 'grocery'
           AND merchant_status = ANY($2) AND status NOT IN ('pending_shopper_search', 'cancelled', 'delivered')`,
        [shopId, MERCHANT_ACTIVE]
      )
    ).rows[0].n
  );

// -> { acceptingOrders, reason: null|'closed'|'paused'|'busy'|'not_approved', message, opensAt, pausedUntil }
const availabilityOf = (shop, activeCount = 0, now = new Date()) => {
  const paused = shop.orders_paused_until && new Date(shop.orders_paused_until) > now;
  let opensAt = null;

  if (!shop.is_open && shop.auto_open && shop.opening_hours) {
    const at = nextChange(effectiveHours(shop.opening_hours, shop.special_hours, now), now);
    opensAt = at ? at.toISOString() : null;
  }

  let reason = null;
  let message = null;

  if (shop.status !== 'approved') {
    reason = 'not_approved';
    message = 'This store is not taking orders on GetMe right now.';
  } else if (!shop.is_open) {
    reason = 'closed';
    message = opensAt ? 'This store is closed now. Order when it opens.' : 'This store is closed right now.';
  } else if (paused) {
    reason = 'paused';
    message = 'This store has paused new orders for a short while. Please try again soon.';
  } else if (shop.max_active_orders && activeCount >= Number(shop.max_active_orders)) {
    reason = 'busy';
    message = 'This store is very busy right now and can\'t take more orders. Please try again in a few minutes.';
  }

  return {
    acceptingOrders: reason === null,
    reason,
    message,
    opensAt,
    pausedUntil: paused ? new Date(shop.orders_paused_until).toISOString() : null,
  };
};

// Public store fields (customer discovery / storefront)
const publicShop = (shop, extra = {}) => {
  const availability = extra.availability || availabilityOf(shop, extra.activeCount || 0);
  return {
    id: Number(shop.id),
    name: shop.shop_name,
    shop_name: shop.shop_name,
    businessType: shop.business_type || 'grocery',
    logoUrl: shop.image_url || null,
    image_url: shop.image_url || null,
    coverUrl: shop.cover_url || null,
    brandColor: shop.brand_color || null,
    description: shop.description || null,
    address: shop.address || null,
    city: shop.city || shop.area || null,
    district: shop.district || null,
    latitude: num(shop.latitude),
    longitude: num(shop.longitude),
    isOpen: !!shop.is_open,
    opensAt: availability.opensAt,
    ordersPaused: availability.reason === 'paused',
    pausedUntil: availability.pausedUntil,
    offersDelivery: shop.offers_delivery !== false,
    offersPickup: !!shop.offers_pickup,
    prepMinutes: Number(shop.default_prep_minutes) || 20,
    acceptingOrders: availability.acceptingOrders,
    notAcceptingReason: availability.reason,
    notAcceptingMessage: availability.message,
  };
};

// -----------------------------------------------------
// Products (clothing / restaurant)
// -----------------------------------------------------

const effectivePrice = (price, discount) => {
  const p = Number(price);
  const d = discount == null ? null : Number(discount);
  return round2(d != null && Number.isFinite(d) && d < p ? d : p);
};

const uniqueInOrder = (values) => {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value) continue;
    const key = String(value).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
};

const variantLabelOf = (variant) =>
  [variant?.size, variant?.colour, variant?.material].filter(Boolean).join(' / ') || null;

// Loads images / variants / option groups for a set of product ids
const loadProductExtras = async (productIds, client = pool) => {
  const ids = [...new Set(productIds.map(Number).filter(Boolean))];
  const empty = { images: new Map(), variants: new Map(), groups: new Map() };
  if (!ids.length) return empty;

  const [images, variants, groups, options] = await Promise.all([
    client.query('SELECT * FROM product_images WHERE product_id = ANY($1) ORDER BY product_id, sort, id', [ids]),
    client.query('SELECT * FROM product_variants WHERE product_id = ANY($1) ORDER BY product_id, sort, id', [ids]),
    client.query('SELECT * FROM product_option_groups WHERE product_id = ANY($1) ORDER BY product_id, sort, id', [ids]),
    client.query('SELECT * FROM product_options WHERE product_id = ANY($1) ORDER BY group_id, sort, id', [ids]),
  ]);

  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };

  for (const row of images.rows) push(empty.images, Number(row.product_id), row);
  for (const row of variants.rows) push(empty.variants, Number(row.product_id), row);
  const optionsByGroup = new Map();
  for (const row of options.rows) push(optionsByGroup, Number(row.group_id), row);
  for (const row of groups.rows) push(empty.groups, Number(row.product_id), { ...row, options: optionsByGroup.get(Number(row.id)) || [] });
  return empty;
};

const toVariant = (variant, product, { forMerchant = false } = {}) => {
  const price = variant.price != null ? Number(variant.price) : Number(product.price);
  const discount = variant.price != null ? variant.discount_price : variant.discount_price ?? product.discount_price;
  const stock = Number(variant.stock_quantity) || 0;
  return {
    id: Number(variant.id),
    size: variant.size || null,
    colour: variant.colour || null,
    material: variant.material || null,
    label: variantLabelOf(variant),
    sku: variant.sku || null,
    ...(forMerchant ? { barcode: variant.barcode || null, priceOverride: num(variant.price), discountOverride: num(variant.discount_price) } : {}),
    price: round2(price),
    discountPrice: discount != null ? round2(discount) : null,
    effectivePrice: effectivePrice(price, discount),
    stock,
    isAvailable: !!variant.is_available,
    inStock: !!variant.is_available && stock > 0,
  };
};

const toOptionGroup = (group, { forMerchant = false } = {}) => ({
  id: Number(group.id),
  name: group.name,
  minSelect: Number(group.min_select),
  maxSelect: Number(group.max_select),
  required: Number(group.min_select) > 0,
  options: (group.options || [])
    .filter((option) => forMerchant || option.is_available)
    .map((option) => ({
      id: Number(option.id),
      name: option.name,
      priceDelta: round2(option.price_delta),
      isAvailable: !!option.is_available,
      isDefault: !!option.is_default,
    })),
});

// Product as customers (and, with forMerchant, the portal) see it
const toProduct = (product, extras, shop = null, { forMerchant = false } = {}) => {
  const id = Number(product.id);
  const images = (extras?.images.get(id) || []).map((row) => row.url);
  const allVariants = (extras?.variants.get(id) || []).map((row) => toVariant(row, product, { forMerchant }));
  const variants = forMerchant ? allVariants : allVariants.filter((v) => v.isAvailable);
  const groups = (extras?.groups.get(id) || []).map((group) => toOptionGroup(group, { forMerchant }));
  const type = shop?.business_type || product.business_type || null;
  const hasVariants = allVariants.length > 0;
  const inStock = type === 'restaurant'
    ? !!product.is_available
    : hasVariants
      ? variants.some((v) => v.inStock)
      : !!product.is_available && Number(product.stock_quantity) > 0;

  return {
    id,
    shopId: Number(product.shop_id),
    businessType: type,
    name: product.product_name,
    description: product.description || null,
    category: product.category || null,
    subcategory: product.subcategory || null,
    brand: product.brand || null,
    price: round2(product.price),
    discountPrice: product.discount_price != null ? round2(product.discount_price) : null,
    effectivePrice: effectivePrice(product.price, product.discount_price),
    images: images.length ? images : product.image_url ? [product.image_url] : [],
    imageUrl: images[0] || product.image_url || null,
    isFeatured: !!product.is_featured,
    isAvailable: !!product.is_available,
    sku: product.sku || null,
    barcode: forMerchant ? product.barcode || null : undefined,
    material: product.material || null,
    gender: product.gender || null,
    hasVariants,
    sizes: uniqueInOrder(variants.map((v) => v.size)),
    colours: uniqueInOrder(variants.map((v) => v.colour)),
    materials: uniqueInOrder(variants.map((v) => v.material)),
    variants,
    stock: hasVariants ? variants.reduce((sum, v) => sum + (v.isAvailable ? v.stock : 0), 0) : Number(product.stock_quantity) || 0,
    inStock,
    prepMinutes: product.prep_minutes != null ? Number(product.prep_minutes) : null,
    foodType: product.food_type || null,
    spiceLevel: product.spice_level != null ? Number(product.spice_level) : null,
    optionGroups: groups,
    sortOrder: Number(product.sort_order) || 0,
    updatedAt: product.updated_at,
  };
};

// Should a customer see this product in a merchant storefront?
const customerVisible = (productView) => {
  if (!productView.isAvailable) return false;
  if (productView.businessType === 'restaurant') return true;
  return productView.inStock;
};

module.exports = {
  pool,
  BUSINESS_TYPES,
  MERCHANT_TYPES,
  RETAIL_TYPES,
  isRetail,
  VEHICLE_RULES,
  allowedVehiclesFor,
  customerTypeRules,
  clearTypeCache,
  customerTypeBlock,
  openMerchantTypes,
  MERCHANT_STATUSES,
  MERCHANT_ACTIVE,
  PROVINCES,
  round2,
  toId,
  fail,
  text,
  bool,
  money,
  num,
  typeLabel,
  validProvince,
  colomboDate,
  effectiveHours,
  normalizeSpecialHours,
  normalizeHours,
  isOpenAt,
  todayHours,
  activeMerchantOrders,
  availabilityOf,
  publicShop,
  effectivePrice,
  variantLabelOf,
  loadProductExtras,
  toVariant,
  toOptionGroup,
  toProduct,
  customerVisible,
};
