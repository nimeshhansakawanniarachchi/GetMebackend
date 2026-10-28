const pool = require('../../config/db');

const { buildOperationsReport } = require('../../reports/operationsReport');
const promotion = require('../../reports/promotionResults');
const onboarding = require('../../shops/onboarding');

// =====================================================
// PHASE 47 (2026-10-29): operations report, shop onboarding,
// promotion results
//   GET   /api/admin/reports/operations?from=&to=   reports.view
//   GET   /api/admin/shops/:id/onboarding             shops.view
//   PATCH /api/admin/shops/:id/onboarding             shops.manage (audited)
//   GET   /api/admin/staff-directory                  shops.manage
//   GET   /api/admin/promos/:id/results?from=&to=     reports.view or promos.manage
//   GET   /api/admin/offers/:id/results?from=&to=     reports.view or shops.manage
// =====================================================

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isoDay = (date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

// from / to (inclusive Colombo days); last 30 days by default, max 366
const readRange = (query = {}) => {
  const today = new Date();
  let to = DATE.test(query.to || '') ? query.to : isoDay(today);
  let from = DATE.test(query.from || '') ? query.from : isoDay(new Date(today.getTime() - 29 * 86400000));
  if (from > to) [from, to] = [to, from];
  const spanDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  if (spanDays > 366) from = isoDay(new Date(new Date(to).getTime() - 365 * 86400000));
  return { from, to };
};

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id < 2147483647 ? id : null;
};

const fail = (res, label, error, message) => {
  console.error(`❌ ${label} error:`, error.message);
  return res.status(500).json({ success: false, message });
};

// -----------------------------------------------------
// Operations report
// -----------------------------------------------------

const getOperationsReport = async (req, res) => {
  try {
    const report = await buildOperationsReport(pool, readRange(req.query));
    return res.json({ success: true, ...report });
  } catch (error) {
    return fail(res, 'operations report', error, 'Unable to load the operations report');
  }
};

// -----------------------------------------------------
// Shop onboarding
// -----------------------------------------------------

const getShopOnboarding = async (req, res) => {
  const shopId = toId(req.params.id);
  if (!shopId) return res.status(400).json({ success: false, message: 'Invalid shop ID' });
  try {
    const result = await onboarding.getOnboarding(pool, shopId);
    if (!result) return res.status(404).json({ success: false, message: 'Shop not found' });
    return res.json({ success: true, onboarding: result, notesMax: onboarding.NOTES_MAX });
  } catch (error) {
    return fail(res, 'shop onboarding', error, 'Unable to load the onboarding checklist');
  }
};

const updateShopOnboarding = async (req, res) => {
  const shopId = toId(req.params.id);
  if (!shopId) return res.status(400).json({ success: false, message: 'Invalid shop ID' });
  try {
    const result = await onboarding.saveOnboarding({ shopId, body: req.body, admin: req.admin });
    if (result.audit) res.locals.audit = result.audit;
    return res.status(result.status).json(result.body);
  } catch (error) {
    return fail(res, 'save shop onboarding', error, 'Unable to save the onboarding checklist');
  }
};

const getStaffDirectory = async (req, res) => {
  try {
    return res.json({ success: true, staff: await onboarding.staffDirectory(pool) });
  } catch (error) {
    return fail(res, 'staff directory', error, 'Unable to load staff');
  }
};

// -----------------------------------------------------
// Promotion results
// -----------------------------------------------------

const getPromoResults = async (req, res) => {
  const promoId = toId(req.params.id);
  if (!promoId) return res.status(400).json({ success: false, message: 'Invalid promo code' });
  try {
    const promo = (await pool.query('SELECT id, code, discount_type, is_active FROM promo_codes WHERE id = $1', [promoId])).rows[0];
    if (!promo) return res.status(404).json({ success: false, message: 'Promo code not found' });
    const range = promotion.readOptionalRange(req.query);
    const results = await promotion.promoResults(pool, { promoId, ...range });
    return res.json({
      success: true,
      promo: { id: promo.id, code: promo.code, discountType: promo.discount_type, isActive: promo.is_active },
      range,
      results: results.get(promoId) || promotion.emptyResult(),
      definitions: promotion.DEFINITIONS,
    });
  } catch (error) {
    return fail(res, 'promo results', error, 'Unable to load promo results');
  }
};

const getOfferResults = async (req, res) => {
  const offerId = toId(req.params.id);
  if (!offerId) return res.status(400).json({ success: false, message: 'Invalid offer ID' });
  try {
    const offer = (
      await pool.query('SELECT o.id, o.title, o.shop_id, s.shop_name FROM product_offers o JOIN shops s ON s.id = o.shop_id WHERE o.id = $1', [offerId])
    ).rows[0];
    if (!offer) return res.status(404).json({ success: false, message: 'Offer not found' });
    const range = promotion.readOptionalRange(req.query);
    const results = await promotion.offerResults(pool, { offerId, ...range });
    return res.json({
      success: true,
      offer: { id: offer.id, title: offer.title, shopId: offer.shop_id, shopName: offer.shop_name },
      range,
      results: results.get(offerId) || promotion.emptyResult({ withLines: true }),
      definitions: {
        ...promotion.DEFINITIONS,
        redemptions: 'Order lines priced with this offer.',
        discountCost: 'What the offer saved customers on orders that were not cancelled (the shop funds its own offers).',
        offerLineSales: 'Sales of the offer lines themselves in delivered orders (refunded lines left out).',
      },
    });
  } catch (error) {
    return fail(res, 'offer results', error, 'Unable to load offer results');
  }
};

module.exports = {
  readRange,
  getOperationsReport,
  getShopOnboarding,
  updateShopOnboarding,
  getStaffDirectory,
  getPromoResults,
  getOfferResults,
};
