DO $$ BEGIN
  IF to_regclass('administration.admin_sessions') IS NULL
    OR to_regclass('administration.admin_sessions_one_current_idx') IS NULL
    OR to_regclass('administration.admin_sessions_token_hash_key') IS NULL
    OR to_regclass('administration.admin_sessions_mfa_proof_id_key') IS NULL
    OR (SELECT count(*) FROM pg_constraint WHERE conrelid='administration.admin_sessions'::regclass
      AND contype='c' AND convalidated) <> 5
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='administration.admin_sessions'::regclass
      AND tgname='admin_sessions_guard' AND NOT tgisinternal AND tgenabled='O') THEN
    RAISE EXCEPTION 'M7 admin session schema unavailable';
  END IF;
END $$;
