DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'matching' AND table_name = 'unmatch_records'
  ) THEN
    RAISE EXCEPTION 'M6 Unmatch table is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'matching' AND indexname = 'unmatch_records_actor_idempotency_uq'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'matching' AND indexname = 'unmatch_records_report_window_idx'
  ) THEN
    RAISE EXCEPTION 'M6 Unmatch indexes are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'unmatch_records_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'unmatch_record_consistent' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'unmatched_match_consistent' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'unmatched_pair_consistent' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'unmatched_chat_consistent' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M6 Unmatch guards are incomplete';
  END IF;
END $$;
