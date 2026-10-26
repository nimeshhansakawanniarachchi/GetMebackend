const crypto = require('crypto');

// =====================================================
// PAYHERE GATEWAY (Sri Lanka)
// Saved cards use two PayHere APIs:
//   Preapproval API - the card is entered on PayHere's own page;
//                     PayHere posts a customer_token to notify_url
//   Charging API    - charges that token (no card details needed)
//   Refund API      - full or partial refund of a charge
// Docs: https://support.payhere.lk/api-&-mobile-sdk/
//
// PAYHERE_MODE:
//   live    - www.payhere.lk
//   sandbox - sandbox.payhere.lk (PayHere test cards)
//   test    - no PayHere at all: a local stand-in page and fake
//             charges, so the apps can be tried on a LAN without
//             keys or a public URL. Refused when NODE_ENV=production.
// Unset: test in development, off in production.
// =====================================================

const HOSTS = {
  sandbox: 'https://sandbox.payhere.lk',
  live: 'https://www.payhere.lk',
};

const CURRENCY = 'LKR';

// Cards PayHere's sandbox accepts, and one the test mode declines
const TEST_CARDS = {
  '4916217501611292': { brand: 'VISA', outcome: 'ok' },
  '4000000000000002': { brand: 'VISA', outcome: 'decline' },
  '5307732125531191': { brand: 'MASTER', outcome: 'ok' },
};

const getMode = () => {
  const mode = String(process.env.PAYHERE_MODE || '').trim().toLowerCase();

  if (mode === 'live' || mode === 'sandbox') {
    return mode;
  }

  if (process.env.NODE_ENV === 'production') {
    return null;
  }

  return mode === '' || mode === 'test' ? 'test' : null;
};

const isTestMode = () => getMode() === 'test';

// Why card payments can't run (null = they can)
const configProblem = () => {
  const mode = getMode();

  if (!mode) {
    return 'Card payments are not set up on this server';
  }

  if (mode === 'test') {
    return null;
  }

  const missing = [
    'PAYHERE_MERCHANT_ID',
    'PAYHERE_MERCHANT_SECRET',
    'PAYHERE_APP_ID',
    'PAYHERE_APP_SECRET',
    'PUBLIC_API_URL',
    'CARD_TOKEN_KEY',
  ].filter((key) => !String(process.env[key] || '').trim());

  return missing.length > 0
    ? `Card payments need ${missing.join(', ')} in the server .env`
    : null;
};

const formatAmount = (amount) => Number(amount).toFixed(2);

// PayHere's fee on a charge, GetMe's cost (recorded with the
// payment, never taken from the shopper). PAYHERE_FEE_PERCENT is
// the rate in GetMe's PayHere agreement.
const gatewayFeeFor = (amount) => {
  const percent = Number(process.env.PAYHERE_FEE_PERCENT ?? 3.3);
  const rate = Number.isFinite(percent) && percent >= 0 ? percent : 3.3;

  return Math.round(Number(amount) * rate) / 100;
};

const md5Upper = (value) =>
  crypto.createHash('md5').update(String(value)).digest('hex').toUpperCase();

const merchantSecretHash = () => md5Upper(process.env.PAYHERE_MERCHANT_SECRET || '');

// Same strings, constant time
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

// Public base URL PayHere calls back on (notify) and the app's
// web view returns to. Test mode: the address the phone used.
const publicBaseUrl = (req) => {
  const configured = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');

  if (configured) {
    return configured;
  }

  return `${req.protocol}://${req.get('host')}`;
};

// =====================================================
// PREAPPROVAL (save a card)
// The form the checkout page auto-submits. No amount: PayHere
// only saves the card. Hash without an amount uses 10.00 for LKR.
// =====================================================

