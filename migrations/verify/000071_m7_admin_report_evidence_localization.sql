DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.report.evidence', 'admin.report.evidence_title', 'admin.report.evidence_choose',
 'admin.report.evidence_empty', 'admin.report.evidence_selected',
 'admin.report.evidence_type.profile', 'admin.report.evidence_type.photo',
 'admin.report.evidence_type.chat', 'admin.report.evidence_type.message',
 'admin.report.evidence_type.unmatched_user', 'admin.report.queue_choose_evidence'
 )) <> 11 THEN
 RAISE EXCEPTION 'M7 report evidence picker localization incomplete';
 END IF;
END $$;
