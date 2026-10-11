-- Bounded ordinary-product batches are not phase completion. Their content-free
-- audit/event must commit under the same live phase-3 deletion fence.
CREATE OR REPLACE FUNCTION identity.require_deletion_product_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work;
  resource integer; removed integer; event uuid;
BEGIN
  IF NEW.event_type<>'account.deletion-product-batch.v1' THEN RETURN NULL; END IF;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=NEW.subject_id;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=root.id;
  resource:=(NEW.metadata->>'resource')::integer;
  removed:=(NEW.metadata->>'rows')::integer;
  event:=(NEW.metadata->>'eventId')::uuid;
  IF root.id IS NULL OR job.deletion_record_id IS NULL OR resource IS NULL OR resource NOT BETWEEN 0 AND 8
    OR removed IS NULL OR removed NOT BETWEEN 1 AND 100 OR event IS NULL
    OR root.phase<>'product_data' OR root.checkpoint_version<>3 OR root.checklist_version<>1
    OR root.product_purged_at IS NOT NULL OR root.completed_at IS NOT NULL OR root.reactivation_allowed
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS NULL OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR NEW.category<>'account' OR NEW.actor_type<>'system' OR NEW.actor_user_id IS NOT NULL OR NEW.actor_admin_id IS NOT NULL
    OR NEW.subject_type<>'account_deletion' OR NEW.result_code<>'product_batch_purged' OR NEW.metadata_schema_version<>1
    OR NEW.command_id IS DISTINCT FROM root.command_id OR NEW.request_id IS DISTINCT FROM root.request_id
    OR NEW.occurred_at>=job.lease_expires_at
    OR NEW.metadata IS DISTINCT FROM jsonb_build_object('resource',resource,'rows',removed,'eventId',event,
      'owner',job.lease_owner,'generation',job.lease_generation,'leaseExpiresAt',job.lease_expires_at)
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=root.user_id AND state='deleted' AND version=root.account_version)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts
      WHERE deletion_record_id=root.id AND completed_phase='evidence_capture' AND next_phase='product_data'
        AND from_checkpoint_version=2 AND next_checkpoint_version=3)
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events outbox WHERE outbox.id=event
      AND outbox.aggregate_type='account_deletion' AND outbox.aggregate_id=root.id
      AND outbox.event_type=NEW.event_type AND outbox.schema_version=1
      AND outbox.payload=jsonb_build_object('deletionRecordId',root.id,'resource',resource,'rows',removed,'auditId',NEW.id)
      AND outbox.occurred_at=NEW.occurred_at AND outbox.available_at=NEW.occurred_at
      AND outbox.correlation_id=root.request_id AND outbox.causation_id=root.command_id) THEN
    RAISE EXCEPTION 'deletion product batch chain incomplete' USING ERRCODE='23514';
  END IF;
  IF resource=8 AND (removed NOT BETWEEN 1 AND 2 OR identity.deletion_evidence_blocker(root.id,root.user_id) IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=root.user_id AND product_epoch=root.product_epoch)) THEN
    RAISE EXCEPTION 'Like purge original-life evidence fence missing' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

-- No reference is moved, released or synthesized. Existing source FKs still
-- prohibit removing any Match/unlock source, including immutable archived facts.
CREATE FUNCTION interaction.purge_deletion_unreferenced_likes(
  deletion_id uuid,subject uuid,worker uuid,generation integer
) RETURNS TABLE(purged_rows integer,has_more boolean,waiting_for_references boolean)
LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work;
  counterpart uuid; source_ids uuid[]; removed integer; audit uuid:=gen_random_uuid();
  event uuid:=gen_random_uuid(); at timestamptz; writes integer;
