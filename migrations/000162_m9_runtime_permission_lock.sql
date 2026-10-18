-- Runtime administrators read RBAC seeds but cannot mutate them. PostgreSQL
-- row-lock clauses require UPDATE rights even for FOR SHARE. Preserve the
-- existing three-table authorization lock through this bounded capability.
CREATE FUNCTION administration.lock_runtime_admin_permission(subject uuid, required_permission text)
RETURNS TABLE(permission_code text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  SELECT role_permission.permission_code
  FROM administration.admin_user_roles AS assignment
  JOIN administration.admin_roles AS role ON role.code=assignment.role_code
  JOIN administration.admin_role_permissions AS role_permission ON role_permission.role_code=role.code
  WHERE assignment.admin_user_id=$1 AND assignment.revoked_at IS NULL
    AND role.is_active AND role_permission.permission_code=$2
  FOR SHARE OF assignment,role,role_permission
$$;
REVOKE ALL ON FUNCTION administration.lock_runtime_admin_permission(uuid,text) FROM PUBLIC;

-- Public submission locks one active approved reason; it never edits the seed.
CREATE FUNCTION moderation.lock_runtime_report_reason(reason_code text)
RETURNS TABLE(id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  SELECT reason.id FROM moderation.report_reasons AS reason
  WHERE reason.code=$1 AND reason.is_active FOR SHARE OF reason
$$;
REVOKE ALL ON FUNCTION moderation.lock_runtime_report_reason(text) FROM PUBLIC;
