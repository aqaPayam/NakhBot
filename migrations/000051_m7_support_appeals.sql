CREATE SCHEMA IF NOT EXISTS support;

CREATE TABLE support.support_threads (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  open_command_id uuid NOT NULL UNIQUE,
  open_idempotency_key text NOT NULL CHECK (char_length(open_idempotency_key) BETWEEN 8 AND 128),
  open_request_digest text NOT NULL CHECK (open_request_digest ~ '^[0-9a-f]{64}$'),
  last_message_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  closed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (user_id, open_idempotency_key),
  CONSTRAINT support_thread_lifecycle_ck CHECK (
    (status = 'open' AND closed_at IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL)
  )
);

CREATE INDEX support_threads_user_open_idx
  ON support.support_threads (user_id, last_message_at DESC, id DESC) WHERE status = 'open';

CREATE TABLE support.support_messages (
  id uuid PRIMARY KEY,
  support_thread_id uuid NOT NULL REFERENCES support.support_threads(id) ON DELETE RESTRICT,
  sender_type text NOT NULL CHECK (sender_type IN ('user','admin')),
  sender_user_id uuid REFERENCES identity.users(id) ON DELETE RESTRICT,
  sender_admin_id uuid REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  message_text text NOT NULL CHECK (char_length(message_text) BETWEEN 1 AND 4000),
  command_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  thread_version_after integer NOT NULL CHECK (thread_version_after >= 1),
  unanswered_user_messages_after integer NOT NULL
    CHECK (unanswered_user_messages_after BETWEEN 0 AND 2),
  created_at timestamptz NOT NULL,
  CONSTRAINT support_message_sender_ck CHECK (
    (sender_type = 'user' AND sender_user_id IS NOT NULL AND sender_admin_id IS NULL)
    OR (sender_type = 'admin' AND sender_user_id IS NULL AND sender_admin_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX support_messages_user_idempotency_uq
  ON support.support_messages (sender_user_id, idempotency_key) WHERE sender_type = 'user';
CREATE INDEX support_messages_thread_time_idx
  ON support.support_messages (support_thread_id, created_at, id);
CREATE INDEX support_messages_admin_time_idx
  ON support.support_messages (created_at DESC, id DESC) WHERE sender_type = 'admin';

CREATE FUNCTION support.guard_thread_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
    OR NEW.open_command_id <> OLD.open_command_id
    OR NEW.open_idempotency_key <> OLD.open_idempotency_key
    OR NEW.open_request_digest <> OLD.open_request_digest OR NEW.created_at <> OLD.created_at
    OR OLD.status = 'closed' OR NEW.version <> OLD.version + 1
    OR NEW.last_message_at < OLD.last_message_at
    OR NOT (NEW.status = 'open' OR (OLD.status = 'open' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION 'support thread transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER support_threads_update_guard
BEFORE UPDATE ON support.support_threads
FOR EACH ROW EXECUTE FUNCTION support.guard_thread_update();

CREATE FUNCTION support.reject_message_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'support messages are immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER support_messages_immutable
BEFORE UPDATE OR DELETE ON support.support_messages
FOR EACH ROW EXECUTE FUNCTION support.reject_message_mutation();

CREATE TABLE moderation.user_appeals (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  ban_state_history_id uuid NOT NULL UNIQUE REFERENCES identity.account_state_history(id) ON DELETE RESTRICT,
  message_text text NOT NULL CHECK (char_length(message_text) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','in_review','accepted','rejected')),
  reviewed_by_admin_id uuid REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  admin_note text,
  submitted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  reviewed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT user_appeal_review_ck CHECK (
    (status IN ('submitted','in_review') AND reviewed_by_admin_id IS NULL
      AND admin_note IS NULL AND reviewed_at IS NULL)
    OR (status IN ('accepted','rejected') AND reviewed_by_admin_id IS NOT NULL
      AND reviewed_at IS NOT NULL)
  )
);

CREATE INDEX user_appeals_queue_idx
  ON moderation.user_appeals (submitted_at, id) WHERE status IN ('submitted','in_review');

CREATE FUNCTION moderation.guard_user_appeal_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
    OR NEW.ban_state_history_id <> OLD.ban_state_history_id
    OR NEW.message_text <> OLD.message_text OR NEW.submitted_at <> OLD.submitted_at
    OR NEW.version <> OLD.version + 1 OR NOT (
      (OLD.status = 'submitted' AND NEW.status IN ('in_review','accepted','rejected'))
      OR (OLD.status = 'in_review' AND NEW.status IN ('accepted','rejected'))
    ) THEN
    RAISE EXCEPTION 'user appeal transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER user_appeals_update_guard
BEFORE UPDATE ON moderation.user_appeals
FOR EACH ROW EXECUTE FUNCTION moderation.guard_user_appeal_update();

COMMENT ON TABLE support.support_threads IS
  'Non-banned user support conversations; admission is serialized per user across open threads.';
COMMENT ON TABLE support.support_messages IS
  'Restricted immutable support text with replay and unanswered-count evidence.';
COMMENT ON TABLE moderation.user_appeals IS
  'Exactly one appeal for one immutable AccountStateHistory ban event.';
