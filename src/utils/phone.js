// =====================================================
// SRI LANKAN PHONE NUMBERS
// Stored in E.164: +94XXXXXXXXX (9 digits after +94)
// Accepted input: 0771234567, 771234567, +94771234567,
// 94771234567, 0094771234567, with spaces / dashes / brackets.
// =====================================================

const digitsOnly = (value) =>
  String(value || '').replace(/[\s\-().]/g, '');

// Returns the 9 national digits (no leading 0) or null
const nationalDigits = (value) => {
  let digits = digitsOnly(value);

  if (digits.startsWith('+')) {
    digits = digits.slice(1);
  }

  if (!/^\d+$/.test(digits)) {
    return null;
  }

  if (digits.startsWith('0094')) {
    digits = digits.slice(4);
  } else if (digits.startsWith('94') && digits.length === 11) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === 10) {
    digits = digits.slice(1);
  }

  return digits.length === 9 ? digits : null;
};

// Mobile numbers start with 7 (070-078): customers and shoppers
const normalizeSriLankanMobile = (value) => {
  const digits = nationalDigits(value);

  return digits && /^7[0-8]\d{7}$/.test(digits) ? `+94${digits}` : null;
};

// Any Sri Lankan number incl. landlines (011, 034 ...): shops
const normalizeSriLankanPhone = (value) => {
  const digits = nationalDigits(value);

  return digits && /^[1-9]\d{8}$/.test(digits) ? `+94${digits}` : null;
};

// +94771234567 -> 077 123 4567, +94342261511 -> 034 226 1511
const formatSriLankanPhone = (value) => {
  const digits = nationalDigits(value);

  if (!digits) {
    return value || '';
  }

  return `0${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
};

const isEmail = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());

module.exports = {
  normalizeSriLankanMobile,
  normalizeSriLankanPhone,
  formatSriLankanPhone,
  isEmail,
};
