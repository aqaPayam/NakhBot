CREATE TABLE platform.audit_logs (
  id uuid PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('product', 'account', 'security', 'admin')),
  event_type text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 160),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'admin', 'system')),
  actor_user_id uuid,
  actor_admin_id uuid,
  subject_type text NOT NULL CHECK (char_length(subject_type) BETWEEN 1 AND 80),
  subject_id uuid NOT NULL,
  result_code text NOT NULL CHECK (char_length(result_code) BETWEEN 1 AND 80),
  metadata_schema_version integer NOT NULL CHECK (metadata_schema_version >= 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  request_id uuid NOT NULL,
  command_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  CONSTRAINT audit_actor_shape_ck CHECK (
    (actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_admin_id IS NULL)
    OR (actor_type = 'admin' AND actor_user_id IS NULL AND actor_admin_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_user_id IS NULL AND actor_admin_id IS NULL)
  )
);

CREATE INDEX audit_logs_subject_time_idx
  ON platform.audit_logs (subject_type, subject_id, occurred_at DESC, id DESC);
CREATE INDEX audit_logs_actor_time_idx
  ON platform.audit_logs (actor_type, actor_user_id, actor_admin_id, occurred_at DESC, id DESC);
CREATE INDEX audit_logs_event_time_idx
  ON platform.audit_logs (event_type, occurred_at DESC, id DESC);

CREATE FUNCTION platform.reject_audit_log_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit logs are append-only' USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON platform.audit_logs
FOR EACH ROW EXECUTE FUNCTION platform.reject_audit_log_mutation();

COMMENT ON TABLE platform.audit_logs IS
  'Append-only safe audit metadata. User prose, Telegram identifiers, and Profile content are prohibited.';

INSERT INTO catalog.ui_texts (
  id, locale_code, text_key, value, category, variables, is_active, created_at, updated_at
) VALUES
  ('10000000-0000-4000-8000-000000000019', 'en', 'common.button.edit_profile', 'Edit profile', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000020', 'en', 'common.button.appeal', 'Appeal', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000021', 'en', 'common.button.delete_account', 'Delete account', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000022', 'en', 'common.button.return_status', 'Check return status', 'button', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000023', 'en', 'error.identity.telegram_context_invalid', 'This Telegram request could not be authenticated.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000024', 'en', 'error.command.idempotency_conflict', 'This request identifier was already used for different data.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('10000000-0000-4000-8000-000000000025', 'en', 'error.command.in_progress', 'This request is already being processed.', 'error', '[]', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
