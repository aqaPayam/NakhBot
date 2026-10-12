-- Paid pending bodies may be removed only after complete original funding and
-- final delivered archival. Captured money remains recordable and refundable.
-- No financial row, Flow, retained reference or preview is removed here.

CREATE FUNCTION billing.require_pending_capture_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment billing.payment_records; capture billing.telegram_stars_receipts;
  fulfillment billing.payment_fulfillments; terminal_event text;
BEGIN
  SELECT * INTO payment FROM billing.payment_records WHERE id=NEW.payment_record_id;
  IF payment.id IS NULL OR payment.payment_type<>'pay_pending_action'
    OR payment.paid_action_reason IS DISTINCT FROM 'send_nakh' THEN RETURN NULL; END IF;
  SELECT * INTO capture FROM billing.telegram_stars_receipts WHERE payment_record_id=payment.id;
  SELECT * INTO fulfillment FROM billing.payment_fulfillments WHERE payment_record_id=payment.id;
  IF capture.payment_record_id IS NULL OR fulfillment.payment_record_id IS NULL
    OR capture.payer_user_id IS DISTINCT FROM payment.user_id
    OR capture.stars_amount IS DISTINCT FROM payment.stars_amount
    OR fulfillment.state NOT IN ('receipt_recorded','correction_required')
    OR fulfillment.lease_owner IS NOT NULL OR fulfillment.lease_expires_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM billing.payment_provider_events event
      WHERE event.provider='telegram_stars' AND event.provider_event_id=capture.provider_event_id
        AND event.payment_record_id=payment.id AND event.payer_user_id=payment.user_id
        AND event.event_type='successful_payment' AND event.decision='receipt_recorded'
        AND event.reason_code IS NULL AND event.received_at=capture.received_at) THEN
    RAISE EXCEPTION 'pending captured payment lacks its complete receipt chain' USING ERRCODE='23514';
  END IF;
  terminal_event:=CASE fulfillment.state WHEN 'receipt_recorded' THEN 'billing.payment-receipt-recorded.v1'
    ELSE 'billing.payment-correction-required.v1' END;
  IF (SELECT count(*) FROM platform.outbox_events event WHERE event.aggregate_type='payment_record'
    AND event.aggregate_id=payment.id AND event.event_type=terminal_event AND event.schema_version=1
    AND event.payload=jsonb_build_object('paymentRecordId',payment.id)
    AND event.occurred_at=capture.received_at AND event.available_at=capture.received_at
    AND event.correlation_id=event.id AND event.causation_id=event.id)<>1 THEN
    RAISE EXCEPTION 'pending captured payment lacks its mandatory event' USING ERRCODE='23514';
  END IF;
  IF fulfillment.state='correction_required' AND (
    fulfillment.correction_required_at IS DISTINCT FROM capture.received_at
    OR fulfillment.last_error_code IS DISTINCT FROM 'payment_state_conflict'
    OR NOT EXISTS(SELECT 1 FROM billing.refund_records refund WHERE refund.payment_record_id=payment.id
      AND refund.user_id=payment.user_id AND refund.funding_type='telegram_stars'
      AND refund.telegram_charge_id=capture.telegram_charge_id AND refund.stars_amount=capture.stars_amount
      AND refund.original_credit_transaction_id IS NULL AND refund.refund_credit_transaction_id IS NULL
      AND refund.credits_amount IS NULL AND refund.reason_code='target_unavailable'
      AND refund.idempotency_key='stars-refund:'||payment.id::text AND refund.status='pending'
      AND refund.created_at=capture.received_at AND refund.processed_at IS NULL AND refund.failed_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'pending captured correction lacks its original refund' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
-- Either mandatory parent catches suppression of the other. These validate
-- newly recorded receipts only, never revalidate expired transport at replay.
CREATE CONSTRAINT TRIGGER pending_capture_receipt_required AFTER INSERT ON billing.telegram_stars_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.require_pending_capture_chain();
CREATE CONSTRAINT TRIGGER pending_capture_fulfillment_required AFTER INSERT ON billing.payment_fulfillments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.require_pending_capture_chain();

CREATE TABLE identity.account_deletion_paid_pending_receipts (
  id uuid PRIMARY KEY,
  pending_nakh_id uuid NOT NULL UNIQUE REFERENCES nakh.pending_nakh_reference_anchors(id) ON DELETE RESTRICT,
  nakh_id uuid NOT NULL UNIQUE REFERENCES nakh.nakh_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  source_version integer NOT NULL CHECK(source_version>=2),
  expires_at timestamptz NOT NULL,
  paid_at timestamptz NOT NULL,
  batch_transaction xid8 NOT NULL,
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE
);
CREATE INDEX deletion_paid_pending_receipts_root_idx
  ON identity.account_deletion_paid_pending_receipts(deletion_record_id,id);

-- Only content-free receipt fields enter this digest. Epoch microseconds avoid
-- TimeZone/DateStyle-dependent timestamp rendering; no body or request hash is retained.
CREATE FUNCTION identity.paid_pending_receipt_digest(receipt identity.account_deletion_paid_pending_receipts)
  RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('id',receipt.id,
    'pendingNakhId',receipt.pending_nakh_id,'nakhId',receipt.nakh_id,
    'deletionRecordId',receipt.deletion_record_id,'version',receipt.source_version,
    'expiresAt',(extract(epoch FROM receipt.expires_at)*1000000)::bigint,
    'paidAt',(extract(epoch FROM receipt.paid_at)*1000000)::bigint,
    'transaction',receipt.batch_transaction::text,'leaseOwner',receipt.lease_owner,
    'generation',receipt.lease_generation,
    'leaseExpiresAt',(extract(epoch FROM receipt.lease_expires_at)*1000000)::bigint,
    'archivedAt',(extract(epoch FROM receipt.archived_at)*1000000)::bigint,
    'auditId',receipt.audit_id,'eventId',receipt.event_id)::text,'UTF8')),'hex')
