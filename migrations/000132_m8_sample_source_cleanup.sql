-- Keep only original synthetic-source ownership and a one-way name fingerprint.
-- Walking-skeleton actors without Accounts remain explicitly unresolved.
CREATE TABLE platform.sample_reference_anchors (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  product_epoch integer CHECK(product_epoch>=0),
  name_digest text NOT NULL CHECK(name_digest~'^[0-9a-f]{64}$')
);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM platform.sample_effects source JOIN identity.accounts account
    ON account.user_id=source.actor_user_id WHERE account.product_epoch<>0) THEN
    RAISE EXCEPTION 'legacy sample ownership is ambiguous';
  END IF;
END $$;
INSERT INTO platform.sample_reference_anchors(id,actor_user_id,product_epoch,name_digest)
 SELECT source.id,source.actor_user_id,CASE WHEN account.user_id IS NOT NULL THEN 0 END,
   encode(sha256(convert_to(source.name,'UTF8')),'hex')
 FROM platform.sample_effects source LEFT JOIN identity.accounts account ON account.user_id=source.actor_user_id;
CREATE INDEX sample_reference_owner_idx ON platform.sample_reference_anchors(actor_user_id,product_epoch,id);
CREATE TABLE identity.account_deletion_sample_receipts (
  source_id uuid PRIMARY KEY REFERENCES platform.sample_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  audit_id uuid NOT NULL REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL REFERENCES platform.outbox_events(id) ON DELETE RESTRICT,
  proof_hash text NOT NULL CHECK(proof_hash~'^[0-9a-f]{64}$')
);
CREATE FUNCTION platform.sample_purge_digest(audit_id uuid,event_id uuid) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT encode(sha256(convert_to(jsonb_build_object(
  'audit',(to_jsonb(audit)-'occurred_at')||jsonb_build_object('occurredAtEpoch',extract(epoch FROM audit.occurred_at)),
  'event',jsonb_build_object('id',event.id,'aggregateType',event.aggregate_type,'aggregateId',event.aggregate_id,
    'eventType',event.event_type,'schemaVersion',event.schema_version,'payload',event.payload,
    'occurredAtEpoch',extract(epoch FROM event.occurred_at),
    'correlationId',event.correlation_id,'causationId',event.causation_id))::text,'UTF8')),'hex')
  FROM platform.audit_logs audit JOIN platform.outbox_events event ON event.id=event_id WHERE audit.id=audit_id
$$;
CREATE FUNCTION platform.guard_sample_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM platform.sample_effects source
    WHERE source.id=NEW.id AND source.actor_user_id=NEW.actor_user_id
      AND encode(sha256(convert_to(source.name,'UTF8')),'hex')=NEW.name_digest) THEN
    RAISE EXCEPTION 'original sample reference requires its source and controlled release' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sample_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON platform.sample_reference_anchors
 FOR EACH ROW EXECUTE FUNCTION platform.guard_sample_reference();
CREATE FUNCTION platform.guard_sample_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid; epoch integer; state text; original platform.sample_reference_anchors;
BEGIN
  IF TG_TABLE_NAME='sample_effects' THEN
    subject:=NEW.actor_user_id;
    IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.actor_user_id,NEW.name,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.actor_user_id,OLD.name,OLD.created_at) THEN
      RAISE EXCEPTION 'sample birth is immutable' USING ERRCODE='23514'; END IF;
  ELSE
    IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.source_event_id,NEW.effect_id,NEW.projected_name,NEW.projected_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.source_event_id,OLD.effect_id,OLD.projected_name,OLD.projected_at) THEN
      RAISE EXCEPTION 'sample projection birth is immutable' USING ERRCODE='23514'; END IF;
    SELECT * INTO original FROM platform.sample_reference_anchors WHERE id=NEW.effect_id;
    IF original.id IS NULL OR NOT EXISTS(SELECT 1 FROM platform.sample_effects source
      WHERE source.id=original.id AND source.actor_user_id=original.actor_user_id
        AND source.name=NEW.projected_name
        AND encode(sha256(convert_to(source.name,'UTF8')),'hex')=original.name_digest) THEN
      RAISE EXCEPTION 'sample projection requires original source' USING ERRCODE='23514'; END IF;
    subject:=original.actor_user_id;
  END IF;
  PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
  SELECT account.product_epoch,account.state INTO epoch,state FROM identity.accounts account WHERE account.user_id=subject FOR UPDATE;
  IF state='deleted' OR (TG_TABLE_NAME='sample_projections' AND epoch IS DISTINCT FROM original.product_epoch) THEN
    RAISE EXCEPTION 'sample write cannot cross deletion or original life' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sample_write_fence BEFORE INSERT OR UPDATE ON platform.sample_effects
 FOR EACH ROW EXECUTE FUNCTION platform.guard_sample_write();
