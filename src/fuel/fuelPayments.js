// =====================================================
// FUEL STATION PAYMENTS (phase 54, 2026-10-30)
//
// Fuel is the SHOPPER'S OWN EXPENSE (the owner's decision): GetMe keeps
// the record, a digital receipt and the history for the shopper. It is
// never part of an order total, the finance ledger, earnings or
// reimbursements, and GetMe never pays for it.
//
// Record-and-verify (no payer API exists; HelaPOS/HelaPay only receives
// payments and has no public API):
//   1. POST /fuel/payments   station, fuel type, litres or amount, vehicle,
//      the pump's LankaQR the shopper scanned (checked against the
//      station's approved QR), payment method / app -> status 'started'
//   2. the shopper pays with their own app or card (outside GetMe)
//   3. POST /fuel/payments/:id/report  amount paid + reference -> 'reported'
//   4. optional receipt photo; GetMe staff verify or reject
// Nothing becomes "paid" because a QR was generated or scanned.
// Station QR identity: approved by staff (from a scanned sample); a pump
// QR that belongs to another station, or doesn't match the approved
// one, is refused before the shopper pays.
// =====================================================

const pool = require('../config/db');
const { readPage, pageMeta } = require('../utils/pagination');
const qr = require('../groceryPayments/lankaqr');
const registry = require('../payments/merchantRegistry');

const FUEL_TYPES = {
  petrol_92: 'Petrol 92 Octane',
  petrol_95: 'Petrol 95 Octane',
  auto_diesel: 'Auto Diesel',
  super_diesel: 'Super Diesel',
};
const BRANDS = { ceypetco: 'CEYPETCO (Ceylon Petroleum)', lioc: 'Lanka IOC', sinopec: 'Sinopec', rm_parks: 'RM Parks (Shell)', shell: 'Shell', other: 'Other' };
const METHODS = {
  lankaqr: 'LankaQR (scan the station QR)',
  card: 'Card at the pump',
  cash: 'Cash',
  // Phase 56: scan, then approve at your own bank (through GetMe)
  lankaqr_bank: 'LankaQR from your bank account (via GetMe)',
};
const PAYER_APPS = { helapay: 'HelaPay (Helakuru)', bank_app: 'Bank app', card: 'Card', other: 'Other app' };
const STATUS_LABELS = {
  started: 'Waiting for your payment',
  reported: 'Payment reported · GetMe is checking',
  verified: 'Verified',
  rejected: 'Not accepted',
  cancelled: 'Cancelled',
};

const round2 = (v) => Math.round(Number(v) * 100) / 100;
const clean = (v, max) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max));
const fail = (status, message, code, extra = {}) => Object.assign(new Error(message), { status, code, extra });

// Sri Lankan vehicle numbers: "CAB-1234", "WP CAB 1234", "123-4567", "19-1234" ...
const VEHICLE = /^(?:[A-Z]{2}\s?)?(?:[A-Z]{1,3}|\d{1,3})[\s-]?\d{4}$/;
const normaliseVehicle = (value) => clean(value, 16).toUpperCase().replace(/\s+/g, ' ');

const FULL_CARD = /\b\d(?:[ -]?\d){12,18}\b/;

// -----------------------------------------------------
// Prices + stations
// -----------------------------------------------------

const currentPrices = async (client = pool) => {
  const rows = (
    await client.query(
      `SELECT DISTINCT ON (fuel_type) fuel_type, price_per_litre, effective_from
         FROM fuel_prices WHERE effective_from <= NOW()
        ORDER BY fuel_type, effective_from DESC, id DESC`
    )
  ).rows;
  return Object.fromEntries(rows.map((r) => [r.fuel_type, { pricePerLitre: Number(r.price_per_litre), since: r.effective_from }]));
};

