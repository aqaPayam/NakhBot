-- Return presentation only. No grant, approval, retained-data policy or product authority.
WITH seed(text_key,category,body) AS (VALUES
 ('return.button.confirm','button','Start again'),
 ('return.button.cancel','button','Not now'),
 ('return.confirm','message','Start again with a new guest account? Prior approval is required. Your previous profile and product data will not be restored, and your lifetime guest preview allowance does not reset.'),
 ('return.completed','message','Your return is complete. Use /start to begin again.'),
 ('return.dismissed','message','No new return command was sent. Use /return to open another prompt.'),
 ('return.unavailable','error','Returning is not available right now. Use /delete_status to check your account.'),
 ('return.rate_limited','error','Please wait before trying this account action again.')
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,category,'[]'::jsonb,true,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM seed;
