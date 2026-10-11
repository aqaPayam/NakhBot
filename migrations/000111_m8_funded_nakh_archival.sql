-- Ordinary source removal is bounded, audited and bound to the original life.
-- Receipts contain counts/fences; only the final batch retains minimal facts.
CREATE TABLE identity.account_deletion_nakh_receipts (
  id uuid PRIMARY KEY,
  nakh_id uuid NOT NULL REFERENCES nakh.nakh_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  source_version integer NOT NULL CHECK(source_version BETWEEN 1 AND 3),
  before_actions integer NOT NULL CHECK(before_actions>=0),
  removed_actions integer NOT NULL CHECK(removed_actions BETWEEN 0 AND 100),
  removed_history integer NOT NULL CHECK(removed_history BETWEEN 0 AND 3),
  final_batch boolean NOT NULL,
  summary jsonb,
  batch_transaction xid8 NOT NULL,
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE,
  UNIQUE(nakh_id,batch_transaction),
  CHECK(removed_actions+removed_history+final_batch::integer BETWEEN 1 AND 100),
  CHECK((final_batch AND summary IS NOT NULL AND jsonb_typeof(summary)='object'
      AND removed_actions=before_actions AND removed_history=source_version)
    OR (NOT final_batch AND summary IS NULL AND removed_history=0 AND removed_actions BETWEEN 1 AND 100))
);
CREATE INDEX deletion_nakh_receipts_root_idx ON identity.account_deletion_nakh_receipts(deletion_record_id,id);
CREATE UNIQUE INDEX deletion_nakh_receipts_final_idx ON identity.account_deletion_nakh_receipts(nakh_id) WHERE final_batch;
CREATE UNIQUE INDEX deletion_nakh_receipts_flow_idx ON identity.account_deletion_nakh_receipts((summary->>'nakhFlowId')) WHERE final_batch;
CREATE UNIQUE INDEX deletion_nakh_receipts_credit_idx ON identity.account_deletion_nakh_receipts((summary->>'creditTransactionId'))
  WHERE final_batch AND summary->>'creditTransactionId' IS NOT NULL;
CREATE UNIQUE INDEX deletion_nakh_receipts_payment_idx ON identity.account_deletion_nakh_receipts((summary->>'paymentRecordId'))
  WHERE final_batch AND summary->>'paymentRecordId' IS NOT NULL;

CREATE FUNCTION nakh.reject_archived_funding_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM identity.account_deletion_nakh_receipts receipt WHERE receipt.final_batch
    AND (receipt.summary->>'nakhFlowId'=NEW.nakh_flow_id::text
      OR receipt.summary->>'creditTransactionId'=NEW.credit_transaction_id::text
      OR receipt.summary->>'paymentRecordId'=NEW.payment_record_id::text)) THEN
    RAISE EXCEPTION 'archived Nakh funding cannot be reused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_nakh_archived_funding_guard BEFORE INSERT ON nakh.nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.reject_archived_funding_reuse();

-- Complete original funding evidence, independent of current Account state.
-- Pending/Flow sources remain live in this increment; their archival is separate.
CREATE FUNCTION nakh.original_funding_scope_life_valid(source_id uuid,flow_id uuid,sender uuid,receiver uuid,
  funding text,credit_id uuid,payment_id uuid) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.nakh_flows flow WHERE flow.id=flow_id
    AND flow.sender_user_id=sender AND flow.receiver_user_id=receiver
    AND ((funding='credits' AND EXISTS(SELECT 1 FROM billing.credit_transactions credit
      WHERE credit.id=credit_id AND credit.nakh_id=source_id AND credit.user_id=sender
        AND credit.product_epoch=flow.sender_product_epoch))
      OR (funding='telegram_stars' AND EXISTS(SELECT 1 FROM billing.payment_records payment
        JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
        WHERE payment.id=payment_id AND payment.user_id=sender AND intent.user_id=sender
          AND intent.product_epoch=flow.sender_product_epoch))))
