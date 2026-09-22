ALTER TABLE nakh.nakh_flows
  ADD CONSTRAINT nakh_flows_identity_unique
  UNIQUE (id, sender_user_id, receiver_user_id);

CREATE TABLE nakh.nakhes (
  id uuid PRIMARY KEY,
  nakh_flow_id uuid NOT NULL UNIQUE,
  sender_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  receiver_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 240 AND char_length(btrim(text)) > 0),
  funding_type text NOT NULL CHECK (funding_type IN ('credits','telegram_stars')),
  credit_transaction_id uuid UNIQUE,
  payment_record_id uuid UNIQUE,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN (
    'sent','seen','accepted','rejected','expired','closed'
  )),
  sent_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz NOT NULL,
  seen_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  expired_at timestamptz,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (id, receiver_user_id),
  CONSTRAINT nakh_flow_identity_fk FOREIGN KEY (
    nakh_flow_id, sender_user_id, receiver_user_id
  ) REFERENCES nakh.nakh_flows (id, sender_user_id, receiver_user_id) ON DELETE RESTRICT,
  CONSTRAINT nakh_funding_shape_ck CHECK (
    (funding_type = 'credits' AND credit_transaction_id IS NOT NULL AND payment_record_id IS NULL)
    OR (funding_type = 'telegram_stars' AND credit_transaction_id IS NULL AND payment_record_id IS NOT NULL)
  ),
  CONSTRAINT nakh_expiry_ck CHECK (expires_at = sent_at + interval '336 hours'),
  CONSTRAINT nakh_lifecycle_ck CHECK (
    (status = 'sent' AND seen_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL
      AND expired_at IS NULL AND closed_at IS NULL)
    OR (status = 'seen' AND seen_at IS NOT NULL AND accepted_at IS NULL AND rejected_at IS NULL
      AND expired_at IS NULL AND closed_at IS NULL)
    OR (status = 'accepted' AND accepted_at IS NOT NULL AND rejected_at IS NULL
      AND expired_at IS NULL AND closed_at IS NULL)
    OR (status = 'rejected' AND accepted_at IS NULL AND rejected_at IS NOT NULL
      AND expired_at IS NULL AND closed_at IS NULL)
    OR (status = 'expired' AND accepted_at IS NULL AND rejected_at IS NULL
      AND expired_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'closed' AND accepted_at IS NULL AND rejected_at IS NULL
      AND expired_at IS NULL AND closed_at IS NOT NULL)
  ),
  CONSTRAINT nakh_lifecycle_time_ck CHECK (
    (seen_at IS NULL OR seen_at >= sent_at)
    AND (accepted_at IS NULL OR accepted_at >= sent_at)
    AND (rejected_at IS NULL OR rejected_at >= sent_at)
    AND (expired_at IS NULL OR expired_at >= expires_at)
    AND (closed_at IS NULL OR closed_at >= sent_at)
  )
);

CREATE INDEX nakhes_receiver_inbox_idx
  ON nakh.nakhes (receiver_user_id, sent_at DESC, id DESC);
CREATE INDEX nakhes_sender_status_idx
  ON nakh.nakhes (sender_user_id, sent_at DESC, id DESC);
CREATE INDEX nakhes_expiry_idx
  ON nakh.nakhes (expires_at, id)
  WHERE status IN ('sent','seen');

CREATE TABLE nakh.nakh_status_history (
  id uuid PRIMARY KEY,
  nakh_id uuid NOT NULL REFERENCES nakh.nakhes(id) ON DELETE RESTRICT,
  nakh_version integer NOT NULL CHECK (nakh_version >= 1),
  from_status text CHECK (from_status IS NULL OR from_status IN (
    'sent','seen','accepted','rejected','expired','closed'
  )),
  to_status text NOT NULL CHECK (to_status IN (
    'sent','seen','accepted','rejected','expired','closed'
  )),
  reason_code text NOT NULL CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  changed_by_user_id uuid REFERENCES identity.users(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (nakh_id, nakh_version),
  CONSTRAINT nakh_history_shape_ck CHECK (
    (nakh_version = 1 AND from_status IS NULL AND to_status = 'sent')
    OR (nakh_version > 1 AND from_status IS NOT NULL AND from_status <> to_status)
  )
);

CREATE INDEX nakh_status_history_time_idx
  ON nakh.nakh_status_history (nakh_id, changed_at, nakh_version);

CREATE TABLE nakh.nakh_receiver_actions (
  id uuid PRIMARY KEY,
  nakh_id uuid NOT NULL,
  receiver_user_id uuid NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('view_profile','accept','reject','report')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 160),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT nakh_receiver_action_owner_fk FOREIGN KEY (nakh_id, receiver_user_id)
    REFERENCES nakh.nakhes(id, receiver_user_id) ON DELETE RESTRICT,
  UNIQUE (nakh_id, idempotency_key)
);

CREATE UNIQUE INDEX nakh_receiver_actions_terminal_idx
  ON nakh.nakh_receiver_actions (nakh_id)
  WHERE action_type IN ('accept','reject');
