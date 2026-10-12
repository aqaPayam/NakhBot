-- Ordinary Flow removal retains only original identity/lives and audited proof.
CREATE TABLE identity.account_deletion_flow_receipts (
  id uuid PRIMARY KEY,
  flow_id uuid NOT NULL UNIQUE REFERENCES nakh.flow_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  batch_transaction xid8 NOT NULL,
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE
);
CREATE INDEX deletion_flow_receipts_root_idx ON identity.account_deletion_flow_receipts(deletion_record_id,id);

CREATE FUNCTION identity.flow_receipt_digest(receipt identity.account_deletion_flow_receipts)
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('id',receipt.id,'flowId',receipt.flow_id,
    'deletionRecordId',receipt.deletion_record_id,'transaction',receipt.batch_transaction::text,
    'owner',receipt.lease_owner,'generation',receipt.lease_generation,
    'leaseExpiresAt',(extract(epoch FROM receipt.lease_expires_at)*1000000)::bigint,
    'archivedAt',(extract(epoch FROM receipt.archived_at)*1000000)::bigint,
    'auditId',receipt.audit_id,'eventId',receipt.event_id,
    'sender',anchor.sender_user_id,'receiver',anchor.receiver_user_id,
    'senderEpoch',anchor.sender_product_epoch,'receiverEpoch',anchor.receiver_product_epoch)::text,'UTF8')),'hex')
  FROM nakh.flow_reference_anchors anchor WHERE anchor.id=receipt.flow_id
$$;

-- No financial reader is called here: those readers use this proof after raw
-- removal. Historical authenticity never grants a new transaction authority.
CREATE FUNCTION identity.flow_receipt_proof_valid(receipt identity.account_deletion_flow_receipts)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.flow_reference_anchors anchor
    JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE anchor.id=receipt.flow_id
      AND ((root.user_id=anchor.sender_user_id AND root.product_epoch=anchor.sender_product_epoch)
        OR (root.user_id=anchor.receiver_user_id AND root.product_epoch=anchor.receiver_product_epoch))
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND audit.category='account' AND audit.event_type='account.deletion-flow-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.result_code='flow_archived' AND audit.metadata_schema_version=1
      AND audit.metadata=jsonb_build_object('kind','flow_source','rows',1,'receiptDigest',identity.flow_receipt_digest(receipt))
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=receipt.archived_at)
$$;

CREATE VIEW nakh.flow_lifecycle_facts AS
  SELECT flow.id,flow.sender_user_id,flow.receiver_user_id,flow.sender_product_epoch,flow.receiver_product_epoch,
    EXISTS(SELECT 1 FROM nakh.flow_reference_anchors anchor WHERE anchor.id=flow.id
      AND anchor.sender_user_id=flow.sender_user_id AND anchor.receiver_user_id=flow.receiver_user_id
      AND anchor.sender_product_epoch=flow.sender_product_epoch AND anchor.receiver_product_epoch=flow.receiver_product_epoch) AS shape_valid
  FROM nakh.nakh_flows flow
  UNION ALL
  SELECT receipt.flow_id,anchor.sender_user_id,anchor.receiver_user_id,anchor.sender_product_epoch,anchor.receiver_product_epoch,
    identity.flow_receipt_proof_valid(receipt)
  FROM identity.account_deletion_flow_receipts receipt LEFT JOIN nakh.flow_reference_anchors anchor ON anchor.id=receipt.flow_id
  WHERE NOT EXISTS(SELECT 1 FROM nakh.nakh_flows flow WHERE flow.id=receipt.flow_id)
  UNION ALL
  SELECT anchor.id,anchor.sender_user_id,anchor.receiver_user_id,anchor.sender_product_epoch,anchor.receiver_product_epoch,false
  FROM nakh.flow_reference_anchors anchor
  WHERE NOT EXISTS(SELECT 1 FROM nakh.nakh_flows WHERE id=anchor.id)
    AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_flow_receipts WHERE flow_id=anchor.id);
CREATE VIEW nakh.verified_original_flow_lives AS SELECT * FROM nakh.flow_lifecycle_facts WHERE shape_valid;
CREATE OR REPLACE FUNCTION nakh.original_flow_reference_valid(subject uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.flow_lifecycle_facts WHERE id=subject AND shape_valid)
$$;

