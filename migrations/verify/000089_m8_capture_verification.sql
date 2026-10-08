DO $$ BEGIN
  IF to_regprocedure('identity.deletion_evidence_capture(uuid)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_evidence_receipts'::regclass
      AND tgname='deletion_evidence_receipt_guard' AND tgenabled='O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_evidence_receipts'::regclass
      AND tgname='deletion_evidence_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'deletion evidence verification safeguards missing';
  END IF;
END $$;
