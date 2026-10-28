-- =====================================================
-- PHASE 43 (2026-10-29): CUSTOMER SUPPORT CASES + GETME CREDIT ISSUING
--
-- * support_cases: a customer reports a problem with a DELIVERED order
--   (within customer_controls_settings.support_report_window_hours of
--   delivery). Staff work it from the admin Support queue and resolve
--   it with a card refund, GetMe credit (customer_credit_entries), no
--   money, or decline it. items = the affected order items with the
--   paid unit price; suggested_amount = their paid value.
--   client_request_id (unique per customer) makes "Send report" safe
--   to retry. A resolved / declined case can't be resolved again.
-- * support_case_events: the conversation and history of a case
--   (customer / staff messages, internal staff notes, status and
--   assignment changes, resolution). visibility 'internal' rows are
--   never sent to the customer. Append-only.
-- * support_case_photos: up to 3 private photos per case (files in
--   src/uploads/support-cases, served only through signed, expiring
--   links like supermarket bill photos).
-- * Super Admin approval requests: one open request per action +
--   record type + record (customer.credit is used for a case and for a
--   customer, so the record type is part of the key now).
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS support_cases (
  id BIGSERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  category VARCHAR(20) NOT NULL
    CHECK (category IN ('missing_item', 'wrong_item', 'damaged', 'quality', 'late_delivery', 'other')),
  status VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'waiting_customer', 'resolved', 'declined')),
  description VARCHAR(1000) NOT NULL,
  -- [{ orderItemId, name, quantity, unitPrice, lineAmount }]
  items JSONB NOT NULL DEFAULT '[]',
  suggested_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (suggested_amount >= 0),
  assigned_admin_id INTEGER REFERENCES admins(id),
  assigned_at TIMESTAMPTZ,
  first_response_at TIMESTAMPTZ,
  first_response_due_at TIMESTAMPTZ NOT NULL,
  overdue_notified_at TIMESTAMPTZ,
  last_customer_message_at TIMESTAMPTZ,
  last_staff_message_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES admins(id),
  resolution_type VARCHAR(12) CHECK (resolution_type IN ('card_refund', 'credit', 'declined', 'no_money')),
  resolution_amount NUMERIC(12, 2) CHECK (resolution_amount IS NULL OR resolution_amount >= 0),
  resolution_note VARCHAR(500),
  client_request_id VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT support_cases_resolution_check CHECK (
    (status IN ('resolved', 'declined')) = (resolution_type IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS support_cases_request_idx ON support_cases (customer_id, client_request_id);
CREATE INDEX IF NOT EXISTS support_cases_status_idx ON support_cases (status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_cases_order_idx ON support_cases (order_id);
CREATE INDEX IF NOT EXISTS support_cases_customer_idx ON support_cases (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_cases_assigned_idx ON support_cases (assigned_admin_id) WHERE assigned_admin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS support_cases_due_idx ON support_cases (first_response_due_at)
  WHERE first_response_at IS NULL AND status NOT IN ('resolved', 'declined');

CREATE TABLE IF NOT EXISTS support_case_events (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES support_cases(id),
  kind VARCHAR(12) NOT NULL CHECK (kind IN ('created', 'message', 'note', 'status', 'assigned', 'resolved', 'approval')),
  author_type VARCHAR(10) NOT NULL CHECK (author_type IN ('customer', 'staff', 'system')),
  admin_id INTEGER REFERENCES admins(id),
  visibility VARCHAR(10) NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'internal')),
  body VARCHAR(2000),
  data JSONB,
  client_request_id VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_case_events_case_idx ON support_case_events (case_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS support_case_events_request_idx ON support_case_events (case_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION support_case_events_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support_case_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_case_events_no_change ON support_case_events;
CREATE TRIGGER support_case_events_no_change
  BEFORE UPDATE OR DELETE ON support_case_events
  FOR EACH ROW EXECUTE FUNCTION support_case_events_no_change();

CREATE TABLE IF NOT EXISTS support_case_photos (
  id BIGSERIAL PRIMARY KEY,
  case_id BIGINT NOT NULL REFERENCES support_cases(id),
  file_name VARCHAR(120) NOT NULL UNIQUE,
  mime_type VARCHAR(40) NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS support_case_photos_case_idx ON support_case_photos (case_id, id);

-- Credit entries point at their case
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_credit_entries_case_fk') THEN
    ALTER TABLE customer_credit_entries ADD CONSTRAINT customer_credit_entries_case_fk
      FOREIGN KEY (support_case_id) REFERENCES support_cases(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS customer_credit_entries_case_idx ON customer_credit_entries (support_case_id)
  WHERE support_case_id IS NOT NULL;

-- One open approval request per action + record type + record
CREATE UNIQUE INDEX IF NOT EXISTS admin_approval_requests_pending_entity_idx
  ON admin_approval_requests (action_type, entity_type, entity_id) WHERE status = 'pending';
DROP INDEX IF EXISTS admin_approval_requests_pending_idx;

COMMIT;
