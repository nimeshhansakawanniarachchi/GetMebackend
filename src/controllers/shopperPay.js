const { deliveryFeeForShopper } = require('../pricing/vehicles');
const { serviceUnitsSql } = require('../pricing/fees');

// ==================================================
// SHOPPER PAY + BATCH OFFER SETTINGS
// The customer pays GetMe's fee as its own line (orders.getme_fee,
// getme_fee_percent of groceries + fees - discounts; tip excluded),
// so nothing is deducted from the shopper:
//   shopper earns = delivery fee + priority (fast) fee
//                   + service fee for the items bought
//                   + 100% of the tip (+ admin adjustments)
//   GetMe keeps   = the GetMe fee (orders.getme_fee_kept once settled)
// The shopper's grocery spend is reimbursed separately
// (store_payments) and never mixed into earnings.
// ==================================================

const round2 = (value) => Math.round(Number(value) * 100) / 100;

// Delivery + fast fee (the shopper's delivery pay)
const DELIVERY_PAY_SQL = '(COALESCE(o.delivery_fee, 0) + COALESCE(o.fast_delivery_fee, 0))';

// Service fee less the units refunded (unavailable items go back
// to the customer with their service fee)
const SERVICE_EARNED_SQL = `GREATEST(0,
  COALESCE(o.service_fee, 0) - COALESCE(o.service_fee_per_unit, 0) * (
    SELECT COALESCE(SUM(${serviceUnitsSql('ri')}), 0)
    FROM order_items ri
    WHERE ri.order_id = o.id AND ri.shopping_status = 'refunded'
  )
)`;

// GetMe's income from an order: the GetMe fee it keeps
const COMMISSION_SQL = 'COALESCE(o.getme_fee_kept, o.getme_fee, 0)';

// What the shopper earns: the settled amount once recorded
// (adjustments / failed delivery included), else from the order.
// A cancelled order with no settled record earned nothing (the
// customer cancelled before shopping) - not its planned pay.
const SHOPPER_PAY_SQL = `COALESCE(
  (SELECT se.net_amount FROM shopper_earnings se WHERE se.order_id = o.id AND se.status <> 'void'),
  CASE
    WHEN o.status IN ('cancelled', 'shopper_search_cancelled') THEN 0
    ELSE ${DELIVERY_PAY_SQL} + ${SERVICE_EARNED_SQL} + COALESCE(o.tip_amount, 0)
  END
)`;

// The shopper's pay by category for one order
// -> { deliveryFee, priorityFee, deliveryPay, serviceFee, tip,
//      adjustment, net }
const splitShopperPay = ({
  deliveryFee = 0,
  fastFee = 0,
  serviceFee = 0,
  tip = 0,
  adjustment = 0,
}) => {
  const delivery = round2(Number(deliveryFee) || 0);
  const priority = round2(Number(fastFee) || 0);
  const service = round2(Number(serviceFee) || 0);
  const safeTip = round2(Number(tip) || 0);
  const extra = round2(Number(adjustment) || 0);

  return {
    deliveryFee: delivery,
    priorityFee: priority,
    deliveryPay: round2(delivery + priority),
    serviceFee: service,
    tip: safeTip,
    adjustment: extra,
    net: round2(delivery + priority + service + safeTip + extra),
  };
};

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
  const serviceFee = Number(order?.service_fee || 0);
  const tip = Number(order?.tip_amount || 0);

  return splitShopperPay({
    deliveryFee: Number.isFinite(deliveryFee) ? deliveryFee : 0,
    fastFee: Number.isFinite(fastFee) ? fastFee : 0,
    serviceFee: Number.isFinite(serviceFee) ? serviceFee : 0,
    tip: Number.isFinite(tip) ? tip : 0,
  }).net;
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
  DELIVERY_PAY_SQL,
  SERVICE_EARNED_SQL,
  COMMISSION_SQL,
  SHOPPER_PAY_SQL,
  splitShopperPay,
  OFFER_RADIUS_KM,
  shopperPayForOrder,
  distanceKm,
};
