DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'interaction' AND table_name = 'likes')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'interaction' AND table_name = 'not_interested')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'interaction' AND table_name = 'user_pair_states') THEN
    RAISE EXCEPTION 'M3 interaction tables are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'interaction' AND indexname = 'likes_receiver_status_time_idx')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'interaction' AND indexname = 'user_pair_states_high_idx') THEN
    RAISE EXCEPTION 'M3 interaction indexes are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'likes_lifecycle_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'not_interested_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_pair_state_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M3 interaction guards are incomplete';
  END IF;
END $$;
