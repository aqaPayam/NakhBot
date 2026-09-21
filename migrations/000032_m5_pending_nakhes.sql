CREATE TABLE nakh.pending_nakhes (
  id uuid PRIMARY KEY,
  nakh_flow_id uuid NOT NULL UNIQUE,
  sender_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 240 AND char_length(btrim(text)) > 0),
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
    'pending_payment','paid_and_sent','cancelled','expired','closed_by_system'
  )),
  pending_payment_id uuid NOT NULL UNIQUE REFERENCES billing.pending_payments(id)
    DEFERRABLE INITIALLY DEFERRED,
  auto_settle_authorized_at timestamptz NOT NULL,
  authorization_source text NOT NULL CHECK (authorization_source = 'explore'),
  authorized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  paid_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  closed_at timestamptz,
  cancel_resolution text CHECK (cancel_resolution IS NULL OR cancel_resolution IN (
    'converted_to_like','converted_to_not_interested'
  )),
  reminder_count integer NOT NULL DEFAULT 0 CHECK (reminder_count BETWEEN 0 AND 6),
  last_reminder_at timestamptz,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 160),
  request_hash text NOT NULL CHECK (char_length(request_hash) = 64),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT pending_nakh_flow_sender_fk FOREIGN KEY (nakh_flow_id, sender_user_id)
    REFERENCES nakh.nakh_flows(id, sender_user_id) ON DELETE RESTRICT,
  CONSTRAINT pending_nakh_expiry_ck CHECK (expires_at = created_at + interval '336 hours'),
  CONSTRAINT pending_nakh_authorization_ck CHECK (
    authorized_at <= created_at AND auto_settle_authorized_at <= created_at
  ),
  CONSTRAINT pending_nakh_reminder_ck CHECK (
    (reminder_count = 0 AND last_reminder_at IS NULL)
    OR (reminder_count > 0 AND last_reminder_at IS NOT NULL
      AND last_reminder_at >= created_at AND last_reminder_at < expires_at)
  ),
  CONSTRAINT pending_nakh_lifecycle_ck CHECK (
    (status = 'pending_payment' AND paid_at IS NULL AND cancelled_at IS NULL
      AND expired_at IS NULL AND closed_at IS NULL AND cancel_resolution IS NULL)
    OR (status = 'paid_and_sent' AND paid_at IS NOT NULL AND cancelled_at IS NULL
      AND expired_at IS NULL AND closed_at IS NULL AND cancel_resolution IS NULL)
    OR (status = 'cancelled' AND paid_at IS NULL AND cancelled_at IS NOT NULL
      AND expired_at IS NULL AND closed_at IS NULL AND cancel_resolution IS NOT NULL)
    OR (status = 'expired' AND paid_at IS NULL AND cancelled_at IS NULL
      AND expired_at IS NOT NULL AND closed_at IS NULL AND cancel_resolution IS NULL)
    OR (status = 'closed_by_system' AND paid_at IS NULL AND cancelled_at IS NULL
      AND expired_at IS NULL AND closed_at IS NOT NULL AND cancel_resolution IS NULL)
  ),
  UNIQUE (sender_user_id, idempotency_key)
);

CREATE INDEX pending_nakhes_sender_fifo_idx
  ON nakh.pending_nakhes (sender_user_id, created_at, id)
  WHERE status = 'pending_payment';
CREATE INDEX pending_nakhes_expiry_idx
  ON nakh.pending_nakhes (expires_at, id)
  WHERE status = 'pending_payment';
CREATE INDEX pending_nakhes_reminder_idx
  ON nakh.pending_nakhes (COALESCE(last_reminder_at, created_at), id)
  WHERE status = 'pending_payment' AND reminder_count < 6;

