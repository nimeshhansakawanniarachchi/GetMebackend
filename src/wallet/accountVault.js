const crypto = require('crypto');

// =====================================================
// PAYOUT ACCOUNT VAULT
// Shoppers' bank account numbers are stored encrypted (AES-256-GCM,
// same format as payments/cardVault.js) and decrypted only for a
// finance admin making the transfer. The apps get the last 4 digits.
// Key: PAYOUT_ACCOUNT_KEY (64 hex chars). Outside production a key
// derived from JWT_SECRET is used so development works without one.
// =====================================================

const getKey = () => {
  const configured = String(process.env.PAYOUT_ACCOUNT_KEY || '').trim();

  if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    return Buffer.from(configured, 'hex');
  }

  if (process.env.NODE_ENV !== 'production' && process.env.JWT_SECRET) {
    return crypto.createHash('sha256').update(`getme-payout-accounts:${process.env.JWT_SECRET}`).digest();
  }

  throw new Error('PAYOUT_ACCOUNT_KEY must be set (64 hex characters) to save bank accounts');
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
    throw new Error('Saved account number is unreadable');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
};

// Same number -> same hash (duplicate check), not reversible
const hashAccountNumber = (number) =>
  crypto.createHmac('sha256', getKey()).update(String(number)).digest('hex');

module.exports = {
  encryptAccountNumber,
  decryptAccountNumber,
  hashAccountNumber,
};
