DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='identity.account_deletion_work'::regclass
    AND attname='lease_generation' AND attnotnull AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_work'::regclass
      AND tgname='account_deletion_work_lease_guard' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_work'::regclass
      AND tgname='account_deletion_work_checkpoint_required' AND tgdeferrable AND tginitdeferred AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_records'::regclass
      AND tgname='account_deletion_record_work_required' AND tgdeferrable AND tginitdeferred AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='identity.account_deletion_work'::regclass
      AND conname='account_deletion_work_safe_error' AND convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='identity.account_deletion_records'::regclass
      AND conname='account_deletion_record_safe_error' AND convalidated) THEN
    RAISE EXCEPTION 'deletion work lease safeguards missing';
  END IF;
END $$;
