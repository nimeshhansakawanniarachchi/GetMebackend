const pool = require('../config/db');
const { broadcastCatalogChange } = require('../realtime');

// =====================================================
// SHOP STOCK (product_stock_movements, phase 27)
// Every change to products.stock_quantity goes through here so it
// is locked, never negative, and recorded with who / why.
//
// Reasons a shop picks for a manual adjustment:
//   received, count, damaged, expired, sold_in_store, returned,
//   correction, other
// Recorded automatically:
//   initial (new product), edit (product form / quick edit),
//   import (spreadsheet), sold_getme (a GetMe shopper bought it)
// =====================================================

const MANUAL_REASONS = ['received', 'count', 'damaged', 'expired', 'sold_in_store', 'returned', 'correction', 'other'];
const MAX_STOCK = 1000000;

const REASON_LABELS = {
  received: 'Stock received',
  count: 'Stock count',
  damaged: 'Damaged',
  expired: 'Expired',
  sold_in_store: 'Sold in store',
  returned: 'Customer return',
  correction: 'Correction',
  other: 'Other',
  initial: 'Opening stock',
  edit: 'Edited',
  import: 'Spreadsheet import',
  sold_getme: 'GetMe order',
};

const recordMovement = (db, { shopId, productId, before, after, reason, note = null, orderId = null, orderItemId = null, actor }) =>
  db.query(
    `
    INSERT INTO product_stock_movements
      (shop_id, product_id, change, stock_before, stock_after, reason, note, order_id, order_item_id, actor_type, actor_id, actor_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
    `,
    [
      shopId, productId, after - before, before, after, reason,
      note ? String(note).slice(0, 300) : null, orderId, orderItemId,
      actor?.type || 'system', actor?.id ?? null, actor?.name ? String(actor.name).slice(0, 120) : null,
    ]
  );

// Records a stock change already written by other code (product form,
// quick edit, import). No row when the stock didn't change.
const recordChange = async (db, args) => {
  if (Number(args.before) === Number(args.after)) return null;
  return (await recordMovement(db, { ...args, before: Number(args.before), after: Number(args.after) })).rows[0];
};

// Manual adjustment from the portal.
// mode: set (new count) | add | remove
// -> { product, movement } or { error: { status, message } }
const adjustStock = async ({ shopId, productId, mode, quantity, reason, note, actor }) => {
  const qty = Number(quantity);

  if (!['set', 'add', 'remove'].includes(mode)) {
    return { error: { status: 400, message: 'Choose set, add or remove' } };
  }

  if (!Number.isInteger(qty) || qty < 0 || qty > MAX_STOCK || (mode !== 'set' && qty === 0)) {
    return { error: { status: 400, message: mode === 'set' ? 'Enter the stock count as a whole number (0 or more)' : 'Enter a whole number of units (1 or more)' } };
  }

  if (!MANUAL_REASONS.includes(reason)) {
    return { error: { status: 400, message: 'Choose a reason for the change' } };
  }

  if (reason === 'other' && String(note || '').trim().length < 3) {
    return { error: { status: 400, message: 'Add a note explaining the change' } };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const product = (
      await client.query('SELECT * FROM products WHERE id = $1 AND shop_id = $2 FOR UPDATE', [productId, shopId])
    ).rows[0];

    if (!product) {
      await client.query('ROLLBACK');
      return { error: { status: 404, message: 'Product not found' } };
    }

    const before = Number(product.stock_quantity || 0);
    const after = mode === 'set' ? qty : mode === 'add' ? before + qty : before - qty;

    if (after < 0) {
      await client.query('ROLLBACK');
      return { error: { status: 409, code: 'NEGATIVE_STOCK', message: `Only ${before} in stock; you can't remove ${qty}.` } };
    }

    if (after > MAX_STOCK) {
      await client.query('ROLLBACK');
      return { error: { status: 400, message: 'Stock is too large' } };
    }

    const updated = (
      await client.query(
        'UPDATE products SET stock_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
        [after, productId]
      )
    ).rows[0];

    const movement = after === before
      ? null
      : (await recordMovement(client, { shopId, productId, before, after, reason, note, actor })).rows[0];

    await client.query('COMMIT');
    return { product: updated, movement };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

// A GetMe shopper confirmed an item (found / replaced): the product
// bought loses that many units of listed stock. One deduction per
// order item (unique index), never below zero. Weighed items deduct
// whole kg / L, rounded up. Never throws (logs instead).
const deductForOrderItem = async (orderItemId, io) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const item = (
      await client.query(
        `
        SELECT oi.id, oi.order_id, oi.shop_id, oi.product_id, oi.quantity, oi.found_quantity,
               oi.found_weight, oi.found_weight_unit, oi.shopping_status, oi.replacement_product_id
        FROM order_items oi WHERE oi.id = $1
        `,
        [orderItemId]
      )
    ).rows[0];

    if (!item || !['found', 'replaced'].includes(item.shopping_status)) {
      await client.query('ROLLBACK');
      return null;
    }

    const productId = item.shopping_status === 'replaced' && item.replacement_product_id
      ? Number(item.replacement_product_id)
      : Number(item.product_id);

    if (!productId) {
      await client.query('ROLLBACK');
      return null; // custom request with no catalogue product
    }

    const weight = Number(item.found_weight);
    const units = weight > 0
      ? Math.ceil(['g', 'ml'].includes(String(item.found_weight_unit || '').toLowerCase()) ? weight / 1000 : weight)
      : Math.ceil(Number(item.found_quantity) > 0 ? Number(item.found_quantity) : Number(item.quantity) || 1);

    const product = (
      await client.query('SELECT id, shop_id, stock_quantity FROM products WHERE id = $1 FOR UPDATE', [productId])
    ).rows[0];

    if (!product) {
      await client.query('ROLLBACK');
      return null;
    }

    const before = Number(product.stock_quantity || 0);
    const after = Math.max(0, before - units);

    // Claims the order item first: a repeat call stops here
    const claimed = await client.query(
      `
      INSERT INTO product_stock_movements
        (shop_id, product_id, change, stock_before, stock_after, reason, note, order_id, order_item_id, actor_type, actor_name)
      VALUES ($1, $2, $3, $4, $5, 'sold_getme', $6, $7, $8, 'system', 'GetMe order')
      ON CONFLICT (order_item_id) WHERE reason = 'sold_getme' DO NOTHING
      RETURNING id
      `,
      [
        product.shop_id, productId, after - before, before, after,
        after - before !== -units ? `Bought ${units}; stock was ${before}` : `Bought ${units}`,
        item.order_id, item.id,
      ]
    );

    if (claimed.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query('UPDATE products SET stock_quantity = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [after, productId]);
    await client.query('COMMIT');

    broadcastCatalogChange(io, product.shop_id, 'products');
    io?.to(`shop:${product.shop_id}`).emit('shop:stock-changed', { productId, stockQuantity: after, orderId: item.order_id });

    return { productId, before, after };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ STOCK DEDUCTION ERROR:', orderItemId, error.message);
    return null;
  } finally {
    client.release();
  }
};

module.exports = {
  MANUAL_REASONS,
  REASON_LABELS,
  recordChange,
  adjustStock,
  deductForOrderItem,
};