const toStation = (row, prices = {}, { admin = false } = {}) => ({
  id: row.id,
  name: row.name,
  brand: row.brand,
  brandLabel: BRANDS[row.brand] || row.brand,
  address: row.address,
  latitude: row.latitude != null ? Number(row.latitude) : null,
  longitude: row.longitude != null ? Number(row.longitude) : null,
  phone: row.phone,
  fuelTypes: (row.fuel_types || []).map((key) => ({ key, label: FUEL_TYPES[key], pricePerLitre: prices[key]?.pricePerLitre ?? null })),
  paymentMethods: (row.payment_methods || []).map((key) => ({ key, label: METHODS[key] })),
  qrApproved: Boolean(row.qr_account_hash),
  qrMerchantName: row.qr_merchant_name || null,
  status: row.status,
  distanceKm: row.distance_km != null ? Math.round(Number(row.distance_km) * 10) / 10 : null,
  ...(admin
    ? {
        qrMerchantCity: row.qr_merchant_city || null,
        qrMcc: row.qr_mcc || null,
        qrApprovedAt: row.qr_approved_at,
        // Phase 55
        qrApprovedBy: row.qr_approved_by ?? null,
        qrCategory: row.qr_merchant_category || null,
        qrCrcValid: row.qr_crc_valid ?? null,
        qrClearedAt: row.qr_cleared_at || null,
        qrClearedReason: row.qr_cleared_reason || null,
        notes: row.notes,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : {}),
});

const toPayment = (row, { admin = false } = {}) => ({
  id: Number(row.id),
  reference: `FUEL-${row.id}`,
  shopperId: Number(row.shopper_id),
  ...(admin ? { shopperName: row.shopper_name || null } : {}),
  station: { id: row.station_id, name: row.station_name || null, address: row.station_address || null },
  fuelType: row.fuel_type,
  fuelLabel: FUEL_TYPES[row.fuel_type],
  litres: row.litres != null ? Number(row.litres) : null,
  pricePerLitre: row.price_per_litre != null ? Number(row.price_per_litre) : null,
  amount: Number(row.amount),
  amountPaid: row.amount_paid != null ? Number(row.amount_paid) : null,
  vehicleReg: row.vehicle_reg,
  paymentMethod: row.payment_method,
  paymentMethodLabel: METHODS[row.payment_method],
  payerApp: row.payer_app,
  payerAppLabel: row.payer_app ? PAYER_APPS[row.payer_app] : null,
  payerReference: row.payer_reference,
  // Phase 56: bank payment (provider) - the bank's approval page only
  // while the shopper still has to approve
  provider: row.provider || null,
  providerRef: row.provider_ref || null,
  providerStatus: row.provider_status || null,
  providerMessage: row.provider_message || null,
  simulator: row.provider === 'simulator',
  verification: row.verification || 'none',
  payerAuth:
    row.status === 'started' && row.provider_status === 'action_required' && row.payer_auth_url
      ? { url: row.payer_auth_url, expiresAt: row.payer_auth_expires_at || null }
      : null,
  // Merchant identity hashes stay with staff (station QR approval)
  qrCheck: row.qr_check ? (admin ? row.qr_check : (({ accountHash, merchantKey, ...rest }) => rest)(row.qr_check)) : null,
  receiptUrl: row.receipt_url || null,
  status: row.status,
  statusLabel: STATUS_LABELS[row.status] || row.status,
  // Never "paid" by GetMe: the shopper's own money, checked by staff
  // (or, phase 56, confirmed by the bank / the TEST SIMULATOR)
  verifiedByGetMe: row.status === 'verified',
  verifiedBy: row.status !== 'verified' ? null : row.verification === 'provider' ? 'bank' : row.verification === 'simulator' ? 'test_simulator' : 'getme_staff',
  reportedAt: row.reported_at,
  reviewedAt: row.reviewed_at,
  reviewNote: row.review_note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  accounting: 'Shopper expense - not part of any order, earnings or reimbursement',
});

const PAYMENT_SELECT = `
  SELECT p.*, s.name AS station_name, s.address AS station_address, sh.full_name AS shopper_name
    FROM fuel_payments p
    JOIN fuel_stations s ON s.id = p.station_id
    JOIN shoppers sh ON sh.id = p.shopper_id`;

const addEvent = (client, paymentId, event, from, to, actorType, actorId, note = null) =>
  client.query(
    `INSERT INTO fuel_payment_events (payment_id, event, from_status, to_status, actor_type, actor_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [paymentId, event, from, to, actorType, actorId ?? null, note ? clean(note, 300) : null]
  );

// Pump / counter QR vs the station's approved QR
const pumpQrCheck = async (client, station, qrPayload, amount) => {
  let parsed;
  try {
    parsed = qr.parse(String(qrPayload));
  } catch (caught) {
    throw fail(400, "This isn't a valid LankaQR code. Scan the station's QR again.", 'QR_INVALID', { reason: caught.code || null });
  }

  // Phase 55 (P-10): an approved supermarket QR is never a fuel pump's
  const shop = await registry.supermarketWithAccount(client, parsed.accountHash);
  if (shop) {
    throw fail(409, `This QR belongs to a supermarket (${shop.shop_name || 'a GetMe store'}), not ${station.name}. Don't pay with it.`, 'QR_IS_SUPERMARKET');
  }

  let merchant = 'UNREGISTERED';
  if (station.qr_account_hash) {
    if (station.qr_account_hash !== parsed.accountHash) {
      throw fail(409, `This QR doesn't belong to ${station.name}. Don't pay with it; tell GetMe support.`, 'STATION_QR_MISMATCH');
    }
    merchant = qr.sameText(station.qr_merchant_name, parsed.merchantName) ? 'APPROVED' : 'NAME_CHANGED';
  } else {
    const other = (
      await client.query('SELECT name FROM fuel_stations WHERE qr_account_hash = $1 AND id <> $2 LIMIT 1', [parsed.accountHash, station.id])
    ).rows[0];
    if (other) throw fail(409, `This QR belongs to another station (${other.name}). Check you chose the right station.`, 'QR_OTHER_STATION');
  }

  const qrAmount = parsed.amount != null ? round2(parsed.amount) : null;
  return {
    merchant,
    merchantName: parsed.merchantName,
    merchantCity: parsed.merchantCity,
    mcc: parsed.mcc,
    kind: parsed.kind,
    qrAmount,
    amountMatches: qrAmount == null ? null : Math.abs(qrAmount - amount) <= 0.01,
    // identity for a staff "approve this QR for the station" action (no secrets)
    merchantKey: parsed.merchantKey,
    accountHash: parsed.accountHash,
    scannedAt: new Date().toISOString(),
  };
};

// =====================================================
// SHOPPER
// =====================================================

const listStations = async ({ latitude, longitude }) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const rows = (
    await pool.query(
      `SELECT s.*,
              CASE WHEN $1::float8 IS NULL OR s.latitude IS NULL THEN NULL ELSE
                6371 * 2 * ASIN(SQRT(POWER(SIN(RADIANS(s.latitude - $1) / 2), 2) +
                  COS(RADIANS($1)) * COS(RADIANS(s.latitude)) * POWER(SIN(RADIANS(s.longitude - $2) / 2), 2))) END AS distance_km
         FROM fuel_stations s
        WHERE s.status = 'active'
        ORDER BY distance_km ASC NULLS LAST, s.name
        LIMIT 50`,
      [hasPoint ? lat : null, hasPoint ? lng : null]
    )
  ).rows;
  const prices = await currentPrices();
  return { stations: rows.map((r) => toStation(r, prices)), prices, fuelTypes: FUEL_TYPES, payerApps: PAYER_APPS, bankPayment: bankPaymentInfo() };
};

