-- =====================================================
-- PHASE 61: one marketplace, category-specific experiences
-- Additive only. Existing rows keep their meaning.
--   * business_types: customer-ordering gate, minimum age, compliance note
--   * liquor business type: shops can register (excise licence document),
--     but CUSTOMER ORDERING STAYS OFF until an admin records legal approval
--   * orders: liquor allowed in the type check, age confirmation snapshot
--   * shop_categories: a store's own menu sections / collections
--     (display order, description; restaurants can rename)
--   * indexes for the home feed (popular items / stores, buy again)
-- =====================================================

ALTER TABLE business_types ADD COLUMN IF NOT EXISTS customer_ordering_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE business_types ADD COLUMN IF NOT EXISTS min_customer_age INTEGER;
ALTER TABLE business_types ADD COLUMN IF NOT EXISTS compliance_note VARCHAR(600);
ALTER TABLE business_types ADD COLUMN IF NOT EXISTS ordering_changed_at TIMESTAMPTZ;
ALTER TABLE business_types ADD COLUMN IF NOT EXISTS ordering_changed_by INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_types_min_age_valid') THEN
    ALTER TABLE business_types ADD CONSTRAINT business_types_min_age_valid
      CHECK (min_customer_age IS NULL OR min_customer_age BETWEEN 16 AND 30);
  END IF;
END $$;

-- Liquor: registration open (licence documents, admin review),
-- customer ordering OFF. In Sri Lanka the sale of liquor needs an
-- Excise Department licence, and online sale / delivery has no clear
-- legal basis (2021 proposal for online permits was withdrawn). The
-- NATA Act bars sales to people under 21.
INSERT INTO business_types (key, label, description, commission_percent, return_window_days, is_active, sort,
                            customer_ordering_enabled, min_customer_age, compliance_note)
VALUES (
  'liquor', 'Liquor store',
  'Licensed liquor stores (wine stores). Customer ordering stays off until GetMe confirms it is legally allowed.',
  10, 0, TRUE, 4, FALSE, 21,
  'Customer ordering is off. Sale of liquor needs an Excise Department licence for the premises, and online sale or delivery needs legal confirmation before it is switched on. Sales to people under 21 are prohibited (NATA Act).'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO business_document_types (business_type, doc_key, label, description, required, sort)
VALUES
  ('liquor', 'business_registration', 'Business registration certificate', 'Registrar of Companies / Divisional Secretariat business registration', TRUE, 1),
  ('liquor', 'owner_identity', 'Owner NIC or passport', 'Front and back of the owner''s NIC, or passport photo page', TRUE, 2),
  ('liquor', 'excise_licence', 'Excise liquor licence', 'Valid Excise Department licence for retail sale of liquor at these premises (for example FL 4), for this year', TRUE, 3),
  ('liquor', 'trade_licence', 'Trade licence', 'Trade licence from the local authority (Municipal / Urban / Pradeshiya Sabha)', TRUE, 4)
ON CONFLICT (business_type, doc_key) DO NOTHING;

DO $$
DECLARE
  v_row RECORD;
  v_parent INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM marketplace_categories WHERE business_type = 'liquor') THEN
    FOR v_row IN
      SELECT * FROM (VALUES
        ('Beer', ARRAY['Lager', 'Strong beer', 'Imported']::text[], 1),
        ('Wine', ARRAY['Red', 'White', 'Rosé', 'Sparkling']::text[], 2),
        ('Arrack', ARRAY[]::text[], 3),
        ('Spirits', ARRAY['Whisky', 'Brandy', 'Gin', 'Vodka', 'Rum']::text[], 4),
        ('Mixers & soft drinks', ARRAY[]::text[], 5)
      ) AS t(name, subs, ord)
    LOOP
      INSERT INTO marketplace_categories (business_type, name, sort)
      VALUES ('liquor', v_row.name, v_row.ord)
      RETURNING id INTO v_parent;

      INSERT INTO marketplace_categories (business_type, parent_id, name, sort)
      SELECT 'liquor', v_parent, s, ord::int
      FROM unnest(v_row.subs) WITH ORDINALITY AS u(s, ord);
    END LOOP;
  END IF;
END $$;

-- Orders: liquor is a valid order type
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_business_type_valid;
ALTER TABLE orders ADD CONSTRAINT orders_business_type_valid
  CHECK (business_type IN ('grocery', 'clothing', 'restaurant', 'liquor'));

-- Age-restricted orders: the customer's confirmation and the age the
-- rider / store must check at hand-over (snapshot at order time)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS min_customer_age INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS age_confirmed_at TIMESTAMPTZ;

-- A store's own menu sections (restaurants) / collections (shops):
-- display order, description. Product rows keep products.category.
CREATE TABLE IF NOT EXISTS shop_categories (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name VARCHAR(60) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 10000),
  description VARCHAR(200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_categories_shop_name_uniq ON shop_categories (shop_id, lower(name));

-- Home feed
CREATE INDEX IF NOT EXISTS idx_orders_merchant_delivered
  ON orders (business_type, delivered_at) WHERE business_type <> 'grocery' AND status = 'delivered';
CREATE INDEX IF NOT EXISTS idx_orders_customer_delivered
  ON orders (customer_id, delivered_at DESC) WHERE status = 'delivered';
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_products_featured ON products (shop_id) WHERE is_featured AND is_available;

-- (an earlier draft of this file added shop_categories.is_visible; sections
--  are switched off through product availability instead)
ALTER TABLE shop_categories DROP COLUMN IF EXISTS is_visible;
