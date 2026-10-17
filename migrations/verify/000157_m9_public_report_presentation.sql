DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND text_key IN ('report.ui.reply_submits','report.ui.cancelled') AND category='message' AND variables='[]'::jsonb)<>2 THEN
  RAISE EXCEPTION 'Public report presentation catalog incomplete';
 END IF;
END $$;
