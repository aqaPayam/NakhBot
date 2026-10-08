DO $$ BEGIN
  IF to_regprocedure('identity.deletion_evidence_blocker(uuid,uuid)') IS NULL
    OR to_regprocedure('identity.finish_deletion_evidence_phase(uuid,uuid,uuid,integer,integer)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_constraint
      WHERE conrelid='identity.account_deletion_phase_receipts'::regclass
        AND conname='deletion_phase_receipt_transition_check' AND convalidated)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger
      WHERE tgrelid='identity.account_deletion_phase_receipts'::regclass
        AND tgname='account_deletion_phase_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'verified deletion evidence checkpoint safeguards missing';
  END IF;
END $$;
