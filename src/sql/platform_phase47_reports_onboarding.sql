-- =====================================================
-- PLATFORM PHASE 47 (2026-10-29): grocery operations reports,
-- shop onboarding checklist + account manager, promotion results.
-- Run: node src/sql/runSql.js src/sql/platform_phase47_reports_onboarding.sql
-- Idempotent and additive (safe to re-run).
--
-- shops.account_manager_admin_id  the GetMe staff member who looks
--                                 after the shop (admins.id)
-- shops.onboarding                manual checklist items, each
--   { "checked": bool, "checked_by": admin id, "checked_at": ISO time }
--   keys: business_registration, owner_identity, agreement_signed,
--         bank_details_verified (yes / no only: account numbers are
--         never stored here)
-- shops.onboarding_notes          staff notes (max 1000 characters)
-- shops.onboarding_completed_at   stamped when every item (manual +
--                                 automatic) is done; automatic items
--                                 (products, photo, hours, location) are
--                                 computed live, never stored
-- Reports read existing tables; only indexes are added for them.
-- =====================================================

BEGIN;

ALTER TABLE shops
  ADD COLUMN IF NOT EXISTS account_manager_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS onboarding JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS onboarding_notes VARCHAR(1000),
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shops_onboarding_is_object') THEN
    ALTER TABLE shops ADD CONSTRAINT shops_onboarding_is_object CHECK (jsonb_typeof(onboarding) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS shops_account_manager_idx ON shops (account_manager_admin_id)
  WHERE account_manager_admin_id IS NOT NULL;

-- Report lookups
CREATE INDEX IF NOT EXISTS orders_delivered_at_idx ON orders (delivered_at) WHERE delivered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_customer_created_idx ON orders (customer_id, created_at);
CREATE INDEX IF NOT EXISTS order_items_offer_id_idx ON order_items (offer_id) WHERE offer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS promo_redemptions_promo_id_idx ON promo_redemptions (promo_id);
CREATE INDEX IF NOT EXISTS card_payments_order_id_idx ON card_payments (order_id) WHERE order_id IS NOT NULL;

COMMIT;
