CREATE TABLE chat.chat_message_snapshot_requests (
  report_id uuid NOT NULL,
  chat_session_id uuid NOT NULL,
  original_message_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  captured_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  PRIMARY KEY (report_id, original_message_id),
  CONSTRAINT chat_snapshot_request_capture_ck CHECK (
    captured_at IS NULL OR captured_at >= requested_at
  )
);

CREATE INDEX chat_snapshot_requests_pending_idx
  ON chat.chat_message_snapshot_requests (chat_session_id, original_message_id, report_id)
  WHERE captured_at IS NULL;

CREATE TABLE chat.chat_message_snapshots (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL,
  chat_session_id uuid NOT NULL,
  original_message_id uuid NOT NULL,
  sender_user_id uuid,
  message_type text NOT NULL CHECK (message_type IN (
    'predefined_question','predefined_answer','text','system'
  )),
  content jsonb NOT NULL CHECK (
    jsonb_typeof(content) = 'object' AND octet_length(content::text) <= 8192
  ),
  original_created_at timestamptz NOT NULL,
  snapshotted_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  integrity_sha256 text NOT NULL CHECK (integrity_sha256 ~ '^[0-9a-f]{64}$'),
  UNIQUE (report_id, original_message_id),
  CONSTRAINT chat_snapshot_sender_ck CHECK (
    (message_type = 'system' AND sender_user_id IS NULL)
    OR (message_type <> 'system' AND sender_user_id IS NOT NULL)
  ),
  CONSTRAINT chat_snapshot_content_ck CHECK (
    (message_type = 'predefined_question' AND content - 'predefinedQuestionId' = '{}'::jsonb
      AND content ? 'predefinedQuestionId'
      AND content->>'predefinedQuestionId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (message_type = 'predefined_answer' AND content - 'predefinedAnswerId' = '{}'::jsonb
      AND content ? 'predefinedAnswerId'
      AND content->>'predefinedAnswerId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    OR (message_type = 'text' AND content - 'text' = '{}'::jsonb
      AND content ? 'text' AND jsonb_typeof(content->'text') = 'string'
      AND char_length(content->>'text') BETWEEN 1 AND 1000)
    OR (message_type = 'system'
      AND content - ARRAY['localizationKey', 'arguments'] = '{}'::jsonb
      AND content ? 'localizationKey' AND content ? 'arguments'
      AND content->>'localizationKey' ~ '^[a-z][a-z0-9_.]{0,159}$'
      AND jsonb_typeof(content->'arguments') = 'object')
  )
);

CREATE INDEX chat_message_snapshots_session_time_idx
  ON chat.chat_message_snapshots (chat_session_id, original_created_at DESC, original_message_id);
CREATE INDEX chat_message_snapshots_report_idx
  ON chat.chat_message_snapshots (report_id, original_created_at, original_message_id);

CREATE TABLE chat.chat_cleanup_checkpoints (
  chat_session_id uuid PRIMARY KEY REFERENCES chat.chat_sessions(id) ON DELETE RESTRICT,
  last_retained_sequence_number bigint CHECK (last_retained_sequence_number >= 1),
  deleted_message_count bigint NOT NULL DEFAULT 0 CHECK (deleted_message_count >= 0),
  last_cleaned_at timestamptz NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE FUNCTION chat.validate_snapshot_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM chat.chat_messages
    WHERE id = NEW.original_message_id AND chat_session_id = NEW.chat_session_id
  ) THEN
    RAISE EXCEPTION 'snapshot request must reference a live message in the session'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_snapshot_request_valid
BEFORE INSERT ON chat.chat_message_snapshot_requests
FOR EACH ROW EXECUTE FUNCTION chat.validate_snapshot_request();

