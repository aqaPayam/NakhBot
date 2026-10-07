-- No ingress/worker activation: atomic admission must precede the complete purge saga.
CREATE TABLE identity.deletion_confirmations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  account_version integer NOT NULL CHECK (account_version >= 1),
  key_id text NOT NULL CHECK (key_id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','cancelled')),
  resolved_at timestamptz,
  UNIQUE (user_id,request_id),
  UNIQUE (id,user_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX deletion_confirmation_pending_user_idx
  ON identity.deletion_confirmations(user_id) WHERE status = 'pending';

CREATE FUNCTION identity.guard_deletion_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deletion authority requires controlled release' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.request_id,NEW.account_version,NEW.key_id,NEW.token_hash,
         NEW.created_at,NEW.expires_at) IS DISTINCT FROM
     ROW(OLD.id,OLD.user_id,OLD.request_id,OLD.account_version,OLD.key_id,OLD.token_hash,
         OLD.created_at,OLD.expires_at)
     OR OLD.status <> 'pending' OR NEW.status NOT IN ('consumed','cancelled')
     OR NEW.resolved_at IS NULL OR NEW.resolved_at < OLD.created_at
     OR (NEW.status = 'consumed' AND NEW.resolved_at >= OLD.expires_at) THEN
    RAISE EXCEPTION 'deletion confirmation transition invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deletion_confirmation_guard BEFORE UPDATE OR DELETE ON identity.deletion_confirmations
  FOR EACH ROW EXECUTE FUNCTION identity.guard_deletion_confirmation();

CREATE TABLE identity.account_deletion_records (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  confirmation_id uuid NOT NULL UNIQUE,
  account_version integer NOT NULL CHECK (account_version >= 2),
  history_id uuid NOT NULL UNIQUE REFERENCES identity.account_state_history(id) ON DELETE RESTRICT,
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  -- Transport rows can expire; the admission constraint verifies the required event at commit.
  event_id uuid NOT NULL UNIQUE,
  command_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL,
  checklist_version integer NOT NULL DEFAULT 1 CHECK (checklist_version = 1),
  requested_at timestamptz NOT NULL,
  purge_started_at timestamptz,
  shared_closed_at timestamptz,
  product_purged_at timestamptz,
  completed_at timestamptz,
  phase text NOT NULL DEFAULT 'shared_closure' CHECK (phase IN
    ('shared_closure','evidence_capture','product_data','media_objects','ephemeral_access','retention_manifest','verification','completed')),
  checkpoint_version integer NOT NULL DEFAULT 1 CHECK (checkpoint_version >= 1),
  reactivation_allowed boolean NOT NULL DEFAULT false CHECK (NOT reactivation_allowed),
  safety_bar text NOT NULL CHECK (safety_bar IN ('none','restricted','banned','unresolved')),
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  UNIQUE (id,user_id),
  FOREIGN KEY (confirmation_id,user_id) REFERENCES identity.deletion_confirmations(id,user_id) ON DELETE RESTRICT,
  CHECK ((phase = 'completed') = (completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);
CREATE UNIQUE INDEX account_deletion_pending_user_idx
  ON identity.account_deletion_records(user_id) WHERE completed_at IS NULL;
CREATE INDEX account_deletion_worker_idx ON identity.account_deletion_records(completed_at,requested_at,id);

CREATE TABLE identity.account_deletion_work (
  deletion_record_id uuid PRIMARY KEY REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  phase text NOT NULL DEFAULT 'shared_closure' CHECK (phase IN
    ('shared_closure','evidence_capture','product_data','media_objects','ephemeral_access','retention_manifest','verification','completed')),
  checkpoint_version integer NOT NULL DEFAULT 1 CHECK (checkpoint_version >= 1),
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner uuid,
  lease_expires_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX account_deletion_work_due_idx ON identity.account_deletion_work(available_at,deletion_record_id)
  WHERE phase <> 'completed';
CREATE TRIGGER account_deletion_work_delete_guard BEFORE DELETE ON identity.account_deletion_work
  FOR EACH ROW EXECUTE FUNCTION identity.reject_account_history_mutation();

-- Permanent content-free command receipts do not depend on the 24-hour transport cache.
CREATE TABLE identity.account_deletion_commands (
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  command_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  command_type text NOT NULL CHECK (command_type IN ('account.delete','account.cancel-deletion')),
  confirmation_id uuid NOT NULL,
  deletion_record_id uuid,
  account_version integer NOT NULL CHECK (account_version >= 1),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (user_id,idempotency_key),
  FOREIGN KEY (confirmation_id,user_id) REFERENCES identity.deletion_confirmations(id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (deletion_record_id,user_id) REFERENCES identity.account_deletion_records(id,user_id) ON DELETE RESTRICT,
  CHECK ((command_type = 'account.delete') = (deletion_record_id IS NOT NULL))
);
CREATE TRIGGER account_deletion_commands_immutable BEFORE UPDATE OR DELETE ON identity.account_deletion_commands
  FOR EACH ROW EXECUTE FUNCTION identity.reject_account_history_mutation();

CREATE FUNCTION identity.require_deletion_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity.accounts account
    JOIN identity.deletion_confirmations proof ON proof.id=NEW.confirmation_id AND proof.user_id=NEW.user_id
    JOIN identity.account_state_history history ON history.id=NEW.history_id AND history.user_id=NEW.user_id
    JOIN platform.audit_logs audit ON audit.id=NEW.audit_id
    JOIN platform.outbox_events event ON event.id=NEW.event_id
    JOIN identity.account_deletion_work work ON work.deletion_record_id=NEW.id
    JOIN identity.account_deletion_commands receipt ON receipt.deletion_record_id=NEW.id
    WHERE account.user_id=NEW.user_id AND account.state='deleted' AND account.version=NEW.account_version
      AND NEW.phase='shared_closure' AND NEW.checkpoint_version=1 AND NEW.completed_at IS NULL
      AND NOT NEW.reactivation_allowed
      AND NEW.safety_bar=CASE history.previous_state WHEN 'banned' THEN 'banned'
        WHEN 'restricted' THEN 'restricted' ELSE 'none' END
      AND proof.status='consumed' AND proof.account_version=NEW.account_version-1
      AND proof.resolved_at=NEW.requested_at AND NEW.requested_at<proof.expires_at
      AND history.previous_state IS NOT NULL AND history.next_state='deleted'
      AND history.actor_type='user' AND history.actor_user_id=NEW.user_id
      AND history.reason_code='user_deletion' AND history.changed_at=NEW.requested_at
      AND audit.category='account' AND audit.event_type='account.deletion-requested.v1'
      AND audit.actor_type='user' AND audit.actor_user_id=NEW.user_id AND audit.actor_admin_id IS NULL
      AND audit.subject_type='user' AND audit.subject_id=NEW.user_id AND audit.result_code='deleted'
      AND audit.command_id=NEW.command_id AND audit.request_id=NEW.request_id
      AND audit.metadata_schema_version=1 AND audit.metadata='{}'::jsonb AND audit.occurred_at=NEW.requested_at
      AND event.aggregate_type='account_deletion' AND event.aggregate_id=NEW.id
      AND event.event_type='account.deletion-requested.v1' AND event.schema_version=1
      AND event.payload=jsonb_build_object('deletionRecordId',NEW.id,'step','shared_closure')
      AND event.causation_id=NEW.command_id AND event.correlation_id=NEW.request_id
      AND work.phase='shared_closure' AND work.checkpoint_version=1
      AND receipt.user_id=NEW.user_id AND receipt.command_id=NEW.command_id AND receipt.request_id=NEW.request_id
      AND receipt.command_type='account.delete' AND receipt.confirmation_id=NEW.confirmation_id
      AND receipt.account_version=NEW.account_version
  ) THEN
    RAISE EXCEPTION 'deletion admission chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_deletion_admission_required AFTER INSERT ON identity.account_deletion_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_deletion_admission();

CREATE FUNCTION identity.guard_deletion_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE phases text[] := ARRAY['shared_closure','evidence_capture','product_data','media_objects',
  'ephemeral_access','retention_manifest','verification','completed'];
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'deletion history requires controlled release' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.confirmation_id,NEW.account_version,NEW.history_id,NEW.audit_id,
         NEW.event_id,NEW.command_id,NEW.request_id,NEW.checklist_version,NEW.requested_at,NEW.safety_bar)
     IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.confirmation_id,OLD.account_version,OLD.history_id,OLD.audit_id,
         OLD.event_id,OLD.command_id,OLD.request_id,OLD.checklist_version,OLD.requested_at,OLD.safety_bar)
     OR OLD.phase='completed'
     OR (NEW.phase <> OLD.phase AND (array_position(phases,NEW.phase) <> array_position(phases,OLD.phase)+1
         OR NEW.checkpoint_version <> OLD.checkpoint_version+1))
     OR (NEW.phase=OLD.phase AND NEW.checkpoint_version<>OLD.checkpoint_version) THEN
    RAISE EXCEPTION 'deletion checkpoint transition invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_deletion_checkpoint_guard BEFORE UPDATE OR DELETE ON identity.account_deletion_records
  FOR EACH ROW EXECUTE FUNCTION identity.guard_deletion_checkpoint();

INSERT INTO catalog.ui_texts(id,locale_code,text_key,value,category,created_at,updated_at)
SELECT md5('m8-deletion:'||locale.code||':'||message.key)::uuid,locale.code,message.key,
  CASE WHEN locale.code='fa' THEN message.fa ELSE message.en END,'error',now(),now()
FROM catalog.locales locale CROSS JOIN (VALUES
  ('error.deletion.confirmation_invalid','Prepare a new deletion confirmation.','تأیید حذف جدیدی درخواست کنید.'),
  ('error.deletion.unavailable','Account deletion is unavailable.','حذف حساب در دسترس نیست.'),
  ('error.deletion.checkpoint_conflict','Deletion progress changed. Please retry.','وضعیت حذف تغییر کرده است. دوباره تلاش کنید.')
) message(key,en,fa);
