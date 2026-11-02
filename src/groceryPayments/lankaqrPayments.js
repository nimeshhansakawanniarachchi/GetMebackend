const pool = require('../config/db');
const grocery = require('./groceryPayments');
const qr = require('./lankaqr');
const providers = require('./providers');
const companyFunding = require('../companyAccounts/integration');
const registry = require('../payments/merchantRegistry');

// =====================================================
// LANKAQR SCAN-TO-PAY FROM GETME'S COMPANY ACCOUNT (phase 49)
// sql/platform_phase49_lankaqr_company_payments.sql
//
// Method getme_lankaqr (funding getme). NO BANK INTEGRATION EXISTS:
// production has no provider (DFCC stub = not configured), so every
// endpoint answers 503 PROVIDER_NOT_CONFIGURED and the method is
// unavailable. Automated tests use the TEST SIMULATOR (no money moves,
// verification 'simulator', never bank-verified).
//
// Flow (built on the phase 38 attempts / reservations):
//   preview  parse + validate the QR, the order, the shop's approved
//            merchant and the amount; nothing is stored, no money moves
//   pay      re-validates everything under the order row lock, creates
//            the attempt once per idempotency key (request_id), then
//            calls provider.initiate ONCE (claimed atomically with
//            initiated_at). succeeded only from the provider; no answer
//            -> 'unknown' (live: no second payment) until queryStatus
//            (shopper poll + a minute clock) settles it.
//   success  store_payments row like the GetMe card path: funded_by
//            getme, reimbursement_status company_paid (never owed to
//            the shopper, never earnings); the bill photo is still
//            uploaded with the existing flow.
// Merchant substitution protection: a QR pays only a merchant approved
// for THAT shop (shop_lankaqr_merchants); name / city / MCC must match.
// Phase 50: GetMe pays from the company bank account set as this
// method's funding source (src/companyAccounts). No eligible account ->
// 409 FUNDING_ACCOUNT_NOT_SET / FUNDING_ACCOUNT_NOT_ELIGIBLE. The account
// (id + label, never its number) is snapshotted on the attempt and the
// store payment, and handed to provider.initiate.
//
// Phase 56: the same flow pays from the SHOPPER'S OWN bank account
// (method lankaqr_bank, funding shopper) - the CBSL-compliant
// third-party payment app model (research: pickme-style-lankaqr-
// research-2026-10-31.md). The provider usually answers
// 'action_required' with the bank's approval page (payer_auth_url): the
// shopper approves there (PIN / OTP at the bank, never in GetMe), and
// the result is taken only from the provider (status query / signed
// callback). On success the store payment is shopper-funded and
// reimbursed like any bill the shopper paid (verification 'provider').
// The shopper types the bill total before scanning; the QR amount must
// equal it. No bank offers this yet: only the TEST SIMULATOR runs it.
// =====================================================

const { round2, error, clean, addEntry } = grocery;
const store = () => require('../controllers/storePaymentController');
const notifications = () => require('../admin/notifications');

const METHOD = 'getme_lankaqr';
// Phase 56: shopper's own account through the provider
const BANK_METHOD = 'lankaqr_bank';
const MODES = {
  company: { method: METHOD, funding: 'getme', capability: 'companyFunded' },
  payer: { method: BANK_METHOD, funding: 'shopper', capability: 'payerFunded' },
};
const modeOf = (value) => (value === 'payer' || value === 'shopper_bank' ? 'payer' : 'company');
const modeOfMethod = (method) => (method === BANK_METHOD ? 'payer' : 'company');
// LankaPay's limit for a JustPay payment made by scanning a LankaQR
const PAYER_MAX_AMOUNT = Number(process.env.LANKAQR_PAYER_MAX_AMOUNT) || 200000;
const PAYER_SOURCE = 'Your own bank account';
// Neutral label when no funding account is set (phase 50: the real
// label comes from the funding account, e.g. "GetMe · DFCC Bank ••1234")
const PAYMENT_SOURCE = companyFunding.NEUTRAL_SOURCE;
const SIM_NOTICE = 'TEST SIMULATOR — no money moves';
const PROVIDER_TIMEOUT_MS = Number(process.env.GROCERY_QR_TIMEOUT_MS) || 20000;
// Shopper status checks call the provider at most this often
const CHECK_EVERY_MS = 3000;
// Created but never sent to the bank (process died before initiate)
const STALE_UNSENT_MS = 2 * 60 * 1000;

const toId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// ---------------------------------------------------
// Provider state
// ---------------------------------------------------

const publicProvider = (state = providers.current()) => ({
  key: state.key,
  label: state.label,
  configured: state.configured,
  usable: state.usable,
  live: state.live,
  liveFlag: state.liveFlag,
  simulator: state.simulator,
  reason: state.reason,
  notice: state.usable && state.simulator ? SIM_NOTICE : null,
});

const requireProvider = (mode = 'company') => {
  const state = providers.current();
  if (!state.usable) {
    throw error(503, `LankaQR ${mode === 'payer' ? 'bank payments' : "payments from GetMe's account"} are not available: ${state.reason}`, 'PROVIDER_NOT_CONFIGURED', {
      provider: publicProvider(state),
    });
  }
  // Phase 56: payer-funded payments need a provider that offers them
  if (mode === 'payer' && !state.provider.describe().capabilities?.payerFunded) {
    throw error(503, `${state.label} can't take payments from a shopper's own bank account`, 'PROVIDER_NOT_CONFIGURED', { provider: publicProvider(state) });
  }
  return state;
};

// Phase 50: the company account GetMe pays from must be set and
// eligible (active, supermarket payments, LKR, linked to the provider
// this server runs, approved). With lock, the funding row + account are
// held FOR SHARE so they can't be changed / deactivated mid-payment.
const requireFunding = async (client = pool, { lock = false } = {}) => {
  const row = (
    await client.query(
      `SELECT a.* FROM company_bank_account_funding f JOIN company_bank_accounts a ON a.id = f.account_id
       WHERE f.method_key = $1 ${lock ? 'FOR SHARE OF f, a' : ''}`,
      [METHOD]
    )
  ).rows[0];
  const check = companyFunding.eligibility(row || null, METHOD);
  if (!check.eligible) {
    throw error(
      409,
      row
        ? "GetMe's company account for LankaQR payments can't be used right now. Use another payment method."
        : "GetMe hasn't set the company account it pays LankaQR from. Use another payment method.",
      check.code
    );
  }
  return { account: row, label: companyFunding.sourceLabel(row) };
};

// Method switched on by the Super Admin, not off at this shop
const checkMethodOn = async (client, shopId, method = METHOD) => {
  const row = (
    await client.query(
      `SELECT m.enabled, o.enabled AS shop_enabled FROM grocery_payment_methods m
       LEFT JOIN grocery_shop_payment_methods o ON o.method_key = m.key AND o.shop_id = $1
       WHERE m.key = $2`,
      [shopId, method]
    )
  ).rows[0];
  const on = row ? (row.shop_enabled != null ? row.shop_enabled : row.enabled) : false;
  const name = method === BANK_METHOD ? 'LankaQR from your bank account' : 'LankaQR (GetMe pays)';
  if (!on) {
    throw error(409, row?.shop_enabled === false ? `${name} is not accepted at this store` : `${name} is not offered by GetMe right now`, 'METHOD_NOT_AVAILABLE');
  }
};

const parseQr = (payload) => {
  try {
    return qr.parse(payload);
  } catch (caught) {
    if (caught instanceof qr.LankaQrError) throw error(400, caught.message, 'INVALID_QR', { qrError: caught.code });
    throw caught;
  }
};

// ---------------------------------------------------
// Merchants approved per shop
// ---------------------------------------------------

