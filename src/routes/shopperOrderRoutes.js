// const express = require('express');

// const router = express.Router();

// const {
//   getAvailableOrders,
//   acceptOrder,
// } = require('../controllers/shopperOrderController');

// const shopperAuthMiddleware =
//   require('../middleware/shopperAuthMiddleware');


// // ==================================================
// // GET AVAILABLE ORDERS
// // ==================================================

// router.get(
//   '/orders',
//   shopperAuthMiddleware,
//   getAvailableOrders
// );


// // ==================================================
// // ACCEPT ORDER
// // ==================================================

// router.patch(
//   '/orders/:orderId/accept',
//   shopperAuthMiddleware,
//   acceptOrder
// );


// module.exports = router;






// const express = require('express');
// const jwt = require('jsonwebtoken');

// const router = express.Router();

// const {
//   getAvailableOrders,
//   acceptOrder,
// } = require('../controllers/shopperOrderController');


// // ==================================================
// // SHOPPER AUTH MIDDLEWARE
// // ==================================================

// const shopperAuthMiddleware = (req, res, next) => {

//   try {

//     const authHeader =
//       req.headers.authorization;


//     if (
//       !authHeader ||
//       !authHeader.startsWith('Bearer ')
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Authentication required',

//       });

//     }


//     const token =
//       authHeader.split(' ')[1];


//     const decoded =
//       jwt.verify(
//         token,
//         process.env.JWT_SECRET
//       );


//     if (!decoded.shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid shopper token',

//       });

//     }


//     req.shopper = decoded;


//     next();

//   } catch (error) {

//     console.error(
//       '❌ SHOPPER AUTH ERROR:',
//       error.message
//     );

//     return res.status(401).json({

//       success: false,

//       message:
//         'Invalid or expired shopper token',

//     });

//   }

// };


// // ==================================================
// // GET AVAILABLE ORDERS
// // ==================================================

// router.get(
//   '/orders',
//   shopperAuthMiddleware,
//   getAvailableOrders
// );


// // ==================================================
// // ACCEPT ORDER
// // ==================================================

// router.patch(
//   '/orders/:orderId/accept',
//   shopperAuthMiddleware,
//   acceptOrder
// );


// module.exports = router;






// const express = require('express');
// const jwt = require('jsonwebtoken');
// const multer = require('multer');
// const path = require('path');
// const fs = require('fs');

// const router = express.Router();

// const {
//   getAvailableOrders,
//   acceptOrder,
//   uploadItemPhoto,
// } = require('../controllers/shopperOrderController');


// // ==================================================
// // SHOPPER AUTH MIDDLEWARE
// // ==================================================

// const shopperAuthMiddleware = (req, res, next) => {

//   try {

//     const authHeader =
//       req.headers.authorization;


//     if (
//       !authHeader ||
//       !authHeader.startsWith('Bearer ')
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Authentication required',

//       });

//     }


//     const token =
//       authHeader.split(' ')[1];


//     const decoded =
//       jwt.verify(
//         token,
//         process.env.JWT_SECRET
//       );


//     if (!decoded.shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid shopper token',

//       });

//     }


//     req.shopper = decoded;


//     next();

//   } catch (error) {

//     console.error(
//       '❌ SHOPPER AUTH ERROR:',
//       error.message
//     );

//     return res.status(401).json({

//       success: false,

//       message:
//         'Invalid or expired shopper token',

//     });

//   }

// };


// // ==================================================
// // ITEM PHOTO UPLOAD FOLDER
// // ==================================================

// const uploadDir =
//   path.join(
//     __dirname,
//     '..',
//     'uploads',
//     'items'
//   );


// fs.mkdirSync(
//   uploadDir,
//   {
//     recursive: true,
//   }
// );


// // ==================================================
// // MULTER STORAGE
// // ==================================================

// const storage =
//   multer.diskStorage({

//     destination: (
//       req,
//       file,
//       cb
//     ) => {

//       cb(
//         null,
//         uploadDir
//       );

//     },


//     filename: (
//       req,
//       file,
//       cb
//     ) => {

//       const ext =
//         path.extname(
//           file.originalname
//         ) || '.jpg';


//       const filename =
//         `order-${req.params.orderId}-item-${req.params.itemId}-${Date.now()}${ext}`;


//       cb(
//         null,
//         filename
//       );

//     },

//   });


// // ==================================================
// // MULTER UPLOAD
// // ==================================================

// const upload =
//   multer({

//     storage,

//     limits: {

//       fileSize:
//         8 * 1024 * 1024,

//     },


//     fileFilter: (
//       req,
//       file,
//       cb
//     ) => {

//       if (
//         file.mimetype &&
//         file.mimetype.startsWith('image/')
//       ) {

//         cb(
//           null,
//           true
//         );

//       } else {

//         cb(
//           new Error(
//             'Only image files are allowed'
//           )
//         );

//       }

//     },

//   });


// // ==================================================
// // GET AVAILABLE ORDERS
// // ==================================================

// router.get(
//   '/orders',
//   shopperAuthMiddleware,
//   getAvailableOrders
// );


// // ==================================================
// // ACCEPT ORDER
// // ==================================================

// router.patch(
//   '/orders/:orderId/accept',
//   shopperAuthMiddleware,
//   acceptOrder
// );


// // ==================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // ==================================================

// router.post(
//   '/orders/:orderId/items/:itemId/photo',
//   shopperAuthMiddleware,
//   upload.single('photo'),
//   uploadItemPhoto
// );


// // ==================================================
// // MULTER ERROR HANDLER
// // ==================================================

// router.use(
//   (
//     error,
//     req,
//     res,
//     next
//   ) => {

//     if (
//       error instanceof multer.MulterError
//     ) {

//       console.error(
//         '❌ MULTER ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     if (
//       error &&
//       error.message ===
//         'Only image files are allowed'
//     ) {

//       console.error(
//         '❌ IMAGE UPLOAD ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     next(error);

//   }
// );


// module.exports = router;


