const startPayment = async ({ shopperId, body, authBaseUrl = null, testOutcome = null }) => {
  const requestId = clean(body?.requestId, 80);
  if (!requestId) throw fail(400, 'requestId is required', 'INVALID');

  const again = (await pool.query(`${PAYMENT_SELECT} WHERE p.shopper_id = $1 AND p.request_id = $2`, [shopperId, requestId])).rows[0];
  if (again) return { payment: toPayment(again), duplicate: true };

  const stationId = Number(body?.stationId);
  const fuelType = String(body?.fuelType || '');
  const method = String(body?.paymentMethod || 'lankaqr');
  const payerApp = body?.payerApp ? String(body.payerApp) : null;
  if (!FUEL_TYPES[fuelType]) throw fail(400, 'Choose a fuel type', 'INVALID_FUEL');
  if (!METHODS[method]) throw fail(400, 'Choose how you pay', 'INVALID_METHOD');
  if (payerApp && !PAYER_APPS[payerApp]) throw fail(400, 'Unknown payment app', 'BAD_PAYER_APP');

  const vehicleReg = body?.vehicleReg ? normaliseVehicle(body.vehicleReg) : null;
  if (vehicleReg && !VEHICLE.test(vehicleReg)) throw fail(400, 'Enter the vehicle number like CAB-1234 or WP CAB 1234', 'INVALID_VEHICLE');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const station = (await client.query("SELECT * FROM fuel_stations WHERE id = $1 AND status = 'active' FOR SHARE", [stationId])).rows[0];
    if (!station) throw fail(404, 'Fuel station not found', 'STATION_NOT_FOUND');
    if (!station.fuel_types.includes(fuelType)) throw fail(409, `${station.name} doesn't list ${FUEL_TYPES[fuelType]}`, 'FUEL_NOT_SOLD');
    // Phase 56: a bank payment pays the station's LankaQR
    const accepts = method === 'lankaqr_bank' ? 'lankaqr' : method;
    if (!station.payment_methods.includes(accepts)) throw fail(409, `${station.name} doesn't take ${METHODS[method].toLowerCase()}`, 'METHOD_NOT_ACCEPTED');
    const bank = method === 'lankaqr_bank' ? bankState() : null;
    if (bank && !bank.available) throw fail(503, bankPaymentInfo().reason, 'PROVIDER_NOT_CONFIGURED');

    // Litres x the current price, or the amount (price shown for reference)
    const price = (await currentPrices(client))[fuelType]?.pricePerLitre ?? null;
    const litres = body?.litres != null && body.litres !== '' ? round2(body.litres) : null;
    let amount = body?.amount != null && body.amount !== '' ? round2(body.amount) : null;
    if (litres != null && !(litres > 0 && litres <= 300)) throw fail(400, 'Litres must be between 0 and 300', 'INVALID_LITRES');
    if (amount != null && !(amount > 0 && amount <= 100000)) throw fail(400, 'Amount must be between Rs 1 and Rs 100,000', 'INVALID_AMOUNT');
    if (litres == null && amount == null) throw fail(400, 'Enter litres or an amount', 'INVALID_AMOUNT');
    if (litres != null) {
      if (price == null) throw fail(409, 'GetMe has no current price for this fuel. Enter the amount instead.', 'NO_PRICE');
      const computed = round2(litres * price);
      if (amount != null && Math.abs(amount - computed) > 1) {
        throw fail(400, `${litres} L at Rs ${price.toFixed(2)} is Rs ${computed.toFixed(2)}, not Rs ${amount.toFixed(2)}`, 'AMOUNT_MISMATCH');
      }
      amount = computed;
    }

    let qrCheck = null;
    if (['lankaqr', 'lankaqr_bank'].includes(method) && body?.qrPayload) {
      qrCheck = await pumpQrCheck(client, station, body.qrPayload, amount);
    }
    if (bank) {
      // Money moves through GetMe: only the station's approved QR, only
      // the amount in a dynamic QR
      if (!qrCheck) throw fail(400, "Scan the station's LankaQR code to pay from your bank account", 'QR_REQUIRED');
      if (qrCheck.merchant !== 'APPROVED') {
        throw fail(409, `GetMe hasn't approved ${station.name}'s QR code yet. Pay with your own app and record it instead.`, 'STATION_QR_NOT_APPROVED');
      }
      if (qrCheck.amountMatches === false) {
        throw fail(409, `The QR asks for Rs ${qrCheck.qrAmount.toFixed(2)}, not Rs ${amount.toFixed(2)}. Check the amount with the attendant.`, 'AMOUNT_MISMATCH');
      }
    }

    const row = (
      await client.query(
        `INSERT INTO fuel_payments (shopper_id, station_id, fuel_type, litres, price_per_litre, amount, vehicle_reg,
                                    payment_method, payer_app, qr_check, request_id, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [shopperId, station.id, fuelType, litres, price, amount, vehicleReg, method, payerApp, qrCheck ? JSON.stringify(qrCheck) : null, requestId, bank ? bank.state.key : null]
      )
    ).rows[0];
    await addEvent(client, row.id, 'started', null, 'started', 'shopper', shopperId,
      qrCheck ? `QR ${qrCheck.merchant === 'APPROVED' ? 'matches the station' : qrCheck.merchant === 'UNREGISTERED' ? 'not yet approved for the station' : 'name differs'}` : null);
    await client.query('COMMIT');
    if (bank) await initiateBank(row.id, { authBaseUrl, testOutcome });
    return { payment: toPayment((await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [row.id])).rows[0]), duplicate: false };
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') {
      const row = (await pool.query(`${PAYMENT_SELECT} WHERE p.shopper_id = $1 AND p.request_id = $2`, [shopperId, requestId])).rows[0];
      if (row) return { payment: toPayment(row), duplicate: true };
    }
    throw caught;
  } finally {
    client.release();
  }
};

const ownPayment = async (client, shopperId, id, { lock = false } = {}) => {
  const row = (await client.query(`SELECT * FROM fuel_payments WHERE id = $1 AND shopper_id = $2 ${lock ? 'FOR UPDATE' : ''}`, [Number(id), shopperId])).rows[0];
  if (!row) throw fail(404, 'Fuel payment not found', 'NOT_FOUND');
  return row;
};

const reportPayment = async ({ shopperId, id, body }) => {
  const amountPaid = round2(body?.amountPaid);
  const reference = clean(body?.reference, 60) || null;
  const payerApp = body?.payerApp ? String(body.payerApp) : null;
  if (!(amountPaid > 0 && amountPaid <= 100000)) throw fail(400, 'Enter the amount you paid', 'INVALID_AMOUNT');
  if (reference && FULL_CARD.test(reference)) throw fail(400, 'Never enter a full card number. Use the last 4 digits or the app reference.', 'FULL_CARD_NUMBER');
  if (payerApp && !PAYER_APPS[payerApp]) throw fail(400, 'Unknown payment app', 'BAD_PAYER_APP');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await ownPayment(client, shopperId, id, { lock: true });
    if (row.provider) throw fail(409, 'This payment is confirmed by the bank, not reported by you', 'BANK_PAYMENT');
    if (!['started', 'reported'].includes(row.status)) throw fail(409, `This payment is ${STATUS_LABELS[row.status].toLowerCase()}`, 'CLOSED');
    await client.query(
      `UPDATE fuel_payments SET amount_paid = $2, payer_reference = $3, payer_app = COALESCE($4, payer_app),
              status = 'reported', reported_at = COALESCE(reported_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [row.id, amountPaid, reference, payerApp]
    );
    await addEvent(client, row.id, row.status === 'reported' ? 'corrected' : 'reported', row.status, 'reported', 'shopper', shopperId,
      Math.abs(amountPaid - Number(row.amount)) > 0.01 ? `Paid Rs ${amountPaid.toFixed(2)} (planned Rs ${Number(row.amount).toFixed(2)})` : null);
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }
  return { payment: toPayment((await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [Number(id)])).rows[0]) };
};

