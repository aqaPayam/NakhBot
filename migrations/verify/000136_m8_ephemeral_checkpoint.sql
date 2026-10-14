DO $$ BEGIN
 IF to_regclass('identity.account_deletion_ephemeral_pages') IS NULL
  OR to_regprocedure('identity.ephemeral_history_valid(uuid)') IS NULL
  OR to_regprocedure('identity.record_ephemeral_page(uuid,jsonb,boolean,integer)') IS NULL
  OR to_regprocedure('identity.finish_deletion_ephemeral_phase(uuid,uuid,uuid,integer,integer)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_ephemeral_pages'::regclass AND tgname='ephemeral_page_guard' AND tgenabled='O')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.account_deletion_ephemeral_pages'::regclass AND tgname='ephemeral_page_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='ephemeral_preparation_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='ephemeral_observation_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN
  RAISE EXCEPTION 'ephemeral checkpoint schema is incomplete';
 END IF;
END $$;
