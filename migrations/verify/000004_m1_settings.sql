DO $$
DECLARE
  missing_key text;
BEGIN
  SELECT expected.text_key INTO missing_key
  FROM (VALUES
    ('error.identity.user_context_invalid'),
    ('error.capability.denied'),
    ('error.settings.version_conflict'),
    ('error.settings.locale_inactive')
  ) AS expected(text_key)
  WHERE NOT EXISTS (
    SELECT 1
    FROM catalog.ui_texts AS text
    WHERE text.locale_code = 'en'
      AND text.text_key = expected.text_key
      AND text.is_active
  )
  LIMIT 1;

  IF missing_key IS NOT NULL THEN
    RAISE EXCEPTION 'M1 settings localization key is missing or inactive: %', missing_key;
  END IF;
END
$$;
