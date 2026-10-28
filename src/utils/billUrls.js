const crypto = require('crypto');

// =====================================================
// SIGNED BILL PHOTO LINKS
// Supermarket bill photos (uploads/bills) are not public: a file is
// only served with a valid signature that hasn't expired
// (/uploads/bills/<file>?exp=<unix s>&sig=<hmac>). API responses sign
// every bill link they contain (signBillLinksInJson, app.js), and
// only routes that already checked the caller may see that order
// (customer / shopper / shop / admin) return bill links - so a
// guessed or old link gets 403.
// exp is rounded to a 6-hour window, so the same link is returned
// for a while (images stay cached) and works for 6-12 hours.
// Secret: BILL_URL_SECRET, else derived from JWT_SECRET.
// =====================================================

const WINDOW_S = 6 * 60 * 60;

const BILL_PATH = /\/uploads\/bills\/([A-Za-z0-9._-]+)(?=")/g;

const secret = () =>
  process.env.BILL_URL_SECRET ||
  crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('getme-bill-urls').digest('hex');

const signatureFor = (file, exp) =>
  crypto.createHmac('sha256', secret()).update(`${file}.${exp}`).digest('hex').slice(0, 32);

const currentExp = (now = Date.now()) => (Math.floor(now / 1000 / WINDOW_S) + 2) * WINDOW_S;

// "/uploads/bills/a.jpg" -> "/uploads/bills/a.jpg?exp=..&sig=.."
const signBillPath = (file, now) => {
  const exp = currentExp(now);
  return `/uploads/bills/${file}?exp=${exp}&sig=${signatureFor(file, exp)}`;
};

// A JSON text with every unsigned bill link signed
const signBillLinksInText = (text, now) =>
  typeof text === 'string' && text.includes('/uploads/bills/')
    ? text.replace(BILL_PATH, (match, file) => signBillPath(file, now))
    : text;

// Any value (socket payloads): same, through JSON
const signBillLinks = (value) => {
  if (value == null || typeof value !== 'object') {
    return value;
  }

  const text = JSON.stringify(value);
  const signed = signBillLinksInText(text);

  return signed === text ? value : JSON.parse(signed);
};

// Express middleware: res.json signs bill links in its body
const signBillLinksInJson = (req, res, next) => {
  const json = res.json.bind(res);

  res.json = (body) => {
    if (body === undefined || body === null || typeof body !== 'object') {
      return json(body);
    }

    const text = JSON.stringify(body);

    if (!text.includes('/uploads/bills/')) {
      return json(body);
    }

    if (!res.get('Content-Type')) {
      res.set('Content-Type', 'application/json; charset=utf-8');
    }

    return res.send(signBillLinksInText(text));
  };

  next();
};

// Static route guard for /uploads/bills
const requireSignedBill = (req, res, next) => {
  const file = decodeURIComponent(String(req.path || '').replace(/^\/+/, ''));
  const exp = Number(req.query.exp);
  const sig = String(req.query.sig || '');

  const valid =
    /^[A-Za-z0-9._-]+$/.test(file) &&
    Number.isInteger(exp) &&
    exp * 1000 > Date.now() &&
    sig.length === 32 &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(signatureFor(file, exp)));

  if (!valid) {
    return res.status(403).json({ success: false, message: 'This bill link is not valid or has expired' });
  }

  // Private: never cached by shared proxies
  res.set('Cache-Control', 'private, max-age=3600');

  return next();
};

module.exports = {
  signBillPath,
  signBillLinks,
  signBillLinksInText,
  signBillLinksInJson,
  requireSignedBill,
};
