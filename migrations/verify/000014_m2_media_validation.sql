DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'media' AND table_name = 'media_assets'
      AND column_name = 'validation_lease_owner') THEN
    RAISE EXCEPTION 'validation lease owner missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname = 'media' AND indexname = 'media_asset_validation_claim_idx') THEN
    RAISE EXCEPTION 'validation claim index missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname = 'media_asset_validation_lease_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'validation lease guard missing';
  END IF;
END $$;
