DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'discovery' AND table_name = 'explore_filters')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'discovery' AND table_name = 'explore_filter_genders')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'discovery' AND table_name = 'explore_consumptions')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'discovery' AND table_name = 'candidate_deliveries') THEN
    RAISE EXCEPTION 'M3 discovery tables are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'discovery' AND indexname = 'candidate_deliveries_one_live_viewer_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'profile' AND indexname = 'profiles_complete_shuffle_idx') THEN
    RAISE EXCEPTION 'M3 discovery indexes are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'explore_filter_gender_required' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'explore_filter_requires_gender' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'explore_consumption_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'candidate_delivery_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M3 discovery guards are incomplete';
  END IF;
END $$;
