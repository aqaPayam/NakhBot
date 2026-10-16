DO $$ BEGIN
 IF to_regprocedure('media.delivery_grant_legacy_source_is_current(media.delivery_grants)') IS NULL
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='media.delivery_grants'::regclass
    AND attname='candidate_delivery_id' AND NOT attisdropped)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='media.delivery_grants'::regclass
    AND attname='session_grant_id' AND NOT attisdropped)
  OR identity.retention_catalog_valid() IS NOT TRUE THEN
  RAISE EXCEPTION 'candidate media authority schema is incomplete'; END IF;
END $$;