CREATE FUNCTION identity.flow_receipt_fence(receipt identity.account_deletion_flow_receipts)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT receipt.batch_transaction=pg_current_xact_id() AND EXISTS(
    SELECT 1 FROM identity.account_deletion_records root JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN nakh.flow_reference_anchors anchor ON anchor.id=receipt.flow_id
    WHERE root.id=receipt.deletion_record_id AND root.phase='product_data' AND root.checkpoint_version=3
      AND root.checklist_version=1 AND root.product_purged_at IS NULL AND root.completed_at IS NULL AND NOT root.reactivation_allowed
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<=clock_timestamp()
      AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
      AND ((root.user_id=anchor.sender_user_id AND root.product_epoch=anchor.sender_product_epoch)
        OR (root.user_id=anchor.receiver_user_id AND root.product_epoch=anchor.receiver_product_epoch))
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND identity.deletion_evidence_blocker(root.id,root.user_id) IS NULL)
$$;

CREATE FUNCTION nakh.flow_source_archivable(subject uuid) RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE pending nakh.pending_nakh_lifecycle_facts; delivered nakh.nakh_lifecycle_facts; proof identity.account_deletion_nakh_receipts;
  pending_count integer; delivered_count integer; matches integer;
BEGIN
  IF NOT nakh.original_flow_reference_valid(subject)
    OR EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE nakh_flow_id=subject)
    OR EXISTS(SELECT 1 FROM nakh.nakhes WHERE nakh_flow_id=subject) THEN RETURN false; END IF;
  SELECT count(*) INTO pending_count FROM nakh.pending_nakh_reference_anchors WHERE nakh_flow_id=subject;
  SELECT count(*) INTO delivered_count FROM nakh.nakh_reference_anchors WHERE nakh_flow_id=subject;
  IF pending_count>1 OR delivered_count>1 OR pending_count+delivered_count=0 THEN RETURN false; END IF;
  IF delivered_count=1 THEN
    SELECT source.* INTO delivered FROM nakh.nakh_lifecycle_facts source WHERE source.nakh_flow_id=subject;
    SELECT * INTO proof FROM identity.account_deletion_nakh_receipts WHERE nakh_id=delivered.id AND final_batch;
    SELECT count(*) INTO matches FROM matching.match_lifecycle_facts match WHERE match.source='nakh_accept'
      AND match.source_nakh_id=delivered.id AND match.user_low_id=LEAST(delivered.sender_user_id,delivered.receiver_user_id)
      AND match.user_high_id=GREATEST(delivered.sender_user_id,delivered.receiver_user_id);
    IF delivered.id IS NULL OR proof.id IS NULL OR delivered.status NOT IN ('accepted','rejected','expired','closed')
      OR delivered.history_count IS DISTINCT FROM delivered.version OR delivered.history_min_version IS DISTINCT FROM 1
      OR delivered.history_max_version IS DISTINCT FROM delivered.version OR delivered.history_last_status IS DISTINCT FROM delivered.status
      OR delivered.notification_count IS DISTINCT FROM 1
      OR (delivered.status='accepted' AND matches<>1) OR (delivered.status<>'accepted' AND matches<>0)
      OR NOT nakh.original_funded_scope_valid(delivered.id,subject,delivered.sender_user_id,delivered.receiver_user_id,
        delivered.funding_type,delivered.credit_transaction_id,delivered.payment_record_id)
      OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_records root JOIN platform.audit_logs audit ON audit.id=proof.audit_id
        WHERE root.id=proof.deletion_record_id AND proof.source_version=delivered.version
          AND ((root.user_id=delivered.sender_user_id AND root.product_epoch=delivered.sender_product_epoch)
            OR (root.user_id=delivered.receiver_user_id AND root.product_epoch=delivered.receiver_product_epoch))
          AND proof.archived_at>=root.requested_at AND proof.archived_at<proof.lease_expires_at
          AND proof.removed_actions=proof.before_actions AND proof.removed_history=proof.source_version
          AND audit.category='account' AND audit.event_type='account.deletion-nakh-batch.v1'
          AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
          AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='nakh_batch_archived'
          AND audit.metadata_schema_version=1 AND audit.metadata=jsonb_build_object('kind','nakh_source',
            'rows',proof.removed_actions+proof.removed_history+1,'final',true)
          AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=proof.archived_at) THEN RETURN false; END IF;
  END IF;
  IF pending_count=1 THEN
    SELECT source.* INTO pending FROM nakh.pending_nakh_lifecycle_facts source WHERE source.nakh_flow_id=subject;
    IF pending.id IS NULL OR pending.shape_valid IS NOT TRUE THEN RETURN false; END IF;
    IF pending.status='paid_and_sent' THEN
      IF delivered_count<>1 OR nakh.paid_pending_source_archivable(pending,delivered.id) IS NOT TRUE THEN RETURN false; END IF;
    ELSIF pending.status IN ('cancelled','expired','closed_by_system') THEN
      IF delivered_count<>0 OR nakh.terminal_pending_closure_valid(pending) IS NOT TRUE THEN RETURN false; END IF;
    ELSE RETURN false; END IF;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION identity.guard_flow_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Flow receipt requires controlled retained release' USING ERRCODE='55000'; END IF;
  IF NOT identity.flow_receipt_fence(NEW) OR NOT EXISTS(SELECT 1 FROM nakh.nakh_flows WHERE id=NEW.flow_id)
    OR nakh.flow_source_archivable(NEW.flow_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Flow original source, financial closure or fence missing' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER flow_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_flow_receipts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_flow_archival_receipt();

CREATE OR REPLACE FUNCTION nakh.reject_nakh_flow_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM identity.account_deletion_flow_receipts receipt
      WHERE receipt.flow_id=OLD.id AND identity.flow_receipt_fence(receipt)
        AND identity.flow_receipt_proof_valid(receipt) AND nakh.flow_source_archivable(OLD.id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Flow mutation lacks its exact current archival transaction' USING ERRCODE='55000';
END $$;

CREATE FUNCTION identity.require_flow_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT identity.flow_receipt_fence(NEW) OR EXISTS(SELECT 1 FROM nakh.nakh_flows WHERE id=NEW.flow_id)
    OR NOT identity.flow_receipt_proof_valid(NEW) OR nakh.flow_source_archivable(NEW.flow_id) IS NOT TRUE
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event JOIN identity.account_deletion_records root ON root.id=NEW.deletion_record_id
      WHERE event.id=NEW.event_id AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
        AND event.event_type='account.deletion-flow-batch.v1' AND event.schema_version=1
        AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','flow_source','rows',1,'auditId',NEW.audit_id)
        AND event.correlation_id=root.request_id AND event.causation_id=root.command_id
        AND event.occurred_at=NEW.archived_at AND event.available_at=NEW.archived_at) THEN
    RAISE EXCEPTION 'Flow removal, lease or mandatory proof incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER flow_archival_receipt_required AFTER INSERT ON identity.account_deletion_flow_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_flow_archival_receipt();

CREATE FUNCTION nakh.purge_deletion_flow_source(deletion_id uuid,subject uuid,worker uuid,generation integer)
RETURNS TABLE(purged_rows integer,has_more boolean) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work;
  source nakh.nakh_flows; proof identity.account_deletion_flow_receipts; candidate uuid; counterpart uuid; writes integer; original_id uuid;
BEGIN
  SELECT flow.id,CASE WHEN flow.sender_user_id=subject THEN flow.receiver_user_id ELSE flow.sender_user_id END
    INTO candidate,counterpart FROM nakh.nakh_flows flow
    LEFT JOIN nakh.flow_reference_anchors anchor ON anchor.id=flow.id
    WHERE subject IN (flow.sender_user_id,flow.receiver_user_id,anchor.sender_user_id,anchor.receiver_user_id)
    ORDER BY flow.id LIMIT 1;
  IF counterpart IS NOT NULL THEN
    PERFORM user_id FROM platform.user_counters WHERE user_id IN (subject,counterpart) ORDER BY user_id FOR UPDATE;
    PERFORM interaction.lock_user_pair(LEAST(subject,counterpart),GREATEST(subject,counterpart));
  END IF;
  PERFORM id FROM identity.users WHERE id IN (subject,counterpart) ORDER BY id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id IN (subject,counterpart) ORDER BY user_id FOR UPDATE;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=deletion_id AND user_id=subject FOR UPDATE;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=deletion_id FOR UPDATE;
  proof.id:=gen_random_uuid(); proof.flow_id:=candidate; proof.deletion_record_id:=deletion_id;
  proof.batch_transaction:=pg_current_xact_id(); proof.lease_owner:=worker; proof.lease_generation:=generation;
  proof.lease_expires_at:=job.lease_expires_at; proof.archived_at:=clock_timestamp();
  proof.audit_id:=gen_random_uuid(); proof.event_id:=gen_random_uuid();
  IF root.id IS NULL OR job.deletion_record_id IS NULL OR root.phase<>'product_data' OR root.checkpoint_version<>3
    OR root.checklist_version<>1 OR root.product_purged_at IS NOT NULL OR root.completed_at IS NOT NULL OR root.reactivation_allowed
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS DISTINCT FROM worker OR job.lease_generation IS DISTINCT FROM generation
    OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted'
      AND version=root.account_version AND product_epoch=root.product_epoch)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=root.id
      AND completed_phase='evidence_capture' AND next_phase='product_data' AND from_checkpoint_version=2 AND next_checkpoint_version=3)
    OR identity.deletion_evidence_blocker(root.id,subject) IS NOT NULL THEN
    RAISE EXCEPTION 'Flow archival current owning lease missing' USING ERRCODE='40001'; END IF;
  purged_rows:=0;
  SELECT * INTO source FROM nakh.nakh_flows WHERE id=candidate FOR UPDATE;
  IF source.id IS NOT NULL THEN
    INSERT INTO identity.account_deletion_flow_receipts SELECT proof.*;
    GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'Flow receipt missing' USING ERRCODE='23514'; END IF;
    INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,
      metadata_schema_version,metadata,command_id,request_id,occurred_at)
    VALUES(proof.audit_id,'account','account.deletion-flow-batch.v1','system','account_deletion',root.id,'flow_archived',1,
      jsonb_build_object('kind','flow_source','rows',1,'receiptDigest',identity.flow_receipt_digest(proof)),root.command_id,root.request_id,proof.archived_at);
    GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'Flow audit missing' USING ERRCODE='23514'; END IF;
    INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
    VALUES(proof.event_id,'account_deletion',root.id,'account.deletion-flow-batch.v1',1,
      jsonb_build_object('deletionRecordId',root.id,'kind','flow_source','rows',1,'auditId',proof.audit_id),proof.archived_at,proof.archived_at,root.request_id,root.command_id);
    GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'Flow event missing' USING ERRCODE='23514'; END IF;
    DELETE FROM nakh.nakh_flows WHERE id=source.id;
    GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'Flow removal missing' USING ERRCODE='23514'; END IF;
    purged_rows:=1;
  ELSE
    FOR original_id IN SELECT anchor.id FROM nakh.flow_reference_anchors anchor WHERE subject IN (anchor.sender_user_id,anchor.receiver_user_id)
      UNION SELECT anchor.nakh_flow_id FROM nakh.nakh_reference_anchors anchor WHERE subject IN (anchor.sender_user_id,anchor.receiver_user_id)
      UNION SELECT anchor.nakh_flow_id FROM nakh.pending_nakh_reference_anchors anchor WHERE subject IN (anchor.sender_user_id,anchor.receiver_user_id)
      UNION SELECT receipt.flow_id FROM identity.account_deletion_flow_receipts receipt
        JOIN identity.account_deletion_records owning ON owning.id=receipt.deletion_record_id WHERE owning.user_id=subject
      UNION SELECT (receipt.summary->>'nakhFlowId')::uuid FROM identity.account_deletion_nakh_receipts receipt
        JOIN identity.account_deletion_records owning ON owning.id=receipt.deletion_record_id WHERE owning.user_id=subject AND receipt.final_batch
    LOOP
      IF nakh.flow_source_archivable(original_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Flow archival replay proof incomplete' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  IF job.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Flow archival lease expired' USING ERRCODE='40001'; END IF;
  SELECT EXISTS(SELECT 1 FROM nakh.nakh_flows flow LEFT JOIN nakh.flow_reference_anchors anchor ON anchor.id=flow.id
    WHERE subject IN (flow.sender_user_id,flow.receiver_user_id,anchor.sender_user_id,anchor.receiver_user_id)) INTO has_more;
  RETURN NEXT;
END $$;

COMMENT ON TABLE identity.account_deletion_flow_receipts IS
  'Minimal immutable original-life Flow removal proof; no body, creation timestamp, product access, phase completion, fresh Return or retained release authority.';

-- Preserve every original predicate; only the historical Flow source changes.
CREATE OR REPLACE FUNCTION nakh.original_funding_scope_life_valid(source_id uuid,flow_id uuid,sender uuid,receiver uuid,
  funding text,credit_id uuid,payment_id uuid) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.verified_original_flow_lives flow WHERE flow.id=flow_id
    AND flow.sender_user_id=sender AND flow.receiver_user_id=receiver
    AND ((funding='credits' AND EXISTS(SELECT 1 FROM billing.credit_transactions credit
      WHERE credit.id=credit_id AND credit.nakh_id=source_id AND credit.user_id=sender
        AND credit.product_epoch=flow.sender_product_epoch))
      OR (funding='telegram_stars' AND EXISTS(SELECT 1 FROM billing.payment_records payment
        JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
        WHERE payment.id=payment_id AND payment.user_id=sender AND intent.user_id=sender
          AND intent.product_epoch=flow.sender_product_epoch))))
