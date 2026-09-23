DO $$
DECLARE
  set_codes text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'chat' AND table_name = 'predefined_question_sets'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'chat' AND table_name = 'predefined_questions'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'chat' AND table_name = 'predefined_answers'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'chat' AND table_name = 'chat_messages'
  ) THEN
    RAISE EXCEPTION 'M6 chat catalog/message tables are incomplete';
  END IF;

  IF (SELECT count(*) FROM chat.predefined_question_sets) <> 10
    OR (SELECT count(*) FROM chat.predefined_questions) <> 10
    OR (SELECT count(*) FROM chat.predefined_answers) <> 47 THEN
    RAISE EXCEPTION 'M6 predefined prompt seed counts are invalid';
  END IF;

  SELECT array_agg(code ORDER BY code) INTO set_codes FROM chat.predefined_question_sets;
  IF set_codes <> ARRAY[
    'calls_or_texting','chat_frequency','current_life_focus','ideal_first_date',
    'important_values','meeting_in_person','relationship_intent','relationship_pace',
    'social_energy','weekend_habits'
  ]::text[] THEN
    RAISE EXCEPTION 'M6 predefined prompt set codes are invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM chat.predefined_question_sets question_set
    LEFT JOIN chat.predefined_questions question ON question.question_set_id = question_set.id
    LEFT JOIN chat.predefined_answers answer ON answer.question_id = question.id
    GROUP BY question_set.id
    HAVING count(DISTINCT question.id) <> 1 OR count(answer.id) NOT BETWEEN 4 AND 5
  ) THEN
    RAISE EXCEPTION 'M6 predefined prompt hierarchy is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'chat' AND table_name = 'chat_participants'
      AND column_name = 'last_read_sequence_number'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'chat' AND table_name = 'chat_participants'
      AND column_name = 'version'
  ) THEN
    RAISE EXCEPTION 'M6 chat participant state columns are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'chat' AND indexname = 'chat_messages_session_page_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'chat_message_sequence_reserved' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'chat_session_sequence_consistent' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'chat_participant_state_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M6 chat message guards or indexes are incomplete';
  END IF;
END $$;
