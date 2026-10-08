DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_phase_receipts'::regclass
    AND tgname='account_deletion_phase_receipt_guard' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_phase_receipts'::regclass
      AND tgname='account_deletion_phase_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
    OR to_regprocedure('identity.deletion_has_open_shared_scopes(uuid)') IS NULL
    OR to_regprocedure('identity.finish_deletion_shared_phase(uuid,uuid,uuid,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'verified deletion shared checkpoint safeguards missing';
  END IF;
END $$;
