CREATE TABLE billing.payment_provider_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider = 'telegram_stars'),
  provider_event_id text NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 256),
  event_type text NOT NULL CHECK (event_type IN ('pre_checkout','successful_payment')),
  payment_record_id uuid REFERENCES billing.payment_records(id) ON DELETE RESTRICT,
  payer_user_id uuid REFERENCES identity.users(id) ON DELETE RESTRICT,
  fact_hash text NOT NULL CHECK (char_length(fact_hash) = 64),
  raw_payload_digest text NOT NULL CHECK (char_length(raw_payload_digest) = 64),
  raw_payload_ciphertext bytea NOT NULL CHECK (octet_length(raw_payload_ciphertext) BETWEEN 32 AND 65536),
  raw_payload_key_id text NOT NULL CHECK (raw_payload_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  raw_payload_schema_version integer NOT NULL CHECK (raw_payload_schema_version >= 1),
  decision text NOT NULL CHECK (decision IN ('allow','deny','receipt_recorded','quarantined')),
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX payment_provider_events_payment_idx
  ON billing.payment_provider_events (payment_record_id, received_at, id)
  WHERE payment_record_id IS NOT NULL;

CREATE TABLE billing.payment_provider_conflicts (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider = 'telegram_stars'),
  provider_event_id text NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 256),
  payment_record_id uuid REFERENCES billing.payment_records(id) ON DELETE RESTRICT,
  existing_fact_hash text CHECK (existing_fact_hash IS NULL OR char_length(existing_fact_hash) = 64),
  incoming_fact_hash text NOT NULL CHECK (char_length(incoming_fact_hash) = 64),
  reason_code text NOT NULL CHECK (reason_code IN ('event_fact_conflict','payment_fact_mismatch','charge_conflict')),
  raw_payload_digest text NOT NULL CHECK (char_length(raw_payload_digest) = 64),
  raw_payload_ciphertext bytea NOT NULL CHECK (octet_length(raw_payload_ciphertext) BETWEEN 32 AND 65536),
  raw_payload_key_id text NOT NULL CHECK (raw_payload_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  raw_payload_schema_version integer NOT NULL CHECK (raw_payload_schema_version >= 1),
  detected_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (provider, provider_event_id, incoming_fact_hash, reason_code)
);

CREATE INDEX payment_provider_conflicts_time_idx
  ON billing.payment_provider_conflicts (detected_at DESC, id DESC);

CREATE TABLE billing.telegram_stars_receipts (
  payment_record_id uuid PRIMARY KEY REFERENCES billing.payment_records(id) ON DELETE RESTRICT,
  provider_event_id text NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 256),
  telegram_charge_id text NOT NULL UNIQUE CHECK (char_length(telegram_charge_id) BETWEEN 1 AND 256),
  provider_charge_id text UNIQUE CHECK (provider_charge_id IS NULL OR char_length(provider_charge_id) BETWEEN 1 AND 256),
  payer_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  stars_amount bigint NOT NULL CHECK (stars_amount > 0),
  received_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE billing.payment_fulfillments (
  payment_record_id uuid PRIMARY KEY REFERENCES billing.payment_records(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'receipt_recorded'
    CHECK (state IN ('receipt_recorded','fulfillment_pending','fulfilled','correction_required','corrected')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  lease_owner text CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  fulfilled_at timestamptz,
  correction_required_at timestamptz,
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT payment_fulfillment_lease_ck CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND state = 'fulfillment_pending')
  ),
  CONSTRAINT payment_fulfillment_state_ck CHECK (
    (state IN ('receipt_recorded','fulfillment_pending') AND fulfilled_at IS NULL
      AND correction_required_at IS NULL AND corrected_at IS NULL)
    OR (state = 'fulfilled' AND fulfilled_at IS NOT NULL
      AND correction_required_at IS NULL AND corrected_at IS NULL AND lease_owner IS NULL)
    OR (state = 'correction_required' AND fulfilled_at IS NULL
      AND correction_required_at IS NOT NULL AND corrected_at IS NULL AND lease_owner IS NULL)
    OR (state = 'corrected' AND fulfilled_at IS NULL
      AND correction_required_at IS NOT NULL AND corrected_at IS NOT NULL AND lease_owner IS NULL)
  )
);

CREATE INDEX payment_fulfillments_due_idx
  ON billing.payment_fulfillments (available_at, payment_record_id)
  WHERE state IN ('receipt_recorded','fulfillment_pending');

CREATE FUNCTION billing.reject_immutable_provider_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider evidence is append-only' USING ERRCODE = '23514';
END $$;

CREATE TRIGGER payment_provider_events_immutable
BEFORE UPDATE OR DELETE ON billing.payment_provider_events
FOR EACH ROW EXECUTE FUNCTION billing.reject_immutable_provider_evidence();
CREATE TRIGGER payment_provider_conflicts_immutable
BEFORE UPDATE OR DELETE ON billing.payment_provider_conflicts
FOR EACH ROW EXECUTE FUNCTION billing.reject_immutable_provider_evidence();
CREATE TRIGGER telegram_stars_receipts_immutable
BEFORE UPDATE OR DELETE ON billing.telegram_stars_receipts
FOR EACH ROW EXECUTE FUNCTION billing.reject_immutable_provider_evidence();

CREATE FUNCTION billing.guard_payment_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_record_id <> OLD.payment_record_id OR NEW.created_at <> OLD.created_at
    OR NEW.attempt_count < OLD.attempt_count OR NEW.fence_token < OLD.fence_token
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid payment fulfillment mutation' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.state = 'receipt_recorded' AND NEW.state = 'fulfillment_pending')
    OR (OLD.state = 'fulfillment_pending' AND NEW.state IN ('fulfillment_pending','fulfilled','correction_required'))
    OR (OLD.state = 'correction_required' AND NEW.state = 'corrected')
  ) THEN
    RAISE EXCEPTION 'invalid payment fulfillment transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payment_fulfillment_guard
BEFORE UPDATE ON billing.payment_fulfillments
FOR EACH ROW EXECUTE FUNCTION billing.guard_payment_fulfillment();
