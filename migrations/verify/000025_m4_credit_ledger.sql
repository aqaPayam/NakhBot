DO $$
DECLARE
  package_count integer;
  package_checksum text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'billing' AND table_name = 'credit_packages'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'billing' AND table_name = 'credit_transactions'
  ) THEN
    RAISE EXCEPTION 'M4 credit ledger tables are incomplete';
  END IF;

  SELECT count(*), string_agg(code || ':' || credit_amount || ':' || stars_price || ':' || display_order, ',' ORDER BY display_order)
    INTO package_count, package_checksum
    FROM billing.credit_packages WHERE is_active;
  IF package_count <> 4 OR package_checksum <> 'starter:10:10:1,plus:25:20:2,best_value:50:35:3,ultimate:100:60:4' THEN
    RAISE EXCEPTION 'M4 active credit packages differ from the locked catalog';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'billing' AND indexname = 'credit_transactions_user_time_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'billing' AND indexname = 'credit_transactions_payment_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'billing' AND indexname = 'credit_transactions_feature_unlock_idx'
  ) THEN
    RAISE EXCEPTION 'M4 credit ledger indexes are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'credit_transactions_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'credit_account_chain_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'credit_transaction_chain_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M4 credit ledger guards are incomplete';
  END IF;
END $$;
