const pool = require('../../config/db');

const {
  getPricingSettings,
  updatePricingSettings,
  withDefaults,
  listPricingVersions,
  cancelPricingVersion,
} = require('../../pricing/settings');

const {
  serviceFee,
  getmeFeePercentOf,
  customerTotals,
} = require('../../pricing/fees');
const { DEFAULT_VEHICLE } = require('../../pricing/vehicles');
const { deliveryFares, TRAVEL_FACTOR } = require('../../pricing/deliveryFare');


// =====================================================
// PRICING SETTINGS
// GET /api/admin/settings/pricing
// =====================================================

const getPricing = async (req, res) => {
  try {
    const pricing = await getPricingSettings();
    const [meta, scheduled] = await Promise.all([
      pricing.versionId
        ? pool.query(
            `
            SELECT v.created_at AS updated_at, a.full_name AS updated_by
            FROM pricing_settings_versions v
            LEFT JOIN admins a ON a.id = v.created_by
            WHERE v.id = $1
            `,
            [pricing.versionId]
          )
        : pool.query(
            `
            SELECT ps.updated_at, a.full_name AS updated_by
            FROM platform_settings ps
            LEFT JOIN admins a ON a.id = ps.updated_by
            WHERE ps.key = 'pricing'
            `
          ),
      pool
        .query(
          `
          SELECT v.id, v.effective_from, v.note, v.created_at, a.full_name AS created_by
          FROM pricing_settings_versions v
          LEFT JOIN admins a ON a.id = v.created_by
          WHERE v.cancelled_at IS NULL AND v.effective_from > NOW()
          ORDER BY v.effective_from
          `
        )
        .catch(() => ({ rows: [] })),
    ]);

    return res.json({
      success: true,
      pricing,
      versionId: pricing.versionId ?? null,
      effectiveFrom: pricing.effectiveFrom ?? null,
      updatedAt: meta.rows[0]?.updated_at || null,
      updatedBy: meta.rows[0]?.updated_by || null,
      // Saved for later (pricing_settings_versions)
      scheduled: scheduled.rows.map((row) => ({
        id: row.id,
        effectiveFrom: row.effective_from,
        note: row.note,
        createdAt: row.created_at,
        createdBy: row.created_by,
      })),
    });
  } catch (error) {
    console.error('❌ admin getPricing error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load pricing' });
  }
};


// =====================================================
// UPDATE PRICING
// PUT /api/admin/settings/pricing
//   { pricing, effectiveFrom? (ISO; empty = now), note? }
// Every save is a new version (history); a future effectiveFrom
// schedules it.
// =====================================================

const updatePricing = async (req, res) => {
  try {
    const { value, errors, version } = await updatePricingSettings(
      req.body?.pricing,
      req.admin.adminId,
      { effectiveFrom: req.body?.effectiveFrom, note: req.body?.note }
    );

    if (errors) {
      return res.status(400).json({ success: false, message: errors[0], errors });
    }

    return res.json({
      success: true,
      message: version.scheduled
        ? `Pricing scheduled for ${new Date(version.effectiveFrom).toLocaleString('en-GB', { timeZone: 'Asia/Colombo' })}`
        : 'Pricing saved',
      pricing: value,
      version,
    });
  } catch (error) {
    console.error('❌ admin updatePricing error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to save pricing' });
  }
};


// =====================================================
// PREVIEW (no save)
// POST /api/admin/settings/pricing/preview
//   { pricing?, itemsTotal, itemUnits, distanceKm (road km),
//     carMinutes? (drive time; default ~2.4 min/km), shopCount,
//     fast, at? (ISO time, for time rules; default now) }
// =====================================================

