DO $$
BEGIN
  IF to_regclass('media.profile_photos') IS NULL OR to_regclass('media.photo_variants') IS NULL
    OR to_regclass('media.photo_moderation_records') IS NULL
    OR to_regclass('media.profile_photos_primary_unique') IS NULL
    OR to_regclass('media.profile_photos_order_unique') IS NULL THEN
    RAISE EXCEPTION 'M2 photo relations or uniqueness indexes are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'media.profile_photos'::regclass
    AND tgname = 'profile_photo_assignment' AND tgenabled = 'O')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'media.photo_moderation_records'::regclass
      AND tgname = 'photo_moderation_append_only' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'M2 photo assignment/history protection is missing';
  END IF;
END $$;
