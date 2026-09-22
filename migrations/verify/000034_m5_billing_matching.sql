DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nakhes_credit_transaction_fk' AND condeferrable AND condeferred
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nakhes_payment_record_fk' AND condeferrable AND condeferred
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_transactions_nakh_fk' AND condeferrable AND condeferred
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'matches_source_nakh_fk' AND condeferrable AND condeferred
  ) THEN
    RAISE EXCEPTION 'M5 funding or matching foreign keys are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'nakh' AND indexname = 'nakhes_funding_reconciliation_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'nakh' AND indexname = 'pending_nakhes_settlement_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'matching' AND indexname = 'matches_source_nakh_idx') THEN
    RAISE EXCEPTION 'M5 billing/matching indexes are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nakhes_funding_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'credit_transactions_nakh_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_records_nakh_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nakhes_match_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'matches_nakh_source_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M5 funding or matching guards are incomplete';
  END IF;
END $$;