$$;

-- Preserve every original predicate; only the historical Flow source changes.
CREATE OR REPLACE FUNCTION nakh.original_funded_scope_valid(source_id uuid,flow_id uuid,sender uuid,receiver uuid,
  funding text,credit_id uuid,payment_id uuid) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.verified_original_flow_lives flow JOIN nakh.nakh_reference_anchors anchor
    ON anchor.id=source_id AND anchor.nakh_flow_id=flow.id
    WHERE flow.id=flow_id AND flow.sender_user_id=sender AND flow.receiver_user_id=receiver
      AND anchor.sender_user_id=sender AND anchor.receiver_user_id=receiver
      AND anchor.sender_product_epoch=flow.sender_product_epoch
      AND anchor.receiver_product_epoch=flow.receiver_product_epoch
      AND ((funding='credits' AND payment_id IS NULL AND EXISTS(
        SELECT 1 FROM billing.credit_transactions credit WHERE credit.id=credit_id
          AND credit.nakh_id=source_id AND credit.user_id=sender AND credit.product_epoch=flow.sender_product_epoch
          AND credit.transaction_type='spend_nakh' AND credit.amount=-2
          AND credit.payment_record_id IS NULL AND credit.feature_unlock_id IS NULL
          AND ((credit.pending_payment_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending WHERE pending.nakh_flow_id=flow.id)
            AND NOT EXISTS(SELECT 1 FROM nakh.pending_nakh_reference_anchors reference WHERE reference.nakh_flow_id=flow.id))
            OR EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending
            WHERE pending.pending_payment_id=credit.pending_payment_id AND pending.nakh_flow_id=flow.id
              AND pending.status='paid_and_sent' AND nakh.original_pending_reference_valid(pending.id)
              AND EXISTS(SELECT 1 FROM billing.pending_payments intent WHERE intent.id=pending.pending_payment_id
                AND intent.status='paid')))))
        OR (funding='telegram_stars' AND credit_id IS NULL AND EXISTS(
          SELECT 1 FROM billing.payment_records payment JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
          WHERE payment.id=payment_id AND payment.user_id=sender AND payment.payment_type='pay_pending_action'
            AND payment.paid_action_reason='send_nakh' AND payment.status='paid' AND payment.stars_amount=2
            AND intent.user_id=sender AND intent.product_epoch=flow.sender_product_epoch
            AND intent.reason='send_nakh' AND intent.target_type='pending_nakh' AND intent.status='paid' AND intent.required_stars=2
            AND EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending WHERE pending.id=intent.target_id
              AND pending.pending_payment_id=intent.id AND pending.nakh_flow_id=flow.id AND pending.status='paid_and_sent' AND nakh.original_pending_reference_valid(pending.id))))))
