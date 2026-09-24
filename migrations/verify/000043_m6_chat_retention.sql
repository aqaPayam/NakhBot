DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'chat' AND table_name = 'chat_message_snapshot_requests'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'chat' AND table_name = 'chat_message_snapshots'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'chat' AND table_name = 'chat_cleanup_checkpoints'
  ) THEN
    RAISE EXCEPTION 'M6 chat retention tables are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'chat' AND indexname = 'chat_snapshot_requests_pending_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'chat' AND indexname = 'chat_message_snapshots_session_time_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'chat' AND indexname = 'chat_message_snapshots_report_idx'
  ) THEN
    RAISE EXCEPTION 'M6 chat retention indexes are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'chat_snapshot_request_valid' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'chat_snapshot_request_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'chat_message_snapshot_valid' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'chat_message_snapshots_update_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'chat_message_snapshots_delete_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'chat_cleanup_checkpoint_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M6 chat retention guards are incomplete';
  END IF;
END $$;
