DO $$
DECLARE
  reason_count integer;
BEGIN
  SELECT count(*) INTO reason_count FROM moderation.report_reasons WHERE is_active;
  IF reason_count <> 7 THEN
    RAISE EXCEPTION 'M7 report reason seed is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'moderation' AND table_name = 'reports'
      AND constraint_name = 'reports_not_self_ck'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'moderation' AND table_name = 'reports'
      AND constraint_name = 'reports_lifecycle_ck'
  ) THEN
    RAISE EXCEPTION 'M7 report constraints are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'moderation' AND indexname = 'reports_reporter_window_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'moderation' AND indexname = 'reports_target_threshold_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'moderation' AND indexname = 'reports_review_queue_idx'
  ) THEN
    RAISE EXCEPTION 'M7 report indexes are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'reports_admission' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'reports_update_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'reports_delete_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'report_reasons_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M7 report guards are incomplete';
  END IF;
END $$;
