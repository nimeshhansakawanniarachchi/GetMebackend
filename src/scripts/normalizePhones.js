const pool = require('../config/db');

const {
  normalizeSriLankanMobile,
  normalizeSriLankanPhone,
} = require('../utils/phone');

// =====================================================
// ONE-TIME: store every phone number as +94XXXXXXXXX
// Reports invalid numbers and numbers that would clash, and
// leaves those rows untouched.
// Usage: node src/scripts/normalizePhones.js [--dry-run]
// =====================================================

const TABLES = [
  { table: 'customers', normalize: normalizeSriLankanMobile },
  { table: 'shoppers', normalize: normalizeSriLankanMobile },
  { table: 'shops', normalize: normalizeSriLankanPhone },
];

const run = async () => {
  const dryRun = process.argv.includes('--dry-run');

  try {
    for (const { table, normalize } of TABLES) {
      const result = await pool.query(`SELECT id, mobile FROM ${table} ORDER BY id`);
      const taken = new Map();

      result.rows.forEach((row) => taken.set(row.mobile, row.id));

      for (const row of result.rows) {
        const normalized = normalize(row.mobile);

        if (!row.mobile) {
          continue;
        }

        if (!normalized) {
          console.log(`⚠️  ${table} #${row.id}: "${row.mobile}" is not a valid Sri Lankan number — skipped`);
          continue;
        }

        if (normalized === row.mobile) {
          continue;
        }

        const owner = taken.get(normalized);

        if (owner && owner !== row.id) {
          console.log(`⚠️  ${table} #${row.id}: ${row.mobile} -> ${normalized} clashes with #${owner} — skipped`);
          continue;
        }

        console.log(`   ${table} #${row.id}: ${row.mobile} -> ${normalized}`);

        if (!dryRun) {
          await pool.query(`UPDATE ${table} SET mobile = $1 WHERE id = $2`, [normalized, row.id]);
        }

        taken.delete(row.mobile);
        taken.set(normalized, row.id);
      }
    }

    console.log(dryRun ? '\n(dry run, nothing saved)' : '\n✅ Phone numbers normalized');
  } catch (error) {
    console.error('❌', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
