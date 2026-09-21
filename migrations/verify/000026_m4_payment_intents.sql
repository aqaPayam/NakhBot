DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'billing' AND table_name = 'pending_payments')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'billing' AND table_name = 'payment_records') THEN
    RAISE EXCEPTION 'M4 payment intent tables are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'billing' AND indexname = 'pending_payments_open_target_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'billing' AND indexname = 'payment_records_attempt_window_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'billing' AND indexname = 'payment_records_reconciliation_idx') THEN
    RAISE EXCEPTION 'M4 payment intent indexes are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pending_payment_lifecycle_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_record_lifecycle_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M4 payment lifecycle guards are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_transactions_payment_record_fk' AND condeferrable AND condeferred
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credit_transactions_pending_payment_fk' AND condeferrable AND condeferred
  ) THEN
    RAISE EXCEPTION 'M4 ledger payment references are not deferred';
  END IF;
END $$;