CREATE TRIGGER sample_projection_write_fence BEFORE INSERT OR UPDATE ON platform.sample_projections
 FOR EACH ROW EXECUTE FUNCTION platform.guard_sample_write();
CREATE FUNCTION platform.capture_sample_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform.sample_reference_anchors(id,actor_user_id,product_epoch,name_digest)
    SELECT NEW.id,NEW.actor_user_id,(SELECT product_epoch FROM identity.accounts WHERE user_id=NEW.actor_user_id),
      encode(sha256(convert_to(NEW.name,'UTF8')),'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER sample_reference_capture AFTER INSERT ON platform.sample_effects
 FOR EACH ROW EXECUTE FUNCTION platform.capture_sample_reference();
CREATE FUNCTION platform.guard_sample_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original platform.sample_reference_anchors; epoch integer; state text;
BEGIN
  IF NEW.event_type<>'platform.sample-effect-created.v1' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.aggregate_type,NEW.aggregate_id,NEW.event_type,NEW.schema_version,NEW.payload,NEW.occurred_at,NEW.correlation_id,NEW.causation_id)
      IS DISTINCT FROM ROW(OLD.id,OLD.aggregate_type,OLD.aggregate_id,OLD.event_type,OLD.schema_version,OLD.payload,OLD.occurred_at,OLD.correlation_id,OLD.causation_id) THEN
      RAISE EXCEPTION 'sample event birth is immutable' USING ERRCODE='23514'; END IF;
    -- Release/retry settlement must remain possible after a tombstone.
    IF NEW.lease_owner IS NOT DISTINCT FROM OLD.lease_owner AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
      OR (NEW.lease_owner IS NULL AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at) THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO original FROM platform.sample_reference_anchors WHERE id=NEW.aggregate_id;
  IF original.id IS NULL OR NEW.aggregate_type<>'sample_effect' OR NEW.schema_version<>1
    OR NOT EXISTS(SELECT 1 FROM platform.sample_effects source WHERE source.id=original.id
      AND source.actor_user_id=original.actor_user_id AND encode(sha256(convert_to(source.name,'UTF8')),'hex')=original.name_digest
      AND NEW.payload=jsonb_build_object('effectId',source.id,'name',source.name)) THEN
    RAISE EXCEPTION 'sample event requires original source' USING ERRCODE='23514'; END IF;
  PERFORM id FROM identity.users WHERE id=original.actor_user_id FOR NO KEY UPDATE;
  SELECT account.product_epoch,account.state INTO epoch,state FROM identity.accounts account WHERE account.user_id=original.actor_user_id FOR UPDATE;
  IF state='deleted' OR epoch IS DISTINCT FROM original.product_epoch THEN
    RAISE EXCEPTION 'sample publication cannot cross deletion or original life' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sample_outbox_fence BEFORE INSERT OR UPDATE ON platform.outbox_events
 FOR EACH ROW EXECUTE FUNCTION platform.guard_sample_outbox();