CREATE FUNCTION chat.guard_snapshot_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.report_id <> OLD.report_id OR NEW.chat_session_id <> OLD.chat_session_id
    OR NEW.original_message_id <> OLD.original_message_id
    OR NEW.requested_at <> OLD.requested_at
    OR OLD.captured_at IS NOT NULL OR NEW.captured_at IS NULL
    OR NEW.version <> OLD.version + 1
    OR NOT EXISTS (
      SELECT 1 FROM chat.chat_message_snapshots
      WHERE report_id = NEW.report_id AND original_message_id = NEW.original_message_id
    ) THEN
    RAISE EXCEPTION 'snapshot request transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_snapshot_request_guard
BEFORE UPDATE ON chat.chat_message_snapshot_requests
FOR EACH ROW EXECUTE FUNCTION chat.guard_snapshot_request();

CREATE FUNCTION chat.validate_message_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source chat.chat_messages%ROWTYPE;
  expected_content jsonb;
BEGIN
  SELECT * INTO source FROM chat.chat_messages
  WHERE id = NEW.original_message_id AND chat_session_id = NEW.chat_session_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM chat.chat_message_snapshot_requests
    WHERE report_id = NEW.report_id AND original_message_id = NEW.original_message_id
      AND chat_session_id = NEW.chat_session_id
  ) THEN
    RAISE EXCEPTION 'snapshot source or request is missing' USING ERRCODE = '23514';
  END IF;
  expected_content := CASE source.message_type
    WHEN 'predefined_question' THEN jsonb_build_object(
      'predefinedQuestionId', source.predefined_question_id
    )
    WHEN 'predefined_answer' THEN jsonb_build_object(
      'predefinedAnswerId', source.predefined_answer_id
    )
    WHEN 'text' THEN jsonb_build_object('text', source.text)
    WHEN 'system' THEN jsonb_build_object(
      'localizationKey', source.text, 'arguments', source.system_arguments
    )
  END;
  IF NEW.sender_user_id IS DISTINCT FROM source.sender_user_id
    OR NEW.message_type <> source.message_type
    OR NEW.original_created_at <> source.created_at
    OR NEW.content <> expected_content THEN
    RAISE EXCEPTION 'snapshot does not match its live source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_message_snapshot_valid
BEFORE INSERT ON chat.chat_message_snapshots
FOR EACH ROW EXECUTE FUNCTION chat.validate_message_snapshot();

CREATE FUNCTION chat.reject_message_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chat message snapshots are immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER chat_message_snapshots_update_immutable
BEFORE UPDATE ON chat.chat_message_snapshots
FOR EACH ROW EXECUTE FUNCTION chat.reject_message_snapshot_mutation();
CREATE TRIGGER chat_message_snapshots_delete_immutable
BEFORE DELETE ON chat.chat_message_snapshots
FOR EACH ROW EXECUTE FUNCTION chat.reject_message_snapshot_mutation();

CREATE FUNCTION chat.guard_cleanup_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.chat_session_id <> OLD.chat_session_id
    OR NEW.deleted_message_count < OLD.deleted_message_count
    OR (OLD.last_retained_sequence_number IS NOT NULL AND (
      NEW.last_retained_sequence_number IS NULL
      OR NEW.last_retained_sequence_number < OLD.last_retained_sequence_number
    ))
    OR NEW.last_cleaned_at < OLD.last_cleaned_at
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'chat cleanup checkpoint cannot move backward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_cleanup_checkpoint_guard
BEFORE UPDATE ON chat.chat_cleanup_checkpoints
FOR EACH ROW EXECUTE FUNCTION chat.guard_cleanup_checkpoint();

COMMENT ON TABLE chat.chat_message_snapshot_requests IS
  'Restricted report-context markers; cleanup captures every pending marker before deleting live content.';
COMMENT ON TABLE chat.chat_message_snapshots IS
  'Append-only restricted report evidence, independent from live-message retention and the future M7 Report foreign key.';
COMMENT ON TABLE chat.chat_cleanup_checkpoints IS
  'Bounded live-message cleanup progress; ordinary chat reads still enforce the newest-50 ceiling.';
