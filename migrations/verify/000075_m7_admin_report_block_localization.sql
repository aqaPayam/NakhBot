DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.report.block.create', 'admin.report.block.remove', 'admin.report.block_prompt', 'admin.report.block_effect'
 )) <> 4 THEN
 RAISE EXCEPTION 'M7 report block localization incomplete';
 END IF;
END $$;
