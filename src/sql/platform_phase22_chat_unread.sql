-- =====================================================
-- PLATFORM PHASE 22 — chat unread counts + push tokens
-- Run once: node src/sql/runSql.js src/sql/platform_phase22_chat_unread.sql
--
-- chat_reads: how far each side of an order's chat has read
-- (last chat_messages.id seen). Unread = messages from the other
-- person (not system timeline lines) after that id.
-- push_tokens: Expo push tokens per app user, for notifications
-- while the app is in the background (builds that support push).
-- =====================================================

CREATE TABLE IF NOT EXISTS chat_reads (
  order_id INTEGER NOT NULL REFERENCES orders (id),
  reader_type VARCHAR(20) NOT NULL CHECK (reader_type IN ('customer', 'shopper')),
  reader_id INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, reader_type, reader_id)
);

CREATE INDEX IF NOT EXISTS chat_messages_order_sender_idx
  ON chat_messages (order_id, sender_type, id);

CREATE TABLE IF NOT EXISTS push_tokens (
  token VARCHAR(255) PRIMARY KEY,
  owner_type VARCHAR(20) NOT NULL CHECK (owner_type IN ('customer', 'shopper')),
  owner_id INTEGER NOT NULL,
  platform VARCHAR(20),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS push_tokens_owner_idx ON push_tokens (owner_type, owner_id);
