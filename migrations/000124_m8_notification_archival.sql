-- Ordinary Notice removal retains only original identity/lives and audited proof.
CREATE TABLE identity.account_deletion_notice_receipts (
  id uuid PRIMARY KEY,
  notice_id uuid NOT NULL UNIQUE REFERENCES notification.notice_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  batch_transaction xid8 NOT NULL,
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE
);
CREATE INDEX deletion_notice_receipts_root_idx ON identity.account_deletion_notice_receipts(deletion_record_id,id);

CREATE FUNCTION identity.notice_receipt_digest(receipt identity.account_deletion_notice_receipts)
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('id',receipt.id,'noticeId',receipt.notice_id,
    'deletionRecordId',receipt.deletion_record_id,'transaction',receipt.batch_transaction::text,
    'owner',receipt.lease_owner,'generation',receipt.lease_generation,
    'leaseExpiresAt',(extract(epoch FROM receipt.lease_expires_at)*1000000)::bigint,
    'archivedAt',(extract(epoch FROM receipt.archived_at)*1000000)::bigint,
    'auditId',receipt.audit_id,'eventId',receipt.event_id,
    'recipient',anchor.user_id,'epoch',anchor.product_epoch,'type',anchor.notification_type,'emptyPayload',anchor.empty_payload,'thresholdEpisode',anchor.threshold_episode_id)::text,'UTF8')),'hex')
  FROM notification.notice_reference_anchors anchor WHERE anchor.id=receipt.notice_id
$$;

-- Authenticate original removal independently of funding checks. Historical
-- authenticity never grants a new transaction authority or product access.
CREATE FUNCTION identity.notice_receipt_proof_valid(receipt identity.account_deletion_notice_receipts)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM notification.notice_reference_anchors anchor
    JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE anchor.id=receipt.notice_id
      AND (root.user_id=anchor.user_id AND root.product_epoch=anchor.product_epoch)
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND audit.category='account' AND audit.event_type='account.deletion-notice-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.result_code='notice_archived' AND audit.metadata_schema_version=1
      AND audit.metadata=jsonb_build_object('kind','notice_source','rows',1,'receiptDigest',identity.notice_receipt_digest(receipt))
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=receipt.archived_at)
$$;

CREATE FUNCTION identity.notice_receipt_fence(receipt identity.account_deletion_notice_receipts)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT receipt.batch_transaction=pg_current_xact_id() AND EXISTS(
    SELECT 1 FROM identity.account_deletion_records root JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN notification.notice_reference_anchors anchor ON anchor.id=receipt.notice_id
    WHERE root.id=receipt.deletion_record_id AND root.phase='product_data' AND root.checkpoint_version=3
      AND root.checklist_version=1 AND root.product_purged_at IS NULL AND root.completed_at IS NULL AND NOT root.reactivation_allowed
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<=clock_timestamp()
      AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
      AND (root.user_id=anchor.user_id AND root.product_epoch=anchor.product_epoch)
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND identity.deletion_evidence_blocker(root.id,root.user_id) IS NULL)
$$;


CREATE FUNCTION notification.notice_source_archivable(subject uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM notification.notice_reference_anchors anchor WHERE anchor.id=subject
    AND (EXISTS(SELECT 1 FROM notification.notifications original WHERE original.id=anchor.id
      AND original.user_id=anchor.user_id AND original.product_epoch=anchor.product_epoch
      AND original.notification_type=anchor.notification_type AND (original.payload='{}'::jsonb)=anchor.empty_payload
      AND anchor.threshold_episode_id IS NOT DISTINCT FROM notification.original_threshold_notice_binding(original.id)
      AND NOT EXISTS(SELECT 1 FROM notification.notification_deliveries delivery WHERE delivery.notification_id=original.id
        AND (delivery.lease_expires_at>clock_timestamp() OR delivery.provider_progress='call_started')))
    OR (NOT EXISTS(SELECT 1 FROM notification.notifications WHERE id=subject)
      AND EXISTS(SELECT 1 FROM identity.account_deletion_notice_receipts receipt WHERE receipt.notice_id=subject
        AND identity.notice_receipt_proof_valid(receipt)))))
