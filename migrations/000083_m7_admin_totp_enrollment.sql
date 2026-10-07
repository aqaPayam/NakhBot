CREATE TABLE administration.admin_totp_operator_commands (
  request_id uuid PRIMARY KEY,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  operator_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('approve','revoke')),
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  subject_id uuid NOT NULL,
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL
);
CREATE FUNCTION administration.validate_totp_operator_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform.audit_logs audit WHERE audit.id=NEW.audit_id
      AND audit.category='security' AND audit.actor_type='system'
      AND audit.event_type=CASE NEW.operation WHEN 'approve' THEN 'administration.totp-enrollment-approved.v1'
        ELSE 'administration.totp-revoked.v1' END
      AND audit.subject_type=CASE NEW.operation WHEN 'approve' THEN 'admin_totp_enrollment'
        ELSE 'admin_totp_credential' END
      AND audit.subject_id=NEW.subject_id AND audit.request_id=NEW.request_id
      AND audit.command_id=NEW.request_id AND audit.occurred_at=NEW.created_at
      AND audit.result_code=CASE NEW.operation WHEN 'approve' THEN 'approved' ELSE 'revoked' END
      AND audit.metadata_schema_version=1
      AND audit.metadata->>'operatorId'=NEW.operator_id::text
      AND audit.metadata->>'requestDigest'=NEW.request_digest
      AND audit.metadata->>'reasonCode' IN ('bootstrap','enrollment','recovery')
  ) THEN
    RAISE EXCEPTION 'MFA operator command requires its bound audit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_totp_operator_valid BEFORE INSERT ON administration.admin_totp_operator_commands
  FOR EACH ROW EXECUTE FUNCTION administration.validate_totp_operator_command();
CREATE TRIGGER admin_totp_operator_immutable BEFORE UPDATE OR DELETE ON administration.admin_totp_operator_commands
  FOR EACH ROW EXECUTE FUNCTION platform.reject_audit_log_mutation();

CREATE TABLE administration.admin_totp_enrollments (
  id uuid PRIMARY KEY,
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  admin_version integer NOT NULL CHECK (admin_version >= 1),
  operator_request_id uuid NOT NULL UNIQUE REFERENCES administration.admin_totp_operator_commands(request_id) ON DELETE RESTRICT,
  invitation_hash text NOT NULL UNIQUE CHECK (invitation_hash ~ '^[0-9a-f]{64}$'),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext)=36),
  nonce bytea NOT NULL CHECK (octet_length(nonce)=12),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{8,160}$'),
  key_version integer NOT NULL CHECK (key_version >= 1),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at=approved_at+interval '10 minutes'),
  completed_at timestamptz,
  completion_audit_id uuid UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancellation_audit_id uuid UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
  CHECK ((completed_at IS NULL AND completion_audit_id IS NULL)
    OR (completed_at IS NOT NULL AND completion_audit_id IS NOT NULL AND completed_at>=approved_at AND completed_at<expires_at)),
  CHECK ((cancelled_at IS NULL AND cancellation_audit_id IS NULL)
    OR (cancelled_at IS NOT NULL AND cancellation_audit_id IS NOT NULL AND cancelled_at>=approved_at)),
  CHECK (completed_at IS NULL OR cancelled_at IS NULL)
);
CREATE UNIQUE INDEX admin_totp_one_pending_idx ON administration.admin_totp_enrollments(admin_user_id)
  WHERE completed_at IS NULL AND cancelled_at IS NULL;

CREATE FUNCTION administration.guard_admin_totp_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'MFA enrollment history is retained' USING ERRCODE = '55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.completed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM administration.admin_totp_operator_commands command
      JOIN administration.admin_users admin ON admin.id=command.admin_user_id
      WHERE command.request_id=NEW.operator_request_id AND command.operation='approve'
        AND command.subject_id=NEW.id AND command.admin_user_id=NEW.admin_user_id
        AND command.created_at=NEW.approved_at AND admin.is_active AND admin.version=NEW.admin_version
        AND NEW.approved_at<=clock_timestamp()
    ) THEN
      RAISE EXCEPTION 'MFA enrollment requires its bound operator approval' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF OLD.completed_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL
      OR (to_jsonb(NEW)-ARRAY['completed_at','completion_audit_id','cancelled_at','cancellation_audit_id'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['completed_at','completion_audit_id','cancelled_at','cancellation_audit_id'])
      OR (NEW.completed_at IS NULL AND NEW.cancelled_at IS NULL) THEN
      RAISE EXCEPTION 'MFA enrollment transition is invalid' USING ERRCODE = '23514';
    END IF;
    IF NEW.completed_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM administration.admin_totp_credentials credential
      JOIN administration.admin_users admin ON admin.id=credential.admin_user_id
      WHERE credential.id=NEW.id AND credential.admin_user_id=NEW.admin_user_id
        AND credential.activation_audit_id=NEW.completion_audit_id AND credential.activated_at=NEW.completed_at
        AND credential.ciphertext=NEW.ciphertext AND credential.nonce=NEW.nonce
        AND credential.key_id=NEW.key_id AND credential.key_version=NEW.key_version
        AND admin.is_active AND admin.version=NEW.admin_version
    ) THEN
      RAISE EXCEPTION 'MFA enrollment completion requires its activated credential' USING ERRCODE = '23514';
    END IF;
    IF NEW.cancelled_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM platform.audit_logs audit WHERE audit.id=NEW.cancellation_audit_id
        AND audit.category='security' AND audit.actor_type='system'
        AND audit.event_type='administration.totp-enrollment-cancelled.v1'
        AND audit.subject_type='admin_totp_enrollment' AND audit.subject_id=NEW.id
        AND audit.result_code='cancelled' AND audit.occurred_at=NEW.cancelled_at
    ) THEN
      RAISE EXCEPTION 'MFA enrollment cancellation requires its bound audit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_totp_enrollment_guard BEFORE INSERT OR UPDATE OR DELETE ON administration.admin_totp_enrollments
  FOR EACH ROW EXECUTE FUNCTION administration.guard_admin_totp_enrollment();