// const express = require('express');
// const jwt = require('jsonwebtoken');
// const multer = require('multer');
// const path = require('path');
// const fs = require('fs');

// const router = express.Router();

// const {
//   getAvailableOrders,
//   acceptOrder,
//   startShopping,
//   uploadItemPhoto,
// } = require('../controllers/shopperOrderController');


// // ==================================================
// // SHOPPER AUTH MIDDLEWARE
// // ==================================================

// const shopperAuthMiddleware = (req, res, next) => {

//   try {

//     const authHeader =
//       req.headers.authorization;


//     if (
//       !authHeader ||
//       !authHeader.startsWith('Bearer ')
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Authentication required',

//       });

//     }


//     const token =
//       authHeader.split(' ')[1];


//     const decoded =
//       jwt.verify(
//         token,
//         process.env.JWT_SECRET
//       );


//     if (!decoded.shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid shopper token',

//       });

//     }


//     req.shopper = decoded;


//     next();

//   } catch (error) {

//     console.error(
//       '❌ SHOPPER AUTH ERROR:',
//       error.message
//     );


//     return res.status(401).json({

//       success: false,

//       message:
//         'Invalid or expired shopper token',

//     });

//   }

// };


// // ==================================================
// // ITEM PHOTO UPLOAD FOLDER
// // ==================================================

// const uploadDir =
//   path.join(
//     __dirname,
//     '..',
//     'uploads',
//     'items'
//   );


// fs.mkdirSync(
//   uploadDir,
//   {
//     recursive: true,
//   }
// );


// // ==================================================
// // MULTER STORAGE
// // ==================================================

// const storage =
//   multer.diskStorage({

//     destination: (
//       req,
//       file,
//       cb
//     ) => {

//       cb(
//         null,
//         uploadDir
//       );

//     },


//     filename: (
//       req,
//       file,
//       cb
//     ) => {

//       const ext =
//         path.extname(
//           file.originalname
//         ) || '.jpg';


//       const filename =
//         `order-${req.params.orderId}-item-${req.params.itemId}-${Date.now()}${ext}`;


//       cb(
//         null,
//         filename
//       );

//     },

//   });


// // ==================================================
// // MULTER UPLOAD
// // ==================================================

// const upload =
//   multer({

//     storage,

//     limits: {

//       fileSize:
//         8 * 1024 * 1024,

//     },


//     fileFilter: (
//       req,
//       file,
//       cb
//     ) => {

//       if (
//         file.mimetype &&
//         file.mimetype.startsWith('image/')
//       ) {

//         cb(
//           null,
//           true
//         );

//       } else {

//         cb(
//           new Error(
//             'Only image files are allowed'
//           )
//         );

//       }

//     },

//   });


// // ==================================================
// // GET AVAILABLE ORDERS
// // ==================================================

// router.get(
//   '/orders',
//   shopperAuthMiddleware,
//   getAvailableOrders
// );


// // ==================================================
// // ACCEPT ORDER
// // ==================================================

// router.patch(
//   '/orders/:orderId/accept',
//   shopperAuthMiddleware,
//   acceptOrder
// );


// // ==================================================
// // START SHOPPING
// // ==================================================

// router.patch(
//   '/orders/:orderId/start-shopping',
//   shopperAuthMiddleware,
//   startShopping
// );


// // ==================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // ==================================================

// router.post(
//   '/orders/:orderId/items/:itemId/photo',
//   shopperAuthMiddleware,
//   upload.single('photo'),
//   uploadItemPhoto
// );


// // ==================================================
// // MULTER ERROR HANDLER
// // ==================================================

// router.use(
//   (
//     error,
//     req,
//     res,
//     next
//   ) => {

//     if (
//       error instanceof multer.MulterError
//     ) {

//       console.error(
//         '❌ MULTER ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     if (
//       error &&
//       error.message ===
//         'Only image files are allowed'
//     ) {

//       console.error(
//         '❌ IMAGE UPLOAD ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     next(error);

//   }
// );


// // ==================================================
// // EXPORT ROUTER
// // ==================================================

// module.exports = router;
































// const express = require('express');
// const jwt = require('jsonwebtoken');
// const multer = require('multer');
// const path = require('path');
// const fs = require('fs');

// const router = express.Router();

// const {
//   getAvailableOrders,
//   acceptOrder,
//   startShopping,
//   uploadItemPhoto,
//   updateItemShoppingStatus,
// } = require('../controllers/shopperOrderController');


// // ==================================================
// // SHOPPER AUTH MIDDLEWARE
// // ==================================================

// const shopperAuthMiddleware = (req, res, next) => {

//   try {

//     const authHeader =
//       req.headers.authorization;


//     if (
//       !authHeader ||
//       !authHeader.startsWith('Bearer ')
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Authentication required',

//       });

//     }


//     const token =
//       authHeader.split(' ')[1];


//     const decoded =
//       jwt.verify(
//         token,
//         process.env.JWT_SECRET
//       );


//     if (!decoded.shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid shopper token',

//       });

//     }


//     req.shopper =
//       decoded;


//     next();

//   } catch (error) {

//     console.error(
//       '❌ SHOPPER AUTH ERROR:',
//       error.message
//     );


//     return res.status(401).json({

//       success: false,

//       message:
//         'Invalid or expired shopper token',

//     });

//   }

// };


// // ==================================================
// // ITEM PHOTO UPLOAD FOLDER
// // ==================================================

// const uploadDir =
//   path.join(
//     __dirname,
//     '..',
//     'uploads',
//     'items'
//   );


// fs.mkdirSync(
//   uploadDir,
//   {
//     recursive: true,
//   }
// );


// console.log(
//   '📁 SHOPPER ITEM UPLOAD DIRECTORY:',
//   uploadDir
// );


// // ==================================================
// // MULTER STORAGE
// // ==================================================

// const storage =
//   multer.diskStorage({

//     destination: (
//       req,
//       file,
//       cb
//     ) => {

//       console.log(
//         '📸 MULTER DESTINATION:',
//         uploadDir
//       );

//       cb(
//         null,
//         uploadDir
//       );

