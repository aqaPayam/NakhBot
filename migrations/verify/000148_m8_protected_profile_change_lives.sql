DO $$ BEGIN
 IF to_regprocedure('profile.change_is_current(uuid,uuid)') IS NULL
  OR to_regprocedure('profile.bind_change_life(uuid,boolean)') IS NULL
  OR to_regprocedure('profile.close_change(uuid,uuid)') IS NULL
  OR to_regclass('platform.profile_change_life_bound_idx') IS NULL
  OR to_regclass('platform.profile_change_closed_idx') IS NULL
  OR to_regclass('platform.profile_change_life_command_idx') IS NULL
  OR to_regclass('platform.profile_change_command_idx') IS NULL
  OR to_regclass('platform.profile_change_requested_subject_idx') IS NULL
  OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgdeferrable AND tginitdeferred
    AND tgname IN('profile_change_life_commit','profile_change_close_commit','profile_change_admission_commit',
      'profile_change_deletion_commit','profile_change_review_commit','profile_change_resolution_commit'))<>6
  OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
    AND tgname IN('profile_change_life_guard','profile_change_close_guard','profile_change_requested_life',
      'profile_change_request_guard','profile_change_review_life_guard'))<>5
  OR identity.retention_catalog_valid() IS NOT TRUE
  OR identity.retained_content_release_enabled() IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'M8 protected profile change life controls incomplete'; END IF;
END $$;
