DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.report.choose_action',
 'admin.report.assign',
 'admin.report.dismissed',
 'admin.report.actioned',
 'admin.report.decision_prompt',
 'admin.report.note_preview',
 'admin.report.decision_effect'
 )) <> 7 THEN
 RAISE EXCEPTION 'M7 report decision localization incomplete';
 END IF;
END $$;