const preapprovalForm = ({ ref, payer, baseUrl }) => {
  const returnUrl = `${baseUrl}/api/payments/cards/return?ref=${encodeURIComponent(ref)}`;
  const cancelUrl = `${baseUrl}/api/payments/cards/cancel?ref=${encodeURIComponent(ref)}`;

  if (isTestMode()) {
    return {
      action: `${baseUrl}/api/payments/test-gateway/preapprove`,
      fields: { order_id: ref, return_url: returnUrl, cancel_url: cancelUrl },
    };
  }

  const merchantId = process.env.PAYHERE_MERCHANT_ID;

  return {
    action: `${HOSTS[getMode()]}/pay/preapprove`,
    fields: {
      merchant_id: merchantId,
      return_url: returnUrl,
      cancel_url: cancelUrl,
      notify_url: `${baseUrl}/api/payments/payhere/notify`,
      first_name: payer.firstName,
      last_name: payer.lastName,
      email: payer.email,
      phone: payer.phone,
      address: payer.address,
      city: payer.city,
      country: 'Sri Lanka',
      order_id: ref,
      items: 'Save card for GetMe payments',
      currency: CURRENCY,
      hash: md5Upper(`${merchantId}${ref}${formatAmount(10)}${CURRENCY}${merchantSecretHash()}`),
    },
  };
};

// notify_url body is genuine PayHere (md5sig matches)
const verifyNotify = (body) => {
  if (isTestMode() || !body) {
    return false;
  }

  const expected = md5Upper(
    `${body.merchant_id}${body.order_id}${body.payhere_amount}` +
      `${body.payhere_currency}${body.status_code}${merchantSecretHash()}`
  );

  return (
    safeEqual(body.merchant_id, process.env.PAYHERE_MERCHANT_ID) &&
    safeEqual(String(body.md5sig || '').toUpperCase(), expected)
  );
};

// =====================================================
// OAUTH (Charging + Refund APIs)
// One access token, reused until shortly before it expires
// =====================================================

let cachedToken = null;

const getAccessToken = async () => {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.value;
  }

  const basic = Buffer.from(
    `${process.env.PAYHERE_APP_ID}:${process.env.PAYHERE_APP_SECRET}`
  ).toString('base64');

  const response = await fetch(`${HOSTS[getMode()]}/merchant/v1/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || 'PayHere sign-in failed');
  }

  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(30, Number(data.expires_in || 0) - 30) * 1000,
  };

  return cachedToken.value;
};

const merchantApi = async (path, body) => {
  const send = async () =>
    fetch(`${HOSTS[getMode()]}/merchant/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

  let response = await send();

  // Token expired early: one fresh try
  if (response.status === 401) {
    cachedToken = null;
    response = await send();
  }

  return response.json().catch(() => ({}));
};

const CHARGE_STATUS = { 2: 'paid', 0: 'pending', '-1': 'failed', '-2': 'failed' };

// =====================================================
// CHARGE A SAVED CARD
// -> { status: 'paid' | 'pending' | 'failed', gatewayPaymentId, message }
// Never throws for a decline; throws only when PayHere can't be
// reached (the caller treats that as failed).
// =====================================================

const chargeToken = async ({ ref, amount, items, token, baseUrl, custom1, custom2 }) => {
  if (isTestMode()) {
    if (String(token).startsWith('test_decline_')) {
      return { status: 'failed', gatewayPaymentId: null, message: 'Card declined (test card)' };
    }

    if (!String(token).startsWith('test_ok_')) {
      return { status: 'failed', gatewayPaymentId: null, message: 'Invalid token' };
    }

    return {
      status: 'paid',
      gatewayPaymentId: `TEST${Date.now()}${crypto.randomInt(100, 999)}`,
      message: 'Test payment successful',
    };
  }

  const data = await merchantApi('/payment/charge', {
    type: 'PAYMENT',
    order_id: ref,
    items: String(items || 'GetMe payment').slice(0, 100),
    currency: CURRENCY,
    amount: Number(formatAmount(amount)),
    customer_token: token,
    custom_1: custom1 ?? null,
    custom_2: custom2 ?? null,
    notify_url: `${baseUrl}/api/payments/payhere/notify`,
  });

  if (data?.status !== 1 || !data?.data) {
    return {
      status: 'failed',
      gatewayPaymentId: null,
      message: data?.msg || data?.error_description || 'Payment failed',
    };
  }

  return {
    status: CHARGE_STATUS[String(data.data.status_code)] || 'failed',
    gatewayPaymentId: data.data.payment_id != null ? String(data.data.payment_id) : null,
    message: data.data.status_message || data.msg,
  };
};

