-- Localized own deletion controls; no schema/canonical retention descriptor changes.
WITH seed(text_key,category,body) AS (VALUES
 ('deletion.button.confirm','button','Delete my account'),
 ('deletion.button.cancel','button','Cancel'),
 ('deletion.confirm','message','Delete your account and product data? This cannot be undone. Some financial and safety records may be retained under their applicable policy.'),
 ('deletion.progress','message','Your account is deleted. Cleanup is in progress. Use /delete_status to check progress.'),
 ('deletion.completed','message','Your account deletion is complete.'),
 ('deletion.completed_denied','message','Your account deletion is complete. Returning is unavailable for this account.'),
 ('deletion.not_requested','message','No account deletion has been requested.'),
 ('deletion.cancelled','message','That deletion confirmation was cancelled.'),
 ('deletion.unavailable','error','This action is unavailable. Use /delete_status to check your account.'),
 ('deletion.rate_limited','error','Please wait before trying this account action again.')
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,category,'[]'::jsonb,true,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM seed;
