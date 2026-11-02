-- =====================================================
-- PHASE 62: FASHION REELS (TikTok-style shoppable videos, clothing shops)
-- Additive only. Video / cover FILES live on disk in
-- private-uploads/reels/ (served through signed links); this schema keeps
-- references and metadata only.
--   fashion_reels      one video per row: metadata, status, counters
--   reel_products      products linked to a reel (same shop)
--   reel_likes         one like per customer
--   reel_views         one counted view per viewer per reel per day
--   reel_events        share / product_click / add_to_cart events
--   reel_reports       customer reports (moderation)
--   shop_follows       customers following shops
--   shops.reels_*      publishing privilege suspension
--   order_items.source_reel_id   order attribution (validated at checkout)
-- =====================================================

CREATE TABLE IF NOT EXISTS fashion_reels (
  id SERIAL PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  title VARCHAR(100) NOT NULL DEFAULT '',
  caption VARCHAR(1000),
  hashtags TEXT[] NOT NULL DEFAULT '{}',
  promo_type VARCHAR(20) NOT NULL DEFAULT 'new_arrival'
    CHECK (promo_type IN ('new_arrival', 'collection', 'trending', 'seasonal', 'offer', 'demo', 'outfit', 'other')),
  audience VARCHAR(10) CHECK (audience IS NULL OR audience IN ('men', 'women', 'kids', 'unisex')),

  video_file VARCHAR(200),
  video_mime VARCHAR(40),
  video_bytes BIGINT,
  video_codec VARCHAR(10),
  duration_seconds NUMERIC(7, 2),
  width INTEGER,
  height INTEGER,
  cover_file VARCHAR(200),
  cover_mime VARCHAR(40),

  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_review', 'published', 'rejected', 'removed')),
  review_note VARCHAR(500),
  reviewed_by INTEGER,
  reviewed_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  removed_reason VARCHAR(500),
  -- hidden from the feed while reports are reviewed
  hidden_by_reports BOOLEAN NOT NULL DEFAULT FALSE,

  view_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  share_count INTEGER NOT NULL DEFAULT 0,
  product_click_count INTEGER NOT NULL DEFAULT 0,
  add_to_cart_count INTEGER NOT NULL DEFAULT 0,

  created_by_staff_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reels_shop ON fashion_reels (shop_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reels_feed ON fashion_reels (published_at DESC, id DESC)
  WHERE status = 'published' AND deleted_at IS NULL AND NOT hidden_by_reports;
CREATE INDEX IF NOT EXISTS idx_reels_review ON fashion_reels (status, submitted_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS reel_products (
  reel_id INTEGER NOT NULL REFERENCES fashion_reels(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (reel_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_reel_products_product ON reel_products (product_id);

CREATE TABLE IF NOT EXISTS reel_likes (
  reel_id INTEGER NOT NULL REFERENCES fashion_reels(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (reel_id, customer_id)
);

-- View rule: watched >= 2 s (or >= half of a shorter video); counted
-- once per viewer per reel per Colombo calendar day
CREATE TABLE IF NOT EXISTS reel_views (
  reel_id INTEGER NOT NULL REFERENCES fashion_reels(id) ON DELETE CASCADE,
  viewer_key VARCHAR(80) NOT NULL,
  view_day DATE NOT NULL,
  watched_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (reel_id, viewer_key, view_day)
);
CREATE INDEX IF NOT EXISTS idx_reel_views_day ON reel_views (reel_id, view_day);

CREATE TABLE IF NOT EXISTS reel_events (
  id BIGSERIAL PRIMARY KEY,
  reel_id INTEGER NOT NULL REFERENCES fashion_reels(id) ON DELETE CASCADE,
  customer_id INTEGER,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN ('share', 'product_click', 'add_to_cart')),
  product_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reel_events ON reel_events (reel_id, event_type, created_at);

CREATE TABLE IF NOT EXISTS reel_reports (
  id SERIAL PRIMARY KEY,
  reel_id INTEGER NOT NULL REFERENCES fashion_reels(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL,
  reason VARCHAR(20) NOT NULL CHECK (reason IN ('inappropriate', 'misleading', 'counterfeit', 'offensive', 'spam', 'other')),
  details VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  resolved_by INTEGER,
  resolved_at TIMESTAMPTZ,
  resolution_note VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reel_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_reel_reports_open ON reel_reports (status, created_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS shop_follows (
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shop_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_shop_follows_customer ON shop_follows (customer_id, created_at DESC);

ALTER TABLE shops ADD COLUMN IF NOT EXISTS reels_suspended_at TIMESTAMPTZ;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS reels_suspended_reason VARCHAR(500);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS source_reel_id INTEGER REFERENCES fashion_reels(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_order_items_reel ON order_items (source_reel_id) WHERE source_reel_id IS NOT NULL;

-- Whether an event counted towards the shop's numbers (repeat taps by the
-- same customer within 10 minutes are stored but not counted)
ALTER TABLE reel_events ADD COLUMN IF NOT EXISTS counted BOOLEAN NOT NULL DEFAULT TRUE;

-- Phase 62b: admin deletion (files removed from disk; the record stays for audit)
ALTER TABLE fashion_reels ADD COLUMN IF NOT EXISTS deleted_by_admin_id INTEGER;
ALTER TABLE fashion_reels ADD COLUMN IF NOT EXISTS deleted_reason VARCHAR(500);
