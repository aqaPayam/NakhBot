DO $$ BEGIN
  IF to_regclass('media.delivery_grants') IS NULL
    OR to_regprocedure('media.delivery_grant_source_is_current(media.delivery_grants)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='media.delivery_grants'::regclass
      AND tgname='delivery_grant_authority_guard' AND NOT tgisinternal)
    OR to_regclass('media.delivery_grants_actor_expiry_idx') IS NULL
    OR to_regclass('media.delivery_grants_owner_expiry_idx') IS NULL THEN
    RAISE EXCEPTION 'M8 media source authority schema is incomplete';
  END IF;
END $$;
