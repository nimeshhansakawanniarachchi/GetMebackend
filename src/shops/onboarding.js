const pool = require('../config/db');
const notifications = require('../admin/notifications');
const { ROLE_LABELS, effectivePermissions } = require('../admin/permissions');

// =====================================================
// SHOP ONBOARDING CHECKLIST + ACCOUNT MANAGER (phase 47, 2026-10-29)
// sql/platform_phase47_reports_onboarding.sql
//
// Manual items (GetMe staff tick them; stored in shops.onboarding with
// who / when): business registration, owner identity, agreement signed,
// bank details verified. Bank details are a yes / no only: no account
// number is ever accepted or stored here.
// Automatic items (computed live from the shop's data, never stored):
// products imported, logo / photo, opening hours, map location.
// Complete = all 8 done. onboarding_completed_at is stamped (and one
// "onboarding complete" notification per shop is raised) when a save
// completes it, or by the minute clock when the last automatic item
// arrives later; un-ticking a manual item re-opens it.
// =====================================================

const MANUAL_ITEMS = [
  { key: 'business_registration', label: 'Business registration checked' },
  { key: 'owner_identity', label: "Owner's identity checked" },
  { key: 'agreement_signed', label: 'Agreement signed' },
  { key: 'bank_details_verified', label: 'Bank details verified (yes / no only)' },
];

const AUTO_ITEMS = [
  { key: 'products_imported', label: 'Products imported', sql: 'EXISTS (SELECT 1 FROM products p WHERE p.shop_id = s.id)' },
  { key: 'photo_set', label: 'Logo / photo set', sql: "COALESCE(TRIM(s.image_url), '') <> ''" },
  {
    key: 'hours_set',
    label: 'Opening hours set',
    sql: `(jsonb_typeof(s.opening_hours) = 'object' AND EXISTS (
      SELECT 1 FROM jsonb_each(s.opening_hours) d
      WHERE jsonb_typeof(d.value) = 'object' AND COALESCE(d.value->>'closed', 'false') <> 'true'
        AND COALESCE(d.value->>'open', '') <> '' AND COALESCE(d.value->>'close', '') <> ''
    ))`,
  },
  { key: 'location_set', label: 'Map location set', sql: '(s.latitude IS NOT NULL AND s.longitude IS NOT NULL)' },
];

const MANUAL_KEYS = MANUAL_ITEMS.map((item) => item.key);
const TOTAL_ITEMS = MANUAL_ITEMS.length + AUTO_ITEMS.length;
const NOTES_MAX = 1000;

const manualDoneSql = (key) => `(s.onboarding->'${key}'->>'checked') = 'true'`;

// Items done (0..8) for the shop aliased `s`
const DONE_COUNT_SQL = `(${[
  ...MANUAL_KEYS.map(manualDoneSql),
  ...AUTO_ITEMS.map((item) => item.sql),
].map((sql) => `(CASE WHEN ${sql} THEN 1 ELSE 0 END)`).join(' + ')})`;

const AUTO_SELECT_SQL = AUTO_ITEMS.map((item) => `(${item.sql}) AS ${item.key}`).join(', ');

const isId = (value) => /^\d{1,9}$/.test(String(value ?? '')) && Number(value) > 0;

const shortName = (fullName) => {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
};

// Active staff who can see shops (the account-manager picker): id,
// name, role label only
const staffDirectory = async (db = pool) => {
  const result = await db.query(
    `SELECT id, full_name, role, permission_grants, permission_revokes
     FROM admins WHERE is_active IS TRUE ORDER BY full_name, id`
  );
  return result.rows
    .filter((row) => effectivePermissions(row).includes('shops.view'))
    .map((row) => ({ id: row.id, name: row.full_name, roleLabel: ROLE_LABELS[row.role] || row.role }));
};

const loadShop = async (db, shopId, { lock = false } = {}) => {
  const result = await db.query(
    `
    SELECT s.id, s.shop_name, s.status, s.onboarding, s.onboarding_notes, s.onboarding_completed_at,
           s.account_manager_admin_id, ${AUTO_SELECT_SQL}
    FROM shops s WHERE s.id = $1
    ${lock ? 'FOR UPDATE OF s' : ''}
    `,
    [shopId]
  );
  return result.rows[0] || null;
};

