INSERT INTO catalog.ui_texts (
  id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at
) VALUES (
  md5('en:error.guest_preview.limit_reached')::uuid,
  'en',
  'error.guest_preview.limit_reached',
  'You have used all available guest previews.',
  'error',
  '[]',
  true,
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z'
), (
  md5('en:error.rate_limit.exceeded')::uuid,
  'en',
  'error.rate_limit.exceeded',
  'Too many requests. Try again later.',
  'error',
  '[]',
  true,
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z'
);