$$;
CREATE FUNCTION nakh.original_funded_scope_valid(source_id uuid,flow_id uuid,sender uuid,receiver uuid,
  funding text,credit_id uuid,payment_id uuid) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.nakh_flows flow JOIN nakh.nakh_reference_anchors anchor
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
          AND (credit.pending_payment_id IS NULL OR EXISTS(SELECT 1 FROM nakh.pending_nakhes pending
            WHERE pending.pending_payment_id=credit.pending_payment_id AND pending.nakh_flow_id=flow.id
              AND pending.status='paid_and_sent'))))
        OR (funding='telegram_stars' AND credit_id IS NULL AND EXISTS(
          SELECT 1 FROM billing.payment_records payment JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
          WHERE payment.id=payment_id AND payment.user_id=sender AND payment.payment_type='pay_pending_action'
            AND payment.paid_action_reason='send_nakh' AND payment.status='paid' AND payment.stars_amount=2
            AND intent.user_id=sender AND intent.product_epoch=flow.sender_product_epoch
            AND intent.reason='send_nakh' AND intent.target_type='pending_nakh' AND intent.status='paid' AND intent.required_stars=2
            AND EXISTS(SELECT 1 FROM nakh.pending_nakhes pending WHERE pending.id=intent.target_id
              AND pending.pending_payment_id=intent.id AND pending.nakh_flow_id=flow.id AND pending.status='paid_and_sent')))))
$$;

CREATE FUNCTION nakh.deletion_source_summary(source nakh.nakhes) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('nakhFlowId',source.nakh_flow_id,'senderUserId',source.sender_user_id,
    'receiverUserId',source.receiver_user_id,
    'senderProductEpoch',(SELECT sender_product_epoch FROM nakh.nakh_flows WHERE id=source.nakh_flow_id),
    'receiverProductEpoch',(SELECT receiver_product_epoch FROM nakh.nakh_flows WHERE id=source.nakh_flow_id),
    'status',source.status,'version',source.version,'fundingType',source.funding_type,
    'creditTransactionId',source.credit_transaction_id,'paymentRecordId',source.payment_record_id,
    'historyCount',(SELECT count(*) FROM nakh.nakh_status_history WHERE nakh_id=source.id),
    'historyMinVersion',(SELECT min(nakh_version) FROM nakh.nakh_status_history WHERE nakh_id=source.id),
    'historyMaxVersion',(SELECT max(nakh_version) FROM nakh.nakh_status_history WHERE nakh_id=source.id),
    'historyLastStatus',(SELECT to_status FROM nakh.nakh_status_history WHERE nakh_id=source.id ORDER BY nakh_version DESC LIMIT 1),
    'notificationCount',(SELECT count(*) FROM notification.notifications notice WHERE notice.user_id=source.receiver_user_id
      AND notice.notification_type='nakh_received' AND notice.payload->>'nakhId'=source.id::text))
$$;

CREATE FUNCTION identity.nakh_receipt_fence(receipt identity.account_deletion_nakh_receipts) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN nakh.nakh_reference_anchors anchor ON anchor.id=receipt.nakh_id
    WHERE root.id=receipt.deletion_record_id AND root.phase='product_data' AND root.checkpoint_version=3 AND root.checklist_version=1
      AND root.product_purged_at IS NULL AND root.completed_at IS NULL AND NOT root.reactivation_allowed
      AND ((root.user_id=anchor.sender_user_id AND root.product_epoch=anchor.sender_product_epoch)
        OR (root.user_id=anchor.receiver_user_id AND root.product_epoch=anchor.receiver_product_epoch))
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.batch_transaction=pg_current_xact_id()
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<=clock_timestamp()
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND identity.deletion_evidence_blocker(root.id,root.user_id) IS NULL)
$$;

