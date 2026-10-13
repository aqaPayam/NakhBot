-- Only verified media_objects/4 -> ephemeral_access/5. Completion and Return remain disabled.
CREATE FUNCTION identity.deletion_media_blocker(root_id uuid,subject uuid) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE epoch integer;
BEGIN
 IF identity.deletion_product_blocker(root_id,subject) IS NOT NULL THEN RETURN 'product'; END IF;
 SELECT product_epoch INTO epoch FROM identity.account_deletion_records WHERE id=root_id AND user_id=subject;
 IF epoch IS NULL THEN RETURN 'product'; END IF;
 IF EXISTS(SELECT 1 FROM media.media_assets WHERE owner_user_id=subject)
  OR EXISTS(SELECT 1 FROM media.photo_variants variant JOIN media.asset_reference_anchors asset ON asset.id=variant.asset_id WHERE asset.owner_user_id=subject)
  THEN RETURN 'sources'; END IF;
 IF EXISTS(SELECT 1 FROM media.asset_reference_anchors asset WHERE asset.owner_user_id=subject AND asset.product_epoch=epoch
   AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_media_receipts receipt WHERE receipt.asset_id=asset.id AND identity.deletion_media_receipt_valid(receipt)))
  OR EXISTS(SELECT 1 FROM identity.account_deletion_media_operations operation WHERE operation.deletion_record_id=root_id
    AND identity.deletion_media_operation_valid(operation) IS NOT TRUE)
  OR EXISTS(SELECT 1 FROM identity.account_deletion_media_receipts receipt JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    WHERE root.user_id=subject AND identity.deletion_media_receipt_valid(receipt) IS NOT TRUE) THEN RETURN 'provider_proof'; END IF;
 RETURN NULL;
END $$;
ALTER TABLE identity.account_deletion_phase_receipts DROP CONSTRAINT deletion_phase_receipt_transition_check,
 ADD CONSTRAINT deletion_phase_receipt_transition_check CHECK(
  (completed_phase='shared_closure' AND from_checkpoint_version=1 AND next_phase='evidence_capture' AND next_checkpoint_version=2)
  OR (completed_phase='evidence_capture' AND from_checkpoint_version=2 AND next_phase='product_data' AND next_checkpoint_version=3)
  OR (completed_phase='product_data' AND from_checkpoint_version=3 AND next_phase='media_objects' AND next_checkpoint_version=4)
  OR (completed_phase='media_objects' AND from_checkpoint_version=4 AND next_phase='ephemeral_access' AND next_checkpoint_version=5));

