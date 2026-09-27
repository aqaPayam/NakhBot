DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'moderation' AND table_name = 'restriction_episodes'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'moderation' AND table_name = 'moderation_reviews'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'moderation' AND table_name = 'moderation_actions'
  ) THEN
    RAISE EXCEPTION 'M7 threshold/review/action tables are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'moderation'
      AND indexname = 'restriction_episodes_one_active_target_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'moderation'
      AND indexname = 'moderation_reviews_queue_idx'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'moderation'
      AND indexname = 'moderation_actions_threshold_episode_uq'
  ) THEN
    RAISE EXCEPTION 'M7 threshold/review/action indexes are incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'restriction_episodes_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'restriction_episode_threshold_valid'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'moderation_reviews_guard' AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'moderation_review_report_consistent'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'report_moderation_review_consistent'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'moderation_actions_immutable' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M7 threshold/review/action guards are incomplete';
  END IF;
END $$;
