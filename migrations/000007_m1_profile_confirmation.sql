INSERT INTO catalog.ui_texts (
  id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at
) VALUES
  (md5('en:error.profile.media_not_eligible')::uuid, 'en', 'error.profile.media_not_eligible', 'Your photos are not eligible for Profile confirmation.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:error.profile.version_conflict')::uuid, 'en', 'error.profile.version_conflict', 'Your Profile changed elsewhere. Refresh and try again.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