const publicMerchant = (row) =>
  row
    ? {
        id: Number(row.id),
        shopId: Number(row.shop_id),
        shopName: row.shop_name ?? undefined,
        name: row.merchant_name,
        city: row.merchant_city,
        mcc: row.mcc,
        accountTags: row.account_tags,
        status: row.status,
        // Phase 55: grocery / fuel / other (from the MCC); CRC checked when parsed
        category: row.merchant_category || null,
        crcValid: row.crc_valid ?? null,
        submittedBy: row.submitted_by_type,
        submittedById: row.submitted_by_id != null ? Number(row.submitted_by_id) : null,
        submittedByName: row.submitter_name ?? undefined,
        submittedOrderId: row.submitted_order_id != null ? Number(row.submitted_order_id) : null,
        submittedNote: row.submitted_note || null,
        reviewedBy: row.reviewed_by != null ? Number(row.reviewed_by) : null,
        reviewedByName: row.reviewer_name ?? undefined,
        reviewedAt: row.reviewed_at,
        reviewNote: row.review_note || null,
        // Same LankaPay account approved at other shops (admin warning)
        otherShops: row.other_shops ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

// What the scanned QR is for this shop:
//   { status: 'approved', merchant } or a refusal code
const merchantCheck = async (client, shopId, parsed, { lock = false } = {}) => {
  // Phase 55 (P-10): a fuel station's QR never pays a supermarket
  if (await registry.fuelStationWithAccount(client, parsed.accountHash)) {
    return { code: 'MERCHANT_IS_FUEL_STATION', merchant: null };
  }

  const exact = (
    await client.query(`SELECT * FROM shop_lankaqr_merchants WHERE shop_id = $1 AND merchant_key = $2 ${lock ? 'FOR SHARE' : ''}`, [shopId, parsed.merchantKey])
  ).rows[0];

  if (exact?.status === 'approved') {
    // Belt and braces: the stored text must still match
    if (!qr.sameText(exact.merchant_name, parsed.merchantName) || !qr.sameText(exact.merchant_city, parsed.merchantCity) || exact.mcc !== parsed.mcc) {
      return { code: 'MERCHANT_MISMATCH', merchant: exact };
    }
    return { code: 'APPROVED', merchant: exact };
  }
  if (exact?.status === 'pending') return { code: 'MERCHANT_PENDING', merchant: exact };
  if (exact?.status === 'rejected') return { code: 'MERCHANT_REJECTED', merchant: exact };
  if (exact?.status === 'disabled') return { code: 'MERCHANT_DISABLED', merchant: exact };

  // Same LankaPay account approved here under another name / city / MCC
  const sameAccount = (
    await client.query("SELECT * FROM shop_lankaqr_merchants WHERE shop_id = $1 AND account_hash = $2 AND status = 'approved' LIMIT 1", [shopId, parsed.accountHash])
  ).rows[0];
  if (sameAccount) return { code: 'MERCHANT_MISMATCH', merchant: sameAccount };

  // Approved only for another shop: never pays this one
  const otherShop = (
    await client.query("SELECT 1 FROM shop_lankaqr_merchants WHERE account_hash = $1 AND shop_id <> $2 AND status = 'approved' LIMIT 1", [parsed.accountHash, shopId])
  ).rows[0];
  if (otherShop) return { code: 'MERCHANT_OTHER_SHOP', merchant: null };

  // A fuel / other-category merchant code isn't a supermarket till
  if (registry.categoryForMcc(parsed.mcc) === 'fuel') return { code: 'MERCHANT_CATEGORY', merchant: null };

  return { code: 'MERCHANT_UNKNOWN', merchant: null };
};

// Phase 55 (P-09 / P-10): what stops a QR being recorded / approved for
// a supermarket. -> throws
const refuseForSupermarket = async (client, shopId, accountHash, mcc) => {
  const station = await registry.fuelStationWithAccount(client, accountHash);
  if (station) throw error(409, `This QR is the approved QR of a fuel station (${station.name}), not a supermarket.`, 'MERCHANT_IS_FUEL_STATION');
  if (registry.categoryForMcc(mcc) === 'fuel') throw error(409, 'This QR has a fuel station merchant category, not a supermarket one.', 'MERCHANT_CATEGORY');
  const other = (
    await client.query(
      `SELECT lm.shop_id, s.shop_name FROM shop_lankaqr_merchants lm LEFT JOIN shops s ON s.id = lm.shop_id
       WHERE lm.account_hash = $1 AND lm.shop_id <> $2 AND lm.status = 'approved' LIMIT 1`,
      [accountHash, shopId]
    )
  ).rows[0];
  if (other) throw error(409, `This QR's account is already approved for another store (${other.shop_name || `shop #${other.shop_id}`}). Disable it there first if the store really changed.`, 'MERCHANT_OTHER_SHOP');
};

const MERCHANT_MESSAGES = {
  MERCHANT_UNKNOWN: "GetMe hasn't approved this store QR yet. Send it to GetMe for approval, or use another payment method.",
  MERCHANT_PENDING: 'This store QR is waiting for GetMe to approve it. Use another payment method for now.',
  MERCHANT_REJECTED: 'GetMe did not approve this QR for this store. Use another payment method and tell GetMe support.',
  MERCHANT_DISABLED: 'GetMe switched this store QR off. Use another payment method.',
  MERCHANT_MISMATCH: "This QR's store name, city or category doesn't match the QR GetMe approved for this store. Don't pay with it; tell GetMe support.",
  MERCHANT_OTHER_SHOP: "This QR is approved for a different GetMe store, not this one. Don't pay with it. You can send it to GetMe for review.",
  // Phase 55
  MERCHANT_IS_FUEL_STATION: "This is a fuel station's QR, not this store's. Don't pay with it; scan the QR at this store's till.",
  MERCHANT_CATEGORY: "This QR's merchant category isn't a supermarket. Don't pay with it; scan the QR at this store's till.",
};

const refuseMerchant = (check, parsed) => {
  const canSubmit = ['MERCHANT_UNKNOWN', 'MERCHANT_OTHER_SHOP'].includes(check.code);
  throw error(409, MERCHANT_MESSAGES[check.code], check.code, {
    canSubmit,
    merchant: { name: parsed.merchantName, city: parsed.merchantCity, mcc: parsed.mcc, submissionStatus: check.merchant?.status || null },
  });
};

// ---------------------------------------------------
// Shared checks (preview + pay)
// ---------------------------------------------------

// Amount the shop is paid: the dynamic QR's amount, else the bill
// amount the shopper typed (static QR)
const amountFor = (parsed, entered, billTotal = null) => {
  // Phase 56: the bill total typed before scanning must be the QR's amount
  if (parsed.amount != null && billTotal != null && Math.abs(round2(parsed.amount) - billTotal) > 0.005) {
    throw error(409, `The QR asks for Rs ${round2(parsed.amount).toFixed(2)} but the bill total is Rs ${billTotal.toFixed(2)}. Ask the cashier to check the bill before you pay.`, 'AMOUNT_MISMATCH', { field: 'billTotal' });
  }
  if (parsed.amount != null) {
    return { amount: parsed.amount, source: 'qr' };
  }
  if ((entered == null || entered === '') && billTotal != null) return { amount: billTotal, source: 'bill' };
  if (entered == null || entered === '') return { amount: null, source: 'shopper' };
  const text = String(entered).replace(/,/g, '').trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) throw error(400, 'Enter the bill amount in rupees (e.g. 4520.50)', 'INVALID_AMOUNT', { field: 'amount' });
  return { amount: round2(Number(text)), source: 'shopper' };
};

const checkAmount = (amount, limit, max = qr.MAX_AMOUNT) => {
  if (!(amount > 0)) throw error(400, 'Enter the bill amount', 'INVALID_AMOUNT', { field: 'amount' });
  if (amount < qr.MIN_AMOUNT) throw error(400, `The amount must be at least Rs ${qr.MIN_AMOUNT.toFixed(2)}`, 'INVALID_AMOUNT', { field: 'amount' });
  if (amount > max) {
    throw error(400, `One LankaQR payment can be at most Rs ${max.toLocaleString('en-LK')}${max === qr.MAX_AMOUNT ? ' (CBSL limit)' : ' (LankaPay limit for paying from a bank account)'}`, 'AMOUNT_OVER_CBSL_LIMIT', { field: 'amount' });
  }
  if (limit != null && amount > round2(limit) + 0.005) {
    throw error(409, `Rs ${amount.toFixed(2)} is over this shop's spending limit of Rs ${round2(limit).toFixed(2)}. GetMe can't pay more than the limit; ask GetMe support to raise it.`, 'OVER_LIMIT', {
      field: 'amount',
    });
  }
};

// Everything that must hold to pay this shop now (inside a transaction
// with the order row locked for pay; read-only for preview)
// Bill total typed before scanning (phase 56), optional
const billTotalOf = (value) => {
  if (value == null || value === '') return null;
  const text = String(value).replace(/,/g, '').trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text) || !(Number(text) > 0)) throw error(400, 'Enter the bill total in rupees (e.g. 4520.50)', 'INVALID_AMOUNT', { field: 'billTotal' });
  return round2(Number(text));
};

