const fs = require('fs');
const path = require('path');

const pool = require('../config/db');

// ==================================================
// RUN A SQL FILE AGAINST THE DATABASE
// Usage: node src/sql/runSql.js src/sql/customer_addresses.sql
// ==================================================

const run = async () => {
  const file = process.argv[2];

  if (!file) {
    console.error('Usage: node src/sql/runSql.js <file.sql>');
    process.exit(1);
  }

  try {
    const sql = fs.readFileSync(
      path.resolve(file),
      'utf8'
    );

    await pool.query(sql);

    console.log(`✅ Ran ${file}`);
  } catch (error) {
    console.error('❌ SQL ERROR:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
