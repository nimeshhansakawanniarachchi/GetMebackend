-- =====================================================
-- PHASE 46 (2026-10-29): shopper compliance, training quiz, incidents
--
--  * shoppers.revenue_licence_expiry / insurance_expiry (licence_expiry
--    exists since phase 34). Staff with shoppers.manage record them;
--    an expired date blocks going online and dispatch. NULL = not
--    recorded (never blocks).
--  * shoppers.approved_at: first time the account was approved (set by
--    a trigger, backfilled for approved shoppers). With activated_at it
--    decides whether the training quiz applies ("activated after the
--    requirement was switched on").
--  * shopper_compliance_alerts: one row per shopper + document +
--    threshold (30 / 14 / 3 days, expired) + expiry date, so each alert
--    is sent once (admin + shopper notification).
--  * shopper_training_settings (one row) + shopper_training_attempts.
--  * shopper_incidents ("I need help") + shopper_incident_events
--    (timeline: created, shopper updates, acknowledged, notes, resolved).
-- Idempotent: safe to run again.
-- =====================================================

BEGIN;

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS revenue_licence_expiry DATE;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS insurance_expiry DATE;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

-- Shoppers approved before this phase: their account start counts
UPDATE shoppers
SET approved_at = COALESCE(activated_at, created_at::timestamptz)
WHERE approval_status = 'approved' AND approved_at IS NULL;

CREATE OR REPLACE FUNCTION shoppers_set_approved_at() RETURNS trigger AS $$
BEGIN
  IF NEW.approval_status = 'approved' AND NEW.approved_at IS NULL THEN
    NEW.approved_at := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shoppers_approved_at ON shoppers;
CREATE TRIGGER shoppers_approved_at
  BEFORE INSERT OR UPDATE OF approval_status ON shoppers
  FOR EACH ROW EXECUTE FUNCTION shoppers_set_approved_at();

-- -----------------------------------------------------
-- Document expiry alerts (dedupe)
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS shopper_compliance_alerts (
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  document VARCHAR(40) NOT NULL,
  threshold VARCHAR(10) NOT NULL,
  expiry_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shopper_id, document, threshold, expiry_date)
);

-- -----------------------------------------------------
-- Training quiz
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS shopper_training_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  training_required BOOLEAN NOT NULL DEFAULT FALSE,
  training_enabled_at TIMESTAMPTZ,
  questions JSONB,
  questions_version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- questions NULL = the built-in default set (src/compliance/training.js)
INSERT INTO shopper_training_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS shopper_training_attempts (
  id BIGSERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  questions_version INTEGER NOT NULL,
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  wrong_question_ids TEXT[] NOT NULL DEFAULT '{}',
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  passed BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shopper_training_attempts_shopper ON shopper_training_attempts (shopper_id, created_at DESC);

-- -----------------------------------------------------
-- Incidents ("I need help")
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS shopper_incidents (
  id BIGSERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('safety', 'accident', 'customer', 'store', 'app_payment', 'other')),
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('warning', 'critical')),
  note VARCHAR(500),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  location_at TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  acknowledged_by INTEGER,
  acknowledged_at TIMESTAMPTZ,
  resolved_by INTEGER,
  resolved_at TIMESTAMPTZ,
  resolution_note VARCHAR(500),
  client_request_id VARCHAR(64) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shopper_incidents_status ON shopper_incidents (status, created_at DESC);
CREATE INDEX IF NOT EXISTS shopper_incidents_shopper ON shopper_incidents (shopper_id, created_at DESC);

-- One open (not resolved) incident per shopper + type + order
CREATE UNIQUE INDEX IF NOT EXISTS shopper_incidents_one_open
  ON shopper_incidents (shopper_id, type, COALESCE(order_id, 0))
  WHERE status <> 'resolved';

CREATE TABLE IF NOT EXISTS shopper_incident_events (
  id BIGSERIAL PRIMARY KEY,
  incident_id BIGINT NOT NULL REFERENCES shopper_incidents(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('created', 'shopper_update', 'acknowledged', 'note', 'resolved')),
  note VARCHAR(500),
  admin_id INTEGER,
  admin_name VARCHAR(120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shopper_incident_events_incident ON shopper_incident_events (incident_id, created_at);

COMMIT;