// =====================================================
// LOOK UP A CHARGE (Retrieval API)
// When the Charging API didn't answer, ask PayHere what happened
// to our order_id before deciding.
// -> { status: 'paid' | 'not_found' | 'unknown', gatewayPaymentId }
// =====================================================

const findCharge = async ({ ref, amount }) => {
  if (isTestMode()) {
    return { status: 'not_found', gatewayPaymentId: null };
  }

  try {
    const response = await fetch(
      `${HOSTS[getMode()]}/merchant/v1/payment/search?order_id=${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${await getAccessToken()}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(20000),
      }
    );

    const data = await response.json().catch(() => ({}));

    if (response.ok && data?.status === 1 && Array.isArray(data.data)) {
      const received = data.data.find(
        (payment) =>
          payment?.status === 'RECEIVED' &&
          Math.abs(Number(payment.amount) - Number(amount)) < 0.01
      );

      if (received) {
        return { status: 'paid', gatewayPaymentId: String(received.payment_id) };
      }
    }

    if (response.ok && data?.status === -1 && /no payments/i.test(String(data?.msg || ''))) {
      return { status: 'not_found', gatewayPaymentId: null };
    }
  } catch (error) {
    console.error('❌ PAYHERE LOOKUP ERROR:', ref, error.message);
  }

  return { status: 'unknown', gatewayPaymentId: null };
};

// =====================================================
// REFUND (full when amount is omitted)
// -> { ok, refundId, message }
// =====================================================

const refundCharge = async ({ gatewayPaymentId, amount, reason }) => {
  if (isTestMode()) {
    return { ok: true, refundId: `TESTR${Date.now()}`, message: 'Test refund processed' };
  }

  const data = await merchantApi('/payment/refund', {
    payment_id: String(gatewayPaymentId),
    description: String(reason || 'GetMe refund').slice(0, 100),
    ...(amount != null ? { amount: formatAmount(amount) } : {}),
  });

  return {
    ok: data?.status === 1,
    refundId: data?.data != null ? String(data.data) : null,
    message: data?.msg || 'Refund failed',
  };
};

// =====================================================
// TEST MODE CARD (stand-in for PayHere's card page)
// Only PayHere's published test numbers are accepted so a real
// card number is never typed into the stand-in page.
// -> { token, brand, last4 } or { error }
// =====================================================

const testCardToken = ({ number, expiry, cvv }) => {
  const digits = String(number || '').replace(/\D/g, '');
  const card = TEST_CARDS[digits];

  if (!card) {
    return { error: 'Use one of the test card numbers listed on this page' };
  }

  const match = String(expiry || '').trim().match(/^(\d{2})\s*\/\s*(\d{2})$/);
  const month = match ? Number(match[1]) : 0;

  if (!match || month < 1 || month > 12) {
    return { error: 'Enter the expiry as MM/YY' };
  }

  const now = new Date();
  const expiresAt = new Date(2000 + Number(match[2]), month, 1);

  if (expiresAt <= now) {
    return { error: 'This card has expired' };
  }

  if (!/^\d{3}$/.test(String(cvv || '').trim())) {
    return { error: 'Enter the 3-digit CVV' };
  }

  return {
    token: `test_${card.outcome}_${crypto.randomBytes(12).toString('hex')}`,
    brand: card.brand,
    last4: digits.slice(-4),
    expiry: `${match[1]}${match[2]}`,
  };
};

module.exports = {
  CURRENCY,
  TEST_CARDS,
  getMode,
  isTestMode,
  configProblem,
  formatAmount,
  gatewayFeeFor,
  publicBaseUrl,
  preapprovalForm,
  verifyNotify,
  chargeToken,
  findCharge,
  refundCharge,
  testCardToken,
};
