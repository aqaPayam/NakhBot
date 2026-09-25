DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'billing'
      AND constraint_name = 'reconciliation_runs_run_type_check'
      AND check_clause LIKE '%chat%'
  ) THEN
    RAISE EXCEPTION 'M6 chat reconciliation run type is unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'billing'
      AND constraint_name = 'reconciliation_anomalies_entity_type_check'
      AND check_clause LIKE '%chat_session%'
      AND check_clause LIKE '%notification_delivery%'
  ) THEN
    RAISE EXCEPTION 'M6 chat reconciliation entity types are unavailable';
  END IF;
END $$;
