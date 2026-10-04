DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'billing' AND constraint_name = 'reconciliation_runs_run_type_check'
      AND check_clause LIKE '%moderation%' AND check_clause LIKE '%chat%'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'billing' AND constraint_name = 'reconciliation_anomalies_entity_type_check'
      AND check_clause LIKE '%report%' AND check_clause LIKE '%support_thread%'
      AND check_clause LIKE '%user_appeal%' AND check_clause LIKE '%chat_session%'
  ) THEN
    RAISE EXCEPTION 'M7 reconciliation types are incomplete';
  END IF;
  IF to_regclass('administration.safety_access_audits') IS NULL
    OR to_regclass('support.support_threads_status_created_idx') IS NULL
    OR to_regclass('moderation.user_appeals_status_submitted_idx') IS NULL THEN
    RAISE EXCEPTION 'M7 restricted access and queue indexes are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'administration.safety_access_audits'::regclass
      AND tgname = 'safety_access_audits_valid' AND NOT tgisinternal AND tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'administration.safety_access_audits'::regclass
      AND tgname = 'safety_access_audits_immutable' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'M7 safety access guards are incomplete';
  END IF;
END $$;
