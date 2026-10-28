-- =====================================================
-- PHASE 30: DYNAMIC DELIVERY PRICING
-- pricing_settings_versions: every saved Fees & pricing version,
--   who saved it, when, and when it takes effect (a version with a
--   future effective_from is scheduled). The current settings are
--   the newest version already in effect (pricing/settings.js);
--   platform_settings 'pricing' keeps mirroring them.
-- orders.delivery_pricing: the fare as charged - road route,
--   travel time, the rule version and every vehicle's breakdown
--   (pricing/deliveryFare.js), so old orders are never re-priced
--   with new rates.
-- Safe to run more than once.
-- =====================================================

CREATE TABLE IF NOT EXISTS pricing_settings_versions (
  id SERIAL PRIMARY KEY,
  value JSONB NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note VARCHAR(300),
  created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A scheduled version cancelled before it took effect
  cancelled_at TIMESTAMPTZ,
  cancelled_by INTEGER REFERENCES admins(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS pricing_settings_versions_effective_idx
  ON pricing_settings_versions (effective_from DESC, id DESC)
  WHERE cancelled_at IS NULL;

-- First version = the settings in use today
INSERT INTO pricing_settings_versions (value, effective_from, note, created_by, created_at)
SELECT ps.value, COALESCE(ps.updated_at, NOW()), 'Settings before versioning', ps.updated_by, COALESCE(ps.updated_at, NOW())
FROM platform_settings ps
WHERE ps.key = 'pricing'
  AND NOT EXISTS (SELECT 1 FROM pricing_settings_versions);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_pricing JSONB;
