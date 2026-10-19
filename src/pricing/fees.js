// =====================================================
// FEE FORMULAS (pure functions, used by quote + admin preview)
// =====================================================

const round2 = (value) => Math.round(Number(value) * 100) / 100;

// Distance from the farthest shop -> base fee + per-km tiers,
// plus a fixed fee for every extra shop the shopper visits.
const deliveryFee = (settings, farthestKm, shopCount = 1) => {
  const d = settings.delivery;

  if (!Number.isFinite(farthestKm)) {
    return null;
  }

  let fee = d.baseFee;
  let coveredKm = d.baseKm;

  for (const tier of d.tiers) {
    if (farthestKm <= coveredKm) {
      break;
    }

    const tierEnd = tier.uptoKm == null ? farthestKm : Math.min(farthestKm, tier.uptoKm);

    fee += Math.max(0, tierEnd - coveredKm) * tier.perKm;
    coveredKm = tierEnd;
  }

  fee += Math.max(0, shopCount - 1) * d.extraShopFee;

  return Math.ceil(fee);
};

// Percentage of priced items, kept between min and max
const serviceFee = (settings, itemsTotal) => {
  const { percent, min, max } = settings.serviceFee;

  if (itemsTotal <= 0) {
    return min;
  }

  return Math.ceil(Math.min(max, Math.max(min, (itemsTotal * percent) / 100)));
};

// Rough door-to-door estimate in minutes
const estimateMinutes = (farthestKm, totalPacks, shopCount = 1) => {
  const km = Number.isFinite(farthestKm) ? farthestKm : 5;
  const shopping = Math.min(25, Math.ceil(totalPacks / 3) * 5) + (shopCount - 1) * 10;
  const min = 15 + shopping + Math.max(10, Math.ceil(km * 4)) + 10;

  return { min, max: min + 15 };
};

module.exports = {
  round2,
  deliveryFee,
  serviceFee,
  estimateMinutes,
};
