DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.support.choose_action', 'admin.support.read', 'admin.support.reply', 'admin.support.close', 'admin.support.reply_prompt', 'admin.support.close_prompt', 'admin.support.reply_preview'
 )) <> 7 THEN
 RAISE EXCEPTION 'M7 support mutation localization incomplete';
 END IF;
END $$;
