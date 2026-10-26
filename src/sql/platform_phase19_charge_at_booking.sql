-- =====================================================
-- PLATFORM PHASE 19 — card charged at booking, not at Place order
-- Run once: node src/sql/runSql.js src/sql/platform_phase19_charge_at_booking.sql
--
-- Place order only remembers which saved card will pay. The card is
-- charged when the customer books a vehicle (start-search) and
-- approves the amount (paymentService.bookingChargeFor).
-- =====================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_card_id INTEGER;
