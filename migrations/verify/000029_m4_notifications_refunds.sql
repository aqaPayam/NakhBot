DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'notification' AND table_name = 'notifications'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'notification' AND table_name = 'notification_deliveries'
  ) THEN
    RAISE EXCEPTION 'M4 notification foundation is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'billing' AND table_name = 'refund_records'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'billing' AND table_name = 'reconciliation_runs'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'billing' AND table_name = 'reconciliation_anomalies'
  ) THEN
    RAISE EXCEPTION 'M4 correction and reconciliation foundation is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'notification' AND indexname = 'notifications_deduplication_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'notification' AND indexname = 'notification_deliveries_due_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'billing' AND indexname = 'refund_records_due_idx'
  ) THEN
    RAISE EXCEPTION 'M4 notification/refund indexes are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'notification_history_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'notification_delivery_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'refund_record_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'reconciliation_anomalies_immutable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M4 notification/refund lifecycle guards are missing';
  END IF;
END $$;
