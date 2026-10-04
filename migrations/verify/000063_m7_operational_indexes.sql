DO $$
BEGIN
  IF to_regclass('moderation.reports_pending_age_idx') IS NULL
    OR to_regclass('moderation.moderation_reviews_in_review_age_idx') IS NULL
    OR to_regclass('support.support_threads_user_all_idx') IS NULL
    OR to_regclass('support.support_messages_thread_sender_time_idx') IS NULL
    OR to_regclass('billing.reconciliation_runs_moderation_completed_idx') IS NULL THEN
    RAISE EXCEPTION 'M7 operational query indexes are incomplete';
  END IF;
END $$;
