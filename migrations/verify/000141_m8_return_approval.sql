DO $$ BEGIN
 IF to_regprocedure('identity.account_return_reviewable(uuid)') IS NULL
  OR to_regprocedure('identity.account_return_approval_valid(platform.audit_logs,boolean)') IS NULL
  OR to_regclass('platform.account_return_approval_root_idx') IS NULL
  OR NOT EXISTS(SELECT 1 FROM administration.admin_role_permissions WHERE role_code='super_admin' AND permission_code='approve_account_return')
  OR EXISTS(SELECT 1 FROM administration.admin_role_permissions WHERE role_code<>'super_admin' AND permission_code='approve_account_return')
  OR identity.retention_catalog_valid() IS NOT TRUE THEN RAISE EXCEPTION 'M8 return approval inventory incomplete'; END IF;
END $$;
