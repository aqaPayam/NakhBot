DO $$ BEGIN
 IF to_regprocedure('identity.return_account(uuid,integer,uuid,uuid,uuid,text,text,integer)') IS NULL
  OR to_regclass('platform.account_return_root_idx') IS NULL OR to_regclass('platform.account_return_command_idx') IS NULL
  OR to_regclass('platform.account_return_idempotency_idx') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='account_return_account_commit' AND tgrelid='identity.accounts'::regclass AND tgdeferrable AND tginitdeferred AND tgenabled='O')
  OR identity.retention_catalog_valid() IS NOT TRUE
  OR platform.deletion_event_policy()->'shapes'->'account.returned.v1' IS DISTINCT FROM '{"required":"userId accountVersion"}'::jsonb THEN
  RAISE EXCEPTION 'fresh account Return safeguards incomplete'; END IF;
END $$;
