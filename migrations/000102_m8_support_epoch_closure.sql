-- Retained support content stays immutable; ordinary access belongs to its
-- original product life and a phase-3 worker may close only that original scope.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM support.support_threads thread LEFT JOIN identity.accounts owner ON owner.user_id=thread.user_id
    WHERE owner.user_id IS NULL OR owner.product_epoch<>0) THEN
    RAISE EXCEPTION 'legacy support lifecycle is unexplained' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE support.support_threads ADD COLUMN product_epoch integer NOT NULL DEFAULT 0 CHECK(product_epoch>=0);
ALTER TABLE support.support_threads ADD CONSTRAINT support_thread_original_epoch_unique UNIQUE(id,user_id,product_epoch);

CREATE TABLE support.deletion_thread_closures (
  support_thread_id uuid PRIMARY KEY,
  deletion_record_id uuid NOT NULL,
  user_id uuid NOT NULL,
  product_epoch integer NOT NULL CHECK(product_epoch>=0),
  source_version integer NOT NULL CHECK(source_version>=1),
  source_last_message_at timestamptz NOT NULL,
  source_created_at timestamptz NOT NULL,
  source_open_command_id uuid NOT NULL,
  source_open_request_digest text NOT NULL CHECK(source_open_request_digest~'^[0-9a-f]{64}$'),
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  closed_at timestamptz NOT NULL CHECK(closed_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE,
  FOREIGN KEY(support_thread_id,user_id,product_epoch) REFERENCES support.support_threads(id,user_id,product_epoch) ON DELETE RESTRICT,
  FOREIGN KEY(deletion_record_id,user_id) REFERENCES identity.account_deletion_records(id,user_id) ON DELETE RESTRICT
);
CREATE INDEX deletion_thread_closures_root_idx ON support.deletion_thread_closures(deletion_record_id,support_thread_id);

CREATE FUNCTION support.deletion_thread_lease_authority(receipt support.deletion_thread_closures)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.accounts owner ON owner.user_id=root.user_id
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    WHERE root.id=receipt.deletion_record_id AND root.user_id=receipt.user_id AND root.product_epoch=receipt.product_epoch
      AND owner.state='deleted' AND owner.product_epoch=root.product_epoch AND owner.version=root.account_version
      AND root.phase='product_data' AND root.checkpoint_version=3 AND root.checklist_version=1
      AND root.completed_at IS NULL AND root.product_purged_at IS NULL AND NOT root.reactivation_allowed
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.closed_at>=root.requested_at AND receipt.closed_at<=clock_timestamp()
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=root.id
        AND prior.completed_phase='evidence_capture' AND prior.next_phase='product_data'
        AND prior.from_checkpoint_version=2 AND prior.next_checkpoint_version=3))
$$;

CREATE FUNCTION support.guard_deletion_thread_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'support deletion closure is immutable' USING ERRCODE='55000'; END IF;
  IF NOT support.deletion_thread_lease_authority(NEW)
    OR NOT EXISTS(SELECT 1 FROM support.support_threads thread WHERE thread.id=NEW.support_thread_id
      AND thread.user_id=NEW.user_id AND thread.product_epoch=NEW.product_epoch AND thread.status='open'
      AND thread.version=NEW.source_version AND thread.last_message_at=NEW.source_last_message_at
      AND thread.created_at=NEW.source_created_at AND thread.open_command_id=NEW.source_open_command_id
      AND thread.open_request_digest=NEW.source_open_request_digest) THEN
    RAISE EXCEPTION 'support closure lacks original deletion authority' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deletion_thread_closure_guard BEFORE INSERT OR UPDATE OR DELETE ON support.deletion_thread_closures
FOR EACH ROW EXECUTE FUNCTION support.guard_deletion_thread_closure();

CREATE FUNCTION support.guard_thread_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner identity.accounts;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'support history requires approved release' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND NEW.product_epoch<>OLD.product_epoch THEN
    RAISE EXCEPTION 'support original lifecycle is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM id FROM identity.users WHERE id=NEW.user_id FOR NO KEY UPDATE;
  SELECT * INTO owner FROM identity.accounts WHERE user_id=NEW.user_id FOR UPDATE;
  IF owner.user_id IS NULL OR owner.product_epoch<>NEW.product_epoch
    OR (TG_OP='INSERT' AND owner.state IN ('banned','deleted')) THEN
    RAISE EXCEPTION 'support original lifecycle is unavailable' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_thread_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON support.support_threads
FOR EACH ROW EXECUTE FUNCTION support.guard_thread_epoch();

