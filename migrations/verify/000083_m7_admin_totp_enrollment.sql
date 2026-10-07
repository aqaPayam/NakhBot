DO $$ BEGIN
  IF to_regclass('administration.admin_totp_operator_commands') IS NULL
    OR to_regclass('administration.admin_totp_enrollments') IS NULL
    OR to_regclass('administration.admin_totp_one_pending_idx') IS NULL
    OR (SELECT count(*) FROM pg_constraint WHERE conrelid='administration.admin_totp_enrollments'::regclass
      AND contype='c' AND convalidated) <> 10
    OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND (tgrelid='administration.admin_totp_enrollments'::regclass AND tgname='admin_totp_enrollment_guard'
        OR tgrelid='administration.admin_totp_operator_commands'::regclass AND tgname IN ('admin_totp_operator_valid','admin_totp_operator_immutable'))) <> 3 THEN
    RAISE EXCEPTION 'M7 approved authenticator enrollment schema unavailable';
  END IF;
END $$;