BEGIN
  IF deletion_id IS NULL OR subject IS NULL OR worker IS NULL OR generation IS NULL OR generation<1 THEN
    RAISE EXCEPTION 'Like purge lease invalid' USING ERRCODE='40001';
  END IF;
  -- Locate without locking; pair writers always take counters/pair before Users.
  SELECT CASE WHEN source.sender_user_id=subject THEN source.receiver_user_id ELSE source.sender_user_id END
    INTO counterpart FROM interaction.likes source
    JOIN identity.account_deletion_records original ON original.id=deletion_id AND original.user_id=subject
    WHERE ((source.sender_user_id=subject AND source.sender_product_epoch=original.product_epoch)
        OR (source.receiver_user_id=subject AND source.receiver_product_epoch=original.product_epoch))
      AND source.status<>'active'
      AND NOT EXISTS(SELECT 1 FROM interaction.like_reference_anchors WHERE id=source.id)
      AND NOT EXISTS(SELECT 1 FROM matching.matches WHERE source.id IN (source_like_a_id,source_like_b_id))
      AND NOT EXISTS(SELECT 1 FROM interaction.feature_unlocks WHERE like_id=source.id)
    ORDER BY source.id LIMIT 1;
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
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted'
      AND version=root.account_version AND product_epoch=root.product_epoch)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=root.id
      AND completed_phase='evidence_capture' AND next_phase='product_data' AND from_checkpoint_version=2 AND next_checkpoint_version=3)
    OR identity.deletion_evidence_blocker(root.id,subject) IS NOT NULL THEN
    RAISE EXCEPTION 'Like purge original lease or capture proof missing' USING ERRCODE='40001';
  END IF;
  SELECT array_agg(id ORDER BY id) INTO source_ids FROM (
    SELECT source.id FROM interaction.likes source
    WHERE ((source.sender_user_id=subject AND source.sender_product_epoch=root.product_epoch AND source.receiver_user_id=counterpart)
        OR (source.receiver_user_id=subject AND source.receiver_product_epoch=root.product_epoch AND source.sender_user_id=counterpart))
      AND source.status<>'active'
      AND NOT EXISTS(SELECT 1 FROM interaction.like_reference_anchors WHERE id=source.id)
      AND NOT EXISTS(SELECT 1 FROM matching.matches WHERE source.id IN (source_like_a_id,source_like_b_id))
      AND NOT EXISTS(SELECT 1 FROM interaction.feature_unlocks WHERE like_id=source.id)
    ORDER BY source.id FOR UPDATE
  ) locked;
  purged_rows:=0;
  IF cardinality(source_ids)>0 THEN
    DELETE FROM interaction.likes WHERE id=ANY(source_ids);
    GET DIAGNOSTICS removed=ROW_COUNT;
    IF removed IS DISTINCT FROM cardinality(source_ids) OR removed NOT BETWEEN 1 AND 2 THEN
      RAISE EXCEPTION 'Like purge required source removal incomplete' USING ERRCODE='23514';
    END IF;
    at:=clock_timestamp();
    INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,
      metadata_schema_version,metadata,command_id,request_id,occurred_at)
    VALUES(audit,'account','account.deletion-product-batch.v1','system','account_deletion',root.id,'product_batch_purged',1,
      jsonb_build_object('resource',8,'rows',removed,'eventId',event,'owner',job.lease_owner,
        'generation',job.lease_generation,'leaseExpiresAt',job.lease_expires_at),root.command_id,root.request_id,at);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 OR NOT EXISTS(SELECT 1 FROM platform.audit_logs WHERE id=audit AND event_type='account.deletion-product-batch.v1'
      AND metadata=jsonb_build_object('resource',8,'rows',removed,'eventId',event,'owner',job.lease_owner,
        'generation',job.lease_generation,'leaseExpiresAt',job.lease_expires_at)) THEN
      RAISE EXCEPTION 'Like purge required audit missing' USING ERRCODE='23514';
    END IF;
    INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,
      occurred_at,available_at,correlation_id,causation_id)
    VALUES(event,'account_deletion',root.id,'account.deletion-product-batch.v1',1,
      jsonb_build_object('deletionRecordId',root.id,'resource',8,'rows',removed,'auditId',audit),at,at,root.request_id,root.command_id);
    GET DIAGNOSTICS writes=ROW_COUNT;
    IF writes<>1 OR NOT EXISTS(SELECT 1 FROM platform.outbox_events WHERE id=event AND event_type='account.deletion-product-batch.v1'
      AND payload=jsonb_build_object('deletionRecordId',root.id,'resource',8,'rows',removed,'auditId',audit)) THEN
      RAISE EXCEPTION 'Like purge required event missing' USING ERRCODE='23514';
    END IF;
    purged_rows:=removed;
  END IF;
  IF job.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Like purge lease expired after work' USING ERRCODE='40001';
  END IF;
  SELECT EXISTS(SELECT 1 FROM interaction.likes source WHERE
    (source.sender_user_id=subject AND source.sender_product_epoch=root.product_epoch)
    OR (source.receiver_user_id=subject AND source.receiver_product_epoch=root.product_epoch)) INTO has_more;
  waiting_for_references:=has_more AND NOT EXISTS(SELECT 1 FROM interaction.likes source WHERE
    ((source.sender_user_id=subject AND source.sender_product_epoch=root.product_epoch)
      OR (source.receiver_user_id=subject AND source.receiver_product_epoch=root.product_epoch))
    AND source.status<>'active'
    AND NOT EXISTS(SELECT 1 FROM interaction.like_reference_anchors WHERE id=source.id)
    AND NOT EXISTS(SELECT 1 FROM matching.matches WHERE source.id IN (source_like_a_id,source_like_b_id))
    AND NOT EXISTS(SELECT 1 FROM interaction.feature_unlocks WHERE like_id=source.id));
  RETURN NEXT;
END $$;
