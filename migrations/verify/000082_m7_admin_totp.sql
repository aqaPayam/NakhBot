DO $$ BEGIN
  IF to_regclass('administration.admin_totp_credentials') IS NULL
    OR to_regclass('administration.admin_totp_one_active_idx') IS NULL
    OR to_regclass('administration.admin_totp_attempt_windows') IS NULL
    OR to_regclass('administration.admin_totp_proofs') IS NULL
    OR (SELECT count(*) FROM pg_constraint WHERE conrelid='administration.admin_totp_credentials'::regclass
      AND contype='c' AND convalidated) <> 6
    OR (SELECT count(*) FROM pg_constraint WHERE conrelid='administration.admin_totp_proofs'::regclass
      AND contype='c' AND convalidated) <> 3
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='administration.admin_sessions'::regclass
      AND conname='admin_session_totp_proof_fk' AND contype='f' AND convalidated)
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND (tgrelid='administration.admin_totp_credentials'::regclass AND tgname='admin_totp_credential_guard'
        OR tgrelid='administration.admin_totp_proofs'::regclass AND tgname IN ('admin_totp_proof_valid','admin_totp_proof_immutable')
        OR tgrelid='administration.admin_sessions'::regclass AND tgname='admin_session_totp_valid')) <> 4 THEN
    RAISE EXCEPTION 'M7 authenticator schema unavailable';
  END IF;
END $$;