CREATE FUNCTION platform.sample_purge_proven(subject uuid,source uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT EXISTS(
  SELECT 1 FROM platform.sample_reference_anchors original
  JOIN identity.account_deletion_records root ON root.id=subject
  JOIN identity.account_deletion_sample_receipts receipt ON receipt.source_id=original.id AND receipt.deletion_record_id=root.id
  JOIN platform.audit_logs audit ON audit.id=receipt.audit_id AND audit.subject_id=root.id
  JOIN platform.outbox_events event ON event.id=receipt.event_id
  WHERE original.id=source AND original.actor_user_id=root.user_id AND original.product_epoch=root.product_epoch
    AND audit.category='account' AND audit.event_type='account.deletion-product-batch.v1'
    AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
    AND audit.subject_type='account_deletion' AND audit.result_code='product_batch_purged' AND audit.metadata_schema_version=1
    AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at>=root.requested_at
    AND audit.metadata->'resource'='11'::jsonb AND audit.metadata->'final'='true'::jsonb
    AND audit.metadata#>>ARRAY['sourceHashes',source::text]=original.name_digest
    AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id AND event.event_type=audit.event_type AND event.schema_version=1
    AND event.payload=jsonb_build_object('deletionRecordId',root.id,'resource',11,'rows',audit.metadata->'rows','auditId',audit.id)
    AND event.occurred_at=audit.occurred_at
    AND event.correlation_id=root.request_id AND event.causation_id=root.command_id
    AND receipt.proof_hash=platform.sample_purge_digest(receipt.audit_id,receipt.event_id))
$$;
CREATE FUNCTION identity.guard_sample_purge_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'sample removal history requires controlled release' USING ERRCODE='55000'; END IF;
  IF platform.sample_purge_proven(NEW.deletion_record_id,NEW.source_id) IS NOT TRUE
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_records root
      JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
      JOIN identity.accounts account ON account.user_id=root.user_id
      JOIN platform.audit_logs audit ON audit.id=NEW.audit_id
      WHERE root.id=NEW.deletion_record_id AND root.phase='product_data' AND root.checkpoint_version=3
        AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
        AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
        AND work.lease_owner::text=audit.metadata->>'owner'
        AND to_jsonb(work.lease_generation)=audit.metadata->'generation'
        AND work.lease_expires_at=(audit.metadata->>'leaseExpiresAt')::timestamptz
        AND work.lease_expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'sample removal proof incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER sample_purge_receipt_required AFTER INSERT OR UPDATE OR DELETE ON identity.account_deletion_sample_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.guard_sample_purge_receipt();
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
  IF root.id IS NULL OR job.deletion_record_id IS NULL OR resource IS NULL OR (resource NOT BETWEEN 0 AND 10 AND resource<>11)
    OR removed IS NULL OR removed NOT BETWEEN 1 AND 100 OR event IS NULL
    OR root.phase<>'product_data' OR root.checkpoint_version<>3 OR root.checklist_version<>1
    OR root.product_purged_at IS NOT NULL OR root.completed_at IS NOT NULL OR root.reactivation_allowed
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS NULL OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR NEW.category<>'account' OR NEW.actor_type<>'system' OR NEW.actor_user_id IS NOT NULL OR NEW.actor_admin_id IS NOT NULL
    OR NEW.subject_type<>'account_deletion' OR NEW.result_code<>'product_batch_purged' OR NEW.metadata_schema_version<>1
    OR NEW.command_id IS DISTINCT FROM root.command_id OR NEW.request_id IS DISTINCT FROM root.request_id
    OR NEW.occurred_at>=job.lease_expires_at
    OR NEW.metadata IS DISTINCT FROM (jsonb_build_object('resource',resource,'rows',removed,'eventId',event,
      'owner',job.lease_owner,'generation',job.lease_generation,'leaseExpiresAt',job.lease_expires_at) || CASE WHEN resource=11 THEN jsonb_build_object('sourceHashes',NEW.metadata->'sourceHashes','final',NEW.metadata->'final','deletedCount',NEW.metadata->'deletedCount') ELSE '{}'::jsonb END)
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
  IF resource BETWEEN 8 AND 10 AND ((resource=8 AND removed NOT BETWEEN 1 AND 2) OR identity.deletion_evidence_blocker(root.id,root.user_id) IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=root.user_id AND product_epoch=root.product_epoch)) THEN
    RAISE EXCEPTION 'Transport/Like original-life evidence fence missing' USING ERRCODE='23514';
  END IF;
  IF resource=11 THEN
    IF jsonb_typeof(NEW.metadata->'sourceHashes') IS DISTINCT FROM 'object'
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.metadata->'sourceHashes'))<>1
      OR removed<>1 OR jsonb_typeof(NEW.metadata->'final') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(NEW.metadata->'deletedCount') IS DISTINCT FROM 'number'
      OR (NEW.metadata->>'deletedCount')::integer NOT BETWEEN 1 AND 102
      OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=root.user_id AND product_epoch=root.product_epoch)
      OR NOT EXISTS(SELECT 1 FROM platform.sample_reference_anchors original
        WHERE original.actor_user_id=root.user_id AND original.product_epoch=root.product_epoch
          AND NEW.metadata->'sourceHashes'=jsonb_build_object(original.id::text,original.name_digest)
          AND ((NEW.metadata->>'final')::boolean IS FALSE OR (
            NOT EXISTS(SELECT 1 FROM platform.sample_effects WHERE id=original.id)
            AND NOT EXISTS(SELECT 1 FROM platform.sample_projections WHERE effect_id=original.id)
            AND NOT EXISTS(SELECT 1 FROM platform.outbox_events WHERE aggregate_type='sample_effect' AND aggregate_id=original.id)))) THEN
      RAISE EXCEPTION 'sample removal original scope or physical absence missing' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE VIEW platform.deletion_original_subjects AS
  SELECT 'user'::text AS resource,id AS source_id,id AS user_id FROM identity.users
  UNION ALL SELECT 'account',user_id,user_id FROM identity.accounts
  UNION ALL SELECT 'credit_account',user_id,user_id FROM billing.credit_accounts
  UNION ALL SELECT 'explore_filter',user_id,user_id FROM discovery.explore_filters
  UNION ALL SELECT 'profile',id,user_id FROM profile.profile_reference_anchors
  UNION ALL SELECT 'profile_photo',photo.id,profile.user_id FROM media.photo_reference_anchors photo JOIN profile.profile_reference_anchors profile ON profile.id=photo.profile_id
  UNION ALL SELECT 'media_asset',id,owner_user_id FROM media.asset_reference_anchors
  UNION ALL SELECT 'match',id,user_low_id FROM matching.match_reference_anchors
  UNION ALL SELECT 'match',id,user_high_id FROM matching.match_reference_anchors
  UNION ALL SELECT 'chat_session',chat.id,match.user_low_id FROM chat.chat_reference_anchors chat JOIN matching.match_reference_anchors match ON match.id=chat.match_id
  UNION ALL SELECT 'chat_session',chat.id,match.user_high_id FROM chat.chat_reference_anchors chat JOIN matching.match_reference_anchors match ON match.id=chat.match_id
  UNION ALL SELECT 'like',id,sender_user_id FROM interaction.like_reference_anchors
  UNION ALL SELECT 'like',id,receiver_user_id FROM interaction.like_reference_anchors
  UNION ALL SELECT 'nakh',id,sender_user_id FROM nakh.nakh_reference_anchors
  UNION ALL SELECT 'nakh',id,receiver_user_id FROM nakh.nakh_reference_anchors
  UNION ALL SELECT 'nakh_flow',id,sender_user_id FROM nakh.flow_reference_anchors
  UNION ALL SELECT 'nakh_flow',id,receiver_user_id FROM nakh.flow_reference_anchors
  UNION ALL SELECT 'pending_nakh',id,sender_user_id FROM nakh.pending_nakh_reference_anchors
  UNION ALL SELECT 'pending_nakh',id,receiver_user_id FROM nakh.pending_nakh_reference_anchors
  UNION ALL SELECT 'notification',id,user_id FROM notification.notice_reference_anchors
  UNION ALL SELECT 'notification_delivery',delivery.id,notice.user_id FROM notification.notification_deliveries delivery JOIN notification.notice_reference_anchors notice ON notice.id=delivery.notification_id
  UNION ALL SELECT 'feature_unlock',id,payer_user_id FROM interaction.feature_unlock_reference_anchors
  UNION ALL SELECT 'payment_record',id,user_id FROM billing.payment_records
  UNION ALL SELECT 'credit_transaction',id,credit_account_id FROM billing.credit_transactions
  UNION ALL SELECT 'support_thread',id,user_id FROM support.support_threads
  UNION ALL SELECT 'user_appeal',id,user_id FROM moderation.user_appeals
  UNION ALL SELECT 'report',id,reporter_user_id FROM moderation.reports
  UNION ALL SELECT 'report',id,target_user_id FROM moderation.reports
  UNION ALL SELECT 'restriction_episode',id,target_user_id FROM moderation.restriction_episodes
  UNION ALL SELECT 'moderation_action',id,target_user_id FROM moderation.moderation_actions WHERE target_user_id IS NOT NULL
  UNION ALL SELECT 'moderation_action',id,target_pair_low_user_id FROM moderation.moderation_actions WHERE target_pair_low_user_id IS NOT NULL
  UNION ALL SELECT 'moderation_action',id,target_pair_high_user_id FROM moderation.moderation_actions WHERE target_pair_high_user_id IS NOT NULL
  UNION ALL SELECT 'profile_change_request',id,user_id FROM profile.profile_change_requests
  UNION ALL SELECT 'telegram_liked_by_delivery',id,viewer_user_id FROM channel_telegram.liked_by_delivery_requests
  UNION ALL SELECT 'account_deletion',id,user_id FROM identity.account_deletion_records
  UNION ALL SELECT 'sample_effect',id,actor_user_id FROM platform.sample_reference_anchors;
