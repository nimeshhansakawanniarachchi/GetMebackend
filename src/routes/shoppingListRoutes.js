const express = require('express');

const authMiddleware = require('../middleware/authMiddleware');
const lists = require('../shoppingLists/shoppingLists');

// =====================================================
// CUSTOMER SHOPPING LISTS (phase 58) - mounted at /api/customer
// =====================================================

const router = express.Router();

router.get('/shopping-lists', authMiddleware, lists.getLists);
router.post('/shopping-lists', authMiddleware, lists.createList);
router.get('/shopping-lists/:listId', authMiddleware, lists.getList);
router.patch('/shopping-lists/:listId', authMiddleware, lists.renameList);
router.delete('/shopping-lists/:listId', authMiddleware, lists.deleteList);
router.post('/shopping-lists/:listId/items', authMiddleware, lists.addItem);
router.patch('/shopping-lists/:listId/items/:itemId', authMiddleware, lists.updateItem);
router.delete('/shopping-lists/:listId/items/:itemId', authMiddleware, lists.removeItem);
router.post('/shopping-lists/:listId/clear', authMiddleware, lists.clearList);
router.post('/shopping-lists/:listId/export', authMiddleware, lists.exportItems);

module.exports = router;
