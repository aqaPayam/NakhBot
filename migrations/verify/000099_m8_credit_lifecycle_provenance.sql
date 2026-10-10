DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='billing' AND table_name='credit_accounts' AND column_name='product_epoch' AND is_nullable='NO')
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='billing' AND table_name='credit_transactions' AND column_name='product_epoch' AND is_nullable='NO')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_accounts'::regclass AND tgname='credit_projection_lifecycle_guard' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_transactions'::regclass AND tgname='credit_lifecycle_guard' AND NOT tgisinternal)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_transactions'::regclass AND tgname='credit_lifecycle_commit_guard' AND tgdeferrable AND tginitdeferred AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M8 credit lifecycle provenance is incomplete';
  END IF;
END $$;