CREATE OR REPLACE FUNCTION identity.deletion_product_blocker(root_id uuid,subject uuid) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE resource jsonb; present boolean; root identity.account_deletion_records;
BEGIN
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=root_id AND user_id=subject;
  IF root.id IS NULL OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted'
    AND version=root.account_version AND product_epoch=root.product_epoch)
    OR identity.deletion_evidence_blocker(root_id,subject) IS NOT NULL THEN RETURN 'evidence'; END IF;
  IF identity.deletion_pair_proofs_valid(root_id,subject) IS NOT TRUE THEN RETURN 'source_proof'; END IF;
  FOR resource IN SELECT * FROM jsonb_array_elements(identity.deletion_product_selectors()) LOOP
    -- Both identifiers and SQL come from this reviewed migration, never a caller.
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM '||(resource->>'table')||' row WHERE '||(resource->>'predicate')||')'
      INTO present USING subject;
    IF present THEN RETURN 'ordinary_rows'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM notification.notification_deliveries delivery JOIN notification.notice_reference_anchors anchor ON anchor.id=delivery.notification_id WHERE anchor.user_id=subject)
    THEN RETURN 'ordinary_rows'; END IF;
  IF billing.deletion_credit_cutover_valid(root_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM billing.credit_epoch_closures receipt WHERE receipt.deletion_record_id=root_id
    AND receipt.user_id=subject AND receipt.product_epoch=root.product_epoch)
    OR EXISTS(SELECT 1 FROM billing.credit_accounts WHERE user_id=subject AND (balance<>0 OR product_epoch<>root.product_epoch+1 OR version<>1))
    OR NOT EXISTS(SELECT 1 FROM billing.credit_epoch_accounts WHERE user_id=subject AND product_epoch=root.product_epoch+1 AND balance=0 AND version=1)
    OR EXISTS(SELECT 1 FROM billing.credit_transactions WHERE credit_account_id=subject AND product_epoch=root.product_epoch+1)
    THEN RETURN 'credit_epoch'; END IF;
  IF EXISTS(SELECT 1 FROM support.support_threads WHERE user_id=subject AND product_epoch=root.product_epoch AND status<>'closed')
    THEN RETURN 'support'; END IF;
  IF EXISTS(SELECT 1 FROM platform.sample_reference_anchors original WHERE original.actor_user_id=subject AND original.product_epoch=root.product_epoch AND platform.sample_purge_proven(root_id,original.id) IS NOT TRUE) THEN RETURN 'source_proof'; END IF;
  IF platform.deletion_operational_blocker(subject) THEN RETURN 'operations'; END IF;
  IF EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.deletion_cancellation_audit_id IS NULL
    AND platform.deletion_event_disposition(event.event_type,event.schema_version,event.payload)='product_transport'
    AND platform.deletion_event_owned(subject,event)) THEN RETURN 'publication'; END IF;
  IF EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.deletion_cancellation_audit_id IS NULL
    AND platform.deletion_event_disposition(event.event_type,event.schema_version,event.payload)='unclassified') THEN RETURN 'operations'; END IF;
  IF EXISTS(SELECT 1 FROM platform.audit_logs audit JOIN identity.account_deletion_records owner ON owner.id=audit.subject_id
    WHERE audit.event_type='account.deletion-operational-batch.v1' AND owner.user_id=subject
      AND platform.deletion_cancellation_audit_valid(audit.id) IS NOT TRUE) THEN RETURN 'source_proof'; END IF;
  IF EXISTS(SELECT 1 FROM identity.account_deletion_notice_receipts receipt JOIN identity.account_deletion_records owner ON owner.id=receipt.deletion_record_id
    WHERE owner.user_id=subject AND identity.notice_receipt_proof_valid(receipt) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM identity.account_deletion_flow_receipts receipt JOIN identity.account_deletion_records owner ON owner.id=receipt.deletion_record_id
      WHERE owner.user_id=subject AND identity.flow_receipt_proof_valid(receipt) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM identity.account_deletion_like_receipts receipt JOIN identity.account_deletion_records owner ON owner.id=receipt.deletion_record_id
      WHERE owner.user_id=subject AND identity.like_receipt_proof_valid(receipt) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM identity.account_deletion_unlock_receipts receipt JOIN identity.account_deletion_records owner ON owner.id=receipt.deletion_record_id
      WHERE owner.user_id=subject AND identity.unlock_receipt_proof_valid(receipt) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM identity.account_deletion_pair_receipts receipt JOIN identity.account_deletion_records owner ON owner.id=receipt.deletion_record_id
      WHERE owner.user_id=subject AND identity.pair_receipt_proof_valid(receipt) IS NOT TRUE)
    THEN RETURN 'source_proof'; END IF;
  -- Independent original child references still witness obligations if a Flow
  -- reference was physically lost; absence alone never authenticates archival.
  IF EXISTS(SELECT 1 FROM nakh.nakh_reference_anchors anchor WHERE
    ((anchor.sender_user_id=subject AND anchor.sender_product_epoch=root.product_epoch)
      OR (anchor.receiver_user_id=subject AND anchor.receiver_product_epoch=root.product_epoch))
    AND nakh.flow_source_archivable(anchor.nakh_flow_id) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM nakh.pending_nakh_reference_anchors anchor WHERE
    ((anchor.sender_user_id=subject AND anchor.sender_product_epoch=root.product_epoch)
      OR (anchor.receiver_user_id=subject AND anchor.receiver_product_epoch=root.product_epoch))
    AND nakh.flow_source_archivable(anchor.nakh_flow_id) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM identity.account_deletion_paid_pending_receipts receipt
      JOIN identity.account_deletion_records owner ON owner.id=receipt.deletion_record_id
      WHERE owner.user_id=subject AND identity.paid_pending_receipt_proof_valid(receipt) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM identity.account_deletion_terminal_pending_receipts receipt
      JOIN identity.account_deletion_records owner ON owner.id=receipt.deletion_record_id
      WHERE owner.user_id=subject AND identity.terminal_pending_receipt_proof_valid(receipt) IS NOT TRUE)
    THEN RETURN 'source_proof'; END IF;
  IF EXISTS(SELECT 1 FROM nakh.flow_reference_anchors anchor WHERE
    ((anchor.sender_user_id=subject AND anchor.sender_product_epoch=root.product_epoch)
      OR (anchor.receiver_user_id=subject AND anchor.receiver_product_epoch=root.product_epoch))
    AND nakh.flow_source_archivable(anchor.id) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM interaction.like_reference_anchors anchor WHERE
      ((anchor.sender_user_id=subject AND anchor.sender_product_epoch=root.product_epoch)
        OR (anchor.receiver_user_id=subject AND anchor.receiver_product_epoch=root.product_epoch))
      AND interaction.like_source_archivable(anchor.id) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM notification.notice_reference_anchors anchor WHERE anchor.user_id=subject
      AND anchor.product_epoch=root.product_epoch AND notification.notice_source_archivable(anchor.id) IS NOT TRUE)
    OR EXISTS(SELECT 1 FROM interaction.feature_unlock_reference_anchors anchor WHERE anchor.payer_user_id=subject
      AND anchor.payer_product_epoch=root.product_epoch AND interaction.unlock_source_archivable(anchor.id) IS NOT TRUE)
    THEN RETURN 'source_proof'; END IF;
  RETURN NULL;
END $$;
