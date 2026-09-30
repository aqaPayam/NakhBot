DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'moderation.moderation_actions'::regclass
      AND tgname = 'moderation_action_report_scope_guard' AND tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'moderation.moderation_actions'::regclass
      AND tgname = 'moderation_action_report_attempt_guard' AND tgenabled = 'O'
      AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'report action scope or deferred attempt guard is missing';
  END IF;
END $$;
