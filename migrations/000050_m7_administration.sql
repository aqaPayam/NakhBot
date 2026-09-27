ALTER TABLE administration.admin_users
  ALTER COLUMN is_active SET DEFAULT false,
  ALTER COLUMN disabled_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN created_at SET DEFAULT transaction_timestamp(),
  ALTER COLUMN updated_at SET DEFAULT transaction_timestamp(),
  ADD COLUMN identity_verified_at timestamptz,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM administration.admin_users admin
    LEFT JOIN identity.telegram_identities identity
      ON identity.user_id = admin.user_id
      AND identity.telegram_user_id = admin.telegram_user_id
    WHERE identity.user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'existing admin identity does not match an authenticated Telegram identity';
  END IF;
END $$;

UPDATE administration.admin_users
SET identity_verified_at = updated_at;

ALTER TABLE administration.admin_users
  ADD CONSTRAINT admin_user_verified_state_ck CHECK (
    NOT is_active OR identity_verified_at IS NOT NULL
  );

CREATE INDEX admin_users_active_idx
  ON administration.admin_users (id) WHERE is_active;

CREATE FUNCTION administration.validate_admin_user_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity.telegram_identities identity
    WHERE identity.user_id = NEW.user_id
      AND identity.telegram_user_id = NEW.telegram_user_id
  ) THEN
    RAISE EXCEPTION 'admin identity must match an authenticated Telegram identity'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER admin_users_identity_valid
BEFORE INSERT OR UPDATE OF user_id, telegram_user_id ON administration.admin_users
FOR EACH ROW EXECUTE FUNCTION administration.validate_admin_user_identity();

CREATE FUNCTION administration.guard_admin_user_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id
    OR NEW.telegram_user_id <> OLD.telegram_user_id
    OR NEW.identity_verified_at IS DISTINCT FROM OLD.identity_verified_at
    OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1
    OR NEW.updated_at <= OLD.updated_at
    OR (NEW.is_active AND NEW.disabled_at IS NOT NULL)
    OR (NOT NEW.is_active AND NEW.disabled_at IS NULL)
    OR (NEW.is_active = OLD.is_active) THEN
    RAISE EXCEPTION 'admin user transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER admin_users_update_guard
BEFORE UPDATE ON administration.admin_users
FOR EACH ROW EXECUTE FUNCTION administration.guard_admin_user_update();

CREATE FUNCTION administration.reject_admin_user_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin users are retained workforce identity' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER admin_users_delete_guard
BEFORE DELETE ON administration.admin_users
FOR EACH ROW EXECUTE FUNCTION administration.reject_admin_user_delete();

