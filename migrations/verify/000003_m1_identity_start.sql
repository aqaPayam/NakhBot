DO $$
BEGIN
  IF to_regclass('platform.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'platform.audit_logs is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'audit_logs_append_only' AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'append-only audit trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'platform' AND indexname = 'audit_logs_subject_time_idx'
  ) THEN
    RAISE EXCEPTION 'audit subject/time index is missing';
  END IF;
END
$$;
