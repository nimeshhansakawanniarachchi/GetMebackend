// =====================================================
// PAYMENT PROVIDERS (phase 54, 2026-10-30)
// One place that says what each provider can really do for GetMe's
// supermarket and fuel payments. Capabilities are only true when an
// official, working integration exists on this server. Nothing here
// calls a provider; it is what Admin -> Payment providers shows, and what
// a new provider adapter must change when it is built.
// =====================================================

const groceryProviders = require('../groceryPayments/providers');
const banks = require('../groceryPayments/providers/banks');
const payhere = require('./payhere');

const NO = false;

const catalogue = () => {
  // Phase 55 (P-15): usable state, not just "configured"
  const active = groceryProviders.current();
  const cardMode = payhere.getMode();
  return [
    // Phase 55: customer card payments (GetMe receives money)
    {
      key: 'payhere_cards',
      label: 'PayHere saved cards (customers paying GetMe)',
      categories: ['customer_payments'],
      status: cardMode === 'live' ? (payhere.configProblem() ? 'not_configured' : 'live') : cardMode === 'sandbox' ? 'sandbox' : cardMode === 'test' ? 'test_only' : 'not_configured',
      capabilities: { scanAndCheckQr: NO, dynamicQrGeneration: NO, initiatePayment: cardMode !== null, verifyWithProvider: cardMode === 'live' || cardMode === 'sandbox', webhooks: cardMode === 'live' || cardMode === 'sandbox', refunds: cardMode !== null },
      reason:
        cardMode === 'test'
          ? 'Test mode: a fake gateway on this server, no PayHere and no money. Sandbox needs PAYHERE_MODE=sandbox with PayHere sandbox keys (Automated Charging is on the PayHere PREMIUM plan).'
          : payhere.configProblem(),
    },
    {
      key: 'helapos_receive',
      label: "HelaPOS (GetMe's own LankaQR) - money paid INTO GetMe",
      categories: ['customer_payments', 'cash_handover'],
      status: 'manual_verification',
      capabilities: { scanAndCheckQr: NO, dynamicQrGeneration: NO, initiatePayment: NO, verifyWithProvider: NO, webhooks: NO, refunds: NO },
      reason:
        'HelaPOS has no API, webhook or export. Finance confirms each payment in the HelaPOS app and records its reference, amount and time in Admin -> Payments -> HelaPOS received (a second admin verifies).',
    },
    ...Object.values(banks.BANKS).map((bank) => {
      const info = groceryProviders.describeKey(bank.key);
      return {
        key: `bank_${bank.key}`,
        label: `${bank.label} - company LankaQR payments`,
        categories: ['supermarket'],
        status: info.configured ? 'configured' : 'waiting_for_provider',
        capabilities: {
          scanAndCheckQr: true,
          dynamicQrGeneration: NO,
          initiatePayment: Boolean(info.capabilities?.lankaqrMerchantPayment),
          verifyWithProvider: Boolean(info.capabilities?.statusQuery),
          webhooks: Boolean(info.capabilities?.signedCallbacks),
          refunds: Boolean(info.capabilities?.reversal),
          payerFunded: Boolean(info.capabilities?.payerFunded),
          companyFunded: Boolean(info.capabilities?.companyFunded),
        },
        reason: info.reason || null,
      };
    }),
    {
      key: 'record_verify',
      label: 'Record and verify (shopper pays with their own app)',
      categories: ['supermarket', 'fuel'],
      status: 'active',
      capabilities: { scanAndCheckQr: true, dynamicQrGeneration: NO, initiatePayment: NO, verifyWithProvider: NO, webhooks: NO, refunds: NO },
      howItWorks:
        'The shopper scans the till / pump LankaQR in GetMe (merchant and amount are checked), pays with their own wallet or bank app (e.g. HelaPay in Helakuru), then reports the reference and receipt. GetMe staff reconcile; nothing is marked paid by the app.',
    },
    {
      key: 'helapay',
      label: 'HelaPay / HelaPOS (Bhasha)',
      categories: ['supermarket', 'fuel'],
      status: 'not_available',
      capabilities: { scanAndCheckQr: NO, dynamicQrGeneration: NO, initiatePayment: NO, verifyWithProvider: NO, webhooks: NO, refunds: NO },
      reason:
        "HelaPOS is a merchant app for RECEIVING LankaQR payments (the merchant shows a QR; the payer scans). It cannot pay a supermarket or fuel station, and Bhasha publishes no HelaPOS / HelaPay API. HelaPay reaches developers only through PayHere's checkout (payment_method=HELAPAY), which is for customers paying GetMe.",
      questionsForProvider: [
        'Is there a business payer API that can pay a third-party LankaQR merchant (supermarket / fuel station) from a GetMe account? Under which bank acquirer and LankaPay certification?',
        'Is there an API for HelaPOS: create a dynamic QR for an amount, read its status, and get a signed callback (webhook) when it is paid?',
        'Sandbox access, API credentials, callback signature method (HMAC / certificate) and IP ranges.',
        'Refunds and reversals: API, time limits, fees.',
        'Settlement reports: format and timing (for reconciliation).',
        'Transaction limits and fees for business accounts; CBSL rules that apply (app user = account owner).',
      ],
    },
    {
      key: 'payhere_helapay',
      label: 'PayHere (HELAPAY method) - customers paying GetMe',
      categories: ['customer_payments'],
      status: 'not_for_this_flow',
      capabilities: { scanAndCheckQr: NO, dynamicQrGeneration: NO, initiatePayment: NO, verifyWithProvider: NO, webhooks: NO, refunds: NO },
      reason: 'PayHere checkout can take HelaPay from customers paying GetMe for an order. It does not pay supermarkets or fuel stations.',
    },
    {
      key: active.key,
      label: `Company LankaQR provider (${active.label})`,
      categories: ['supermarket'],
      status: active.configured ? (active.simulator ? 'test_only' : active.live ? 'live' : 'configured') : 'not_configured',
      capabilities: {
        scanAndCheckQr: true,
        dynamicQrGeneration: NO,
        initiatePayment: Boolean(active.usable),
        verifyWithProvider: Boolean(active.usable),
        webhooks: NO,
        refunds: NO,
      },
      reason: active.reason || null,
      simulator: Boolean(active.simulator),
    },
  ];
};

module.exports = { catalogue };