$$;

-- Preserve every original predicate; only the historical Flow source changes.
CREATE OR REPLACE FUNCTION nakh.original_pending_reference_valid(subject uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending
    JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=pending.id
    JOIN nakh.verified_original_flow_lives flow ON flow.id=pending.nakh_flow_id
    JOIN billing.pending_payments intent ON intent.id=pending.pending_payment_id
    WHERE pending.id=subject AND pending.shape_valid AND anchor.nakh_flow_id=flow.id
      AND anchor.sender_user_id=pending.sender_user_id AND flow.sender_user_id=pending.sender_user_id
      AND anchor.receiver_user_id=flow.receiver_user_id
      AND anchor.sender_product_epoch=flow.sender_product_epoch
      AND anchor.receiver_product_epoch=flow.receiver_product_epoch
      AND anchor.pending_payment_id=intent.id
      AND intent.user_id=pending.sender_user_id AND intent.product_epoch=flow.sender_product_epoch
      AND intent.reason='send_nakh' AND intent.target_type='pending_nakh' AND intent.target_id=pending.id
      AND intent.expires_at=pending.expires_at)
$$;

-- Preserve every original predicate; only the historical Flow source changes.
CREATE OR REPLACE FUNCTION identity.paid_pending_receipt_proof_valid(receipt identity.account_deletion_paid_pending_receipts)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN nakh.pending_nakh_reference_anchors pending ON pending.id=receipt.pending_nakh_id
    JOIN nakh.verified_original_flow_lives flow ON flow.id=pending.nakh_flow_id
    JOIN nakh.nakh_reference_anchors delivered ON delivered.id=receipt.nakh_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE root.id=receipt.deletion_record_id AND receipt.source_version>=2
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
      AND pending.sender_user_id=flow.sender_user_id AND pending.receiver_user_id=flow.receiver_user_id
      AND pending.sender_product_epoch=flow.sender_product_epoch
      AND pending.receiver_product_epoch=flow.receiver_product_epoch
      AND delivered.nakh_flow_id=flow.id AND delivered.sender_user_id=flow.sender_user_id
      AND delivered.receiver_user_id=flow.receiver_user_id
      AND delivered.sender_product_epoch=flow.sender_product_epoch
      AND delivered.receiver_product_epoch=flow.receiver_product_epoch
      AND ((root.user_id=pending.sender_user_id AND root.product_epoch=pending.sender_product_epoch)
        OR (root.user_id=pending.receiver_user_id AND root.product_epoch=pending.receiver_product_epoch))
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND EXISTS(SELECT 1 FROM identity.account_deletion_nakh_receipts final
        WHERE final.nakh_id=receipt.nakh_id AND final.final_batch)
      AND NOT EXISTS(SELECT 1 FROM nakh.nakhes WHERE id=receipt.nakh_id)
      AND audit.category='account' AND audit.event_type='account.deletion-paid-pending-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.result_code='paid_pending_archived' AND audit.metadata_schema_version=1
      AND audit.metadata=jsonb_build_object('kind','paid_pending_source','rows',1,
        'receiptDigest',identity.paid_pending_receipt_digest(receipt))
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id
      AND audit.occurred_at=receipt.archived_at)