const view = async (db, shop) => {
  const onboarding = shop.onboarding && typeof shop.onboarding === 'object' ? shop.onboarding : {};
  const adminIds = [
    shop.account_manager_admin_id,
    ...MANUAL_KEYS.map((key) => onboarding[key]?.checked_by),
  ].filter(isId).map(Number);

  const names = new Map();
  if (adminIds.length) {
    const admins = await db.query('SELECT id, full_name, role, is_active FROM admins WHERE id = ANY($1::int[])', [[...new Set(adminIds)]]);
    admins.rows.forEach((row) => names.set(row.id, row));
  }

  const items = [
    ...MANUAL_ITEMS.map((item) => {
      const entry = onboarding[item.key] || {};
      const by = isId(entry.checked_by) ? names.get(Number(entry.checked_by)) : null;
      return {
        key: item.key,
        label: item.label,
        kind: 'manual',
        done: entry.checked === true,
        changedBy: by ? { id: by.id, name: by.full_name } : null,
        changedAt: entry.checked_at || null,
      };
    }),
    ...AUTO_ITEMS.map((item) => ({ key: item.key, label: item.label, kind: 'automatic', done: shop[item.key] === true })),
  ];

  const done = items.filter((item) => item.done).length;
  const manager = shop.account_manager_admin_id ? names.get(Number(shop.account_manager_admin_id)) : null;

  return {
    shopId: shop.id,
    shopName: shop.shop_name,
    items,
    done,
    total: TOTAL_ITEMS,
    complete: done === TOTAL_ITEMS,
    completedAt: shop.onboarding_completed_at,
    accountManager: manager
      ? { id: manager.id, name: manager.full_name, roleLabel: ROLE_LABELS[manager.role] || manager.role, active: manager.is_active === true }
      : null,
    notes: shop.onboarding_notes || '',
  };
};

const getOnboarding = async (db, shopId) => {
  const shop = await loadShop(db, shopId);
  return shop ? view(db, shop) : null;
};

// What the audit log keeps (no names needed: ids + flags)
const auditSnapshot = (shop) => ({
  items: Object.fromEntries(MANUAL_KEYS.map((key) => [key, shop.onboarding?.[key]?.checked === true])),
  accountManagerAdminId: shop.account_manager_admin_id ?? null,
  notes: shop.onboarding_notes || '',
  completedAt: shop.onboarding_completed_at || null,
});

// Body: { items?: { <manual key>: boolean }, accountManagerAdminId?: id | null, notes?: string | null }
const readChanges = (body) => {
  const allowed = ['items', 'accountManagerAdminId', 'notes'];
  const unknown = Object.keys(body || {}).filter((key) => !allowed.includes(key));
  if (unknown.length) return { error: `Unknown field: ${unknown.join(', ')}. Only checklist ticks, the account manager and notes can be saved (never bank or ID numbers).` };

  const changes = {};
  if (body.items !== undefined) {
    if (!body.items || typeof body.items !== 'object' || Array.isArray(body.items)) return { error: 'items must be an object of yes / no ticks' };
    const bad = Object.keys(body.items).filter((key) => !MANUAL_KEYS.includes(key));
    if (bad.length) return { error: `Not a manual checklist item: ${bad.join(', ')}` };
    const notBoolean = Object.entries(body.items).filter(([, value]) => typeof value !== 'boolean');
    if (notBoolean.length) return { error: 'Each checklist item is yes / no (true or false) only' };
    changes.items = body.items;
  }
  if (body.accountManagerAdminId !== undefined) {
    if (body.accountManagerAdminId !== null && !isId(body.accountManagerAdminId)) return { error: 'Choose a staff member or none' };
    changes.accountManagerAdminId = body.accountManagerAdminId === null ? null : Number(body.accountManagerAdminId);
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') return { error: 'Notes must be text' };
    const notes = String(body.notes || '').trim();
    if (notes.length > NOTES_MAX) return { error: `Notes can be at most ${NOTES_MAX} characters` };
    changes.notes = notes || null;
  }
  if (!Object.keys(changes).length) return { error: 'Nothing to save' };
  return { changes };
};

const notifyComplete = (shop, actorAdminId = null) =>
  notifications.notify({
    category: 'shops',
    event: 'shop.onboarding_complete',
    severity: 'info',
    title: `Onboarding complete: ${String(shop.shop_name || `Shop #${shop.id}`).slice(0, 120)}`,
    body: `All ${TOTAL_ITEMS} onboarding checklist items are done.${shop.managerName ? ` Account manager: ${shop.managerName}` : ''}`,
    entityType: 'shop',
    entityId: shop.id,
    permissions: ['shops.view'],
    dedupe: `shop.onboarding_complete:${shop.id}`,
    actorAdminId,
  });

