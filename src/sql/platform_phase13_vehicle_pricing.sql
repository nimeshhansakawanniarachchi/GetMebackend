-- ==================================================
-- PLATFORM PHASE 13 — delivery fee per vehicle
-- Run once: node src/sql/runSql.js src/sql/platform_phase13_vehicle_pricing.sql
-- Safe to re-run.
-- ==================================================

-- Delivery fee for each bookable vehicle, fixed when the order is
-- placed: { "motorbike": 180, "three-wheeler": 234, "car": 288 }.
-- orders.delivery_fee is the fee of the vehicle booked (Bike until
-- the customer books). NULL on older orders (one fee for all).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS vehicle_fees JSONB NULL;
