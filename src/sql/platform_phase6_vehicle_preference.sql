-- ==================================================
-- PLATFORM PHASE 6 — customer's preferred shopper vehicle
-- Run once: node src/sql/runSql.js src/sql/platform_phase6_vehicle_preference.sql
-- Safe to re-run.
-- ==================================================

-- Chosen on the Find a shopper screen. NULL = any vehicle.
-- Values match shoppers.vehicle_type (see src/utils/vehicleTypes.js).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS preferred_vehicle_type VARCHAR(30) NULL;