const previewPricing = async (req, res) => {
  try {
    const pricing = req.body?.pricing || (await getPricingSettings());
    const itemsTotal = Math.max(0, Number(req.body?.itemsTotal) || 0);
    // Packs / pieces in the basket (service fee is per unit)
    const itemUnits = Math.max(0, Math.min(500, Number.parseInt(req.body?.itemUnits, 10) || 0));
    const distanceKm = Math.max(0, Math.min(500, Number(req.body?.distanceKm) || 0));
    const minutesInput = Number(req.body?.carMinutes);
    const carMinutes = Number.isFinite(minutesInput) && minutesInput > 0
      ? Math.min(1000, minutesInput)
      : Math.max(1, Math.ceil(distanceKm * 2.4));
    const shopCount = Math.max(1, Math.min(10, Number.parseInt(req.body?.shopCount, 10) || 1));
    const fast = req.body?.fast !== false;
    const atInput = req.body?.at ? new Date(req.body.at) : new Date();
    const at = Number.isNaN(atInput.getTime()) ? new Date() : atInput;

    // Same engine as checkout: priced for Bike, with every vehicle's fare
    const { vehicleFees, fares } = deliveryFares(withDefaults(pricing), {
      route: { distanceKm, carMinutes },
      shopCount,
      at,
    });
    const delivery = vehicleFees[DEFAULT_VEHICLE];
    const fastFee = fast ? Number(pricing.fastFee || 0) : 0;
    const service = serviceFee(pricing, itemUnits);
    const getmeFeePercent = getmeFeePercentOf(pricing);
    const totals = customerTotals({
      itemsTotal,
      deliveryFee: delivery,
      fastFee,
      serviceFee: service,
      percent: getmeFeePercent,
    });

    return res.json({
      success: true,
      preview: {
        itemsTotal,
        itemUnits,
        deliveryFee: delivery,
        vehicleFees,
        fares,
        carMinutes,
        travelFactors: TRAVEL_FACTOR,
        fastDeliveryFee: fastFee,
        serviceFee: service,
        getmeFee: totals.getmeFee,
        getmeFeePercent,
        customerTotal: totals.totalAmount,
        shopReceives: itemsTotal,
        // Shopper keeps every fee (+ 100% of any tip); GetMe keeps its fee
        shopperEarns: delivery + fastFee + service,
        getmeEarns: totals.getmeFee,
        tooFar: distanceKm > Number(pricing.delivery?.maxKm || 0),
      },
    });
  } catch (error) {
    console.error('❌ admin previewPricing error:', error.message);

    return res.status(400).json({ success: false, message: 'Check the pricing values' });
  }
};

// =====================================================
// HISTORY
// GET /api/admin/settings/pricing/history?limit=
// Every saved version: who, when, effective from, what changed
// =====================================================

// Paths whose value differs between two settings objects
const changedPaths = (before, after, prefix = '') => {
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return [];
  }

  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

  if (!isObject(before) || !isObject(after)) {
    return [prefix || '(all)'];
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];

  return keys.flatMap((key) => changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key));
};

const IGNORED_PATHS = ['versionId', 'effectiveFrom', 'vehicleMultipliers'];

const getPricingHistory = async (req, res) => {
  try {
    const [rows, current] = await Promise.all([
      listPricingVersions({ limit: req.query.limit }),
      getPricingSettings(),
    ]);
    const now = Date.now();

    // Oldest first: each version is compared with the one before it
    // that was not cancelled
    const changes = new Map();
    let previous = null;

    for (const row of rows.slice().reverse()) {
      const value = withDefaults(row.value);
      changes.set(row.id, previous ? changedPaths(previous, value) : []);

      if (!row.cancelled_at) {
        previous = value;
      }
    }

    return res.json({
      success: true,
      currentVersionId: current.versionId ?? null,
      versions: rows.map((row) => ({
        id: row.id,
        effectiveFrom: row.effective_from,
        note: row.note,
        createdAt: row.created_at,
        createdBy: row.created_by_name,
        cancelledAt: row.cancelled_at,
        cancelledBy: row.cancelled_by_name,
        status: row.cancelled_at
          ? 'cancelled'
          : row.id === current.versionId
            ? 'current'
            : new Date(row.effective_from).getTime() > now
              ? 'scheduled'
              : 'past',
        changed: (changes.get(row.id) || [])
          .filter((path) => !IGNORED_PATHS.includes(path.split('.')[0]))
          .slice(0, 40),
        pricing: withDefaults(row.value),
      })),
    });
  } catch (error) {
    console.error('❌ admin getPricingHistory error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load pricing history' });
  }
};

// =====================================================
// CANCEL A SCHEDULED VERSION
// DELETE /api/admin/settings/pricing/versions/:id
// =====================================================

const cancelScheduledPricing = async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid version' });
  }

  try {
    const ok = await cancelPricingVersion(id, req.admin.adminId);

    if (!ok) {
      return res.status(409).json({
        success: false,
        message: 'Only a scheduled version that has not started yet can be cancelled',
      });
    }

    return res.json({ success: true, message: 'Scheduled pricing cancelled' });
  } catch (error) {
    console.error('❌ admin cancelScheduledPricing error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to cancel the scheduled pricing' });
  }
};

module.exports = {
  getPricing,
  updatePricing,
  previewPricing,
  getPricingHistory,
  cancelScheduledPricing,
};