$$;

-- Preserve every original predicate; only the historical Flow source changes.
CREATE OR REPLACE FUNCTION identity.terminal_pending_receipt_proof_valid(receipt identity.account_deletion_terminal_pending_receipts)
  RETURNS boolean LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  -- Cache this complete predicate instead of expanding it repeatedly through
  -- lifecycle/reference/closure readers. Every original binding remains checked.
  RETURN EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=receipt.pending_nakh_id
    JOIN nakh.verified_original_flow_lives flow ON flow.id=anchor.nakh_flow_id
    JOIN billing.pending_payments intent ON intent.id=anchor.pending_payment_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE root.id=receipt.deletion_record_id AND receipt.source_version>=2
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
      AND anchor.sender_user_id=flow.sender_user_id AND anchor.receiver_user_id=flow.receiver_user_id
      AND anchor.sender_product_epoch=flow.sender_product_epoch
      AND anchor.receiver_product_epoch=flow.receiver_product_epoch
      AND intent.user_id=anchor.sender_user_id AND intent.product_epoch=anchor.sender_product_epoch
      AND intent.reason='send_nakh' AND intent.target_type='pending_nakh' AND intent.target_id=anchor.id
      AND intent.expires_at=receipt.expires_at
      AND ((root.user_id=anchor.sender_user_id AND root.product_epoch=anchor.sender_product_epoch)
        OR (root.user_id=anchor.receiver_user_id AND root.product_epoch=anchor.receiver_product_epoch))
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND NOT EXISTS(SELECT 1 FROM nakh.nakhes WHERE nakh_flow_id=flow.id)
      AND NOT EXISTS(SELECT 1 FROM nakh.nakh_reference_anchors WHERE nakh_flow_id=flow.id)
      AND audit.category='account' AND audit.event_type='account.deletion-terminal-pending-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.result_code='terminal_pending_archived' AND audit.metadata_schema_version=1
      AND audit.metadata=jsonb_build_object('kind','terminal_pending_source','rows',1,
        'receiptDigest',identity.terminal_pending_receipt_digest(receipt))
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id
      AND audit.occurred_at=receipt.archived_at);
