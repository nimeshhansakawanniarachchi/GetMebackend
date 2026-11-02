// =====================================================
// VERIFIED UPLOADS (security review 2026-10-30, B-02)
// A drop-in for require('multer'): the same API, but after multer has
// stored the file(s), each one is checked by its first bytes (not its
// name or the type the client claimed). Anything that is not a known
// image, audio or PDF format is deleted and the request gets 400, so
// an HTML / SVG / script file can never end up in a public folder.
// A real file saved under the wrong extension is renamed to match its
// content (req.file.filename / path are updated for the controller).
// Each route's own fileFilter still decides which kinds it accepts.
// =====================================================

const fs = require('fs');
const path = require('path');
const multer = require('multer');

const HEIF_BRANDS = /^(heic|heix|hevc|hevx|mif1|msf1|heif)/;

// First bytes -> { mime, ext } or null
const sniff = (b) => {
  if (!b || b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF') {
    const kind = b.subarray(8, 12).toString('latin1');
    if (kind === 'WEBP') return { mime: 'image/webp', ext: '.webp' };
    if (kind === 'WAVE') return { mime: 'audio/wav', ext: '.wav' };
    return null;
  }
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    if (HEIF_BRANDS.test(brand)) return { mime: 'image/heic', ext: '.heic' };
    // M4A / MP4 / 3GP containers (voice notes from iOS and Android)
    return { mime: 'audio/mp4', ext: '.m4a' };
  }
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  if (b.subarray(0, 4).toString('latin1') === 'OggS') return { mime: 'audio/ogg', ext: '.ogg' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'audio/webm', ext: '.webm' };
  if (b.subarray(0, 3).toString('latin1') === 'ID3') return { mime: 'audio/mpeg', ext: '.mp3' };
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { mime: 'audio/aac', ext: '.aac' };
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { mime: 'audio/mpeg', ext: '.mp3' };
  return null;
};

const readHead = async (file) => {
  if (file.buffer) return file.buffer.subarray(0, 64);
  if (!file.path) return null;
  const handle = await fs.promises.open(file.path, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, 64, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const uploadedFiles = (req) => {
  const list = [];
  if (req.file) list.push(req.file);
  if (Array.isArray(req.files)) list.push(...req.files);
  else if (req.files && typeof req.files === 'object') Object.values(req.files).forEach((group) => list.push(...group));
  return list;
};

const removeAll = async (files) => {
  await Promise.all(files.filter((f) => f.path).map((f) => fs.promises.unlink(f.path).catch(() => {})));
};

// Only files written to disk: in-memory uploads (ID documents, support
// photos) are checked by their own modules, which answer with their own
// codes, and are never served from a public folder
const verifyFiles = async (req) => {
  const files = uploadedFiles(req).filter((file) => file.path);
  for (const file of files) {
    const info = sniff(await readHead(file));
    if (!info) {
      await removeAll(files);
      return false;
    }
    file.detectedMime = info.mime;
    // Disk file under a misleading extension: name it after its content
    if (file.path && path.extname(file.filename || '').toLowerCase() !== info.ext &&
        !(info.ext === '.jpg' && /\.jpe?g$/i.test(file.filename || ''))) {
      const filename = `${path.basename(file.filename, path.extname(file.filename))}${info.ext}`;
      const target = path.join(path.dirname(file.path), filename);
      await fs.promises.rename(file.path, target);
      file.filename = filename;
      file.path = target;
    }
  }
  return true;
};

const REFUSED = {
  success: false,
  code: 'FILE_TYPE_NOT_ALLOWED',
  message: 'This file type is not allowed. Upload a JPG, PNG or WEBP photo, or a voice note.',
};

const verifiedMulter = (options) => {
  const instance = multer(options);
  ['single', 'array', 'fields', 'any'].forEach((method) => {
    const original = instance[method].bind(instance);
    instance[method] = (...args) => {
      const middleware = original(...args);
      return (req, res, next) =>
        middleware(req, res, (error) => {
          if (error) return next(error);
          verifyFiles(req)
            .then((ok) => (ok ? next() : res.status(400).json(REFUSED)))
            .catch(next);
          return undefined;
        });
    };
  });
  return instance;
};

// multer.diskStorage, memoryStorage, MulterError ... stay available
Object.assign(verifiedMulter, multer);
verifiedMulter.sniff = sniff;

module.exports = verifiedMulter;