CREATE OR REPLACE FUNCTION identity.guard_deletion_phase_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'deletion phase receipt requires controlled release' USING ERRCODE='55000';
  END IF;
  IF NEW.completed_phase='media_objects' AND identity.deletion_media_blocker(NEW.deletion_record_id,(SELECT user_id FROM identity.account_deletion_records WHERE id=NEW.deletion_record_id)) IS NOT NULL THEN RAISE EXCEPTION 'media verification incomplete' USING ERRCODE='23514'; END IF;
  IF NEW.completed_phase='product_data' AND identity.deletion_product_blocker(NEW.deletion_record_id,(SELECT user_id FROM identity.account_deletion_records WHERE id=NEW.deletion_record_id)) IS NOT NULL THEN RAISE EXCEPTION 'product verification incomplete' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.account_deletion_records record
    JOIN identity.account_deletion_work work ON work.deletion_record_id=record.id
    JOIN identity.accounts account ON account.user_id=record.user_id
    WHERE record.id=NEW.deletion_record_id AND record.phase=NEW.completed_phase
      AND record.checkpoint_version=NEW.from_checkpoint_version AND record.checklist_version=NEW.checklist_version
      AND work.phase=record.phase AND work.checkpoint_version=record.checkpoint_version
      AND work.lease_owner=NEW.lease_owner AND work.lease_generation=NEW.lease_generation
      AND work.lease_expires_at=NEW.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND account.state='deleted' AND account.version=record.account_version
      AND EXISTS (SELECT 1 FROM platform.user_counters WHERE user_id=record.user_id AND pending_nakh_count=0)
      AND NEW.verified_at>=record.requested_at AND NEW.verified_at<=clock_timestamp()
      AND NOT identity.deletion_has_open_shared_scopes(record.user_id)
      AND (NEW.completed_phase='shared_closure' OR (record.shared_closed_at IS NOT NULL
        AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior
          WHERE prior.deletion_record_id=record.id AND prior.completed_phase='shared_closure'
            AND prior.verified_at=record.shared_closed_at)
        AND identity.deletion_evidence_blocker(record.id,record.user_id) IS NULL))) THEN
    RAISE EXCEPTION 'deletion phase receipt lacks verified fence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION identity.require_deletion_phase_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.account_deletion_records record
    JOIN identity.account_deletion_work work ON work.deletion_record_id=record.id
    JOIN identity.accounts account ON account.user_id=record.user_id
    JOIN platform.audit_logs audit ON audit.id=NEW.audit_id
    JOIN platform.outbox_events event ON event.id=NEW.event_id
    WHERE record.id=NEW.deletion_record_id AND record.phase=NEW.next_phase
      AND record.checkpoint_version=NEW.next_checkpoint_version
      AND ((NEW.completed_phase='shared_closure' AND record.shared_closed_at=NEW.verified_at)
        OR (NEW.completed_phase='evidence_capture' AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior
          WHERE prior.deletion_record_id=record.id AND prior.completed_phase='shared_closure' AND prior.verified_at=record.shared_closed_at)
          AND identity.deletion_evidence_blocker(record.id,record.user_id) IS NULL)
        OR (NEW.completed_phase='media_objects' AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=record.id AND prior.completed_phase='product_data'))
        OR (NEW.completed_phase='product_data' AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=record.id AND prior.completed_phase='evidence_capture')))
      AND (NEW.completed_phase<>'media_objects' OR identity.deletion_media_blocker(record.id,record.user_id) IS NULL)
      AND (NEW.completed_phase<>'product_data' OR identity.deletion_product_blocker(record.id,record.user_id) IS NULL)
      AND record.product_purged_at IS NULL
      AND record.checklist_version=NEW.checklist_version AND record.purge_started_at IS NOT NULL
      AND record.last_error_code IS NULL AND NOT record.reactivation_allowed AND record.completed_at IS NULL
      AND work.phase=record.phase AND work.checkpoint_version=record.checkpoint_version
      AND work.lease_generation=NEW.lease_generation AND work.lease_owner IS NULL AND work.lease_expires_at IS NULL
      AND work.available_at=NEW.verified_at AND work.last_error_code IS NULL
      AND account.state='deleted' AND account.version=record.account_version
      AND EXISTS (SELECT 1 FROM platform.user_counters WHERE user_id=record.user_id AND pending_nakh_count=0)
      AND clock_timestamp()<NEW.lease_expires_at AND NOT identity.deletion_has_open_shared_scopes(record.user_id)
      AND audit.category='account' AND audit.event_type='account.deletion-phase-completed.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=record.id AND audit.result_code='phase_completed'
      AND audit.metadata_schema_version=1 AND audit.metadata=jsonb_build_object('phase',NEW.completed_phase,'checkpointVersion',NEW.from_checkpoint_version)
      AND audit.command_id=record.command_id AND audit.request_id=record.request_id AND audit.occurred_at=NEW.verified_at
      AND event.aggregate_type='account_deletion' AND event.aggregate_id=record.id
      AND event.event_type='account.deletion-phase-completed.v1' AND event.schema_version=1
      AND event.payload=jsonb_build_object('deletionRecordId',record.id,'completedPhase',NEW.completed_phase,'nextPhase',NEW.next_phase,'checkpointVersion',NEW.next_checkpoint_version)
      AND event.correlation_id=record.request_id AND event.causation_id=record.command_id AND event.occurred_at=NEW.verified_at) THEN
    RAISE EXCEPTION 'deletion phase completion chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION identity.guard_deletion_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'deletion history requires controlled release' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.id,NEW.user_id,NEW.confirmation_id,NEW.account_version,NEW.history_id,NEW.audit_id,
      NEW.event_id,NEW.command_id,NEW.request_id,NEW.checklist_version,NEW.requested_at,NEW.safety_bar)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.confirmation_id,OLD.account_version,OLD.history_id,OLD.audit_id,
      OLD.event_id,OLD.command_id,OLD.request_id,OLD.checklist_version,OLD.requested_at,OLD.safety_bar)
    OR OLD.phase='completed' OR NEW.reactivation_allowed
    OR NEW.product_purged_at IS DISTINCT FROM OLD.product_purged_at
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR (OLD.purge_started_at IS NOT NULL AND NEW.purge_started_at IS DISTINCT FROM OLD.purge_started_at)
    OR (NEW.purge_started_at IS NOT NULL AND (NEW.purge_started_at<NEW.requested_at OR NEW.purge_started_at>clock_timestamp())) THEN
    RAISE EXCEPTION 'deletion checkpoint transition invalid' USING ERRCODE='55000';
  END IF;
  IF NEW.phase=OLD.phase THEN
    IF NEW.checkpoint_version<>OLD.checkpoint_version OR NEW.shared_closed_at IS DISTINCT FROM OLD.shared_closed_at THEN
      RAISE EXCEPTION 'deletion checkpoint milestone requires receipt' USING ERRCODE='55000';
    END IF;
  ELSIF NOT ((OLD.phase='shared_closure' AND NEW.phase='evidence_capture'
      AND OLD.checkpoint_version=1 AND NEW.checkpoint_version=2)
      OR (OLD.phase='evidence_capture' AND NEW.phase='product_data'
        AND OLD.checkpoint_version=2 AND NEW.checkpoint_version=3)
      OR (OLD.phase='product_data' AND NEW.phase='media_objects' AND OLD.checkpoint_version=3 AND NEW.checkpoint_version=4)
      OR (OLD.phase='media_objects' AND NEW.phase='ephemeral_access' AND OLD.checkpoint_version=4 AND NEW.checkpoint_version=5))
    OR NOT EXISTS (SELECT 1 FROM identity.account_deletion_phase_receipts receipt
      WHERE receipt.deletion_record_id=NEW.id AND receipt.completed_phase=OLD.phase
        AND receipt.next_phase=NEW.phase AND receipt.from_checkpoint_version=OLD.checkpoint_version
        AND receipt.next_checkpoint_version=NEW.checkpoint_version
        AND ((OLD.phase='shared_closure' AND NEW.shared_closed_at=receipt.verified_at)
          OR (OLD.phase IN('evidence_capture','product_data','media_objects') AND NEW.shared_closed_at IS NOT DISTINCT FROM OLD.shared_closed_at))) THEN
    RAISE EXCEPTION 'deletion checkpoint requires verified executor' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION identity.guard_deletion_work_lease() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.phase<>'shared_closure' OR NEW.checkpoint_version<>1 OR NEW.lease_generation<>0
      OR NEW.attempt_count<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'deletion work admission invalid' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.deletion_record_id<>OLD.deletion_record_id OR OLD.phase='completed' THEN
    RAISE EXCEPTION 'deletion work identity invalid' USING ERRCODE='55000';
  END IF;
  IF NEW.phase<>OLD.phase OR NEW.checkpoint_version<>OLD.checkpoint_version THEN
    IF NOT ((OLD.phase='shared_closure' AND NEW.phase='evidence_capture' AND OLD.checkpoint_version=1 AND NEW.checkpoint_version=2)
      OR (OLD.phase='evidence_capture' AND NEW.phase='product_data' AND OLD.checkpoint_version=2 AND NEW.checkpoint_version=3)
      OR (OLD.phase='product_data' AND NEW.phase='media_objects' AND OLD.checkpoint_version=3 AND NEW.checkpoint_version=4)
      OR (OLD.phase='media_objects' AND NEW.phase='ephemeral_access' AND OLD.checkpoint_version=4 AND NEW.checkpoint_version=5))
      OR NEW.lease_generation<>OLD.lease_generation OR NEW.attempt_count<>OLD.attempt_count
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.last_error_code IS NOT NULL
      OR OLD.lease_owner IS NULL OR OLD.lease_expires_at<=at
      OR NOT EXISTS (SELECT 1 FROM identity.account_deletion_phase_receipts receipt
        WHERE receipt.deletion_record_id=OLD.deletion_record_id AND receipt.completed_phase=OLD.phase
          AND receipt.from_checkpoint_version=OLD.checkpoint_version AND receipt.next_phase=NEW.phase
          AND receipt.next_checkpoint_version=NEW.checkpoint_version AND receipt.lease_owner=OLD.lease_owner
          AND receipt.lease_generation=OLD.lease_generation AND receipt.lease_expires_at=OLD.lease_expires_at
          AND receipt.verified_at=NEW.available_at) THEN
      RAISE EXCEPTION 'deletion work phase requires verified executor' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.lease_generation<>OLD.lease_generation THEN
    IF NEW.lease_generation<>OLD.lease_generation+1 OR NEW.attempt_count<>OLD.attempt_count+1
      OR (OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>at)
      OR NEW.lease_owner IS NULL OR NEW.lease_expires_at<=at OR NEW.lease_expires_at>at+interval '120 seconds'
      OR NEW.available_at IS DISTINCT FROM OLD.available_at OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code THEN
      RAISE EXCEPTION 'deletion work acquisition invalid' USING ERRCODE='55000';
    END IF;
  ELSE
    IF NEW.attempt_count<>OLD.attempt_count
      OR (NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS DISTINCT FROM OLD.lease_owner)
      OR (NEW.lease_owner IS NOT NULL AND (OLD.lease_expires_at<=at OR NEW.lease_expires_at<OLD.lease_expires_at
        OR NEW.lease_expires_at<=at OR NEW.lease_expires_at>at+interval '120 seconds'
        OR NEW.available_at IS DISTINCT FROM OLD.available_at OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code)) THEN
      RAISE EXCEPTION 'deletion work lease mutation invalid' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION identity.finish_deletion_media_phase(deletion_id uuid, subject uuid, worker uuid, generation integer, checkpoint integer)