//     },


//     filename: (
//       req,
//       file,
//       cb
//     ) => {

//       const ext =
//         path.extname(
//           file.originalname
//         ) || '.jpg';


//       const filename =
//         `order-${req.params.orderId}-item-${req.params.itemId}-${Date.now()}${ext}`;


//       console.log(
//         '📸 MULTER FILENAME:',
//         filename
//       );


//       cb(
//         null,
//         filename
//       );

//     },

//   });


// // ==================================================
// // MULTER UPLOAD
// // ==================================================

// const upload =
//   multer({

//     storage,

//     limits: {

//       fileSize:
//         8 * 1024 * 1024,

//     },


//     fileFilter: (
//       req,
//       file,
//       cb
//     ) => {

//       if (
//         file.mimetype &&
//         file.mimetype.startsWith('image/')
//       ) {

//         cb(
//           null,
//           true
//         );

//       } else {

//         cb(
//           new Error(
//             'Only image files are allowed'
//           )
//         );

//       }

//     },

//   });


// // ==================================================
// // TEST SHOPPER ITEM PHOTO FILE
// // ==================================================
// //
// // Temporary diagnostic route.
// //
// // This checks whether the backend process can
// // actually see the uploaded file inside:
// //
// // customer-backend/uploads/items
// //
// // Remove this route later after the problem
// // is fixed.
// //

// router.get(
//   '/test-item-photo',
//   (req, res) => {

//     const testFile =
//       path.join(
//         __dirname,
//         '..',
//         'uploads',
//         'items',
//         'order-76-item-171-1790616548371.jpg'
//       );


//     console.log(
//       '=========================================='
//     );

//     console.log(
//       '📁 TEST ITEM PHOTO PATH:',
//       testFile
//     );


//     const exists =
//       fs.existsSync(
//         testFile
//       );


//     console.log(
//       '📁 TEST ITEM PHOTO EXISTS:',
//       exists
//     );


//     console.log(
//       '=========================================='
//     );


//     if (!exists) {

//       return res.status(404).json({

//         success: false,

//         exists: false,

//         message:
//           'Item photo file was not found by backend',

//         path:
//           testFile,

//       });

//     }


//     return res.json({

//       success: true,

//       exists: true,

//       message:
//         'Item photo file exists',

//       path:
//         testFile,

//     });

//   }
// );


// // ==================================================
// // GET AVAILABLE ORDERS
// // ==================================================

// router.get(
//   '/orders',
//   shopperAuthMiddleware,
//   getAvailableOrders
// );


// // ==================================================
// // ACCEPT ORDER
// // ==================================================

// router.patch(
//   '/orders/:orderId/accept',
//   shopperAuthMiddleware,
//   acceptOrder
// );


// // ==================================================
// // START SHOPPING
// // ==================================================

// router.patch(
//   '/orders/:orderId/start-shopping',
//   shopperAuthMiddleware,
//   startShopping
// );


// // ==================================================
// // UPDATE SHOPPING ITEM STATUS
// // ==================================================
// //
// // Shopper confirms an item:
// //
// // shopping_status = 'done'
// // found_quantity
// // found_weight
// // found_weight_unit
// // barcode_scanned
// //
// // CustomerApp polls the customer order endpoint
// // and receives these updated values.
// //

// router.patch(
//   '/orders/:orderId/items/:itemId/status',
//   shopperAuthMiddleware,
//   updateItemShoppingStatus
// );


// // ==================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // ==================================================

// router.post(
//   '/orders/:orderId/items/:itemId/photo',
//   shopperAuthMiddleware,
//   upload.single('photo'),
//   uploadItemPhoto
// );


// // ==================================================
// // MULTER ERROR HANDLER
// // ==================================================

// router.use(
//   (
//     error,
//     req,
//     res,
//     next
//   ) => {

//     if (
//       error instanceof multer.MulterError
//     ) {

//       console.error(
//         '❌ MULTER ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     if (
//       error &&
//       error.message ===
//         'Only image files are allowed'
//     ) {

//       console.error(
//         '❌ IMAGE UPLOAD ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     next(error);

//   }
// );


// // ==================================================
// // EXPORT ROUTER
// // ==================================================

// module.exports =
//   router;


























// const express = require('express');
// const jwt = require('jsonwebtoken');
// const multer = require('multer');
// const path = require('path');
// const fs = require('fs');

// const router = express.Router();

// const {
//   getAvailableOrders,
//   acceptOrder,
//   startShopping,
//   uploadItemPhoto,
//   updateItemShoppingStatus,
// } = require('../controllers/shopperOrderController');


// // ==================================================
// // SHOPPER AUTH MIDDLEWARE
// // ==================================================

// const shopperAuthMiddleware = (req, res, next) => {

//   try {

//     const authHeader =
//       req.headers.authorization;


//     if (
//       !authHeader ||
//       !authHeader.startsWith('Bearer ')
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Authentication required',

//       });

//     }


//     const token =
//       authHeader.split(' ')[1];


//     const decoded =
//       jwt.verify(
//         token,
//         process.env.JWT_SECRET
//       );


//     if (!decoded.shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid shopper token',

//       });

//     }


//     req.shopper =
//       decoded;


//     next();

//   } catch (error) {

//     console.error(
//       '❌ SHOPPER AUTH ERROR:',
//       error.message
//     );


//     return res.status(401).json({

//       success: false,

//       message:
//         'Invalid or expired shopper token',

//     });

//   }

// };


// // ==================================================
// // ITEM PHOTO UPLOAD FOLDER
// // ==================================================

// const uploadDir =
//   path.join(
//     __dirname,
//     '..',
//     'uploads',
//     'items'
//   );


// fs.mkdirSync(
//   uploadDir,
//   {
//     recursive: true,
//   }
// );


// console.log(
//   '📁 SHOPPER ITEM UPLOAD DIRECTORY:',
//   uploadDir
// );


// // ==================================================
// // MULTER STORAGE
// // ==================================================

// const storage =
//   multer.diskStorage({

