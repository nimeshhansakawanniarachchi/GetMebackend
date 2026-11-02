const crypto = require('crypto');

// =====================================================
// LANKAQR PAYLOAD PARSER (phase 49) - the server is the authority
//
// LANKAQR follows the EMVCo Merchant-Presented QR (MPM) format (CBSL
// LANKAQR specification v1.3, PSD Circular 02/2026): a string of TLV
// data objects, each "ID (2 digits) + length (2 digits) + value".
//   00  payload format indicator, must be "01", first object
//   01  point of initiation: "11" static (shopper enters the amount),
//       "12" dynamic (the amount is in the QR)
//   26 / 27  merchant account information reserved for LankaPay. The
//       raw value is kept and hashed as the merchant identity. Any
//       split into sub-fields is UNVERIFIED (the Network Facilitator
//       document is under NDA), so it is never used for identity.
//   52  merchant category code (4 digits)
//   53  currency, must be "144" (LKR)
//   54  amount (dynamic QR), decimal with at most 2 decimals
//   55  tip / convenience fee indicator: fixed (02) or % (03) fees are
//       refused (the paid amount must be exactly what was previewed)
//   58  country, must be "LK"
//   59  merchant name, 60 merchant city, 61 postal code
//   62  additional data template (nested): 05 = reference label
//   64  merchant information in another language (nested)
//   63  CRC-16/CCITT-FALSE over everything before the CRC value
//       (including "6304"), 4 hex digits, last object
//
// No maintained npm EMV-MPM parser was found (emvqr 0.0.5, emv-qrcps
// 0.0.7, steplix-emv-qrcps 0.0.8, emvqr-parser 1.0.6: small, single-
// maintainer, last real releases 2021-2023), so this small module is
// kept with its own unit tests (code-backups/scripts/lankaqr-parser-test.js).
// =====================================================

const MAX_PAYLOAD = 512;
const MIN_PAYLOAD = 30;
// CBSL per-transaction LANKAQR limit and GetMe's minimum
const MAX_AMOUNT = 500000;
const MIN_AMOUNT = 1;

const NAMES = {
  NOT_TEXT: 'This is not a payment QR code.',
  TOO_LONG: 'This QR code is too long to be a LankaQR code.',
  TOO_SHORT: 'This is not a LankaQR payment code.',
  BAD_CHARSET: 'This QR code contains characters a LankaQR code cannot have.',
  NOT_EMV: 'This is not a LankaQR payment code.',
  TRUNCATED: 'The QR code was read only partly. Scan it again.',
  GARBAGE: 'This QR code is damaged or not a LankaQR code. Scan it again.',
  DUPLICATE_TAG: 'This QR code is damaged (a field appears twice).',
  BAD_CRC: 'The QR code check failed (damaged or altered). Scan it again.',
  BAD_POINT_OF_INITIATION: 'This QR code is not a valid LankaQR code.',
  NOT_LANKAQR: 'This is not a LankaQR code (no LankaPay merchant account in it).',
  BAD_MERCHANT_ACCOUNT: 'The merchant account in this QR code is not valid.',
  BAD_MCC: 'The merchant category in this QR code is not valid.',
  WRONG_CURRENCY: 'This QR code is not in Sri Lankan rupees (LKR).',
  BAD_AMOUNT: 'The amount in this QR code is not valid.',
  DYNAMIC_WITHOUT_AMOUNT: 'This QR code is for one payment but has no amount.',
  CONVENIENCE_FEE_NOT_SUPPORTED: 'This QR code adds a convenience fee, which GetMe cannot pay. Ask the cashier for a QR without a fee.',
  WRONG_COUNTRY: 'This QR code is not a Sri Lankan merchant (country is not LK).',
  MISSING_MERCHANT_NAME: 'The merchant name is missing or too long in this QR code.',
  MISSING_CITY: 'The merchant city is missing or too long in this QR code.',
  BAD_ADDITIONAL_DATA: 'The extra data in this QR code is damaged.',
};

