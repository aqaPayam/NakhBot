DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='identity' AND table_name='account_deletion_records'
      AND column_name='product_epoch' AND data_type='integer' AND is_nullable='NO')
    OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid='identity.account_deletion_product_life_idx'::regclass AND indisunique AND indisvalid)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_records'::regclass AND tgname='account_deletion_epoch_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_records'::regclass AND tgname='account_deletion_lifecycle_commit_guard'
      AND tgdeferrable AND tginitdeferred AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.accounts'::regclass AND tgname='accounts_pending_deletion_commit_guard'
      AND tgdeferrable AND tginitdeferred AND tgenabled='O') THEN
    RAISE EXCEPTION 'M8 original deletion lifecycle binding is incomplete';
  END IF;
END $$;
