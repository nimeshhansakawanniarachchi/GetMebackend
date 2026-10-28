// =====================================================
// SMS SENDER (phase 34): Notify.lk (owner's choice 2026-10-28)
// https://app.notify.lk/api/v1/send?user_id=&api_key=&sender_id=&to=94XXXXXXXXX&message=
// Configure in .env (never commit):
//   NOTIFY_LK_USER_ID, NOTIFY_LK_API_KEY, NOTIFY_LK_SENDER_ID
// (sender ID "NotifyDEMO" works for testing on a Notify.lk account; a
// own sender ID needs Notify.lk approval).
// Not configured -> isConfigured() is false and nothing is sent: the
// registration flow then records the phone as not verified (an admin
// confirms it) instead of pretending a code was sent.
// The message text (with the code) is never logged.
// =====================================================

const NOTIFY_URL = 'https://app.notify.lk/api/v1/send';

const config = () => ({
  userId: String(process.env.NOTIFY_LK_USER_ID || '').trim(),
  apiKey: String(process.env.NOTIFY_LK_API_KEY || '').trim(),
  senderId: String(process.env.NOTIFY_LK_SENDER_ID || '').trim(),
});

const isConfigured = () => {
  const { userId, apiKey, senderId } = config();
  return Boolean(userId && apiKey && senderId);
};

// +94771234567 -> 94771234567 (Notify.lk format)
const toNotifyNumber = (mobile) => String(mobile || '').replace(/\D/g, '').replace(/^0/, '94');

// -> { ok: true, id } | throws
const sendSms = async (mobile, message) => {
  if (!isConfigured()) {
    throw Object.assign(new Error('SMS is not configured'), { status: 503, code: 'SMS_NOT_CONFIGURED' });
  }

  const { userId, apiKey, senderId } = config();
  const url = new URL(NOTIFY_URL);
  url.searchParams.set('user_id', userId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('sender_id', senderId);
  url.searchParams.set('to', toNotifyNumber(mobile));
  url.searchParams.set('message', message);

  let response;

  try {
    response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000) });
  } catch (error) {
    throw Object.assign(new Error('Could not reach the SMS service'), { status: 502, code: 'SMS_FAILED', cause: error.message });
  }

  const body = await response.json().catch(() => null);

  if (!response.ok || body?.status !== 'success') {
    // Log the provider's status only (no number, no message)
    console.error('❌ SMS SEND FAILED:', response.status, body?.status || '', body?.message ? String(body.message).slice(0, 80) : '');
    throw Object.assign(new Error('The SMS could not be sent. Try again in a minute.'), { status: 502, code: 'SMS_FAILED' });
  }

  return { ok: true, id: body?.data?.id ?? null };
};

module.exports = { isConfigured, sendSms };