//     destination: (
//       req,
//       file,
//       cb
//     ) => {

//       console.log(
//         '📸 MULTER DESTINATION:',
//         uploadDir
//       );

//       cb(
//         null,
//         uploadDir
//       );

//     },


//     filename: (
//       req,
//       file,
//       cb
//     ) => {

//       const ext =
//         path.extname(
//           file.originalname
//         ) || '.jpg';


//       const filename =
//         `order-${req.params.orderId}-item-${req.params.itemId}-${Date.now()}${ext}`;


//       console.log(
//         '📸 MULTER FILENAME:',
//         filename
//       );


//       cb(
//         null,
//         filename
//       );

//     },

//   });


// // ==================================================
// // MULTER UPLOAD
// // ==================================================

// const upload =
//   multer({

//     storage,

//     limits: {

//       fileSize:
//         8 * 1024 * 1024,

//     },


//     fileFilter: (
//       req,
//       file,
//       cb
//     ) => {

//       if (
//         file.mimetype &&
//         file.mimetype.startsWith('image/')
//       ) {

//         cb(
//           null,
//           true
//         );

//       } else {

//         cb(
//           new Error(
//             'Only image files are allowed'
//           )
//         );

//       }

//     },

//   });


// // ==================================================
// // TEST SHOPPER ITEM PHOTO FILE
// // ==================================================
// //
// // Temporary diagnostic route.
// //
// // This checks whether the backend process can
// // actually see the newly uploaded file inside:
// //
// // customer-backend/uploads/items
// //
// // Current test file:
// //
// // order-77-item-173-1790617470510.jpg
// //
// // Remove this route later after the problem
// // is fixed.
// //

// router.get(
//   '/test-item-photo',
//   (req, res) => {

//     const fileName =
//       'order-77-item-173-1790617470510.jpg';


//     const uploadRoot =
//       path.join(
//         __dirname,
//         '..',
//         'uploads'
//       );


//     const itemsDir =
//       path.join(
//         uploadRoot,
//         'items'
//       );


//     const testFile =
//       path.join(
//         itemsDir,
//         fileName
//       );


//     console.log(
//       '=========================================='
//     );


//     console.log(
//       '📁 ROUTES __dirname:',
//       __dirname
//     );


//     console.log(
//       '📁 UPLOAD ROOT:',
//       uploadRoot
//     );


//     console.log(
//       '📁 ITEMS DIRECTORY:',
//       itemsDir
//     );


//     console.log(
//       '📁 TEST FILE:',
//       testFile
//     );


//     console.log(
//       '📁 UPLOAD ROOT EXISTS:',
//       fs.existsSync(
//         uploadRoot
//       )
//     );


//     console.log(
//       '📁 ITEMS DIRECTORY EXISTS:',
//       fs.existsSync(
//         itemsDir
//       )
//     );


//     console.log(
//       '📁 FILE EXISTS:',
//       fs.existsSync(
//         testFile
//       )
//     );


//     if (
//       fs.existsSync(
//         itemsDir
//       )
//     ) {

//       try {

//         console.log(
//           '📁 ITEMS FILES:',
//           fs.readdirSync(
//             itemsDir
//           )
//         );

//       } catch (error) {

//         console.error(
//           '❌ READ ITEMS DIRECTORY ERROR:',
//           error.message
//         );

//       }

//     }


//     console.log(
//       '=========================================='
//     );


//     if (
//       !fs.existsSync(
//         testFile
//       )
//     ) {

//       return res.status(404).json({

//         success: false,

//         exists: false,

//         message:
//           'Item photo file was not found by backend',

//         path:
//           testFile,

//         uploadRootExists:
//           fs.existsSync(
//             uploadRoot
//           ),

//         itemsDirExists:
//           fs.existsSync(
//             itemsDir
//           ),

//       });

//     }


//     return res.json({

//       success: true,

//       exists: true,

//       message:
//         'Item photo file exists',

//       path:
//         testFile,

//       uploadRootExists:
//         fs.existsSync(
//           uploadRoot
//         ),

//       itemsDirExists:
//         fs.existsSync(
//           itemsDir
//         ),

//     });

//   }
// );


// // ==================================================
// // GET AVAILABLE ORDERS
// // ==================================================

// router.get(
//   '/orders',
//   shopperAuthMiddleware,
//   getAvailableOrders
// );


// // ==================================================
// // ACCEPT ORDER
// // ==================================================

// router.patch(
//   '/orders/:orderId/accept',
//   shopperAuthMiddleware,
//   acceptOrder
// );


// // ==================================================
// // START SHOPPING
// // ==================================================

// router.patch(
//   '/orders/:orderId/start-shopping',
//   shopperAuthMiddleware,
//   startShopping
// );


// // ==================================================
// // UPDATE SHOPPING ITEM STATUS
// // ==================================================
// //
// // Shopper confirms an item:
// //
// // shopping_status = 'done'
// // found_quantity
// // found_weight
// // found_weight_unit
// // barcode_scanned
// //
// // CustomerApp polls the customer order endpoint
// // and receives these updated values.
// //

// router.patch(
//   '/orders/:orderId/items/:itemId/status',
//   shopperAuthMiddleware,
//   updateItemShoppingStatus
// );


// // ==================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // ==================================================

// router.post(
//   '/orders/:orderId/items/:itemId/photo',
//   shopperAuthMiddleware,
//   upload.single('photo'),
//   uploadItemPhoto
// );


// // ==================================================
// // MULTER ERROR HANDLER
// // ==================================================

// router.use(
//   (
//     error,
//     req,
//     res,
//     next
//   ) => {

//     if (
//       error instanceof multer.MulterError
//     ) {

//       console.error(
//         '❌ MULTER ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     if (
//       error &&
//       error.message ===
//         'Only image files are allowed'
//     ) {

//       console.error(
//         '❌ IMAGE UPLOAD ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     next(error);

//   }
// );


// // ==================================================
// // EXPORT ROUTER
// // ==================================================

// module.exports =
//   router;


















