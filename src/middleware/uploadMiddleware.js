const multer = require('multer');
const path = require('path');
const fs = require('fs');

// =====================================================
// UPLOAD DIRECTORY
// =====================================================

const uploadDir = path.join(
  __dirname,
  '../uploads/items'
);

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, {
    recursive: true,
  });
}

// =====================================================
// STORAGE
// =====================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(
      file.originalname || ''
    );

    const baseName = path
      .basename(
        file.originalname || 'file',
        ext
      )
      .replace(
        /[^a-zA-Z0-9_-]/g,
        '_'
      );

    const uniqueName =
      `${baseName}-${Date.now()}-${Math.round(
        Math.random() * 1E9
      )}${ext}`;

    cb(null, uniqueName);
  },
});

// =====================================================
// FILE FILTER
// =====================================================

const fileFilter = (req, file, cb) => {
  const mimeType = (
    file.mimetype || ''
  ).toLowerCase();

  const ext = path
    .extname(
      file.originalname || ''
    )
    .toLowerCase();

  // ---------------------------------------------------
  // IMAGE TYPES
  // ---------------------------------------------------

  const imageTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
  ];

  const imageExtensions = [
    '.jpg',
    '.jpeg',
    '.png',
    '.webp',
  ];

  // ---------------------------------------------------
  // AUDIO TYPES
  // ---------------------------------------------------

  const audioTypes = [
    'audio/mpeg',
    'audio/mp3',
    'audio/mp4',
    'audio/m4a',
    'audio/x-m4a',
    'audio/wav',
    'audio/x-wav',
    'audio/aac',
    'audio/ogg',
    'audio/webm',

    // Expo / React Native can sometimes
    // send audio with this MIME type.
    'application/octet-stream',
  ];

  const audioExtensions = [
    '.mp3',
    '.m4a',
    '.wav',
    '.aac',
    '.ogg',
    '.webm',
  ];

  // ---------------------------------------------------
  // DEBUG LOG
  // ---------------------------------------------------

  console.log(
    '===================================='
  );

  console.log(
    '📁 UPLOAD FILE CHECK'
  );

  console.log(
    'FIELD:',
    file.fieldname
  );

  console.log(
    'NAME:',
    file.originalname
  );

  console.log(
    'MIME:',
    file.mimetype
  );

  console.log(
    'EXT:',
    ext
  );

  console.log(
    '===================================='
  );

  // ---------------------------------------------------
  // IMAGE
  //
  // Either MIME OR extension can identify
  // the file.
  // ---------------------------------------------------

  if (
    imageExtensions.includes(ext) ||
    imageTypes.includes(mimeType)
  ) {
    console.log(
      '✅ IMAGE FILE ACCEPTED'
    );

    return cb(null, true);
  }

  // ---------------------------------------------------
  // AUDIO
  //
  // Either MIME OR extension can identify
  // the file.
  // ---------------------------------------------------

  if (
    audioExtensions.includes(ext) ||
    audioTypes.includes(mimeType)
  ) {
    console.log(
      '✅ AUDIO FILE ACCEPTED'
    );

    return cb(null, true);
  }

  // ---------------------------------------------------
  // INVALID FILE
  // ---------------------------------------------------

  console.log(
    '❌ FILE REJECTED'
  );

  console.log(
    'MIME:',
    mimeType
  );

  console.log(
    'EXT:',
    ext
  );

  const error = new Error(
    'Only JPG, PNG, WEBP images and MP3, M4A, WAV, AAC, OGG, WEBM audio files are allowed'
  );

  error.code = 'INVALID_FILE_TYPE';

  return cb(error);
};

// =====================================================
// MULTER CONFIGURATION
// =====================================================

const upload = multer({
  storage,

  fileFilter,

  limits: {
    // Maximum 10 MB per file
    fileSize: 10 * 1024 * 1024,

    // Maximum 2 files
    // 1 image + 1 voice
    files: 2,
  },
});

// =====================================================
// EXPORT
// =====================================================

module.exports = upload;