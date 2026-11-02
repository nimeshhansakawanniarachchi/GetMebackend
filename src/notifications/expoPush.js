const db = require('../config/db');

// =====================================================
// EXPO PUSH (shared by chat and customer notifications)
// Sends one message to every registered token of an owner
// (push_tokens; apps built with push support register them).
// -> { status: 'sent' | 'no_device' | 'failed', error? }
// Tokens of uninstalled apps (DeviceNotRegistered) are removed.
// =====================================================

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const sendExpoPush = async (owner, { title, body, data, channelId = 'default' }) => {
  try {
    const tokens = (
      await db.query('SELECT token FROM push_tokens WHERE owner_type = $1 AND owner_id = $2', [owner.type, owner.id])
    ).rows.map((row) => row.token);

    if (tokens.length === 0) return { status: 'no_device' };

    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(
        tokens.map((to) => ({ to, title, body, data, sound: 'default', channelId, priority: 'high' }))
      ),
      signal: AbortSignal.timeout(10000),
    });

    const result = await response.json().catch(() => ({}));
    const tickets = Array.isArray(result?.data) ? result.data : [];

    const dead = tickets
      .map((ticket, index) => (ticket?.details?.error === 'DeviceNotRegistered' ? tokens[index] : null))
      .filter(Boolean);

    if (dead.length > 0) {
      await db.query('DELETE FROM push_tokens WHERE token = ANY($1)', [dead]);
    }

    if (!response.ok) return { status: 'failed', error: `Expo push HTTP ${response.status}` };

    // Delivered to Expo for at least one device
    if (tickets.some((ticket) => ticket?.status === 'ok')) return { status: 'sent' };

    // Every device was unregistered: nothing left to send to
    if (dead.length === tokens.length) return { status: 'no_device' };

    const message = tickets.find((ticket) => ticket?.message)?.message || result?.errors?.[0]?.message || 'No push ticket';
    return { status: 'failed', error: String(message).slice(0, 300) };
  } catch (error) {
    return { status: 'failed', error: String(error?.message || error).slice(0, 300) };
  }
};

module.exports = { sendExpoPush };
