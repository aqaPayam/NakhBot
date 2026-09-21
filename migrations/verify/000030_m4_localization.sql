DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT count(*) INTO missing_count
  FROM (VALUES
    ('billing.package.starter.title'),
    ('billing.package.plus.title'),
    ('billing.package.best_value.title'),
    ('billing.package.ultimate.title'),
    ('notification.payment_success.title'),
    ('notification.payment_corrected.body'),
    ('notification.chat_unlock_safety.body'),
    ('error.billing.provider_callback_invalid'),
    ('error.billing.refund_resolution_forbidden'),
    ('error.notification.preferences_not_found')
  ) required(text_key)
  WHERE NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts text
    WHERE text.locale_code = 'en' AND text.text_key = required.text_key
      AND text.is_active = true
  );
  IF missing_count <> 0 THEN
    RAISE EXCEPTION 'M4 English localization catalog is incomplete (% missing)', missing_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM billing.credit_packages package
    WHERE NOT EXISTS (
      SELECT 1 FROM catalog.ui_texts text
      WHERE text.locale_code = 'en' AND text.text_key = package.title_key AND text.is_active = true
    ) OR (
      package.badge_key IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM catalog.ui_texts text
        WHERE text.locale_code = 'en' AND text.text_key = package.badge_key AND text.is_active = true
      )
    )
  ) THEN
    RAISE EXCEPTION 'an M4 credit package references missing English text';
  END IF;
END $$;