// -> { status, body, audit? }
const saveOnboarding = async ({ shopId, body, admin }) => {
  const read = readChanges(body);
  if (read.error) return { status: 400, body: { success: false, message: read.error } };
  const { changes } = read;

  const client = await pool.connect();
  let completedNow = null;
  try {
    await client.query('BEGIN');
    const before = await loadShop(client, shopId, { lock: true });
    if (!before) {
      await client.query('ROLLBACK');
      return { status: 404, body: { success: false, message: 'Shop not found' } };
    }

    if (changes.accountManagerAdminId) {
      const directory = await staffDirectory(client);
      if (!directory.some((staff) => staff.id === changes.accountManagerAdminId)) {
        await client.query('ROLLBACK');
        return { status: 400, body: { success: false, message: 'The account manager must be an active staff member who can see shops' } };
      }
    }

    const onboarding = { ...(before.onboarding || {}) };
    const now = new Date().toISOString();
    for (const [key, checked] of Object.entries(changes.items || {})) {
      if ((onboarding[key]?.checked === true) === checked) continue;
      onboarding[key] = { checked, checked_by: admin?.adminId ?? null, checked_at: now };
    }

    await client.query(
      `
      UPDATE shops SET
        onboarding = $2::jsonb,
        account_manager_admin_id = CASE WHEN $3::boolean THEN $4::int ELSE account_manager_admin_id END,
        onboarding_notes = CASE WHEN $5::boolean THEN $6::varchar ELSE onboarding_notes END,
        updated_at = NOW()
      WHERE id = $1
      `,
      [
        shopId,
        JSON.stringify(onboarding),
        changes.accountManagerAdminId !== undefined,
        changes.accountManagerAdminId ?? null,
        changes.notes !== undefined,
        changes.notes ?? null,
      ]
    );

    // Complete now? (automatic items are live)
    const doneRow = await client.query(`SELECT ${DONE_COUNT_SQL} AS done FROM shops s WHERE s.id = $1`, [shopId]);
    const complete = Number(doneRow.rows[0].done) === TOTAL_ITEMS;
    if (complete && !before.onboarding_completed_at) {
      await client.query('UPDATE shops SET onboarding_completed_at = NOW() WHERE id = $1', [shopId]);
      completedNow = before;
    } else if (!complete && before.onboarding_completed_at) {
      await client.query('UPDATE shops SET onboarding_completed_at = NULL WHERE id = $1', [shopId]);
    }

    const after = await loadShop(client, shopId);
    await client.query('COMMIT');

    const result = await view(pool, after);
    if (completedNow) {
      await notifyComplete({ ...after, managerName: shortName(result.accountManager?.name) }, admin?.adminId ?? null);
    }

    const ticked = Object.entries(changes.items || {}).map(([key, value]) => `${value ? 'ticked' : 'un-ticked'} ${key.replace(/_/g, ' ')}`);
    const parts = [
      ...ticked,
      ...(changes.accountManagerAdminId !== undefined ? [`account manager ${changes.accountManagerAdminId ? `#${changes.accountManagerAdminId}` : 'removed'}`] : []),
      ...(changes.notes !== undefined ? ['notes edited'] : []),
    ];

    return {
      status: 200,
      body: { success: true, onboarding: result, message: completedNow ? 'Onboarding complete' : 'Onboarding saved' },
      audit: {
        summary: `Onboarding of ${before.shop_name}: ${parts.join(', ') || 'saved'}${completedNow ? ' (now complete)' : ''}`.slice(0, 300),
        before: auditSnapshot(before),
        after: auditSnapshot(after),
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

// Minute clock: the last automatic item can arrive after the manual
// ticks (e.g. the shop imports products later). Stamp + notify once.
const checkCompletions = async () => {
  const result = await pool.query(
    `
    UPDATE shops s SET onboarding_completed_at = NOW()
    WHERE s.onboarding_completed_at IS NULL
      AND ${MANUAL_KEYS.map(manualDoneSql).join(' AND ')}
      AND ${DONE_COUNT_SQL} = ${TOTAL_ITEMS}
    RETURNING s.id, s.shop_name, s.account_manager_admin_id
    `
  );
  for (const shop of result.rows) {
    let managerName = null;
    if (shop.account_manager_admin_id) {
      const manager = await pool.query('SELECT full_name FROM admins WHERE id = $1', [shop.account_manager_admin_id]);
      managerName = shortName(manager.rows[0]?.full_name);
    }
    await notifyComplete({ ...shop, managerName });
  }
  return result.rows.length;
};

if (typeof notifications.addClockCheck === 'function') {
  notifications.addClockCheck('shop onboarding', checkCompletions);
}

module.exports = {
  MANUAL_ITEMS,
  AUTO_ITEMS,
  TOTAL_ITEMS,
  DONE_COUNT_SQL,
  NOTES_MAX,
  staffDirectory,
  getOnboarding,
  saveOnboarding,
  checkCompletions,
};
