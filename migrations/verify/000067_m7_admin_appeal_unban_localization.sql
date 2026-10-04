DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.appeal.unban', 'admin.appeal.unban_prompt', 'admin.appeal.unban_confirm', 'admin.appeal.unban_effect'
 )) <> 4 THEN
 RAISE EXCEPTION 'M7 appeal unban localization incomplete';
 END IF;
END $$;
