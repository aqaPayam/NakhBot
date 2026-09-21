DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'billing' AND table_name = 'payment_provider_events')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'billing' AND table_name = 'payment_provider_conflicts')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'billing' AND table_name = 'telegram_stars_receipts')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'billing' AND table_name = 'payment_fulfillments') THEN
    RAISE EXCEPTION 'M4 provider receipt tables are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'billing' AND indexname = 'payment_fulfillments_due_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'billing' AND indexname = 'payment_provider_conflicts_time_idx') THEN
    RAISE EXCEPTION 'M4 provider receipt indexes are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_provider_events_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_provider_conflicts_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'telegram_stars_receipts_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_fulfillment_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M4 provider evidence guards are incomplete';
  END IF;
END $$;
