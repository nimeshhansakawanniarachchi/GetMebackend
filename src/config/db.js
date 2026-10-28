const { Pool } = require('pg');
require('dotenv').config();

// Offer start/end times, slots and opening hours are Sri Lanka times
// stored without a zone, so Node and Postgres must both read them as
// Asia/Colombo, whatever zone the server runs in.
const TIME_ZONE = 'Asia/Colombo';
process.env.TZ = TIME_ZONE;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: `-c timezone=${TIME_ZONE}`,
});

pool.on('connect', () => {
  console.log('✅ PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err.message);
});

module.exports = pool;