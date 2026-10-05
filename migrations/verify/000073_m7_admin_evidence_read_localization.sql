DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.report.evidence_read', 'admin.report.evidence_read_choose',
 'admin.report.evidence_read_prompt', 'admin.report.evidence_read_effect'
 )) <> 4 THEN
 RAISE EXCEPTION 'M7 evidence read localization incomplete';
 END IF;
END $$;
