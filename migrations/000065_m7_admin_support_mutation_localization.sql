-- Confirmed support reply/close UI; protected plain text and English fallback.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.support.choose_action', 'message', 'Choose an action for the selected support request.'),
 ('admin.support.read', 'button', 'Read conversation'),
 ('admin.support.reply', 'button', 'Reply to request'),
 ('admin.support.close', 'button', 'Close request'),
 ('admin.support.reply_prompt', 'message', 'Reply to this message with your review reason on the first line (1 to 1024 characters), then your support reply on the following lines (1 to 2000 characters). You will review and confirm before sending.'),
 ('admin.support.close_prompt', 'message', 'Reply to this message with your reason for closing the selected request (1 to 1024 characters). You will confirm before closure.'),
 ('admin.support.reply_preview', 'message', 'Review your support reply before confirming:')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
