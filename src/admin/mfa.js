// =====================================================
// ADMIN TWO-STEP SIGN-IN (security review B-13, phase 53)
//
// TOTP (RFC 6238): 30-second steps, 6 digits, HMAC-SHA1 - what Google
// Authenticator, Microsoft Authenticator, 1Password and Authy use.
// * The shared secret is stored encrypted (AES-256-GCM). Key:
//   ADMIN_MFA_KEY (64 hex characters). Outside production a key derived
//   from JWT_SECRET is used; in production the key must be set.
// * A code is accepted for the current step or one step either side
//   (clock drift), and each step only once (admins.mfa_last_step).
// * 5 wrong codes lock code entry for 15 minutes.
// Short-lived "challenge" tokens carry a signed-in-with-password state
// between the password step and the code step; they are not session
// tokens (requireAdmin refuses them: they have no role claim).
// =====================================================

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'GetMe Ops';
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
// High-risk actions need a password / code check this recent (minutes)
const STEP_UP_MINUTES = 15;

// ---------------------------------------------------
// Base32 (RFC 4648, no padding) for authenticator apps
// ---------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

const base32Decode = (text) => {
  const clean = String(text || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

// ---------------------------------------------------
// TOTP
// ---------------------------------------------------

const codeAt = (secretBase32, step) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
};

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

// -> the matching step, or null. lastStep: the step used last time (no reuse)
const verifyCode = (secretBase32, code, lastStep = null, now = Date.now()) => {
  const clean = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const step = currentStep(now);
  for (const candidate of [step, step - 1, step + 1]) {
    if (lastStep != null && candidate <= Number(lastStep)) continue;
    const expected = Buffer.from(codeAt(secretBase32, candidate));
    if (crypto.timingSafeEqual(expected, Buffer.from(clean))) return candidate;
  }
  return null;
};

const newSecret = () => base32Encode(crypto.randomBytes(20));

const otpauthUrl = (secretBase32, accountName) =>
  `otpauth://totp/${encodeURIComponent(`${ISSUER}:${accountName}`)}?secret=${secretBase32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// ---------------------------------------------------
// Secret storage
// ---------------------------------------------------

const getKey = () => {
  const configured = String(process.env.ADMIN_MFA_KEY || '').trim();
  if (/^[0-9a-fA-F]{64}$/.test(configured)) return Buffer.from(configured, 'hex');
  if (process.env.NODE_ENV !== 'production' && process.env.JWT_SECRET) {
    return crypto.createHash('sha256').update(`getme-admin-mfa:${process.env.JWT_SECRET}`).digest();
  }
  throw new Error('ADMIN_MFA_KEY must be set (64 hex characters) in production');
};

const encryptSecret = (secret) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p)).join('.');
};

const decryptSecret = (stored) => {
  const [version, iv, tag, data] = String(stored || '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('MFA secret is unreadable');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
};

// ---------------------------------------------------
// Challenge tokens (password checked, code still needed)
// purpose: 'mfa' (enter a code) | 'mfa-setup' (set up first)
// ---------------------------------------------------

const signChallenge = (admin, purpose) =>
  jwt.sign({ mfaAdminId: admin.id, purpose, av: Number(admin.auth_version || 0) }, process.env.JWT_SECRET, { expiresIn: '10m' });

const readChallenge = (token, purposes) => {
  try {
    const decoded = jwt.verify(String(token || ''), process.env.JWT_SECRET);
    if (!decoded?.mfaAdminId || !purposes.includes(decoded.purpose)) return null;
    return decoded;
  } catch {
    return null;
  }
};

module.exports = {
  STEP_SECONDS,
  STEP_UP_MINUTES,
  MAX_FAILURES,
  LOCK_MINUTES,
  codeAt,
  currentStep,
  verifyCode,
  newSecret,
  otpauthUrl,
  encryptSecret,
  decryptSecret,
  signChallenge,
  readChallenge,
  base32Decode,
};