$$;

-- Historical proof has no current Account/worker predicate and does not require
-- an expired transport event. It never calls funded-scope validation recursively.
CREATE FUNCTION identity.paid_pending_receipt_proof_valid(receipt identity.account_deletion_paid_pending_receipts)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN nakh.pending_nakh_reference_anchors pending ON pending.id=receipt.pending_nakh_id
    JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
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

-- Entity presence remains independent of valid proof. Missing anchors or damaged
-- receipts cannot hide an archived entity; an anchor-only sentinel grants no lifecycle.
CREATE VIEW nakh.pending_nakh_lifecycle_facts AS
  SELECT pending.id,pending.nakh_flow_id,pending.sender_user_id,pending.pending_payment_id,
    pending.status,pending.version,pending.expires_at,pending.paid_at,true AS shape_valid
  FROM nakh.pending_nakhes pending
  UNION ALL
  SELECT receipt.pending_nakh_id,anchor.nakh_flow_id,anchor.sender_user_id,anchor.pending_payment_id,
    'paid_and_sent',receipt.source_version,receipt.expires_at,receipt.paid_at,
    identity.paid_pending_receipt_proof_valid(receipt)
  FROM identity.account_deletion_paid_pending_receipts receipt
  LEFT JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=receipt.pending_nakh_id
  WHERE NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE id=receipt.pending_nakh_id)
  UNION ALL
  SELECT anchor.id,anchor.nakh_flow_id,anchor.sender_user_id,anchor.pending_payment_id,
    'missing',NULL::integer,NULL::timestamptz,NULL::timestamptz,false
  FROM nakh.pending_nakh_reference_anchors anchor
  WHERE NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE id=anchor.id)
    AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_paid_pending_receipts WHERE pending_nakh_id=anchor.id);

