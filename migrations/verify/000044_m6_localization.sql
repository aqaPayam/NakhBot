DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT count(*) INTO missing_count
  FROM (
    SELECT title_key AS text_key FROM chat.predefined_question_sets
    UNION ALL SELECT text_key FROM chat.predefined_questions
    UNION ALL SELECT text_key FROM chat.predefined_answers
  ) required
  WHERE NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts text
    WHERE text.locale_code = 'en' AND text.text_key = required.text_key
      AND text.is_active = true
  );
  IF missing_count <> 0 THEN
    RAISE EXCEPTION 'M6 prompt localization catalog is incomplete (% missing)', missing_count;
  END IF;

  SELECT count(*) INTO missing_count
  FROM (VALUES
    ('notification.new_chat_message.title'),
    ('notification.new_chat_message.body'),
    ('notification.chat_closed.title'),
    ('notification.chat_closed.body'),
    ('notification.chat_unlock_safety.title'),
    ('notification.chat_unlock_safety.body'),
    ('error.chat.unavailable'),
    ('error.chat.text_invalid'),
    ('error.chat.text_unavailable'),
    ('error.chat.cursor_invalid'),
    ('error.chat.snapshot_invalid'),
    ('error.notification.delivery_state_invalid')
  ) required(text_key)
  WHERE NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts text
    WHERE text.locale_code = 'en' AND text.text_key = required.text_key
      AND text.is_active = true AND text.variables = '[]'::jsonb
  );
  IF missing_count <> 0 THEN
    RAISE EXCEPTION 'M6 Chat English presentation is incomplete (% missing)', missing_count;
  END IF;
END $$;
