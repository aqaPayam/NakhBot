-- Terminal unpaid bodies retain original financial accountability after removal.
-- No Flow, financial record, reference, preview or deletion checkpoint is removed.
CREATE TABLE identity.account_deletion_terminal_pending_receipts (
  id uuid PRIMARY KEY,
  pending_nakh_id uuid NOT NULL UNIQUE REFERENCES nakh.pending_nakh_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  source_status text NOT NULL CHECK(source_status IN ('cancelled','expired','closed_by_system')),
  source_version integer NOT NULL CHECK(source_version>=2),
  expires_at timestamptz NOT NULL,
  terminal_at timestamptz NOT NULL,
  cancel_resolution text CHECK(cancel_resolution IN ('converted_to_like','converted_to_not_interested')),
  batch_transaction xid8 NOT NULL,
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE,
  CHECK((source_status='cancelled')=(cancel_resolution IS NOT NULL)),
  CHECK(terminal_at>=expires_at-interval '336 hours' AND terminal_at<=archived_at),
  CHECK(source_status<>'expired' OR terminal_at>=expires_at)
);
CREATE INDEX deletion_terminal_pending_receipts_root_idx
  ON identity.account_deletion_terminal_pending_receipts(deletion_record_id,id);

CREATE FUNCTION identity.terminal_pending_receipt_digest(receipt identity.account_deletion_terminal_pending_receipts)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('id',receipt.id,
    'pendingNakhId',receipt.pending_nakh_id,'deletionRecordId',receipt.deletion_record_id,
    'status',receipt.source_status,'version',receipt.source_version,
    'expiresAt',(extract(epoch FROM receipt.expires_at)*1000000)::bigint,
    'terminalAt',(extract(epoch FROM receipt.terminal_at)*1000000)::bigint,
    'cancelResolution',receipt.cancel_resolution,
    'transaction',receipt.batch_transaction::text,'leaseOwner',receipt.lease_owner,
    'generation',receipt.lease_generation,
    'leaseExpiresAt',(extract(epoch FROM receipt.lease_expires_at)*1000000)::bigint,
    'archivedAt',(extract(epoch FROM receipt.archived_at)*1000000)::bigint,
    'auditId',receipt.audit_id,'eventId',receipt.event_id)::text,'UTF8')),'hex')
$$;

-- Historical verification does not depend on current Accounts, live leases or
-- transport retention. It never calls the lifecycle view recursively.
CREATE FUNCTION identity.terminal_pending_receipt_proof_valid(receipt identity.account_deletion_terminal_pending_receipts)
  RETURNS boolean LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  -- Cache this complete predicate instead of expanding it repeatedly through
  -- lifecycle/reference/closure readers. Every original binding remains checked.
  RETURN EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=receipt.pending_nakh_id
    JOIN nakh.nakh_flows flow ON flow.id=anchor.nakh_flow_id
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

