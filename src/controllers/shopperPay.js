const { deliveryFeeForShopper } = require('../pricing/vehicles');

// ==================================================
// SHOPPER PAY + BATCH OFFER SETTINGS
// Shopper earns the order's delivery fee + fast delivery fee
// + 100% of the customer's tip.
// ==================================================

const SHOPPER_PAY_SQL =
  '(COALESCE(o.delivery_fee, 0) + COALESCE(o.fast_delivery_fee, 0) + COALESCE(o.tip_amount, 0))';

// Shops must be within this distance of the shopper. Also the radius
// for the nearby shoppers a customer sees while finding a shopper.
const OFFER_RADIUS_KM = 5;

// shopperVehicleType: pay for an OFFER to that shopper - their
// vehicle's fee from orders.vehicle_fees (a cheaper vehicle after
// the vehicle fallback earns its own fee; accepting re-prices the
// order to it). Omit it for orders already taken.
const shopperPayForOrder = (order, shopperVehicleType) => {
  const deliveryFee =
    shopperVehicleType === undefined
      ? Number(order?.delivery_fee || 0)
      : deliveryFeeForShopper(order, shopperVehicleType);
  const fastFee = Number(order?.fast_delivery_fee || 0);
  const tip = Number(order?.tip_amount || 0);

  return (
    (Number.isFinite(deliveryFee) ? deliveryFee : 0) +
    (Number.isFinite(fastFee) ? fastFee : 0) +
    (Number.isFinite(tip) ? tip : 0)
  );
};

const distanceKm = (fromLat, fromLng, toLat, toLng) => {
  const toRad = (value) => (Number(value) * Math.PI) / 180;

  const dLat = toRad(toLat - fromLat);
  const dLng = toRad(toLng - fromLng);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(fromLat)) *
      Math.cos(toRad(toLat)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

module.exports = {
  SHOPPER_PAY_SQL,
  OFFER_RADIUS_KM,
  shopperPayForOrder,
  distanceKm,
};
