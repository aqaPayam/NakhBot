-- Actor-bound current integrity checks must not rescan every history row for a busy account.
-- Ordinary append-only history guards and the restoration lookup index remain unchanged.
CREATE INDEX account_history_moderation_actor_idx
  ON identity.account_state_history
    (user_id, actor_admin_id, actor_type, reason_code, changed_at, next_state);
