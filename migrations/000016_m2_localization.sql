INSERT INTO catalog.ui_texts (
  id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at
) VALUES
  (md5('en:media.photos.title')::uuid, 'en', 'media.photos.title', 'Your photos ({count})', 'message', '["count"]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:media.photos.empty')::uuid, 'en', 'media.photos.empty', 'You have no photos yet.', 'message', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:media.photos.item.primary')::uuid, 'en', 'media.photos.item.primary', 'Photo {position} · Primary', 'message', '["position"]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:media.photos.item.visible')::uuid, 'en', 'media.photos.item.visible', 'Photo {position} · Visible', 'message', '["position"]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:media.photos.item.hidden')::uuid, 'en', 'media.photos.item.hidden', 'Photo {position} · Hidden', 'message', '["position"]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:media.photos.button.set_primary')::uuid, 'en', 'media.photos.button.set_primary', 'Make primary', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:media.photos.button.move_up')::uuid, 'en', 'media.photos.button.move_up', 'Move up', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:media.photos.button.move_down')::uuid, 'en', 'media.photos.button.move_down', 'Move down', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  (md5('en:media.photos.button.delete')::uuid, 'en', 'media.photos.button.delete', 'Delete', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
