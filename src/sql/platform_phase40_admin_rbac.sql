-- =====================================================
-- PLATFORM PHASE 40 - admin roles, permissions, approvals (2026-10-29)
-- Run once: node src/sql/runSql.js src/sql/platform_phase40_admin_rbac.sql
--
-- Builds on phase 26 (admins.role owner / operations / finance /
-- support + admin_audit_log). The 'owner' role is the Super Admin.
-- * admins: Developer role, per-staff permission grants / revokes
--   (src/admin/permissions.js), session version (password reset signs
--   every session out), must-change-password for temporary passwords.
-- * admin_audit_log: outcome + before / after values; rows can never be
--   changed or deleted (trigger).
-- * admin_approval_requests: high-risk money actions over the limits
--   wait for the Super Admin (maker-checker).
-- * admin_security_settings: the approval limits.
-- * order_support_notes: support notes on orders (append-only).
-- Existing admins, roles and log rows are kept as they are.
-- =====================================================

ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;
ALTER TABLE admins ADD CONSTRAINT admins_role_check
  CHECK (role IN ('owner', 'operations', 'finance', 'support', 'developer'));

ALTER TABLE admins ADD COLUMN IF NOT EXISTS permission_grants TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS permission_revokes TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE admins ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- Audit log: outcome (success / failed / denied) and before / after
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS outcome VARCHAR(10) NOT NULL DEFAULT 'success';
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS before_value JSONB;
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS after_value JSONB;
CREATE INDEX IF NOT EXISTS admin_audit_log_outcome_idx ON admin_audit_log (outcome, created_at DESC);

-- Nobody edits or deletes audit history (not even the Super Admin
-- through the app)
CREATE OR REPLACE FUNCTION admin_audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_audit_log_no_change ON admin_audit_log;
CREATE TRIGGER admin_audit_log_no_change
  BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION admin_audit_log_immutable();

-- Approval limits (LKR): above them a Finance action waits for the
-- Super Admin
CREATE TABLE IF NOT EXISTS admin_security_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  refund_approval_limit NUMERIC(12, 2) NOT NULL DEFAULT 10000 CHECK (refund_approval_limit >= 0),
  earnings_adjust_approval_limit NUMERIC(12, 2) NOT NULL DEFAULT 2000 CHECK (earnings_adjust_approval_limit >= 0),
  updated_by INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO admin_security_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_approval_requests (
  id SERIAL PRIMARY KEY,
  action_type VARCHAR(40) NOT NULL,
  entity_type VARCHAR(40),
  entity_id VARCHAR(40),
  amount NUMERIC(12, 2),
  summary VARCHAR(300),
  -- The request as sent (no secrets: refund / adjustment fields only)
  params JSONB NOT NULL DEFAULT '{}',
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(10) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'failed')),
  requested_by INTEGER NOT NULL REFERENCES admins (id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by INTEGER REFERENCES admins (id),
  decided_at TIMESTAMPTZ,
  decision_note VARCHAR(300),
  result_status INTEGER,
  result_message VARCHAR(300),
  CONSTRAINT admin_approval_not_self CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

-- One open request per action + record (no duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS admin_approval_requests_pending_idx
  ON admin_approval_requests (action_type, entity_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS admin_approval_requests_status_idx ON admin_approval_requests (status, requested_at DESC);

CREATE TABLE IF NOT EXISTS order_support_notes (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders (id),
  admin_id INTEGER NOT NULL REFERENCES admins (id),
  category VARCHAR(30) NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'complaint', 'missing_items', 'cancellation', 'delivery', 'payment', 'other')),
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 3 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_support_notes_order_idx ON order_support_notes (order_id, created_at);

CREATE OR REPLACE FUNCTION order_support_notes_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_support_notes are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_support_notes_no_change ON order_support_notes;
CREATE TRIGGER order_support_notes_no_change
  BEFORE UPDATE ON order_support_notes
  FOR EACH ROW EXECUTE FUNCTION order_support_notes_immutable();