END
$$;

-- Preserve every original predicate; only the historical Flow source changes.
CREATE OR REPLACE FUNCTION identity.deletion_has_unresolved_shared_payments(subject uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE wanted uuid[]; blocked boolean;
BEGIN
  -- Discover conservatively from raw participants, original references and the
  -- owning archival root. None of these candidates is removal authority.
  SELECT array_agg(id) INTO wanted FROM (
    SELECT pending.id FROM nakh.pending_nakhes pending
      LEFT JOIN nakh.verified_original_flow_lives flow ON flow.id=pending.nakh_flow_id
      LEFT JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=pending.id
      WHERE pending.sender_user_id=subject OR flow.receiver_user_id=subject OR anchor.receiver_user_id=subject
    UNION
    SELECT anchor.id FROM nakh.pending_nakh_reference_anchors anchor
      LEFT JOIN nakh.verified_original_flow_lives flow ON flow.id=anchor.nakh_flow_id
      WHERE anchor.sender_user_id=subject OR anchor.receiver_user_id=subject OR flow.receiver_user_id=subject
    UNION
    SELECT receipt.pending_nakh_id FROM identity.account_deletion_terminal_pending_receipts receipt
      JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
      WHERE root.user_id=subject
  ) candidates;
  IF wanted IS NULL THEN RETURN false; END IF;
  -- Filter original participants before invoking the complete historical proof.
  -- This boundary prevents PostgreSQL from verifying every unrelated archived
  -- source while the caller holds its current Account/work locks.
  WITH scoped AS MATERIALIZED (
    SELECT pending.* FROM nakh.pending_nakh_lifecycle_facts pending
    WHERE pending.status IN ('cancelled','expired','closed_by_system','missing')
      AND pending.id=ANY(wanted))
  SELECT EXISTS(SELECT 1 FROM scoped pending
    WHERE nakh.terminal_pending_closure_valid(pending::nakh.pending_nakh_lifecycle_facts) IS NOT TRUE) INTO blocked;
  RETURN blocked;
END
$$;

-- Cache complete boolean proof plans; retain every original predicate.
CREATE OR REPLACE FUNCTION identity.flow_receipt_proof_valid(receipt identity.account_deletion_flow_receipts)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
BEGIN RETURN (SELECT EXISTS(SELECT 1 FROM nakh.flow_reference_anchors anchor
    JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE anchor.id=receipt.flow_id
      AND ((root.user_id=anchor.sender_user_id AND root.product_epoch=anchor.sender_product_epoch)
        OR (root.user_id=anchor.receiver_user_id AND root.product_epoch=anchor.receiver_product_epoch))
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND audit.category='account' AND audit.event_type='account.deletion-flow-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.result_code='flow_archived' AND audit.metadata_schema_version=1
      AND audit.metadata=jsonb_build_object('kind','flow_source','rows',1,'receiptDigest',identity.flow_receipt_digest(receipt))
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=receipt.archived_at)); END;
$function$;
CREATE OR REPLACE FUNCTION identity.paid_pending_receipt_proof_valid(receipt identity.account_deletion_paid_pending_receipts)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
BEGIN RETURN (SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN nakh.pending_nakh_reference_anchors pending ON pending.id=receipt.pending_nakh_id
    JOIN nakh.verified_original_flow_lives flow ON flow.id=pending.nakh_flow_id
    JOIN nakh.nakh_reference_anchors delivered ON delivered.id=receipt.nakh_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE root.id=receipt.deletion_record_id AND receipt.source_version>=2
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
      AND pending.sender_user_id=flow.sender_user_id AND pending.receiver_user_id=flow.receiver_user_id
      AND pending.sender_product_epoch=flow.sender_product_epoch
      AND pending.receiver_product_epoch=flow.receiver_product_epoch
      AND delivered.nakh_flow_id=flow.id AND delivered.sender_user_id=flow.sender_user_id
      AND delivered.receiver_user_id=flow.receiver_user_id
      AND delivered.sender_product_epoch=flow.sender_product_epoch
      AND delivered.receiver_product_epoch=flow.receiver_product_epoch
      AND ((root.user_id=pending.sender_user_id AND root.product_epoch=pending.sender_product_epoch)
        OR (root.user_id=pending.receiver_user_id AND root.product_epoch=pending.receiver_product_epoch))
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND EXISTS(SELECT 1 FROM identity.account_deletion_nakh_receipts final
        WHERE final.nakh_id=receipt.nakh_id AND final.final_batch)
      AND NOT EXISTS(SELECT 1 FROM nakh.nakhes WHERE id=receipt.nakh_id)
      AND audit.category='account' AND audit.event_type='account.deletion-paid-pending-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.result_code='paid_pending_archived' AND audit.metadata_schema_version=1
      AND audit.metadata=jsonb_build_object('kind','paid_pending_source','rows',1,
        'receiptDigest',identity.paid_pending_receipt_digest(receipt))
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id
      AND audit.occurred_at=receipt.archived_at)); END;
