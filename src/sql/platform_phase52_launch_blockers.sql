-- =====================================================
-- PHASE 52 (2026-10-30): LAUNCH BLOCKERS (security)
--
-- Delivery PIN attempt lock: 5 wrong PINs lock the PIN check on that
-- order for 30 minutes (shopperOrderStatusController.verifyDeliveryPin).
-- With a 6-digit PIN this keeps guessing to ~10 tries an hour.
-- =====================================================

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_pin_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_pin_locked_until TIMESTAMPTZ;

COMMIT;
