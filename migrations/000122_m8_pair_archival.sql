-- Ordinary Pair removal retains only original identity/lives and audited proof.
CREATE TABLE identity.account_deletion_pair_receipts (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL UNIQUE REFERENCES matching.match_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  batch_transaction xid8 NOT NULL,
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE
);
CREATE INDEX deletion_pair_receipts_root_idx ON identity.account_deletion_pair_receipts(deletion_record_id,id);

CREATE FUNCTION identity.pair_receipt_digest(receipt identity.account_deletion_pair_receipts)
RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('id',receipt.id,'pairId',receipt.match_id,
    'deletionRecordId',receipt.deletion_record_id,'transaction',receipt.batch_transaction::text,
    'owner',receipt.lease_owner,'generation',receipt.lease_generation,
    'leaseExpiresAt',(extract(epoch FROM receipt.lease_expires_at)*1000000)::bigint,
    'archivedAt',(extract(epoch FROM receipt.archived_at)*1000000)::bigint,
    'auditId',receipt.audit_id,'eventId',receipt.event_id,
    'low',anchor.user_low_id,'high',anchor.user_high_id,'lowEpoch',anchor.low_product_epoch,'highEpoch',anchor.high_product_epoch)::text,'UTF8')),'hex')
  FROM matching.match_reference_anchors anchor WHERE anchor.id=receipt.match_id
$$;

-- Authenticate original removal independently of funding checks. Historical
-- authenticity never grants a new transaction authority or product access.
CREATE FUNCTION identity.pair_receipt_proof_valid(receipt identity.account_deletion_pair_receipts)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM matching.match_reference_anchors anchor
    JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE anchor.id=receipt.match_id
      AND ((root.user_id=anchor.user_low_id AND root.product_epoch=anchor.low_product_epoch) OR (root.user_id=anchor.user_high_id AND root.product_epoch=anchor.high_product_epoch))
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND audit.category='account' AND audit.event_type='account.deletion-pair-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.result_code='pair_archived' AND audit.metadata_schema_version=1
      AND audit.metadata=jsonb_build_object('kind','pair_source','rows',1,'receiptDigest',identity.pair_receipt_digest(receipt))
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=receipt.archived_at)
$$;

CREATE FUNCTION identity.pair_receipt_fence(receipt identity.account_deletion_pair_receipts)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT receipt.batch_transaction=pg_current_xact_id() AND EXISTS(
    SELECT 1 FROM identity.account_deletion_records root JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN matching.match_reference_anchors anchor ON anchor.id=receipt.match_id
    WHERE root.id=receipt.deletion_record_id AND root.phase='product_data' AND root.checkpoint_version=3
      AND root.checklist_version=1 AND root.product_purged_at IS NULL AND root.completed_at IS NULL AND NOT root.reactivation_allowed
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<=clock_timestamp()
      AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
      AND ((root.user_id=anchor.user_low_id AND root.product_epoch=anchor.low_product_epoch) OR (root.user_id=anchor.user_high_id AND root.product_epoch=anchor.high_product_epoch))
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND identity.deletion_evidence_blocker(root.id,root.user_id) IS NULL)
$$;


