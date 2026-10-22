// =====================================================
// PRODUCT BARCODES
// Retail codes (EAN-13, EAN-8, UPC-A, UPC-E) carry a check
// digit; shorter / other codes are PLUs or in-store labels.
// =====================================================

const clean = (value) => String(value ?? '').replace(/\s+/g, '');

// Leading zeros differ between the UPC-A and EAN-13 forms of one
// code; same rule as the ShopperApp scan check
const barcodeKey = (value) => clean(value).replace(/^0+/, '');

// GS1 check digit: weights 3,1,3,... from the right (excluding the check digit)
const hasValidCheckDigit = (digits) => {
  const body = digits.slice(0, -1);
  let sum = 0;

  for (let i = 0; i < body.length; i += 1) {
    const digit = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? digit * 3 : digit;
  }

  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
};

// UPC-E (8 digits, number system 0/1) -> its 12-digit UPC-A form
const expandUpcE = (code) => {
  const [system, d1, d2, d3, d4, d5, d6, check] = code;
  let middle;

  if ('012'.includes(d6)) middle = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
  else if (d6 === '3') middle = `${d1}${d2}${d3}00000${d4}${d5}`;
  else if (d6 === '4') middle = `${d1}${d2}${d3}${d4}00000${d5}`;
  else middle = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;

  return `${system}${middle}${check}`;
};

/**
 * 'EAN13' | 'UPCA' | 'EAN8' | 'UPCE' for a valid retail code,
 * 'OTHER' for PLUs / in-store codes, null for an 8/12/13-digit
 * number whose check digit is wrong.
 */
const barcodeFormat = (value) => {
  const code = clean(value);

  if (!/^\d+$/.test(code) || ![8, 12, 13].includes(code.length)) {
    return 'OTHER';
  }

  if (code.length === 13) return hasValidCheckDigit(code) ? 'EAN13' : null;
  if (code.length === 12) return hasValidCheckDigit(code) ? 'UPCA' : null;
  if (hasValidCheckDigit(code)) return 'EAN8';
  if ('01'.includes(code[0]) && hasValidCheckDigit(expandUpcE(code))) return 'UPCE';

  return null;
};

// Manufacturer codes are shared across shops. EAN-13 prefixes 20-29
// (and UPC-A number system 2) are in-store codes, e.g. weighed items,
// so they stay with the shop that printed them.
const isManufacturerBarcode = (value) => {
  const code = clean(value);
  const format = barcodeFormat(code);

  if (!format || format === 'OTHER') return false;
  if (format === 'EAN13' && code[0] === '2') return false;
  if (format === 'UPCA' && code[0] === '2') return false;

  return barcodeKey(code) !== '';
};

module.exports = {
  barcodeKey,
  barcodeFormat,
  isManufacturerBarcode,
};