CREATE OR REPLACE VIEW nakh.pending_nakh_lifecycle_facts AS
  SELECT pending.id,pending.nakh_flow_id,pending.sender_user_id,pending.pending_payment_id,
    pending.status,pending.version,pending.expires_at,pending.paid_at,true AS shape_valid,
    pending.cancelled_at,pending.expired_at,pending.closed_at,pending.cancel_resolution
  FROM nakh.pending_nakhes pending
  UNION ALL
  SELECT receipt.pending_nakh_id,anchor.nakh_flow_id,anchor.sender_user_id,anchor.pending_payment_id,
    'paid_and_sent',receipt.source_version,receipt.expires_at,receipt.paid_at,
    identity.paid_pending_receipt_proof_valid(receipt),NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,NULL::text
  FROM identity.account_deletion_paid_pending_receipts receipt
  LEFT JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=receipt.pending_nakh_id
  WHERE NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE id=receipt.pending_nakh_id)
  UNION ALL
  SELECT receipt.pending_nakh_id,anchor.nakh_flow_id,anchor.sender_user_id,anchor.pending_payment_id,
    receipt.source_status,receipt.source_version,receipt.expires_at,NULL::timestamptz,
    identity.terminal_pending_receipt_proof_valid(receipt),
    CASE WHEN receipt.source_status='cancelled' THEN receipt.terminal_at END,
    CASE WHEN receipt.source_status='expired' THEN receipt.terminal_at END,
    CASE WHEN receipt.source_status='closed_by_system' THEN receipt.terminal_at END,receipt.cancel_resolution
  FROM identity.account_deletion_terminal_pending_receipts receipt
  LEFT JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=receipt.pending_nakh_id
  WHERE NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE id=receipt.pending_nakh_id)
  UNION ALL
  SELECT anchor.id,anchor.nakh_flow_id,anchor.sender_user_id,anchor.pending_payment_id,
    'missing',NULL::integer,NULL::timestamptz,NULL::timestamptz,false,
    NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,NULL::text
  FROM nakh.pending_nakh_reference_anchors anchor
  WHERE NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE id=anchor.id)
    AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_paid_pending_receipts WHERE pending_nakh_id=anchor.id)
    AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_terminal_pending_receipts WHERE pending_nakh_id=anchor.id);

CREATE FUNCTION nakh.terminal_pending_closure_valid(source nakh.pending_nakh_lifecycle_facts)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT source.shape_valid AND source.status IN ('cancelled','expired','closed_by_system')
    AND source.version>=2 AND source.paid_at IS NULL AND nakh.original_pending_reference_valid(source.id)
    AND COALESCE(source.cancelled_at,source.expired_at,source.closed_at)>=source.expires_at-interval '336 hours'
    AND ((source.status='cancelled' AND source.cancelled_at IS NOT NULL
      AND source.cancelled_at<source.expires_at
      AND source.cancel_resolution IN ('converted_to_like','converted_to_not_interested')
      AND source.expired_at IS NULL AND source.closed_at IS NULL)
      OR (source.status='expired' AND source.expired_at>=source.expires_at
        AND source.cancelled_at IS NULL AND source.closed_at IS NULL AND source.cancel_resolution IS NULL)
      OR (source.status='closed_by_system' AND source.closed_at IS NOT NULL
        AND source.cancelled_at IS NULL AND source.expired_at IS NULL AND source.cancel_resolution IS NULL))
    AND NOT EXISTS(SELECT 1 FROM nakh.nakhes WHERE nakh_flow_id=source.nakh_flow_id)
    AND NOT EXISTS(SELECT 1 FROM nakh.nakh_reference_anchors WHERE nakh_flow_id=source.nakh_flow_id)
    AND EXISTS(SELECT 1 FROM billing.pending_payments intent WHERE intent.id=source.pending_payment_id
      AND intent.funding_type='telegram_stars' AND intent.required_stars=2 AND intent.required_credits IS NULL
      AND intent.resolved_at IS NOT NULL
      AND ((source.status='cancelled' AND intent.status IN ('cancelled','paid'))
        OR (source.status='expired' AND intent.status IN ('expired','paid'))
        OR (source.status='closed_by_system' AND intent.status IN ('cancelled','expired','failed','paid')))
      AND (intent.status<>'paid' OR EXISTS(SELECT 1 FROM billing.payment_records payment
        JOIN billing.telegram_stars_receipts capture ON capture.payment_record_id=payment.id
        WHERE payment.pending_payment_id=intent.id)))
    AND NOT EXISTS(SELECT 1 FROM billing.payment_records payment
      LEFT JOIN billing.telegram_stars_receipts capture ON capture.payment_record_id=payment.id
      LEFT JOIN billing.payment_fulfillments fulfillment ON fulfillment.payment_record_id=payment.id
      WHERE payment.pending_payment_id=source.pending_payment_id
        AND (payment.status IN ('paid','refunded') OR capture.payment_record_id IS NOT NULL)
        AND NOT COALESCE(payment.user_id=source.sender_user_id
          AND payment.payment_type='pay_pending_action' AND payment.paid_action_reason='send_nakh'
          AND payment.stars_amount=2 AND capture.payer_user_id=payment.user_id
          AND capture.stars_amount=payment.stars_amount
          AND fulfillment.state IN ('correction_required','corrected')
          AND fulfillment.correction_required_at IS NOT NULL
          AND fulfillment.lease_owner IS NULL AND fulfillment.lease_expires_at IS NULL
          AND EXISTS(SELECT 1 FROM billing.refund_records refund WHERE refund.payment_record_id=payment.id
            AND refund.user_id=payment.user_id AND refund.funding_type='telegram_stars'
            AND refund.telegram_charge_id=capture.telegram_charge_id AND refund.stars_amount=capture.stars_amount
            AND refund.original_credit_transaction_id IS NULL AND refund.refund_credit_transaction_id IS NULL
            AND refund.credits_amount IS NULL AND refund.reason_code='target_unavailable'
            AND refund.idempotency_key='stars-refund:'||payment.id::text
            AND ((fulfillment.state='corrected' AND fulfillment.corrected_at IS NOT NULL
              AND refund.status='processed' AND refund.processed_at IS NOT NULL
              AND refund.provider_progress='refund_confirmed' AND payment.status='refunded')
              OR (fulfillment.state='correction_required' AND fulfillment.corrected_at IS NULL
                AND refund.status<>'processed' AND refund.processed_at IS NULL AND payment.status<>'refunded'))),false))