// const express = require('express');
// const jwt = require('jsonwebtoken');
// const multer = require('multer');
// const path = require('path');
// const fs = require('fs');

// const router = express.Router();

// const {
//   getAvailableOrders,
//   acceptOrder,
//   startShopping,
//   uploadItemPhoto,
//   uploadReplacementPhoto,
//   updateItemShoppingStatus,
// } = require('../controllers/shopperOrderController');


// // ==================================================
// // SHOPPER AUTH MIDDLEWARE
// // ==================================================

// const shopperAuthMiddleware = (req, res, next) => {

//   try {

//     const authHeader =
//       req.headers.authorization;


//     if (
//       !authHeader ||
//       !authHeader.startsWith('Bearer ')
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Authentication required',

//       });

//     }


//     const token =
//       authHeader.split(' ')[1];


//     const decoded =
//       jwt.verify(
//         token,
//         process.env.JWT_SECRET
//       );


//     if (!decoded.shopperId) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid shopper token',

//       });

//     }


//     req.shopper =
//       decoded;


//     next();

//   } catch (error) {

//     console.error(
//       '❌ SHOPPER AUTH ERROR:',
//       error.message
//     );


//     return res.status(401).json({

//       success: false,

//       message:
//         'Invalid or expired shopper token',

//     });

//   }

// };


// // ==================================================
// // ITEM PHOTO UPLOAD FOLDER
// // ==================================================

// const uploadDir =
//   path.join(
//     __dirname,
//     '..',
//     'uploads',
//     'items'
//   );


// fs.mkdirSync(
//   uploadDir,
//   {
//     recursive: true,
//   }
// );


// console.log(
//   '📁 SHOPPER ITEM UPLOAD DIRECTORY:',
//   uploadDir
// );


// // ==================================================
// // REPLACEMENT PHOTO UPLOAD FOLDER
// // ==================================================

// const replacementUploadDir =
//   path.join(
//     __dirname,
//     '..',
//     'uploads',
//     'replacements'
//   );


// fs.mkdirSync(
//   replacementUploadDir,
//   {
//     recursive: true,
//   }
// );


// console.log(
//   '📁 SHOPPER REPLACEMENT UPLOAD DIRECTORY:',
//   replacementUploadDir
// );


// // ==================================================
// // ITEM PHOTO MULTER STORAGE
// // ==================================================

// const storage =
//   multer.diskStorage({

//     destination: (
//       req,
//       file,
//       cb
//     ) => {

//       console.log(
//         '📸 MULTER ITEM DESTINATION:',
//         uploadDir
//       );


//       cb(
//         null,
//         uploadDir
//       );

//     },


//     filename: (
//       req,
//       file,
//       cb
//     ) => {

//       const ext =
//         path.extname(
//           file.originalname
//         ) || '.jpg';


//       const filename =
//         `order-${req.params.orderId}-item-${req.params.itemId}-${Date.now()}${ext}`;


//       console.log(
//         '📸 MULTER ITEM FILENAME:',
//         filename
//       );


//       cb(
//         null,
//         filename
//       );

//     },

//   });


// // ==================================================
// // REPLACEMENT PHOTO MULTER STORAGE
// // ==================================================

// const replacementStorage =
//   multer.diskStorage({

//     destination: (
//       req,
//       file,
//       cb
//     ) => {

//       console.log(
//         '📸 MULTER REPLACEMENT DESTINATION:',
//         replacementUploadDir
//       );


//       cb(
//         null,
//         replacementUploadDir
//       );

//     },


//     filename: (
//       req,
//       file,
//       cb
//     ) => {

//       const ext =
//         path.extname(
//           file.originalname
//         ) || '.jpg';


//       const filename =
//         `order-${req.params.orderId}-item-${req.params.itemId}-replacement-${Date.now()}${ext}`;


//       console.log(
//         '📸 MULTER REPLACEMENT FILENAME:',
//         filename
//       );


//       cb(
//         null,
//         filename
//       );

//     },

//   });


// // ==================================================
// // COMMON IMAGE FILTER
// // ==================================================

// const imageFileFilter = (
//   req,
//   file,
//   cb
// ) => {

//   if (
//     file.mimetype &&
//     file.mimetype.startsWith('image/')
//   ) {

//     cb(
//       null,
//       true
//     );

//   } else {

//     cb(
//       new Error(
//         'Only image files are allowed'
//       )
//     );

//   }

// };


// // ==================================================
// // ITEM PHOTO MULTER UPLOAD
// // ==================================================

// const upload =
//   multer({

//     storage,

//     limits: {

//       fileSize:
//         8 * 1024 * 1024,

//     },


//     fileFilter:
//       imageFileFilter,

//   });


// // ==================================================
// // REPLACEMENT PHOTO MULTER UPLOAD
// // ==================================================

// const uploadReplacement =
//   multer({

//     storage:
//       replacementStorage,

//     limits: {

//       fileSize:
//         8 * 1024 * 1024,

//     },


//     fileFilter:
//       imageFileFilter,

//   });


// // ==================================================
// // TEST SHOPPER ITEM PHOTO FILE
// // ==================================================

// router.get(
//   '/test-item-photo',
//   (req, res) => {

//     const fileName =
//       'order-77-item-173-1790617470510.jpg';


//     const uploadRoot =
//       path.join(
//         __dirname,
//         '..',
//         'uploads'
//       );


//     const itemsDir =
//       path.join(
//         uploadRoot,
//         'items'
//       );


//     const testFile =
//       path.join(
//         itemsDir,
//         fileName
//       );


//     console.log(
//       '=========================================='
//     );


//     console.log(
//       '📁 ROUTES __dirname:',
//       __dirname
//     );


//     console.log(
//       '📁 UPLOAD ROOT:',
//       uploadRoot
//     );


//     console.log(
//       '📁 ITEMS DIRECTORY:',
//       itemsDir
//     );


//     console.log(
//       '📁 TEST FILE:',
//       testFile
//     );


//     console.log(
//       '📁 UPLOAD ROOT EXISTS:',
//       fs.existsSync(
//         uploadRoot
//       )
//     );


