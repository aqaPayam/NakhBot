-- Admin command IDs are actor-bound, including sensitive-read attempts.
-- Preserve every existing audit row while allowing independent admins to reuse a command UUID.
ALTER TABLE moderation.evidence_access_audits
  DROP CONSTRAINT evidence_access_audits_command_id_key,
  ADD CONSTRAINT evidence_access_audits_admin_command_uq UNIQUE (admin_user_id, command_id);
