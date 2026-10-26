-- =====================================================
-- PLATFORM PHASE 26 — admin operations platform
-- Run once: node src/sql/runSql.js src/sql/platform_phase26_admin_ops.sql
--
--   admins.role               owner | operations | finance | support
--                             (existing admins become owner)
--   admin_audit_log           every admin change (who, what, when)
--   shoppers.location_updated_at   when the app last sent a position,
--                             so stale map positions can be flagged
--   orders.accepted_at        shopper accepted (timeline, delays)
--   orders.out_for_delivery_at  shopper left the store
-- All additive: no existing column changes meaning.
-- =====================================================

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'owner';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admins_role_check'
  ) THEN
    ALTER TABLE admins
      ADD CONSTRAINT admins_role_check
      CHECK (role IN ('owner', 'operations', 'finance', 'support'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  admin_id INT,
  admin_name VARCHAR(120),
  admin_role VARCHAR(20),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(30),
  entity_id VARCHAR(40),
  summary VARCHAR(300),
  details JSONB,
  ip VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_log_entity_idx ON admin_audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS admin_audit_log_admin_idx ON admin_audit_log (admin_id, created_at DESC);

ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS out_for_delivery_at TIMESTAMPTZ;
