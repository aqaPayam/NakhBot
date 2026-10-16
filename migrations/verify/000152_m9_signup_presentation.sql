DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.ui_texts WHERE locale_code='en' AND is_active AND text_key LIKE 'signup.ui.%')<>26 OR platform.deletion_event_policy()->'shapes'->'identity.signup-optional-details-saved.v1' IS DISTINCT FROM '{"required":"userId currentStep draftVersion"}'::jsonb THEN RAISE EXCEPTION 'M9 signup presentation incomplete'; END IF;
END $$;
