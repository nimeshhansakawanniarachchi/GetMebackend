const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// =====================================================
// SUPPORT CASE PHOTOS (phase 43) - private, like supermarket bills
//
// Files live in src/uploads/support-cases (no static route serves that
// folder). A photo is only served through a signed link that expires:
//   /uploads/support-cases/<file>?exp=<unix s>&sig=<hmac>
// Links are signed only in answers to callers already allowed to see
// the case (the case's customer; staff with support access), so a
// guessed or old link gets 403. exp is rounded to a 6-hour window
// (same link for a while, so images stay cached; valid 6-12 hours).
// Secret: SUPPORT_PHOTO_URL_SECRET, else derived from JWT_SECRET.
// =====================================================

const STORAGE_DIR = path.resolve(__dirname, '..', 'uploads', 'support-cases');
const MAX_PHOTOS = 3;
const MAX_BYTES = 8 * 1024 * 1024;
const WINDOW_S = 6 * 60 * 60;
const URL_PREFIX = '/uploads/support-cases/';

const secret = () =>
  process.env.SUPPORT_PHOTO_URL_SECRET ||
  crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('getme-support-photos').digest('hex');

const signatureFor = (file, exp) =>
  crypto.createHmac('sha256', secret()).update(`${file}.${exp}`).digest('hex').slice(0, 32);

const currentExp = (now = Date.now()) => (Math.floor(now / 1000 / WINDOW_S) + 2) * WINDOW_S;

const signedUrl = (file, now) => {
  const exp = currentExp(now);
  return `${URL_PREFIX}${file}?exp=${exp}&sig=${signatureFor(file, exp)}`;
};

// Static route guard (app.js)
const requireSignedPhoto = (req, res, next) => {
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
    return res.status(403).json({ success: false, message: 'This photo link is not valid or has expired' });
  }

  res.set('Cache-Control', 'private, max-age=3600');
  return next();
};

// The file's real type from its first bytes (not the name / header)
const sniffImage = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
};

// Multipart: up to 3 'photos', kept in memory until checked
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: MAX_PHOTOS, fileSize: MAX_BYTES, fields: 20, fieldSize: 64 * 1024 },
});

// Express middleware: parses multipart bodies only (JSON passes through)
const acceptPhotos = (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  return upload.array('photos', MAX_PHOTOS)(req, res, (error) => {
    if (!error) return next();
    const message =
      error.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 8 MB'
        : error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE' ? `Add up to ${MAX_PHOTOS} photos`
          : 'The photos could not be read';
    return res.status(400).json({ success: false, code: 'INVALID_PHOTOS', message });
  });
};

// Checks the files; -> [{ buffer, mime, ext, size, sha256 }] or throws { status, message }
const checkPhotos = (files) => {
  const list = Array.isArray(files) ? files : [];
  if (list.length > MAX_PHOTOS) throw Object.assign(new Error(`Add up to ${MAX_PHOTOS} photos`), { status: 400 });
  return list.map((file) => {
    const mime = sniffImage(file.buffer || Buffer.alloc(0));
    if (!mime) throw Object.assign(new Error('Photos must be JPG, PNG or WEBP images'), { status: 415 });
    return {
      buffer: file.buffer,
      mime,
      ext: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime],
      size: file.buffer.length,
      sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    };
  });
};

// Writes checked photos for a case; -> file names written
const writePhotos = (caseId, photos) => {
  if (!photos.length) return [];
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  return photos.map((photo) => {
    const name = `case${caseId}-${crypto.randomBytes(12).toString('hex')}.${photo.ext}`;
    fs.writeFileSync(path.join(STORAGE_DIR, name), photo.buffer, { mode: 0o600 });
    return name;
  });
};

// Files written for a request that was rolled back
const removeFiles = (names) => {
  (names || []).forEach((name) => {
    try {
      fs.unlinkSync(path.join(STORAGE_DIR, path.basename(name)));
    } catch {
      // already gone
    }
  });
};

const toPhoto = (row) => ({
  id: Number(row.id),
  url: signedUrl(row.file_name),
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  createdAt: row.created_at,
});

module.exports = {
  STORAGE_DIR,
  MAX_PHOTOS,
  URL_PREFIX,
  signedUrl,
  requireSignedPhoto,
  acceptPhotos,
  checkPhotos,
  writePhotos,
  removeFiles,
  toPhoto,
};
