-- ==================================================
-- PLATFORM PHASE 16 — shopper profile photo
-- Run once: node src/sql/runSql.js src/sql/platform_phase16_shopper_photo.sql
-- Safe to re-run.
-- ==================================================

-- The shopper's face (/uploads/shoppers/...): customers see it on
-- the live map pin and the shopper card. NULL = no photo.
ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS profile_image_url TEXT NULL;
