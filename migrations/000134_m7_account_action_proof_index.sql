-- Exact succeeded account-action proof remains bound to administrator/command,
-- request, digest and target. Cover the fields used by indexed resolution probes
-- without copying request context, outcome bodies or widening accepted authority.
CREATE INDEX admin_action_logs_account_proof_idx
  ON administration.admin_action_logs (admin_user_id, command_id)
  INCLUDE (request_id, request_digest, target_id)
  WHERE result='succeeded' AND command_code='moderation.apply-account-action' AND target_type='user';