$function$;
CREATE OR REPLACE FUNCTION nakh.original_funded_scope_valid(source_id uuid, flow_id uuid, sender uuid, receiver uuid, funding text, credit_id uuid, payment_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
BEGIN RETURN (SELECT EXISTS(SELECT 1 FROM nakh.verified_original_flow_lives flow JOIN nakh.nakh_reference_anchors anchor
    ON anchor.id=source_id AND anchor.nakh_flow_id=flow.id
    WHERE flow.id=flow_id AND flow.sender_user_id=sender AND flow.receiver_user_id=receiver
      AND anchor.sender_user_id=sender AND anchor.receiver_user_id=receiver
      AND anchor.sender_product_epoch=flow.sender_product_epoch
      AND anchor.receiver_product_epoch=flow.receiver_product_epoch
      AND ((funding='credits' AND payment_id IS NULL AND EXISTS(
        SELECT 1 FROM billing.credit_transactions credit WHERE credit.id=credit_id
          AND credit.nakh_id=source_id AND credit.user_id=sender AND credit.product_epoch=flow.sender_product_epoch
          AND credit.transaction_type='spend_nakh' AND credit.amount=-2
          AND credit.payment_record_id IS NULL AND credit.feature_unlock_id IS NULL
          AND ((credit.pending_payment_id IS NULL
            AND NOT EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending WHERE pending.nakh_flow_id=flow.id)
            AND NOT EXISTS(SELECT 1 FROM nakh.pending_nakh_reference_anchors reference WHERE reference.nakh_flow_id=flow.id))
            OR EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending
            WHERE pending.pending_payment_id=credit.pending_payment_id AND pending.nakh_flow_id=flow.id
              AND pending.status='paid_and_sent' AND nakh.original_pending_reference_valid(pending.id)
              AND EXISTS(SELECT 1 FROM billing.pending_payments intent WHERE intent.id=pending.pending_payment_id
                AND intent.status='paid')))))
        OR (funding='telegram_stars' AND credit_id IS NULL AND EXISTS(
          SELECT 1 FROM billing.payment_records payment JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
          WHERE payment.id=payment_id AND payment.user_id=sender AND payment.payment_type='pay_pending_action'
            AND payment.paid_action_reason='send_nakh' AND payment.status='paid' AND payment.stars_amount=2
            AND intent.user_id=sender AND intent.product_epoch=flow.sender_product_epoch
            AND intent.reason='send_nakh' AND intent.target_type='pending_nakh' AND intent.status='paid' AND intent.required_stars=2
            AND EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending WHERE pending.id=intent.target_id
              AND pending.pending_payment_id=intent.id AND pending.nakh_flow_id=flow.id AND pending.status='paid_and_sent' AND nakh.original_pending_reference_valid(pending.id))))))); END;
