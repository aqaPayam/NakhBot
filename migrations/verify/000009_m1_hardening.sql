DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts
    WHERE locale_code = 'en'
      AND text_key = 'error.guest_preview.limit_reached'
      AND is_active
  ) OR NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts
    WHERE locale_code = 'en'
      AND text_key = 'error.rate_limit.exceeded'
      AND is_active
  ) THEN
    RAISE EXCEPTION 'M1 hardening localization is missing';
  END IF;
END
$$;
