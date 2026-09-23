CREATE TABLE chat.predefined_question_sets (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  title_key text NOT NULL UNIQUE CHECK (title_key ~ '^[a-z][a-z0-9_.]{0,159}$'),
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL UNIQUE CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE TABLE chat.predefined_questions (
  id uuid PRIMARY KEY,
  question_set_id uuid NOT NULL REFERENCES chat.predefined_question_sets(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  text_key text NOT NULL UNIQUE CHECK (text_key ~ '^[a-z][a-z0-9_.]{0,159}$'),
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (question_set_id, code),
  UNIQUE (question_set_id, display_order)
);

CREATE INDEX predefined_questions_active_order_idx
  ON chat.predefined_questions (question_set_id, display_order, id)
  WHERE is_active;

CREATE TABLE chat.predefined_answers (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES chat.predefined_questions(id) ON DELETE RESTRICT,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  text_key text NOT NULL UNIQUE CHECK (text_key ~ '^[a-z][a-z0-9_.]{0,159}$'),
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL CHECK (display_order >= 0),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (question_id, code),
  UNIQUE (question_id, display_order)
);

CREATE INDEX predefined_answers_active_order_idx
  ON chat.predefined_answers (question_id, display_order, id)
  WHERE is_active;

CREATE FUNCTION chat.guard_prompt_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['is_active','updated_at','version'])
      <> (to_jsonb(OLD) - ARRAY['is_active','updated_at','version'])
    OR NEW.is_active = OLD.is_active
    OR NEW.updated_at <= OLD.updated_at
    OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'prompt catalog identity is immutable and updates must toggle active state'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER predefined_question_sets_guard
BEFORE UPDATE ON chat.predefined_question_sets
FOR EACH ROW EXECUTE FUNCTION chat.guard_prompt_catalog();
CREATE TRIGGER predefined_questions_guard
BEFORE UPDATE ON chat.predefined_questions
FOR EACH ROW EXECUTE FUNCTION chat.guard_prompt_catalog();
CREATE TRIGGER predefined_answers_guard
BEFORE UPDATE ON chat.predefined_answers
FOR EACH ROW EXECUTE FUNCTION chat.guard_prompt_catalog();

WITH seed(code, display_order) AS (
  VALUES
    ('relationship_intent', 1),
    ('ideal_first_date', 2),
    ('chat_frequency', 3),
    ('social_energy', 4),
    ('weekend_habits', 5),
    ('calls_or_texting', 6),
    ('important_values', 7),
    ('meeting_in_person', 8),
    ('relationship_pace', 9),
    ('current_life_focus', 10)
)
INSERT INTO chat.predefined_question_sets (
  id, code, title_key, is_active, display_order, created_at, updated_at
)
SELECT md5('chat:question-set:' || code)::uuid, code,
  'chat.prompt.set.' || code || '.title', true, display_order,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
FROM seed;

INSERT INTO chat.predefined_questions (
  id, question_set_id, code, text_key, is_active, display_order, created_at, updated_at
)
SELECT md5('chat:question:' || code || ':primary')::uuid, id, 'primary',
  'chat.prompt.' || code || '.question', true, 1,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
FROM chat.predefined_question_sets;

WITH seed(set_code, answer_code, display_order) AS (
  VALUES
    ('relationship_intent', 'serious_relationship', 1),
    ('relationship_intent', 'something_casual', 2),
    ('relationship_intent', 'friendship', 3),
    ('relationship_intent', 'marriage', 4),
    ('relationship_intent', 'still_figuring_it_out', 5),
    ('ideal_first_date', 'coffee_and_conversation', 1),
    ('ideal_first_date', 'walk_outdoors', 2),
    ('ideal_first_date', 'dinner', 3),
    ('ideal_first_date', 'fun_activity', 4),
    ('ideal_first_date', 'surprise_me', 5),
    ('chat_frequency', 'throughout_the_day', 1),
    ('chat_frequency', 'few_times_a_day', 2),
    ('chat_frequency', 'one_daily_check_in', 3),
    ('chat_frequency', 'whenever_both_free', 4),
    ('social_energy', 'introvert', 1),
    ('social_energy', 'mostly_introvert', 2),
    ('social_energy', 'a_mix', 3),
    ('social_energy', 'mostly_extrovert', 4),
    ('social_energy', 'extrovert', 5),
    ('weekend_habits', 'staying_in', 1),
    ('weekend_habits', 'friends_or_family', 2),
    ('weekend_habits', 'exploring_the_city', 3),
    ('weekend_habits', 'nature_or_adventure', 4),
    ('weekend_habits', 'working_on_hobbies', 5),
    ('calls_or_texting', 'mostly_text', 1),
    ('calls_or_texting', 'mostly_calls', 2),
    ('calls_or_texting', 'a_mix', 3),
    ('calls_or_texting', 'voice_messages', 4),
    ('calls_or_texting', 'it_depends', 5),
    ('important_values', 'honesty', 1),
    ('important_values', 'kindness', 2),
    ('important_values', 'ambition', 3),
    ('important_values', 'family', 4),
    ('important_values', 'humor', 5),
    ('meeting_in_person', 'after_a_few_good_conversations', 1),
    ('meeting_in_person', 'within_a_week', 2),
    ('meeting_in_person', 'prefer_more_time', 3),
    ('meeting_in_person', 'video_call_first', 4),
    ('relationship_pace', 'slow_and_steady', 1),
    ('relationship_pace', 'let_it_happen_naturally', 2),
    ('relationship_pace', 'intentional_and_fast', 3),
    ('relationship_pace', 'it_depends_on_connection', 4),
    ('current_life_focus', 'career_or_studies', 1),
    ('current_life_focus', 'family', 2),
    ('current_life_focus', 'health_and_growth', 3),
    ('current_life_focus', 'fun_and_new_experiences', 4),
    ('current_life_focus', 'finding_balance', 5)
)
INSERT INTO chat.predefined_answers (
  id, question_id, code, text_key, is_active, display_order, created_at, updated_at
)
SELECT md5('chat:answer:' || seed.set_code || ':' || seed.answer_code)::uuid,
  question.id, seed.answer_code,
  'chat.prompt.' || seed.set_code || '.answer.' || seed.answer_code,
  true, seed.display_order, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
FROM seed
JOIN chat.predefined_question_sets question_set ON question_set.code = seed.set_code
JOIN chat.predefined_questions question ON question.question_set_id = question_set.id
  AND question.code = 'primary';

ALTER TABLE chat.chat_participants
  ADD COLUMN last_read_sequence_number bigint CHECK (last_read_sequence_number >= 1),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD CONSTRAINT chat_participant_read_shape_ck CHECK (
    (last_read_at IS NULL AND last_read_sequence_number IS NULL)
    OR (last_read_at IS NOT NULL AND last_read_sequence_number IS NOT NULL)
  );

CREATE TABLE chat.chat_messages (
  id uuid PRIMARY KEY,
  chat_session_id uuid NOT NULL REFERENCES chat.chat_sessions(id) ON DELETE RESTRICT,
  sender_user_id uuid REFERENCES identity.users(id) ON DELETE RESTRICT,
  message_type text NOT NULL CHECK (message_type IN (
    'predefined_question','predefined_answer','text','system'
  )),
  text text,
  predefined_question_id uuid REFERENCES chat.predefined_questions(id) ON DELETE RESTRICT,
  predefined_answer_id uuid REFERENCES chat.predefined_answers(id) ON DELETE RESTRICT,
  system_arguments jsonb,
  sequence_number bigint NOT NULL CHECK (sequence_number >= 1),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (chat_session_id, sequence_number),
  FOREIGN KEY (chat_session_id, sender_user_id)
    REFERENCES chat.chat_participants(chat_session_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT chat_message_text_bound_ck CHECK (
    text IS NULL OR (char_length(text) BETWEEN 1 AND 1000 AND text = btrim(text))
  ),
  CONSTRAINT chat_message_payload_ck CHECK (
    (message_type = 'predefined_question' AND sender_user_id IS NOT NULL
      AND predefined_question_id IS NOT NULL AND predefined_answer_id IS NULL
      AND text IS NULL AND system_arguments IS NULL)
    OR (message_type = 'predefined_answer' AND sender_user_id IS NOT NULL
      AND predefined_question_id IS NULL AND predefined_answer_id IS NOT NULL
      AND text IS NULL AND system_arguments IS NULL)
    OR (message_type = 'text' AND sender_user_id IS NOT NULL
      AND predefined_question_id IS NULL AND predefined_answer_id IS NULL
      AND text IS NOT NULL AND system_arguments IS NULL)
    OR (message_type = 'system' AND sender_user_id IS NULL
      AND predefined_question_id IS NULL AND predefined_answer_id IS NULL
      AND text IS NOT NULL AND text ~ '^[a-z][a-z0-9_.]{0,159}$'
      AND system_arguments IS NOT NULL
      AND jsonb_typeof(system_arguments) = 'object'
      AND octet_length(system_arguments::text) <= 2048)
  )
);

CREATE INDEX chat_messages_session_page_idx
  ON chat.chat_messages (chat_session_id, sequence_number DESC);
CREATE INDEX chat_messages_sender_time_idx
  ON chat.chat_messages (sender_user_id, created_at DESC, id)
  WHERE sender_user_id IS NOT NULL;

CREATE FUNCTION chat.require_allocated_message_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  session_status text;
  allocated_next bigint;
BEGIN
  SELECT status, next_sequence_number INTO session_status, allocated_next
  FROM chat.chat_sessions WHERE id = NEW.chat_session_id;
  IF session_status <> 'active' OR allocated_next <> NEW.sequence_number + 1 THEN
    RAISE EXCEPTION 'chat message sequence was not reserved by the active session'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_message_sequence_reserved
BEFORE INSERT ON chat.chat_messages
FOR EACH ROW EXECUTE FUNCTION chat.require_allocated_message_sequence();

CREATE FUNCTION chat.reject_chat_message_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chat messages are immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER chat_messages_update_immutable
BEFORE UPDATE ON chat.chat_messages
FOR EACH ROW EXECUTE FUNCTION chat.reject_chat_message_update();

CREATE FUNCTION chat.verify_session_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_session_id uuid;
  expected_next bigint;
  actual_next bigint;
BEGIN
  IF TG_TABLE_NAME = 'chat_sessions' THEN
    checked_session_id := NEW.id;
  ELSE
    checked_session_id := COALESCE(NEW.chat_session_id, OLD.chat_session_id);
  END IF;
  SELECT next_sequence_number INTO actual_next
  FROM chat.chat_sessions WHERE id = checked_session_id;
  IF actual_next IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(max(sequence_number), 0) + 1 INTO expected_next
  FROM chat.chat_messages WHERE chat_session_id = checked_session_id;
  IF actual_next <> expected_next THEN
    RAISE EXCEPTION 'chat session sequence allocator diverged from messages'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER chat_session_sequence_consistent
AFTER INSERT OR UPDATE ON chat.chat_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION chat.verify_session_sequence();
CREATE CONSTRAINT TRIGGER chat_message_sequence_consistent
AFTER INSERT OR DELETE ON chat.chat_messages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION chat.verify_session_sequence();

CREATE FUNCTION chat.guard_chat_participant_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.chat_session_id <> OLD.chat_session_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'chat participant identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1
    OR (to_jsonb(NEW) - 'version') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'version') THEN
    RAISE EXCEPTION 'chat participant update must advance state and version'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.last_read_sequence_number IS NOT NULL AND (
      NEW.last_read_sequence_number IS NULL
      OR NEW.last_read_sequence_number < OLD.last_read_sequence_number
      OR NEW.last_read_at < OLD.last_read_at
    ) THEN
    RAISE EXCEPTION 'chat read state cannot move backward' USING ERRCODE = '23514';
  END IF;
  IF OLD.unlock_safety_warning_shown_at IS NOT NULL
    AND NEW.unlock_safety_warning_shown_at IS DISTINCT FROM OLD.unlock_safety_warning_shown_at THEN
    RAISE EXCEPTION 'chat safety warning state is monotonic' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER chat_participant_state_guard
BEFORE UPDATE ON chat.chat_participants
FOR EACH ROW EXECUTE FUNCTION chat.guard_chat_participant_state();

CREATE FUNCTION chat.verify_participant_read_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocated_next bigint;
BEGIN
  IF NEW.last_read_sequence_number IS NULL THEN RETURN NULL; END IF;
  SELECT next_sequence_number INTO allocated_next
  FROM chat.chat_sessions WHERE id = NEW.chat_session_id;
  IF NEW.last_read_sequence_number >= allocated_next THEN
    RAISE EXCEPTION 'chat read sequence exceeds committed messages' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER chat_participant_read_sequence_valid
AFTER INSERT OR UPDATE ON chat.chat_participants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION chat.verify_participant_read_sequence();

COMMENT ON TABLE chat.predefined_question_sets IS
  'Stable localized prompt-set catalog; rows are deactivated rather than deleted.';
COMMENT ON TABLE chat.predefined_questions IS
  'Stable localized predefined questions; handlers resolve text through localization keys.';
COMMENT ON TABLE chat.predefined_answers IS
  'Stable answers owned by exactly one predefined question.';
COMMENT ON TABLE chat.chat_messages IS
  'Sensitive immutable live chat content; normal reads are capped at the newest 50 and M6 cleanup deletes older rows after evidence handling.';
COMMENT ON COLUMN chat.chat_participants.last_read_sequence_number IS
  'Derived monotonic cursor for scalable unread calculations; last_read_at remains the canonical user-facing time.';
