// ==================================================
// SHOPPER PAY + BATCH OFFER SETTINGS
// Shopper earns the order's delivery fee + fast delivery fee
// + 100% of the customer's tip.
// ==================================================

const SHOPPER_PAY_SQL =
  '(COALESCE(o.delivery_fee, 0) + COALESCE(o.fast_delivery_fee, 0) + COALESCE(o.tip_amount, 0))';

// How long each shopper has to accept a batch before it is hidden
// for them (the next shopper is added after 5 s, see shopperDispatch)
const OFFER_SECONDS =
  Number(process.env.SHOPPER_OFFER_SECONDS) > 0
    ? Number(process.env.SHOPPER_OFFER_SECONDS)
    : 10;

// Shops must be within this distance of the shopper. Also the radius
// for the nearby shoppers a customer sees while finding a shopper.
const OFFER_RADIUS_KM = 5;

const shopperPayForOrder = (order) => {
  const deliveryFee = Number(order?.delivery_fee || 0);
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
  OFFER_SECONDS,
  OFFER_RADIUS_KM,
  shopperPayForOrder,
  distanceKm,
};