CREATE INDEX nakh_receiver_actions_receiver_time_idx
  ON nakh.nakh_receiver_actions (receiver_user_id, created_at DESC, id DESC);

CREATE FUNCTION nakh.guard_nakh_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delivered Nakh history is retained' USING ERRCODE = '55000';
  END IF;
  IF NEW.id <> OLD.id OR NEW.nakh_flow_id <> OLD.nakh_flow_id
    OR NEW.sender_user_id <> OLD.sender_user_id OR NEW.receiver_user_id <> OLD.receiver_user_id
    OR NEW.text <> OLD.text OR NEW.funding_type <> OLD.funding_type
    OR NEW.credit_transaction_id IS DISTINCT FROM OLD.credit_transaction_id
    OR NEW.payment_record_id IS DISTINCT FROM OLD.payment_record_id
    OR NEW.sent_at <> OLD.sent_at OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'delivered Nakh identity, text, funding, and clocks are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'delivered Nakh version must advance once' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'sent' AND NEW.status IN ('seen','accepted','rejected','expired','closed'))
    OR (OLD.status = 'seen' AND NEW.status IN ('accepted','rejected','expired','closed'))
  ) THEN
    RAISE EXCEPTION 'invalid delivered Nakh lifecycle transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.seen_at IS NOT NULL AND NEW.seen_at IS DISTINCT FROM OLD.seen_at THEN
    RAISE EXCEPTION 'delivered Nakh first-seen time is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nakhes_lifecycle_guard
BEFORE UPDATE OR DELETE ON nakh.nakhes
FOR EACH ROW EXECUTE FUNCTION nakh.guard_nakh_lifecycle();

CREATE FUNCTION nakh.guard_nakh_status_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
  current_version integer;
  previous_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Nakh status history is append-only' USING ERRCODE = '55000';
  END IF;
  SELECT status, version INTO current_status, current_version
    FROM nakh.nakhes WHERE id = NEW.nakh_id;
  IF current_status IS NULL OR current_status <> NEW.to_status OR current_version <> NEW.nakh_version THEN
    RAISE EXCEPTION 'Nakh status history must describe the current aggregate version'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.nakh_version > 1 THEN
    SELECT to_status INTO previous_status FROM nakh.nakh_status_history
      WHERE nakh_id = NEW.nakh_id AND nakh_version = NEW.nakh_version - 1;
    IF previous_status IS NULL OR previous_status <> NEW.from_status THEN
      RAISE EXCEPTION 'Nakh status history continuity is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nakh_status_history_guard
BEFORE INSERT OR UPDATE OR DELETE ON nakh.nakh_status_history
FOR EACH ROW EXECUTE FUNCTION nakh.guard_nakh_status_history();

CREATE FUNCTION nakh.reject_nakh_receiver_action_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Nakh receiver actions are append-only' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER nakh_receiver_actions_immutable
BEFORE UPDATE OR DELETE ON nakh.nakh_receiver_actions
FOR EACH ROW EXECUTE FUNCTION nakh.reject_nakh_receiver_action_mutation();

CREATE FUNCTION nakh.verify_nakh_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_nakh_id uuid;
  current_status text;
  current_version integer;
  history_count integer;
  first_version integer;
  last_version integer;
  last_status text;
BEGIN
  IF TG_TABLE_NAME = 'nakhes' THEN
    checked_nakh_id := COALESCE(NEW.id, OLD.id);
  ELSE
    checked_nakh_id := COALESCE(NEW.nakh_id, OLD.nakh_id);
  END IF;
  SELECT status, version INTO current_status, current_version
    FROM nakh.nakhes WHERE id = checked_nakh_id;
  IF current_status IS NULL THEN RETURN NULL; END IF;
  SELECT count(*), min(nakh_version), max(nakh_version) INTO history_count, first_version, last_version
    FROM nakh.nakh_status_history WHERE nakh_id = checked_nakh_id;
  SELECT to_status INTO last_status FROM nakh.nakh_status_history
    WHERE nakh_id = checked_nakh_id AND nakh_version = current_version;
  IF history_count <> current_version OR first_version <> 1 OR last_version <> current_version
    OR last_status IS DISTINCT FROM current_status THEN
    RAISE EXCEPTION 'Nakh status history diverged from aggregate state' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER nakhes_history_guard
AFTER INSERT OR UPDATE ON nakh.nakhes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_nakh_history();
CREATE CONSTRAINT TRIGGER nakh_status_history_aggregate_guard
AFTER INSERT ON nakh.nakh_status_history
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_nakh_history();

COMMENT ON TABLE nakh.nakhes IS
  'Immutable funded Nakh delivery with independent 14-day lifecycle and exactly one funding proof.';
COMMENT ON COLUMN nakh.nakhes.text IS
  'Immutable user prose; prohibited from logs, metrics, generic outbox payloads, and billing projections.';
COMMENT ON TABLE nakh.nakh_status_history IS
  'Append-only, gap-free lifecycle evidence for delivered Nakhes.';
COMMENT ON TABLE nakh.nakh_receiver_actions IS
  'Receiver-bound idempotent actions; one unique terminal accept or reject may win.';
