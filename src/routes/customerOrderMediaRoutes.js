const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const authMiddleware =
  require('../middleware/authMiddleware');

const router = express.Router();


// =====================================================
// UPLOAD DIRECTORY
// =====================================================

const uploadDir = path.join(
  __dirname,
  '..',
  'uploads',
  'order-media'
);


// =====================================================
// CREATE DIRECTORY
// =====================================================

if (!fs.existsSync(uploadDir)) {

  fs.mkdirSync(
    uploadDir,
    {
      recursive: true,
    }
  );

  console.log(
    '📁 Created order media directory:',
    uploadDir
  );

}


// =====================================================
// MULTER STORAGE
// =====================================================

const storage =
  multer.diskStorage({

    destination: (
      req,
      file,
      cb
    ) => {

      cb(
        null,
        uploadDir
      );

    },


    filename: (
      req,
      file,
      cb
    ) => {

      const originalName =
        file.originalname || '';


      let extension =
        path.extname(
          originalName
        ).toLowerCase();


      // ===============================================
      // If extension is missing
      // ===============================================

      if (!extension) {

        if (
          file.mimetype ===
          'audio/mp4'
        ) {

          extension = '.m4a';

        }

        else if (
          file.mimetype ===
          'audio/m4a'
        ) {

          extension = '.m4a';

        }

        else if (
          file.mimetype ===
          'image/png'
        ) {

          extension = '.png';

        }

        else {

          extension = '.jpg';

        }

      }


      const filename =
        `order-media-${Date.now()}-${Math.round(
          Math.random() * 1000000000
        )}${extension}`;


      cb(
        null,
        filename
      );

    },

  });


// =====================================================
// FILE FILTER
// =====================================================

