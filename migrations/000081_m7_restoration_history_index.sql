-- Restoration integrity reads select the latest history entering the exact prior state.
-- Include the restored state without changing immutable history or restoration policy.
CREATE INDEX account_history_restoration_state_idx
  ON identity.account_state_history (user_id, next_state, changed_at DESC, id DESC)
  INCLUDE (previous_state);