$$;
CREATE FUNCTION identity.guard_notice_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'notice receipt requires controlled release' USING ERRCODE='55000'; END IF;
  IF NOT identity.notice_receipt_fence(NEW) OR NOT EXISTS(SELECT 1 FROM notification.notifications WHERE id=NEW.notice_id)
    OR notification.notice_source_archivable(NEW.notice_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'notice source, delivery drain or owning fence missing' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notice_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_notice_receipts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_notice_archival_receipt();
CREATE OR REPLACE FUNCTION notification.require_notice_archival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM identity.account_deletion_notice_receipts receipt WHERE receipt.notice_id=OLD.id
    AND identity.notice_receipt_fence(receipt) AND identity.notice_receipt_proof_valid(receipt)
    AND notification.notice_source_archivable(OLD.id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'notice removal lacks exact owned archival transaction' USING ERRCODE='55000';
END $$;
CREATE FUNCTION identity.require_notice_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT identity.notice_receipt_fence(NEW) OR NOT identity.notice_receipt_proof_valid(NEW)
    OR EXISTS(SELECT 1 FROM notification.notifications WHERE id=NEW.notice_id)
    OR EXISTS(SELECT 1 FROM notification.notification_deliveries WHERE notification_id=NEW.notice_id)
    OR notification.notice_source_archivable(NEW.notice_id) IS NOT TRUE
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event JOIN identity.account_deletion_records root ON root.id=NEW.deletion_record_id
      WHERE event.id=NEW.event_id AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
        AND event.event_type='account.deletion-notice-batch.v1' AND event.schema_version=1
        AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','notice_source','rows',1,'auditId',NEW.audit_id)
        AND event.correlation_id=root.request_id AND event.causation_id=root.command_id
        AND event.occurred_at=NEW.archived_at AND event.available_at=NEW.archived_at) THEN
    RAISE EXCEPTION 'notice removal, lease or mandatory proof incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER notice_archival_receipt_required AFTER INSERT ON identity.account_deletion_notice_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_notice_archival_receipt();

CREATE FUNCTION notification.purge_deletion_notice_source(deletion_id uuid,subject uuid,worker uuid,generation integer)
RETURNS TABLE(purged_rows integer,has_more boolean,waiting_for_delivery boolean) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work; original notification.notifications;
  proof identity.account_deletion_notice_receipts; writes integer; original_id uuid;
BEGIN
  PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=deletion_id AND user_id=subject FOR UPDATE;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=deletion_id FOR UPDATE;
  IF root.id IS NULL OR job.deletion_record_id IS NULL OR root.phase<>'product_data' OR root.checkpoint_version<>3
    OR root.checklist_version<>1 OR root.product_purged_at IS NOT NULL OR root.completed_at IS NOT NULL OR root.reactivation_allowed
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS DISTINCT FROM worker OR job.lease_generation IS DISTINCT FROM generation
    OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted' AND version=root.account_version AND product_epoch=root.product_epoch)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=root.id
      AND completed_phase='evidence_capture' AND next_phase='product_data' AND from_checkpoint_version=2 AND next_checkpoint_version=3)
    OR identity.deletion_evidence_blocker(root.id,subject) IS NOT NULL THEN
    RAISE EXCEPTION 'notice archival current owning lease missing' USING ERRCODE='40001'; END IF;
  purged_rows:=0;waiting_for_delivery:=false;
  SELECT * INTO original FROM notification.notifications WHERE user_id=subject ORDER BY id LIMIT 1 FOR UPDATE;
  IF original.id IS NOT NULL THEN
    IF original.product_epoch<>root.product_epoch THEN RAISE EXCEPTION 'notice original life mismatch' USING ERRCODE='23514'; END IF;
    PERFORM id FROM notification.notification_deliveries WHERE notification_id=original.id ORDER BY id FOR UPDATE;
    -- Preserve original Nakh notice counts until their immutable source summary exists.
    IF EXISTS(SELECT 1 FROM nakh.nakhes WHERE subject IN(sender_user_id,receiver_user_id))
      OR EXISTS(SELECT 1 FROM notification.notification_deliveries WHERE notification_id=original.id
        AND (lease_expires_at>clock_timestamp() OR provider_progress='call_started')) THEN waiting_for_delivery:=true;
    ELSE
      INSERT INTO notification.notice_reference_anchors
        SELECT original.id,original.user_id,original.product_epoch,original.notification_type,
          original.payload='{}'::jsonb,notification.original_threshold_notice_binding(original.id) ON CONFLICT(id) DO NOTHING;
      IF notification.notice_source_archivable(original.id) IS NOT TRUE THEN RAISE EXCEPTION 'notice original proof incomplete' USING ERRCODE='23514'; END IF;
      proof.id:=gen_random_uuid();proof.notice_id:=original.id;proof.deletion_record_id:=root.id;
      proof.batch_transaction:=pg_current_xact_id();proof.lease_owner:=worker;proof.lease_generation:=generation;
      proof.lease_expires_at:=job.lease_expires_at;proof.archived_at:=clock_timestamp();proof.audit_id:=gen_random_uuid();proof.event_id:=gen_random_uuid();
      INSERT INTO identity.account_deletion_notice_receipts SELECT proof.*;
      GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'notice receipt missing' USING ERRCODE='23514'; END IF;
      INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
      VALUES(proof.audit_id,'account','account.deletion-notice-batch.v1','system','account_deletion',root.id,'notice_archived',1,
        jsonb_build_object('kind','notice_source','rows',1,'receiptDigest',identity.notice_receipt_digest(proof)),root.command_id,root.request_id,proof.archived_at);
      GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'notice audit missing' USING ERRCODE='23514'; END IF;
      INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
      VALUES(proof.event_id,'account_deletion',root.id,'account.deletion-notice-batch.v1',1,
        jsonb_build_object('deletionRecordId',root.id,'kind','notice_source','rows',1,'auditId',proof.audit_id),proof.archived_at,proof.archived_at,root.request_id,root.command_id);
      GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'notice event missing' USING ERRCODE='23514'; END IF;
      DELETE FROM notification.notifications WHERE id=original.id;
      GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'notice removal missing' USING ERRCODE='23514'; END IF;
      purged_rows:=1;
    END IF;
  ELSE
    FOR original_id IN SELECT anchor.id FROM notification.notice_reference_anchors anchor WHERE anchor.user_id=subject
      UNION SELECT receipt.notice_id FROM identity.account_deletion_notice_receipts receipt
        JOIN identity.account_deletion_records owning ON owning.id=receipt.deletion_record_id WHERE owning.user_id=subject
      UNION SELECT action.notification_id FROM moderation.moderation_actions action WHERE action.target_user_id=subject AND action.notification_id IS NOT NULL
    LOOP
      IF notification.notice_source_archivable(original_id) IS NOT TRUE THEN RAISE EXCEPTION 'notice replay proof incomplete' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  IF job.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'notice archival lease expired' USING ERRCODE='40001'; END IF;
  SELECT EXISTS(SELECT 1 FROM notification.notifications WHERE user_id=subject) INTO has_more;
  RETURN NEXT;