RETURNS TABLE(phase text, checkpoint_version integer, replayed boolean, waiting_for text) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work;
  receipt identity.account_deletion_phase_receipts; at timestamptz; audit uuid; event uuid; blocker text; writes integer;
BEGIN
  IF deletion_id IS NULL OR subject IS NULL OR worker IS NULL OR generation IS NULL OR generation<1 OR checkpoint IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
  END IF;
  PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=deletion_id AND user_id=subject FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001'; END IF;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=deletion_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted' AND version=root.account_version) THEN
    RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
  END IF;
  SELECT * INTO receipt FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=deletion_id AND completed_phase='media_objects';
  IF FOUND THEN
    IF receipt.lease_owner<>worker OR receipt.lease_generation<>generation OR receipt.from_checkpoint_version<>checkpoint THEN
      RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
    END IF;
    RETURN QUERY SELECT receipt.next_phase,receipt.next_checkpoint_version,true,NULL::text; RETURN;
  END IF;
  at:=clock_timestamp();
  IF root.phase<>'media_objects' OR root.checkpoint_version<>4 OR checkpoint<>4
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS DISTINCT FROM worker OR job.lease_generation<>generation OR job.lease_expires_at IS NULL OR job.lease_expires_at<=at
    OR NOT EXISTS (SELECT 1 FROM platform.user_counters WHERE user_id=subject AND pending_nakh_count=0)
    OR identity.deletion_has_open_shared_scopes(subject) THEN
    RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
  END IF;
  blocker:=identity.deletion_media_blocker(deletion_id,subject);
  IF blocker IS NOT NULL THEN RETURN QUERY SELECT 'media_objects'::text,4,false,blocker; RETURN; END IF;
  audit:=gen_random_uuid(); event:=gen_random_uuid();
  INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,
    metadata_schema_version,metadata,command_id,request_id,occurred_at)
  VALUES(audit,'account','account.deletion-phase-completed.v1','system',NULL,NULL,'account_deletion',deletion_id,'phase_completed',1,
    jsonb_build_object('phase','media_objects','checkpointVersion',4),root.command_id,root.request_id,at);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'media checkpoint audit missing' USING ERRCODE='23514'; END IF;
  INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
  VALUES(event,'account_deletion',deletion_id,'account.deletion-phase-completed.v1',1,
    jsonb_build_object('deletionRecordId',deletion_id,'completedPhase','media_objects','nextPhase','ephemeral_access','checkpointVersion',5),at,at,root.request_id,root.command_id);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'media checkpoint event missing' USING ERRCODE='23514'; END IF;
  INSERT INTO identity.account_deletion_phase_receipts(deletion_record_id,completed_phase,from_checkpoint_version,next_phase,next_checkpoint_version,
    checklist_version,lease_owner,lease_generation,lease_expires_at,verified_at,audit_id,event_id)
  VALUES(deletion_id,'media_objects',4,'ephemeral_access',5,root.checklist_version,worker,generation,job.lease_expires_at,at,audit,event);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'media checkpoint receipt missing' USING ERRCODE='23514'; END IF;
  UPDATE identity.account_deletion_records SET phase='ephemeral_access',checkpoint_version=5,last_error_code=NULL WHERE id=deletion_id;
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'media checkpoint root update missing' USING ERRCODE='23514'; END IF;
  UPDATE identity.account_deletion_work SET phase='ephemeral_access',checkpoint_version=5,available_at=at,
    lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE deletion_record_id=deletion_id;
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'media checkpoint work update missing' USING ERRCODE='23514'; END IF;
  RETURN QUERY SELECT 'ephemeral_access'::text,5,false,NULL::text;
END $$;
