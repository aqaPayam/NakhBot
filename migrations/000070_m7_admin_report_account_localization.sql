-- Separately confirmed report Account actions.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.report.account.restrict_user', 'button', 'Restrict account'),
 ('admin.report.account.unrestrict_user', 'button', 'Remove account restriction'),
 ('admin.report.account.ban_user', 'button', 'Ban account'),
 ('admin.report.account.unban_user', 'button', 'Unban account'),
 ('admin.report.account_prompt', 'message', 'Reply with your reason for the selected account action (1 to 1024 characters). You will confirm the action separately.'),
 ('admin.report.account_effect', 'message', 'This changes the account for the selected report and notifies the user. It does not close the report review or decide an appeal. Confirm only the selected action.')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;

UPDATE catalog.ui_texts SET value = 'Select a report to choose an available review or account action. Each action requires a reason and separate confirmation.', updated_at = '2026-01-01T00:00:00Z'
WHERE locale_code = 'en' AND text_key = 'admin.report.queue_choose';
