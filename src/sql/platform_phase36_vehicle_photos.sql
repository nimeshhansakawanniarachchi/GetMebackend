-- =====================================================
-- PHASE 36: vehicle photos + per-document review (2026-10-28)
--   * new document types: vehicle_front, vehicle_side, vehicle_rear,
--     vehicle_interior. Which ones a vehicle needs comes from the
--     pricing settings (vehiclePhotos, per vehicle type): Bike = front,
--     side, rear (number plate; no interior); Tuk / Car = front,
--     side, interior
--   * every document (application + change request) is reviewed one by
--     one: pending -> accepted | rejected (who, when, note). An
--     application or change request can only be approved once every
--     required document is accepted - an upload alone is never
--     "verified"
--   * shopper_vehicle_records: the verified vehicle (details + the
--     documents that proved it) after each approval; the previous one
--     is kept, marked superseded (vehicle history)
-- =====================================================

BEGIN;

ALTER TABLE shopper_application_documents DROP CONSTRAINT IF EXISTS shopper_application_documents_doc_type_check;
ALTER TABLE shopper_application_documents
  ADD CONSTRAINT shopper_application_documents_doc_type_check
  CHECK (doc_type IN ('nic_front', 'nic_back', 'selfie', 'licence_front', 'licence_back', 'vehicle_cr', 'owner_letter',
                      'vehicle_front', 'vehicle_side', 'vehicle_rear', 'vehicle_interior'));

ALTER TABLE shopper_change_request_documents DROP CONSTRAINT IF EXISTS shopper_change_request_documents_doc_type_check;
ALTER TABLE shopper_change_request_documents
  ADD CONSTRAINT shopper_change_request_documents_doc_type_check
  CHECK (doc_type IN ('nic_front', 'nic_back', 'selfie', 'licence_front', 'licence_back', 'vehicle_cr', 'owner_letter',
                      'vehicle_front', 'vehicle_side', 'vehicle_rear', 'vehicle_interior'));

-- Per-document review
ALTER TABLE shopper_application_documents
  ADD COLUMN IF NOT EXISTS review_status VARCHAR(10) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS review_note VARCHAR(300),
  ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE shopper_change_request_documents
  ADD COLUMN IF NOT EXISTS review_status VARCHAR(10) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS review_note VARCHAR(300),
  ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE shopper_application_documents DROP CONSTRAINT IF EXISTS shopper_application_documents_review_check;
ALTER TABLE shopper_application_documents
  ADD CONSTRAINT shopper_application_documents_review_check CHECK (review_status IN ('pending', 'accepted', 'rejected'));

ALTER TABLE shopper_change_request_documents DROP CONSTRAINT IF EXISTS shopper_change_request_documents_review_check;
ALTER TABLE shopper_change_request_documents
  ADD CONSTRAINT shopper_change_request_documents_review_check CHECK (review_status IN ('pending', 'accepted', 'rejected'));

-- Documents of applications / requests already approved before this
-- phase were accepted as part of that approval
UPDATE shopper_application_documents d
SET review_status = 'accepted', reviewed_by = a.reviewed_by, reviewed_at = a.reviewed_at
FROM shopper_applications a
WHERE a.id = d.application_id AND a.status = 'approved' AND d.review_status = 'pending';

UPDATE shopper_change_request_documents d
SET review_status = 'accepted', reviewed_by = r.reviewed_by, reviewed_at = r.reviewed_at
FROM shopper_change_requests r
WHERE r.id = d.request_id AND r.status = 'approved' AND d.review_status = 'pending';

-- The verified vehicle after each approval (history)
CREATE TABLE IF NOT EXISTS shopper_vehicle_records (
  id SERIAL PRIMARY KEY,
  shopper_id INTEGER NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('application', 'change_request')),
  source_id INTEGER NOT NULL,
  vehicle_type VARCHAR(20),
  vehicle_number VARCHAR(20),
  vehicle_make VARCHAR(40),
  vehicle_model VARCHAR(60),
  is_registered_owner BOOLEAN,
  licence_expiry DATE,
  -- [{ id, type }] documents (in the source's table) that proved it
  documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  approved_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at TIMESTAMPTZ,
  superseded_by INTEGER REFERENCES shopper_vehicle_records(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS shopper_vehicle_records_current_key
  ON shopper_vehicle_records (shopper_id) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS shopper_vehicle_records_shopper_idx
  ON shopper_vehicle_records (shopper_id, approved_at DESC);

-- Shoppers approved through an application before this phase
INSERT INTO shopper_vehicle_records (shopper_id, source_type, source_id, vehicle_type, vehicle_number, is_registered_owner, licence_expiry, documents, approved_by, approved_at)
SELECT a.shopper_id, 'application', a.id, a.vehicle_type, a.vehicle_number, a.is_registered_owner, a.licence_expiry,
       COALESCE((SELECT json_agg(json_build_object('id', d.id, 'type', d.doc_type))
                 FROM shopper_application_documents d
                 WHERE d.application_id = a.id AND d.replaced_at IS NULL AND d.deleted_at IS NULL
                   AND d.doc_type IN ('vehicle_cr', 'owner_letter', 'licence_front', 'licence_back'))::jsonb, '[]'::jsonb),
       a.reviewed_by, COALESCE(a.reviewed_at, NOW())
FROM shopper_applications a
WHERE a.status = 'approved'
  AND NOT EXISTS (SELECT 1 FROM shopper_vehicle_records r WHERE r.shopper_id = a.shopper_id);

COMMIT;
