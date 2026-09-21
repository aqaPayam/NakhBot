CREATE TABLE billing.pending_payments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason IN ('send_nakh','unlock_chat','unlock_liked_by_profile','buy_credit_package')),
  target_type text NOT NULL CHECK (target_type IN ('credit_package','like','match','pending_nakh')),
  target_id uuid NOT NULL,
  funding_type text NOT NULL CHECK (funding_type IN ('credits','telegram_stars')),
  required_credits bigint,
  required_stars bigint,
  package_code_snapshot text,
  package_credit_amount_snapshot bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled','expired')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 160),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT pending_payment_amount_ck CHECK (
    (funding_type = 'credits' AND required_credits > 0 AND required_stars IS NULL)
    OR (funding_type = 'telegram_stars' AND required_stars > 0 AND required_credits IS NULL)
  ),
  CONSTRAINT pending_payment_target_ck CHECK (
    (reason = 'buy_credit_package' AND target_type = 'credit_package' AND funding_type = 'telegram_stars'
      AND package_code_snapshot IS NOT NULL AND package_credit_amount_snapshot > 0)
    OR (reason = 'unlock_liked_by_profile' AND target_type = 'like'
      AND package_code_snapshot IS NULL AND package_credit_amount_snapshot IS NULL)
    OR (reason = 'unlock_chat' AND target_type = 'match'
      AND package_code_snapshot IS NULL AND package_credit_amount_snapshot IS NULL)
    OR (reason = 'send_nakh' AND target_type = 'pending_nakh'
      AND package_code_snapshot IS NULL AND package_credit_amount_snapshot IS NULL)
  ),
  CONSTRAINT pending_payment_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT pending_payment_lifecycle_ck CHECK (
    (status = 'pending' AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  ),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (id, user_id)
);

CREATE UNIQUE INDEX pending_payments_open_target_idx
  ON billing.pending_payments (user_id, reason, target_type, target_id)
  WHERE status = 'pending';
CREATE INDEX pending_payments_user_time_idx
  ON billing.pending_payments (user_id, created_at DESC, id DESC);
CREATE INDEX pending_payments_expiry_idx
  ON billing.pending_payments (expires_at, id) WHERE status = 'pending';

