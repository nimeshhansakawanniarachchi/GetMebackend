// =====================================================
// DFCC LANKAQR PROVIDER - NOT CONNECTED (phase 49, phase 55)
//
// DFCC has NOT provided any API that pays a LANKAQR merchant from a
// corporate account (DFCC iConnect offers "API / Host-to-Host" corporate
// payments through a relationship manager, but no published QR payment
// or callback API). Since phase 55 DFCC is one entry of the bank adapter
// list (providers/banks.js) built by providers/bankAdapter.js: the
// bank-independent parts (configuration, sandbox / production, reference
// checks, timeouts -> unknown, signed callbacks) are shared, and only
// the DFCC request formats are missing. It refuses every call.
//
// What DFCC / LankaPay must answer first, and where each answer plugs
// in, is listed in code-backups/reports/dfcc-lankaqr-questions.md.
// =====================================================

const banks = require('./banks');

const REASON = banks.BANKS.dfcc.waitingFor;

const create = () => banks.create('dfcc');

module.exports = { create, REASON };
