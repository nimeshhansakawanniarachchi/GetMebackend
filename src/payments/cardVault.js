const crypto = require('crypto');

const { getMode } = require('./payhere');

// =====================================================
// CARD TOKEN VAULT
// PayHere's customer_token can charge the card, so it is stored
// encrypted (AES-256-GCM) and only ever decrypted on the server
// right before a charge. Never sent to the apps.
// Key: CARD_TOKEN_KEY (64 hex chars = 32 bytes). Test mode falls
// back to a key derived from JWT_SECRET.
// =====================================================

const getKey = () => {
  const configured = String(process.env.CARD_TOKEN_KEY || '').trim();

  if (/^[0-9a-fA-F]{64}$/.test(configured)) {
    return Buffer.from(configured, 'hex');
  }

  if (getMode() === 'test' && process.env.JWT_SECRET) {
    return crypto
      .createHash('sha256')
      .update(`getme-card-vault:${process.env.JWT_SECRET}`)
      .digest();
  }

  throw new Error('CARD_TOKEN_KEY must be set (64 hex characters) to save cards');
};

// "v1.<iv>.<tag>.<data>" (base64url parts)
const encryptToken = (token) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return ['v1', iv, tag, data].map((part) =>
    Buffer.isBuffer(part) ? part.toString('base64url') : part
  ).join('.');
};

const decryptToken = (stored) => {
  const [version, iv, tag, data] = String(stored || '').split('.');

  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('Saved card token is unreadable');
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(iv, 'base64url')
  );

  decipher.setAuthTag(Buffer.from(tag, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

module.exports = {
  encryptToken,
  decryptToken,
};