//     console.log(
//       '📁 ITEMS DIRECTORY EXISTS:',
//       fs.existsSync(
//         itemsDir
//       )
//     );


//     console.log(
//       '📁 FILE EXISTS:',
//       fs.existsSync(
//         testFile
//       )
//     );


//     if (
//       fs.existsSync(
//         itemsDir
//       )
//     ) {

//       try {

//         console.log(
//           '📁 ITEMS FILES:',
//           fs.readdirSync(
//             itemsDir
//           )
//         );

//       } catch (error) {

//         console.error(
//           '❌ READ ITEMS DIRECTORY ERROR:',
//           error.message
//         );

//       }

//     }


//     console.log(
//       '=========================================='
//     );


//     if (
//       !fs.existsSync(
//         testFile
//       )
//     ) {

//       return res.status(404).json({

//         success: false,

//         exists: false,

//         message:
//           'Item photo file was not found by backend',

//         path:
//           testFile,

//         uploadRootExists:
//           fs.existsSync(
//             uploadRoot
//           ),

//         itemsDirExists:
//           fs.existsSync(
//             itemsDir
//           ),

//       });

//     }


//     return res.json({

//       success: true,

//       exists: true,

//       message:
//         'Item photo file exists',

//       path:
//         testFile,

//       uploadRootExists:
//         fs.existsSync(
//           uploadRoot
//         ),

//       itemsDirExists:
//         fs.existsSync(
//           itemsDir
//         ),

//     });

//   }
// );


// // ==================================================
// // GET AVAILABLE ORDERS
// // ==================================================

// router.get(
//   '/orders',
//   shopperAuthMiddleware,
//   getAvailableOrders
// );


// // ==================================================
// // ACCEPT ORDER
// // ==================================================

// router.patch(
//   '/orders/:orderId/accept',
//   shopperAuthMiddleware,
//   acceptOrder
// );


// // ==================================================
// // START SHOPPING
// // ==================================================

// router.patch(
//   '/orders/:orderId/start-shopping',
//   shopperAuthMiddleware,
//   startShopping
// );


// // ==================================================
// // UPDATE SHOPPING ITEM STATUS
// // ==================================================

// router.patch(
//   '/orders/:orderId/items/:itemId/status',
//   shopperAuthMiddleware,
//   updateItemShoppingStatus
// );


// // ==================================================
// // UPLOAD SHOPPER ITEM PHOTO
// // ==================================================

// router.post(
//   '/orders/:orderId/items/:itemId/photo',
//   shopperAuthMiddleware,
//   upload.single('photo'),
//   uploadItemPhoto
// );


// // ==================================================
// // UPLOAD SHOPPER REPLACEMENT PHOTO
// // ==================================================

// router.post(
//   '/orders/:orderId/items/:itemId/replacement-photo',
//   shopperAuthMiddleware,
//   uploadReplacement.single('photo'),
//   uploadReplacementPhoto
// );


// // ==================================================
// // MULTER ERROR HANDLER
// // ==================================================

// router.use(
//   (
//     error,
//     req,
//     res,
//     next
//   ) => {

//     if (
//       error instanceof multer.MulterError
//     ) {

//       console.error(
//         '❌ MULTER ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     if (
//       error &&
//       error.message ===
//         'Only image files are allowed'
//     ) {

//       console.error(
//         '❌ IMAGE UPLOAD ERROR:',
//         error.message
//       );


//       return res.status(400).json({

//         success: false,

//         message:
//           error.message,

//       });

//     }


//     next(error);

//   }
// );


// // ==================================================
// // EXPORT ROUTER
// // ==================================================

// module.exports =
//   router;






// const express = require('express');
// const jwt = require('jsonwebtoken');
// const multer = require('multer');
// const path = require('path');
// const fs = require('fs');

// const router = express.Router();

// const {
//   getAvailableOrders,
//   getMyOrderById,
//   acceptOrder,
//   startShopping,
//   uploadItemPhoto,
//   uploadReplacementPhoto,
//   updateItemShoppingStatus,
// } = require('../controllers/shopperOrderController');


// // =====================================================
// // SHOPPER AUTH MIDDLEWARE
// // =====================================================

// const shopperAuthMiddleware = (
//   req,
//   res,
//   next
// ) => {

//   try {

//     const authHeader =
//       req.headers.authorization;


//     if (
//       !authHeader ||
//       !authHeader.startsWith('Bearer ')
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Authentication token is required',

//       });

//     }


//     const token =
//       authHeader.split(' ')[1];


//     const decoded =
//       jwt.verify(
//         token,
//         process.env.JWT_SECRET
//       );


//     if (
//       !decoded ||
//       !decoded.shopperId
//     ) {

//       return res.status(401).json({

//         success: false,

//         message:
//           'Invalid shopper authentication token',

//       });

//     }


//     req.shopper =
//       decoded;


//     next();

//   } catch (error) {

//     console.error(
//       '❌ SHOPPER AUTH ERROR:',
//       error
//     );


//     return res.status(401).json({

//       success: false,

//       message:
//         'Invalid or expired authentication token',

//     });

//   }

// };


// // =====================================================
// // UPLOAD DIRECTORIES
// // =====================================================

// const uploadDir =
//   path.join(
//     __dirname,
//     '..',
//     'uploads',
//     'items'
//   );


// const replacementUploadDir =
//   path.join(
//     __dirname,
//     '..',
//     'uploads',
//     'replacements'
//   );


// // =====================================================
// // CREATE DIRECTORIES
// // =====================================================

// if (
//   !fs.existsSync(
//     uploadDir
//   )
// ) {

//   fs.mkdirSync(
//     uploadDir,
//     {
//       recursive: true,
//     }
//   );

// }


// if (
//   !fs.existsSync(
//     replacementUploadDir
//   )
// ) {

//   fs.mkdirSync(
//     replacementUploadDir,
//     {
//       recursive: true,
//     }
//   );

// }


// // =====================================================
// // ITEM PHOTO STORAGE
// // =====================================================

// const itemStorage =
//   multer.diskStorage({

