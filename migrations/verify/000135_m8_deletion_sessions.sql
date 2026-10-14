DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='identity.account_deletion_session_receipts'::regclass)
  OR to_regprocedure('identity.user_session_epoch(uuid)') IS NULL
  OR to_regprocedure('identity.deletion_session_digest(uuid)') IS NULL
  OR to_regprocedure('identity.deletion_session_audit_valid(uuid)') IS NULL
  OR to_regprocedure('identity.user_session_authority_revoked(uuid)') IS NULL
  OR to_regprocedure('identity.deletion_session_blocker(uuid,uuid)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass
    AND tgname='deletion_session_audit_guard' AND tgenabled='O')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass
    AND tgname='deletion_session_audit_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_session_receipts'::regclass
    AND tgname='deletion_session_receipt_guard' AND tgenabled='O')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_session_receipts'::regclass
    AND tgname='deletion_session_receipt_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN
  RAISE EXCEPTION 'deletion session authority schema is incomplete';
 END IF;
END $$;
