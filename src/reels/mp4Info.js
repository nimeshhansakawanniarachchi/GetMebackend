// =====================================================
// PHASE 62: READ AN MP4 / MOV FILE'S BASIC FACTS ON THE SERVER
// (no ffmpeg on the server). Walks the ISO-BMFF box tree:
//   ftyp            -> it really is an MP4 / QuickTime file
//   moov/mvhd       -> duration (timescale units)
//   moov/trak/tkhd  -> display width / height + rotation matrix
//   .../mdia/hdlr   -> 'vide' = the video track
//   .../stsd        -> codec (avc1 / hvc1 / hev1 / mp4v ...)
// Only box headers and the moov box are read (moov is small, even when
// it sits after a large mdat).
// =====================================================

const fs = require('fs');

const MAX_MOOV_BYTES = 32 * 1024 * 1024;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);

const readAt = async (handle, position, length) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
};

// Top-level boxes: [{ type, start, size, headerSize }]
const topBoxes = async (handle, fileSize) => {
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= fileSize && boxes.length < 200) {
    const head = await readAt(handle, offset, 16);
    if (head.length < 8) break;
    let size = head.readUInt32BE(0);
    const type = head.subarray(4, 8).toString('latin1');
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = Number(head.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - offset;
    }
    if (size < headerSize) break;
    boxes.push({ type, start: offset, size, headerSize });
    offset += size;
  }
  return boxes;
};

// Children of a box held in memory
const childBoxes = (buffer, start, end) => {
  const out = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1');
    let headerSize = 8;
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;
    out.push({ type, start: offset, size, headerSize, body: offset + headerSize, end: offset + size });
    offset += size;
  }
  return out;
};

const fixed16 = (value) => value / 65536;

const parseMvhd = (buf, box) => {
  const version = buf[box.body];
  if (version === 1) {
    const timescale = buf.readUInt32BE(box.body + 20);
    const duration = Number(buf.readBigUInt64BE(box.body + 24));
    return timescale ? duration / timescale : null;
  }
  const timescale = buf.readUInt32BE(box.body + 12);
  const duration = buf.readUInt32BE(box.body + 16);
  return timescale ? duration / timescale : null;
};

const parseTkhd = (buf, box) => {
  const version = buf[box.body];
  // header: version(1) flags(3) + times + track id + reserved + duration
  const afterDuration = box.body + (version === 1 ? 4 + 8 + 8 + 4 + 4 + 8 : 4 + 4 + 4 + 4 + 4 + 4);
  // reserved(8) layer(2) alt(2) volume(2) reserved(2) matrix(36) width(4) height(4)
  const matrixAt = afterDuration + 16;
  const a = buf.readInt32BE(matrixAt);
  const b = buf.readInt32BE(matrixAt + 4);
  const width = fixed16(buf.readUInt32BE(matrixAt + 36));
  const height = fixed16(buf.readUInt32BE(matrixAt + 40));
  // a = cos, b = sin (16.16): 90 / 270 degree turns swap the sides
  const rotated = a === 0 && Math.abs(b) === 65536;
  return { width: Math.round(width), height: Math.round(height), rotated };
};

const findPath = (buf, parent, path) => {
  let node = parent;
  for (const type of path) {
    node = childBoxes(buf, node.body, node.end).find((c) => c.type === type);
    if (!node) return null;
  }
  return node;
};

// -> { container: 'mp4'|'mov', durationSeconds, width, height, codec } or throws Error(code)
const readMp4Info = async (filePath) => {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const boxes = await topBoxes(handle, fileSize);
    const ftyp = boxes[0];
    if (!ftyp || ftyp.type !== 'ftyp') throw Object.assign(new Error('NOT_MP4'), { code: 'NOT_MP4' });
    const brand = (await readAt(handle, ftyp.start + 8, 4)).toString('latin1');
    if (/^(heic|heix|hevc|hevx|mif1|msf1|heif|M4A |M4B )/.test(brand)) {
      throw Object.assign(new Error('NOT_VIDEO'), { code: 'NOT_VIDEO' });
    }
    const moov = boxes.find((b) => b.type === 'moov');
    if (!moov) throw Object.assign(new Error('NO_MOOV'), { code: 'NO_MOOV' });
    if (moov.size > MAX_MOOV_BYTES) throw Object.assign(new Error('MOOV_TOO_BIG'), { code: 'MOOV_TOO_BIG' });

    const buf = await readAt(handle, moov.start, moov.size);
    const root = { body: moov.headerSize, end: buf.length };
    const mvhd = childBoxes(buf, root.body, root.end).find((c) => c.type === 'mvhd');
    const durationSeconds = mvhd ? parseMvhd(buf, mvhd) : null;

    let video = null;
    for (const trak of childBoxes(buf, root.body, root.end).filter((c) => c.type === 'trak')) {
      const hdlr = findPath(buf, trak, ['mdia', 'hdlr']);
      const handler = hdlr ? buf.subarray(hdlr.body + 8, hdlr.body + 12).toString('latin1') : null;
      if (handler !== 'vide') continue;
      const tkhd = childBoxes(buf, trak.body, trak.end).find((c) => c.type === 'tkhd');
      const stsd = findPath(buf, trak, ['mdia', 'minf', 'stbl', 'stsd']);
      // stsd: version/flags(4) count(4) then the first sample entry (size + type)
      const codec = stsd ? buf.subarray(stsd.body + 12, stsd.body + 16).toString('latin1').trim() : null;
      const dims = tkhd ? parseTkhd(buf, tkhd) : { width: 0, height: 0, rotated: false };
      video = {
        codec,
        width: dims.rotated ? dims.height : dims.width,
        height: dims.rotated ? dims.width : dims.height,
      };
      break;
    }
    if (!video) throw Object.assign(new Error('NO_VIDEO_TRACK'), { code: 'NO_VIDEO_TRACK' });

    return {
      container: /^qt/.test(brand) ? 'mov' : 'mp4',
      brand: brand.trim(),
      durationSeconds: durationSeconds != null ? Math.round(durationSeconds * 100) / 100 : null,
      width: video.width,
      height: video.height,
      codec: video.codec,
      bytes: fileSize,
    };
  } finally {
    await handle.close();
  }
};

module.exports = { readMp4Info, CONTAINERS };
