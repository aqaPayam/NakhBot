DO $$
DECLARE resource text;
BEGIN
  FOREACH resource IN ARRAY ARRAY['deletion_confirmations','account_deletion_records',
    'account_deletion_work','account_deletion_commands'] LOOP
    IF to_regclass('identity.'||resource) IS NULL THEN
      RAISE EXCEPTION 'deletion admission resource missing';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_records'::regclass
      AND tgname='account_deletion_admission_required' AND tgdeferrable AND tginitdeferred AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_records'::regclass
      AND tgname='account_deletion_checkpoint_guard' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.deletion_confirmations'::regclass
      AND tgname='deletion_confirmation_guard' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_commands'::regclass
      AND tgname='account_deletion_commands_immutable' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_work'::regclass
      AND tgname='account_deletion_work_delete_guard' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='identity.account_deletion_pending_user_idx'::regclass
      AND indisunique AND indisvalid AND indisready)
    OR NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='identity.deletion_confirmation_pending_user_idx'::regclass
      AND indisunique AND indisvalid AND indisready)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='identity.account_deletion_records'::regclass
      AND contype='c' AND pg_get_constraintdef(oid) LIKE '%NOT reactivation_allowed%') THEN
    RAISE EXCEPTION 'deletion admission safeguards missing';
  END IF;
END $$;
