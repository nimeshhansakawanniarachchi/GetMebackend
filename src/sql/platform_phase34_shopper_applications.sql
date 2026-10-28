-- =====================================================
-- PHASE 34: step-by-step shopper registration (owner's choices
-- 2026-10-28)
--   * the account (mobile + password) is created at step 1; the
--     rest of the application is saved step by step (save & resume)
--     and submitted for admin review
--   * statuses: draft -> submitted -> under_review ->
--     more_info_required (back to the applicant) -> approved | rejected
--   * NIC and driving licence numbers are stored encrypted
--     (onboarding/identityVault.js) + an HMAC for duplicate checks;
--     documents live outside the public uploads folder
--     (private-uploads/shopper-applications), served only to the
--     applicant and to Owner / Operations admins
--   * phone OTP (Notify.lk) when configured; otherwise the phone is
--     confirmed by an admin and the application says so
--   * documents of rejected applications / drafts idle for 90 days are
--     deleted automatically (records of the decision stay)
-- Existing approved shoppers have no application and keep working.
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS shopper_applications (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL UNIQUE REFERENCES shoppers(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'under_review', 'more_info_required', 'approved', 'rejected')),

  -- Step 1: personal
  full_name VARCHAR(120),
  date_of_birth DATE,
  email VARCHAR(160),
  phone_verified_at TIMESTAMPTZ,
  -- 'otp' (SMS code) | 'admin' (confirmed by phone call during review)
  phone_verified_by VARCHAR(10),

  -- Step 2: identity (NIC encrypted; last 4 for display)
  nic_encrypted TEXT,
  nic_hash VARCHAR(64),
  nic_last4 VARCHAR(4),

  -- Step 3: vehicle + driving licence
  vehicle_type VARCHAR(20) CHECK (vehicle_type IN ('motorbike', 'three-wheeler', 'car')),
  vehicle_number VARCHAR(20),
  is_registered_owner BOOLEAN,
  licence_encrypted TEXT,
  licence_last4 VARCHAR(4),
  licence_expiry DATE,

  -- Step 4: address + emergency contact
  address_line VARCHAR(200),
  city VARCHAR(80),
  district VARCHAR(40),
  service_area VARCHAR(120),
  emergency_name VARCHAR(120),
  emergency_phone VARCHAR(20),
  emergency_relation VARCHAR(40),

  -- Step 5: payout account (encrypted in shopper_payout_accounts)
  payout_account_id INTEGER REFERENCES shopper_payout_accounts(id) ON DELETE SET NULL,

  -- Step 6: consent
  terms_accepted_at TIMESTAMPTZ,
  privacy_accepted_at TIMESTAMPTZ,
  terms_version VARCHAR(20),

  -- Review
  submitted_at TIMESTAMPTZ,
  submit_count INTEGER NOT NULL DEFAULT 0,
  last_submit_request_id VARCHAR(64),
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  decision_reason VARCHAR(500),
  -- { message, items: ['nic_front', 'vehicle_number', ...] }
  info_request JSONB,

  documents_deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live application per NIC (a rejected one may apply again)
CREATE UNIQUE INDEX IF NOT EXISTS shopper_applications_nic_key
  ON shopper_applications (nic_hash)
  WHERE nic_hash IS NOT NULL AND status <> 'rejected';

CREATE INDEX IF NOT EXISTS shopper_applications_status_idx
  ON shopper_applications (status, submitted_at DESC);

CREATE TABLE IF NOT EXISTS shopper_application_documents (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES shopper_applications(id) ON DELETE CASCADE,
  doc_type VARCHAR(30) NOT NULL
    CHECK (doc_type IN ('nic_front', 'nic_back', 'selfie', 'licence_front', 'licence_back', 'vehicle_cr', 'owner_letter')),
  -- Path under private-uploads/shopper-applications (never public)
  file_name VARCHAR(200) NOT NULL,
  mime_type VARCHAR(60) NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 VARCHAR(64) NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  replaced_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

-- One current document per type
CREATE UNIQUE INDEX IF NOT EXISTS shopper_application_documents_current_key
  ON shopper_application_documents (application_id, doc_type)
  WHERE replaced_at IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS shopper_application_events (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES shopper_applications(id) ON DELETE CASCADE,
  action VARCHAR(40) NOT NULL,
  from_status VARCHAR(30),
  to_status VARCHAR(30),
  actor_type VARCHAR(10) NOT NULL CHECK (actor_type IN ('shopper', 'admin', 'system')),
  actor_id INTEGER,
  note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shopper_application_events_app_idx
  ON shopper_application_events (application_id, created_at);

-- Phone verification codes (hashed; never stored or logged in clear)
CREATE TABLE IF NOT EXISTS shopper_phone_otps (
  id SERIAL PRIMARY KEY,
  mobile VARCHAR(20) NOT NULL,
  purpose VARCHAR(20) NOT NULL DEFAULT 'register',
  code_hash VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  -- A one-time proof handed to the app after a correct code, used once
  -- to create the account
  proof_hash VARCHAR(64),
  proof_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shopper_phone_otps_mobile_idx
  ON shopper_phone_otps (mobile, created_at DESC);

COMMIT;
