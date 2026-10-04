DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.report.photo.hide_photo', 'admin.report.photo.restore_photo', 'admin.report.photo.delete_photo',
 'admin.report.photo_choose', 'admin.report.photo_prompt', 'admin.report.photo_effect'
 )) <> 6 THEN
 RAISE EXCEPTION 'M7 report photo localization incomplete';
 END IF;
END $$;
