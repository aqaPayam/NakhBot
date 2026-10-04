-- Explicit appeal review only; never grants or invokes unban.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.appeal.choose_action', 'message', 'Choose an action for the selected appeal.'),
 ('admin.appeal.read', 'button', 'Read appeal'),
 ('admin.appeal.accepted', 'button', 'Accept appeal'),
 ('admin.appeal.rejected', 'button', 'Reject appeal'),
 ('admin.appeal.review_prompt', 'message', 'Reply to this message with your review reason on the first line (1 to 1024 characters). You may add a private review note on following lines (up to 2000 characters). You will confirm the selected decision.'),
 ('admin.appeal.note_preview', 'message', 'Review your private appeal note before confirming:'),
 ('admin.appeal.ban_remains', 'message', 'This decision leaves the ban in place. Restoring access requires a separate authorized unban action.')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
