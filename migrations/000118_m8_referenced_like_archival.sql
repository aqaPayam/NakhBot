-- Ordinary Like removal retains only original identity/lives and audited proof.
CREATE TABLE identity.account_deletion_like_receipts (
  id uuid PRIMARY KEY,
  like_id uuid NOT NULL UNIQUE REFERENCES interaction.like_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  batch_transaction xid8 NOT NULL,
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE
);
CREATE INDEX deletion_like_receipts_root_idx ON identity.account_deletion_like_receipts(deletion_record_id,id);

CREATE FUNCTION identity.like_receipt_digest(receipt identity.account_deletion_like_receipts)
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('id',receipt.id,'likeId',receipt.like_id,
    'deletionRecordId',receipt.deletion_record_id,'transaction',receipt.batch_transaction::text,
    'owner',receipt.lease_owner,'generation',receipt.lease_generation,
    'leaseExpiresAt',(extract(epoch FROM receipt.lease_expires_at)*1000000)::bigint,
    'archivedAt',(extract(epoch FROM receipt.archived_at)*1000000)::bigint,
    'auditId',receipt.audit_id,'eventId',receipt.event_id,
    'sender',anchor.sender_user_id,'receiver',anchor.receiver_user_id,
    'senderEpoch',anchor.sender_product_epoch,'receiverEpoch',anchor.receiver_product_epoch)::text,'UTF8')),'hex')
  FROM interaction.like_reference_anchors anchor WHERE anchor.id=receipt.like_id
$$;

-- Authenticate original removal independently of funding checks. Historical
-- authenticity never grants a new transaction authority or product access.
CREATE FUNCTION identity.like_receipt_proof_valid(receipt identity.account_deletion_like_receipts)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM interaction.like_reference_anchors anchor
    JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE anchor.id=receipt.like_id
      AND ((root.user_id=anchor.sender_user_id AND root.product_epoch=anchor.sender_product_epoch)
        OR (root.user_id=anchor.receiver_user_id AND root.product_epoch=anchor.receiver_product_epoch))
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND audit.category='account' AND audit.event_type='account.deletion-like-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.result_code='like_archived' AND audit.metadata_schema_version=1
      AND audit.metadata=jsonb_build_object('kind','like_source','rows',1,'receiptDigest',identity.like_receipt_digest(receipt))
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=receipt.archived_at)
$$;

CREATE FUNCTION identity.like_receipt_fence(receipt identity.account_deletion_like_receipts)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT receipt.batch_transaction=pg_current_xact_id() AND EXISTS(
    SELECT 1 FROM identity.account_deletion_records root JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN interaction.like_reference_anchors anchor ON anchor.id=receipt.like_id
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

CREATE FUNCTION interaction.like_source_archivable(subject uuid) RETURNS boolean
LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE anchor interaction.like_reference_anchors; source interaction.likes;
BEGIN
  SELECT * INTO anchor FROM interaction.like_reference_anchors WHERE id=subject;
  IF anchor.id IS NULL THEN RETURN false; END IF;
  SELECT * INTO source FROM interaction.likes WHERE id=subject;
  IF source.id IS NOT NULL THEN
    IF source.status='active' OR source.closed_at IS NULL
      OR source.sender_user_id<>anchor.sender_user_id OR source.receiver_user_id<>anchor.receiver_user_id
      OR source.sender_product_epoch<>anchor.sender_product_epoch OR source.receiver_product_epoch<>anchor.receiver_product_epoch THEN RETURN false; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM identity.account_deletion_like_receipts receipt
    WHERE receipt.like_id=subject AND identity.like_receipt_proof_valid(receipt)) THEN RETURN false;
  END IF;
  -- A live Match still owns its source FK. Archived Match proof is preserved.
  IF EXISTS(SELECT 1 FROM matching.matches WHERE subject IN (source_like_a_id,source_like_b_id)) THEN RETURN false; END IF;
  -- Keep the original funded unlock and all ledger/payment rows. A reference is
  -- historical ownership only; it never grants live product access.
  IF EXISTS(SELECT 1 FROM interaction.feature_unlocks grant_row WHERE grant_row.like_id=subject
    AND (grant_row.status='active' OR grant_row.payer_user_id<>anchor.receiver_user_id
      OR grant_row.feature_type<>'liked_by_profile_unlock' OR grant_row.match_id IS NOT NULL
      OR NOT ((grant_row.payment_record_id IS NULL AND EXISTS(
        SELECT 1 FROM billing.credit_transactions credit WHERE credit.id=grant_row.credit_transaction_id
          AND credit.feature_unlock_id=grant_row.id AND credit.user_id=anchor.receiver_user_id
          AND credit.product_epoch=anchor.receiver_product_epoch AND credit.transaction_type='spend_liked_by_unlock'
          AND credit.amount<0 AND credit.balance_after=credit.balance_before+credit.amount
          AND credit.payment_record_id IS NULL AND credit.pending_payment_id IS NULL AND credit.nakh_id IS NULL))
        OR (grant_row.credit_transaction_id IS NULL AND EXISTS(
          SELECT 1 FROM billing.payment_records payment JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
          JOIN billing.telegram_stars_receipts receipt ON receipt.payment_record_id=payment.id
          JOIN billing.payment_fulfillments fulfillment ON fulfillment.payment_record_id=payment.id
          WHERE payment.id=grant_row.payment_record_id AND payment.user_id=anchor.receiver_user_id
            AND intent.user_id=payment.user_id AND intent.product_epoch=anchor.receiver_product_epoch
            AND intent.target_type='like' AND intent.target_id=subject AND intent.status='paid'
            AND payment.payment_type='direct_paid_action' AND payment.paid_action_reason='unlock_liked_by_profile'
            AND payment.status IN ('paid','refunded') AND payment.stars_amount=receipt.stars_amount
            AND payment.provider_payment_id=receipt.telegram_charge_id AND receipt.payer_user_id=anchor.receiver_user_id
            AND fulfillment.state='fulfilled'))))) THEN RETURN false; END IF;
  RETURN true;
