const crypto = require('crypto');

// =====================================================
// APPLICANT IDENTITY VAULT (phase 34)
// NIC and driving licence numbers of shopper applicants are stored
// encrypted (AES-256-GCM, same format as wallet/accountVault.js) and
// decrypted only for Owner / Operations admins reviewing them. An
// HMAC of the normalised NIC catches duplicate applications.
// Key: APPLICANT_DATA_KEY (64 hex chars). Outside production a key
// derived from JWT_SECRET is used so development works without one.
// =====================================================

const getKey = () => {
  const configured = String(process.env.APPLICANT_DATA_KEY || '').trim();

  if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    return Buffer.from(configured, 'hex');
  }

  if (process.env.NODE_ENV !== 'production' && process.env.JWT_SECRET) {
    return crypto.createHash('sha256').update(`getme-applicant-data:${process.env.JWT_SECRET}`).digest();
  }

  throw new Error('APPLICANT_DATA_KEY must be set (64 hex characters) to store applicant identity data');
};

const encryptIdentity = (value) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);

  return ['v1', iv, cipher.getAuthTag(), data]
    .map((part) => (Buffer.isBuffer(part) ? part.toString('base64url') : part))
    .join('.');
};

const decryptIdentity = (stored) => {
  if (!stored) return null;

  const [version, iv, tag, data] = String(stored).split('.');

  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('Stored identity value is unreadable');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
};

// Same value -> same hash (duplicate check), not reversible
const hashIdentity = (value) =>
  crypto.createHmac('sha256', getKey()).update(`identity:${String(value)}`).digest('hex');

module.exports = { encryptIdentity, decryptIdentity, hashIdentity };
