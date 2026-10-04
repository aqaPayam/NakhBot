CREATE INDEX reports_pending_age_idx
  ON moderation.reports (submitted_at, id) WHERE status IN ('submitted','pending_review');
CREATE INDEX moderation_reviews_in_review_age_idx
  ON moderation.moderation_reviews (updated_at, id) WHERE status = 'in_review';
CREATE INDEX support_threads_user_all_idx
  ON support.support_threads (user_id, id);
CREATE INDEX support_messages_thread_sender_time_idx
  ON support.support_messages (support_thread_id, sender_type, created_at DESC, id DESC);
CREATE INDEX reconciliation_runs_moderation_completed_idx
  ON billing.reconciliation_runs (finished_at DESC, id DESC)
  WHERE run_type = 'moderation' AND status = 'succeeded';

COMMENT ON INDEX support.support_threads_user_all_idx IS
  'Shared unanswered support admission includes admin replies in closed threads.';
COMMENT ON INDEX billing.reconciliation_runs_moderation_completed_idx IS
  'Aggregate scheduler freshness reads the latest completed moderation scan without loading identities.';
