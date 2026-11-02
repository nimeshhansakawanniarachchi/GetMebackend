const crypto = require('crypto');

// =====================================================
// COMPANY BANK ACCOUNT VAULT (phase 50)
// GetMe's own account numbers are stored encrypted with AES-256-GCM in
// the same 'v1.iv.tag.data' format as wallet/accountVault.js (shopper
// payout accounts) but with a SEPARATE key, so neither key opens the
// other's data. Shopper payout data and its key are not touched here.
// Key: COMPANY_ACCOUNT_KEY (64 hex characters). Outside production a
// key derived from JWT_SECRET is used so development works without one;
// in production saving or reading a number is refused without the key.
// =====================================================

const KEY_ENV = 'COMPANY_ACCOUNT_KEY';

const isProduction = () => String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';

const getKey = () => {
  const configured = String(process.env[KEY_ENV] || '').trim();

  if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    return Buffer.from(configured, 'hex');
  }

  if (!isProduction() && process.env.JWT_SECRET) {
    return crypto.createHash('sha256').update(`getme-company-accounts:${process.env.JWT_SECRET}`).digest();
  }

  throw Object.assign(new Error(`${KEY_ENV} must be set (64 hex characters) to store company bank accounts`), {
    status: 503,
    code: 'COMPANY_ACCOUNT_KEY_MISSING',
  });
};

// Where the key comes from (never the key itself)
const keySource = () => {
  if (/^[0-9a-fA-F]{64}$/.test(String(process.env[KEY_ENV] || '').trim())) return 'configured';
  if (!isProduction() && process.env.JWT_SECRET) return 'development_fallback';
  return 'missing';
};

const encryptAccountNumber = (number) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(number), 'utf8'), cipher.final()]);

  return ['v1', iv, cipher.getAuthTag(), data]
    .map((part) => (Buffer.isBuffer(part) ? part.toString('base64url') : part))
    .join('.');
};

const decryptAccountNumber = (stored) => {
  const [version, iv, tag, data] = String(stored || '').split('.');

  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('Saved company account number is unreadable');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
};

// Same number -> same hash (duplicate check), not reversible
const hashAccountNumber = (number) => crypto.createHmac('sha256', getKey()).update(String(number)).digest('hex');

module.exports = {
  KEY_ENV,
  keySource,
  encryptAccountNumber,
  decryptAccountNumber,
  hashAccountNumber,
};
