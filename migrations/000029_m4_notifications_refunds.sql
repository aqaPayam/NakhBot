CREATE TABLE notification.notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  notification_type text NOT NULL CHECK (notification_type IN (
    'like_received','nakh_received','match_created','new_chat_message','chat_unlocked',
    'liked_by_profile_unlocked','report_result','restriction_warning','ban_warning',
    'payment_success','payment_failure','pending_nakh_payment_reminder','admin_notice',
    'safety_notice','chat_closed'
  )),
  category text NOT NULL CHECK (category IN (
    'chat','like','nakh','match','safety','payment','admin','ban','restriction'
  )),
  title_key text NOT NULL CHECK (title_key ~ '^[a-z][a-z0-9_.]{0,159}$'),
  body_key text NOT NULL CHECK (body_key ~ '^[a-z][a-z0-9_.]{0,159}$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
  payload_schema_version integer NOT NULL DEFAULT 1 CHECK (payload_schema_version >= 1),
  status text NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read')),
  deduplication_key text CHECK (
    deduplication_key IS NULL OR char_length(deduplication_key) BETWEEN 8 AND 200
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  read_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT notification_read_state_ck CHECK (
    (status = 'unread' AND read_at IS NULL) OR (status = 'read' AND read_at IS NOT NULL)
  ),
  CONSTRAINT notification_type_category_ck CHECK (
    (notification_type = 'new_chat_message' AND category = 'chat')
    OR (notification_type IN ('like_received','liked_by_profile_unlocked') AND category = 'like')
    OR (notification_type IN ('nakh_received','pending_nakh_payment_reminder') AND category = 'nakh')
    OR (notification_type IN ('match_created','chat_unlocked','chat_closed') AND category = 'match')
    OR (notification_type = 'safety_notice' AND category = 'safety')
    OR (notification_type IN ('payment_success','payment_failure') AND category = 'payment')
    OR (notification_type IN ('report_result','admin_notice') AND category = 'admin')
    OR (notification_type = 'ban_warning' AND category = 'ban')
    OR (notification_type = 'restriction_warning' AND category = 'restriction')
  )
);

CREATE UNIQUE INDEX notifications_deduplication_idx
  ON notification.notifications (deduplication_key);
CREATE INDEX notifications_user_status_time_idx
  ON notification.notifications (user_id, status, created_at DESC, id DESC);

CREATE TABLE notification.notification_deliveries (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notification.notifications(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('telegram','in_app')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','failed_retryable','failed_terminal')),
  attempt_number integer NOT NULL DEFAULT 0 CHECK (attempt_number >= 0),
  next_attempt_at timestamptz DEFAULT transaction_timestamp(),
  sent_at timestamptz,
  failed_at timestamptz,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  provider_delivery_key text CHECK (
    provider_delivery_key IS NULL OR char_length(provider_delivery_key) BETWEEN 1 AND 256
  ),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (notification_id, channel),
  CONSTRAINT notification_delivery_state_ck CHECK (
    (status = 'pending' AND next_attempt_at IS NOT NULL AND sent_at IS NULL
      AND failed_at IS NULL AND failure_code IS NULL)
    OR (status = 'sent' AND next_attempt_at IS NULL AND sent_at IS NOT NULL
      AND failed_at IS NULL AND failure_code IS NULL)
    OR (status = 'failed_retryable' AND next_attempt_at IS NOT NULL AND sent_at IS NULL
      AND failed_at IS NOT NULL AND failure_code IS NOT NULL)
    OR (status = 'failed_terminal' AND next_attempt_at IS NULL AND sent_at IS NULL
      AND failed_at IS NOT NULL AND failure_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX notification_deliveries_provider_key_idx
  ON notification.notification_deliveries (channel, provider_delivery_key)
  WHERE provider_delivery_key IS NOT NULL;
CREATE INDEX notification_deliveries_due_idx
  ON notification.notification_deliveries (next_attempt_at, id)
  WHERE status IN ('pending','failed_retryable');

CREATE FUNCTION notification.guard_notification_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
    OR NEW.notification_type <> OLD.notification_type OR NEW.category <> OLD.category
    OR NEW.title_key <> OLD.title_key OR NEW.body_key <> OLD.body_key
    OR NEW.payload <> OLD.payload OR NEW.payload_schema_version <> OLD.payload_schema_version
    OR NEW.deduplication_key IS DISTINCT FROM OLD.deduplication_key
    OR NEW.created_at <> OLD.created_at OR OLD.status <> 'unread' OR NEW.status <> 'read'
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid notification history mutation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER notification_history_guard
BEFORE UPDATE ON notification.notifications
FOR EACH ROW EXECUTE FUNCTION notification.guard_notification_history();

CREATE FUNCTION notification.guard_notification_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.notification_id <> OLD.notification_id OR NEW.channel <> OLD.channel
    OR NEW.created_at <> OLD.created_at OR NEW.attempt_number < OLD.attempt_number
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid notification delivery mutation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER notification_delivery_guard
BEFORE UPDATE ON notification.notification_deliveries
FOR EACH ROW EXECUTE FUNCTION notification.guard_notification_delivery();

CREATE TABLE billing.refund_records (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  funding_type text NOT NULL CHECK (funding_type IN ('credits','telegram_stars')),
  payment_record_id uuid REFERENCES billing.payment_records(id) ON DELETE RESTRICT,
  original_credit_transaction_id uuid REFERENCES billing.credit_transactions(id) ON DELETE RESTRICT,
  refund_credit_transaction_id uuid UNIQUE REFERENCES billing.credit_transactions(id) ON DELETE RESTRICT,
  telegram_charge_id text CHECK (
    telegram_charge_id IS NULL OR char_length(telegram_charge_id) BETWEEN 1 AND 256
  ),
  reason_code text NOT NULL CHECK (reason_code IN (
    'target_unavailable','system_failure','duplicate_capture'
  )),
  stars_amount bigint CHECK (stars_amount IS NULL OR stars_amount > 0),
  credits_amount bigint CHECK (credits_amount IS NULL OR credits_amount > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processed','failed_retryable','failed_terminal')),
  provider_progress text NOT NULL DEFAULT 'not_started'
    CHECK (provider_progress IN ('not_started','call_started','refund_confirmed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  fence_token bigint NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
  available_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  lease_owner text CHECK (lease_owner IS NULL OR char_length(lease_owner) BETWEEN 1 AND 128),
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  processed_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT refund_funding_shape_ck CHECK (
    (funding_type = 'telegram_stars' AND payment_record_id IS NOT NULL
      AND original_credit_transaction_id IS NULL AND refund_credit_transaction_id IS NULL
      AND telegram_charge_id IS NOT NULL AND stars_amount IS NOT NULL AND credits_amount IS NULL)
    OR (funding_type = 'credits' AND payment_record_id IS NULL
      AND original_credit_transaction_id IS NOT NULL AND telegram_charge_id IS NULL
      AND stars_amount IS NULL AND credits_amount IS NOT NULL)
  ),
  CONSTRAINT refund_lease_ck CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      AND status IN ('pending','failed_retryable'))
  ),
  CONSTRAINT refund_state_ck CHECK (
    (status = 'pending' AND processed_at IS NULL AND failed_at IS NULL)
    OR (status = 'processed' AND processed_at IS NOT NULL AND failed_at IS NULL
      AND lease_owner IS NULL AND (
        (funding_type = 'telegram_stars' AND provider_progress = 'refund_confirmed')
        OR (funding_type = 'credits' AND refund_credit_transaction_id IS NOT NULL)
      ))
    OR (status = 'failed_retryable' AND processed_at IS NULL AND failed_at IS NOT NULL
      AND last_error_code IS NOT NULL)
    OR (status = 'failed_terminal' AND processed_at IS NULL AND failed_at IS NOT NULL
      AND last_error_code IS NOT NULL AND lease_owner IS NULL)
  )
);

CREATE UNIQUE INDEX refund_records_payment_idx
  ON billing.refund_records (payment_record_id) WHERE payment_record_id IS NOT NULL;
CREATE UNIQUE INDEX refund_records_original_credit_idx
  ON billing.refund_records (original_credit_transaction_id)
  WHERE original_credit_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX refund_records_telegram_charge_idx
  ON billing.refund_records (telegram_charge_id) WHERE telegram_charge_id IS NOT NULL;
CREATE INDEX refund_records_due_idx
  ON billing.refund_records (available_at, id)
  WHERE status IN ('pending','failed_retryable');

CREATE FUNCTION billing.guard_refund_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.funding_type <> OLD.funding_type
    OR NEW.payment_record_id IS DISTINCT FROM OLD.payment_record_id
    OR NEW.original_credit_transaction_id IS DISTINCT FROM OLD.original_credit_transaction_id
    OR NEW.telegram_charge_id IS DISTINCT FROM OLD.telegram_charge_id
    OR NEW.reason_code <> OLD.reason_code OR NEW.stars_amount IS DISTINCT FROM OLD.stars_amount
    OR NEW.credits_amount IS DISTINCT FROM OLD.credits_amount
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at
    OR NEW.attempt_count < OLD.attempt_count OR NEW.fence_token < OLD.fence_token
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid refund record mutation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER refund_record_guard
BEFORE UPDATE ON billing.refund_records
FOR EACH ROW EXECUTE FUNCTION billing.guard_refund_record();

CREATE TABLE billing.reconciliation_runs (
  id uuid PRIMARY KEY,
  run_type text NOT NULL DEFAULT 'billing' CHECK (run_type = 'billing'),
  status text NOT NULL CHECK (status IN ('started','succeeded','failed')),
  cursor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cursor) = 'object'),
  scanned_count bigint NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  anomaly_count bigint NOT NULL DEFAULT 0 CHECK (anomaly_count >= 0),
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  started_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  finished_at timestamptz,
  CONSTRAINT reconciliation_run_state_ck CHECK (
    (status = 'started' AND finished_at IS NULL AND failure_code IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND failure_code IS NOT NULL)
  )
);

CREATE INDEX reconciliation_runs_time_idx
  ON billing.reconciliation_runs (started_at DESC, id DESC);

CREATE TABLE billing.reconciliation_anomalies (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES billing.reconciliation_runs(id) ON DELETE RESTRICT,
  anomaly_type text NOT NULL CHECK (anomaly_type ~ '^[a-z][a-z0-9_]{0,79}$'),
  entity_type text NOT NULL CHECK (entity_type IN (
    'payment_record','payment_fulfillment','credit_account','credit_transaction',
    'feature_unlock','refund_record','provider_event'
  )),
  entity_id uuid NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('repair_scheduled','quarantined')),
  safe_detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(safe_detail) = 'object' AND octet_length(safe_detail::text) <= 4096),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  detected_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX reconciliation_anomalies_entity_idx
  ON billing.reconciliation_anomalies (entity_type, entity_id, detected_at DESC);

CREATE FUNCTION billing.reject_reconciliation_anomaly_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation anomaly is append-only' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER reconciliation_anomalies_immutable
BEFORE UPDATE OR DELETE ON billing.reconciliation_anomalies
FOR EACH ROW EXECUTE FUNCTION billing.reject_reconciliation_anomaly_mutation();

COMMENT ON TABLE notification.notifications IS
  'Durable in-app notification history; mutable preferences never suppress this record.';
COMMENT ON TABLE notification.notification_deliveries IS
  'One asynchronous provider delivery per notification and channel.';
COMMENT ON TABLE billing.refund_records IS
  'Idempotent automatic correction progress for a verified funding proof.';
COMMENT ON TABLE billing.reconciliation_anomalies IS
  'Append-only safe reconciliation findings; repairs use normal idempotent commands.';
