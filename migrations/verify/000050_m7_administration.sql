DO $$
DECLARE
  permission_count integer;
BEGIN
  IF to_regclass('administration.admin_roles') IS NULL
    OR to_regclass('administration.admin_permissions') IS NULL
    OR to_regclass('administration.admin_role_permissions') IS NULL
    OR to_regclass('administration.admin_user_roles') IS NULL
    OR to_regclass('administration.admin_action_logs') IS NULL THEN
    RAISE EXCEPTION 'M7 administration tables are incomplete';
  END IF;

  IF (SELECT count(*) FROM administration.admin_roles) <> 3
    OR NOT EXISTS (SELECT 1 FROM administration.admin_roles WHERE code = 'super_admin')
    OR NOT EXISTS (SELECT 1 FROM administration.admin_roles WHERE code = 'moderator')
    OR NOT EXISTS (SELECT 1 FROM administration.admin_roles WHERE code = 'support') THEN
    RAISE EXCEPTION 'M7 admin role seeds are incomplete';
  END IF;

  SELECT count(*) INTO permission_count FROM administration.admin_permissions;
  IF permission_count <> 14
    OR (SELECT count(*) FROM administration.admin_role_permissions
        WHERE role_code = 'super_admin') <> permission_count
    OR (SELECT count(*) FROM administration.admin_role_permissions
        WHERE role_code = 'moderator') <> 13
    OR (SELECT count(*) FROM administration.admin_role_permissions
        WHERE role_code = 'support') <> 2 THEN
    RAISE EXCEPTION 'M7 admin permission seeds or mappings are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1 FROM administration.admin_users admin
    LEFT JOIN identity.telegram_identities identity
      ON identity.user_id = admin.user_id
      AND identity.telegram_user_id = admin.telegram_user_id
    WHERE identity.user_id IS NULL OR (admin.is_active AND admin.identity_verified_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'M7 admin identity binding is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'administration'
      AND indexname = 'admin_action_logs_admin_time_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'administration'
      AND indexname = 'admin_action_logs_target_time_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'administration'
      AND indexname = 'admin_user_roles_active_idx'
  ) THEN
    RAISE EXCEPTION 'M7 administration indexes are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'admin_users_identity_valid' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'admin_users_update_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'admin_users_delete_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'admin_roles_seed_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'admin_permissions_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'admin_role_permissions_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'admin_user_roles_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'admin_action_logs_immutable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M7 administration guards are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'moderation' AND table_name = 'evidence_access_audits'
      AND column_name = 'permission_code'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'moderation' AND table_name = 'evidence_access_audits'
      AND column_name = 'outcome'
  ) THEN
    RAISE EXCEPTION 'M7 evidence access audit outcome fields are incomplete';
  END IF;
END $$;