CREATE FUNCTION identity.guard_nakh_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source nakh.nakhes; facts jsonb; matches integer;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Nakh receipt requires controlled retained release' USING ERRCODE='55000'; END IF;
  SELECT * INTO source FROM nakh.nakhes WHERE id=NEW.nakh_id;
  facts:=nakh.deletion_source_summary(source);
  SELECT count(*) INTO matches FROM matching.match_lifecycle_facts candidate WHERE candidate.source='nakh_accept'
    AND candidate.source_nakh_id=source.id AND candidate.user_low_id=LEAST(source.sender_user_id,source.receiver_user_id)
    AND candidate.user_high_id=GREATEST(source.sender_user_id,source.receiver_user_id);
  IF NOT identity.nakh_receipt_fence(NEW) OR source.id IS NULL OR source.version<>NEW.source_version
    OR source.status NOT IN ('accepted','rejected','expired','closed')
    OR NOT nakh.original_funded_scope_valid(source.id,source.nakh_flow_id,source.sender_user_id,source.receiver_user_id,
      source.funding_type,source.credit_transaction_id,source.payment_record_id)
    OR NEW.before_actions<>(SELECT count(*) FROM nakh.nakh_receiver_actions WHERE nakh_id=source.id)
    OR (facts->>'historyCount')::integer<>source.version OR (facts->>'historyMinVersion')::integer<>1
    OR (facts->>'historyMaxVersion')::integer<>source.version OR facts->>'historyLastStatus' IS DISTINCT FROM source.status
    OR (facts->>'notificationCount')::integer<>1
    OR (source.status='accepted' AND matches<>1) OR (source.status<>'accepted' AND matches<>0)
    OR EXISTS(SELECT 1 FROM matching.matches WHERE source_nakh_id=source.id)
    OR EXISTS(SELECT 1 FROM nakh.nakh_status_history history WHERE history.nakh_id=source.id
      AND ((history.nakh_version=1 AND (history.from_status IS NOT NULL OR history.to_status<>'sent'))
        OR (history.nakh_version>1 AND NOT EXISTS(SELECT 1 FROM nakh.nakh_status_history previous
          WHERE previous.nakh_id=history.nakh_id AND previous.nakh_version=history.nakh_version-1
            AND previous.to_status=history.from_status))))
    OR (NEW.final_batch AND NEW.summary IS DISTINCT FROM facts) THEN
    RAISE EXCEPTION 'Nakh archival original funding, lifecycle or fence missing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nakh_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_nakh_receipts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_nakh_archival_receipt();

CREATE FUNCTION identity.require_nakh_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE remaining integer; source nakh.nakhes; root identity.account_deletion_records; rows integer;
BEGIN
  SELECT count(*) INTO remaining FROM nakh.nakh_receiver_actions WHERE nakh_id=NEW.nakh_id;
  SELECT * INTO source FROM nakh.nakhes WHERE id=NEW.nakh_id;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=NEW.deletion_record_id;
  rows:=NEW.removed_actions+NEW.removed_history+NEW.final_batch::integer;
  IF NOT identity.nakh_receipt_fence(NEW) OR remaining<>NEW.before_actions-NEW.removed_actions
    OR (NEW.final_batch AND (source.id IS NOT NULL OR EXISTS(SELECT 1 FROM nakh.nakh_status_history WHERE nakh_id=NEW.nakh_id)))
    OR (NOT NEW.final_batch AND (source.id IS NULL OR source.version<>NEW.source_version
      OR NOT nakh.original_funded_scope_valid(source.id,source.nakh_flow_id,source.sender_user_id,source.receiver_user_id,
        source.funding_type,source.credit_transaction_id,source.payment_record_id)
      OR (SELECT count(*) FROM nakh.nakh_status_history WHERE nakh_id=source.id)<>NEW.source_version))
    OR NOT EXISTS(SELECT 1 FROM platform.audit_logs audit JOIN platform.outbox_events event ON event.id=NEW.event_id
      WHERE audit.id=NEW.audit_id AND audit.category='account' AND audit.event_type='account.deletion-nakh-batch.v1'
        AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
        AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='nakh_batch_archived'
        AND audit.metadata_schema_version=1 AND audit.metadata=jsonb_build_object('kind','nakh_source','rows',rows,'final',NEW.final_batch)
        AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=NEW.archived_at
        AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id AND event.event_type=audit.event_type
        AND event.schema_version=1 AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','nakh_source','rows',rows,'auditId',audit.id)
        AND event.correlation_id=root.request_id AND event.causation_id=root.command_id
        AND event.occurred_at=NEW.archived_at AND event.available_at=NEW.archived_at) THEN
    RAISE EXCEPTION 'Nakh archival count, lease or mandatory chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER nakh_archival_receipt_required AFTER INSERT ON identity.account_deletion_nakh_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_nakh_archival_receipt();

