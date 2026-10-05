DO $$
DECLARE scope_definition text; attempt_definition text;
BEGIN
  SELECT pg_get_functiondef('moderation.verify_action_report_scope()'::regprocedure) INTO scope_definition;
  SELECT pg_get_functiondef('moderation.verify_action_report_attempt()'::regprocedure) INTO attempt_definition;
  IF position('create_internal_block' IN scope_definition) = 0
    OR position('remove_internal_block' IN scope_definition) = 0
    OR position('report.reporter_user_id' IN scope_definition) = 0
    OR position('review.assigned_admin_id = NEW.actor_admin_id' IN scope_definition) = 0
    OR position('moderation.admin_pair_target_id' IN attempt_definition) = 0
    OR position('moderation.change-internal-block' IN attempt_definition) = 0
    OR position('moderation.apply-photo-action' IN attempt_definition) = 0
    OR position('log.result = ''succeeded''' IN attempt_definition) = 0 THEN
    RAISE EXCEPTION 'report-linked internal block scope or successful attempt verification is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'moderation.moderation_actions'::regclass
    AND tgname = 'moderation_action_report_scope_guard' AND tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'moderation.moderation_actions'::regclass
      AND tgname = 'moderation_action_report_attempt_guard' AND tgenabled = 'O' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'report action guards are missing';
  END IF;
  IF moderation.admin_pair_target_id('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002') <> 'a2105599-16da-54f2-940a-967fe0a81907'::uuid THEN
    RAISE EXCEPTION 'canonical admin pair target is missing';
  END IF;
END $$;
