-- Separate exact-ban account restoration; never implicit in appeal review.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.appeal.unban', 'button', 'Restore access'),
 ('admin.appeal.unban_prompt', 'message', 'Reply to this message with your reason for restoring access for the selected accepted appeal (1 to 1024 characters). You will confirm this separate action.'),
 ('admin.appeal.unban_confirm', 'message', 'Confirm restoration of account access'),
 ('admin.appeal.unban_effect', 'message', 'This separately authorized action restores access only for the accepted appeal and its current ban.')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
