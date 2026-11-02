const { createBankAdapter } = require('./bankAdapter');

// =====================================================
// BANKS GETME MAY CONNECT FOR COMPANY LANKAQR PAYMENTS (phase 55)
//
// None of these banks has published an API that pays a LankaQR
// merchant from a corporate account (research 2026-10-31:
// code-backups/reports/payment-providers-research-2026-10-31.md).
// Corporate APIs exist only through a relationship manager (DFCC
// iConnect API / host-to-host, ComBank host-to-host files, Sampath's
// API platform, BOC CFlex) and none documents QR payments or webhooks.
// So every entry has implementation: null and refuses all calls.
//
// To connect a bank once it issues API documentation + sandbox keys:
//   1. write providers/<bank>Implementation.js (see bankAdapter.js for
//      the functions it supplies) from the bank's documentation only
//   2. set `implementation: require('./<bank>Implementation')` and the
//      capabilities it really supports below
//   3. set <PREFIX>_ENV=sandbox and the bank's sandbox URL / keys in the
//      server .env, run the sandbox tests, then the Super Admin links a
//      company account (phase 50) and switches getme_lankaqr on
// GROCERY_QR_PROVIDER=<key> selects the bank; GROCERY_QR_LIVE=true is
// still required for real payments.
// =====================================================

const WAITING = (bank) =>
  `${bank} has not given GetMe a LankaQR payment API (payer scan-to-pay from shoppers' own accounts, or company payments). Draft requests: code-backups/reports/lankaqr-partner-emails-2026-10-31.md.`;

// Phase 56: Seylan Bank and Cargills Bank publicly act as acquiring
// banks for non-bank payment apps (HelaPay, DirectPay / six fintech
// apps): the first ones to ask for payer-side scan-to-pay. HNB and
// Dialog Pay publish merchant (collection) APIs only.
const BANKS = {
  seylan: { label: 'Seylan Bank', envPrefix: 'SEYLAN_LANKAQR', bankKeys: ['seylan_bank'] },
  cargills: { label: 'Cargills Bank', envPrefix: 'CARGILLS_LANKAQR', bankKeys: ['cargills_bank'] },
  combank: { label: 'Commercial Bank of Ceylon', envPrefix: 'COMBANK_LANKAQR', bankKeys: ['commercial_bank_of_ceylon'] },
  sampath: { label: 'Sampath Bank', envPrefix: 'SAMPATH_LANKAQR', bankKeys: ['sampath_bank'] },
  hnb: { label: 'Hatton National Bank', envPrefix: 'HNB_LANKAQR', bankKeys: ['hatton_national_bank'] },
  dfcc: { label: 'DFCC Bank', envPrefix: 'DFCC_LANKAQR', bankKeys: ['dfcc_bank'] },
  boc: { label: 'Bank of Ceylon', envPrefix: 'BOC_LANKAQR', bankKeys: ['bank_of_ceylon'] },
};

Object.entries(BANKS).forEach(([key, bank]) => {
  bank.key = key;
  bank.implementation = null;
  bank.capabilities = { lankaqrMerchantPayment: false, companyFunded: false, payerFunded: false, payerAuth: false, statusQuery: false, signedCallbacks: false, cancel: false, reversal: false };
  bank.waitingFor = WAITING(bank.label);
});

const create = (key) => {
  const bank = BANKS[key];
  return bank ? createBankAdapter(bank) : null;
};

module.exports = { BANKS, create, WAITING };
