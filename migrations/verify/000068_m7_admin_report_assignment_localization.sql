DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.report.queue_title', 'admin.report.queue_choose', 'admin.report.assign_prompt',
 'admin.report.assign_confirm', 'admin.report.assign_effect', 'admin.queue.status.pending_review',
 'admin.queue.status.dismissed', 'admin.queue.status.actioned'
 )) <> 8 THEN
 RAISE EXCEPTION 'M7 report assignment localization incomplete';
 END IF;
END $$;
