DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND text_key IN(E'filters.any',E'filters.apply',E'filters.changed',E'filters.genders',E'filters.goal',E'filters.invalid',E'filters.location',E'filters.max_age',E'filters.min_age',E'filters.preference_adjusted',E'filters.saved',E'filters.summary',E'filters.title'))<>13 THEN RAISE EXCEPTION 'Explore filter presentation incomplete'; END IF;
 IF NOT EXISTS(SELECT 1 FROM catalog.ui_texts WHERE locale_code='en' AND text_key='filters.summary' AND variables='["genders","goal","location","max","min"]'::jsonb) THEN RAISE EXCEPTION 'Explore filter variables invalid'; END IF;
END $$;