const cancelPayment = async ({ shopperId, id }) => {
  // Phase 56: a bank payment is stopped at the bank (only before approval)
  const own = await ownPayment(pool, shopperId, id);
  if (own.provider && own.initiated_at && own.status === 'started') {
    if (own.provider_status !== 'action_required') throw fail(409, 'This payment is already with the bank. Wait for its result.', 'CANNOT_CANCEL');
    const { state, available } = bankState();
    if (!available || state.key !== own.provider) throw fail(503, 'The payment provider is not available. Try again later.', 'PROVIDER_NOT_CONFIGURED');
    let result;
    try {
      result = await withTimeout(state.provider.cancel ? state.provider.cancel({ attemptId: `F${own.id}`, providerRef: own.provider_ref }) : { status: 'unknown' }, PROVIDER_TIMEOUT_MS);
    } catch {
      result = { status: 'unknown' };
    }
    if (['cancelled', 'expired', 'failed', 'succeeded'].includes(result?.status)) await applyBankOutcome(own.id, result, { source: 'query' });
    else await queryBank(own, { force: true });
    return { payment: toPayment((await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [own.id])).rows[0]) };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await ownPayment(client, shopperId, id, { lock: true });
    if (row.status === 'cancelled') {
      await client.query('COMMIT');
    } else {
      if (row.status !== 'started') throw fail(409, 'A reported payment can only be changed by GetMe support', 'CLOSED');
      await client.query("UPDATE fuel_payments SET status = 'cancelled', updated_at = NOW() WHERE id = $1", [row.id]);
      await addEvent(client, row.id, 'cancelled', 'started', 'cancelled', 'shopper', shopperId);
      await client.query('COMMIT');
    }
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }
  return { payment: toPayment((await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [Number(id)])).rows[0]) };
};

// Ownership is checked before multer stores anything (B-28)
const requireOwnOpenPayment = async (req, res, next) => {
  try {
    const row = await ownPayment(pool, Number(req.shopper?.shopperId), req.params.id);
    if (!['started', 'reported'].includes(row.status)) {
      return res.status(409).json({ success: false, code: 'CLOSED', message: 'This payment is closed' });
    }
    return next();
  } catch (caught) {
    return res.status(caught.status || 500).json({ success: false, code: caught.code, message: caught.status ? caught.message : 'Unable to check the payment' });
  }
};

const saveReceipt = async ({ shopperId, id, file }) => {
  if (!file) throw fail(400, 'Add a photo of the receipt', 'NO_FILE');
  const url = `/uploads/fuel-receipts/${file.filename}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await ownPayment(client, shopperId, id, { lock: true });
    await client.query('UPDATE fuel_payments SET receipt_url = $2, updated_at = NOW() WHERE id = $1', [row.id, url]);
    await addEvent(client, row.id, 'receipt', row.status, row.status, 'shopper', shopperId);
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }
  return { payment: toPayment((await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [Number(id)])).rows[0]) };
};

const listOwn = async ({ shopperId, query }) => {
  const paging = readPage(query);
  const total = (await pool.query('SELECT COUNT(*)::int AS n FROM fuel_payments WHERE shopper_id = $1', [shopperId])).rows[0].n;
  const rows = (
    await pool.query(`${PAYMENT_SELECT} WHERE p.shopper_id = $1 ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`, [shopperId, paging.pageSize, paging.offset])
  ).rows;
  return { ...pageMeta(paging, total), payments: rows.map((r) => toPayment(r)) };
};

const eventsOf = async (id) =>
  (
    await pool.query('SELECT event, from_status, to_status, actor_type, note, created_at FROM fuel_payment_events WHERE payment_id = $1 ORDER BY created_at, id', [id])
  ).rows.map((e) => ({ event: e.event, from: e.from_status, to: e.to_status, by: e.actor_type, note: e.note, at: e.created_at }));

const getOwn = async ({ shopperId, id }) => {
  let row = (await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1 AND p.shopper_id = $2`, [Number(id), shopperId])).rows[0];
  if (!row) throw fail(404, 'Fuel payment not found', 'NOT_FOUND');
  // Phase 56: an open bank payment is checked with the provider (app poll)
  if (row.provider && row.status === 'started') {
    await queryBank(row);
    row = (await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [row.id])).rows[0];
  }
  return { payment: toPayment(row), events: await eventsOf(row.id) };
};

