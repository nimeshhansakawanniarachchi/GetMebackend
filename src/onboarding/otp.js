const crypto = require('crypto');

const pool = require('../config/db');
const sms = require('./sms');

// =====================================================
// PHONE OTP for shopper registration (phase 34)
//   send    6-digit code by SMS (Notify.lk); at most one per 60 s and
//           5 per hour per number; expires in 10 minutes
//   verify  5 tries per code; a correct code returns a one-time proof
//           (30 minutes) that the registration uses to mark the phone
//           as verified
// Codes and proofs are stored as HMACs only and never logged.
// The SMS sender can be passed in (tests); the API uses sms.js. When
// SMS isn't configured, send answers 503 SMS_NOT_CONFIGURED and the
// app continues without a verified phone (an admin confirms it).
// =====================================================

const CODE_TTL_MIN = 10;
const RESEND_AFTER_S = 60;
const MAX_PER_HOUR = 5;
const MAX_TRIES = 5;
const PROOF_TTL_MIN = 30;

const error = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });

const secret = () =>
  crypto.createHash('sha256').update(`getme-shopper-otp:${process.env.JWT_SECRET || ''}`).digest();

const hashOf = (mobile, value) => crypto.createHmac('sha256', secret()).update(`${mobile}:${value}`).digest('hex');

const sameHash = (a, b) => {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
};

// -> { sent: true, expiresInSeconds, resendInSeconds }
// purpose: 'register' | 'phone_new' | 'phone_current' | 'recovery_new'
// (phase 35); codes of one purpose can't be used for another
const sendCode = async (mobile, { send = sms.sendSms, configured = sms.isConfigured, purpose = 'register' } = {}) => {
  if (!configured()) {
    throw error(503, 'SMS verification is not set up yet. Continue without it; GetMe will confirm your number by phone.', 'SMS_NOT_CONFIGURED');
  }

  const recent = (
    await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS last_hour,
        EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))::float AS since_last
      FROM shopper_phone_otps
      WHERE mobile = $1 AND purpose = $2
      `,
      [mobile, purpose]
    )
  ).rows[0];

  if (recent.since_last != null && recent.since_last < RESEND_AFTER_S) {
    const wait = Math.ceil(RESEND_AFTER_S - recent.since_last);
    throw error(429, `Wait ${wait} seconds before asking for another code`, 'RESEND_TOO_SOON', { retryInSeconds: wait });
  }

  if (recent.last_hour >= MAX_PER_HOUR) {
    throw error(429, 'Too many codes for this number. Try again in an hour.', 'TOO_MANY_CODES');
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const row = (
    await pool.query(
      `
      INSERT INTO shopper_phone_otps (mobile, purpose, code_hash, expires_at)
      VALUES ($1, $4, $2, NOW() + ($3 || ' minutes')::interval)
      RETURNING id
      `,
      [mobile, hashOf(mobile, code), String(CODE_TTL_MIN), purpose]
    )
  ).rows[0];

  try {
    await send(mobile, `Your GetMe shopper code is ${code}. It expires in ${CODE_TTL_MIN} minutes. Never share it with anyone.`);
  } catch (caught) {
    // Not sent: the code can't be used
    await pool.query('UPDATE shopper_phone_otps SET consumed_at = NOW() WHERE id = $1', [row.id]);
    throw caught.status ? caught : error(502, 'The SMS could not be sent. Try again in a minute.', 'SMS_FAILED');
  }

  return { sent: true, expiresInSeconds: CODE_TTL_MIN * 60, resendInSeconds: RESEND_AFTER_S };
};

// -> { verified: true, proof }
const verifyCode = async (mobile, code, { purpose = 'register' } = {}) => {
  const clean = String(code || '').replace(/\D/g, '');

  if (clean.length !== 6) {
    throw error(400, 'Enter the 6-digit code', 'BAD_CODE');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const row = (
      await client.query(
        `
        SELECT * FROM shopper_phone_otps
        WHERE mobile = $1 AND purpose = $2 AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
        `,
        [mobile, purpose]
      )
    ).rows[0];

    if (!row || new Date(row.expires_at) < new Date()) {
      throw error(400, 'This code has expired. Ask for a new one.', 'CODE_EXPIRED');
    }

    if (row.attempts >= MAX_TRIES) {
      throw error(429, 'Too many wrong codes. Ask for a new one.', 'TOO_MANY_ATTEMPTS');
    }

    if (!sameHash(row.code_hash, hashOf(mobile, clean))) {
      await client.query('UPDATE shopper_phone_otps SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      const left = MAX_TRIES - row.attempts - 1;
      throw error(400, left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code. Ask for a new one.', 'WRONG_CODE', { attemptsLeft: left });
    }

    const proof = crypto.randomBytes(24).toString('base64url');

    await client.query(
      'UPDATE shopper_phone_otps SET consumed_at = NOW(), proof_hash = $2 WHERE id = $1',
      [row.id, hashOf(mobile, `proof:${proof}`)]
    );
    await client.query('COMMIT');

    return { verified: true, proof };
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }
};

// Uses a proof once (inside the caller's transaction) -> true | false
const useProof = async (client, mobile, proof) => {
  if (!proof) return false;

  const result = await client.query(
    `
    UPDATE shopper_phone_otps
    SET proof_used_at = NOW()
    WHERE mobile = $1 AND proof_hash = $2 AND proof_used_at IS NULL
      AND consumed_at > NOW() - ($3 || ' minutes')::interval
    RETURNING id
    `,
    [mobile, hashOf(mobile, `proof:${String(proof)}`), String(PROOF_TTL_MIN)]
  );

  return result.rowCount === 1;
};

module.exports = { sendCode, verifyCode, useProof, isConfigured: sms.isConfigured };
