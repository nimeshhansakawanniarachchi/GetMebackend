const crypto = require('crypto');

// =====================================================
// SIGNED PRIVATE MEDIA LINKS
// Supermarket bill photos (uploads/bills) and - since the security
// review of 2026-10-30 (B-03) - every other private order file:
//   /uploads/order-media   customer voice notes / photos
//   /uploads/deliveries    the shopper's photo at the door
//   /uploads/replacements  replacement item photos
//   /uploads/items, /items item photos
//   /uploads/shoppers      shopper profile photos
// A file is only served with a valid signature that hasn't expired
// (/uploads/<folder>/<file>?exp=<unix s>&sig=<hmac>). API responses
// (signBillLinksInJson, app.js) and Socket.IO payloads (bin/www) sign
// every link they contain, and only routes that already checked the
// caller may see that order return those links - so a guessed or old
// link gets 403. Product and shop images stay public.
// Only a link that is a whole JSON value is signed (B-09): a path
// typed inside a chat message or note is left as text.
// exp is rounded to a 6-hour window, so the same link is returned
// for a while (images stay cached) and works for 6-12 hours.
// Secret: BILL_URL_SECRET, else derived from JWT_SECRET.
// =====================================================

const WINDOW_S = 6 * 60 * 60;

const PRIVATE_FOLDERS = ['bills', 'order-media', 'deliveries', 'replacements', 'items', 'shoppers', 'fuel-receipts'];

// "<origin?>/uploads/<folder>/<file>" or the old "/items/<file>", as a
// whole JSON string value (opening and closing quote)
const PRIVATE_PATH = new RegExp(
  `"((?:https?://[^"\\s/]+)?)/(?:uploads/(${PRIVATE_FOLDERS.join('|')})|(items))/([A-Za-z0-9._-]+)"`,
  'g'
);

const secret = () =>
  process.env.BILL_URL_SECRET ||
  crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('getme-bill-urls').digest('hex');

// Bills keep their original signature input (links already handed out stay valid)
const signatureFor = (file, exp, folder = 'bills') =>
  crypto
    .createHmac('sha256', secret())
    .update(folder === 'bills' ? `${file}.${exp}` : `${folder}/${file}.${exp}`)
    .digest('hex')
    .slice(0, 32);

const currentExp = (now = Date.now()) => (Math.floor(now / 1000 / WINDOW_S) + 2) * WINDOW_S;

const signedQuery = (folder, file, now) => {
  const exp = currentExp(now);
  return `exp=${exp}&sig=${signatureFor(file, exp, folder)}`;
};

// "/uploads/bills/a.jpg" -> "/uploads/bills/a.jpg?exp=..&sig=.."
const signBillPath = (file, now) => `/uploads/bills/${file}?${signedQuery('bills', file, now)}`;

const mightHaveLinks = (text) =>
  typeof text === 'string' && (text.includes('/uploads/') || text.includes('/items/'));

// A JSON text with every unsigned private link signed
const signBillLinksInText = (text, now) =>
  mightHaveLinks(text)
    ? text.replace(PRIVATE_PATH, (match, origin, folder, legacyItems, file) => {
        const key = folder || 'items';
        const prefix = folder ? `/uploads/${folder}` : '/items';
        return `"${origin}${prefix}/${file}?${signedQuery(key, file, now)}"`;
      })
    : text;

// Any value (socket payloads): same, through JSON
const signBillLinks = (value) => {
  if (value == null || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof ArrayBuffer) {
    return value;
  }

  const text = JSON.stringify(value);
  if (!mightHaveLinks(text)) return value;
  const signed = signBillLinksInText(text);

  return signed === text ? value : JSON.parse(signed);
};

// Express middleware: res.json signs private links in its body
const signBillLinksInJson = (req, res, next) => {
  const json = res.json.bind(res);

  res.json = (body) => {
    if (body === undefined || body === null || typeof body !== 'object') {
      return json(body);
    }

    const text = JSON.stringify(body);

    if (!mightHaveLinks(text)) {
      return json(body);
    }

    if (!res.get('Content-Type')) {
      res.set('Content-Type', 'application/json; charset=utf-8');
    }

    return res.send(signBillLinksInText(text));
  };

  next();
};

// Static route guard for one private folder
const requireSignedMedia = (folder) => (req, res, next) => {
  const file = decodeURIComponent(String(req.path || '').replace(/^\/+/, ''));
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig || '');

  const valid =
    /^[A-Za-z0-9._-]+$/.test(file) &&
    Number.isInteger(exp) &&
    exp * 1000 > Date.now() &&
    sig.length === 32 &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(signatureFor(file, exp, folder)));

  if (!valid) {
    return res.status(403).json({ success: false, message: 'This link is not valid or has expired' });
  }

  // Private: never cached by shared proxies
  res.set('Cache-Control', 'private, max-age=3600');

  return next();
};

const requireSignedBill = requireSignedMedia('bills');

module.exports = {
  PRIVATE_FOLDERS,
  signBillPath,
  signBillLinks,
  signBillLinksInText,
  signBillLinksInJson,
  requireSignedBill,
  requireSignedMedia,
};
