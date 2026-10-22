// =====================================================
// SHOP BRAND COLOR
// "#rgb" / "#rrggbb" -> "#RRGGBB". White text sits on it in
// the customer app, so it must keep at least 3:1 contrast
// with white (WCAG AA for large/bold text).
// =====================================================

const MIN_WHITE_CONTRAST = 3;

const normalizeBrandColor = (value) => {
  const text = String(value ?? '').trim().toUpperCase();
  const short = /^#?([0-9A-F])([0-9A-F])([0-9A-F])$/.exec(text);

  if (short) {
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  }

  const full = /^#?([0-9A-F]{6})$/.exec(text);

  return full ? `#${full[1]}` : null;
};

const channel = (hex) => {
  const c = parseInt(hex, 16) / 255;

  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// Contrast ratio of white text on a "#RRGGBB" background
const whiteContrast = (color) => {
  const luminance =
    0.2126 * channel(color.slice(1, 3)) +
    0.7152 * channel(color.slice(3, 5)) +
    0.0722 * channel(color.slice(5, 7));

  return 1.05 / (luminance + 0.05);
};

module.exports = {
  MIN_WHITE_CONTRAST,
  normalizeBrandColor,
  whiteContrast,
};
