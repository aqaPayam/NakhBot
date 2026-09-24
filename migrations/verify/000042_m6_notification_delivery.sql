DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'notification' AND table_name = 'notification_deliveries'
      AND column_name = 'provider_progress'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'notification' AND table_name = 'notification_deliveries'
      AND column_name = 'lease_owner'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'notification' AND table_name = 'notification_deliveries'
      AND column_name = 'lease_expires_at'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'notification' AND table_name = 'notification_deliveries'
      AND column_name = 'fence_token'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'notification' AND table_name = 'notification_deliveries'
      AND column_name = 'quarantined_at'
  ) THEN
    RAISE EXCEPTION 'M6 notification delivery reliability columns are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'notification'
      AND indexname = 'notification_deliveries_due_claim_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'notification'
      AND indexname = 'notification_deliveries_expired_call_idx'
  ) THEN
    RAISE EXCEPTION 'M6 notification delivery reliability indexes are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'notification_delivery_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M6 notification delivery guard is missing';
  END IF;
END $$;