CREATE FUNCTION support.guard_message_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE thread support.support_threads; owner identity.accounts;
BEGIN
  SELECT * INTO thread FROM support.support_threads WHERE id=NEW.support_thread_id;
  PERFORM id FROM identity.users WHERE id=thread.user_id FOR NO KEY UPDATE;
  SELECT * INTO owner FROM identity.accounts WHERE user_id=thread.user_id FOR UPDATE;
  PERFORM id FROM support.support_threads WHERE id=thread.id FOR SHARE;
  IF owner.user_id IS NULL OR owner.product_epoch<>thread.product_epoch
    OR EXISTS(SELECT 1 FROM support.deletion_thread_closures WHERE support_thread_id=thread.id)
    OR (NEW.sender_type='user' AND (NEW.sender_user_id IS DISTINCT FROM thread.user_id OR owner.state IN ('banned','deleted'))) THEN
    RAISE EXCEPTION 'support message original lifecycle is unavailable' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER support_message_epoch_guard BEFORE INSERT ON support.support_messages
FOR EACH ROW EXECUTE FUNCTION support.guard_message_epoch();

CREATE FUNCTION support.require_thread_epoch_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM identity.accounts owner WHERE owner.user_id=NEW.user_id AND owner.product_epoch=NEW.product_epoch)
    OR (TG_OP='INSERT' AND EXISTS(SELECT 1 FROM identity.accounts owner WHERE owner.user_id=NEW.user_id AND owner.state IN ('banned','deleted'))) THEN
    RAISE EXCEPTION 'support thread final lifecycle changed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER support_thread_epoch_commit_guard AFTER INSERT OR UPDATE ON support.support_threads
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION support.require_thread_epoch_commit();
CREATE FUNCTION support.require_message_epoch_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM support.support_threads thread JOIN identity.accounts owner ON owner.user_id=thread.user_id
      WHERE thread.id=NEW.support_thread_id AND owner.product_epoch=thread.product_epoch
        AND NOT EXISTS(SELECT 1 FROM support.deletion_thread_closures WHERE support_thread_id=thread.id)
        AND (NEW.sender_type<>'user' OR (NEW.sender_user_id=thread.user_id AND owner.state NOT IN ('banned','deleted')))) THEN
    RAISE EXCEPTION 'support message final lifecycle changed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER support_message_epoch_commit_guard AFTER INSERT ON support.support_messages
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION support.require_message_epoch_commit();

-- Historical proof does not depend on a still-live lease or transport event.
-- The actual insertion/commit guards establish those transient obligations.
CREATE FUNCTION support.deletion_thread_has_bound_closure(subject uuid,original_version integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM support.deletion_thread_closures receipt
    JOIN support.support_threads thread ON thread.id=receipt.support_thread_id
    JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE receipt.support_thread_id=subject AND receipt.source_version=original_version
      AND thread.user_id=receipt.user_id AND thread.product_epoch=receipt.product_epoch
      AND thread.status='closed' AND thread.version=receipt.source_version+1 AND thread.closed_at=receipt.closed_at
      AND thread.last_message_at=receipt.source_last_message_at AND thread.created_at=receipt.source_created_at
      AND thread.open_command_id=receipt.source_open_command_id AND thread.open_request_digest=receipt.source_open_request_digest
      AND root.user_id=receipt.user_id AND root.product_epoch=receipt.product_epoch AND root.requested_at<=receipt.closed_at
      AND audit.category='account' AND audit.event_type='account.deletion-support-closed.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='support_scope_closed'
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.metadata_schema_version=1
      AND audit.metadata='{"kind":"support_scope","count":1}'::jsonb AND audit.occurred_at=receipt.closed_at)
$$;

CREATE FUNCTION support.require_deletion_thread_closure_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT support.deletion_thread_lease_authority(NEW)
    OR NOT support.deletion_thread_has_bound_closure(NEW.support_thread_id,NEW.source_version)
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event JOIN identity.account_deletion_records root ON root.id=NEW.deletion_record_id
      WHERE event.id=NEW.event_id AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
        AND event.event_type='account.deletion-support-closed.v1' AND event.schema_version=1
        AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','support_scope','count',1)
        AND event.causation_id=root.command_id AND event.correlation_id=root.request_id
        AND event.occurred_at=NEW.closed_at AND event.available_at=NEW.closed_at) THEN
    RAISE EXCEPTION 'support deletion closure chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER deletion_thread_closure_commit_guard AFTER INSERT ON support.deletion_thread_closures
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION support.require_deletion_thread_closure_commit();

COMMENT ON TABLE support.deletion_thread_closures IS 'Audited original-life support closure; retained transcripts stay immutable and approved release stays disabled.';
