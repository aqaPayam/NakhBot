DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM catalog.ui_texts WHERE locale_code = 'en' AND text_key = 'error.profile.media_not_eligible' AND is_active)
    OR NOT EXISTS (SELECT 1 FROM catalog.ui_texts WHERE locale_code = 'en' AND text_key = 'error.profile.version_conflict' AND is_active) THEN
    RAISE EXCEPTION 'M1 Profile confirmation localization is incomplete';
  END IF;
END
$$;
