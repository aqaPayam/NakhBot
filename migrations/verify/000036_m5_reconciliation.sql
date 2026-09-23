DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'billing' AND indexname = 'reconciliation_runs_active_type_idx'
  ) THEN
    RAISE EXCEPTION 'M5 reconciliation active-run index is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_schema = 'billing'
      AND constraint_name = 'reconciliation_runs_run_type_check'
      AND check_clause LIKE '%nakh%'
  ) THEN
    RAISE EXCEPTION 'M5 reconciliation run type is unavailable';
  END IF;
END $$;