// =====================================================
// ADMIN
// =====================================================

const STATION_FIELDS = ['name', 'brand', 'address', 'latitude', 'longitude', 'phone', 'fuelTypes', 'paymentMethods', 'status', 'notes'];

const stationValues = (body, partial) => {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = clean(body.name, 120);
    if (!out.name) throw fail(400, 'Enter the station name', 'INVALID');
  }
  if (body.brand !== undefined) {
    if (!BRANDS[body.brand]) throw fail(400, 'Unknown brand', 'INVALID');
    out.brand = body.brand;
  }
  if (body.address !== undefined) out.address = clean(body.address, 300) || null;
  if (body.phone !== undefined) out.phone = clean(body.phone, 20) || null;
  if (body.notes !== undefined) out.notes = clean(body.notes, 500) || null;
  for (const [key, max] of [['latitude', 90], ['longitude', 180]]) {
    if (body[key] !== undefined) {
      const n = body[key] === null || body[key] === '' ? null : Number(body[key]);
      if (n !== null && !(Number.isFinite(n) && Math.abs(n) <= max)) throw fail(400, `Invalid ${key}`, 'INVALID');
      out[key] = n;
    }
  }
  if (body.fuelTypes !== undefined) {
    const list = [...new Set(Array.isArray(body.fuelTypes) ? body.fuelTypes.map(String) : [])];
    if (!list.length || list.some((k) => !FUEL_TYPES[k])) throw fail(400, 'Choose at least one fuel type', 'INVALID');
    out.fuel_types = list;
  }
  if (body.paymentMethods !== undefined) {
    const list = [...new Set(Array.isArray(body.paymentMethods) ? body.paymentMethods.map(String) : [])];
    if (!list.length || list.some((k) => !METHODS[k])) throw fail(400, 'Choose at least one payment method', 'INVALID');
    out.payment_methods = list;
  }
  if (body.status !== undefined) {
    if (!['active', 'inactive'].includes(body.status)) throw fail(400, 'Status is active or inactive', 'INVALID');
    out.status = body.status;
  }
  return out;
};

const adminListStations = async () => {
  const prices = await currentPrices();
  const rows = (
    await pool.query(
      `SELECT s.*, (SELECT COUNT(*)::int FROM fuel_payments p WHERE p.station_id = s.id) AS payments
         FROM fuel_stations s ORDER BY s.status, s.name`
    )
  ).rows;
  return { stations: rows.map((r) => ({ ...toStation(r, prices, { admin: true }), payments: r.payments })), prices, fuelTypes: FUEL_TYPES, brands: BRANDS, methods: METHODS };
};