-- A previous receipt, a GUC or a still-valid old worker lease cannot authorize
-- another transaction's removal. The full transaction id is native authority.
CREATE FUNCTION nakh.authorize_deletion_batch(source_id uuid,require_final boolean) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_nakh_receipts receipt
    WHERE receipt.nakh_id=source_id AND receipt.batch_transaction=pg_current_xact_id()
      AND (NOT require_final OR receipt.final_batch) AND identity.nakh_receipt_fence(receipt))
$$;

CREATE OR REPLACE FUNCTION nakh.reject_nakh_receiver_action_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND nakh.authorize_deletion_batch(OLD.nakh_id,false) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Nakh receiver actions require a current verified deletion batch' USING ERRCODE='55000';
END $$;

-- Preserve every INSERT/history and UPDATE/source rule by delegating to the
-- original functions under new names; only current proven DELETE gains authority.
ALTER FUNCTION nakh.guard_nakh_lifecycle() RENAME TO guard_nakh_lifecycle_before_archival;
CREATE FUNCTION nakh.guard_nakh_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT nakh.authorize_deletion_batch(OLD.id,true) THEN
      RAISE EXCEPTION 'delivered Nakh requires verified final archival' USING ERRCODE='55000';
    END IF;
    RETURN OLD;
  END IF;
  -- The existing update trigger below remains the original owning function.
  RETURN NEW;
END $$;
DROP TRIGGER nakhes_lifecycle_guard ON nakh.nakhes;
CREATE TRIGGER nakhes_lifecycle_guard BEFORE UPDATE ON nakh.nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_nakh_lifecycle_before_archival();
CREATE TRIGGER nakhes_archival_guard BEFORE DELETE ON nakh.nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_nakh_lifecycle();
ALTER FUNCTION nakh.guard_nakh_status_history() RENAME TO guard_nakh_status_history_before_archival;
CREATE FUNCTION nakh.guard_nakh_status_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND nakh.authorize_deletion_batch(OLD.nakh_id,true) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Nakh status history requires verified final archival' USING ERRCODE='55000';
END $$;
DROP TRIGGER nakh_status_history_guard ON nakh.nakh_status_history;
CREATE TRIGGER nakh_status_history_guard BEFORE INSERT OR UPDATE ON nakh.nakh_status_history
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_nakh_status_history_before_archival();
CREATE TRIGGER nakh_status_history_archival_guard BEFORE DELETE ON nakh.nakh_status_history
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_nakh_status_history();

CREATE FUNCTION nakh.purge_deletion_funded_source(deletion_id uuid,subject uuid,worker uuid,generation integer)
  RETURNS TABLE(purged_rows integer,has_more boolean) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work; source nakh.nakhes;
  candidate uuid; counterpart uuid; receipt uuid:=gen_random_uuid(); audit uuid:=gen_random_uuid(); event uuid:=gen_random_uuid();
  before_actions integer; removed_actions integer; removed_history integer:=0; final boolean;
  at timestamptz; writes integer; action_ids uuid[];
