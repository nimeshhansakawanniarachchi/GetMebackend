const jwt = require('jsonwebtoken');

const pool = require('../config/db');

// =====================================================
// SHOPPER SESSIONS (phase 35)
// A shopper token carries av = shoppers.auth_version at sign-in. After
// a phone change / recovery the version is bumped, so every older
// token (other phones, a stolen session) stops working, sockets
// included. Tokens from before phase 35 have no av: they count as 0
// and keep working until the first bump.
// The version is cached for a few seconds per shopper (every API call
// checks it); a bump in this process clears the cache at once.
// =====================================================

const CACHE_MS = 10 * 1000;
const cache = new Map();

const signShopperToken = (shopper) =>
  jwt.sign(
    { shopperId: shopper.id, email: shopper.email, av: Number(shopper.auth_version || 0) },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

const currentVersion = async (shopperId) => {
  const hit = cache.get(shopperId);

  if (hit && hit.at > Date.now() - CACHE_MS) return hit.version;

  const row = (await pool.query('SELECT auth_version FROM shoppers WHERE id = $1', [shopperId])).rows[0];
  const version = row ? Number(row.auth_version || 0) : null;

  cache.set(shopperId, { version, at: Date.now() });

  return version;
};

// decoded JWT -> true when the shopper exists and the token's version
// is the current one
const isSessionCurrent = async (decoded) => {
  const shopperId = Number(decoded?.shopperId ?? decoded?.shopper_id);

  if (!Number.isInteger(shopperId) || shopperId <= 0) return false;

  const version = await currentVersion(shopperId);

  return version !== null && Number(decoded.av || 0) === version;
};

// Inside the caller's transaction; -> the new version
const revokeSessions = async (client, shopperId) => {
  const row = (
    await client.query(
      'UPDATE shoppers SET auth_version = auth_version + 1, updated_at = NOW() WHERE id = $1 RETURNING auth_version',
      [shopperId]
    )
  ).rows[0];

  cache.delete(Number(shopperId));

  return Number(row?.auth_version || 0);
};

// After commit: drop the shopper's live sockets (they reconnect with a
// token, which must be the new one)
const disconnectShopper = (io, shopperId) => {
  cache.delete(Number(shopperId));

  try {
    io?.in(`shopper:${shopperId}`).disconnectSockets(true);
  } catch {
    // best effort
  }
};

const SESSION_ENDED = {
  success: false,
  code: 'SESSION_ENDED',
  message: 'Your account details changed. Sign in again.',
};

module.exports = { signShopperToken, isSessionCurrent, revokeSessions, disconnectShopper, SESSION_ENDED };
