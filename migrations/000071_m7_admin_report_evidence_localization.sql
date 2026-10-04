-- Metadata-only report evidence picker; reveal and photo mutation remain separate capabilities.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.report.evidence', 'button', 'Evidence metadata'),
 ('admin.report.evidence_title', 'message', 'Report evidence metadata'),
 ('admin.report.evidence_choose', 'message', 'Choose an evidence item. This list shows only its type. Viewing content or changing a photo requires a separate confirmed command.'),
 ('admin.report.evidence_empty', 'message', 'No evidence metadata is available for this report.'),
 ('admin.report.evidence_selected', 'message', 'Selected evidence type. Content has not been opened.'),
 ('admin.report.evidence_type.profile', 'button', 'Profile'),
 ('admin.report.evidence_type.photo', 'button', 'Photo'),
 ('admin.report.evidence_type.chat', 'button', 'Chat'),
 ('admin.report.evidence_type.message', 'button', 'Message'),
 ('admin.report.evidence_type.unmatched_user', 'button', 'Unmatched user'),
 ('admin.report.queue_choose_evidence', 'message', 'Select a report to browse evidence metadata or choose an available action. Each change requires a reason and separate confirmation.')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
