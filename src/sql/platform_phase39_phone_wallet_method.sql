-- =====================================================
-- PLATFORM PHASE 39 - phone tap-to-pay as its own method (2026-10-28)
-- Run once: node src/sql/runSql.js src/sql/platform_phase39_phone_wallet_method.sql
--
-- Splits "own card or Google Wallet" into:
--   card          the shopper's own bank card at the till (tap / insert)
--   phone_wallet  the shopper's own card in Google Wallet on an NFC
--                 Android phone. Google Wallet in Sri Lanka: ComBank,
--                 Sampath, Seylan cards and HNB Visa debit (Google's
--                 issuer list, checked 2026-10-28); Apple Pay and
--                 Samsung Pay are not available for Sri Lankan cards,
--                 so it is not offered on iPhone.
-- Both are the shopper's own money, reimbursed after delivery. GetMe
-- does not charge or provision anything into a wallet.
-- =====================================================

INSERT INTO grocery_payment_methods (key, label, funding, integration, enabled, icon, instructions, requirement, sort_order) VALUES
  ('phone_wallet', 'Tap with your phone (Google Wallet)', 'shopper', 'manual', TRUE, 'phone-portrait-outline',
   'Unlock your Android phone and hold it near the card terminal. Your own card must already be in Google Wallet (ComBank, Sampath, Seylan, or HNB Visa debit). The terminal may ask for your card PIN on bigger bills. GetMe pays you back after delivery.',
   NULL, 25)
ON CONFLICT (key) DO NOTHING;

UPDATE grocery_payment_methods SET
  label = 'Your own bank card',
  instructions = 'Tap, insert or swipe your own debit or credit card at the till and enter your PIN if asked. Keep the card slip with the bill. GetMe pays you back after delivery.'
WHERE key = 'card';

ALTER TABLE store_payments DROP CONSTRAINT IF EXISTS store_payments_method_check;
ALTER TABLE store_payments ADD CONSTRAINT store_payments_method_check
  CHECK (method IN ('cash', 'card', 'phone_wallet', 'lankaqr', 'getme_card'));