CREATE FUNCTION interaction.pair_source_archivable(subject uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT matching.original_match_closure_valid(subject) AND EXISTS(
    SELECT 1 FROM matching.match_reference_anchors anchor WHERE anchor.id=subject
      AND NOT EXISTS(SELECT 1 FROM interaction.likes source
        WHERE ((source.sender_user_id=anchor.user_low_id AND source.receiver_user_id=anchor.user_high_id
            AND source.sender_product_epoch=anchor.low_product_epoch AND source.receiver_product_epoch=anchor.high_product_epoch)
          OR (source.sender_user_id=anchor.user_high_id AND source.receiver_user_id=anchor.user_low_id
            AND source.sender_product_epoch=anchor.high_product_epoch AND source.receiver_product_epoch=anchor.low_product_epoch)))
      AND NOT EXISTS(SELECT 1 FROM matching.unmatch_records record WHERE record.match_id=anchor.id
        AND record.report_window_expires_at>clock_timestamp()))
$$;
CREATE FUNCTION interaction.require_pair_archival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Active administrator blocks are retained safety facts. Their existing
  -- permission-checked removal path is independent of account deletion.
  IF OLD.state='blocked' THEN RETURN OLD; END IF;
  IF OLD.state='unmatched' AND EXISTS(
    SELECT 1 FROM identity.account_deletion_pair_receipts receipt
    JOIN matching.match_reference_anchors anchor ON anchor.id=receipt.match_id
    JOIN identity.account_deletion_match_receipts closure ON closure.match_id=anchor.id
    WHERE anchor.user_low_id=OLD.user_low_id AND anchor.user_high_id=OLD.user_high_id
      AND closure.closed_at=OLD.changed_at AND identity.pair_receipt_fence(receipt)
      AND identity.pair_receipt_proof_valid(receipt) AND interaction.pair_source_archivable(anchor.id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'ordinary pair removal lacks exact current archival' USING ERRCODE='55000';
END $$;
CREATE TRIGGER pair_archival_delete_guard BEFORE DELETE ON interaction.user_pair_states
  FOR EACH ROW EXECUTE FUNCTION interaction.require_pair_archival();
CREATE FUNCTION identity.guard_pair_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'pair receipt requires controlled release' USING ERRCODE='55000'; END IF;
  IF NOT identity.pair_receipt_fence(NEW) OR NOT interaction.pair_source_archivable(NEW.match_id)
    OR NOT EXISTS(SELECT 1 FROM matching.match_reference_anchors anchor
      JOIN interaction.user_pair_states source ON source.user_low_id=anchor.user_low_id AND source.user_high_id=anchor.user_high_id
      JOIN identity.account_deletion_match_receipts closure ON closure.match_id=anchor.id
      WHERE anchor.id=NEW.match_id AND source.state='unmatched' AND source.changed_at=closure.closed_at) THEN
    RAISE EXCEPTION 'pair receipt lacks exact closed source' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pair_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_pair_receipts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_pair_archival_receipt();
CREATE FUNCTION identity.require_pair_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT identity.pair_receipt_fence(NEW) OR NOT identity.pair_receipt_proof_valid(NEW)
    OR NOT interaction.pair_source_archivable(NEW.match_id)
    OR EXISTS(SELECT 1 FROM interaction.user_pair_states source JOIN matching.match_reference_anchors anchor
      ON source.user_low_id=anchor.user_low_id AND source.user_high_id=anchor.user_high_id WHERE anchor.id=NEW.match_id)
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event JOIN identity.account_deletion_records root ON root.id=NEW.deletion_record_id
      WHERE event.id=NEW.event_id AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
        AND event.event_type='account.deletion-pair-batch.v1' AND event.schema_version=1
        AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','pair_source','rows',1,'auditId',NEW.audit_id)
        AND event.correlation_id=root.request_id AND event.causation_id=root.command_id
        AND event.occurred_at=NEW.archived_at AND event.available_at=NEW.archived_at) THEN
    RAISE EXCEPTION 'pair removal, lease or mandatory proof incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pair_archival_receipt_required AFTER INSERT ON identity.account_deletion_pair_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_pair_archival_receipt();

CREATE FUNCTION interaction.purge_deletion_pair_source(deletion_id uuid,subject uuid,worker uuid,generation integer)
RETURNS TABLE(purged_rows integer,has_more boolean,waiting_for_sources boolean) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work;
  proof identity.account_deletion_pair_receipts; source interaction.user_pair_states;
  candidate matching.match_reference_anchors; other uuid; writes integer; original_id uuid;
BEGIN
  SELECT anchor.* INTO candidate FROM interaction.user_pair_states pair
    JOIN matching.match_reference_anchors anchor ON anchor.user_low_id=pair.user_low_id AND anchor.user_high_id=pair.user_high_id
    JOIN identity.accounts low_account ON low_account.user_id=anchor.user_low_id AND low_account.product_epoch=anchor.low_product_epoch
    JOIN identity.accounts high_account ON high_account.user_id=anchor.user_high_id AND high_account.product_epoch=anchor.high_product_epoch
    JOIN identity.account_deletion_records owning ON owning.id=deletion_id AND owning.user_id=subject
    WHERE pair.state<>'blocked' AND ((anchor.user_low_id=subject AND anchor.low_product_epoch=owning.product_epoch)
      OR (anchor.user_high_id=subject AND anchor.high_product_epoch=owning.product_epoch)) ORDER BY anchor.id LIMIT 1;
  other:=CASE WHEN candidate.user_low_id=subject THEN candidate.user_high_id ELSE candidate.user_low_id END;
  IF other IS NOT NULL THEN
    PERFORM user_id FROM platform.user_counters WHERE user_id IN(subject,other) ORDER BY user_id FOR UPDATE;
    PERFORM interaction.lock_user_pair(LEAST(subject,other),GREATEST(subject,other));
  END IF;
  PERFORM id FROM identity.users WHERE id IN(subject,other) ORDER BY id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id IN(subject,other) ORDER BY user_id FOR UPDATE;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=deletion_id AND user_id=subject FOR UPDATE;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=deletion_id FOR UPDATE;
  proof.id:=gen_random_uuid(); proof.match_id:=candidate.id; proof.deletion_record_id:=deletion_id;
  proof.batch_transaction:=pg_current_xact_id(); proof.lease_owner:=worker; proof.lease_generation:=generation;
  proof.lease_expires_at:=job.lease_expires_at; proof.archived_at:=clock_timestamp(); proof.audit_id:=gen_random_uuid(); proof.event_id:=gen_random_uuid();
  IF root.id IS NULL OR job.deletion_record_id IS NULL OR root.phase<>'product_data' OR root.checkpoint_version<>3
    OR root.checklist_version<>1 OR root.product_purged_at IS NOT NULL OR root.completed_at IS NOT NULL OR root.reactivation_allowed
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS DISTINCT FROM worker OR job.lease_generation IS DISTINCT FROM generation
    OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted' AND version=root.account_version AND product_epoch=root.product_epoch)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=root.id
      AND completed_phase='evidence_capture' AND next_phase='product_data' AND from_checkpoint_version=2 AND next_checkpoint_version=3)
    OR identity.deletion_evidence_blocker(root.id,subject) IS NOT NULL THEN
    RAISE EXCEPTION 'pair archival current lease missing' USING ERRCODE='40001'; END IF;
  purged_rows:=0; waiting_for_sources:=false;
  SELECT * INTO source FROM interaction.user_pair_states WHERE user_low_id=candidate.user_low_id AND user_high_id=candidate.user_high_id FOR UPDATE;
  IF source.user_low_id IS NOT NULL AND source.state<>'blocked' THEN
    IF source.state<>'unmatched' OR interaction.pair_source_archivable(candidate.id) IS NOT TRUE THEN waiting_for_sources:=true;
    ELSE
      INSERT INTO identity.account_deletion_pair_receipts SELECT proof.*;
      GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'pair receipt missing' USING ERRCODE='23514'; END IF;
      INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
      VALUES(proof.audit_id,'account','account.deletion-pair-batch.v1','system','account_deletion',root.id,'pair_archived',1,
        jsonb_build_object('kind','pair_source','rows',1,'receiptDigest',identity.pair_receipt_digest(proof)),root.command_id,root.request_id,proof.archived_at);
      GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'pair audit missing' USING ERRCODE='23514'; END IF;
      INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
      VALUES(proof.event_id,'account_deletion',root.id,'account.deletion-pair-batch.v1',1,
        jsonb_build_object('deletionRecordId',root.id,'kind','pair_source','rows',1,'auditId',proof.audit_id),proof.archived_at,proof.archived_at,root.request_id,root.command_id);
      GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'pair event missing' USING ERRCODE='23514'; END IF;
      DELETE FROM interaction.user_pair_states WHERE user_low_id=source.user_low_id AND user_high_id=source.user_high_id;
      GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'pair removal missing' USING ERRCODE='23514'; END IF;
      purged_rows:=1;
    END IF;
  END IF;
  -- Retained Match and receipt witnesses make missing source proof a denial.
  FOR original_id IN SELECT anchor.id FROM matching.match_reference_anchors anchor
    WHERE subject IN(anchor.user_low_id,anchor.user_high_id)
      AND NOT EXISTS(SELECT 1 FROM interaction.user_pair_states pair
        WHERE pair.user_low_id=anchor.user_low_id AND pair.user_high_id=anchor.user_high_id)
    UNION SELECT receipt.match_id FROM identity.account_deletion_pair_receipts receipt
      JOIN identity.account_deletion_records owning ON owning.id=receipt.deletion_record_id
      WHERE owning.user_id=subject
    UNION SELECT closure.match_id FROM identity.account_deletion_match_receipts closure
      JOIN identity.account_deletion_records owning ON owning.id=closure.deletion_record_id
      WHERE owning.user_id=subject AND NOT EXISTS(SELECT 1 FROM interaction.user_pair_states pair
        JOIN matching.match_reference_anchors anchor ON anchor.user_low_id=pair.user_low_id AND anchor.user_high_id=pair.user_high_id
        WHERE anchor.id=closure.match_id)
  LOOP
    IF NOT EXISTS(SELECT 1 FROM identity.account_deletion_pair_receipts receipt WHERE receipt.match_id=original_id
      AND identity.pair_receipt_proof_valid(receipt)) OR interaction.pair_source_archivable(original_id) IS NOT TRUE THEN
      RAISE EXCEPTION 'pair replay proof incomplete' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF job.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'pair archival lease expired' USING ERRCODE='40001'; END IF;
  SELECT EXISTS(SELECT 1 FROM interaction.user_pair_states pair WHERE subject IN(pair.user_low_id,pair.user_high_id)
    AND pair.state<>'blocked') INTO has_more;
  IF has_more AND candidate.id IS NULL THEN
    RAISE EXCEPTION 'ordinary pair lost its original Match life' USING ERRCODE='23514'; END IF;
  RETURN NEXT;
END $$;
CREATE OR REPLACE FUNCTION matching.verify_unmatch_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_match_id uuid; checked_ids uuid[];
BEGIN
  IF (TG_TABLE_SCHEMA = 'matching' AND TG_TABLE_NAME = 'unmatch_records') OR (TG_TABLE_SCHEMA='identity' AND TG_TABLE_NAME='account_deletion_match_receipts') THEN
    checked_match_id := NEW.match_id;
  ELSIF TG_TABLE_SCHEMA = 'matching' AND TG_TABLE_NAME = 'matches' THEN
    checked_match_id := NEW.id;
  ELSIF TG_TABLE_SCHEMA = 'chat' AND TG_TABLE_NAME = 'chat_sessions' THEN
    checked_match_id := NEW.match_id;
  ELSE
    SELECT array_agg(id ORDER BY id) INTO checked_ids FROM matching.match_reference_anchors
    WHERE user_low_id=NEW.user_low_id AND user_high_id=NEW.user_high_id;
  END IF;

  IF checked_ids IS NULL THEN checked_ids:=ARRAY[checked_match_id]; END IF;
  FOREACH checked_match_id IN ARRAY checked_ids LOOP
  IF EXISTS (SELECT 1 FROM matching.unmatch_records WHERE match_id = checked_match_id)
    OR EXISTS (SELECT 1 FROM matching.matches WHERE id = checked_match_id AND status = 'unmatched')
  THEN
    IF NOT EXISTS (
      SELECT 1
      FROM matching.unmatch_records record
      JOIN matching.match_lifecycle_facts match ON match.id = record.match_id
      JOIN LATERAL (
        SELECT live.state,live.changed_at FROM interaction.user_pair_states live
          WHERE live.user_low_id=match.user_low_id AND live.user_high_id=match.user_high_id
        UNION ALL
        SELECT 'unmatched',closure.closed_at FROM identity.account_deletion_pair_receipts proof
          JOIN identity.account_deletion_match_receipts closure ON closure.match_id=proof.match_id
          WHERE proof.match_id=match.id AND identity.pair_receipt_proof_valid(proof)
            AND matching.original_match_closure_valid(match.id)
      ) pair ON true
      JOIN LATERAL (
        SELECT live.status,live.closed_reason,live.closed_at FROM chat.chat_sessions live WHERE live.match_id=match.id
        UNION ALL
        SELECT 'closed',receipt.closed_reason,receipt.closed_at FROM chat.chat_reference_anchors anchor
          JOIN identity.account_deletion_chat_receipts receipt ON receipt.chat_session_id=anchor.id AND receipt.final_batch
          WHERE anchor.match_id=match.id AND NOT EXISTS (SELECT 1 FROM chat.chat_sessions WHERE id=anchor.id)
      ) session ON true
      WHERE record.match_id = checked_match_id
        AND record.actor_user_id IN (match.user_low_id, match.user_high_id)
        AND match.status = 'unmatched' AND match.closed_at = record.unmatched_at
        AND pair.state = 'unmatched' AND pair.changed_at = record.unmatched_at
        AND session.status = 'closed' AND session.closed_reason = 'unmatch'
        AND session.closed_at = record.unmatched_at
        AND NOT EXISTS (
          SELECT 1 FROM interaction.likes like_row
          WHERE ((like_row.sender_user_id = match.user_low_id AND like_row.receiver_user_id = match.user_high_id)
            OR (like_row.sender_user_id = match.user_high_id AND like_row.receiver_user_id = match.user_low_id))
            AND like_row.status IN ('active','closed_by_match')
            AND EXISTS(SELECT 1 FROM matching.match_reference_anchors original WHERE original.id=match.id
              AND ((like_row.sender_product_epoch=original.low_product_epoch AND like_row.receiver_product_epoch=original.high_product_epoch
                  AND like_row.sender_user_id=original.user_low_id)
                OR (like_row.sender_product_epoch=original.high_product_epoch AND like_row.receiver_product_epoch=original.low_product_epoch
                  AND like_row.sender_user_id=original.user_high_id)))
        )
    ) THEN
      RAISE EXCEPTION 'unmatch lifecycle is inconsistent' USING ERRCODE = '23514';
    END IF;
  END IF;
  END LOOP;
  RETURN NULL;
END $$;
