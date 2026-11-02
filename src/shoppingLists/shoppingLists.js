const pool = require('../config/db');

// =====================================================
// CUSTOMER SHOPPING LISTS (phase 58, additive)
// Saved lists of catalogue products and special requests. Nothing
// here changes carts, orders or prices:
//   - product lines keep only the product id; the shop, name, price,
//     unit and availability are always read live from the catalogue;
//   - special requests have no price (they become the existing custom
//     items, priced by the shopper at the shelf);
//   - POST /:id/export turns chosen lines into the exact item format
//     the existing quote / add-items / item-request endpoints take,
//     which re-price and validate everything themselves.
// Every query is limited to the signed-in customer.
// =====================================================

const MAX_LISTS = 10;
const MAX_ITEMS = 200;
const SPECIAL_UNITS = ['pcs', 'item', 'pack', 'kg', 'g', 'L', 'ml'];
const LOOSE_UNITS = ['kg', 'g', 'L', 'ml'];

const fail = (res, status, message, code) => res.status(status).json({ success: false, message, ...(code ? { code } : {}) });
const customerIdOf = (req) => Number(req.customer?.customerId);
const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const text = (value, max) => {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : null;
};
const money = (value) => (value == null ? null : Math.round(Number(value) * 100) / 100);

// Quantities: whole numbers for counted items, up to 3 decimals for kg / L
const readQuantity = (value, unit) => {
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999) return null;
  if (!LOOSE_UNITS.includes(unit) && !Number.isInteger(quantity)) return null;
  return Math.round(quantity * 1000) / 1000;
};

// Only photos uploaded through the app's own media upload
// (POST /api/customer/orders/upload-media -> /uploads/items/<file>)
const readPhoto = (value) => {
  if (value == null || value === '') return null;
  const match = String(value).match(/\/uploads\/items\/([A-Za-z0-9._-]{1,200})(?:\?|$)/);
  return match ? `/uploads/items/${match[1]}` : undefined;
};

const ownList = async (client, customerId, listId) =>
  (await client.query(
    'SELECT * FROM shopping_lists WHERE id = $1 AND customer_id = $2 AND archived_at IS NULL',
    [listId, customerId]
  )).rows[0] || null;

const touch = (client, listId) =>
  client.query('UPDATE shopping_lists SET updated_at = NOW() WHERE id = $1', [listId]);