CREATE TABLE billing.payment_records (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  pending_payment_id uuid NOT NULL,
  payment_type text NOT NULL CHECK (payment_type IN ('buy_credit_package','direct_paid_action','pay_pending_action')),
  paid_action_reason text CHECK (paid_action_reason IS NULL OR paid_action_reason IN ('send_nakh','unlock_chat','unlock_liked_by_profile')),
  credit_package_id uuid REFERENCES billing.credit_packages(id) ON DELETE RESTRICT,
  package_code_snapshot text,
  package_credit_amount_snapshot bigint,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled','expired','refunded')),
  stars_amount bigint NOT NULL CHECK (stars_amount > 0),
  provider text NOT NULL CHECK (provider = 'telegram_stars'),
  provider_environment text NOT NULL CHECK (provider_environment IN ('local','test','staging','production')),
  provider_bot_id_digest text NOT NULL CHECK (char_length(provider_bot_id_digest) = 64),
  invoice_payload_digest text NOT NULL UNIQUE CHECK (char_length(invoice_payload_digest) = 64),
  invoice_payload_ciphertext bytea NOT NULL CHECK (octet_length(invoice_payload_ciphertext) BETWEEN 32 AND 2048),
  invoice_payload_key_id text NOT NULL CHECK (invoice_payload_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  provider_payment_id text UNIQUE CHECK (provider_payment_id IS NULL OR char_length(provider_payment_id) BETWEEN 1 AND 256),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 160),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  paid_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  refunded_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT payment_record_type_ck CHECK (
    (payment_type = 'buy_credit_package' AND paid_action_reason IS NULL AND credit_package_id IS NOT NULL
      AND package_code_snapshot IS NOT NULL AND package_credit_amount_snapshot > 0)
    OR (payment_type IN ('direct_paid_action','pay_pending_action') AND paid_action_reason IS NOT NULL
      AND credit_package_id IS NULL AND package_code_snapshot IS NULL AND package_credit_amount_snapshot IS NULL)
  ),
  CONSTRAINT payment_record_lifecycle_ck CHECK (
    (status = 'pending' AND paid_at IS NULL AND failed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL AND refunded_at IS NULL)
    OR (status = 'paid' AND paid_at IS NOT NULL AND failed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL AND refunded_at IS NULL)
    OR (status = 'failed' AND paid_at IS NULL AND failed_at IS NOT NULL AND cancelled_at IS NULL AND expired_at IS NULL AND refunded_at IS NULL)
    OR (status = 'cancelled' AND paid_at IS NULL AND failed_at IS NULL AND cancelled_at IS NOT NULL AND expired_at IS NULL AND refunded_at IS NULL)
    OR (status = 'expired' AND paid_at IS NULL AND failed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NOT NULL AND refunded_at IS NULL)
    OR (status = 'refunded' AND paid_at IS NOT NULL AND failed_at IS NULL AND cancelled_at IS NULL AND expired_at IS NULL AND refunded_at IS NOT NULL)
  ),
  CONSTRAINT payment_record_intent_user_fk FOREIGN KEY (pending_payment_id, user_id)
    REFERENCES billing.pending_payments(id, user_id) ON DELETE RESTRICT,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX payment_records_user_time_idx
  ON billing.payment_records (user_id, created_at DESC, id DESC);
CREATE INDEX payment_records_reconciliation_idx
  ON billing.payment_records (status, created_at, id);
CREATE INDEX payment_records_attempt_window_idx
  ON billing.payment_records (user_id, created_at DESC);
CREATE INDEX payment_records_pending_payment_idx
  ON billing.payment_records (pending_payment_id, created_at DESC, id DESC);

ALTER TABLE billing.credit_transactions
  ADD CONSTRAINT credit_transactions_payment_record_fk
  FOREIGN KEY (payment_record_id) REFERENCES billing.payment_records(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE billing.credit_transactions
  ADD CONSTRAINT credit_transactions_pending_payment_fk
  FOREIGN KEY (pending_payment_id) REFERENCES billing.pending_payments(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION billing.guard_pending_payment_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.reason <> OLD.reason
    OR NEW.target_type <> OLD.target_type OR NEW.target_id <> OLD.target_id
    OR NEW.funding_type <> OLD.funding_type OR NEW.required_credits IS DISTINCT FROM OLD.required_credits
    OR NEW.required_stars IS DISTINCT FROM OLD.required_stars
    OR NEW.package_code_snapshot IS DISTINCT FROM OLD.package_code_snapshot
    OR NEW.package_credit_amount_snapshot IS DISTINCT FROM OLD.package_credit_amount_snapshot
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_hash <> OLD.request_hash OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'pending payment identity and price are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid pending payment transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pending_payment_lifecycle_guard
BEFORE UPDATE ON billing.pending_payments
FOR EACH ROW EXECUTE FUNCTION billing.guard_pending_payment_lifecycle();

CREATE FUNCTION billing.guard_payment_record_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.pending_payment_id <> OLD.pending_payment_id
    OR NEW.payment_type <> OLD.payment_type OR NEW.paid_action_reason IS DISTINCT FROM OLD.paid_action_reason
    OR NEW.credit_package_id IS DISTINCT FROM OLD.credit_package_id
    OR NEW.package_code_snapshot IS DISTINCT FROM OLD.package_code_snapshot
    OR NEW.package_credit_amount_snapshot IS DISTINCT FROM OLD.package_credit_amount_snapshot
    OR NEW.stars_amount <> OLD.stars_amount OR NEW.provider <> OLD.provider
    OR NEW.provider_environment <> OLD.provider_environment OR NEW.provider_bot_id_digest <> OLD.provider_bot_id_digest
    OR NEW.invoice_payload_digest <> OLD.invoice_payload_digest
    OR NEW.invoice_payload_ciphertext <> OLD.invoice_payload_ciphertext
    OR NEW.invoice_payload_key_id <> OLD.invoice_payload_key_id OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.request_hash <> OLD.request_hash OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'payment record identity and snapshot are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('paid','failed','cancelled','expired'))
    OR (OLD.status = 'paid' AND NEW.status = 'refunded')
  ) OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'invalid payment record transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER payment_record_lifecycle_guard
BEFORE UPDATE ON billing.payment_records
FOR EACH ROW EXECUTE FUNCTION billing.guard_payment_record_lifecycle();
