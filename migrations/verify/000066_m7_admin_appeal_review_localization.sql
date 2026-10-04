DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.appeal.choose_action', 'admin.appeal.read', 'admin.appeal.accepted', 'admin.appeal.rejected', 'admin.appeal.review_prompt', 'admin.appeal.note_preview', 'admin.appeal.ban_remains'
 )) <> 7 THEN
 RAISE EXCEPTION 'M7 appeal review localization incomplete';
 END IF;
END $$;