END $$;

CREATE FUNCTION identity.guard_like_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Like receipt requires controlled retained release' USING ERRCODE='55000'; END IF;
  IF NOT identity.like_receipt_fence(NEW) OR NOT EXISTS(SELECT 1 FROM interaction.likes WHERE id=NEW.like_id)
    OR interaction.like_source_archivable(NEW.like_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Like original source, financial closure or fence missing' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER like_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_like_receipts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_like_archival_receipt();

CREATE FUNCTION interaction.require_referenced_like_archival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM interaction.like_reference_anchors WHERE id=OLD.id) THEN RETURN OLD; END IF;
  IF EXISTS(SELECT 1 FROM identity.account_deletion_like_receipts receipt
    WHERE receipt.like_id=OLD.id AND identity.like_receipt_fence(receipt)
      AND identity.like_receipt_proof_valid(receipt) AND interaction.like_source_archivable(OLD.id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'referenced Like removal lacks its exact archival transaction' USING ERRCODE='55000';
END $$;
CREATE TRIGGER referenced_like_archival_delete_guard BEFORE DELETE ON interaction.likes
  FOR EACH ROW EXECUTE FUNCTION interaction.require_referenced_like_archival();

CREATE FUNCTION identity.require_like_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT identity.like_receipt_fence(NEW) OR EXISTS(SELECT 1 FROM interaction.likes WHERE id=NEW.like_id)
    OR NOT identity.like_receipt_proof_valid(NEW) OR interaction.like_source_archivable(NEW.like_id) IS NOT TRUE
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event JOIN identity.account_deletion_records root ON root.id=NEW.deletion_record_id
      WHERE event.id=NEW.event_id AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
        AND event.event_type='account.deletion-like-batch.v1' AND event.schema_version=1
        AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','like_source','rows',1,'auditId',NEW.audit_id)
        AND event.correlation_id=root.request_id AND event.causation_id=root.command_id
        AND event.occurred_at=NEW.archived_at AND event.available_at=NEW.archived_at) THEN
    RAISE EXCEPTION 'Like removal, lease or mandatory proof incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER like_archival_receipt_required AFTER INSERT ON identity.account_deletion_like_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_like_archival_receipt();

CREATE FUNCTION interaction.purge_deletion_like_source(deletion_id uuid,subject uuid,worker uuid,generation integer)
RETURNS TABLE(purged_rows integer,has_more boolean) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work;
  source interaction.likes; proof identity.account_deletion_like_receipts; candidate uuid; counterpart uuid; writes integer; original_id uuid;
BEGIN
  SELECT original.id,CASE WHEN original.sender_user_id=subject THEN original.receiver_user_id ELSE original.sender_user_id END
    INTO candidate,counterpart FROM interaction.likes original
    LEFT JOIN interaction.like_reference_anchors anchor ON anchor.id=original.id
    WHERE anchor.id IS NOT NULL AND subject IN (original.sender_user_id,original.receiver_user_id,anchor.sender_user_id,anchor.receiver_user_id)
    ORDER BY original.id LIMIT 1;
  IF counterpart IS NOT NULL THEN
    PERFORM user_id FROM platform.user_counters WHERE user_id IN (subject,counterpart) ORDER BY user_id FOR UPDATE;
    PERFORM interaction.lock_user_pair(LEAST(subject,counterpart),GREATEST(subject,counterpart));
  END IF;
  PERFORM id FROM identity.users WHERE id IN (subject,counterpart) ORDER BY id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id IN (subject,counterpart) ORDER BY user_id FOR UPDATE;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=deletion_id AND user_id=subject FOR UPDATE;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=deletion_id FOR UPDATE;
  proof.id:=gen_random_uuid(); proof.like_id:=candidate; proof.deletion_record_id:=deletion_id;
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
    RAISE EXCEPTION 'Like archival current owning lease missing' USING ERRCODE='40001'; END IF;
  purged_rows:=0;
  SELECT * INTO source FROM interaction.likes WHERE id=candidate FOR UPDATE;
  IF source.id IS NOT NULL THEN
    INSERT INTO identity.account_deletion_like_receipts SELECT proof.*;
    GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'Like receipt missing' USING ERRCODE='23514'; END IF;
    INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,
      metadata_schema_version,metadata,command_id,request_id,occurred_at)
    VALUES(proof.audit_id,'account','account.deletion-like-batch.v1','system','account_deletion',root.id,'like_archived',1,
      jsonb_build_object('kind','like_source','rows',1,'receiptDigest',identity.like_receipt_digest(proof)),root.command_id,root.request_id,proof.archived_at);
    GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'Like audit missing' USING ERRCODE='23514'; END IF;
    INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
    VALUES(proof.event_id,'account_deletion',root.id,'account.deletion-like-batch.v1',1,
      jsonb_build_object('deletionRecordId',root.id,'kind','like_source','rows',1,'auditId',proof.audit_id),proof.archived_at,proof.archived_at,root.request_id,root.command_id);
    GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'Like event missing' USING ERRCODE='23514'; END IF;
    DELETE FROM interaction.likes WHERE id=source.id;
    GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'Like removal missing' USING ERRCODE='23514'; END IF;
    purged_rows:=1;
  ELSE
    FOR original_id IN SELECT anchor.id FROM interaction.like_reference_anchors anchor WHERE subject IN (anchor.sender_user_id,anchor.receiver_user_id)
      UNION SELECT receipt.like_id FROM identity.account_deletion_like_receipts receipt
        JOIN identity.account_deletion_records owning ON owning.id=receipt.deletion_record_id WHERE owning.user_id=subject
    LOOP
      IF interaction.like_source_archivable(original_id) IS NOT TRUE THEN
        RAISE EXCEPTION 'Like archival replay proof incomplete' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  IF job.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Like archival lease expired' USING ERRCODE='40001'; END IF;
  SELECT EXISTS(SELECT 1 FROM interaction.likes original LEFT JOIN interaction.like_reference_anchors anchor ON anchor.id=original.id
    WHERE anchor.id IS NOT NULL AND subject IN (original.sender_user_id,original.receiver_user_id,anchor.sender_user_id,anchor.receiver_user_id)) INTO has_more;
  RETURN NEXT;
END $$;

COMMENT ON TABLE identity.account_deletion_like_receipts IS
  'Minimal immutable original-life Like removal proof; no body, creation timestamp, product access, phase completion, fresh Return or retained release authority.';


-- Move only the unlock FK; live Match source FKs continue to require raw Likes.
ALTER TABLE interaction.feature_unlocks DROP CONSTRAINT feature_unlocks_like_id_fkey;
ALTER TABLE interaction.feature_unlocks ADD CONSTRAINT feature_unlocks_like_id_fkey
  FOREIGN KEY(like_id) REFERENCES interaction.like_reference_anchors(id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION interaction.require_live_like_unlock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.like_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM interaction.likes source
    WHERE source.id=NEW.like_id AND source.receiver_user_id=NEW.payer_user_id) THEN
    RAISE EXCEPTION 'new unlock requires its original live Like source' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feature_unlock_live_like_required BEFORE INSERT ON interaction.feature_unlocks
  FOR EACH ROW EXECUTE FUNCTION interaction.require_live_like_unlock();