CREATE OR REPLACE FUNCTION nakh.original_pending_reference_valid(subject uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending
    JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=pending.id
    JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
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

-- Original pending references must remain complete for archival and funded replay.
-- This read-only proof grants no new delivery, refund, deletion or fresh Return.
CREATE OR REPLACE FUNCTION nakh.original_funded_scope_valid(source_id uuid,flow_id uuid,sender uuid,receiver uuid,
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

-- Financial intent snapshot checks follow the same proven lifecycle facts after
-- body removal. Every original snapshot and epoch predicate remains mandatory.
CREATE OR REPLACE FUNCTION nakh.verify_pending_nakh_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid;
BEGIN
  IF TG_TABLE_SCHEMA='billing' THEN
    IF NEW.reason<>'send_nakh' THEN RETURN NULL; END IF;
    subject:=NEW.target_id;
  ELSE subject:=NEW.id; END IF;
  IF NOT EXISTS(SELECT 1 FROM nakh.pending_nakh_lifecycle_facts pending
    JOIN billing.pending_payments intent ON intent.id=pending.pending_payment_id
    WHERE pending.id=subject AND pending.shape_valid AND nakh.original_pending_reference_valid(pending.id)
      AND intent.reason='send_nakh' AND intent.target_type='pending_nakh' AND intent.target_id=pending.id
      AND intent.user_id=pending.sender_user_id AND intent.funding_type='telegram_stars'
      AND intent.required_stars=2 AND intent.required_credits IS NULL AND intent.expires_at=pending.expires_at) THEN
    RAISE EXCEPTION 'pending Nakh payment snapshot is missing or inconsistent' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION nakh.paid_pending_source_archivable(source nakh.pending_nakh_lifecycle_facts,delivered_id uuid)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT source.shape_valid AND source.status='paid_and_sent' AND source.version>=2 AND source.paid_at IS NOT NULL
    AND nakh.original_pending_reference_valid(source.id)
    AND EXISTS(SELECT 1 FROM nakh.nakh_lifecycle_facts delivered
      JOIN identity.account_deletion_nakh_receipts final ON final.nakh_id=delivered.id AND final.final_batch
      WHERE delivered.id=delivered_id AND delivered.nakh_flow_id=source.nakh_flow_id
        AND delivered.sender_user_id=source.sender_user_id AND delivered.status IN ('accepted','rejected','expired','closed')
        AND NOT EXISTS(SELECT 1 FROM nakh.nakhes WHERE id=delivered.id)
        AND nakh.original_funded_scope_valid(delivered.id,delivered.nakh_flow_id,
          delivered.sender_user_id,delivered.receiver_user_id,delivered.funding_type,
          delivered.credit_transaction_id,delivered.payment_record_id)
        AND (delivered.funding_type='credits' OR EXISTS(SELECT 1 FROM billing.payment_fulfillments fulfillment
          JOIN billing.telegram_stars_receipts capture ON capture.payment_record_id=fulfillment.payment_record_id
          JOIN billing.payment_records payment ON payment.id=capture.payment_record_id
          WHERE fulfillment.payment_record_id=delivered.payment_record_id AND fulfillment.state='fulfilled'
            AND capture.payer_user_id=payment.user_id AND capture.stars_amount=payment.stars_amount
            AND capture.telegram_charge_id=payment.provider_payment_id)))
    -- Uncaptured competing invoices remain for genuine late callbacks. Captured
    -- attempts must already be the selected delivery or an exact original refund;
    -- no queued receipt/worker can lose its live target through this archival.
    AND NOT EXISTS(SELECT 1 FROM billing.payment_records payment
      LEFT JOIN billing.telegram_stars_receipts capture ON capture.payment_record_id=payment.id
      LEFT JOIN billing.payment_fulfillments fulfillment ON fulfillment.payment_record_id=payment.id
      WHERE payment.pending_payment_id=source.pending_payment_id
        AND (payment.status='paid' OR capture.payment_record_id IS NOT NULL)
        AND NOT COALESCE(capture.payer_user_id=payment.user_id AND capture.stars_amount=payment.stars_amount
          AND ((fulfillment.state='fulfilled' AND EXISTS(SELECT 1 FROM nakh.nakh_lifecycle_facts delivered
            WHERE delivered.id=delivered_id AND delivered.payment_record_id=payment.id))
          OR (fulfillment.state IN ('correction_required','corrected') AND EXISTS(
            SELECT 1 FROM billing.refund_records refund WHERE refund.payment_record_id=payment.id
              AND refund.user_id=payment.user_id AND refund.funding_type='telegram_stars'
              AND refund.telegram_charge_id=capture.telegram_charge_id AND refund.stars_amount=capture.stars_amount
              AND refund.original_credit_transaction_id IS NULL AND refund.refund_credit_transaction_id IS NULL
              AND refund.credits_amount IS NULL AND refund.reason_code='target_unavailable'
              AND refund.idempotency_key='stars-refund:'||payment.id::text
              AND ((fulfillment.state='corrected' AND refund.status='processed' AND refund.processed_at IS NOT NULL)
                OR (fulfillment.state='correction_required' AND refund.status<>'processed' AND refund.processed_at IS NULL))
          ))),false))
$$;

CREATE FUNCTION identity.paid_pending_receipt_fence(receipt identity.account_deletion_paid_pending_receipts)
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

CREATE FUNCTION identity.guard_paid_pending_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source nakh.pending_nakh_lifecycle_facts;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'paid pending receipt requires controlled retained release' USING ERRCODE='55000';
  END IF;
  SELECT * INTO source FROM nakh.pending_nakh_lifecycle_facts WHERE id=NEW.pending_nakh_id;
  IF NOT identity.paid_pending_receipt_fence(NEW) OR source.id IS NULL
    OR NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE id=NEW.pending_nakh_id)
    OR source.version IS DISTINCT FROM NEW.source_version OR source.expires_at IS DISTINCT FROM NEW.expires_at
    OR source.paid_at IS DISTINCT FROM NEW.paid_at
    OR nakh.paid_pending_source_archivable(source,NEW.nakh_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'paid pending archival original proof or fence missing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paid_pending_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
  ON identity.account_deletion_paid_pending_receipts FOR EACH ROW
  EXECUTE FUNCTION identity.guard_paid_pending_archival_receipt();

CREATE FUNCTION identity.require_paid_pending_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source nakh.pending_nakh_lifecycle_facts; root identity.account_deletion_records;
BEGIN
  SELECT * INTO source FROM nakh.pending_nakh_lifecycle_facts WHERE id=NEW.pending_nakh_id;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=NEW.deletion_record_id;
  IF NOT identity.paid_pending_receipt_fence(NEW) OR source.id IS NULL
    OR EXISTS(SELECT 1 FROM nakh.pending_nakhes WHERE id=NEW.pending_nakh_id)
    OR source.version IS DISTINCT FROM NEW.source_version OR source.expires_at IS DISTINCT FROM NEW.expires_at
    OR source.paid_at IS DISTINCT FROM NEW.paid_at
    OR nakh.paid_pending_source_archivable(source,NEW.nakh_id) IS NOT TRUE
    OR NOT identity.paid_pending_receipt_proof_valid(NEW)
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.id=NEW.event_id
      AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
      AND event.event_type='account.deletion-paid-pending-batch.v1' AND event.schema_version=1
      AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','paid_pending_source','rows',1,'auditId',NEW.audit_id)
      AND event.correlation_id=root.request_id AND event.causation_id=root.command_id
      AND event.occurred_at=NEW.archived_at AND event.available_at=NEW.archived_at) THEN
    RAISE EXCEPTION 'paid pending archival removal, lease or mandatory chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER paid_pending_archival_receipt_required
  AFTER INSERT ON identity.account_deletion_paid_pending_receipts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION identity.require_paid_pending_archival_receipt();

ALTER FUNCTION nakh.guard_pending_nakh_lifecycle() RENAME TO guard_pending_nakh_lifecycle_before_archival;
CREATE FUNCTION nakh.guard_pending_nakh_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM identity.account_deletion_paid_pending_receipts receipt
    WHERE receipt.pending_nakh_id=OLD.id AND receipt.source_version=OLD.version
      AND receipt.expires_at=OLD.expires_at AND receipt.paid_at=OLD.paid_at
      AND receipt.batch_transaction=pg_current_xact_id() AND identity.paid_pending_receipt_fence(receipt)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pending Nakh requires current verified paid archival' USING ERRCODE='55000';
END $$;
DROP TRIGGER pending_nakhes_lifecycle_guard ON nakh.pending_nakhes;
CREATE TRIGGER pending_nakhes_lifecycle_guard BEFORE UPDATE ON nakh.pending_nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_pending_nakh_lifecycle_before_archival();
CREATE TRIGGER pending_nakhes_paid_archival_guard BEFORE DELETE ON nakh.pending_nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_pending_nakh_lifecycle();

CREATE FUNCTION nakh.purge_deletion_paid_pending_source(deletion_id uuid,subject uuid,worker uuid,generation integer)
  RETURNS TABLE(purged_rows integer,has_more boolean) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work; source nakh.pending_nakhes;
  candidate uuid; counterpart uuid; delivered_id uuid;
  proof identity.account_deletion_paid_pending_receipts; writes integer;
BEGIN
  IF deletion_id IS NULL OR subject IS NULL OR worker IS NULL OR generation IS NULL OR generation<1 THEN
    RAISE EXCEPTION 'paid pending archival lease invalid' USING ERRCODE='40001';
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
  WHERE pending.status='paid_and_sent' AND (pending.sender_user_id=subject OR flow.receiver_user_id=subject
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
    RAISE EXCEPTION 'paid pending archival original lease or capture proof missing' USING ERRCODE='40001';
  END IF;
  SELECT * INTO source FROM nakh.pending_nakhes WHERE id=candidate FOR UPDATE;
  purged_rows:=0;
  IF source.id IS NOT NULL THEN
    SELECT id INTO delivered_id FROM nakh.nakh_reference_anchors WHERE nakh_flow_id=source.nakh_flow_id;
    -- Retained intent identity is unchanged. Serialize archive with legitimate
    -- receipt admission, then recheck complete terminal authority at commit.
    PERFORM id FROM billing.pending_payments WHERE id=source.pending_payment_id FOR UPDATE;
    proof.id:=gen_random_uuid(); proof.pending_nakh_id:=source.id; proof.nakh_id:=delivered_id;
    proof.deletion_record_id:=root.id; proof.source_version:=source.version;
    proof.expires_at:=source.expires_at; proof.paid_at:=source.paid_at;
    proof.batch_transaction:=pg_current_xact_id(); proof.lease_owner:=worker;
    proof.lease_generation:=generation; proof.lease_expires_at:=job.lease_expires_at;
    proof.archived_at:=clock_timestamp(); proof.audit_id:=gen_random_uuid(); proof.event_id:=gen_random_uuid();
    INSERT INTO identity.account_deletion_paid_pending_receipts SELECT proof.*;
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'paid pending archival receipt missing' USING ERRCODE='23514'; END IF;
    DELETE FROM nakh.pending_nakhes WHERE id=source.id;
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'paid pending archival body removal incomplete' USING ERRCODE='23514'; END IF;
    INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,
      metadata_schema_version,metadata,command_id,request_id,occurred_at)
    VALUES(proof.audit_id,'account','account.deletion-paid-pending-batch.v1','system','account_deletion',root.id,
      'paid_pending_archived',1,jsonb_build_object('kind','paid_pending_source','rows',1,
        'receiptDigest',identity.paid_pending_receipt_digest(proof)),root.command_id,root.request_id,proof.archived_at);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'paid pending archival audit missing' USING ERRCODE='23514'; END IF;
    INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
      occurred_at,available_at,correlation_id,causation_id)
    VALUES(proof.event_id,'account_deletion',root.id,'account.deletion-paid-pending-batch.v1',1,
      jsonb_build_object('deletionRecordId',root.id,'kind','paid_pending_source','rows',1,'auditId',proof.audit_id),
      proof.archived_at,proof.archived_at,root.request_id,root.command_id);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 THEN RAISE EXCEPTION 'paid pending archival event missing' USING ERRCODE='23514'; END IF;
    purged_rows:=1;
  END IF;
  IF job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'paid pending archival lease expired' USING ERRCODE='40001';
  END IF;
  SELECT EXISTS(SELECT 1 FROM nakh.pending_nakhes pending
    LEFT JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
    LEFT JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=pending.id
    LEFT JOIN nakh.nakh_reference_anchors delivered ON delivered.nakh_flow_id=pending.nakh_flow_id
    WHERE pending.status='paid_and_sent' AND (pending.sender_user_id=subject OR flow.receiver_user_id=subject
      OR anchor.receiver_user_id=subject OR delivered.receiver_user_id=subject)) INTO has_more;
  RETURN NEXT;
END $$;

COMMENT ON TABLE identity.account_deletion_paid_pending_receipts IS
  'Immutable phase-3 original paid pending archival proof; terminal scalars and content-free binding only. No prose, action/request hashes, financial deletion, Flow removal, phase completion, fresh Return or retained release.';
COMMENT ON VIEW nakh.pending_nakh_lifecycle_facts IS
  'Internal live or audited archived pending facts, plus non-authorizing missing-source sentinels. Reconciliation and original financial proof only; product admission still requires a live source.';
