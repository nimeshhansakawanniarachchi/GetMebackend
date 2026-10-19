// ==================================================
// SHOPPER PAY + BATCH OFFER SETTINGS
// Shopper earns the order's delivery fee + fast delivery fee.
// ==================================================

const SHOPPER_PAY_SQL =
  '(COALESCE(o.delivery_fee, 0) + COALESCE(o.fast_delivery_fee, 0))';

// How long a new batch stays on a shopper's screen before it is hidden for them
const OFFER_SECONDS =
  Number(process.env.SHOPPER_OFFER_SECONDS) > 0
    ? Number(process.env.SHOPPER_OFFER_SECONDS)
    : 60;

// Shops must be within this distance of the shopper
const OFFER_RADIUS_KM = 10;

const shopperPayForOrder = (order) => {
  const deliveryFee = Number(order?.delivery_fee || 0);
  const fastFee = Number(order?.fast_delivery_fee || 0);

  return (
    (Number.isFinite(deliveryFee) ? deliveryFee : 0) +
    (Number.isFinite(fastFee) ? fastFee : 0)
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
  OFFER_SECONDS,
  OFFER_RADIUS_KM,
  shopperPayForOrder,
  distanceKm,
};