const adminSaveStation = async ({ id, body, adminId }) => {
  const values = stationValues(body || {}, Boolean(id));
  const keys = Object.keys(values);
  let row;
  if (id) {
    if (!keys.length) throw fail(400, 'Nothing to change', 'INVALID');
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    row = (await pool.query(`UPDATE fuel_stations SET ${sets}, updated_by = $${keys.length + 2}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [Number(id), ...keys.map((k) => values[k]), adminId])).rows[0];
    if (!row) throw fail(404, 'Station not found', 'NOT_FOUND');
  } else {
    row = (await pool.query(`INSERT INTO fuel_stations (${keys.join(', ')}, created_by, updated_by) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, $${keys.length + 1}, $${keys.length + 1}) RETURNING *`,
      [...keys.map((k) => values[k]), adminId])).rows[0];
  }
  return { station: toStation(row, await currentPrices(), { admin: true }) };
};

// Approve a station's LankaQR from a scanned sample (payload text) or from a payment's scan
const adminSetStationQr = async ({ id, body, adminId }) => {
  const station = (await pool.query('SELECT * FROM fuel_stations WHERE id = $1', [Number(id)])).rows[0];
  if (!station) throw fail(404, 'Station not found', 'NOT_FOUND');
  if (body?.clear === true) {
    // Phase 55: removing a station's QR needs a reason (kept on the station)
    const reason = clean(body?.reason, 300);
    if (reason.length < 3) throw fail(400, 'Say why the station QR is removed', 'REASON_REQUIRED');
    const row = (await pool.query(
      `UPDATE fuel_stations SET qr_merchant_key = NULL, qr_account_hash = NULL, qr_merchant_name = NULL, qr_merchant_city = NULL,
              qr_mcc = NULL, qr_approved_at = NULL, qr_approved_by = NULL, qr_payload = NULL, qr_crc_valid = NULL,
              qr_merchant_category = NULL, qr_cleared_at = NOW(), qr_cleared_by = $2, qr_cleared_reason = $3,
              updated_by = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [station.id, adminId, reason])).rows[0];
    return { station: toStation(row, await currentPrices(), { admin: true }) };
  }
  let identity;
  if (body?.fromPaymentId) {
    const payment = (await pool.query('SELECT qr_check FROM fuel_payments WHERE id = $1 AND station_id = $2', [Number(body.fromPaymentId), station.id])).rows[0];
    if (!payment?.qr_check?.accountHash) throw fail(400, 'That payment has no scanned QR for this station', 'NO_QR');
    identity = payment.qr_check;
  } else {
    try {
      const parsed = qr.parse(String(body?.qrPayload || ''));
      identity = { merchantKey: parsed.merchantKey, accountHash: parsed.accountHash, merchantName: parsed.merchantName, merchantCity: parsed.merchantCity, mcc: parsed.mcc, payload: parsed.sample || null };
    } catch (caught) {
      throw fail(400, 'Paste the text of a valid LankaQR code', 'QR_INVALID', { reason: caught.code || null });
    }
  }
  // Phase 55 (P-10): a supermarket's QR / a supermarket merchant code
  // can't become a fuel station's QR
  const shop = await registry.supermarketWithAccount(pool, identity.accountHash);
  if (shop) throw fail(409, `This QR is approved for a supermarket (${shop.shop_name || `shop #${shop.shop_id}`}), not a fuel station`, 'QR_IS_SUPERMARKET');
  const category = registry.categoryForMcc(identity.mcc);
  if (category === 'grocery') throw fail(409, 'This QR has a supermarket merchant category, not a fuel station one', 'QR_CATEGORY');
  try {
    const row = (await pool.query(
      `UPDATE fuel_stations SET qr_merchant_key = $2, qr_account_hash = $3, qr_merchant_name = $4, qr_merchant_city = $5, qr_mcc = $6,
              qr_approved_at = NOW(), qr_approved_by = $7, qr_payload = $8, qr_crc_valid = TRUE, qr_merchant_category = $9,
              updated_by = $7, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [station.id, identity.merchantKey, identity.accountHash, clean(identity.merchantName, 60), clean(identity.merchantCity, 40), identity.mcc || null, adminId, identity.payload || null, category])).rows[0];
    return { station: toStation(row, await currentPrices(), { admin: true }) };
  } catch (caught) {
    if (caught.code === '23505') throw fail(409, 'This QR is already approved for another station', 'QR_OTHER_STATION');
    throw caught;
  }
};

const adminListPrices = async () => {
  const rows = (await pool.query('SELECT * FROM fuel_prices ORDER BY effective_from DESC, id DESC LIMIT 100')).rows;
  return {
    current: await currentPrices(),
    history: rows.map((r) => ({ id: r.id, fuelType: r.fuel_type, fuelLabel: FUEL_TYPES[r.fuel_type], pricePerLitre: Number(r.price_per_litre), effectiveFrom: r.effective_from, note: r.note, createdAt: r.created_at })),
    fuelTypes: FUEL_TYPES,
  };
};

const adminAddPrice = async ({ body, adminId }) => {
  const fuelType = String(body?.fuelType || '');
  const price = round2(body?.pricePerLitre);
  if (!FUEL_TYPES[fuelType]) throw fail(400, 'Choose a fuel type', 'INVALID');
  if (!(price > 0 && price < 10000)) throw fail(400, 'Enter the price per litre', 'INVALID');
  const from = body?.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
  if (!Number.isFinite(from.getTime())) throw fail(400, 'Invalid start date', 'INVALID');
  await pool.query('INSERT INTO fuel_prices (fuel_type, price_per_litre, effective_from, note, set_by) VALUES ($1, $2, $3, $4, $5)',
    [fuelType, price, from, clean(body?.note, 200) || null, adminId]);
  return adminListPrices();
};

const adminListPayments = async ({ query }) => {
  const paging = readPage(query);
  const params = [];
  const where = [];
  if (STATUS_LABELS[query.status]) { params.push(query.status); where.push(`p.status = $${params.length}`); }
  if (query.stationId) { params.push(Number(query.stationId)); where.push(`p.station_id = $${params.length}`); }
  if (query.shopperId) { params.push(Number(query.shopperId)); where.push(`p.shopper_id = $${params.length}`); }
  if (FUEL_TYPES[query.fuelType]) { params.push(query.fuelType); where.push(`p.fuel_type = $${params.length}`); }
  if (query.qr === 'unregistered') where.push(`p.qr_check->>'merchant' = 'UNREGISTERED'`);
  for (const [key, op] of [['from', '>='], ['to', '<']]) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(query[key] || ''))) {
      const day = new Date(`${query[key]}T00:00:00`);
      params.push(key === 'to' ? new Date(day.getTime() + 86400000) : day);
      where.push(`p.created_at ${op} $${params.length}`);
    }
  }
  const search = clean(query.search, 60);
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const n = params.length;
    const id = /^(FUEL-)?\d+$/i.test(search) ? ` OR p.id = ${Number(search.replace(/\D/g, ''))}` : '';
    where.push(`(LOWER(p.vehicle_reg) LIKE $${n} OR LOWER(p.payer_reference) LIKE $${n} OR LOWER(sh.full_name) LIKE $${n} OR LOWER(s.name) LIKE $${n}${id})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM fuel_payments p JOIN fuel_stations s ON s.id = p.station_id JOIN shoppers sh ON sh.id = p.shopper_id ${whereSql}`;
  const [total, rows, sums] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n ${from}`, params),
    pool.query(`SELECT p.*, s.name AS station_name, s.address AS station_address, sh.full_name AS shopper_name ${from} ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, paging.pageSize, paging.offset]),
    pool.query(`SELECT p.status, COUNT(*)::int AS n, COALESCE(SUM(COALESCE(p.amount_paid, p.amount)), 0)::float AS total ${from} GROUP BY p.status`, params),
  ]);
  return {
    ...pageMeta(paging, total.rows[0].n),
    payments: rows.rows.map((r) => toPayment(r, { admin: true })),
    totals: Object.fromEntries(sums.rows.map((r) => [r.status, { count: r.n, amount: round2(r.total) }])),
    note: "Fuel is the shopper's own expense: these totals are not GetMe revenue, cost or earnings.",
  };
};

const adminGetPayment = async ({ id }) => {
  const row = (await pool.query(`${PAYMENT_SELECT} WHERE p.id = $1`, [Number(id)])).rows[0];
  if (!row) throw fail(404, 'Fuel payment not found', 'NOT_FOUND');
  return { payment: toPayment(row, { admin: true }), events: await eventsOf(row.id) };
};

const adminReview = async ({ id, body, adminId }) => {
  const action = String(body?.action || '');
  const note = clean(body?.note, 300);
  if (!['verify', 'reject'].includes(action)) throw fail(400, 'Action is verify or reject', 'INVALID');
  // Phase 55: a verification records what was checked, like a rejection
  if (note.length < 3) throw fail(400, action === 'verify' ? 'Say what you checked (receipt, amount, station)' : 'Give a reason', 'REASON_REQUIRED');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('getme.actor', $1, true), set_config('getme.reason', $2, true)", [`admin:${adminId}`, note]);
    const row = (await client.query('SELECT * FROM fuel_payments WHERE id = $1 FOR UPDATE', [Number(id)])).rows[0];
    if (!row) throw fail(404, 'Fuel payment not found', 'NOT_FOUND');
    // Phase 56: a bank payment the provider can't settle may be closed by
    // staff with the bank's confirmation (never a TEST SIMULATOR one as paid)
    const bankOpen = row.provider && row.status === 'started' && ['unknown', 'pending', 'accepted'].includes(row.provider_status);
    if (row.status !== 'reported' && !bankOpen) throw fail(409, 'Only reported payments can be reviewed', 'NOT_REPORTED');
    if (bankOpen && action === 'verify' && row.provider === 'simulator') throw fail(409, 'A TEST SIMULATOR payment moved no money: it can only be rejected', 'SIMULATOR_NOT_BANK');
    const to = action === 'verify' ? 'verified' : 'rejected';
    await client.query(`UPDATE fuel_payments SET status = $2::varchar, reviewed_at = NOW(), reviewed_by = $3, review_note = $4,
              verification = CASE WHEN $2::varchar = 'verified' THEN 'admin' ELSE verification END, updated_at = NOW() WHERE id = $1`,
      [row.id, to, adminId, note || null]);
    await addEvent(client, row.id, action === 'verify' ? 'verified' : 'rejected', row.status, to, 'admin', adminId, note || null);
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }
  return adminGetPayment({ id });
};

// =====================================================
// PAY FROM THE SHOPPER'S OWN BANK ACCOUNT (phase 56)
// Same providers as supermarket LankaQR (groceryPayments/providers): the
// shopper scans the station's APPROVED pump QR, the provider asks the
// shopper's bank to approve (action_required -> the bank's page), and
// only the provider's answer settles it ('verified', verification
// provider / simulator). Still the shopper's own expense: never an
// order, earnings or reimbursement. No bank offers this yet - only the
// TEST SIMULATOR runs it (no money moves).
// =====================================================

const providers = () => require('../groceryPayments/providers');
const PROVIDER_TIMEOUT_MS = Number(process.env.GROCERY_QR_TIMEOUT_MS) || 20000;
const BANK_STATUSES = ['accepted', 'pending', 'action_required', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired', 'unknown'];

const bankState = () => {
  const state = providers().current();
  const payer = Boolean(state.usable && state.provider.describe().capabilities?.payerFunded);
  return { state, available: payer };
};

const bankPaymentInfo = () => {
  const { state, available } = bankState();
  return {
    available,
    simulator: available && state.simulator,
    notice: available && state.simulator ? 'TEST SIMULATOR — no money moves' : null,
    reason: available ? null : 'Not available yet: no bank lets GetMe start LankaQR payments from your own account',
  };
};

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'PROVIDER_TIMEOUT' })), ms))]);

const normaliseBank = (result, simulator) => {
  let status = BANK_STATUSES.includes(result?.status) ? result.status : 'unknown';
  const url = typeof result?.authUrl === 'string' ? result.authUrl : '';
  const authUrl = /^https:\/\//i.test(url) || (simulator && /^http:\/\//i.test(url)) ? url.slice(0, 2000) : null;
  if (status === 'action_required' && !authUrl) status = 'pending';
  const expires = result?.expiresAt ? new Date(result.expiresAt) : null;
  return {
    status,
    providerRef: result?.providerRef ? clean(result.providerRef, 80) : null,
    amount: result?.amount != null && Number.isFinite(Number(result.amount)) ? round2(result.amount) : null,
    message: result?.message ? clean(result.message, 300) : null,
    authUrl,
    expiresAt: expires && Number.isFinite(expires.getTime()) ? expires : null,
  };
};

// Applies the provider's answer to an open fuel bank payment
const applyBankOutcome = async (id, raw, { source = 'provider' } = {}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM fuel_payments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row || row.status !== 'started' || !row.provider) {
      await client.query('COMMIT');
      return row;
    }
    const sim = row.provider === 'simulator';
    const result = normaliseBank(raw, sim);
    await client.query(
      `UPDATE fuel_payments SET provider_ref = COALESCE($2, provider_ref), provider_status = $3::varchar, provider_message = COALESCE($4, provider_message),
              payer_auth_url = CASE WHEN $3::varchar = 'action_required' THEN $5::text ELSE NULL END,
              payer_auth_expires_at = CASE WHEN $3::varchar = 'action_required' THEN COALESCE($6::timestamptz, payer_auth_expires_at) ELSE payer_auth_expires_at END,
              last_checked_at = CASE WHEN $7::text = 'query' THEN NOW() ELSE last_checked_at END,
              status_checks = status_checks + CASE WHEN $7::text = 'query' THEN 1 ELSE 0 END, updated_at = NOW()
        WHERE id = $1`,
      [row.id, result.providerRef, result.status, result.message, result.authUrl, result.expiresAt, source]
    );
    const amount = round2(row.amount);
    if (result.status === 'succeeded') {
      if (result.amount != null && Math.abs(result.amount - amount) > 0.005) {
        // The bank paid another amount: a person must look at it
        await client.query(
          `UPDATE fuel_payments SET status = 'reported', amount_paid = $2, payer_reference = COALESCE($3, payer_reference),
                  reported_at = NOW(), review_note = $4, verification = $5, updated_at = NOW() WHERE id = $1`,
          [row.id, result.amount, result.providerRef, `Bank paid Rs ${result.amount.toFixed(2)}, confirmed Rs ${amount.toFixed(2)}`, sim ? 'simulator' : 'provider']
        );
        await addEvent(client, row.id, 'reported', 'started', 'reported', 'system', null, 'Bank amount differs: needs review');
      } else {
        await client.query(
          `UPDATE fuel_payments SET status = 'verified', amount_paid = $2, payer_reference = COALESCE($3, payer_reference), reported_at = NOW(),
                  reviewed_at = NOW(), review_note = $4, verification = $5, updated_at = NOW() WHERE id = $1`,
          [row.id, amount, result.providerRef || row.provider_ref, sim ? 'TEST SIMULATOR — no money moved' : 'Confirmed by the bank', sim ? 'simulator' : 'provider']
        );
        await addEvent(client, row.id, 'verified', 'started', 'verified', 'system', null, sim ? 'TEST SIMULATOR confirmation' : 'Confirmed by the bank');
      }
    } else if (['failed', 'rejected', 'cancelled', 'expired'].includes(result.status)) {
      const to = result.status === 'cancelled' || result.status === 'expired' ? 'cancelled' : 'rejected';
      const why = result.status === 'expired' ? 'Not approved at the bank in time' : result.message || (to === 'cancelled' ? 'Cancelled at the bank' : 'Declined by the bank');
      await client.query('UPDATE fuel_payments SET status = $2, review_note = $3, updated_at = NOW() WHERE id = $1', [row.id, to, clean(why, 300)]);
      await addEvent(client, row.id, to, 'started', to, 'system', null, why);
    }
    await client.query('COMMIT');
    return (await pool.query('SELECT * FROM fuel_payments WHERE id = $1', [id])).rows[0];
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }
};

// provider.initiate at most once (atomic claim on initiated_at)
const initiateBank = async (id, { authBaseUrl = null, testOutcome = null } = {}) => {
  const claimed = (
    await pool.query(
      `UPDATE fuel_payments SET initiated_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND initiated_at IS NULL AND status = 'started' AND provider IS NOT NULL RETURNING *`,
      [id]
    )
  ).rows[0];
  if (!claimed) return null;
  const { state, available } = bankState();
  if (!available || state.key !== claimed.provider) {
    return applyBankOutcome(id, { status: 'failed', message: 'Not sent: the payment provider is not available' }, { source: 'initiate' });
  }
  const station = (await pool.query('SELECT qr_merchant_name, qr_merchant_city, qr_mcc FROM fuel_stations WHERE id = $1', [claimed.station_id])).rows[0];
  let result;
  try {
    result = await withTimeout(
      state.provider.initiate({
        attemptId: `F${claimed.id}`,
        idempotencyKey: claimed.request_id,
        amount: round2(claimed.amount),
        currency: 'LKR',
        merchant: station ? { name: station.qr_merchant_name, city: station.qr_merchant_city, mcc: station.qr_mcc } : null,
        reference: `GETMEF-${claimed.id}`,
        fundingSource: 'payer',
        payer: { type: 'shopper', id: Number(claimed.shopper_id) },
        authBaseUrl,
        testOutcome: state.simulator ? testOutcome : null,
      }),
      PROVIDER_TIMEOUT_MS
    );
  } catch (caught) {
    result = { status: 'unknown', message: caught?.code === 'PROVIDER_TIMEOUT' ? 'No answer from the bank in time' : 'Could not reach the bank' };
  }
  return applyBankOutcome(id, result, { source: 'initiate' });
};

const queryBank = async (row, { force = false } = {}) => {
  if (row.status !== 'started' || !row.provider || !row.initiated_at) return row;
  const last = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0;
  if (!force && Date.now() - last < 3000) return row;
  const { state, available } = bankState();
  if (!available || state.key !== row.provider) return row;
  const expired = row.provider_status === 'action_required' && row.payer_auth_expires_at && new Date(row.payer_auth_expires_at).getTime() < Date.now();
  let result;
  try {
    result = await withTimeout(
      state.provider.queryStatus({ attemptId: `F${row.id}`, providerRef: row.provider_ref, idempotencyKey: row.request_id, amount: round2(row.amount) }),
      PROVIDER_TIMEOUT_MS
    );
  } catch {
    result = { status: 'unknown', message: 'Status check got no answer' };
  }
  if (expired && result?.status === 'action_required') {
    try {
      result = await withTimeout(state.provider.cancel ? state.provider.cancel({ attemptId: `F${row.id}`, providerRef: row.provider_ref }) : { status: 'unknown' }, PROVIDER_TIMEOUT_MS);
      if (result?.status === 'cancelled') result = { ...result, status: 'expired' };
    } catch {
      result = { status: 'unknown', message: 'Cancel got no answer' };
    }
  }
  return applyBankOutcome(row.id, result, { source: 'query' });
};

// Minute clock: open bank payments the app stopped asking about
const checkOpenBankPayments = async () => {
  const rows = (
    await pool.query(
      `SELECT * FROM fuel_payments WHERE provider IS NOT NULL AND status = 'started' AND initiated_at IS NOT NULL
          AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '30 seconds')
          AND initiated_at < NOW() - INTERVAL '20 seconds'
        ORDER BY updated_at LIMIT 25`
    )
  ).rows;
  for (const row of rows) {
    try {
      await queryBank(row, { force: true });
    } catch (caught) {
      console.error('❌ FUEL BANK STATUS CHECK:', row.id, caught.message);
    }
  }
};

try {
  const notify = require('../admin/notifications');
  if (typeof notify.addClockCheck === 'function') notify.addClockCheck('fuel bank payments', checkOpenBankPayments);
} catch (caught) {
  console.error('❌ fuel bank clock:', caught.message);
}

module.exports = {
  FUEL_TYPES,
  STATION_FIELDS,
  listStations,
  startPayment,
  reportPayment,
  cancelPayment,
  requireOwnOpenPayment,
  saveReceipt,
  listOwn,
  getOwn,
  currentPrices,
  adminListStations,
  adminSaveStation,
  adminSetStationQr,
  adminListPrices,
  adminAddPrice,
  adminListPayments,
  adminGetPayment,
  adminReview,
  // phase 56
  bankPaymentInfo,
  checkOpenBankPayments,
};
