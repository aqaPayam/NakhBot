DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'media.media_assets'::regclass
    AND tgname = 'report_photo_asset_retained' AND NOT tgisinternal AND tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'media.photo_variants'::regclass
    AND tgname = 'report_photo_variant_retained' AND NOT tgisinternal AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'retained report photo objects require physical cleanup guards';
  END IF;
END $$;
