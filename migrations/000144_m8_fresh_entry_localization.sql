-- Fresh-entry presentation only. No product credential or retention authority.
WITH seed(text_key,category,body) AS (VALUES
 ('entry.confirm','message','Begin using your new guest account? Confirm to activate access for this new account lifetime. Previous profile and product data will not be restored, and your lifetime guest preview allowance does not reset.'),
 ('entry.completed','message','Access for your new guest account is ready. Your previous profile and product data remain deleted.'),
 ('entry.dismissed','message','No activation was requested. Use /start when you are ready.'),
 ('entry.unavailable','error','Entry is not available right now. Use /delete_status to check your account.'),
 ('entry.rate_limited','error','Please wait before trying to begin again.')
)
INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,variables,is_active,created_at,updated_at)
SELECT md5('en:'||text_key)::uuid,'en',text_key,body,category,'[]'::jsonb,true,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z' FROM seed;
