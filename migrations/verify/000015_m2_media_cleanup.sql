DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'media' AND table_name = 'media_assets'
      AND column_name = 'cleanup_lease_owner') THEN
    RAISE EXCEPTION 'cleanup lease owner missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname = 'media' AND indexname = 'media_asset_cleanup_claim_idx') THEN
    RAISE EXCEPTION 'cleanup claim index missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname = 'media_asset_cleanup_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'cleanup lease guard missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname = 'media_variant_storage_identity_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'variant storage identity guard missing';
  END IF;
END $$;
