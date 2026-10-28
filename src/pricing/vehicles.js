const { round2, customerTotals } = require('./fees');

// =====================================================
// DELIVERY FEE PER VEHICLE
// Each vehicle's fee comes from pricing/deliveryFare.js (its own
// fare rules on the road route). The fee of every bookable
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
// The GetMe fee follows the new delivery fee (fees.customerTotals).
const repriceOrder = (order, vehicleType, { freeDelivery = false } = {}) => {
  const oldFee = Number(order?.delivery_fee) || 0;
  const oldDiscount = Number(order?.discount_amount) || 0;
  const oldTotal = Number(order?.total_amount) || 0;
  const fee = orderFeeFor(order, vehicleType);

  if (fee === null) {
    return {
      deliveryFee: oldFee,
      discountAmount: oldDiscount,
      getmeFee: Number(order?.getme_fee) || 0,
      totalAmount: oldTotal,
    };
  }

  const change = fee - oldFee;
  const discountAmount = round2(oldDiscount + (freeDelivery ? change : 0));

  const totals = customerTotals({
    itemsTotal: order?.items_total,
    deliveryFee: fee,
    fastFee: order?.fast_delivery_fee,
    serviceFee: order?.service_fee,
    discount: discountAmount,
    windowDiscount: order?.window_discount,
    tip: order?.tip_amount,
    percent: order?.getme_fee_percent ?? 15,
  });

  return {
    deliveryFee: round2(fee),
    discountAmount,
    getmeFee: totals.getmeFee,
    totalAmount: totals.totalAmount,
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
      getme_fee = $5,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [order.id, price.deliveryFee, price.discountAmount, price.totalAmount, price.getmeFee]
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
  orderFeeFor,
  deliveryFeeForShopper,
  repriceOrder,
  hasFreeDeliveryPromo,
  applyVehiclePrice,
};
