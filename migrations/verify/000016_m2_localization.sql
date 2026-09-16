DO $$ BEGIN
  IF (
    SELECT count(*)
    FROM catalog.ui_texts
    WHERE locale_code = 'en'
      AND is_active
      AND text_key IN (
        'media.photos.title',
        'media.photos.empty',
        'media.photos.item.primary',
        'media.photos.item.visible',
        'media.photos.item.hidden',
        'media.photos.button.set_primary',
        'media.photos.button.move_up',
        'media.photos.button.move_down',
        'media.photos.button.delete'
      )
  ) <> 9 THEN
    RAISE EXCEPTION 'M2 photo-menu localization seed is incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM catalog.ui_texts
    WHERE locale_code = 'en' AND text_key = 'media.photos.title'
      AND variables = '["count"]'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM catalog.ui_texts
    WHERE locale_code = 'en' AND text_key LIKE 'media.photos.item.%'
      AND variables <> '["position"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'M2 photo-menu localization variables are invalid';
  END IF;
END $$;
