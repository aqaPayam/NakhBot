DO $$
BEGIN
  IF to_regclass('support.support_threads') IS NULL
    OR to_regclass('support.support_messages') IS NULL
    OR to_regclass('moderation.user_appeals') IS NULL THEN
    RAISE EXCEPTION 'M7 support and appeal tables are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'support'
      AND indexname = 'support_threads_user_open_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'support'
      AND indexname = 'support_messages_user_idempotency_uq'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'moderation'
      AND indexname = 'user_appeals_queue_idx'
  ) THEN
    RAISE EXCEPTION 'M7 support and appeal indexes are incomplete';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'support_threads_update_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'support_messages_immutable' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'user_appeals_update_guard' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M7 support and appeal guards are incomplete';
  END IF;
END $$;