//     destination: (
//       req,
//       file,
//       cb
//     ) => {

//       cb(
//         null,
//         uploadDir
//       );

//     },


//     filename: (
//       req,
//       file,
//       cb
//     ) => {

//       const ext =
//         path.extname(
//           file.originalname
//         );


//       const filename =
//         `order-${req.params.orderId}-item-${req.params.itemId}-${Date.now()}${ext}`;


//       cb(
//         null,
//         filename
//       );

//     },

//   });


// // =====================================================
// // REPLACEMENT PHOTO STORAGE
// // =====================================================

// const replacementStorage =
//   multer.diskStorage({

//     destination: (
//       req,
//       file,
//       cb
//     ) => {

//       cb(
//         null,
//         replacementUploadDir
//       );

//     },


//     filename: (
//       req,
//       file,
//       cb
//     ) => {

//       const ext =
//         path.extname(
//           file.originalname
//         );


//       const filename =
//         `order-${req.params.orderId}-item-${req.params.itemId}-replacement-${Date.now()}${ext}`;


//       cb(
//         null,
//         filename
//       );

//     },

//   });


// // =====================================================
// // IMAGE FILTER
// // =====================================================

// const imageFilter =
//   (
//     req,
//     file,
//     cb
//   ) => {

//     if (
//       file.mimetype &&
//       file.mimetype.startsWith(
//         'image/'
//       )
//     ) {

//       cb(
//         null,
//         true
//       );

//     } else {

//       cb(
//         new Error(
//           'Only image files are allowed'
//         ),
//         false
//       );

//     }

//   };


// // =====================================================
// // MULTER - NORMAL ITEM PHOTO
// // =====================================================

// const upload =
//   multer({

//     storage:
//       itemStorage,

//     fileFilter:
//       imageFilter,

//     limits: {

//       fileSize:
//         8 * 1024 * 1024,

//     },

//   });


// // =====================================================
// // MULTER - REPLACEMENT PHOTO
// // =====================================================

// const uploadReplacement =
//   multer({

//     storage:
//       replacementStorage,

//     fileFilter:
//       imageFilter,

//     limits: {

//       fileSize:
//         8 * 1024 * 1024,

//     },

//   });


// // =====================================================
// // TEST ITEM PHOTO
// // =====================================================

// router.get(
//   '/test-item-photo',
//   (req, res) => {

//     try {

//       const testFile =
//         path.join(
//           __dirname,
//           '..',
//           'uploads',
//           'items',
//           'test.jpg'
//         );


//       if (
//         fs.existsSync(
//           testFile
//         )
//       ) {

//         return res.json({

//           success: true,

//           message:
//             'Test item photo exists',

//           file:
//             testFile,

//         });

//       }


//       return res.status(404).json({

//         success: false,

//         message:
//           'Test item photo not found',

//         file:
//           testFile,

//       });

//     } catch (error) {

//       console.error(
//         '❌ TEST ITEM PHOTO ERROR:',
//         error
//       );


//       return res.status(500).json({

//         success: false,

//         message:
//           'Failed to test item photo',

//         error:
//           error.message,

//       });

//     }

//   }
// );


// // =====================================================
// // GET AVAILABLE ORDERS
// // =====================================================

// router.get(
//   '/orders',
//   shopperAuthMiddleware,
//   getAvailableOrders
// );


// // =====================================================
// // GET SINGLE SHOPPER ORDER
// // =====================================================
// //
// // GET:
// // /api/shopper/orders/:orderId
// //
// // This returns:
// // - Order information
// // - Shop information
// // - Order items
// // - Replacement items
// // - Replacement approval/rejection status
// //
// // =====================================================

// router.get(
//   '/orders/:orderId',
//   shopperAuthMiddleware,
//   getMyOrderById
// );


// // =====================================================
// // ACCEPT ORDER
// // =====================================================

// router.patch(
//   '/orders/:orderId/accept',
//   shopperAuthMiddleware,
//   acceptOrder
// );


// // =====================================================
// // START SHOPPING
// // =====================================================

// router.patch(
//   '/orders/:orderId/start-shopping',
//   shopperAuthMiddleware,
//   startShopping
// );


// // =====================================================
// // UPDATE ITEM SHOPPING STATUS
// // =====================================================

// router.patch(
//   '/orders/:orderId/items/:itemId/status',
//   shopperAuthMiddleware,
//   updateItemShoppingStatus
// );


// // =====================================================
// // UPLOAD NORMAL ITEM PHOTO
// // =====================================================

// router.post(
//   '/orders/:orderId/items/:itemId/photo',
//   shopperAuthMiddleware,
//   upload.single('photo'),
//   uploadItemPhoto
// );


// // =====================================================
// // UPLOAD REPLACEMENT PHOTO
// // =====================================================

// router.post(
//   '/orders/:orderId/items/:itemId/replacement-photo',
//   shopperAuthMiddleware,
//   uploadReplacement.single('photo'),
//   uploadReplacementPhoto
// );


// // =====================================================
// // EXPORT
// // =====================================================

// module.exports =
//   router;




































const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// =====================================================
// CONTROLLERS
// =====================================================

const {
  getAvailableOrders,
  getMyOrderById,
  acceptOrder,
  startShopping,
  uploadItemPhoto,
  uploadReplacementPhoto,
  updateItemShoppingStatus,
  updateOrderPayment,
  uploadBill: uploadBillController,
} = require('../controllers/shopperOrderController');

// =====================================================
// AUTH MIDDLEWARE
// =====================================================

const authMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'Authorization header is required',
      });
    }

    const parts = authHeader.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({
        success: false,
        message: 'Invalid authorization format',
      });
    }

    const token = parts[1];

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    if (!decoded || !decoded.shopperId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid shopper token',
      });
    }

    req.shopper = decoded;

    next();
  } catch (error) {
    console.error(
      '❌ Shopper auth error:',
      error.message
    );

    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }
};

// =====================================================
// UPLOAD DIRECTORIES
// =====================================================

