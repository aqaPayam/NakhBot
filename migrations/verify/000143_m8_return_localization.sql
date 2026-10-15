DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND variables='[]'::jsonb AND value<>''
   AND text_key IN('return.button.confirm','return.button.cancel','return.confirm','return.completed','return.dismissed','return.unavailable','return.rate_limited'))<>7
   OR identity.retention_catalog_valid() IS NOT TRUE THEN
  RAISE EXCEPTION 'M8 Return localization incomplete';
 END IF;
END $$;
