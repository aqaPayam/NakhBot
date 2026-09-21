DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'interaction' AND table_name = 'feature_unlocks') THEN
    RAISE EXCEPTION 'M4 feature unlock table is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'interaction' AND indexname = 'feature_unlocks_like_once_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'interaction' AND indexname = 'feature_unlocks_match_once_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'interaction' AND indexname = 'feature_unlocks_payment_once_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'interaction' AND indexname = 'feature_unlocks_credit_once_idx') THEN
    RAISE EXCEPTION 'M4 feature unlock uniqueness is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'feature_unlock_lifecycle_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M4 feature unlock lifecycle guard is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_transactions_feature_unlock_fk' AND condeferrable AND condeferred
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'feature_unlocks_credit_transaction_id_fkey' AND condeferrable AND condeferred
  ) THEN
    RAISE EXCEPTION 'M4 feature unlock ledger cycle is not deferred';
  END IF;
END $$;
