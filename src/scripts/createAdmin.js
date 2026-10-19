const bcrypt = require('bcryptjs');

const pool = require('../config/db');

// =====================================================
// CREATE (OR RESET) AN ADMIN ACCOUNT
// Usage:
//   node src/scripts/createAdmin.js <email> <password> "<Full Name>"
// Running it again for the same email resets that admin's password.
// =====================================================

const run = async () => {
  const [email, password, fullName = 'GetMe Admin'] = process.argv.slice(2);

  if (!email || !password) {
    console.error(
      'Usage: node src/scripts/createAdmin.js <email> <password> "<Full Name>"'
    );
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO admins (full_name, email, password_hash)
      VALUES ($1, LOWER($2), $3)
      ON CONFLICT (email)
      DO UPDATE SET
        password_hash = EXCLUDED.password_hash,
        full_name = EXCLUDED.full_name,
        is_active = true
      RETURNING id, email, (xmax = 0) AS created
      `,
      [fullName.trim(), email.trim(), passwordHash]
    );

    const admin = result.rows[0];

    console.log(
      admin.created
        ? `✅ Admin created: ${admin.email} (id ${admin.id})`
        : `✅ Admin password reset: ${admin.email} (id ${admin.id})`
    );
  } catch (error) {
    console.error('❌ Could not create admin:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

run();
