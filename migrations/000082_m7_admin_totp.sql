CREATE TABLE administration.admin_totp_credentials (
  id uuid PRIMARY KEY,
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) = 36),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9_-]{8,160}$'),
  key_version integer NOT NULL CHECK (key_version >= 1),
  activated_at timestamptz NOT NULL,
  activation_audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
  last_used_step bigint NOT NULL CHECK (last_used_step >= 0),
  revoked_at timestamptz,
  revocation_audit_id uuid UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
  UNIQUE (id, admin_user_id),
  CHECK ((revoked_at IS NULL AND revocation_audit_id IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_at >= activated_at AND revocation_audit_id IS NOT NULL))
);
CREATE UNIQUE INDEX admin_totp_one_active_idx ON administration.admin_totp_credentials(admin_user_id)
  WHERE revoked_at IS NULL;

CREATE FUNCTION administration.guard_admin_totp_credential() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MFA security history is retained' USING ERRCODE = '55000';
  END IF;
  SELECT user_id INTO owner_user_id FROM administration.admin_users WHERE id=NEW.admin_user_id;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['last_used_step','revoked_at','revocation_audit_id'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['last_used_step','revoked_at','revocation_audit_id'])
      OR OLD.revoked_at IS NOT NULL OR NEW.last_used_step < OLD.last_used_step
      OR (NEW.revoked_at IS NULL AND NEW.revocation_audit_id IS DISTINCT FROM OLD.revocation_audit_id) THEN
      RAISE EXCEPTION 'MFA credential transition is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.revoked_at IS NOT NULL OR NEW.activated_at > clock_timestamp()
      OR NEW.last_used_step NOT BETWEEN floor(extract(epoch FROM NEW.activated_at)/30)::bigint-1
        AND floor(extract(epoch FROM NEW.activated_at)/30)::bigint+1
      OR NOT EXISTS (
      SELECT 1 FROM platform.audit_logs WHERE id=NEW.activation_audit_id
      AND category='security' AND event_type='administration.totp-activated.v1'
      AND metadata_schema_version=1 AND metadata='{}'::jsonb
      AND actor_type='user' AND actor_user_id=owner_user_id
      AND subject_type='admin_totp_credential' AND subject_id=NEW.id
      AND result_code='activated' AND occurred_at=NEW.activated_at
    ) THEN
      RAISE EXCEPTION 'MFA activation requires its bound audit' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.revoked_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM platform.audit_logs WHERE id=NEW.revocation_audit_id
    AND category='security' AND event_type='administration.totp-revoked.v1'
    AND subject_type='admin_totp_credential' AND subject_id=NEW.id
    AND result_code='revoked' AND occurred_at=NEW.revoked_at
  ) THEN
    RAISE EXCEPTION 'MFA revocation requires its bound audit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_totp_credential_guard BEFORE INSERT OR UPDATE OR DELETE
  ON administration.admin_totp_credentials FOR EACH ROW
  EXECUTE FUNCTION administration.guard_admin_totp_credential();

CREATE TABLE administration.admin_totp_attempt_windows (
  admin_user_id uuid PRIMARY KEY REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 5)
);
CREATE TABLE administration.admin_totp_proofs (
  id uuid PRIMARY KEY,
  credential_id uuid NOT NULL,
  admin_user_id uuid NOT NULL,
  admin_version integer NOT NULL CHECK (admin_version >= 1),
  matched_step bigint NOT NULL CHECK (matched_step >= 0),
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at = verified_at + interval '5 minutes'),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
  UNIQUE (credential_id, matched_step),
  UNIQUE (id, credential_id, admin_user_id),
  FOREIGN KEY (credential_id, admin_user_id)
    REFERENCES administration.admin_totp_credentials(id, admin_user_id) ON DELETE RESTRICT
);
CREATE FUNCTION administration.validate_admin_totp_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM administration.admin_totp_credentials credential
    JOIN administration.admin_users admin ON admin.id=credential.admin_user_id
    JOIN platform.audit_logs audit ON audit.id=NEW.audit_id
    WHERE credential.id=NEW.credential_id AND credential.admin_user_id=NEW.admin_user_id
      AND credential.revoked_at IS NULL AND credential.last_used_step=NEW.matched_step
      AND NEW.verified_at >= credential.activated_at AND NEW.verified_at <= clock_timestamp()
      AND NEW.matched_step BETWEEN floor(extract(epoch FROM NEW.verified_at)/30)::bigint-1
        AND floor(extract(epoch FROM NEW.verified_at)/30)::bigint+1
      AND admin.version=NEW.admin_version AND admin.is_active
      AND audit.category='security' AND audit.event_type='administration.totp-verified.v1'
      AND audit.metadata_schema_version=1 AND audit.metadata='{}'::jsonb
      AND audit.actor_type='user' AND audit.actor_user_id=admin.user_id
      AND audit.subject_type='admin_totp_proof' AND audit.subject_id=NEW.id
      AND audit.result_code='verified' AND audit.occurred_at=NEW.verified_at
  ) THEN
    RAISE EXCEPTION 'MFA proof requires current credential and bound audit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_totp_proof_valid BEFORE INSERT ON administration.admin_totp_proofs
  FOR EACH ROW EXECUTE FUNCTION administration.validate_admin_totp_proof();
CREATE TRIGGER admin_totp_proof_immutable BEFORE UPDATE OR DELETE ON administration.admin_totp_proofs
  FOR EACH ROW EXECUTE FUNCTION platform.reject_audit_log_mutation();

ALTER TABLE administration.admin_sessions ADD COLUMN totp_credential_id uuid;
ALTER TABLE administration.admin_sessions ADD CONSTRAINT admin_session_totp_proof_fk
  FOREIGN KEY (mfa_proof_id, totp_credential_id, admin_user_id)
  REFERENCES administration.admin_totp_proofs(id, credential_id, admin_user_id) ON DELETE RESTRICT;
CREATE FUNCTION administration.validate_admin_session_totp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.totp_credential_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM administration.admin_totp_proofs proof
    JOIN administration.admin_totp_credentials credential ON credential.id=proof.credential_id
    WHERE proof.id=NEW.mfa_proof_id AND proof.credential_id=NEW.totp_credential_id
      AND proof.admin_user_id=NEW.admin_user_id AND proof.admin_version=NEW.admin_version
      AND proof.verified_at=NEW.mfa_verified_at AND proof.expires_at=NEW.mfa_expires_at
      AND credential.last_used_step=proof.matched_step
      AND credential.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'MFA session proof is unavailable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_session_totp_valid BEFORE INSERT ON administration.admin_sessions
  FOR EACH ROW EXECUTE FUNCTION administration.validate_admin_session_totp();
