-- M1 settings localization additions. Settings data structures were created by 000002.
-- Verification: the four text keys below must each exist once for the active English locale.
INSERT INTO catalog.ui_texts (
  id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at
) VALUES
  ('10000000-0000-4000-8000-000000000026', 'en', 'error.identity.user_context_invalid', 'This user request could not be authenticated.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000027', 'en', 'error.capability.denied', 'This action is not available for your account.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000028', 'en', 'error.settings.version_conflict', 'Your settings changed elsewhere. Refresh and try again.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000029', 'en', 'error.settings.locale_inactive', 'That language is not currently available.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
