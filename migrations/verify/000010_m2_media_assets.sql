DO $$
BEGIN
  IF to_regclass('media.media_assets') IS NULL
    OR to_regclass('media.media_assets_owner_attempt_idx') IS NULL
    OR to_regclass('media.media_assets_active_hash_unique') IS NULL THEN
    RAISE EXCEPTION 'M2 media assets or critical indexes are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'media.media_assets'::regclass
    AND tgname = 'media_asset_identity_and_state' AND tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'media.media_assets'::regclass
      AND conname = 'media_asset_valid_facts' AND convalidated) THEN
    RAISE EXCEPTION 'M2 asset identity/state or validation facts protection is missing';
  END IF;
END $$;
