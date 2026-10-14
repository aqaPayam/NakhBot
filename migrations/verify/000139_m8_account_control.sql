DO $$ BEGIN
 IF to_regprocedure('identity.account_control_epoch(uuid)') IS NULL
  OR to_regprocedure('identity.account_control_authority_revoked(uuid)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='account_control_admission' AND tgenabled='O')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='account_control_commit' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
  OR to_regprocedure('identity.account_control_current(uuid,uuid,integer)') IS NULL
  OR to_regprocedure('identity.require_account_control_effect()') IS NULL
  OR (SELECT count(*) FROM pg_trigger WHERE tgname IN('account_control_account_effect','account_control_confirmation_effect','account_control_command_effect') AND tgenabled='O' AND tgdeferrable AND tginitdeferred)<>3
  OR identity.retention_catalog_valid() IS NOT TRUE THEN RAISE EXCEPTION 'account control authority unavailable'; END IF;
END $$;
