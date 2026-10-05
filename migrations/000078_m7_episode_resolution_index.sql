-- Resolved threshold episodes must find their exact native unrestriction before joining attempts.
-- The partial covering index keeps mixed terminal-appeal populations from reversing this lookup.
CREATE INDEX moderation_actions_episode_resolution_idx
  ON moderation.moderation_actions (restriction_episode_id)
  INCLUDE (actor_admin_id, target_user_id, reason_code, occurred_at, command_id, request_id, request_digest)
  WHERE restriction_episode_id IS NOT NULL AND actor_type = 'admin' AND action_type = 'unrestrict_user';
