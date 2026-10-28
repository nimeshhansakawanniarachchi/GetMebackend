const os = require('os');

const pool = require('../config/db');

// =====================================================
// TECHNICAL HEALTH + ERROR LOG for the Developer role (phase 40)
//   GET /api/admin/system/health   system.health
//   GET /api/admin/system/errors   system.logs
// Only technical facts: no customer data, no request bodies, no
// secrets. Integrations show "configured: yes / no" only. The error log
// keeps, in memory since the last restart, every 5xx answer (method,
// route pattern with ids replaced, status, time taken) and how often
// each server error label ("❌ SAVE STORE PAYMENT ERROR") was logged -
// the label only, never the message after it.
// =====================================================

const MAX = 200;
const responses = [];
const labels = new Map();
const startedAt = new Date();

// /api/admin/orders/123/refund?x=1 -> /api/admin/orders/:id/refund
const routePattern = (url) =>
  String(url || '')
    .split('?')[0]
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, '/:uuid')
    .slice(0, 160);

// Express middleware: remember server errors (5xx)
const trackResponses = (req, res, next) => {
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    if (res.statusCode < 500) return;
    // Developer notification, grouped per route per hour (phase 41)
    notifySystem({
      event: 'system.server_error',
      severity: 'warning',
      title: `Server errors: ${req.method} ${routePattern(req.originalUrl)}`,
      body: `{n} failed request(s) this hour (last status ${res.statusCode}).`,
      key: `${req.method} ${routePattern(req.originalUrl)}`,
    });
    responses.unshift({
      at: new Date().toISOString(),
      method: req.method,
      route: routePattern(req.originalUrl),
      status: res.statusCode,
      ms: Number((process.hrtime.bigint() - started) / 1000000n),
    });
    if (responses.length > MAX) responses.length = MAX;
  });

  next();
};

// Outside services whose errors reach the Developer as notifications
// (label only - never the message, which can hold keys or order data)
const INTEGRATION_LABELS = [
  { name: 'Google Routes API', match: /^Google Routes API error/i, hint: 'Delivery fares and ETAs fall back to OSRM; check the Maps quota and key.' },
  { name: 'PayHere', match: /^❌ PAYHERE/i, hint: 'Card payments or refunds may be affected; see the System page.' },
  { name: 'SMS (Notify.lk)', match: /^❌ SMS SEND FAILED/i, hint: 'Shopper OTP texts may not arrive.' },
];

// Lazy: notifications.js loads the database pool and settings
const notifySystem = (event) => {
  try {
    require('./notifications').systemEvent(event);
  } catch {
    // never break a response or a log line
  }
};

// console.error hook: count error labels ("❌ X ERROR:") without the
// details that follow (they can hold order data)
const hookConsole = () => {
  if (console.error.__getmeHooked) return;
  const original = console.error.bind(console);
  const hooked = (...args) => {
    try {
      const first = typeof args[0] === 'string' ? args[0] : '';
      const integration = INTEGRATION_LABELS.find((item) => item.match.test(first));
      if (integration) {
        notifySystem({
          event: 'system.integration_error',
          severity: 'critical',
          title: `${integration.name} is failing`,
          body: `{n} error(s) this hour. ${integration.hint}`,
          key: integration.name,
        });
      }
      if (first.includes('❌')) {
        const label = first.split(':')[0].replace(/[\d]{3,}/g, '#').trim().slice(0, 90);
        const entry = labels.get(label) || { label, count: 0, firstAt: new Date().toISOString(), lastAt: null };
        entry.count += 1;
        entry.lastAt = new Date().toISOString();
        labels.set(label, entry);
        if (labels.size > 300) labels.delete(labels.keys().next().value);
      }
    } catch {
      // never break logging
    }
    original(...args);
  };
  hooked.__getmeHooked = true;
  console.error = hooked;
};

const configured = (name) => Boolean(process.env[name] && String(process.env[name]).trim());

const health = async (app) => {
  let database = { ok: false, latencyMs: null };
  const t = Date.now();
  try {
    await pool.query('SELECT 1');
    database = { ok: true, latencyMs: Date.now() - t };
  } catch (error) {
    database = { ok: false, latencyMs: null, error: 'Database query failed' };
  }

  let migrations = null;
  try {
    const checks = await pool.query(
      `SELECT
         to_regclass('public.admin_approval_requests') IS NOT NULL AS phase40,
         to_regclass('public.grocery_payment_attempts') IS NOT NULL AS phase38,
         EXISTS (SELECT 1 FROM grocery_payment_methods WHERE key = 'phone_wallet') AS phase39`
    );
    migrations = checks.rows[0];
  } catch {
    migrations = null;
  }

  const io = app?.get?.('io');
  const memory = process.memoryUsage();

  return {
    status: database.ok ? 'ok' : 'degraded',
    serverTime: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    environment: process.env.NODE_ENV || 'development',
    host: { platform: os.platform(), cpus: os.cpus().length, loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100) },
    memoryMb: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) },
    database,
    migrations,
    realtime: { connectedClients: io?.engine?.clientsCount ?? null },
    // yes / no only - never the values
    integrations: {
      payhere: { mode: process.env.PAYHERE_MODE || 'test (no live keys)', merchantConfigured: configured('PAYHERE_MERCHANT_ID'), appConfigured: configured('PAYHERE_APP_ID') },
      googleMaps: { configured: configured('GOOGLE_MAPS_API_KEY') },
      notifyLkSms: { configured: configured('NOTIFY_LK_USER_ID') && configured('NOTIFY_LK_API_KEY') },
      applicantDataKey: { configured: configured('APPLICANT_DATA_KEY') },
      cardTokenKey: { configured: configured('CARD_TOKEN_KEY') },
      publicApiUrl: { configured: configured('PUBLIC_API_URL') },
    },
    errorsSinceStart: { serverErrors: responses.length, errorLabels: labels.size },
  };
};

const errors = () => ({
  since: startedAt.toISOString(),
  note: 'Kept in memory since the last server restart. Routes only, no request data.',
  responses: responses.slice(0, MAX),
  labels: [...labels.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 100),
});

module.exports = { trackResponses, hookConsole, health, errors, routePattern };
