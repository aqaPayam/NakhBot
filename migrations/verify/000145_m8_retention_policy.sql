DO $$ BEGIN
 IF to_regprocedure('identity.retention_policy_proof_valid(platform.audit_logs,boolean)') IS NULL
  OR to_regclass('platform.retention_policy_version_idx') IS NULL OR to_regclass('platform.retention_policy_revocation_idx') IS NULL
  OR NOT EXISTS(SELECT 1 FROM administration.admin_role_permissions WHERE role_code='super_admin' AND permission_code='approve_retention_policy')
  OR EXISTS(SELECT 1 FROM administration.admin_role_permissions WHERE role_code<>'super_admin' AND permission_code='approve_retention_policy')
  OR identity.retention_catalog_valid() IS NOT TRUE THEN RAISE EXCEPTION 'M8 retention policy controls incomplete'; END IF;
END $$;