const fileFilter =
  (
    req,
    file,
    cb
  ) => {

    const mimeType =
      (
        file.mimetype ||
        ''
      ).toLowerCase();


    const originalName =
      (
        file.originalname ||
        ''
      ).toLowerCase();


    const extension =
      path.extname(
        originalName
      ).toLowerCase();


    console.log('');
    console.log(
      '📥 Incoming media file'
    );

    console.log(
      '📄 Name:',
      file.originalname
    );

    console.log(
      '📄 MIME:',
      file.mimetype
    );

    console.log(
      '📄 Extension:',
      extension
    );


    // =================================================
    // IMAGES
    // =================================================

    const imageMimeTypes = [

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


    if (
      imageMimeTypes.includes(
        mimeType
      ) ||

      imageExtensions.includes(
        extension
      )
    ) {

      cb(
        null,
        true
      );

      return;

    }


    // =================================================
    // AUDIO
    // =================================================

    const audioMimeTypes = [

      'audio/mp4',

      'audio/m4a',

      'audio/aac',

      'audio/mpeg',

      'audio/mp3',

      'audio/x-m4a',

      'audio/wav',

      'audio/x-wav',

      'audio/webm',

      'application/octet-stream',

      'text/plain',

      '',

    ];


    const audioExtensions = [

      '.m4a',

      '.mp4',

      '.aac',

      '.mp3',

      '.wav',

      '.webm',

    ];


    if (
      audioMimeTypes.includes(
        mimeType
      ) ||

      audioExtensions.includes(
        extension
      )
    ) {

      console.log(
        '🎤 Audio file accepted'
      );


      cb(
        null,
        true
      );

      return;

    }


    // =================================================
    // UNKNOWN FILE
    // =================================================

    console.log(
      '❌ Unsupported media type:',
      file.mimetype
    );


    cb(
      new Error(
        `Unsupported file type: ${file.mimetype}`
      )
    );

  };


// =====================================================
// MULTER
// =====================================================

const upload =
  multer({

    storage,

    fileFilter,

    limits: {

      files: 10,

      fileSize:
        20 * 1024 * 1024,

    },

  });


// =====================================================
// CUSTOMER ORDER MEDIA UPLOAD
// =====================================================
//
// POST
//
// /api/customer/orders/upload-media
//
// FormData field:
//
// files
//
// Response:
//
// imageUrl
// voiceUrl
// =====================================================

router.post(

  '/orders/upload-media',

  authMiddleware,

  upload.array(
    'files',
    10
  ),

  async (
    req,
    res
  ) => {

    try {

      console.log('');
      console.log(
        '=========================================='
      );

      console.log(
        '📥 CUSTOMER ORDER MEDIA UPLOAD'
      );

      console.log(
        '=========================================='
      );


      // =================================================
      // CHECK FILES
      // =================================================

      if (
        !req.files ||
        req.files.length === 0
      ) {

        console.log(
          '❌ No files received'
        );


        return res
          .status(400)
          .json({

            success: false,

            message:
              'No media files uploaded',

          });

      }


      console.log(
        '📦 Files received:',
        req.files.length
      );


      let imageUrl = null;

      let voiceUrl = null;


      // =================================================
      // PROCESS EACH FILE
      // =================================================

      for (
        const file of req.files
      ) {

        const originalName =
          (
            file.originalname ||
            ''
          ).toLowerCase();


        const extension =
          path.extname(
            originalName
          ).toLowerCase();


        const mimeType =
          (
            file.mimetype ||
            ''
          ).toLowerCase();


        const fileUrl =
          `/uploads/order-media/${file.filename}`;


        console.log('');

        console.log(
          '📄 Original:',
          file.originalname
        );

        console.log(
          '📄 MIME:',
          file.mimetype
        );

        console.log(
          '📄 Extension:',
          extension
        );

        console.log(
          '📄 Saved:',
          file.filename
        );


        // =============================================
        // IMAGE
        // =============================================

        const isImage =
          mimeType.startsWith(
            'image/'
          ) ||

          [
            '.jpg',
            '.jpeg',
            '.png',
            '.webp',
          ].includes(
            extension
          );


        // =============================================
        // AUDIO
        // =============================================

        const isAudio =
          mimeType.startsWith(
            'audio/'
          ) ||

          [
            '.m4a',
            '.mp4',
            '.aac',
            '.mp3',
            '.wav',
            '.webm',
          ].includes(
            extension
          ) ||

          mimeType ===
            'text/plain';


        // =============================================
        // SET URL
        // =============================================

        if (isImage) {

          imageUrl =
            fileUrl;

        }

        else if (isAudio) {

          voiceUrl =
            fileUrl;

        }

      }


      // =================================================
      // RESULT
      // =================================================

      console.log('');

      console.log(
        '🖼️ IMAGE URL:',
        imageUrl
      );

      console.log(
        '🎤 VOICE URL:',
        voiceUrl
      );

      console.log(
        '=========================================='
      );

      console.log('');


      // =================================================
      // RESPONSE
      // =================================================

      return res
        .status(200)
        .json({

          success: true,

          message:
            'Media uploaded successfully',

          imageUrl,

          voiceUrl,

        });

    }

    catch (error) {

      console.error(
        '❌ CUSTOMER MEDIA UPLOAD ERROR:',
        error
      );


      return res
        .status(500)
        .json({

          success: false,

          message:
            'Failed to upload order media',

          error:
            error.message,

        });

    }

  }

);


// =====================================================
// MULTER ERROR HANDLER
// =====================================================

router.use(
  (
    error,
    req,
    res,
    next
  ) => {

    if (
      error instanceof
      multer.MulterError
    ) {

      console.error(
        '❌ MULTER ERROR:',
        error
      );


      return res
        .status(400)
        .json({

          success: false,

          message:
            error.message,

        });

    }


    if (error) {

      console.error(
        '❌ MEDIA UPLOAD ERROR:',
        error
      );


      return res
        .status(400)
        .json({

          success: false,

          message:
            error.message,

        });

    }


    next();

  }
);


// =====================================================
// EXPORT
// =====================================================

module.exports =
  router;