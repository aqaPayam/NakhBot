DO $$ BEGIN
 IF identity.retained_content_release_enabled() IS DISTINCT FROM false
  OR to_regprocedure('support.release_content(uuid,uuid,uuid,integer)') IS NULL
  OR to_regprocedure('support.content_released(uuid)') IS NULL
  OR to_regclass('platform.support_content_release_source_idx') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='support_content_release_commit'
   AND tgrelid='platform.audit_logs'::regclass AND tgdeferrable AND tginitdeferred AND tgenabled='O')
  OR identity.retention_catalog_valid() IS NOT TRUE THEN
  RAISE EXCEPTION 'M8 disabled support release controls incomplete'; END IF;
END $$;