class LankaQrError extends Error {
  constructor(code, detail = null) {
    super(NAMES[code] || 'This QR code is not a valid LankaQR code.');
    this.code = code;
    this.detail = detail;
    this.status = 400;
  }
}

const fail = (code, detail) => {
  throw new LankaQrError(code, detail);
};

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0
const crc16 = (input) => {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
};

// TLV list (ID, length, value); throws on truncation / garbage / duplicates
const parseTlv = (text, { where = 'payload' } = {}) => {
  const out = [];
  const seen = new Set();
  let i = 0;

  while (i < text.length) {
    if (text.length - i < 4) fail('TRUNCATED', `${where}: ${text.length - i} trailing characters`);
    const id = text.slice(i, i + 2);
    const lenText = text.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(id) || !/^\d{2}$/.test(lenText)) fail('GARBAGE', `${where}: bad tag at ${i}`);
    const length = Number(lenText);
    if (length === 0) fail('GARBAGE', `${where}: empty tag ${id}`);
    if (i + 4 + length > text.length) fail('TRUNCATED', `${where}: tag ${id} needs ${length} characters`);
    if (seen.has(id)) fail('DUPLICATE_TAG', `${where}: tag ${id}`);
    seen.add(id);
    out.push({ id, length, value: text.slice(i + 4, i + 4 + length) });
    i += 4 + length;
  }

  return out;
};

const toMap = (list) => Object.fromEntries(list.map((t) => [t.id, t.value]));

const normalise = (value) => String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// Amount text -> number (format checked)
const parseAmountText = (text) => {
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text) || text.length > 13) fail('BAD_AMOUNT', text);
  const amount = Math.round(Number(text) * 100) / 100;
  if (!(amount > 0)) fail('BAD_AMOUNT', text);
  return amount;
};

// Builds a payload with a correct CRC (tests, merchant samples).
// tags: [[id, value], ...] without 63.
const buildPayload = (tags) => {
  const body = tags
    .map(([id, value]) => {
      const text = String(value);
      return `${id}${String(text.length).padStart(2, '0')}${text}`;
    })
    .join('');
  return `${body}6304${crc16(`${body}6304`)}`;
};

const IDENTITY_TAGS = ['00', '01', '26', '27', '52', '53', '58', '59', '60', '61'];

