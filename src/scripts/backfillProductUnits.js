const pool = require('../config/db');

// =====================================================
// ONE-TIME: set products.unit (item | kg | L)
// Names with a size ("5kg", "1.5L", "80ml") are packs -> item.
// Otherwise use the customer app's old guess (drinks/dairy -> L,
// bakery/eggs/bottles -> item, everything else -> kg).
// Usage: node src/scripts/backfillProductUnits.js [--dry-run]
// =====================================================

const guessUnit = (name, category) => {
  const n = String(name || '').toLowerCase();
  const c = String(category || '').toLowerCase();

  if (/\d+(\.\d+)?\s*(kg|g|l|ml|pcs|pack)\b/.test(n)) {
    return 'item';
  }

  if (/(milk|juice|oil|water)/.test(n) || /(dairy|drink|beverage)/.test(c)) {
    return 'L';
  }

  if (/(bread|egg|bottle|can\b)/.test(n) || /bakery/.test(c)) {
    return 'item';
  }

  return 'kg';
};

const run = async () => {
  const dryRun = process.argv.includes('--dry-run');

  try {
    const result = await pool.query(
      'SELECT id, product_name, category, price, unit FROM products ORDER BY id'
    );

    for (const product of result.rows) {
      const unit = guessUnit(product.product_name, product.category);

      console.log(
        `${String(product.id).padStart(4)}  ${unit.padEnd(4)}  Rs ${product.price}  ${product.product_name} [${product.category}]`
      );

      if (!dryRun) {
        await pool.query('UPDATE products SET unit = $1 WHERE id = $2', [unit, product.id]);
      }
    }

    console.log(dryRun ? '\n(dry run, nothing saved)' : `\n✅ Updated ${result.rows.length} products`);
  } catch (error) {
    console.error('❌', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