const validate = async (client, { shopperId, orderId, shopId, parsed, entered, lock, mode = 'company', billTotal = null }) => {
  const order = await grocery.orderForShopper(client, orderId, shopperId, shopId, { lock });
  await grocery.checkReadyToPay(client, order, shopId);
  await checkMethodOn(client, shopId, MODES[mode].method);

  const check = await merchantCheck(client, shopId, parsed, { lock });
  if (check.code !== 'APPROVED') refuseMerchant(check, parsed);

  const settings = await grocery.loadSettings(client);
  const reservation = lock
    ? await grocery.syncReservation(client, order, shopId, settings)
    : (await client.query('SELECT * FROM grocery_reservations WHERE order_id = $1 AND shop_id = $2', [order.id, shopId])).rows[0];
  if (!reservation) throw error(409, 'This order has no spending limit yet', 'NO_RESERVATION');

  const live = await grocery.liveAttempt(client, order.id, shopId, { lock });
  const blockingShop = (await grocery.shopStatesFor(client, order.id)).find(
    (shop) => shop.shopId !== Number(shopId) && ['awaiting_payment', 'awaiting_receipt'].includes(shop.state)
  );
  const existing = (await client.query('SELECT id, locked_at FROM store_payments WHERE order_id = $1 AND shop_id = $2', [order.id, shopId])).rows[0];
  const { amount, source } = amountFor(parsed, entered, billTotal);

  return { order, merchant: check.merchant, reservation, live, blockingShop, existing, amount, amountSource: source };
};

const refuseOpen = ({ live, blockingShop, existing }) => {
  if (live) {
    throw error(
      409,
      ['pending', 'unknown'].includes(live.status)
        ? 'A payment is already in progress for this shop. Wait for its result.'
        : 'This shop is already paid for this order',
      ['pending', 'unknown'].includes(live.status) ? 'PAYMENT_IN_PROGRESS' : 'ALREADY_PAID',
      { attemptId: Number(live.id) }
    );
  }
  if (blockingShop) {
    throw error(
      409,
      blockingShop.state === 'awaiting_payment'
        ? `Finish paying ${blockingShop.shopName} first.`
        : `Upload the receipt for ${blockingShop.shopName} before paying the next shop.`,
      'PREVIOUS_SHOP_OPEN',
      { blockingShopId: blockingShop.shopId }
    );
  }
  if (existing) throw error(409, 'This shop already has a store payment recorded. Ask GetMe support.', 'ALREADY_RECORDED');
};

// ---------------------------------------------------
// Shopper: preview (no money moves, nothing stored)
// ---------------------------------------------------

// POST /api/shopper/lankaqr/preview { orderId, shopId, qrPayload, amount?, billTotal?, source? }
// source: 'company' (GetMe pays, phase 49) | 'shopper_bank' (phase 56)
const preview = async ({ shopperId, orderId, shopId, qrPayload, amount, billTotal, source }) => {
  const mode = modeOf(source);
  const state = requireProvider(mode);
  const parsed = parseQr(qrPayload);
  const bill = billTotalOf(billTotal);
  // Ownership first (404), then refresh the spending limit
  await grocery.orderForShopper(pool, orderId, shopperId, shopId);
  await grocery.syncOrder(orderId);

  const v = await validate(pool, { shopperId, orderId, shopId, parsed, entered: amount, lock: false, mode, billTotal: bill });
  refuseOpen(v);
  const funding = mode === 'company' ? await requireFunding(pool) : { label: PAYER_SOURCE };

  const limit = round2(v.reservation.limit_amount);
  if (v.amount != null) checkAmount(v.amount, limit, mode === 'payer' ? PAYER_MAX_AMOUNT : qr.MAX_AMOUNT);

  const items = await store().shopItems(pool, v.order.id, shopId);
  const shop = (await pool.query('SELECT id, shop_name FROM shops WHERE id = $1', [shopId])).rows[0];

  return {
    preview: {
      merchant: { id: Number(v.merchant.id), name: parsed.merchantName, city: parsed.merchantCity, mcc: parsed.mcc, approved: true },
      qr: { kind: parsed.kind, referenceLabel: parsed.referenceLabel, billNumber: parsed.billNumber, terminalLabel: parsed.terminalLabel },
      billTotal: bill,
      source: mode === 'payer' ? 'shopper_bank' : 'company',
      // Phase 56: the bank asks the shopper to approve (OTP from Rs 10,000)
      bankApprovalNeeded: mode === 'payer',
      amount: v.amount,
      amountSource: v.amountSource,
      needsAmount: v.amount == null,
      currency: 'LKR',
      order: { id: Number(v.order.id), code: `GETME-${v.order.id}` },
      shop: { id: Number(shopId), name: shop?.shop_name || null },
      expectedAmount: store().expectedFor(items),
      limitAmount: limit,
      paymentSource: funding.label,
      provider: publicProvider(state),
      simulator: state.simulator,
      notice: state.simulator ? SIM_NOTICE : null,
    },
  };
};

// ---------------------------------------------------
// Attempt view / state changes
// ---------------------------------------------------

const attemptOf = async (attemptId, shopperId = null) => {
  const view = await grocery.attemptView(pool, attemptId);
  if (!view || (shopperId != null && view.shopperId !== Number(shopperId))) throw error(404, 'Payment not found', 'NOT_FOUND');
  return view;
};

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('Provider timeout'), { code: 'PROVIDER_TIMEOUT' })), ms)),
  ]);

