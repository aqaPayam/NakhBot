DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'nakh' AND table_name = 'pending_nakhes') THEN
    RAISE EXCEPTION 'M5 pending Nakh table is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'nakh' AND indexname = 'pending_nakhes_sender_fifo_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'nakh' AND indexname = 'pending_nakhes_expiry_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'nakh' AND indexname = 'pending_nakhes_reminder_idx') THEN
    RAISE EXCEPTION 'M5 pending Nakh indexes are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pending_nakhes_lifecycle_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pending_nakh_counter_source_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pending_nakh_counter_value_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pending_nakh_payment_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pending_payment_nakh_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M5 pending Nakh guards are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pending_nakhes_pending_payment_id_fkey' AND condeferrable AND condeferred
  ) THEN
    RAISE EXCEPTION 'M5 pending Nakh payment reference is not deferred';
  END IF;
END $$;
