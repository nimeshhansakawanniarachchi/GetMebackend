-- ==================================================
-- PLATFORM PHASE 3 — server-side pricing
-- Run once: node src/sql/runSql.js src/sql/platform_phase3.sql
-- Then:     node src/scripts/backfillProductUnits.js
--           node src/scripts/normalizePhones.js
-- ==================================================

-- Admin-editable platform settings (fees, slots ...)
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL
);

INSERT INTO platform_settings (key, value)
VALUES (
  'pricing',
  '{
    "delivery": {
      "baseFee": 100,
      "baseKm": 2,
      "tiers": [
        { "uptoKm": 5, "perKm": 30 },
        { "uptoKm": 10, "perKm": 35 },
        { "uptoKm": null, "perKm": 40 }
      ],
      "extraShopFee": 50,
      "maxKm": 10
    },
    "fastFee": 100,
    "serviceFee": { "percent": 5, "min": 50, "max": 400 },
    "slots": { "days": 4, "startHour": 8, "endHour": 20, "slotHours": 2, "leadMinutes": 60 }
  }'::jsonb
)
ON CONFLICT (key) DO NOTHING;

-- How a product is priced: per item, per kg or per litre
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS unit VARCHAR(10) NOT NULL DEFAULT 'item';

-- What the customer actually bought, as priced by the server
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS pack_amount NUMERIC(12, 3);
