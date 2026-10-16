DO $$ BEGIN
 IF to_regprocedure('identity.retained_user_safety_clear(uuid)') IS NULL
  OR to_regprocedure('identity.fence_retained_safety_hold()') IS NULL
  OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
    AND tgname IN('retained_report_safety_fence','retained_episode_safety_fence','retained_appeal_safety_fence'))<>3
  OR position('identity.retained_user_safety_clear(root.user_id)' IN
    pg_get_functiondef('support.content_release_valid(platform.audit_logs,boolean)'::regprocedure))=0
  OR identity.retention_catalog_valid() IS NOT TRUE
  OR identity.retained_content_release_enabled() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'M8 live retained safety hold controls incomplete'; END IF;
END $$;
