-- Assigned report decisions with separate confirmation.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.report.choose_action', 'message', 'Choose the next step for this report review'),
 ('admin.report.assign', 'button', 'Take responsibility'),
 ('admin.report.dismissed', 'button', 'Dismiss report'),
 ('admin.report.actioned', 'button', 'Complete after moderation action'),
 ('admin.report.decision_prompt', 'message', 'Reply with your reason on the first line (1 to 1024 characters). Remaining lines are an optional private review note (up to 2000 characters). You will confirm separately.'),
 ('admin.report.note_preview', 'message', 'Private review note preview'),
 ('admin.report.decision_effect', 'message', 'This closes the selected report review. Account and photo actions require their own permission checks and separate confirmation.')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
