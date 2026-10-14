DO $$ BEGIN
 IF to_regclass('identity.data_retention_records') IS NULL
  OR to_regprocedure('identity.record_retention_batch(uuid,uuid,uuid,integer)') IS NULL
  OR to_regprocedure('identity.finish_deletion_retention_phase(uuid,uuid,uuid,integer,integer)') IS NULL
  OR identity.retention_catalog_valid() IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.data_retention_records'::regclass AND tgname='retention_record_guard' AND tgenabled='O')
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.data_retention_records'::regclass AND tgname='retention_record_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='retention_audit_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN
  RAISE EXCEPTION 'retention manifest schema is incomplete';
 END IF;
END $$;
