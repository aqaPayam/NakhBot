DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND text_key LIKE 'profile.ui.%')<>4 THEN
  RAISE EXCEPTION 'Profile detail presentation catalog incomplete';
 END IF;
END $$;
