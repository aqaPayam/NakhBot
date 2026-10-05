-- Exact evidence selection, owned reason, and separate audited read confirmation.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.report.evidence_read', 'button', 'View selected evidence'),
 ('admin.report.evidence_read_choose', 'message', 'You can request a confidential view of this exact evidence item. A reason and separate confirmation are required.'),
 ('admin.report.evidence_read_prompt', 'message', 'Reply with your reason for viewing this evidence (1 to 1024 characters). You will confirm the view separately.'),
 ('admin.report.evidence_read_effect', 'message', 'This opens only the selected retained evidence and records an access audit. It does not change the account, photo or report review. A retry will not resend evidence content; request a new confirmed view if delivery fails.')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
