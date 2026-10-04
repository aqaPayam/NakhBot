-- Separately confirmed actions on the exact selected report photo.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.report.photo.hide_photo', 'button', 'Hide photo'),
 ('admin.report.photo.restore_photo', 'button', 'Restore photo'),
 ('admin.report.photo.delete_photo', 'button', 'Delete photo'),
 ('admin.report.photo_choose', 'message', 'Choose an available action for the selected reported photo. Each action requires a reason and separate confirmation.'),
 ('admin.report.photo_prompt', 'message', 'Reply with your reason for the selected photo action (1 to 1024 characters). You will confirm the action separately.'),
 ('admin.report.photo_effect', 'message', 'This changes the selected reported photo. It does not open evidence content or close the report review. Deletion is permanent; retained report evidence is preserved. Confirm only the selected action.')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
