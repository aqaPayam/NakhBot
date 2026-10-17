DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND text_key LIKE 'preview.ui.%')<>5
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='discovery.candidate_deliveries'::regclass AND tgname='candidate_provider_erase_guard' AND tgenabled='O' AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'Guest Preview presentation catalog incomplete';
 END IF;
END $$;
