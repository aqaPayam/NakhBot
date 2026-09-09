DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'media' AND table_name = 'media_assets' AND column_name = 'quarantine_sha256')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'media.media_assets'::regclass
      AND tgname = 'media_asset_quarantine_completion' AND tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'media.media_assets'::regclass
      AND conname = 'quarantine_facts_complete' AND convalidated) THEN
    RAISE EXCEPTION 'M2 quarantine completion facts are missing';
  END IF;
END $$;
