const { round2 } = require('./fees');

// =====================================================
// DELIVERY FEE PER VEHICLE
// Fee = the distance fee (fees.deliveryFee) x the vehicle's
// multiplier from the pricing settings. The fee of every bookable
// vehicle is saved on the order when it's placed
// (orders.vehicle_fees), so the Find a shopper screen, booking,
// the shopper's offer and the accept all use the same numbers.
// orders.delivery_fee = fee of the vehicle booked (Bike until then).
// =====================================================

const BOOKABLE_VEHICLES = ['motorbike', 'three-wheeler', 'car'];

const DEFAULT_VEHICLE = 'motorbike';

// Shopper vehicles the customer can't book (bicycle, scooter,
// none set) are priced like a Bike; same rule as the dispatch SQL
const priceClass = (vehicleType) => {
  const type = String(vehicleType || '').trim().toLowerCase();

  return BOOKABLE_VEHICLES.includes(type) ? type : DEFAULT_VEHICLE;
};

// { motorbike, 'three-wheeler', car } for a distance fee
const vehicleFeesFor = (settings, baseFee) => {
  const fees = {};

  for (const vehicle of BOOKABLE_VEHICLES) {
    const multiplier = Number(settings?.vehicleMultipliers?.[vehicle]);

    fees[vehicle] = Math.ceil(
      Number(baseFee) * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1)
    );
  }

  return fees;
};

// The order's fee for a vehicle; null when the order has no
// per-vehicle fees (placed before phase 13) or the type is unknown
const orderFeeFor = (order, vehicleType) => {
  const fees = order?.vehicle_fees;
  const vehicle = priceClass(vehicleType);

  if (!fees || !vehicle || fees[vehicle] == null) {
    return null;
  }

  const fee = Number(fees[vehicle]);

  return Number.isFinite(fee) ? fee : null;
};

// What a shopper with this vehicle earns as delivery fee: their
// vehicle's fee, never more than the fee the customer booked
const deliveryFeeForShopper = (order, shopperVehicleType) => {
  const booked = Number(order?.delivery_fee) || 0;
  const own = orderFeeFor(order, shopperVehicleType);

  return own === null ? booked : Math.min(booked, own);
};

// Order totals re-priced for a vehicle (pure). A free-delivery
// promo covers the delivery fee, so its discount moves with it.
const repriceOrder = (order, vehicleType, { freeDelivery = false } = {}) => {
  const oldFee = Number(order?.delivery_fee) || 0;
  const oldDiscount = Number(order?.discount_amount) || 0;
  const oldTotal = Number(order?.total_amount) || 0;
  const fee = orderFeeFor(order, vehicleType);

  if (fee === null) {
    return { deliveryFee: oldFee, discountAmount: oldDiscount, totalAmount: oldTotal };
  }

  const change = fee - oldFee;
  const discountChange = freeDelivery ? change : 0;

  return {
    deliveryFee: round2(fee),
    discountAmount: round2(oldDiscount + discountChange),
    totalAmount: round2(Math.max(0, oldTotal + change - discountChange)),
  };
};

const hasFreeDeliveryPromo = async (client, order) => {
  if (!order?.promo_code) {
    return false;
  }

  const result = await client.query(
    'SELECT discount_type FROM promo_codes WHERE code = $1 LIMIT 1',
    [String(order.promo_code).trim().toUpperCase()]
  );

  return result.rows[0]?.discount_type === 'free_delivery';
};

// Saves the order re-priced for a vehicle (inside the caller's
// transaction) and returns the updated row
const applyVehiclePrice = async (client, order, vehicleType) => {
  if (orderFeeFor(order, vehicleType) === null) {
    return order;
  }

  const freeDelivery = await hasFreeDeliveryPromo(client, order);
  const price = repriceOrder(order, vehicleType, { freeDelivery });

  const result = await client.query(
    `
    UPDATE orders
    SET
      delivery_fee = $2,
      discount_amount = $3,
      total_amount = $4,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [order.id, price.deliveryFee, price.discountAmount, price.totalAmount]
  );

  if (freeDelivery) {
    await client.query(
      'UPDATE promo_redemptions SET discount_amount = $2 WHERE order_id = $1',
      [order.id, price.discountAmount]
    );
  }

  return result.rows[0] || order;
};

module.exports = {
  BOOKABLE_VEHICLES,
  DEFAULT_VEHICLE,
  priceClass,
  vehicleFeesFor,
  orderFeeFor,
  deliveryFeeForShopper,
  repriceOrder,
  hasFreeDeliveryPromo,
  applyVehiclePrice,
};