BEGIN
  IF deletion_id IS NULL OR subject IS NULL OR worker IS NULL OR generation IS NULL OR generation<1 THEN
    RAISE EXCEPTION 'Nakh archival lease invalid' USING ERRCODE='40001';
  END IF;
  SELECT live.id,CASE WHEN live.sender_user_id=subject THEN live.receiver_user_id ELSE live.sender_user_id END
    INTO candidate,counterpart FROM nakh.nakhes live JOIN nakh.nakh_reference_anchors anchor ON anchor.id=live.id
    JOIN identity.account_deletion_records owning ON owning.id=deletion_id AND owning.user_id=subject
    WHERE (subject=anchor.sender_user_id AND owning.product_epoch=anchor.sender_product_epoch)
      OR (subject=anchor.receiver_user_id AND owning.product_epoch=anchor.receiver_product_epoch)
    ORDER BY live.id LIMIT 1;
  IF counterpart IS NOT NULL THEN
    PERFORM user_id FROM platform.user_counters WHERE user_id IN (subject,counterpart) ORDER BY user_id FOR UPDATE;
    PERFORM interaction.lock_user_pair(LEAST(subject,counterpart),GREATEST(subject,counterpart));
  END IF;
  PERFORM id FROM identity.users WHERE id IN (subject,counterpart) ORDER BY id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id IN (subject,counterpart) ORDER BY user_id FOR UPDATE;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=deletion_id AND user_id=subject FOR UPDATE;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=deletion_id FOR UPDATE;
  IF root.id IS NULL OR job.deletion_record_id IS NULL OR root.phase<>'product_data' OR root.checkpoint_version<>3
    OR root.checklist_version<>1 OR root.product_purged_at IS NOT NULL OR root.completed_at IS NOT NULL OR root.reactivation_allowed
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS DISTINCT FROM worker OR job.lease_generation IS DISTINCT FROM generation
    OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted' AND version=root.account_version
      AND product_epoch=root.product_epoch)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=root.id
      AND completed_phase='evidence_capture' AND next_phase='product_data' AND from_checkpoint_version=2 AND next_checkpoint_version=3)
    OR identity.deletion_evidence_blocker(root.id,subject) IS NOT NULL THEN
    RAISE EXCEPTION 'Nakh archival original lease or capture proof missing' USING ERRCODE='40001';
  END IF;
  SELECT * INTO source FROM nakh.nakhes WHERE id=candidate FOR UPDATE;
  purged_rows:=0;
  IF source.id IS NOT NULL THEN
    SELECT count(*) INTO before_actions FROM nakh.nakh_receiver_actions WHERE nakh_id=source.id;
    final:=before_actions<=96;
    SELECT array_agg(id ORDER BY id) INTO action_ids FROM (
      SELECT id FROM nakh.nakh_receiver_actions WHERE nakh_id=source.id ORDER BY id LIMIT 100 FOR UPDATE
    ) selected;
    removed_actions:=LEAST(before_actions,100);
    IF final THEN SELECT count(*) INTO removed_history FROM nakh.nakh_status_history WHERE nakh_id=source.id; END IF;
    at:=clock_timestamp();
    INSERT INTO identity.account_deletion_nakh_receipts VALUES(receipt,source.id,root.id,source.version,
      before_actions,removed_actions,removed_history,final,CASE WHEN final THEN nakh.deletion_source_summary(source) END,
      pg_current_xact_id(),worker,generation,job.lease_expires_at,at,audit,event);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'Nakh archival receipt missing' USING ERRCODE='23514'; END IF;
    DELETE FROM nakh.nakh_receiver_actions WHERE id=ANY(action_ids);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>removed_actions THEN RAISE EXCEPTION 'Nakh archival action removal incomplete' USING ERRCODE='23514'; END IF;
    IF final THEN
      DELETE FROM nakh.nakh_status_history WHERE nakh_id=source.id;
      GET DIAGNOSTICS writes=ROW_COUNT;
      IF writes<>removed_history THEN RAISE EXCEPTION 'Nakh archival history removal incomplete' USING ERRCODE='23514'; END IF;
      DELETE FROM nakh.nakhes WHERE id=source.id;
      GET DIAGNOSTICS writes=ROW_COUNT;
      IF writes<>1 THEN RAISE EXCEPTION 'Nakh archival source removal incomplete' USING ERRCODE='23514'; END IF;
    END IF;
    purged_rows:=removed_actions+removed_history+final::integer;
    INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,
      metadata_schema_version,metadata,command_id,request_id,occurred_at)
    VALUES(audit,'account','account.deletion-nakh-batch.v1','system','account_deletion',root.id,'nakh_batch_archived',1,
      jsonb_build_object('kind','nakh_source','rows',purged_rows,'final',final),root.command_id,root.request_id,at);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'Nakh archival audit missing' USING ERRCODE='23514'; END IF;
    INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
      occurred_at,available_at,correlation_id,causation_id)
    VALUES(event,'account_deletion',root.id,'account.deletion-nakh-batch.v1',1,
      jsonb_build_object('deletionRecordId',root.id,'kind','nakh_source','rows',purged_rows,'auditId',audit),at,at,root.request_id,root.command_id);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'Nakh archival event missing' USING ERRCODE='23514'; END IF;
  END IF;
  IF job.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Nakh archival lease expired' USING ERRCODE='40001'; END IF;
  SELECT EXISTS(SELECT 1 FROM nakh.nakhes live JOIN nakh.nakh_reference_anchors anchor ON anchor.id=live.id
    WHERE (subject=anchor.sender_user_id AND root.product_epoch=anchor.sender_product_epoch)
      OR (subject=anchor.receiver_user_id AND root.product_epoch=anchor.receiver_product_epoch)) INTO has_more;
  RETURN NEXT;