// Phase 56: + action_required (payer approving at the bank), cancelled,
// expired
const PROVIDER_STATUSES = ['accepted', 'pending', 'action_required', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired', 'unknown'];

const normaliseResult = (result, { simulator = false } = {}) => {
  let status = PROVIDER_STATUSES.includes(result?.status) ? result.status : 'unknown';
  // The bank's approval page: https (the local simulator page may be http)
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

// Bank-confirmed (or statement-confirmed) payment -> store payment
// record, exactly like the GetMe card path: funded_by getme,
// reimbursement_status company_paid. Never refused because the order
// moved on: money already left GetMe's account.
const recordProviderPaid = async (client, { order, attempt, providerRef, verification, actorType = 'system', actorId = null }) => {
  const shopId = Number(attempt.shop_id);
  const amount = round2(attempt.requested_amount);
  const items = await store().shopItems(client, order.id, shopId);
  const expected = store().expectedFor(items);
  const merchant = attempt.merchant_id
    ? (await client.query('SELECT merchant_name, merchant_city FROM shop_lankaqr_merchants WHERE id = $1', [attempt.merchant_id])).rows[0]
    : null;
  const existing = (await client.query('SELECT * FROM store_payments WHERE order_id = $1 AND shop_id = $2 FOR UPDATE', [order.id, shopId])).rows[0];
  const sim = attempt.provider === 'simulator';

  // Should never happen (pay refuses when a record exists): keep the
  // money trail and flag it for an admin instead of overwriting
  if (existing) {
    await client.query(
      `UPDATE grocery_payment_attempts SET status = 'disputed', amount = $2, provider_ref = COALESCE($3, provider_ref),
         verification = $4, reconciliation_status = 'mismatch',
         reconciliation_note = 'Bank confirmed the payment but a store payment was already recorded for this shop',
         paid_at = COALESCE(paid_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [attempt.id, amount, providerRef, verification]
    );
    return { row: null, disputed: true };
  }

  const reservation = attempt.reservation_id
    ? (await client.query('SELECT * FROM grocery_reservations WHERE id = $1 FOR UPDATE', [attempt.reservation_id])).rows[0]
    : null;
  const limit = round2(reservation?.limit_amount ?? attempt.limit_amount);
  const overLimit = amount > limit + 0.005;
  const variance = round2(amount - expected);
  const needsReview = overLimit || Math.abs(variance) > store().reviewTolerance(expected);
  const reference = clean(providerRef || attempt.provider_ref || '', 40) || null;
  // Phase 56: paid from the shopper's own account -> reimbursed later
  const payer = attempt.method === BANK_METHOD;
  const note = clean(`LankaQR paid ${payer ? "from the shopper's bank account" : 'by GetMe'}${sim ? ` (${SIM_NOTICE})` : ''}${merchant ? ` to ${merchant.merchant_name}, ${merchant.merchant_city}` : ''}`, 300);

  const row = (
    await client.query(
      `INSERT INTO store_payments (
         order_id, shop_id, shopper_id, method, amount_paid, expected_amount,
         variance, reference, note, review_status, review_note, reimbursement_status,
         funded_by, attempt_id, card_id, funding_account_id, funding_account_label
       )
       VALUES ($1, $2, $3, $14, $4, $5, $6, $7, $8, $9, $10, $15, $16, $11, NULL, $12, $13)
       RETURNING *`,
      [
        order.id,
        shopId,
        Number(attempt.shopper_id),
        amount,
        expected,
        variance,
        reference,
        note,
        needsReview ? 'needs_review' : 'ok',
        overLimit ? `Rs ${amount.toFixed(2)} is over the spending limit of Rs ${limit.toFixed(2)}` : null,
        Number(attempt.id),
        // Phase 50: the company account it was paid from (snapshot)
        attempt.funding_account_id ?? null,
        attempt.funding_account_label ?? null,
        payer ? BANK_METHOD : METHOD,
        payer ? 'pending' : 'company_paid',
        payer ? 'shopper' : 'getme',
      ]
    )
  ).rows[0];

  await client.query(
    `UPDATE grocery_payment_attempts
     SET status = 'succeeded', amount = $2, reference = $3, store_payment_id = $4, over_limit = $5,
         expected_amount = $6, limit_amount = $7, verification = $8,
         provider_ref = COALESCE($9, provider_ref), paid_at = COALESCE(paid_at, NOW()), updated_at = NOW()
     WHERE id = $1`,
    [attempt.id, amount, reference, row.id, overLimit, expected, limit, verification, providerRef]
  );

  if (reservation) {
    await client.query(
      `UPDATE grocery_reservations SET captured_amount = $2,
         status = CASE WHEN status IN ('settled', 'released') THEN 'settled' ELSE 'captured' END, updated_at = NOW()
       WHERE id = $1`,
      [reservation.id, amount]
    );
  }

  await addEntry(client, {
    type: 'capture',
    orderId: order.id,
    shopId,
    shopperId: attempt.shopper_id,
    reservationId: attempt.reservation_id,
    attemptId: attempt.id,
    amount,
    actorType,
    actorId,
    note: `LankaQR (${payer ? 'shopper\'s bank account' : 'GetMe pays'}): Rs ${amount.toFixed(2)} ${sim ? `${SIM_NOTICE}` : verification === 'statement' ? 'confirmed with the bank statement' : 'confirmed by the bank'}${reference ? ` · ref ${reference}` : ''}`,
  });

  await store().syncOrderReimbursement(client, order.id);
  return { row, disputed: false };
};

// Applies a provider answer to an open attempt (order row, then the
// attempt locked - the same lock order as every payment path)
const applyOutcome = async (attemptId, rawResult, { source = 'provider', io = null } = {}) => {
  const peek = (await pool.query('SELECT order_id, provider FROM grocery_payment_attempts WHERE id = $1', [attemptId])).rows[0];
  const result = normaliseResult(rawResult, { simulator: peek?.provider === 'simulator' });
  if (!peek) return null;

  const client = await pool.connect();
  let paidRow = null;
  let orderId = Number(peek.order_id);

  try {
    await client.query('BEGIN');
    const order = (await client.query('SELECT id, status, shopper_id FROM orders WHERE id = $1 FOR UPDATE', [orderId])).rows[0];
    const attempt = (await client.query('SELECT * FROM grocery_payment_attempts WHERE id = $1 FOR UPDATE', [attemptId])).rows[0];

    if (!attempt || !['pending', 'unknown'].includes(attempt.status)) {
      await client.query('COMMIT');
      return attempt;
    }

    await client.query(
      `UPDATE grocery_payment_attempts
       SET provider_ref = COALESCE($2, provider_ref), provider_status = $3::varchar, provider_message = COALESCE($4, provider_message),
           last_checked_at = CASE WHEN $5 = 'query' THEN NOW() ELSE last_checked_at END,
           status_checks = status_checks + CASE WHEN $5 = 'query' THEN 1 ELSE 0 END,
           payer_auth_url = CASE WHEN $3::varchar = 'action_required' THEN $6::text ELSE NULL END,
           payer_auth_expires_at = CASE WHEN $3::varchar = 'action_required' THEN COALESCE($7::timestamptz, payer_auth_expires_at) ELSE payer_auth_expires_at END,
           updated_at = NOW()
       WHERE id = $1`,
      [attempt.id, result.providerRef, result.status, result.message, source, result.authUrl, result.expiresAt]
    );
    const ref = result.providerRef || attempt.provider_ref || null;
    const entry = { orderId, shopId: attempt.shop_id, shopperId: attempt.shopper_id, reservationId: attempt.reservation_id, attemptId: attempt.id };

    if (result.status === 'succeeded') {
      if (result.amount != null && Math.abs(result.amount - round2(attempt.requested_amount)) > 0.005) {
        // The bank paid a different amount than was confirmed: disputed
        await client.query(
          `UPDATE grocery_payment_attempts SET status = 'disputed', amount = $2, reconciliation_status = 'mismatch',
             reconciliation_note = $3, verification = $4, paid_at = COALESCE(paid_at, NOW()), updated_at = NOW() WHERE id = $1`,
          [attempt.id, result.amount, `Bank paid Rs ${result.amount.toFixed(2)}, confirmed Rs ${round2(attempt.requested_amount).toFixed(2)}`, attempt.provider === 'simulator' ? 'simulator' : 'provider']
        );
      } else {
        const paid = await recordProviderPaid(client, {
          order,
          attempt,
          providerRef: ref,
          verification: attempt.provider === 'simulator' ? 'simulator' : 'provider',
        });
        paidRow = paid.row;
      }
    } else if (result.status === 'failed' || result.status === 'rejected') {
      const why = result.message || (result.status === 'rejected' ? 'Rejected by the bank' : 'Declined by the bank');
      await client.query('UPDATE grocery_payment_attempts SET status = $2, failure_reason = $3, updated_at = NOW() WHERE id = $1', [attempt.id, result.status, why]);
      await addEntry(client, { ...entry, type: 'attempt_failed', amount: attempt.requested_amount, note: `LankaQR ${result.status}: ${why}`.slice(0, 300) });
    } else if (result.status === 'cancelled' || result.status === 'expired') {
      // Phase 56: the payer cancelled / never approved at the bank
      const why = result.status === 'expired' ? 'Not approved at the bank in time' : result.message || 'Cancelled at the bank';
      await client.query("UPDATE grocery_payment_attempts SET status = 'cancelled', failure_reason = $2, updated_at = NOW() WHERE id = $1", [attempt.id, clean(why, 300)]);
      await addEntry(client, { ...entry, type: 'attempt_failed', amount: attempt.requested_amount, note: `LankaQR ${result.status}: ${why}`.slice(0, 300) });
    } else if (result.status === 'unknown') {
      if (attempt.status !== 'unknown') await client.query("UPDATE grocery_payment_attempts SET status = 'unknown', updated_at = NOW() WHERE id = $1", [attempt.id]);
    } else if (attempt.status === 'unknown') {
      // pending / accepted after an unknown: back to pending (still live)
      await client.query("UPDATE grocery_payment_attempts SET status = 'pending', updated_at = NOW() WHERE id = $1", [attempt.id]);
    }

    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  if (paidRow) await grocery.finishAfterCommit(orderId, paidRow, io);
  return (await pool.query('SELECT * FROM grocery_payment_attempts WHERE id = $1', [attemptId])).rows[0];
};

// Calls provider.initiate at most once per attempt: the claim on
// initiated_at is atomic, so duplicate taps / concurrent requests can't
// send a second payment instruction
const initiateOnce = async (attemptId, { testOutcome = null, io = null, authBaseUrl = null } = {}) => {
  const claimed = (
    await pool.query(
      `UPDATE grocery_payment_attempts SET initiated_at = NOW(), initiate_count = initiate_count + 1, updated_at = NOW()
       WHERE id = $1 AND initiated_at IS NULL AND status = 'pending' AND provider IS NOT NULL
       RETURNING *`,
      [attemptId]
    )
  ).rows[0];
  if (!claimed) return null;

  const state = providers.current();
  // The provider changed since the attempt was created: never send it
  // to another provider
  if (!state.usable || state.key !== claimed.provider) {
    return applyOutcome(attemptId, { status: 'failed', message: 'Not sent: the payment provider is not available' }, { source: 'initiate', io });
  }

  // Phase 50: the company account this attempt pays from must still be
  // active (it was eligible when the attempt was created). Phase 56: a
  // payer-funded payment has no company account.
  const payer = claimed.method === BANK_METHOD;
  const fundingAccount = claimed.funding_account_id
    ? (await pool.query('SELECT * FROM company_bank_accounts WHERE id = $1', [claimed.funding_account_id])).rows[0]
    : null;
  if (!payer && (!fundingAccount || fundingAccount.status !== 'active')) {
    return applyOutcome(attemptId, { status: 'failed', message: "Not sent: GetMe's company account for this payment is not active" }, { source: 'initiate', io });
  }

  const merchant = (await pool.query('SELECT merchant_name, merchant_city, mcc, account_tags FROM shop_lankaqr_merchants WHERE id = $1', [claimed.merchant_id])).rows[0];
  let result;
  try {
    result = await withTimeout(
      state.provider.initiate({
        attemptId: Number(claimed.id),
        idempotencyKey: claimed.request_id,
        amount: round2(claimed.requested_amount),
        currency: 'LKR',
        merchant: merchant ? { name: merchant.merchant_name, city: merchant.merchant_city, mcc: merchant.mcc, accountTags: merchant.account_tags } : null,
        reference: `GETME-${claimed.order_id}-${claimed.id}`,
        // Phase 50: which company account pays (id, bank, last 4 - never the number)
        fundingAccount: payer ? null : companyFunding.providerAccount(fundingAccount),
        // Phase 56: payer-funded = the shopper approves at their bank
        fundingSource: payer ? 'payer' : 'company',
        payer: payer ? { type: 'shopper', id: Number(claimed.shopper_id) } : null,
        authBaseUrl,
        testOutcome: state.simulator ? testOutcome : null,
      }),
      PROVIDER_TIMEOUT_MS
    );
  } catch (caught) {
    // Timeout / network error: the bank may or may not have paid
    result = { status: 'unknown', message: caught?.code === 'PROVIDER_TIMEOUT' ? 'No answer from the bank in time' : 'Could not reach the bank' };
  }

  return applyOutcome(attemptId, result, { source: 'initiate', io });
};

// Asks the provider for an open attempt's status (shopper poll, clock,
// admin "check now")
const queryOnce = async (attempt, { io = null, testOutcome = null } = {}) => {
  const state = providers.current();
  if (!state.usable || state.key !== attempt.provider) return null;

  let result;
  try {
    result = await withTimeout(
      state.provider.queryStatus({
        attemptId: Number(attempt.id),
        providerRef: attempt.provider_ref || null,
        idempotencyKey: attempt.request_id,
        amount: round2(attempt.requested_amount),
        testOutcome: state.simulator ? testOutcome : null,
      }),
      PROVIDER_TIMEOUT_MS
    );
  } catch {
    result = { status: 'unknown', message: 'Status check got no answer' };
  }
  return applyOutcome(Number(attempt.id), result, { source: 'query', io });
};

// Created but never sent (crash between insert and initiate): nothing
// was sent to the bank, so it is safe to close
const closeUnsent = async (attemptId) => {
  const row = (
    await pool.query(
      `UPDATE grocery_payment_attempts SET status = 'failed', failure_reason = 'Not sent to the bank (interrupted). Scan again.', updated_at = NOW()
       WHERE id = $1 AND status = 'pending' AND initiated_at IS NULL AND provider IS NOT NULL RETURNING *`,
      [attemptId]
    )
  ).rows[0];
  if (row) {
    await addEntry(pool, { type: 'attempt_failed', orderId: row.order_id, shopId: row.shop_id, shopperId: row.shopper_id, reservationId: row.reservation_id, attemptId: row.id, note: 'LankaQR not sent to the bank (interrupted)' });
  }
  return row;
};

// ---------------------------------------------------
// Shopper: pay
// ---------------------------------------------------

const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,80}$/;

// POST /api/shopper/lankaqr/pay { orderId, shopId, qrPayload, amount, idempotencyKey, billTotal?, source? }
const pay = async ({ shopperId, orderId, shopId, qrPayload, amount, idempotencyKey, billTotal, source, authBaseUrl = null, testOutcome = null, io = null }) => {
  const mode = modeOf(source);
  const { method } = MODES[mode];
  const state = requireProvider(mode);
  const bill = billTotalOf(billTotal);
  const key = String(idempotencyKey ?? '').trim();
  if (!KEY_PATTERN.test(key)) throw error(400, 'Missing payment key. Update the app and try again.', 'IDEMPOTENCY_KEY_REQUIRED');

  // Same key again (double tap, retry after a lost reply): the same
  // attempt, never a second payment instruction
  const again = async () => {
    const row = (await pool.query('SELECT * FROM grocery_payment_attempts WHERE shopper_id = $1 AND request_id = $2', [shopperId, key])).rows[0];
    if (!row) return null;
    if (Number(row.order_id) !== Number(orderId) || Number(row.shop_id) !== Number(shopId) || row.method !== method) {
      throw error(409, 'This payment key was already used for another payment', 'IDEMPOTENCY_KEY_REUSED');
    }
    return row;
  };

  const before = await again();
  if (before) {
    return { attempt: await attemptOf(before.id, shopperId), duplicate: true };
  }

  const parsed = parseQr(qrPayload);
  const client = await pool.connect();
  let attemptId;

  try {
    await client.query('BEGIN');
    const v = await validate(client, { shopperId, orderId, shopId, parsed, entered: amount, lock: true, mode, billTotal: bill });

    // A concurrent request with the same key won the order lock first
    if (v.live && v.live.request_id === key && Number(v.live.shopper_id) === Number(shopperId)) {
      await client.query('COMMIT');
      return { attempt: await attemptOf(v.live.id, shopperId), duplicate: true };
    }
    refuseOpen(v);
    if (v.amount == null) throw error(400, 'Enter the bill amount', 'INVALID_AMOUNT', { field: 'amount' });
    checkAmount(v.amount, v.reservation.limit_amount, mode === 'payer' ? PAYER_MAX_AMOUNT : qr.MAX_AMOUNT);
    const funding = mode === 'company' ? await requireFunding(client, { lock: true }) : null;

    const items = await store().shopItems(client, v.order.id, shopId);
    const inserted = (
      await client.query(
        `INSERT INTO grocery_payment_attempts (
           order_id, shop_id, shopper_id, reservation_id, method, funding, status,
           expected_amount, limit_amount, request_id, provider, requested_amount, merchant_id, qr_kind, qr_reference,
           funding_account_id, funding_account_label, bill_total
         ) VALUES ($1, $2, $3, $4, $5, $16, 'pending', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $17)
         RETURNING id`,
        [
          v.order.id,
          shopId,
          shopperId,
          v.reservation.id,
          method,
          store().expectedFor(items),
          round2(v.reservation.limit_amount),
          key,
          state.key,
          v.amount,
          v.merchant.id,
          parsed.kind,
          parsed.referenceLabel ? clean(parsed.referenceLabel, 25) : null,
          funding ? Number(funding.account.id) : null,
          funding ? funding.label : null,
          MODES[mode].funding,
          bill,
        ]
      )
    ).rows[0];
    attemptId = Number(inserted.id);

    await addEntry(client, {
      type: 'attempt_start',
      orderId: v.order.id,
      shopId,
      shopperId,
      reservationId: v.reservation.id,
      attemptId,
      amount: v.amount,
      actorType: 'shopper',
      actorId: shopperId,
      note: `LankaQR (${mode === 'payer' ? "shopper's bank account" : 'GetMe pays'})${state.simulator ? ` · ${SIM_NOTICE}` : ''}: Rs ${v.amount.toFixed(2)} to ${parsed.merchantName}, ${parsed.merchantCity}`,
    });
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    if (caught.code === '23505') {
      const row = await again();
      if (row) return { attempt: await attemptOf(row.id, shopperId), duplicate: true };
      throw error(409, 'A payment is already in progress for this shop. Wait for its result.', 'PAYMENT_IN_PROGRESS');
    }
    throw caught;
  } finally {
    client.release();
  }

  await initiateOnce(attemptId, { testOutcome, io, authBaseUrl });
  return { attempt: await attemptOf(attemptId, shopperId), duplicate: false };
};

// Phase 56: an approval page nobody finished -> ask the bank, then stop it
const expireIfOverdue = async (row, { io = null } = {}) => {
  if (row.provider_status !== 'action_required' || !row.payer_auth_expires_at) return false;
  if (new Date(row.payer_auth_expires_at).getTime() > Date.now()) return false;
  const state = providers.current();
  if (!state.usable || state.key !== row.provider) return false;
  const after = await queryOnce(row, { io });
  if (after?.provider_status !== 'action_required') return true;
  let result;
  try {
    result = await withTimeout(state.provider.cancel ? state.provider.cancel({ attemptId: Number(row.id), providerRef: row.provider_ref, idempotencyKey: row.request_id }) : { status: 'unknown' }, PROVIDER_TIMEOUT_MS);
  } catch {
    result = { status: 'unknown', message: 'Cancel got no answer' };
  }
  await applyOutcome(Number(row.id), ['cancelled', 'expired'].includes(result?.status) ? { ...result, status: 'expired' } : result, { source: 'query', io });
  return true;
};

// POST /api/shopper/lankaqr/attempts/:id/cancel - stop a payment the
// shopper has not approved at the bank yet (or never sent)
const cancel = async ({ shopperId, attemptId, io = null }) => {
  const row = (await pool.query('SELECT * FROM grocery_payment_attempts WHERE id = $1 AND shopper_id = $2', [attemptId, shopperId])).rows[0];
  if (!row || ![METHOD, BANK_METHOD].includes(row.method)) throw error(404, 'Payment not found', 'NOT_FOUND');
  if (!['pending', 'unknown'].includes(row.status)) throw error(409, 'This payment is already finished', 'WRONG_STATUS');

  if (!row.initiated_at) {
    await closeUnsent(row.id);
  } else if (row.provider_status === 'action_required') {
    const state = providers.current();
    if (!state.usable || state.key !== row.provider) throw error(503, 'The payment provider is not available. Try again later.', 'PROVIDER_NOT_CONFIGURED');
    let result;
    try {
      result = await withTimeout(state.provider.cancel ? state.provider.cancel({ attemptId: Number(row.id), providerRef: row.provider_ref, idempotencyKey: row.request_id }) : { status: 'unknown' }, PROVIDER_TIMEOUT_MS);
    } catch {
      result = { status: 'unknown', message: 'Cancel got no answer' };
    }
    // Only the bank's answer counts: if it says paid, it is paid
    if (['cancelled', 'expired', 'failed', 'succeeded'].includes(result?.status)) await applyOutcome(Number(row.id), result, { source: 'query', io });
    else await queryOnce(row, { io });
  } else {
    throw error(409, 'This payment is already with the bank. Wait for its result.', 'CANNOT_CANCEL');
  }
  return { attempt: await attemptOf(row.id, shopperId) };
};

// GET /api/shopper/lankaqr/attempts/:id - the app's status poll (and
// resume after a restart). Asks the provider for open attempts.
const status = async ({ shopperId, attemptId, testOutcome = null, io = null }) => {
  const row = (await pool.query('SELECT * FROM grocery_payment_attempts WHERE id = $1 AND shopper_id = $2', [attemptId, shopperId])).rows[0];
  if (!row || ![METHOD, BANK_METHOD].includes(row.method)) throw error(404, 'Payment not found', 'NOT_FOUND');

  if (row.status === 'pending' && !row.initiated_at && Date.now() - new Date(row.created_at).getTime() > STALE_UNSENT_MS) {
    await closeUnsent(row.id);
  } else if (await expireIfOverdue(row, { io })) {
    // settled above
  } else if (['pending', 'unknown'].includes(row.status) && row.initiated_at) {
    const last = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0;
    if (Date.now() - last >= CHECK_EVERY_MS) await queryOnce(row, { io, testOutcome });
  }

  const state = providers.current();
  return { attempt: await attemptOf(row.id, shopperId), provider: publicProvider(state) };
};

// ---------------------------------------------------
// Shopper: send an unknown QR to GetMe for approval
// ---------------------------------------------------

// POST /api/shopper/lankaqr/merchant-submissions { orderId, shopId, qrPayload, note? }
const submitMerchant = async ({ shopperId, orderId, shopId, qrPayload, note }) => {
  requireProvider();
  const parsed = parseQr(qrPayload);
  const order = await grocery.orderForShopper(pool, orderId, shopperId, shopId);
  if (['cancelled', 'delivered'].includes(order.status)) throw error(409, 'This order is finished', 'ORDER_FINISHED');

  const existing = (await pool.query('SELECT * FROM shop_lankaqr_merchants WHERE shop_id = $1 AND merchant_key = $2', [shopId, parsed.merchantKey])).rows[0];
  if (!existing) {
    const station = await registry.fuelStationWithAccount(pool, parsed.accountHash);
    if (station || registry.categoryForMcc(parsed.mcc) === 'fuel') {
      throw error(409, MERCHANT_MESSAGES[station ? 'MERCHANT_IS_FUEL_STATION' : 'MERCHANT_CATEGORY'], station ? 'MERCHANT_IS_FUEL_STATION' : 'MERCHANT_CATEGORY');
    }
  }
  if (existing) {
    return {
      merchant: publicMerchant(existing),
      created: false,
      message:
        existing.status === 'approved'
          ? 'This store QR is already approved.'
          : existing.status === 'pending'
          ? 'Already sent: GetMe is checking this store QR.'
          : 'GetMe already reviewed this store QR and did not approve it.',
    };
  }

  const row = (
    await pool.query(
      `INSERT INTO shop_lankaqr_merchants (
         shop_id, merchant_key, account_hash, account_tags, merchant_name, merchant_city, mcc,
         status, submitted_by_type, submitted_by_id, submitted_order_id, submitted_note, sample_payload,
         crc_valid, merchant_category
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'shopper', $8, $9, $10, $11, TRUE, $12)
       ON CONFLICT (shop_id, merchant_key) DO NOTHING
       RETURNING *`,
      [shopId, parsed.merchantKey, parsed.accountHash, parsed.merchantAccount.label, clean(parsed.merchantName, 50), clean(parsed.merchantCity, 30), parsed.mcc, shopperId, order.id, clean(note, 300) || null, parsed.sample, registry.categoryForMcc(parsed.mcc)]
    )
  ).rows[0];

  if (!row) {
    const again = (await pool.query('SELECT * FROM shop_lankaqr_merchants WHERE shop_id = $1 AND merchant_key = $2', [shopId, parsed.merchantKey])).rows[0];
    return { merchant: publicMerchant(again), created: false, message: 'Already sent: GetMe is checking this store QR.' };
  }

  const shop = (await pool.query('SELECT shop_name FROM shops WHERE id = $1', [shopId])).rows[0];
  // Payments category (grocery.manage approves); no personal data
  await notifications().notify({
    category: 'payments',
    event: 'lankaqr.merchant_submitted',
    severity: 'warning',
    title: `Store QR to approve: ${clean(parsed.merchantName, 40)} at ${shop?.shop_name || `shop #${shopId}`}`,
    body: `A shopper scanned a LankaQR code GetMe hasn't approved (${clean(parsed.merchantCity, 20)}, order #${order.id}). Approve it before GetMe can pay it.`,
    entityType: 'order',
    entityId: order.id,
    permissions: ['grocery.manage'],
    dedupe: `lankaqr.merchant:${row.id}`,
  });

  return { merchant: publicMerchant(row), created: true, message: 'Sent to GetMe. Use another payment method until it is approved.' };
};

// ---------------------------------------------------
// Admin
// ---------------------------------------------------

const MERCHANT_SELECT = `
  SELECT lm.*, s.shop_name, ad.full_name AS reviewer_name,
         CASE WHEN lm.submitted_by_type = 'admin' THEN sa.full_name ELSE split_part(COALESCE(sh.full_name, ''), ' ', 1) END AS submitter_name,
         (SELECT COALESCE(json_agg(json_build_object('shopId', o.shop_id, 'shopName', os.shop_name, 'status', o.status)), '[]'::json)
          FROM shop_lankaqr_merchants o LEFT JOIN shops os ON os.id = o.shop_id
          WHERE o.account_hash = lm.account_hash AND o.id <> lm.id) AS other_shops
  FROM shop_lankaqr_merchants lm
  LEFT JOIN shops s ON s.id = lm.shop_id
  LEFT JOIN admins ad ON ad.id = lm.reviewed_by
  LEFT JOIN admins sa ON lm.submitted_by_type = 'admin' AND sa.id = lm.submitted_by_id
  LEFT JOIN shoppers sh ON lm.submitted_by_type = 'shopper' AND sh.id = lm.submitted_by_id
`;

// GET /api/admin/lankaqr/merchants?status=&shopId=
const listMerchants = async (query = {}) => {
  const where = ['TRUE'];
  const params = [];
  if (['pending', 'approved', 'rejected', 'disabled'].includes(query.status)) {
    params.push(query.status);
    where.push(`lm.status = $${params.length}`);
  }
  if (toId(query.shopId)) {
    params.push(toId(query.shopId));
    where.push(`lm.shop_id = $${params.length}`);
  }
  const rows = (await pool.query(`${MERCHANT_SELECT} WHERE ${where.join(' AND ')} ORDER BY (lm.status = 'pending') DESC, lm.updated_at DESC LIMIT 200`, params)).rows;
  const counts = (await pool.query('SELECT status, COUNT(*)::int AS n FROM shop_lankaqr_merchants GROUP BY status')).rows;
  return { merchants: rows.map(publicMerchant), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
};

const merchantRow = async (id) => (await pool.query(`${MERCHANT_SELECT} WHERE lm.id = $1`, [id])).rows[0];

// PATCH /api/admin/lankaqr/merchants/:id { action: approve|reject|disable, note }
const reviewMerchant = async (merchantId, input = {}, admin) => {
  const id = toId(merchantId);
  const action = String(input.action || '');
  const note = clean(input.note, 300);
  if (!id) throw error(400, 'Invalid merchant');
  if (!['approve', 'reject', 'disable'].includes(action)) throw error(400, 'Choose approve, reject or disable');
  if (action !== 'approve' && note.length < 3) throw error(400, 'Say why (at least 3 characters)', 'NOTE_REQUIRED', { field: 'note' });

  const before = (await pool.query('SELECT * FROM shop_lankaqr_merchants WHERE id = $1', [id])).rows[0];
  if (!before) throw error(404, 'Store QR not found');

  const next = { approve: 'approved', reject: 'rejected', disable: 'disabled' }[action];
  if (action === 'disable' && before.status !== 'approved') throw error(409, 'Only an approved store QR can be disabled', 'WRONG_STATUS');
  if (action === 'reject' && before.status !== 'pending') throw error(409, 'Only a store QR waiting for review can be rejected', 'WRONG_STATUS');
  if (before.status === next) throw error(409, `This store QR is already ${next}`, 'WRONG_STATUS');
  if (action === 'approve') {
    // Phase 55 (P-09): fuel station QRs, fuel categories and QRs approved
    // for another store can't be approved here; nobody approves a QR they
    // submitted themselves
    await refuseForSupermarket(pool, before.shop_id, before.account_hash, before.mcc);
    if (before.submitted_by_type === 'admin' && Number(before.submitted_by_id) === Number(admin?.adminId)) {
      throw error(409, 'Another admin has to approve a store QR you added', 'SAME_ADMIN');
    }
  }

  await pool.query(
    'UPDATE shop_lankaqr_merchants SET status = $2, reviewed_by = $3, reviewed_at = NOW(), review_note = $4, updated_at = NOW() WHERE id = $1',
    [id, next, admin?.adminId ?? null, note || null]
  );

  const after = await merchantRow(id);
  return {
    merchant: publicMerchant(after),
    message: { approved: 'Store QR approved for this shop', rejected: 'Store QR rejected', disabled: 'Store QR disabled' }[next],
    audit: {
      summary: `${{ approve: 'Approved', reject: 'Rejected', disable: 'Disabled' }[action]} LankaQR merchant "${before.merchant_name}, ${before.merchant_city}" for shop #${before.shop_id}${note ? `: ${note}` : ''}`.slice(0, 300),
      before: { status: before.status },
      after: { status: next },
    },
  };
};

// POST /api/admin/lankaqr/merchants { shopId, qrPayload, note } - staff
// add a store QR they checked themselves (approved at once)
const createMerchant = async (input = {}, admin) => {
  const shopId = toId(input.shopId);
  if (!shopId || !(await pool.query('SELECT 1 FROM shops WHERE id = $1', [shopId])).rows.length) throw error(404, 'Shop not found', 'SHOP_NOT_FOUND', { field: 'shopId' });
  const parsed = parseQr(input.qrPayload);
  const note = clean(input.note, 300);
  if (note.length < 3) throw error(400, 'Say how you checked this QR (at least 3 characters)', 'NOTE_REQUIRED', { field: 'note' });
  await refuseForSupermarket(pool, shopId, parsed.accountHash, parsed.mcc);

  const row = (
    await pool.query(
      `INSERT INTO shop_lankaqr_merchants (
         shop_id, merchant_key, account_hash, account_tags, merchant_name, merchant_city, mcc, status,
         submitted_by_type, submitted_by_id, submitted_note, sample_payload, reviewed_by, reviewed_at, review_note,
         crc_valid, merchant_category
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', 'admin', $8, $9, $10, $8, NOW(), $9, TRUE, $11)
       ON CONFLICT (shop_id, merchant_key) DO NOTHING
       RETURNING id`,
      [shopId, parsed.merchantKey, parsed.accountHash, parsed.merchantAccount.label, clean(parsed.merchantName, 50), clean(parsed.merchantCity, 30), parsed.mcc, admin?.adminId ?? null, note, parsed.sample, registry.categoryForMcc(parsed.mcc)]
    )
  ).rows[0];
  if (!row) throw error(409, 'This store QR is already recorded for this shop. Approve it from the list.', 'DUPLICATE');

  return {
    merchant: publicMerchant(await merchantRow(row.id)),
    message: 'Store QR added and approved for this shop',
    audit: { summary: `Added + approved LankaQR merchant "${parsed.merchantName}, ${parsed.merchantCity}" for shop #${shopId}: ${note}`.slice(0, 300) },
  };
};

// GET /api/admin/lankaqr/status - provider card (no secrets)
const adminStatus = async () => {
  const [method, counts, open] = await Promise.all([
    pool.query('SELECT enabled, updated_at, updated_by FROM grocery_payment_methods WHERE key = $1', [METHOD]),
    pool.query('SELECT status, COUNT(*)::int AS n FROM shop_lankaqr_merchants GROUP BY status'),
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'unknown')::int AS unknown,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'succeeded' AND provider = 'simulator')::int AS simulated_paid
       FROM grocery_payment_attempts WHERE method = $1`,
      [METHOD]
    ),
  ]);
  const state = providers.current();
  // Phase 50: the company account it pays from (masked label only)
  const funding = await companyFunding.fundingFor(METHOD);
  return {
    provider: publicProvider(state),
    method: { key: METHOD, enabled: Boolean(method.rows[0]?.enabled), usable: Boolean(method.rows[0]?.enabled) && state.usable && funding.eligible, updatedAt: method.rows[0]?.updated_at || null },
    paymentSource: funding.label,
    fundingAccount: {
      set: Boolean(funding.account),
      id: funding.account ? Number(funding.account.id) : null,
      label: funding.label,
      eligible: funding.eligible,
      code: funding.code,
      reasons: funding.reasons,
    },
    merchants: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])),
    attempts: open.rows[0],
    environment: { productionNode: String(process.env.NODE_ENV || '').toLowerCase() === 'production' },
  };
};

// Admin actions on a LANKAQR attempt (PATCH /api/admin/grocery-payments/:id)
//   check_provider    ask the provider now
//   resolve_provider  { outcome: failed|succeeded, note, statementReference }
//                     for an open attempt the provider can't settle;
//                     succeeded needs the bank statement reference and
//                     is never allowed for a simulated attempt
const adminProviderAction = async (attempt, input, adminId) => {
  const action = String(input.action || '');
  if (![METHOD, BANK_METHOD].includes(attempt.method) || !attempt.provider) throw error(409, 'This is not a LankaQR provider payment', 'WRONG_METHOD');
  if (!['pending', 'unknown'].includes(attempt.status)) throw error(409, 'This payment is already settled', 'WRONG_STATUS');

  if (action === 'check_provider') {
    if (!attempt.initiated_at) {
      await closeUnsent(attempt.id);
      return { message: 'It was never sent to the bank, so it is closed as failed.' };
    }
    const state = providers.current();
    if (!state.usable || state.key !== attempt.provider) throw error(503, `The provider is not available: ${state.reason}`, 'PROVIDER_NOT_CONFIGURED');
    await queryOnce(attempt);
    return { message: 'Checked with the provider' };
  }

  const outcome = String(input.outcome || '');
  const note = clean(input.note, 300);
  const statementReference = clean(input.statementReference, 60) || null;
  if (!['failed', 'succeeded'].includes(outcome)) throw error(400, 'Choose failed or succeeded');
  if (note.length < 3) throw error(400, 'Say what the bank confirmed (at least 3 characters)', 'NOTE_REQUIRED', { field: 'note' });
  if (outcome === 'succeeded' && attempt.provider === 'simulator') {
    throw error(409, 'A TEST SIMULATOR payment moved no money: it can only be closed as failed.', 'SIMULATOR_NOT_BANK');
  }
  if (outcome === 'succeeded' && (!statementReference || statementReference.length < 3)) {
    throw error(400, "Enter the bank statement reference of GetMe's payment", 'STATEMENT_REQUIRED', { field: 'statementReference' });
  }

  const client = await pool.connect();
  let paidRow = null;
  try {
    await client.query('BEGIN');
    const order = (await client.query('SELECT id, status, shopper_id FROM orders WHERE id = $1 FOR UPDATE', [attempt.order_id])).rows[0];
    const locked = (await client.query('SELECT * FROM grocery_payment_attempts WHERE id = $1 FOR UPDATE', [attempt.id])).rows[0];
    if (!['pending', 'unknown'].includes(locked.status)) throw error(409, 'This payment is already settled', 'WRONG_STATUS');
    const entry = { orderId: locked.order_id, shopId: locked.shop_id, shopperId: locked.shopper_id, reservationId: locked.reservation_id, attemptId: locked.id, actorType: 'admin', actorId: adminId };

    if (outcome === 'failed') {
      await client.query("UPDATE grocery_payment_attempts SET status = 'failed', failure_reason = $2, reconciled_by = $3, reconciled_at = NOW(), updated_at = NOW() WHERE id = $1", [locked.id, `Closed by GetMe: ${note}`.slice(0, 300), adminId]);
      await addEntry(client, { ...entry, type: 'attempt_failed', amount: locked.requested_amount, note: `Closed as not paid: ${note}` });
    } else {
      await client.query('UPDATE grocery_payment_attempts SET statement_reference = $2, reconciled_by = $3, reconciled_at = NOW() WHERE id = $1', [locked.id, statementReference, adminId]);
      const paid = await recordProviderPaid(client, { order, attempt: locked, providerRef: locked.provider_ref, verification: 'statement', actorType: 'admin', actorId: adminId });
      paidRow = paid.row;
      await addEntry(client, { ...entry, type: 'reconcile', amount: locked.requested_amount, note: `Confirmed with the bank statement ${statementReference}: ${note}` });
    }
    await client.query('COMMIT');
  } catch (caught) {
    await client.query('ROLLBACK').catch(() => {});
    throw caught;
  } finally {
    client.release();
  }

  if (paidRow) await grocery.finishAfterCommit(Number(attempt.order_id), paidRow, null);
  return { message: outcome === 'failed' ? 'Closed as not paid' : 'Recorded as paid (bank statement)' };
};

// ---------------------------------------------------
// Minute clock: settle open provider payments
// ---------------------------------------------------

const checkOpenAttempts = async () => {
  const rows = (
    await pool.query(
      `SELECT * FROM grocery_payment_attempts
       WHERE method = ANY($1) AND provider IS NOT NULL AND status IN ('pending', 'unknown')
         AND (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '30 seconds')
         -- the app's own status poll gets the first 20 seconds
         AND (initiated_at IS NULL OR initiated_at < NOW() - INTERVAL '20 seconds')
       ORDER BY updated_at LIMIT 25`,
      [[METHOD, BANK_METHOD]]
    )
  ).rows;
  const state = providers.current();

  for (const row of rows) {
    try {
      if (!row.initiated_at) {
        if (Date.now() - new Date(row.created_at).getTime() > STALE_UNSENT_MS) await closeUnsent(row.id);
        continue;
      }
      if (state.usable && state.key === row.provider) {
        if (!(await expireIfOverdue(row))) await queryOnce(row);
      } else if (Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000) {
        // Can't be checked automatically: someone must ask the bank
        await notifications().notify({
          category: 'payments',
          event: 'grocery_payment.unresolved',
          severity: 'critical',
          title: `${row.provider === 'simulator' ? 'TEST SIMULATOR: ' : ''}LankaQR payment can't be checked (order #${row.order_id})`,
          body: `Rs ${round2(row.requested_amount).toFixed(2)} · the provider is not available to confirm it. Check with the bank and close it in Supermarket payments.`,
          entityType: 'order',
          entityId: row.order_id,
          permissions: ['grocery.manage'],
          dedupe: `lankaqr.unresolved:${row.id}`,
        });
      }
    } catch (caught) {
      console.error('❌ LANKAQR STATUS CHECK:', row.id, caught.message);
    }
  }
};

try {
  const notify = notifications();
  if (typeof notify.addClockCheck === 'function') notify.addClockCheck('lankaqr payments', checkOpenAttempts);
} catch (caught) {
  console.error('❌ LANKAQR CLOCK:', caught.message);
}

module.exports = {
  // phase 54: the shopper-funded LankaQR method checks the till QR too
  merchantCheck,
  refuseMerchant,
  METHOD,
  BANK_METHOD,
  PAYER_MAX_AMOUNT,
  cancel,
  PAYMENT_SOURCE,
  SIM_NOTICE,
  requireFunding,
  publicProvider,
  preview,
  pay,
  status,
  submitMerchant,
  listMerchants,
  reviewMerchant,
  createMerchant,
  adminStatus,
  adminProviderAction,
  checkOpenAttempts,
  // tests
  initiateOnce,
  applyOutcome,
};
