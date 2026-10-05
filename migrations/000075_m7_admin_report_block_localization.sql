-- Private, separately confirmed actions on the exact Report participant pair.
WITH seed(text_key, category, body) AS (
 VALUES
 ('admin.report.block.create', 'button', 'Create internal block'),
 ('admin.report.block.remove', 'button', 'Remove internal block'),
 ('admin.report.block_prompt', 'message', 'Reply with your reason for this internal block action (1 to 1024 characters). You will confirm the action separately.'),
 ('admin.report.block_effect', 'message', 'This changes the internal block between the two people in this report without notifying them. Creation closes their active interactions. Removal never reopens old interactions. Accounts and the report review are unchanged. Confirm only the selected action.')
)
INSERT INTO catalog.ui_texts (id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at)
SELECT md5('en:' || text_key)::uuid, 'en', text_key, body, category, '[]'::jsonb, true,
 '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z' FROM seed;
