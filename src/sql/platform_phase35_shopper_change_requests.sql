-- =====================================================
-- PHASE 35: shopper profile protection (2026-10-28)
--   * approved shoppers can't edit their vehicle, legal name / NIC or
--     phone directly: they send a change request that Owner /
--     Operations admins review (phone changes may complete on their
--     own once both numbers are verified by SMS and no risk check
--     fires; without SMS they go to an admin)
--   * lost phone: a recovery request (identity checked against the
--     registration) reviewed by an admin; same account, no duplicate
--   * every applied change is kept in shopper_profile_history
--   * shoppers.auth_version: bumped after a phone change / recovery so
--     every older login token (and socket) stops working
--   * vehicle eligibility: licence expiry + an admin restriction keep
--     a shopper offline until resolved
-- =====================================================

BEGIN;

ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vehicle_make VARCHAR(40),
  ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR(60),
  ADD COLUMN IF NOT EXISTS licence_expiry DATE,
  ADD COLUMN IF NOT EXISTS vehicle_restriction VARCHAR(300),
  ADD COLUMN IF NOT EXISTS vehicle_restricted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vehicle_restricted_by INTEGER REFERENCES admins(id) ON DELETE SET NULL;

-- Licence expiry of shoppers approved through an application
UPDATE shoppers sh
SET licence_expiry = a.licence_expiry
FROM shopper_applications a
WHERE a.shopper_id = sh.id AND a.status = 'approved' AND sh.licence_expiry IS NULL AND a.licence_expiry IS NOT NULL;

CREATE TABLE IF NOT EXISTS shopper_change_requests (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('vehicle_change', 'phone_change', 'phone_recovery', 'identity_change')),
  status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_verification', 'pending_review', 'more_info_required', 'approved', 'rejected', 'cancelled')),
  -- Snapshot of the registered values when the request was made
  current_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Proposed non-secret values (vehicle type / number / make / model /
  -- owner / licence expiry / full name)
  proposed_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposed_mobile VARCHAR(20),
  proposed_licence_encrypted TEXT,
  proposed_nic_encrypted TEXT,
  proposed_nic_hash VARCHAR(64),
  -- { passwordConfirmedAt, currentPhoneVerifiedAt, newPhoneVerifiedAt,
  --   identityChecks: {...}, smsConfigured }
  verification JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- [{ code, label }] reasons an admin must look (recovery, recent
  -- change, open withdrawal, ...)
  risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  shopper_note VARCHAR(500),
  decision_reason VARCHAR(500),
  info_request JSONB,
  -- Recovery requests are made signed out: a status token (hashed)
  status_token_hash VARCHAR(64),
  client_request_id VARCHAR(64),
  submitted_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  documents_deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open request of each type per shopper
CREATE UNIQUE INDEX IF NOT EXISTS shopper_change_requests_open_key
  ON shopper_change_requests (shopper_id, (CASE WHEN type = 'phone_recovery' THEN 'phone_change' ELSE type END))
  WHERE status IN ('draft', 'pending_verification', 'pending_review', 'more_info_required');

CREATE UNIQUE INDEX IF NOT EXISTS shopper_change_requests_client_key
  ON shopper_change_requests (shopper_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS shopper_change_requests_status_idx
  ON shopper_change_requests (status, submitted_at);

CREATE TABLE IF NOT EXISTS shopper_change_request_documents (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES shopper_change_requests(id) ON DELETE CASCADE,
  doc_type VARCHAR(30) NOT NULL
    CHECK (doc_type IN ('nic_front', 'nic_back', 'selfie', 'licence_front', 'licence_back', 'vehicle_cr', 'owner_letter')),
  file_name VARCHAR(200) NOT NULL,
  mime_type VARCHAR(60) NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replaced_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS shopper_change_request_documents_current_key
  ON shopper_change_request_documents (request_id, doc_type)
  WHERE replaced_at IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS shopper_change_request_events (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES shopper_change_requests(id) ON DELETE CASCADE,
  action VARCHAR(40) NOT NULL,
  from_status VARCHAR(30),
  to_status VARCHAR(30),
  actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('shopper', 'admin', 'system', 'public')),
  actor_id INTEGER,
  note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shopper_change_request_events_req_idx
  ON shopper_change_request_events (request_id, created_at);

-- Every applied change to a protected field (previous -> new).
-- Licence / NIC numbers are kept masked here.
CREATE TABLE IF NOT EXISTS shopper_profile_history (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  field VARCHAR(40) NOT NULL,
  old_value VARCHAR(200),
  new_value VARCHAR(200),
  change_request_id INTEGER REFERENCES shopper_change_requests(id) ON DELETE SET NULL,
  changed_by_type VARCHAR(10) NOT NULL CHECK (changed_by_type IN ('shopper', 'admin', 'system')),
  changed_by_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shopper_profile_history_shopper_idx
  ON shopper_profile_history (shopper_id, created_at DESC);

COMMIT;