$$;

-- The same current-life, full transaction and commit-time fence protects the
-- terminal executor below. Historical proof does not grant new removal authority.
CREATE FUNCTION identity.terminal_pending_receipt_fence(receipt identity.account_deletion_terminal_pending_receipts)
  RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=receipt.pending_nakh_id
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

CREATE FUNCTION identity.guard_terminal_pending_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source nakh.pending_nakh_lifecycle_facts;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'terminal pending receipt requires controlled retained release' USING ERRCODE='55000';
  END IF;
  SELECT * INTO source FROM nakh.pending_nakh_lifecycle_facts WHERE id=NEW.pending_nakh_id;
  IF NOT identity.terminal_pending_receipt_fence(NEW) OR source.id IS NULL
    OR NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE id=NEW.pending_nakh_id)
    OR source.status IS DISTINCT FROM NEW.source_status OR source.version IS DISTINCT FROM NEW.source_version
    OR source.expires_at IS DISTINCT FROM NEW.expires_at
    OR COALESCE(source.cancelled_at,source.expired_at,source.closed_at) IS DISTINCT FROM NEW.terminal_at
    OR source.cancel_resolution IS DISTINCT FROM NEW.cancel_resolution
    OR nakh.terminal_pending_closure_valid(source) IS NOT TRUE THEN
    RAISE EXCEPTION 'terminal pending original closure or fence missing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION billing.pending_nakh_has_bound_closure(subject uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending WHERE pending.id=subject
    AND pending.status='closed_by_system' AND nakh.terminal_pending_closure_valid(pending))
$$;