END $$;

-- Historical safety facts only, with an independently authenticated receipt.
-- No normal notification renderer or delivery admission uses this view.
CREATE VIEW notification.archived_notice_facts AS
  SELECT anchor.id,anchor.user_id,anchor.product_epoch,anchor.notification_type,anchor.empty_payload,anchor.threshold_episode_id
  FROM notification.notice_reference_anchors anchor JOIN identity.account_deletion_notice_receipts receipt ON receipt.notice_id=anchor.id
  WHERE NOT EXISTS(SELECT 1 FROM notification.notifications WHERE id=anchor.id)
    AND identity.notice_receipt_proof_valid(receipt);

-- Advancing past product cleanup cannot reopen ordinary notification storage.
-- Original financial correction producers suppress these product projections.
CREATE FUNCTION notification.guard_post_purge_notice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- This trigger sorts before the original recipient-life trigger. Acquire the
  -- Account here too, then read the checkpoint after any committing wait.
  PERFORM user_id FROM identity.accounts WHERE user_id=NEW.user_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM identity.accounts owner JOIN identity.account_deletion_records root
    ON root.user_id=owner.user_id AND root.product_epoch=owner.product_epoch
    WHERE owner.user_id=NEW.user_id AND owner.state='deleted' AND root.checkpoint_version>=4) THEN
    RAISE EXCEPTION 'notice recipient product purge already verified' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER notice_post_purge_guard BEFORE INSERT ON notification.notifications
  FOR EACH ROW EXECUTE FUNCTION notification.guard_post_purge_notice();
