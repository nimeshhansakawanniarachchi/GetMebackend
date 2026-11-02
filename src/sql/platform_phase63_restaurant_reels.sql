-- =====================================================
-- PHASE 63: RESTAURANT REELS on the existing reels system (phase 62)
-- Additive only. The same tables, storage, moderation, analytics and
-- checkout attribution serve clothing shops and restaurants; a reel now
-- records its business type.
--   fashion_reels.business_type   clothing | restaurant (existing rows -> clothing)
--   promo_type                    + food categories (new_dish, popular_meal, ...)
--   reel_events                   + profile_visit
-- =====================================================

ALTER TABLE fashion_reels ADD COLUMN IF NOT EXISTS business_type VARCHAR(20);
UPDATE fashion_reels r SET business_type = s.business_type
  FROM shops s WHERE s.id = r.shop_id AND r.business_type IS NULL;
UPDATE fashion_reels SET business_type = 'clothing' WHERE business_type IS NULL;
ALTER TABLE fashion_reels ALTER COLUMN business_type SET DEFAULT 'clothing';
ALTER TABLE fashion_reels ALTER COLUMN business_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fashion_reels_business_type_valid') THEN
    ALTER TABLE fashion_reels ADD CONSTRAINT fashion_reels_business_type_valid
      CHECK (business_type IN ('clothing', 'restaurant'));
  END IF;
END $$;

-- Promotion types: clothing (phase 62) + food
ALTER TABLE fashion_reels DROP CONSTRAINT IF EXISTS fashion_reels_promo_type_check;
ALTER TABLE fashion_reels ADD CONSTRAINT fashion_reels_promo_type_check CHECK (promo_type IN (
  'new_arrival', 'collection', 'trending', 'seasonal', 'offer', 'demo', 'outfit', 'other',
  'new_dish', 'popular_meal', 'fast_food', 'pizza', 'rice_curry', 'dessert', 'beverage',
  'special_menu', 'preparation', 'chef_special'
));

ALTER TABLE reel_events DROP CONSTRAINT IF EXISTS reel_events_event_type_check;
ALTER TABLE reel_events ADD CONSTRAINT reel_events_event_type_check
  CHECK (event_type IN ('share', 'product_click', 'add_to_cart', 'profile_visit'));

ALTER TABLE fashion_reels ADD COLUMN IF NOT EXISTS profile_visit_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_reels_type_feed ON fashion_reels (business_type, published_at DESC, id DESC)
  WHERE status = 'published' AND deleted_at IS NULL AND NOT hidden_by_reports;