-- Terminal sources stay in the shared financial blocker after archival. A lost
-- receipt or damaged original refund cannot silently become absence authority.
CREATE OR REPLACE FUNCTION identity.deletion_has_unresolved_shared_payments(subject uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE wanted uuid[]; blocked boolean;
BEGIN
  -- Discover conservatively from raw participants, original references and the
  -- owning archival root. None of these candidates is removal authority.
  SELECT array_agg(id) INTO wanted FROM (
    SELECT pending.id FROM nakh.pending_nakhes pending
      LEFT JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
      LEFT JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=pending.id
      WHERE pending.sender_user_id=subject OR flow.receiver_user_id=subject OR anchor.receiver_user_id=subject
    UNION
    SELECT anchor.id FROM nakh.pending_nakh_reference_anchors anchor
      LEFT JOIN nakh.nakh_flows flow ON flow.id=anchor.nakh_flow_id
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
CREATE TRIGGER terminal_pending_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
  ON identity.account_deletion_terminal_pending_receipts FOR EACH ROW
  EXECUTE FUNCTION identity.guard_terminal_pending_archival_receipt();

CREATE FUNCTION identity.require_terminal_pending_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source nakh.pending_nakh_lifecycle_facts; root identity.account_deletion_records;
BEGIN
  SELECT * INTO source FROM nakh.pending_nakh_lifecycle_facts WHERE id=NEW.pending_nakh_id;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=NEW.deletion_record_id;
  IF NOT identity.terminal_pending_receipt_fence(NEW) OR source.id IS NULL
    OR EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE id=NEW.pending_nakh_id)
    OR source.status IS DISTINCT FROM NEW.source_status OR source.version IS DISTINCT FROM NEW.source_version
    OR source.expires_at IS DISTINCT FROM NEW.expires_at
    OR COALESCE(source.cancelled_at,source.expired_at,source.closed_at) IS DISTINCT FROM NEW.terminal_at
    OR source.cancel_resolution IS DISTINCT FROM NEW.cancel_resolution
    OR nakh.terminal_pending_closure_valid(source) IS NOT TRUE
    OR NOT identity.terminal_pending_receipt_proof_valid(NEW)
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.id=NEW.event_id
      AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
      AND event.event_type='account.deletion-terminal-pending-batch.v1' AND event.schema_version=1
      AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','terminal_pending_source','rows',1,'auditId',NEW.audit_id)
      AND event.correlation_id=root.request_id AND event.causation_id=root.command_id
      AND event.occurred_at=NEW.archived_at AND event.available_at=NEW.archived_at) THEN
    RAISE EXCEPTION 'terminal pending removal, lease or mandatory chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER terminal_pending_archival_receipt_required
  AFTER INSERT ON identity.account_deletion_terminal_pending_receipts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION identity.require_terminal_pending_archival_receipt();

