CREATE TABLE administration.admin_sessions (
  id uuid PRIMARY KEY,
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  admin_version integer NOT NULL CHECK (admin_version >= 1),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  mfa_proof_id uuid NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  mfa_verified_at timestamptz NOT NULL,
  mfa_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
  CHECK (mfa_verified_at <= issued_at AND mfa_expires_at > issued_at
    AND mfa_expires_at <= mfa_verified_at + interval '5 minutes'
    AND mfa_expires_at <= expires_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE UNIQUE INDEX admin_sessions_one_current_idx ON administration.admin_sessions(admin_user_id)
  WHERE revoked_at IS NULL;
CREATE FUNCTION administration.guard_admin_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin sessions retain security history' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'admin session transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_sessions_guard BEFORE UPDATE OR DELETE ON administration.admin_sessions
  FOR EACH ROW EXECUTE FUNCTION administration.guard_admin_session();
