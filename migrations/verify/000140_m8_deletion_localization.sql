DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND variables='[]'::jsonb AND value<>'' AND text_key IN('deletion.button.confirm','deletion.button.cancel','deletion.confirm','deletion.progress','deletion.completed','deletion.completed_denied','deletion.not_requested','deletion.cancelled','deletion.unavailable','deletion.rate_limited'))<>10 OR identity.retention_catalog_valid() IS NOT TRUE THEN RAISE EXCEPTION 'M8 deletion localization incomplete'; END IF;
END $$;
