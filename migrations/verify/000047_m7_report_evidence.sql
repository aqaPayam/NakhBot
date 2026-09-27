DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'moderation' AND table_name = 'report_evidence'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'moderation' AND table_name = 'report_snapshots'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'moderation' AND table_name = 'evidence_access_audits'
  ) THEN
    RAISE EXCEPTION 'M7 report evidence tables are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'chat' AND table_name = 'chat_message_snapshots'
      AND constraint_name = 'chat_message_snapshots_report_fk'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'chat' AND table_name = 'chat_message_snapshot_requests'
      AND constraint_name = 'chat_snapshot_requests_report_fk'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'media' AND table_name = 'photo_moderation_records'
      AND constraint_name = 'photo_moderation_report_fk'
  ) THEN
    RAISE EXCEPTION 'M7 cross-module evidence ownership is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'report_requires_evidence' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'report_evidence_valid' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'report_evidence_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'report_snapshot_valid' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'report_snapshots_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'evidence_access_audit_valid' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'evidence_access_audits_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'chat_message_evidence_delete_guard'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M7 evidence guards are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'moderation' AND indexname = 'report_evidence_report_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'moderation' AND indexname = 'report_snapshots_key_version_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'moderation' AND indexname = 'evidence_access_audits_report_time_idx'
  ) THEN
    RAISE EXCEPTION 'M7 evidence indexes are incomplete';
  END IF;
END $$;
