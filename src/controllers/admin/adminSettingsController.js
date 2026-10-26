const pool = require('../../config/db');

const {
  getPricingSettings,
  updatePricingSettings,
} = require('../../pricing/settings');

const {
  deliveryFee,
  serviceFee,
  getmeFeePercentOf,
  customerTotals,
} = require('../../pricing/fees');
const { DEFAULT_VEHICLE, vehicleFeesFor } = require('../../pricing/vehicles');


// =====================================================
// PRICING SETTINGS
// GET /api/admin/settings/pricing
// =====================================================

const getPricing = async (req, res) => {
  try {
    const [pricing, meta] = await Promise.all([
      getPricingSettings(),
      pool.query(
        `
        SELECT ps.updated_at, a.full_name AS updated_by
        FROM platform_settings ps
        LEFT JOIN admins a ON a.id = ps.updated_by
        WHERE ps.key = 'pricing'
        `
      ),
    ]);

    return res.json({
      success: true,
      pricing,
      updatedAt: meta.rows[0]?.updated_at || null,
      updatedBy: meta.rows[0]?.updated_by || null,
    });
  } catch (error) {
    console.error('❌ admin getPricing error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to load pricing' });
  }
};


// =====================================================
// UPDATE PRICING
// PUT /api/admin/settings/pricing { pricing }
// =====================================================

const updatePricing = async (req, res) => {
  try {
    const { value, errors } = await updatePricingSettings(
      req.body?.pricing,
      req.admin.adminId
    );

    if (errors) {
      return res.status(400).json({ success: false, message: errors[0], errors });
    }

    return res.json({ success: true, message: 'Pricing saved', pricing: value });
  } catch (error) {
    console.error('❌ admin updatePricing error:', error.message);

    return res.status(500).json({ success: false, message: 'Unable to save pricing' });
  }
};


// =====================================================
// PREVIEW (no save)
// POST /api/admin/settings/pricing/preview
//   { pricing?, itemsTotal, itemUnits, distanceKm, shopCount, fast }
// =====================================================

const previewPricing = async (req, res) => {
  try {
    const pricing = req.body?.pricing || (await getPricingSettings());
    const itemsTotal = Math.max(0, Number(req.body?.itemsTotal) || 0);
    // Packs / pieces in the basket (service fee is per unit)
    const itemUnits = Math.max(0, Math.min(500, Number.parseInt(req.body?.itemUnits, 10) || 0));
    const distanceKm = Math.max(0, Number(req.body?.distanceKm) || 0);
    const shopCount = Math.max(1, Math.min(10, Number.parseInt(req.body?.shopCount, 10) || 1));
    const fast = req.body?.fast !== false;

    // Same as checkout: priced for Bike, with every vehicle's fee
    const vehicleFees = vehicleFeesFor(pricing, deliveryFee(pricing, distanceKm, shopCount) ?? 0);
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

module.exports = {
  getPricing,
  updatePricing,
  previewPricing,
};
