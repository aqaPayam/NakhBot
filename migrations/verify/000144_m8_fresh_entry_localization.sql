DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND variables='[]'::jsonb AND value<>''
   AND text_key IN('entry.confirm','entry.completed','entry.dismissed','entry.unavailable','entry.rate_limited'))<>5
   OR identity.retention_catalog_valid() IS NOT TRUE THEN
  RAISE EXCEPTION 'M8 fresh entry localization incomplete';
 END IF;
END $$;