CREATE TABLE administration.admin_roles (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE administration.admin_permissions (
  code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{0,79}$'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp()
);

CREATE TABLE administration.admin_role_permissions (
  role_code text NOT NULL REFERENCES administration.admin_roles(code) ON DELETE RESTRICT,
  permission_code text NOT NULL REFERENCES administration.admin_permissions(code) ON DELETE RESTRICT,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE administration.admin_user_roles (
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  role_code text NOT NULL REFERENCES administration.admin_roles(code) ON DELETE RESTRICT,
  assigned_by_admin_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  revoked_by_admin_id uuid REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  PRIMARY KEY (admin_user_id, role_code),
  CONSTRAINT admin_user_role_revocation_ck CHECK (
    (revoked_by_admin_id IS NULL AND revoked_at IS NULL)
    OR (revoked_by_admin_id IS NOT NULL AND revoked_at IS NOT NULL AND revoked_at >= assigned_at)
  )
);

CREATE INDEX admin_user_roles_active_idx
  ON administration.admin_user_roles (admin_user_id, role_code) WHERE revoked_at IS NULL;

CREATE TABLE administration.admin_action_logs (
  id uuid PRIMARY KEY,
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  command_code text NOT NULL CHECK (command_code ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  target_type text NOT NULL CHECK (target_type ~ '^[a-z][a-z0-9_]{0,79}$'),
  target_id uuid NOT NULL,
  expected_target_version integer CHECK (expected_target_version IS NULL OR expected_target_version >= 1),
  result text NOT NULL CHECK (result IN ('succeeded','rejected','failed')),
  safe_code text NOT NULL CHECK (safe_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  reason_digest text NOT NULL CHECK (reason_digest ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096
  ),
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (admin_user_id, command_id)
);

CREATE INDEX admin_action_logs_admin_time_idx
  ON administration.admin_action_logs (admin_user_id, created_at DESC, id DESC);
CREATE INDEX admin_action_logs_target_time_idx
  ON administration.admin_action_logs (target_type, target_id, created_at DESC, id DESC);

CREATE FUNCTION administration.guard_seed_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin role seed identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.code <> OLD.code OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'admin role seed identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER admin_roles_seed_guard
BEFORE UPDATE OR DELETE ON administration.admin_roles
FOR EACH ROW EXECUTE FUNCTION administration.guard_seed_role();

CREATE FUNCTION administration.reject_rbac_seed_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin RBAC seed mapping is immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER admin_permissions_immutable
BEFORE UPDATE OR DELETE ON administration.admin_permissions
FOR EACH ROW EXECUTE FUNCTION administration.reject_rbac_seed_mutation();
CREATE TRIGGER admin_role_permissions_immutable
BEFORE UPDATE OR DELETE ON administration.admin_role_permissions
FOR EACH ROW EXECUTE FUNCTION administration.reject_rbac_seed_mutation();

CREATE FUNCTION administration.guard_admin_user_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin role assignment transition is invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.admin_user_id <> OLD.admin_user_id
    OR NEW.role_code <> OLD.role_code OR NEW.assigned_by_admin_id <> OLD.assigned_by_admin_id
    OR NEW.assigned_at <> OLD.assigned_at OR OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL OR NEW.revoked_by_admin_id IS NULL THEN
    RAISE EXCEPTION 'admin role assignment transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER admin_user_roles_guard
BEFORE UPDATE OR DELETE ON administration.admin_user_roles
FOR EACH ROW EXECUTE FUNCTION administration.guard_admin_user_role();

CREATE FUNCTION administration.reject_admin_action_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin action logs are append-only' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER admin_action_logs_immutable
BEFORE UPDATE OR DELETE ON administration.admin_action_logs
FOR EACH ROW EXECUTE FUNCTION administration.reject_admin_action_log_mutation();

INSERT INTO administration.admin_roles (code, description) VALUES
  ('super_admin', 'Explicit full administrative permission set.'),
  ('moderator', 'Safety review and moderation operations.'),
  ('support', 'Least-privilege user support operations.');

INSERT INTO administration.admin_permissions (code, description) VALUES
  ('view_reports', 'View report metadata and authorized evidence.'),
  ('view_user_profile', 'View the minimum user profile required for an assigned task.'),
  ('restrict_user', 'Restrict an eligible user account.'),
  ('unrestrict_user', 'Resolve a restriction and restore an eligible account.'),
  ('ban_user', 'Ban an eligible user account.'),
  ('unban_user', 'Unban an eligible user account.'),
  ('hide_photo', 'Hide a profile photo from delivery.'),
  ('restore_photo', 'Restore an eligible hidden profile photo.'),
  ('delete_photo', 'Delete a profile photo through the media lifecycle.'),
  ('dismiss_report', 'Dismiss an assigned report review.'),
  ('manage_internal_blocks', 'Create or remove silent internal pair blocks.'),
  ('review_change_requests', 'Review protected profile change requests.'),
  ('review_support', 'Review and reply to support threads.'),
  ('review_appeals', 'Review one-per-ban user appeals.');

INSERT INTO administration.admin_role_permissions (role_code, permission_code)
SELECT 'super_admin', code FROM administration.admin_permissions;

INSERT INTO administration.admin_role_permissions (role_code, permission_code)
SELECT 'moderator', code FROM administration.admin_permissions
WHERE code <> 'review_support';

INSERT INTO administration.admin_role_permissions (role_code, permission_code) VALUES
  ('support', 'view_user_profile'),
  ('support', 'review_support');

ALTER TABLE moderation.evidence_access_audits
  ADD COLUMN permission_code text NOT NULL DEFAULT 'view_reports'
    REFERENCES administration.admin_permissions(code) ON DELETE RESTRICT,
  ADD COLUMN outcome text NOT NULL DEFAULT 'revealed' CHECK (outcome IN ('revealed','rejected')),
  ADD COLUMN safe_code text NOT NULL DEFAULT 'evidence_revealed'
    CHECK (safe_code ~ '^[a-z][a-z0-9_]{0,79}$');

COMMENT ON TABLE administration.admin_users IS
  'Verified Telegram-backed workforce identities; migrations never seed an enabled operator.';
COMMENT ON TABLE administration.admin_action_logs IS
  'Append-only sanitized outcome for every attempted state-changing admin command.';
COMMENT ON TABLE administration.admin_role_permissions IS
  'Code-owned explicit permissions; role names never authorize commands by themselves.';
