DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'nakh' AND table_name = 'nakh_flows')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'platform' AND table_name = 'user_counters') THEN
    RAISE EXCEPTION 'M5 Nakh flow and counter tables are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nakh_flows_immutable' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_create_counter' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'user_counters_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M5 Nakh flow and counter guards are incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM identity.users users
    LEFT JOIN platform.user_counters counters ON counters.user_id = users.id
    WHERE counters.user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'M5 user counters are not complete';
  END IF;
END $$;
