ALTER TABLE billing.reconciliation_runs
  DROP CONSTRAINT reconciliation_runs_run_type_check;
ALTER TABLE billing.reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_run_type_check
  CHECK (run_type IN ('billing','nakh','chat','moderation'));

ALTER TABLE billing.reconciliation_anomalies
  DROP CONSTRAINT reconciliation_anomalies_entity_type_check;
ALTER TABLE billing.reconciliation_anomalies
  ADD CONSTRAINT reconciliation_anomalies_entity_type_check CHECK (entity_type IN (
    'payment_record','payment_fulfillment','credit_account','credit_transaction',
    'feature_unlock','refund_record','provider_event','nakh_flow','pending_nakh','nakh',
    'user_counter','chat_session','chat_message','match','notification_delivery',
    'report','moderation_review','moderation_action','restriction_episode',
    'internal_block','admin_user','admin_action_log','support_thread','user_appeal'
  ));

CREATE INDEX support_threads_status_created_idx
  ON support.support_threads (status, created_at, id);
CREATE INDEX user_appeals_status_submitted_idx
  ON moderation.user_appeals (status, submitted_at, id);

CREATE TABLE administration.safety_access_audits (
  id uuid PRIMARY KEY,
  admin_user_id uuid NOT NULL REFERENCES administration.admin_users(id) ON DELETE RESTRICT,
  admin_action_log_id uuid NOT NULL UNIQUE
    REFERENCES administration.admin_action_logs(id) ON DELETE RESTRICT,
  command_id uuid NOT NULL,
  request_id uuid NOT NULL,
  support_thread_id uuid REFERENCES support.support_threads(id) ON DELETE RESTRICT,
  user_appeal_id uuid REFERENCES moderation.user_appeals(id) ON DELETE RESTRICT,
  permission_code text NOT NULL CHECK (permission_code IN ('review_support','review_appeals'))
    REFERENCES administration.admin_permissions(code) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('revealed','rejected')),
  safe_code text NOT NULL CHECK (safe_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  item_count integer NOT NULL CHECK (item_count BETWEEN 0 AND 50),
  occurred_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (admin_user_id, command_id),
  CONSTRAINT safety_access_subject_ck CHECK (
    (support_thread_id IS NOT NULL AND user_appeal_id IS NULL AND permission_code = 'review_support')
    OR (support_thread_id IS NULL AND user_appeal_id IS NOT NULL AND permission_code = 'review_appeals')
  ),
  CONSTRAINT safety_access_rejected_count_ck CHECK (outcome = 'revealed' OR item_count = 0)
);
CREATE INDEX safety_access_audits_admin_time_idx
  ON administration.safety_access_audits (admin_user_id, occurred_at DESC, id DESC);

CREATE FUNCTION administration.validate_safety_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  attempt administration.admin_action_logs%ROWTYPE;
BEGIN
  SELECT * INTO attempt FROM administration.admin_action_logs WHERE id = NEW.admin_action_log_id;
  IF NOT FOUND OR attempt.admin_user_id <> NEW.admin_user_id
    OR attempt.command_id <> NEW.command_id OR attempt.request_id <> NEW.request_id
    OR attempt.safe_code <> NEW.safe_code
    OR attempt.target_id <> COALESCE(NEW.support_thread_id, NEW.user_appeal_id)
    OR NOT (
      (NEW.support_thread_id IS NOT NULL AND attempt.command_code = 'support.reveal-thread'
        AND attempt.target_type = 'support_thread')
      OR (NEW.user_appeal_id IS NOT NULL AND attempt.command_code = 'moderation.reveal-appeal'
        AND attempt.target_type = 'user_appeal')
    ) OR (NEW.outcome = 'revealed') <> (attempt.result = 'succeeded') THEN
    RAISE EXCEPTION 'safety access audit must match its recorded attempt' USING ERRCODE = '23514';
  END IF;
  IF NEW.outcome = 'revealed' AND NOT EXISTS (
    SELECT 1 FROM administration.admin_users admin
    JOIN identity.telegram_identities identity ON identity.user_id = admin.user_id
      AND identity.telegram_user_id = admin.telegram_user_id
    JOIN administration.admin_user_roles assignment ON assignment.admin_user_id = admin.id
      AND assignment.revoked_at IS NULL
    JOIN administration.admin_roles role ON role.code = assignment.role_code AND role.is_active
    JOIN administration.admin_role_permissions permission ON permission.role_code = role.code
      AND permission.permission_code = NEW.permission_code
    WHERE admin.id = NEW.admin_user_id AND admin.is_active AND admin.identity_verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'safety access requires current verified permission' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER safety_access_audits_valid
BEFORE INSERT ON administration.safety_access_audits
FOR EACH ROW EXECUTE FUNCTION administration.validate_safety_access_audit();
CREATE TRIGGER safety_access_audits_immutable
BEFORE UPDATE OR DELETE ON administration.safety_access_audits
FOR EACH ROW EXECUTE FUNCTION administration.reject_admin_action_log_mutation();

COMMENT ON TABLE administration.safety_access_audits IS
  'Required append-only support/appeal access outcomes linked to the exact admin attempt; no content.';
COMMENT ON CONSTRAINT reconciliation_runs_run_type_check ON billing.reconciliation_runs IS
  'Independently resumable billing, Nakh, chat and moderation integrity scanners.';
