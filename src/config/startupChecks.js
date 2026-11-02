// =====================================================
// START-UP SECURITY CHECKS (security review B-04 / M-04, 2026-10-30)
//
// NODE_ENV=production: the server refuses to start when a setting would
// make it fall back to development behaviour (fake card gateway, keys
// derived from the JWT secret, a weak signing secret). Anywhere else the
// same problems are printed as warnings, so development keeps working.
// No values are printed - only variable names.
// =====================================================

const HEX64 = /^[0-9a-fA-F]{64}$/;

const problems = () => {
  const list = [];
  const env = process.env;
  const secret = String(env.JWT_SECRET || '');

  if (secret.length < 32) list.push('JWT_SECRET is shorter than 32 characters (use 32+ random bytes)');

  const payhere = String(env.PAYHERE_MODE || '').trim().toLowerCase();
  if (!payhere) list.push('PAYHERE_MODE is not set (test mode is used outside production; set test, sandbox or live explicitly)');
  else if (payhere === 'test') list.push('PAYHERE_MODE=test: card payments use the fake test gateway');
  // Payment audit P-03 (2026-10-31): sandbox money is not real money
  else if (payhere === 'sandbox') list.push('PAYHERE_MODE=sandbox: card payments use PayHere test cards (no real money)');
  else if (payhere !== 'live') list.push(`PAYHERE_MODE has an unknown value (use test, sandbox or live)`);
  if (payhere === 'live' || payhere === 'sandbox') {
    const missing = ['PAYHERE_MERCHANT_ID', 'PAYHERE_MERCHANT_SECRET', 'PAYHERE_APP_ID', 'PAYHERE_APP_SECRET', 'PUBLIC_API_URL']
      .filter((name) => !String(env[name] || '').trim());
    if (missing.length) list.push(`PAYHERE_MODE=${payhere} needs ${missing.join(', ')}`);
    if (env.PUBLIC_API_URL && !String(env.PUBLIC_API_URL).trim().toLowerCase().startsWith('https://')) list.push('PUBLIC_API_URL must be https:// for PayHere notifications');
  }
  // Live card keys on a server that isn't marked production would still
  // use development fallbacks (derived keys, test gateways elsewhere)
  if (payhere === 'live' && env.NODE_ENV !== 'production') list.push('PAYHERE_MODE=live needs NODE_ENV=production');

  // Company LankaQR payments: the simulator is never real money
  const qrProvider = String(env.GROCERY_QR_PROVIDER || '').trim().toLowerCase();
  if (qrProvider === 'simulator') list.push('GROCERY_QR_PROVIDER=simulator: company LankaQR payments are simulated');

  [
    ['CARD_TOKEN_KEY', 'saved-card tokens'],
    ['ADMIN_MFA_KEY', 'admin two-step secrets'],
  ].forEach(([name, what]) => {
    if (!HEX64.test(String(env[name] || '').trim())) list.push(`${name} is not set (64 hex characters); ${what} use a key derived from JWT_SECRET`);
  });

  ['BILL_URL_SECRET', 'SUPPORT_PHOTO_URL_SECRET'].forEach((name) => {
    if (String(env[name] || '').length < 32) list.push(`${name} is not set; private file links are signed with a key derived from JWT_SECRET`);
  });

  return list;
};

const run = () => {
  const list = problems();
  if (list.length === 0) return;

  if (process.env.NODE_ENV === 'production') {
    console.error('❌ SECURITY: refusing to start in production:');
    list.forEach((item) => console.error(`   - ${item}`));
    process.exit(1);
  }

  console.warn('⚠️  SECURITY (development settings - fix before production):');
  list.forEach((item) => console.warn(`   - ${item}`));
};

module.exports = { run, problems };
