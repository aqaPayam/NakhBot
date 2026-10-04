-- Metadata-only admin picker and exact-prompt reason entry; English fallback.
WITH seed(text_key, category, body) AS (
  VALUES
    ('admin.queue.support_title', 'message', 'Support requests'),
    ('admin.queue.appeals_title', 'message', 'Ban appeals'),
    ('admin.queue.choose', 'message', 'Choose a request to review. Dates are shown in UTC.'),
    ('admin.queue.empty', 'message', 'There are no requests in this queue.'),
    ('admin.queue.next', 'button', 'Next page'),
    ('admin.queue.reason_prompt', 'message', 'Reply to this message with your reason for reading the selected request (1 to 1024 characters). You will confirm before any content is shown.'),
    ('admin.queue.status.open', 'button', 'Open'),
    ('admin.queue.status.closed', 'button', 'Closed'),
    ('admin.queue.status.submitted', 'button', 'Submitted'),
    ('admin.queue.status.in_review', 'button', 'In review'),
    ('admin.queue.status.accepted', 'button', 'Accepted'),
    ('admin.queue.status.rejected', 'button', 'Rejected')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
