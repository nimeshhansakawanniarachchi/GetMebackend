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

// Service fee: a fixed amount per item unit (each pack / piece
// ordered; a loose weighed line counts once). Paid to the shopper.
const LOOSE_UNITS = ['kg', 'g', 'L', 'ml'];

const lineUnits = (line) => {
  const quantity = Number(line?.quantity);

  if (line?.custom && LOOSE_UNITS.includes(line?.unit)) {
    return 1;
  }

  return Number.isFinite(quantity) && quantity > 0 ? Math.ceil(quantity) : 1;
};

const serviceUnits = (lines = []) => lines.reduce((sum, line) => sum + lineUnits(line), 0);

// The same count for an order_items row in SQL (alias = table alias)
const serviceUnitsSql = (alias = 'oi') => `(
  CASE
    WHEN COALESCE(${alias}.custom, false) AND ${alias}.unit IN ('kg', 'g', 'L', 'ml') THEN 1
    WHEN COALESCE(${alias}.quantity, 0) > 0 THEN CEIL(${alias}.quantity)
    ELSE 1
  END
)`;

const servicePerUnit = (settings) => {
  const perUnit = Number(settings?.serviceFee?.perUnit);

  return Number.isFinite(perUnit) && perUnit >= 0 ? perUnit : 50;
};

const serviceFee = (settings, units) =>
  round2(servicePerUnit(settings) * Math.max(0, Number(units) || 0));

// GetMe fee: getmeFeePercent of what the customer pays before the
// tip (groceries + delivery + priority + service - discounts)
const getmeFeePercentOf = (settings) => {
  const percent = Number(settings?.getmeFeePercent);

  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : 15;
};

// The customer's total from its parts (the one formula everything uses)
// -> { feeBase, getmeFee, totalAmount }
const customerTotals = ({
  itemsTotal = 0,
  deliveryFee = 0,
  fastFee = 0,
  serviceFee: service = 0,
  discount = 0,
  windowDiscount = 0,
  tip = 0,
  percent = 15,
}) => {
  const feeBase = round2(
    Math.max(
      0,
      Number(itemsTotal) + Number(deliveryFee) + Number(fastFee) + Number(service) -
        Number(discount) - Number(windowDiscount)
    )
  );
  const getmeFee = round2((feeBase * Number(percent)) / 100);

  return { feeBase, getmeFee, totalAmount: round2(feeBase + getmeFee + (Number(tip) || 0)) };
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
  serviceUnits,
  serviceUnitsSql,
  servicePerUnit,
  serviceFee,
  getmeFeePercentOf,
  customerTotals,
  estimateMinutes,
};