// payload -> parsed LANKAQR (throws LankaQrError)
const parse = (input) => {
  if (typeof input !== 'string') fail('NOT_TEXT');
  // Scanners sometimes add a line break at the end
  const payload = input.replace(/[\r\n]+$/, '');

  if (payload.length > MAX_PAYLOAD) fail('TOO_LONG', payload.length);
  if (payload.length < MIN_PAYLOAD) fail('TOO_SHORT', payload.length);
  if (/[\u0000-\u001f\u007f-\u009f]/.test(payload)) fail('BAD_CHARSET');
  if (!payload.startsWith('000201')) fail('NOT_EMV');

  const top = parseTlv(payload);
  const last = top[top.length - 1];

  if (!last || last.id !== '63' || last.length !== 4 || !payload.endsWith(`6304${last.value}`)) fail('BAD_CRC', 'CRC missing or not last');
  if (!/^[0-9A-Fa-f]{4}$/.test(last.value)) fail('BAD_CRC', 'CRC not hex');
  const expectedCrc = crc16(payload.slice(0, -4));
  if (expectedCrc !== last.value.toUpperCase()) fail('BAD_CRC', `expected ${expectedCrc}`);
  if (top.filter((t) => t.id === '63').length !== 1) fail('DUPLICATE_TAG', '63');

  const tags = toMap(top);

  if (tags['00'] !== '01') fail('NOT_EMV', 'payload format');

  const initiation = tags['01'];
  if (initiation != null && !['11', '12'].includes(initiation)) fail('BAD_POINT_OF_INITIATION', initiation);

  // LankaPay-reserved merchant account templates (raw values only)
  const accountTags = ['26', '27'].filter((id) => tags[id] != null);
  if (accountTags.length === 0) fail('NOT_LANKAQR');
  for (const id of accountTags) {
    if (tags[id].trim().length < 4) fail('BAD_MERCHANT_ACCOUNT', id);
  }
  const accountRaw = accountTags.map((id) => `${id}=${tags[id]}`).join('|');

  // Unverified view of the sub-fields (display / support only)
  const accountSubfields = {};
  for (const id of accountTags) {
    try {
      accountSubfields[id] = toMap(parseTlv(tags[id], { where: `tag ${id}` }));
    } catch {
      accountSubfields[id] = null;
    }
  }

  const mcc = tags['52'];
  if (!/^\d{4}$/.test(mcc || '')) fail('BAD_MCC', mcc);
  if (tags['53'] !== '144') fail('WRONG_CURRENCY', tags['53']);
  if (tags['58'] !== 'LK') fail('WRONG_COUNTRY', tags['58']);

  const name = String(tags['59'] || '').trim();
  if (!name || tags['59'].length > 25) fail('MISSING_MERCHANT_NAME');
  const city = String(tags['60'] || '').trim();
  if (!city || tags['60'].length > 15) fail('MISSING_CITY');

  const amount = tags['54'] != null ? parseAmountText(tags['54']) : null;
  if (initiation === '12' && amount == null) fail('DYNAMIC_WITHOUT_AMOUNT');

  if (tags['55'] != null) {
    if (!['01', '02', '03'].includes(tags['55'])) fail('GARBAGE', 'tag 55');
    if (tags['55'] !== '01') fail('CONVENIENCE_FEE_NOT_SUPPORTED');
  }

  let additional = {};
  if (tags['62'] != null) {
    try {
      additional = toMap(parseTlv(tags['62'], { where: 'tag 62' }));
    } catch (caught) {
      fail('BAD_ADDITIONAL_DATA', caught.detail);
    }
  }
  if (additional['05'] != null && additional['05'].length > 25) fail('BAD_ADDITIONAL_DATA', 'reference label');

  let otherLanguage = null;
  if (tags['64'] != null) {
    try {
      otherLanguage = toMap(parseTlv(tags['64'], { where: 'tag 64' }));
    } catch (caught) {
      fail('BAD_ADDITIONAL_DATA', caught.detail);
    }
  }

  const merchantName = name;
  const merchantCity = city;
  const accountHash = sha256(accountRaw);
  const merchantKey = sha256(JSON.stringify([accountRaw, mcc, normalise(merchantName), normalise(merchantCity)]));

  return {
    payloadFormat: '01',
    kind: initiation === '12' ? 'dynamic' : 'static',
    pointOfInitiation: initiation || null,
    merchantAccount: {
      tags: accountTags,
      label: accountTags.join('+'),
      // raw values stay server-side (identity hash input)
      raw: accountRaw,
      subfieldsUnverified: accountSubfields,
    },
    accountHash,
    merchantKey,
    mcc,
    currency: '144',
    amount,
    amountText: tags['54'] ?? null,
    countryCode: 'LK',
    merchantName,
    merchantCity,
    postalCode: tags['61'] || null,
    referenceLabel: additional['05'] || null,
    billNumber: additional['01'] || null,
    terminalLabel: additional['07'] || null,
    otherLanguage,
    tipPrompt: tags['55'] === '01',
    crc: last.value.toUpperCase(),
    tagIds: top.map((t) => t.id),
    // merchant-identity tags only, fresh CRC (stored with approvals)
    // (a dynamic QR's sample becomes static: its amount is left out)
    sample: buildPayload(top.filter((t) => IDENTITY_TAGS.includes(t.id)).map((t) => [t.id, t.id === '01' ? '11' : t.value])),
  };
};

// Same merchant text as an approved record (case / spaces ignored)
const sameText = (a, b) => normalise(a) === normalise(b);

module.exports = {
  MAX_PAYLOAD,
  MAX_AMOUNT,
  MIN_AMOUNT,
  LankaQrError,
  crc16,
  parseTlv,
  parse,
  buildPayload,
  parseAmountText,
  normalise,
  sameText,
  sha256,
};