$function$;
CREATE OR REPLACE FUNCTION nakh.original_funding_scope_life_valid(source_id uuid, flow_id uuid, sender uuid, receiver uuid, funding text, credit_id uuid, payment_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
BEGIN RETURN (SELECT EXISTS(SELECT 1 FROM nakh.verified_original_flow_lives flow WHERE flow.id=flow_id
    AND flow.sender_user_id=sender AND flow.receiver_user_id=receiver
    AND ((funding='credits' AND EXISTS(SELECT 1 FROM billing.credit_transactions credit
      WHERE credit.id=credit_id AND credit.nakh_id=source_id AND credit.user_id=sender
        AND credit.product_epoch=flow.sender_product_epoch))
      OR (funding='telegram_stars' AND EXISTS(SELECT 1 FROM billing.payment_records payment
        JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
        WHERE payment.id=payment_id AND payment.user_id=sender AND intent.user_id=sender
          AND intent.product_epoch=flow.sender_product_epoch))))); END;
$function$;
CREATE OR REPLACE FUNCTION nakh.original_pending_reference_valid(subject uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE
AS $function$
BEGIN RETURN (SELECT EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending
    JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=pending.id
    JOIN nakh.verified_original_flow_lives flow ON flow.id=pending.nakh_flow_id
    JOIN billing.pending_payments intent ON intent.id=pending.pending_payment_id
    WHERE pending.id=subject AND pending.shape_valid AND anchor.nakh_flow_id=flow.id
      AND anchor.sender_user_id=pending.sender_user_id AND flow.sender_user_id=pending.sender_user_id
      AND anchor.receiver_user_id=flow.receiver_user_id
      AND anchor.sender_product_epoch=flow.sender_product_epoch
      AND anchor.receiver_product_epoch=flow.receiver_product_epoch
      AND anchor.pending_payment_id=intent.id
      AND intent.user_id=pending.sender_user_id AND intent.product_epoch=flow.sender_product_epoch
      AND intent.reason='send_nakh' AND intent.target_type='pending_nakh' AND intent.target_id=pending.id
      AND intent.expires_at=pending.expires_at)); END;
$function$;
