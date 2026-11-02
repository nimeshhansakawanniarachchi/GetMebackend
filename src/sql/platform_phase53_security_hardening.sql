-- =====================================================
-- PHASE 53 (2026-10-30): SECURITY HARDENING S2
-- (code-backups/reports/getme-security-review-2026-10-30.html)
--
-- * Shop and shop-staff session versions (B-11): a password change
--   bumps auth_version, so tokens signed before it stop working
--   (src/middleware/shopAuthMiddleware.js, bin/www).
-- * Admin two-step sign-in (B-13): TOTP (RFC 6238, 30 s, 6 digits).
--   The secret is stored encrypted (src/admin/mfa.js, AES-256-GCM);
--   mfa_last_step stops a code being used twice. When
--   admin_security_settings.mfa_required is on, an admin without MFA
--   must set it up at sign-in before anything else works.
-- =====================================================

BEGIN;

ALTER TABLE shops ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_staff ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_secret_enc TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_pending_secret_enc TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS mfa_locked_until TIMESTAMPTZ;

ALTER TABLE admin_security_settings ADD COLUMN IF NOT EXISTS mfa_required BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;