END $$;

CREATE VIEW nakh.nakh_lifecycle_facts AS
  SELECT source.id,source.nakh_flow_id,source.sender_user_id,source.receiver_user_id,
    source.funding_type,source.credit_transaction_id,source.payment_record_id,source.status,source.version,
    (SELECT sender_product_epoch FROM nakh.nakh_flows WHERE id=source.nakh_flow_id) AS sender_product_epoch,
    (SELECT receiver_product_epoch FROM nakh.nakh_flows WHERE id=source.nakh_flow_id) AS receiver_product_epoch,
    (SELECT count(*)::integer FROM nakh.nakh_status_history WHERE nakh_id=source.id) AS history_count,
    (SELECT min(nakh_version) FROM nakh.nakh_status_history WHERE nakh_id=source.id) AS history_min_version,
    (SELECT max(nakh_version) FROM nakh.nakh_status_history WHERE nakh_id=source.id) AS history_max_version,
    (SELECT to_status FROM nakh.nakh_status_history WHERE nakh_id=source.id ORDER BY nakh_version DESC LIMIT 1) AS history_last_status,
    (SELECT count(*)::integer FROM notification.notifications notice WHERE notice.user_id=source.receiver_user_id
      AND notice.notification_type='nakh_received' AND notice.payload->>'nakhId'=source.id::text) AS notification_count
  FROM nakh.nakhes source
  UNION ALL
  SELECT receipt.nakh_id,(receipt.summary->>'nakhFlowId')::uuid,(receipt.summary->>'senderUserId')::uuid,
    (receipt.summary->>'receiverUserId')::uuid,
    receipt.summary->>'fundingType',(receipt.summary->>'creditTransactionId')::uuid,(receipt.summary->>'paymentRecordId')::uuid,
    receipt.summary->>'status',(receipt.summary->>'version')::integer,
    (receipt.summary->>'senderProductEpoch')::integer,(receipt.summary->>'receiverProductEpoch')::integer,
    (receipt.summary->>'historyCount')::integer,(receipt.summary->>'historyMinVersion')::integer,
    (receipt.summary->>'historyMaxVersion')::integer,receipt.summary->>'historyLastStatus',
    (receipt.summary->>'notificationCount')::integer
  FROM identity.account_deletion_nakh_receipts receipt
  WHERE receipt.final_batch AND NOT EXISTS(SELECT 1 FROM nakh.nakhes WHERE id=receipt.nakh_id);
COMMENT ON TABLE identity.account_deletion_nakh_receipts IS
  'Immutable bounded original-life deletion proof; final minimal funding/lifecycle summary only. No prose, action request text, new effects, provider calls, phase completion, fresh return or retained release.';
COMMENT ON VIEW nakh.nakh_lifecycle_facts IS
  'Internal live or verified immutable final lifecycle facts for reconciliation only; all product admission still requires its live original funded source.';
