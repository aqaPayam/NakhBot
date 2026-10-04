DO $$
BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code = 'en' AND is_active AND variables = '[]'::jsonb AND value <> '' AND text_key IN (
 'admin.report.account.restrict_user',
 'admin.report.account.unrestrict_user',
 'admin.report.account.ban_user',
 'admin.report.account.unban_user',
 'admin.report.account_prompt',
 'admin.report.account_effect'
 )) <> 6 THEN
 RAISE EXCEPTION 'M7 report Account localization incomplete';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM catalog.ui_texts WHERE locale_code = 'en' AND text_key = 'admin.report.queue_choose' AND value = 'Select a report to choose an available review or account action. Each action requires a reason and separate confirmation.') THEN
 RAISE EXCEPTION 'M7 report queue action instructions incomplete';
 END IF;
END $$;