CREATE FUNCTION nakh.guard_pending_nakh_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pending Nakh history is retained' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.nakh_flow_id <> OLD.nakh_flow_id
    OR NEW.sender_user_id <> OLD.sender_user_id
    OR NEW.pending_payment_id <> OLD.pending_payment_id
    OR NEW.auto_settle_authorized_at <> OLD.auto_settle_authorized_at
    OR NEW.authorization_source <> OLD.authorization_source OR NEW.authorized_at <> OLD.authorized_at
    OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at
    OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.request_hash <> OLD.request_hash THEN
    RAISE EXCEPTION 'pending Nakh identity and authorization are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending_payment' OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'terminal pending Nakh is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'pending_payment' THEN
    IF NEW.paid_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.expired_at IS NOT NULL
      OR NEW.closed_at IS NOT NULL OR NEW.cancel_resolution IS NOT NULL THEN
      RAISE EXCEPTION 'pending Nakh cannot carry terminal facts' USING ERRCODE = '23514';
    END IF;
    IF NEW.reminder_count = OLD.reminder_count THEN
      IF NEW.last_reminder_at IS DISTINCT FROM OLD.last_reminder_at OR NEW.text = OLD.text THEN
        RAISE EXCEPTION 'pending Nakh edit must change only text' USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.reminder_count = OLD.reminder_count + 1 THEN
      IF NEW.text <> OLD.text OR NEW.last_reminder_at IS NULL
        OR NEW.last_reminder_at <= COALESCE(OLD.last_reminder_at, OLD.created_at)
        OR NEW.last_reminder_at < COALESCE(OLD.last_reminder_at, OLD.created_at) + interval '48 hours' THEN
        RAISE EXCEPTION 'invalid pending Nakh reminder advance' USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'invalid pending Nakh mutable update' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status NOT IN ('paid_and_sent','cancelled','expired','closed_by_system')
    OR NEW.text <> OLD.text OR NEW.reminder_count <> OLD.reminder_count
    OR NEW.last_reminder_at IS DISTINCT FROM OLD.last_reminder_at THEN
    RAISE EXCEPTION 'invalid pending Nakh terminal transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pending_nakhes_lifecycle_guard
BEFORE UPDATE OR DELETE ON nakh.pending_nakhes
FOR EACH ROW EXECUTE FUNCTION nakh.guard_pending_nakh_lifecycle();

CREATE FUNCTION nakh.verify_pending_nakh_counter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_user_id uuid;
  stored_count integer;
  source_count integer;
BEGIN
  IF TG_TABLE_SCHEMA = 'platform' THEN
    checked_user_id := COALESCE(NEW.user_id, OLD.user_id);
  ELSE
    checked_user_id := COALESCE(NEW.sender_user_id, OLD.sender_user_id);
  END IF;
  SELECT pending_nakh_count INTO stored_count
    FROM platform.user_counters WHERE user_id = checked_user_id;
  SELECT count(*) INTO source_count FROM nakh.pending_nakhes
    WHERE sender_user_id = checked_user_id AND status = 'pending_payment';
  IF stored_count IS NULL OR stored_count <> source_count THEN
    RAISE EXCEPTION 'pending Nakh counter diverged from source rows' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER pending_nakh_counter_source_guard
AFTER INSERT OR UPDATE OR DELETE ON nakh.pending_nakhes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_pending_nakh_counter();
CREATE CONSTRAINT TRIGGER pending_nakh_counter_value_guard
AFTER INSERT OR UPDATE ON platform.user_counters
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_pending_nakh_counter();

CREATE FUNCTION nakh.verify_pending_nakh_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_pending_nakh_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA = 'billing' THEN
    IF NEW.reason <> 'send_nakh' THEN RETURN NULL; END IF;
    checked_pending_nakh_id := NEW.target_id;
  ELSE
    checked_pending_nakh_id := NEW.id;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM nakh.pending_nakhes pending
    JOIN billing.pending_payments payment ON payment.id = pending.pending_payment_id
    WHERE pending.id = checked_pending_nakh_id
      AND payment.reason = 'send_nakh' AND payment.target_type = 'pending_nakh'
      AND payment.target_id = pending.id AND payment.user_id = pending.sender_user_id
      AND payment.funding_type = 'telegram_stars' AND payment.required_stars = 2
      AND payment.required_credits IS NULL AND payment.expires_at = pending.expires_at
  ) THEN
    RAISE EXCEPTION 'pending Nakh payment snapshot is missing or inconsistent' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER pending_nakh_payment_guard
AFTER INSERT OR UPDATE ON nakh.pending_nakhes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_pending_nakh_payment();
CREATE CONSTRAINT TRIGGER pending_payment_nakh_guard
AFTER INSERT OR UPDATE ON billing.pending_payments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_pending_nakh_payment();

COMMENT ON TABLE nakh.pending_nakhes IS
  'Sender-only unpaid Nakh state. Receiver queries and notification workers must never read this table.';
COMMENT ON COLUMN nakh.pending_nakhes.text IS
  'User prose; prohibited from logs, metrics, billing projections, and generic notification payloads.';
