-- Only stable routing metadata is persisted. Profile cards and signed media grants are minted
-- after a worker claims the request; neither is durable channel payload.
CREATE SCHEMA IF NOT EXISTS channel_telegram;

CREATE TABLE channel_telegram.liked_by_delivery_requests (
  id uuid PRIMARY KEY,
  bot_id text NOT NULL CHECK (bot_id ~ '^[1-9][0-9]{0,19}$'),
  update_id bigint NOT NULL CHECK (update_id >= 0),
  viewer_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  telegram_user_id text NOT NULL CHECK (telegram_user_id ~ '^[1-9][0-9]{0,19}$'),
  request_id uuid NOT NULL,
  cursor text CHECK (cursor ~ '^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$'),
  callback_query_id text CHECK (char_length(callback_query_id) BETWEEN 1 AND 128),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT liked_by_delivery_callback_pair_ck CHECK (
    (cursor IS NULL AND callback_query_id IS NULL)
    OR (cursor IS NOT NULL AND callback_query_id IS NOT NULL)
  ),
  CONSTRAINT liked_by_delivery_lease_shape_ck CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT liked_by_delivery_state_shape_ck CHECK (
    (state = 'delivered' AND delivered_at IS NOT NULL)
    OR (state <> 'delivered' AND delivered_at IS NULL)
  ),
  UNIQUE (bot_id, update_id)
);

CREATE INDEX liked_by_delivery_due_idx
  ON channel_telegram.liked_by_delivery_requests (available_at, id)
  WHERE state = 'pending';

CREATE INDEX liked_by_delivery_viewer_idx
  ON channel_telegram.liked_by_delivery_requests (viewer_user_id, created_at DESC, id);
