DO $$ BEGIN
 IF to_regprocedure('identity.finish_deletion_verification_phase(uuid,uuid,uuid,integer,integer)') IS NULL
  OR to_regprocedure('identity.deletion_verification_blocker(uuid,uuid)') IS NULL
  OR to_regprocedure('identity.ephemeral_verification_restart(platform.audit_logs,identity.account_deletion_ephemeral_pages)') IS NULL
  OR identity.retention_catalog_valid() IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='identity.account_deletion_phase_receipts'::regclass
    AND conname='deletion_phase_receipt_transition_check' AND pg_get_constraintdef(oid) LIKE '%verification%completed%8%') THEN
  RAISE EXCEPTION 'final verification schema is incomplete';
 END IF;
END $$;