// List lines + live catalogue data
const loadItems = async (client, listId) => {
  const result = await client.query(
    `SELECT li.*,
            p.product_name, p.price AS product_price, p.unit AS product_unit, p.image_url AS product_image,
            p.brand AS product_brand, p.size AS product_size, p.is_available, p.stock_quantity,
            s.shop_name, s.is_open AS shop_open, s.status AS shop_status
       FROM shopping_list_items li
       LEFT JOIN products p ON li.kind = 'product' AND p.id = li.product_id
       LEFT JOIN shops s ON s.id = COALESCE(p.shop_id, li.shop_id)
      WHERE li.list_id = $1
      ORDER BY li.checked, li.id`,
    [listId]
  );

  return result.rows.map((row) => {
    const isProduct = row.kind === 'product';
    const exists = isProduct ? row.product_name != null : true;
    const inStock = row.stock_quantity == null || Number(row.stock_quantity) > 0;
    const available = isProduct ? exists && row.is_available === true && inStock : null;

    return {
      id: row.id,
      kind: row.kind,
      productId: row.product_id,
      shopId: row.shop_id,
      shopName: row.shop_name || null,
      shopOpen: row.shop_open == null ? null : Boolean(row.shop_open),
      name: isProduct && row.product_name ? row.product_name : row.item_name,
      brand: row.brand || (isProduct ? row.product_brand : null) || null,
      size: row.size || (isProduct ? row.product_size : null) || null,
      quantity: Number(row.quantity),
      unit: isProduct ? row.product_unit || row.unit : row.unit,
      note: row.note,
      photoUrl: row.photo_url || null,
      image: isProduct ? row.product_image || null : row.photo_url || null,
      checked: row.checked,
      // Live catalogue facts (special requests: none - priced in store)
      price: isProduct && exists ? money(row.product_price) : null,
      available,
      unavailableReason: isProduct
        ? (!exists ? 'no_longer_sold' : row.is_available !== true ? 'unavailable' : !inStock ? 'out_of_stock' : null)
        : null,
      isSpecialRequest: !isProduct,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
};

const listSummary = (row) => ({
  id: row.id,
  name: row.name,
  itemCount: Number(row.item_count || 0),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// -----------------------------------------------------
// Lists
// -----------------------------------------------------

// GET /api/customer/shopping-lists (the first visit creates "My shopping list")
const getLists = async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const read = () => pool.query(
      `SELECT l.*, (SELECT COUNT(*) FROM shopping_list_items i WHERE i.list_id = l.id) AS item_count
         FROM shopping_lists l
        WHERE l.customer_id = $1 AND l.archived_at IS NULL
        ORDER BY l.id`,
      [customerId]
    );

    let result = await read();
    if (result.rows.length === 0) {
      await pool.query(
        `INSERT INTO shopping_lists (customer_id)
         SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM shopping_lists WHERE customer_id = $1 AND archived_at IS NULL)`,
        [customerId]
      );
      result = await read();
    }

    return res.json({ success: true, lists: result.rows.map(listSummary) });
  } catch (error) {
    console.error('❌ SHOPPING LISTS:', error.message);
    return fail(res, 500, 'Unable to load your shopping lists');
  }
};

// POST /api/customer/shopping-lists { name }
const createList = async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const name = text(req.body?.name, 80) || 'My shopping list';
    const count = Number((await pool.query(
      'SELECT COUNT(*) FROM shopping_lists WHERE customer_id = $1 AND archived_at IS NULL', [customerId]
    )).rows[0].count);
    if (count >= MAX_LISTS) return fail(res, 400, `You can keep up to ${MAX_LISTS} lists`, 'TOO_MANY_LISTS');

    const row = (await pool.query(
      'INSERT INTO shopping_lists (customer_id, name) VALUES ($1, $2) RETURNING *', [customerId, name]
    )).rows[0];
    return res.status(201).json({ success: true, list: listSummary({ ...row, item_count: 0 }) });
  } catch (error) {
    console.error('❌ SHOPPING LIST CREATE:', error.message);
    return fail(res, 500, 'Unable to create the list');
  }
};

// PATCH /api/customer/shopping-lists/:listId { name }
const renameList = async (req, res) => {
  try {
    const listId = toId(req.params.listId);
    const name = text(req.body?.name, 80);
    if (!listId) return fail(res, 400, 'Invalid list');
    if (!name) return fail(res, 400, 'Enter a list name');

    const row = (await pool.query(
      `UPDATE shopping_lists SET name = $3, updated_at = NOW()
        WHERE id = $1 AND customer_id = $2 AND archived_at IS NULL RETURNING *`,
      [listId, customerIdOf(req), name]
    )).rows[0];
    if (!row) return fail(res, 404, 'List not found');
    return res.json({ success: true, list: listSummary(row) });
  } catch (error) {
    console.error('❌ SHOPPING LIST RENAME:', error.message);
    return fail(res, 500, 'Unable to rename the list');
  }
};

// DELETE /api/customer/shopping-lists/:listId (archived, never hard-deleted)
const deleteList = async (req, res) => {
  try {
    const listId = toId(req.params.listId);
    if (!listId) return fail(res, 400, 'Invalid list');
    const row = (await pool.query(
      `UPDATE shopping_lists SET archived_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND customer_id = $2 AND archived_at IS NULL RETURNING id`,
      [listId, customerIdOf(req)]
    )).rows[0];
    if (!row) return fail(res, 404, 'List not found');
    return res.json({ success: true });
  } catch (error) {
    console.error('❌ SHOPPING LIST DELETE:', error.message);
    return fail(res, 500, 'Unable to delete the list');
  }
};

// GET /api/customer/shopping-lists/:listId
const getList = async (req, res) => {
  try {
    const listId = toId(req.params.listId);
    if (!listId) return fail(res, 400, 'Invalid list');
    const list = await ownList(pool, customerIdOf(req), listId);
    if (!list) return fail(res, 404, 'List not found');

    const items = await loadItems(pool, listId);
    return res.json({ success: true, list: listSummary({ ...list, item_count: items.length }), items });
  } catch (error) {
    console.error('❌ SHOPPING LIST GET:', error.message);
    return fail(res, 500, 'Unable to load the list');
  }
};

// -----------------------------------------------------
// Items
// -----------------------------------------------------

// POST /api/customer/shopping-lists/:listId/items
//   product: { kind: 'product', productId, quantity, note?, clientItemId? }
//   special: { kind: 'special', itemName, brand?, size?, quantity, unit?, note?, photoUrl?, shopId?, clientItemId? }
const addItem = async (req, res) => {
  const client = await pool.connect();
  try {
    const customerId = customerIdOf(req);
    const listId = toId(req.params.listId);
    if (!listId) return fail(res, 400, 'Invalid list');

    const kind = req.body?.kind === 'special' ? 'special' : 'product';
    const clientItemId = text(req.body?.clientItemId, 64);
    const note = text(req.body?.note, 500);

    await client.query('BEGIN');
    const list = (await client.query(
      'SELECT * FROM shopping_lists WHERE id = $1 AND customer_id = $2 AND archived_at IS NULL FOR UPDATE',
      [listId, customerId]
    )).rows[0];
    if (!list) {
      await client.query('ROLLBACK');
      return fail(res, 404, 'List not found');
    }

    // The same request again (retry / double tap): the line it made
    if (clientItemId) {
      const existing = (await client.query(
        'SELECT id FROM shopping_list_items WHERE list_id = $1 AND client_item_id = $2', [listId, clientItemId]
      )).rows[0];
      if (existing) {
        await client.query('ROLLBACK');
        const items = await loadItems(pool, listId);
        return res.json({ success: true, duplicate: true, item: items.find((item) => item.id === existing.id), items });
      }
    }

    const count = Number((await client.query('SELECT COUNT(*) FROM shopping_list_items WHERE list_id = $1', [listId])).rows[0].count);

    let itemId;
    if (kind === 'product') {
      const productId = toId(req.body?.productId);
      const product = productId
        ? (await client.query('SELECT id, shop_id, product_name, unit FROM products WHERE id = $1', [productId])).rows[0]
        : null;
      if (!product) {
        await client.query('ROLLBACK');
        return fail(res, 404, 'That product is not in the catalogue', 'PRODUCT_NOT_FOUND');
      }
      const quantity = readQuantity(req.body?.quantity ?? 1, product.unit);
      if (quantity == null) {
        await client.query('ROLLBACK');
        return fail(res, 400, 'Choose a quantity between 1 and 999', 'BAD_QUANTITY');
      }

      // Already on the list: raise the quantity instead of a second line
      const same = (await client.query(
        "SELECT id, quantity FROM shopping_list_items WHERE list_id = $1 AND kind = 'product' AND product_id = $2 FOR UPDATE",
        [listId, product.id]
      )).rows[0];

      if (same) {
        const merged = Math.min(999, Math.round((Number(same.quantity) + quantity) * 1000) / 1000);
        await client.query(
          `UPDATE shopping_list_items
              SET quantity = $2, note = COALESCE($3, note), checked = FALSE, updated_at = NOW()
            WHERE id = $1`,
          [same.id, merged, note]
        );
        itemId = same.id;
      } else {
        if (count >= MAX_ITEMS) {
          await client.query('ROLLBACK');
          return fail(res, 400, `A list can hold up to ${MAX_ITEMS} items`, 'LIST_FULL');
        }
        itemId = (await client.query(
          `INSERT INTO shopping_list_items (list_id, customer_id, kind, product_id, shop_id, item_name, quantity, unit, note, client_item_id)
           VALUES ($1, $2, 'product', $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [listId, customerId, product.id, product.shop_id, product.product_name, quantity, product.unit || 'pcs', note, clientItemId]
        )).rows[0].id;
      }
    } else {
      const itemName = text(req.body?.itemName ?? req.body?.name, 150);
      const unit = SPECIAL_UNITS.includes(req.body?.unit) ? req.body.unit : 'pcs';
      const quantity = readQuantity(req.body?.quantity ?? 1, unit);
      const photoUrl = readPhoto(req.body?.photoUrl);
      const shopId = toId(req.body?.shopId);

      if (!itemName) {
        await client.query('ROLLBACK');
        return fail(res, 400, 'Enter the item name', 'NAME_REQUIRED');
      }
      if (quantity == null) {
        await client.query('ROLLBACK');
        return fail(res, 400, 'Choose a quantity between 1 and 999', 'BAD_QUANTITY');
      }
      if (photoUrl === undefined) {
        await client.query('ROLLBACK');
        return fail(res, 400, 'Upload the photo through the app first', 'BAD_PHOTO');
      }
      if (shopId) {
        const shop = (await client.query("SELECT id FROM shops WHERE id = $1 AND status = 'approved'", [shopId])).rows[0];
        if (!shop) {
          await client.query('ROLLBACK');
          return fail(res, 404, 'That store was not found', 'SHOP_NOT_FOUND');
        }
      }
      if (count >= MAX_ITEMS) {
        await client.query('ROLLBACK');
        return fail(res, 400, `A list can hold up to ${MAX_ITEMS} items`, 'LIST_FULL');
      }

      itemId = (await client.query(
        `INSERT INTO shopping_list_items (list_id, customer_id, kind, shop_id, item_name, brand, size, quantity, unit, note, photo_url, client_item_id)
         VALUES ($1, $2, 'special', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [listId, customerId, shopId, itemName, text(req.body?.brand, 80), text(req.body?.size, 60), quantity, unit, note, photoUrl, clientItemId]
      )).rows[0].id;
    }

    await touch(client, listId);
    await client.query('COMMIT');

    const items = await loadItems(pool, listId);
    return res.status(201).json({ success: true, item: items.find((item) => item.id === itemId), items });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Two identical requests at the same moment: the other one won
    if (error.code === '23505') {
      const items = await loadItems(pool, toId(req.params.listId)).catch(() => []);
      return res.json({ success: true, duplicate: true, items });
    }
    console.error('❌ SHOPPING LIST ADD:', error.message);
    return fail(res, 500, 'Unable to add the item');
  } finally {
    client.release();
  }
};

// PATCH /api/customer/shopping-lists/:listId/items/:itemId
//   { quantity?, note?, checked?, itemName? brand? size? unit? photoUrl? shopId? (special only) }
const updateItem = async (req, res) => {
  try {
    const customerId = customerIdOf(req);
    const listId = toId(req.params.listId);
    const itemId = toId(req.params.itemId);
    if (!listId || !itemId) return fail(res, 400, 'Invalid item');

    const row = (await pool.query(
      `SELECT li.*, p.unit AS product_unit FROM shopping_list_items li
         JOIN shopping_lists l ON l.id = li.list_id AND l.customer_id = $3 AND l.archived_at IS NULL
         LEFT JOIN products p ON p.id = li.product_id
        WHERE li.id = $1 AND li.list_id = $2`,
      [itemId, listId, customerId]
    )).rows[0];
    if (!row) return fail(res, 404, 'Item not found');

    const body = req.body || {};
    const special = row.kind === 'special';
    const unit = special && SPECIAL_UNITS.includes(body.unit) ? body.unit : (special ? row.unit : row.product_unit || row.unit);

    let quantity = Number(row.quantity);
    if (body.quantity !== undefined) {
      quantity = readQuantity(body.quantity, unit);
      if (quantity == null) return fail(res, 400, 'Choose a quantity between 1 and 999', 'BAD_QUANTITY');
    }

    let photoUrl = row.photo_url;
    if (special && body.photoUrl !== undefined) {
      photoUrl = readPhoto(body.photoUrl);
      if (photoUrl === undefined) return fail(res, 400, 'Upload the photo through the app first', 'BAD_PHOTO');
    }

    let shopId = row.shop_id;
    if (special && body.shopId !== undefined) {
      shopId = toId(body.shopId);
      if (shopId && !(await pool.query("SELECT 1 FROM shops WHERE id = $1 AND status = 'approved'", [shopId])).rows[0]) {
        return fail(res, 404, 'That store was not found', 'SHOP_NOT_FOUND');
      }
    }

    const itemName = special && body.itemName !== undefined ? text(body.itemName, 150) : row.item_name;
    if (!itemName) return fail(res, 400, 'Enter the item name', 'NAME_REQUIRED');

    await pool.query(
      `UPDATE shopping_list_items
          SET quantity = $2, unit = $3, note = $4, checked = $5, item_name = $6,
              brand = $7, size = $8, photo_url = $9, shop_id = $10, updated_at = NOW()
        WHERE id = $1`,
      [
        itemId, quantity, unit,
        body.note !== undefined ? text(body.note, 500) : row.note,
        body.checked !== undefined ? body.checked === true : row.checked,
        itemName,
        special && body.brand !== undefined ? text(body.brand, 80) : row.brand,
        special && body.size !== undefined ? text(body.size, 60) : row.size,
        photoUrl,
        shopId,
      ]
    );
    await touch(pool, listId);

    const items = await loadItems(pool, listId);
    return res.json({ success: true, item: items.find((item) => item.id === itemId), items });
  } catch (error) {
    console.error('❌ SHOPPING LIST UPDATE:', error.message);
    return fail(res, 500, 'Unable to update the item');
  }
};

// DELETE /api/customer/shopping-lists/:listId/items/:itemId
const removeItem = async (req, res) => {
  try {
    const listId = toId(req.params.listId);
    const itemId = toId(req.params.itemId);
    if (!listId || !itemId) return fail(res, 400, 'Invalid item');

    const result = await pool.query(
      `DELETE FROM shopping_list_items li
        USING shopping_lists l
        WHERE li.id = $1 AND li.list_id = $2 AND l.id = li.list_id AND l.customer_id = $3 AND l.archived_at IS NULL`,
      [itemId, listId, customerIdOf(req)]
    );
    if (result.rowCount === 0) return fail(res, 404, 'Item not found');
    await touch(pool, listId);

    return res.json({ success: true, items: await loadItems(pool, listId) });
  } catch (error) {
    console.error('❌ SHOPPING LIST REMOVE:', error.message);
    return fail(res, 500, 'Unable to remove the item');
  }
};

// POST /api/customer/shopping-lists/:listId/clear { confirm: true }
const clearList = async (req, res) => {
  try {
    const listId = toId(req.params.listId);
    if (!listId) return fail(res, 400, 'Invalid list');
    if (req.body?.confirm !== true) return fail(res, 400, 'Confirm to clear the list', 'CONFIRM_REQUIRED');

    const list = await ownList(pool, customerIdOf(req), listId);
    if (!list) return fail(res, 404, 'List not found');

    const result = await pool.query('DELETE FROM shopping_list_items WHERE list_id = $1', [listId]);
    await touch(pool, listId);
    return res.json({ success: true, removed: result.rowCount, items: [] });
  } catch (error) {
    console.error('❌ SHOPPING LIST CLEAR:', error.message);
    return fail(res, 500, 'Unable to clear the list');
  }
};

// -----------------------------------------------------
// Export: chosen lines -> the item format of the existing
// cart / quote / add-items / item-request endpoints
// POST /api/customer/shopping-lists/:listId/export { itemIds?: [], shopId? }
//   shopId: the store they go to (special requests need one; products
//   from another store are skipped, never merged into it)
// -> { items: [quote input], skipped: [{ itemId, name, reason, message }] }
// -----------------------------------------------------

const SKIP_MESSAGES = {
  no_longer_sold: 'No longer sold',
  unavailable: 'Not available right now',
  out_of_stock: 'Out of stock',
  other_store: 'From another store',
  choose_store: 'Choose a store for this special request',
};

const exportItems = async (req, res) => {
  try {
    const listId = toId(req.params.listId);
    if (!listId) return fail(res, 400, 'Invalid list');
    const list = await ownList(pool, customerIdOf(req), listId);
    if (!list) return fail(res, 404, 'List not found');

    const wanted = Array.isArray(req.body?.itemIds) ? new Set(req.body.itemIds.map(Number).filter(Boolean)) : null;
    const shopId = toId(req.body?.shopId);

    const lines = (await loadItems(pool, listId)).filter((item) => !wanted || wanted.has(item.id));
    const items = [];
    const skipped = [];
    const skip = (item, reason) => skipped.push({ itemId: item.id, name: item.name, reason, message: SKIP_MESSAGES[reason] });

    for (const item of lines) {
      if (item.kind === 'product') {
        if (!item.available) { skip(item, item.unavailableReason || 'unavailable'); continue; }
        if (shopId && Number(item.shopId) !== shopId) { skip(item, 'other_store'); continue; }
        items.push({
          listItemId: item.id,
          productId: item.productId,
          shopId: item.shopId,
          itemName: item.name,
          quantity: item.unit && LOOSE_UNITS.includes(item.unit) ? 1 : item.quantity,
          // kg / L products: quantity is the amount of the product's unit
          amount: item.unit && LOOSE_UNITS.includes(item.unit) ? item.quantity : 1,
          selectedUnit: item.unit || null,
          ...(item.note ? { note: item.note } : {}),
        });
      } else {
        const targetShop = shopId || item.shopId;
        if (!targetShop) { skip(item, 'choose_store'); continue; }
        if (shopId && item.shopId && Number(item.shopId) !== shopId) { skip(item, 'other_store'); continue; }
        const details = [
          item.brand ? `Brand: ${item.brand}` : null,
          item.size ? `Size: ${item.size}` : null,
          item.note || null,
          'Special request from the shopping list (price set in store)',
        ].filter(Boolean).join(' · ').slice(0, 500);
        items.push({
          listItemId: item.id,
          custom: true,
          shopId: targetShop,
          itemName: item.name,
          // Same as the store's own custom items: quantity + unit (2 + kg = 2 kg)
          quantity: item.quantity,
          unit: item.unit || 'pcs',
          details,
          image: item.photoUrl || null,
        });
      }
    }

    return res.json({ success: true, items, skipped });
  } catch (error) {
    console.error('❌ SHOPPING LIST EXPORT:', error.message);
    return fail(res, 500, 'Unable to prepare the items');
  }
};

module.exports = {
  getLists,
  createList,
  renameList,
  deleteList,
  getList,
  addItem,
  updateItem,
  removeItem,
  clearList,
  exportItems,
};