CREATE OR REPLACE FUNCTION nakh.guard_pending_nakh_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND (
    EXISTS(SELECT 1 FROM identity.account_deletion_paid_pending_receipts receipt
      WHERE receipt.pending_nakh_id=OLD.id AND receipt.source_version=OLD.version
        AND receipt.expires_at=OLD.expires_at AND receipt.paid_at=OLD.paid_at
        AND receipt.batch_transaction=pg_current_xact_id() AND identity.paid_pending_receipt_fence(receipt))
    OR EXISTS(SELECT 1 FROM identity.account_deletion_terminal_pending_receipts receipt
      WHERE receipt.pending_nakh_id=OLD.id AND receipt.source_status=OLD.status AND receipt.source_version=OLD.version
        AND receipt.expires_at=OLD.expires_at
        AND receipt.terminal_at=COALESCE(OLD.cancelled_at,OLD.expired_at,OLD.closed_at)
        AND receipt.cancel_resolution IS NOT DISTINCT FROM OLD.cancel_resolution
        AND receipt.batch_transaction=pg_current_xact_id() AND identity.terminal_pending_receipt_fence(receipt))
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'pending Nakh requires current verified archival' USING ERRCODE='55000';
END $$;



CREATE FUNCTION nakh.purge_deletion_terminal_pending_source(deletion_id uuid,subject uuid,worker uuid,generation integer)
  RETURNS TABLE(purged_rows integer,has_more boolean) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work; source nakh.pending_nakhes;
  candidate uuid; counterpart uuid;
  proof identity.account_deletion_terminal_pending_receipts; writes integer;
BEGIN
  IF deletion_id IS NULL OR subject IS NULL OR worker IS NULL OR generation IS NULL OR generation<1 THEN
    RAISE EXCEPTION 'terminal pending archival lease invalid' USING ERRCODE='40001';
  END IF;
  -- Conservative discovery includes damaged references. Discovery grants no
  -- removal authority; the owning original-life fence and complete proof below do.
  SELECT pending.id,CASE WHEN pending.sender_user_id=subject
    THEN COALESCE(flow.receiver_user_id,anchor.receiver_user_id,delivered.receiver_user_id)
    ELSE pending.sender_user_id END INTO candidate,counterpart
  FROM nakh.pending_nakhes pending
  LEFT JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
  LEFT JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=pending.id
  LEFT JOIN nakh.nakh_reference_anchors delivered ON delivered.nakh_flow_id=pending.nakh_flow_id
  WHERE pending.status IN ('cancelled','expired','closed_by_system') AND (pending.sender_user_id=subject OR flow.receiver_user_id=subject
    OR anchor.receiver_user_id=subject OR delivered.receiver_user_id=subject)
  ORDER BY pending.id LIMIT 1;
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
    RAISE EXCEPTION 'terminal pending archival original lease or capture proof missing' USING ERRCODE='40001';
  END IF;
  SELECT * INTO source FROM nakh.pending_nakhes WHERE id=candidate FOR UPDATE;
  purged_rows:=0;
  IF source.id IS NOT NULL THEN
    -- Retained intent identity is unchanged. Serialize archive with legitimate
    -- receipt admission, then recheck complete terminal authority at commit.
    PERFORM id FROM billing.pending_payments WHERE id=source.pending_payment_id FOR UPDATE;
    proof.id:=gen_random_uuid(); proof.pending_nakh_id:=source.id; proof.source_status:=source.status;
    proof.deletion_record_id:=root.id; proof.source_version:=source.version;
    proof.expires_at:=source.expires_at;
    proof.terminal_at:=COALESCE(source.cancelled_at,source.expired_at,source.closed_at);
    proof.cancel_resolution:=source.cancel_resolution;
    proof.batch_transaction:=pg_current_xact_id(); proof.lease_owner:=worker;
    proof.lease_generation:=generation; proof.lease_expires_at:=job.lease_expires_at;
    proof.archived_at:=clock_timestamp(); proof.audit_id:=gen_random_uuid(); proof.event_id:=gen_random_uuid();
    INSERT INTO identity.account_deletion_terminal_pending_receipts SELECT proof.*;
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'terminal pending archival receipt missing' USING ERRCODE='23514'; END IF;
    DELETE FROM nakh.pending_nakhes WHERE id=source.id;
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'terminal pending archival body removal incomplete' USING ERRCODE='23514'; END IF;
    INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,
      metadata_schema_version,metadata,command_id,request_id,occurred_at)
    VALUES(proof.audit_id,'account','account.deletion-terminal-pending-batch.v1','system','account_deletion',root.id,
      'terminal_pending_archived',1,jsonb_build_object('kind','terminal_pending_source','rows',1,
        'receiptDigest',identity.terminal_pending_receipt_digest(proof)),root.command_id,root.request_id,proof.archived_at);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'terminal pending archival audit missing' USING ERRCODE='23514'; END IF;
    INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
      occurred_at,available_at,correlation_id,causation_id)
    VALUES(proof.event_id,'account_deletion',root.id,'account.deletion-terminal-pending-batch.v1',1,
      jsonb_build_object('deletionRecordId',root.id,'kind','terminal_pending_source','rows',1,'auditId',proof.audit_id),
      proof.archived_at,proof.archived_at,root.request_id,root.command_id);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'terminal pending archival event missing' USING ERRCODE='23514'; END IF;
    purged_rows:=1;
  END IF;
  IF job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'terminal pending archival lease expired' USING ERRCODE='40001';
  END IF;
  SELECT EXISTS(SELECT 1 FROM nakh.pending_nakhes pending
    LEFT JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
    LEFT JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=pending.id
    LEFT JOIN nakh.nakh_reference_anchors delivered ON delivered.nakh_flow_id=pending.nakh_flow_id
    WHERE pending.status IN ('cancelled','expired','closed_by_system') AND (pending.sender_user_id=subject OR flow.receiver_user_id=subject
      OR anchor.receiver_user_id=subject OR delivered.receiver_user_id=subject)) INTO has_more;
  RETURN NEXT;
END $$;
