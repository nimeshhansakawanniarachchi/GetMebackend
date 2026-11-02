// =====================================================
// COMPANY BANK ACCOUNTS - catalogue + input validation (phase 50)
// Banks: the Sri Lankan bank list shoppers already choose from
// (wallet/shopperWallet.js BANKS), with a stable key per bank; 'other'
// takes a free-text name (e.g. a foreign bank for a future
// international account). Nothing here says anything about a bank's
// APIs: integrations are tracked separately (integration.js).
// =====================================================

const { BANKS } = require('../wallet/shopperWallet');

const slug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

const BANK_CATALOGUE = BANKS.filter((name) => name !== 'Other').map((name) => ({ key: slug(name), name, country: 'LK' }));
const BANK_BY_KEY = Object.fromEntries(BANK_CATALOGUE.map((bank) => [bank.key, bank]));

const PURPOSES = [
  { key: 'supermarket_payments', label: 'Supermarket payments', hint: 'Pays supermarkets for orders (e.g. LankaQR when a bank integration exists)' },
  { key: 'customer_settlements', label: 'Customer settlements', hint: 'Receives customer payments settled to GetMe' },
  { key: 'shopper_payouts', label: 'Shopper payouts', hint: 'Pays shopper withdrawals (bank transfers done by Finance)' },
  { key: 'gateway_settlements', label: 'Payment gateway settlements', hint: 'Where a payment gateway settles card payments (set at the gateway, recorded here)' },
  { key: 'operational_expenses', label: 'Operational expenses', hint: 'Running costs' },
];
const PURPOSE_KEYS = PURPOSES.map((p) => p.key);
const PURPOSE_LABELS = Object.fromEntries(PURPOSES.map((p) => [p.key, p.label]));

// Offered in the admin form; any ISO-4217 / ISO-3166 code is accepted
const COMMON_CURRENCIES = ['LKR', 'USD', 'EUR', 'GBP', 'AUD', 'SGD', 'INR', 'AED', 'JPY'];
const COMMON_COUNTRIES = [
  ['LK', 'Sri Lanka'],
  ['IN', 'India'],
  ['SG', 'Singapore'],
  ['AE', 'United Arab Emirates'],
  ['GB', 'United Kingdom'],
  ['US', 'United States'],
  ['AU', 'Australia'],
];

const error = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Digits for a Sri Lankan account (6-20); letters + digits (IBAN-like,
// 5-34) for other countries. Spaces and dashes are ignored.
const normaliseNumber = (value, country) => {
  const raw = String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (country === 'LK') {
    if (!/^\d{6,20}$/.test(raw)) throw error(400, 'A Sri Lankan account number is 6 to 20 digits', 'INVALID_ACCOUNT_NUMBER', { field: 'accountNumber' });
  } else if (!/^[A-Z0-9]{5,34}$/.test(raw)) {
    throw error(400, 'The account number should be 5 to 34 letters or digits', 'INVALID_ACCOUNT_NUMBER', { field: 'accountNumber' });
  }
  return raw;
};

const parseCountry = (value) => {
  const country = String(value ?? 'LK').trim().toUpperCase() || 'LK';
  if (!/^[A-Z]{2}$/.test(country)) throw error(400, 'Country must be a 2-letter ISO code (e.g. LK)', 'INVALID_COUNTRY', { field: 'country' });
  return country;
};

const parseCurrency = (value) => {
  const currency = String(value ?? 'LKR').trim().toUpperCase() || 'LKR';
  if (!/^[A-Z]{3}$/.test(currency)) throw error(400, 'Currency must be a 3-letter ISO code (e.g. LKR)', 'INVALID_CURRENCY', { field: 'currency' });
  return currency;
};

const parsePurposes = (value) => {
  if (!Array.isArray(value)) throw error(400, 'Choose what the account is used for', 'INVALID_PURPOSES', { field: 'purposes' });
  const list = [...new Set(value.map((v) => String(v)))];
  const bad = list.filter((p) => !PURPOSE_KEYS.includes(p));
  if (bad.length) throw error(400, `Unknown purpose: ${clean(bad[0], 40)}`, 'INVALID_PURPOSES', { field: 'purposes' });
  if (!list.length) throw error(400, 'Choose at least one purpose', 'INVALID_PURPOSES', { field: 'purposes' });
  return PURPOSE_KEYS.filter((p) => list.includes(p));
};

const parseBank = (bankKey, otherName) => {
  const key = String(bankKey ?? '').trim();
  if (key === 'other') {
    const name = clean(otherName, 80);
    if (name.length < 3) throw error(400, 'Enter the name of the bank', 'INVALID_BANK', { field: 'bankName' });
    return { bankKey: 'other', bankName: name };
  }
  const bank = BANK_BY_KEY[key];
  if (!bank) throw error(400, 'Choose the bank', 'INVALID_BANK', { field: 'bankKey' });
  return { bankKey: bank.key, bankName: bank.name };
};

const parseNickname = (value) => {
  const name = clean(value, 60);
  if (name.length < 3) throw error(400, 'Give the account a short name (at least 3 characters)', 'INVALID_NICKNAME', { field: 'nickname' });
  return name;
};

const parseHolder = (value) => {
  const holder = clean(value, 120);
  if (holder.length < 3) throw error(400, 'Enter the account holder name', 'INVALID_HOLDER', { field: 'accountHolderName' });
  return holder;
};

const parseBranch = (value, { required }) => {
  const branch = clean(value, 80);
  if (required && branch.length < 2) throw error(400, 'Enter the branch', 'INVALID_BRANCH', { field: 'branchName' });
  return branch || null;
};

const parseBranchCode = (value) => {
  const code = clean(value, 12).toUpperCase();
  if (!code) return null;
  if (!/^[A-Z0-9-]{1,12}$/.test(code)) throw error(400, 'The branch code is letters, digits or dashes (up to 12)', 'INVALID_BRANCH_CODE', { field: 'branchCode' });
  return code;
};

module.exports = {
  BANK_CATALOGUE,
  BANK_BY_KEY,
  PURPOSES,
  PURPOSE_KEYS,
  PURPOSE_LABELS,
  COMMON_CURRENCIES,
  COMMON_COUNTRIES,
  error,
  clean,
  normaliseNumber,
  parseCountry,
  parseCurrency,
  parsePurposes,
  parseBank,
  parseNickname,
  parseHolder,
  parseBranch,
  parseBranchCode,
};
