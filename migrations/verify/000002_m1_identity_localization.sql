DO $$
DECLARE
  missing_table text;
BEGIN
  SELECT expected.name INTO missing_table
  FROM (VALUES
    ('identity.users'),
    ('identity.telegram_identities'),
    ('identity.accounts'),
    ('identity.account_state_history'),
    ('identity.guest_preview_counters'),
    ('identity.user_settings'),
    ('billing.credit_accounts'),
    ('notification.notification_preferences'),
    ('catalog.locales'),
    ('catalog.ui_texts')
  ) AS expected(name)
  WHERE to_regclass(expected.name) IS NULL
  LIMIT 1;

  IF missing_table IS NOT NULL THEN
    RAISE EXCEPTION 'M1 identity/localization table is missing: %', missing_table;
  END IF;

  IF (SELECT count(*) FROM catalog.locales WHERE is_default) <> 1 THEN
    RAISE EXCEPTION 'exactly one default locale is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM catalog.locales WHERE code = 'en' AND is_active AND is_default
  ) OR NOT EXISTS (
    SELECT 1 FROM catalog.locales WHERE code = 'fa' AND NOT is_active AND NOT is_default
  ) THEN
    RAISE EXCEPTION 'locked locale seeds are invalid';
  END IF;

  IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active) < 18 THEN
    RAISE EXCEPTION 'required English M1 localization seeds are incomplete';
  END IF;
END
$$;
