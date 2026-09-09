DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'media'
    AND table_name = 'media_assets' AND column_name = 'ingestion_lease_owner')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'media'
      AND table_name = 'media_assets' AND column_name = 'malware_scanned_at')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'media'
      AND indexname = 'media_asset_ingestion_claim_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'media.media_assets'::regclass
      AND tgname = 'media_asset_ingestion_lease_guard' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'M2 ingestion lease controls are missing';
  END IF;
END $$;
