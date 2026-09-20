-- Known-success receipts let a retry skip only the exact logical message Telegram accepted.
-- The ledger stores no rendered text, profile identifiers, media grants, or credentials.
CREATE TABLE channel_telegram.liked_by_delivery_receipts (
  delivery_id uuid NOT NULL
    REFERENCES channel_telegram.liked_by_delivery_requests(id) ON DELETE CASCADE,
  message_key text NOT NULL
    CHECK (message_key ~ '^(card|screen):[A-Za-z0-9._-]{1,80}$'),
  provider_message_id bigint NOT NULL CHECK (provider_message_id > 0),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (delivery_id, message_key),
  UNIQUE (delivery_id, provider_message_id)
);
