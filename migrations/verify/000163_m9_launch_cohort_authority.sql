DO $$ BEGIN
 IF to_regprocedure('platform.launch_policy_version(uuid)') IS NULL
 OR to_regprocedure('platform.launch_member_epoch(uuid)') IS NULL
 OR to_regclass('platform.launch_policy_version_idx') IS NULL
 OR to_regclass('platform.launch_member_policy_user_idx') IS NULL
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='launch_authority_owner' AND tgenabled='O')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='launch_manifest_complete' AND tgdeferrable AND tginitdeferred AND tgenabled='O')
 OR EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='platform.launch-policy-applied.v1' AND platform.launch_policy_version(id) IS NULL)
 OR EXISTS(SELECT 1 FROM platform.audit_logs WHERE event_type='platform.launch-cohort-granted.v1' AND platform.launch_member_epoch(id) IS NULL)
 THEN RAISE EXCEPTION 'Launch authority verification failed' USING ERRCODE='55000'; END IF;
END $$;
