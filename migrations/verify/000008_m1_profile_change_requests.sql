DO $$
BEGIN
  IF to_regclass('administration.admin_users') IS NULL
    OR to_regclass('profile.profile_change_requests') IS NULL
    OR to_regclass('profile.profile_change_reviews') IS NULL THEN
    RAISE EXCEPTION 'M1 protected Profile change tables are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class index_class
    JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
    JOIN pg_index index_metadata ON index_metadata.indexrelid = index_class.oid
    WHERE namespace.nspname = 'profile'
      AND index_class.relname = 'profile_change_requests_one_pending_idx'
      AND index_metadata.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Pending protected-change uniqueness index is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'profile_change_reviews_immutable' AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'Profile change review immutability trigger is missing';
  END IF;
END
$$;
