DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'matching' AND table_name = 'matches')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'matching' AND table_name = 'match_participants')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'chat' AND table_name = 'chat_sessions')
    OR NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'chat' AND table_name = 'chat_participants') THEN
    RAISE EXCEPTION 'M3 matching/chat tables are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'match_requires_participants' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'match_participants_exact' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_requires_participants' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_participants_exact' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'matches_lifecycle_guard' AND NOT tgisinternal)
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chat_session_lifecycle_guard' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'M3 matching/chat guards are incomplete';
  END IF;
END $$;
