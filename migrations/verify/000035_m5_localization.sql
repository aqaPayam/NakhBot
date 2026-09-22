DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT count(*) INTO missing_count
  FROM (VALUES
    ('nakh.compose.auto_settle_consent'),
    ('nakh.pending.button.edit'),
    ('nakh.pending.button.convert_like'),
    ('nakh.pending.button.convert_not_interested'),
    ('nakh.pending.expired'),
    ('nakh.status.sent'),
    ('nakh.status.seen'),
    ('nakh.status.accepted'),
    ('nakh.status.rejected'),
    ('nakh.status.closed'),
    ('notification.nakh_received.title'),
    ('notification.nakh_received.body'),
    ('notification.pending_nakh_payment_reminder.title'),
    ('notification.pending_nakh_payment_reminder.body'),
    ('error.nakh.text_invalid'),
    ('error.nakh.quota_reached'),
    ('error.nakh.version_conflict'),
    ('error.nakh.terminal'),
    ('error.nakh.payment_expired'),
    ('error.nakh.settlement_invalid')
  ) required(text_key)
  WHERE NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts text
    WHERE text.locale_code = 'en' AND text.text_key = required.text_key
      AND text.is_active = true
  );
  IF missing_count <> 0 THEN
    RAISE EXCEPTION 'M5 English localization catalog is incomplete (% missing)', missing_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts
    WHERE locale_code = 'en' AND text_key = 'nakh.status.rejected'
      AND value = 'Closed' AND variables = '[]'::jsonb AND is_active = true
  ) OR NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts
    WHERE locale_code = 'en' AND text_key = 'nakh.status.closed'
      AND value = 'Closed' AND variables = '[]'::jsonb AND is_active = true
  ) THEN
    RAISE EXCEPTION 'M5 rejected/closed presentation contract is invalid';
  END IF;

  IF EXISTS (
    SELECT 1 FROM catalog.ui_texts
    WHERE locale_code = 'en' AND text_key IN (
      'nakh.pending.card.title', 'nakh.pending.card.expires', 'nakh.received.card.title'
    ) AND (
      (text_key = 'nakh.pending.card.title' AND variables <> '["name"]'::jsonb)
      OR (text_key = 'nakh.pending.card.expires' AND variables <> '["expiresAt"]'::jsonb)
      OR (text_key = 'nakh.received.card.title' AND variables <> '["name"]'::jsonb)
    )
  ) THEN
    RAISE EXCEPTION 'M5 localization variable declarations are invalid';
  END IF;
END $$;

