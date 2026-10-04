-- Private metadata queue and separately confirmed own-review assignment.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.report.queue_title', 'message', 'Report review queue'),
 ('admin.report.queue_choose', 'message', 'Select a report to prepare taking responsibility for its review. You will provide a reason and confirm separately.'),
 ('admin.report.assign_prompt', 'message', 'Reply to this message with your reason for taking the selected review (1 to 1024 characters). You will confirm the assignment separately.'),
 ('admin.report.assign_confirm', 'message', 'Confirm taking responsibility for this report review'),
 ('admin.report.assign_effect', 'message', 'This assigns the selected review to you. It does not decide the report or change the account, photos or evidence.'),
 ('admin.queue.status.pending_review', 'button', 'Pending review'),
 ('admin.queue.status.dismissed', 'button', 'Dismissed'),
 ('admin.queue.status.actioned', 'button', 'Actioned')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