const itemUploadDir =
  path.join(
    __dirname,
    '..',
    'uploads',
    'items'
  );

const replacementUploadDir =
  path.join(
    __dirname,
    '..',
    'uploads',
    'replacements'
  );

const billUploadDir =
  path.join(
    __dirname,
    '..',
    'uploads',
    'bills'
  );

// =====================================================
// CREATE DIRECTORIES
// =====================================================

if (!fs.existsSync(itemUploadDir)) {
  fs.mkdirSync(
    itemUploadDir,
    {
      recursive: true,
    }
  );
}

if (!fs.existsSync(replacementUploadDir)) {
  fs.mkdirSync(
    replacementUploadDir,
    {
      recursive: true,
    }
  );
}

if (!fs.existsSync(billUploadDir)) {
  fs.mkdirSync(
    billUploadDir,
    {
      recursive: true,
    }
  );
}

// =====================================================
// IMAGE FILTER
// =====================================================

const imageFilter = (
  req,
  file,
  cb
) => {
  if (
    file &&
    file.mimetype &&
    file.mimetype.startsWith('image/')
  ) {
    cb(null, true);
  } else {
    cb(
      new Error(
        'Only image files are allowed'
      )
    );
  }
};

// =====================================================
// ITEM PHOTO STORAGE
// =====================================================

const itemStorage =
  multer.diskStorage({
    destination: function (
      req,
      file,
      cb
    ) {
      cb(
        null,
        itemUploadDir
      );
    },

    filename: function (
      req,
      file,
      cb
    ) {
      const ext =
        path.extname(
          file.originalname ||
            '.jpg'
        );

      cb(
        null,
        `order-${req.params.orderId}-item-${req.params.itemId}-${Date.now()}${ext}`
      );
    },
  });

// =====================================================
// REPLACEMENT PHOTO STORAGE
// =====================================================

const replacementStorage =
  multer.diskStorage({
    destination: function (
      req,
      file,
      cb
    ) {
      cb(
        null,
        replacementUploadDir
      );
    },

    filename: function (
      req,
      file,
      cb
    ) {
      const ext =
        path.extname(
          file.originalname ||
            '.jpg'
        );

      cb(
        null,
        `order-${req.params.orderId}-replacement-${req.params.itemId}-${Date.now()}${ext}`
      );
    },
  });

// =====================================================
// BILL PHOTO STORAGE
// =====================================================

const billStorage =
  multer.diskStorage({
    destination: function (
      req,
      file,
      cb
    ) {
      cb(
        null,
        billUploadDir
      );
    },

    filename: function (
      req,
      file,
      cb
    ) {
      const ext =
        path.extname(
          file.originalname ||
            '.jpg'
        );

      cb(
        null,
        `order-${req.params.orderId}-bill-${Date.now()}${ext}`
      );
    },
  });

// =====================================================
// MULTER UPLOADS
// =====================================================

const uploadItem =
  multer({
    storage: itemStorage,

    fileFilter:
      imageFilter,

    limits: {
      fileSize:
        8 * 1024 * 1024,
    },
  });

const uploadReplacement =
  multer({
    storage:
      replacementStorage,

    fileFilter:
      imageFilter,

    limits: {
      fileSize:
        8 * 1024 * 1024,
    },
  });

// IMPORTANT:
// This is named uploadBillFile so it does NOT
// conflict with controller uploadBillController.

const uploadBillFile =
  multer({
    storage: billStorage,

    fileFilter:
      imageFilter,

    limits: {
      fileSize:
        8 * 1024 * 1024,
    },
  });

// =====================================================
// AVAILABLE ORDERS
// =====================================================

router.get(
  '/orders',
  authMiddleware,
  getAvailableOrders
);

// =====================================================
// GET MY ORDER BY ID
// =====================================================

router.get(
  '/orders/:orderId',
  authMiddleware,
  getMyOrderById
);

// =====================================================
// ACCEPT ORDER
// =====================================================

router.patch(
  '/orders/:orderId/accept',
  authMiddleware,
  acceptOrder
);

// =====================================================
// START SHOPPING
// =====================================================

router.patch(
  '/orders/:orderId/start-shopping',
  authMiddleware,
  startShopping
);

// =====================================================
// UPDATE ITEM SHOPPING STATUS
// =====================================================

router.patch(
  '/orders/:orderId/items/:itemId/status',
  authMiddleware,
  updateItemShoppingStatus
);

// =====================================================
// UPLOAD ITEM PHOTO
// =====================================================

router.post(
  '/orders/:orderId/items/:itemId/photo',
  authMiddleware,
  uploadItem.single('photo'),
  uploadItemPhoto
);

// =====================================================
// UPLOAD REPLACEMENT PHOTO
// =====================================================

router.post(
  '/orders/:orderId/items/:itemId/replacement-photo',
  authMiddleware,
  uploadReplacement.single('photo'),
  uploadReplacementPhoto
);

// =====================================================
// COMPLETE PAYMENT
// =====================================================

router.patch(
  '/orders/:orderId/payment',
  authMiddleware,
  updateOrderPayment
);

// =====================================================
// UPLOAD SUPERMARKET BILL
// =====================================================

router.post(
  '/orders/:orderId/bill',
  authMiddleware,
  uploadBillFile.single('bill'),
  uploadBillController
);

// =====================================================
// ERROR HANDLER FOR MULTER
// =====================================================

router.use(
  (
    error,
    req,
    res,
    next
  ) => {
    if (
      error instanceof multer.MulterError
    ) {
      console.error(
        '❌ Multer error:',
        error
      );

      if (
        error.code ===
        'LIMIT_FILE_SIZE'
      ) {
        return res.status(400).json({
          success: false,
          message:
            'Image file is too large. Maximum size is 8MB.',
        });
      }

      return res.status(400).json({
        success: false,
        message:
          error.message ||
          'File upload failed',
      });
    }

    if (
      error &&
      error.message ===
        'Only image files are allowed'
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Only image files are allowed',
      });
    }

    next(error);
  }
);

// =====================================================
// EXPORT
// =====================================================

module.exports = router;
