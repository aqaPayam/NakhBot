-- Fresh original-life provider passes at verification/7, then atomic completion/8.
-- Old page/audit bytes remain valid. Completion grants neither Return nor release.
CREATE FUNCTION identity.ephemeral_verification_restart(a platform.audit_logs,prior identity.account_deletion_ephemeral_pages)
 RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(
 a.metadata->'checkpointVersion'='7'::jsonb AND a.metadata->'stage'='0'::jsonb AND prior.next_stage=6
 AND EXISTS(SELECT 1 FROM platform.audit_logs origin WHERE origin.id=prior.id AND NOT origin.metadata?'checkpointVersion'),false) $$;
CREATE OR REPLACE FUNCTION identity.ephemeral_preparation_valid(a platform.audit_logs) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE root identity.account_deletion_records; prior identity.account_deletion_ephemeral_pages; revision integer; stage integer; expiry timestamptz; checkpoint integer; prior_checkpoint integer;
BEGIN
 IF a.id IS NULL OR a.category<>'account' OR a.event_type<>'account.deletion-ephemeral-prepared.v1' OR a.actor_type<>'system'
  OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL OR a.subject_type<>'account_deletion' OR a.result_code<>'prepared'
  OR a.metadata_schema_version<>1 OR (CASE WHEN a.metadata?'checkpointVersion' THEN (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>14 OR a.metadata->'checkpointVersion' IS DISTINCT FROM '7'::jsonb ELSE (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>13 END)
  OR NOT a.metadata?&ARRAY['revision','stage','cursorHash','previousId','namespaceHash','legacyNamespaceHash','queueHash','cutoverEvidenceHash','productEpoch','owner','generation','leaseExpiresAt','transactionId']
  OR jsonb_typeof(a.metadata->'legacyNamespaceHash') IS DISTINCT FROM 'string' OR a.metadata->>'legacyNamespaceHash'!~'^[0-9a-f]{64}$'
  OR jsonb_typeof(a.metadata->'queueHash') IS DISTINCT FROM 'string' OR a.metadata->>'queueHash'!~'^[0-9a-f]{64}$' THEN RETURN false; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 IF root.id IS NULL OR a.command_id<>root.command_id OR a.request_id<>root.request_id OR a.occurred_at<root.requested_at
  OR a.occurred_at>clock_timestamp() OR NOT isfinite(a.occurred_at)
  OR a.metadata->'productEpoch' IS DISTINCT FROM to_jsonb(root.product_epoch)
  OR a.metadata->>'namespaceHash'!~'^[0-9a-f]{64}$' OR a.metadata->>'cutoverEvidenceHash'!~'^[0-9a-f]{64}$'
  OR a.metadata->>'cursorHash'!~'^[0-9a-f]{64}$' OR a.metadata->>'transactionId'!~'^[1-9][0-9]{0,19}$'
  OR jsonb_typeof(a.metadata->'owner') IS DISTINCT FROM 'string' OR jsonb_typeof(a.metadata->'leaseExpiresAt') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'transactionId') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'namespaceHash') IS DISTINCT FROM 'string' OR jsonb_typeof(a.metadata->'cutoverEvidenceHash') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'cursorHash') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 checkpoint:=CASE WHEN a.metadata?'checkpointVersion' THEN 7 ELSE 5 END;
 PERFORM (a.metadata->>'owner')::uuid;
 revision:=(a.metadata->>'revision')::integer; stage:=(a.metadata->>'stage')::integer; expiry:=(a.metadata->>'leaseExpiresAt')::timestamptz;
 IF revision<1 OR stage NOT BETWEEN 0 AND 5 OR a.metadata->'revision' IS DISTINCT FROM to_jsonb(revision)
  OR a.metadata->'stage' IS DISTINCT FROM to_jsonb(stage) OR (a.metadata->>'generation')::integer<1
  OR a.metadata->'generation' IS DISTINCT FROM to_jsonb((a.metadata->>'generation')::integer)
  OR NOT isfinite(expiry) OR a.occurred_at>=expiry THEN RETURN false; END IF;
 IF revision=1 THEN
  RETURN checkpoint=5 AND stage=0 AND a.metadata->'previousId'='null'::jsonb
   AND a.metadata->>'cursorHash'=encode(sha256(convert_to(identity.ephemeral_zero(0)::text,'UTF8')),'hex');
 END IF;
 SELECT * INTO prior FROM identity.account_deletion_ephemeral_pages WHERE id=(a.metadata->>'previousId')::uuid;
 SELECT coalesce((origin.metadata->>'checkpointVersion')::integer,5) INTO prior_checkpoint FROM platform.audit_logs origin WHERE origin.id=prior.id;
 RETURN prior.id IS NOT NULL AND prior.deletion_record_id=root.id AND prior.revision=revision-1 AND ((prior.next_stage=stage AND prior_checkpoint=checkpoint) OR identity.ephemeral_verification_restart(a,prior))
  AND a.metadata->>'cursorHash'=encode(sha256(convert_to(prior.next_cursor::text,'UTF8')),'hex')
  AND EXISTS(SELECT 1 FROM platform.audit_logs origin WHERE origin.id=prior.id
   AND origin.metadata->'namespaceHash'=a.metadata->'namespaceHash' AND origin.metadata->'cutoverEvidenceHash'=a.metadata->'cutoverEvidenceHash'
   AND origin.metadata->'legacyNamespaceHash'=a.metadata->'legacyNamespaceHash' AND origin.metadata->'queueHash'=a.metadata->'queueHash');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION identity.ephemeral_operation_current(operation uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE a platform.audit_logs; root identity.account_deletion_records; job identity.account_deletion_work;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=operation;
 IF identity.ephemeral_preparation_valid(a) IS NOT TRUE THEN RETURN false; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=root.id;
 RETURN ((root.phase='ephemeral_access' AND root.checkpoint_version=5 AND NOT a.metadata?'checkpointVersion') OR (root.phase='verification' AND root.checkpoint_version=7 AND a.metadata->'checkpointVersion'='7'::jsonb)) AND root.completed_at IS NULL
  AND EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=root.user_id AND state='deleted' AND version=root.account_version AND product_epoch=root.product_epoch)
  AND job.phase=root.phase AND job.checkpoint_version=root.checkpoint_version AND job.lease_owner=(a.metadata->>'owner')::uuid
  AND job.lease_generation=(a.metadata->>'generation')::integer
  AND job.lease_expires_at=(a.metadata->>'leaseExpiresAt')::timestamptz AND job.lease_expires_at>clock_timestamp();
END $$;
CREATE OR REPLACE FUNCTION identity.ephemeral_page_valid(p identity.account_deletion_ephemeral_pages) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE a platform.audit_logs; observed platform.audit_logs; prior identity.account_deletion_ephemeral_pages; transition jsonb; pending boolean:=false;
BEGIN
 SELECT * INTO a FROM platform.audit_logs WHERE id=p.id;
 SELECT * INTO observed FROM platform.audit_logs WHERE id=p.audit_id;
 IF identity.ephemeral_preparation_valid(a) IS NOT TRUE OR p.deletion_record_id<>a.subject_id OR p.revision<>(a.metadata->>'revision')::integer
  OR p.stage<>(a.metadata->>'stage')::integer OR identity.ephemeral_cursor_namespace(p.cursor_out,a.metadata->>'namespaceHash') IS NOT TRUE OR a.metadata->>'cursorHash'<>encode(sha256(convert_to(p.cursor_in::text,'UTF8')),'hex')
  OR observed.id IS NULL OR observed.category<>'account' OR observed.event_type<>'account.deletion-ephemeral-observed.v1'
  OR observed.actor_type<>'system' OR observed.actor_user_id IS NOT NULL OR observed.actor_admin_id IS NOT NULL
  OR observed.subject_type<>'account_deletion' OR observed.subject_id<>a.subject_id OR observed.result_code<>'observed'
  OR observed.metadata_schema_version<>1 OR observed.command_id<>a.command_id OR observed.request_id<>a.request_id
  OR observed.occurred_at<a.occurred_at OR observed.occurred_at>clock_timestamp() OR observed.occurred_at>=(a.metadata->>'leaseExpiresAt')::timestamptz
  OR observed.metadata<>jsonb_build_object('operationId',p.id,'revision',p.revision,'found',p.found,'more',p.more)
  OR p.proof_hash IS DISTINCT FROM identity.ephemeral_page_digest(p) THEN RETURN false; END IF;
 IF p.revision=1 THEN
  IF p.previous_id IS NOT NULL OR p.cursor_in<>identity.ephemeral_zero(0) THEN RETURN false; END IF;
 ELSE
  SELECT * INTO prior FROM identity.account_deletion_ephemeral_pages WHERE id=p.previous_id;
  IF prior.id IS NULL OR prior.deletion_record_id<>p.deletion_record_id OR prior.revision<>p.revision-1
   OR (prior.next_stage<>p.stage AND NOT identity.ephemeral_verification_restart(a,prior)) OR prior.next_cursor<>p.cursor_in OR prior.proof_hash IS DISTINCT FROM p.previous_hash THEN RETURN false; END IF;
  pending:=prior.pending_found;
 END IF;
 transition:=identity.ephemeral_next(p.stage,p.cursor_out,p.more,p.found,pending);
 RETURN transition IS NOT NULL AND p.next_stage=(transition->>'stage')::integer AND p.next_cursor=transition->'cursor' AND p.pending_found=(transition->>'pending')::boolean;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION identity.guard_ephemeral_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid; last_revision integer;
BEGIN
 IF NEW.event_type<>'account.deletion-ephemeral-prepared.v1' THEN RETURN NEW; END IF;
 SELECT user_id INTO subject FROM identity.account_deletion_records WHERE id=NEW.subject_id;
 PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
 PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
 PERFORM id FROM identity.account_deletion_records WHERE id=NEW.subject_id FOR UPDATE;
 PERFORM deletion_record_id FROM identity.account_deletion_work WHERE deletion_record_id=NEW.subject_id FOR UPDATE;
 SELECT coalesce(max(revision),0) INTO last_revision FROM identity.account_deletion_ephemeral_pages WHERE deletion_record_id=NEW.subject_id;
 IF identity.ephemeral_preparation_valid(NEW) IS NOT TRUE OR identity.ephemeral_history_valid(NEW.subject_id) IS NOT TRUE
  OR (NEW.metadata->>'revision')::integer<>last_revision+1 OR (NEW.metadata->>'transactionId')::xid8<>pg_current_xact_id()
  OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_records root JOIN identity.account_deletion_work job ON job.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id WHERE root.id=NEW.subject_id AND ((root.phase='ephemeral_access' AND root.checkpoint_version=5 AND NOT NEW.metadata?'checkpointVersion') OR (root.phase='verification' AND root.checkpoint_version=7 AND NEW.metadata->'checkpointVersion'='7'::jsonb))
     AND root.completed_at IS NULL AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
     AND job.phase=root.phase AND job.checkpoint_version=root.checkpoint_version AND job.lease_owner=(NEW.metadata->>'owner')::uuid
     AND job.lease_generation=(NEW.metadata->>'generation')::integer AND job.lease_expires_at=(NEW.metadata->>'leaseExpiresAt')::timestamptz AND job.lease_expires_at>clock_timestamp())
  OR identity.deletion_media_blocker(NEW.subject_id,subject) IS NOT NULL OR identity.deletion_session_blocker(NEW.subject_id,subject) IS NOT NULL
  OR EXISTS(SELECT 1 FROM platform.audit_logs a WHERE a.event_type=NEW.event_type AND a.subject_id=NEW.subject_id AND
   (a.metadata->'namespaceHash' IS DISTINCT FROM NEW.metadata->'namespaceHash' OR a.metadata->'legacyNamespaceHash' IS DISTINCT FROM NEW.metadata->'legacyNamespaceHash'
    OR a.metadata->'queueHash' IS DISTINCT FROM NEW.metadata->'queueHash' OR a.metadata->'cutoverEvidenceHash' IS DISTINCT FROM NEW.metadata->'cutoverEvidenceHash'))
  OR EXISTS(SELECT 1 FROM platform.audit_logs a WHERE a.event_type=NEW.event_type AND a.subject_id=NEW.subject_id
     AND a.metadata->'revision'=NEW.metadata->'revision' AND a.metadata->'generation'=NEW.metadata->'generation') THEN
  RAISE EXCEPTION 'ephemeral preparation lacks current original authority' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION identity.deletion_session_context(a platform.audit_logs,live boolean) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work; owner identity.accounts;
 ids uuid[]; expiry timestamptz; worker uuid; generation integer;
BEGIN
 IF a.category<>'security' OR a.event_type<>'identity.user-session-root-revoked.v1'
  OR a.actor_type<>'system' OR a.actor_user_id IS NOT NULL OR a.actor_admin_id IS NOT NULL
  OR a.subject_type<>'account_deletion' OR a.result_code<>'deletion_sessions_revoked' OR a.metadata_schema_version<>1
  OR (SELECT count(*) FROM jsonb_object_keys(a.metadata))<>7
  OR jsonb_typeof(a.metadata->'grantIds') IS DISTINCT FROM 'array'
  OR jsonb_array_length(a.metadata->'grantIds') NOT BETWEEN 1 AND 100
  OR a.metadata->'rows' IS DISTINCT FROM to_jsonb(jsonb_array_length(a.metadata->'grantIds'))
  OR jsonb_typeof(a.metadata->'productEpoch') IS DISTINCT FROM 'number'
  OR jsonb_typeof(a.metadata->'owner') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'generation') IS DISTINCT FROM 'number'
  OR jsonb_typeof(a.metadata->'leaseExpiresAt') IS DISTINCT FROM 'string'
  OR jsonb_typeof(a.metadata->'transactionId') IS DISTINCT FROM 'string'
  OR (a.metadata->>'transactionId')!~'^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
 SELECT array_agg(value::uuid ORDER BY value::uuid) INTO ids FROM jsonb_array_elements_text(a.metadata->'grantIds');
 IF cardinality(ids)<>(SELECT count(DISTINCT id) FROM unnest(ids) id) THEN RETURN false; END IF;
 worker:=(a.metadata->>'owner')::uuid; generation:=(a.metadata->>'generation')::integer;
 expiry:=(a.metadata->>'leaseExpiresAt')::timestamptz;
 IF generation<1 OR a.metadata->'generation' IS DISTINCT FROM to_jsonb(generation)
  OR NOT isfinite(expiry) OR a.occurred_at>=expiry OR a.occurred_at>clock_timestamp() THEN RETURN false; END IF;
 SELECT * INTO root FROM identity.account_deletion_records WHERE id=a.subject_id;
 IF root.id IS NULL OR a.command_id<>root.command_id OR a.request_id<>root.request_id
  OR a.occurred_at<root.requested_at OR a.metadata->'productEpoch' IS DISTINCT FROM to_jsonb(root.product_epoch)
  OR cardinality(ids)<>(SELECT count(*) FROM platform.audit_logs source WHERE source.id=ANY(ids)
    AND source.actor_user_id=root.user_id AND identity.user_session_epoch(source.id)=root.product_epoch) THEN RETURN false; END IF;
 IF live THEN
  SELECT * INTO owner FROM identity.accounts WHERE user_id=root.user_id;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=root.id;
  IF owner.user_id IS NULL OR owner.state<>'deleted' OR owner.version<>root.account_version OR owner.product_epoch<>root.product_epoch
   OR NOT ((root.phase='ephemeral_access' AND root.checkpoint_version=5) OR (root.phase='verification' AND root.checkpoint_version=7)) OR root.completed_at IS NOT NULL
   OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version OR job.lease_owner IS DISTINCT FROM worker
   OR job.lease_generation<>generation OR job.lease_expires_at IS DISTINCT FROM expiry OR expiry<=clock_timestamp()
   OR (a.metadata->>'transactionId')::xid8<>pg_current_xact_id() THEN RETURN false; END IF;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION identity.ephemeral_reconciliation_payload(root_id uuid,at timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('namespaceHash',prepared.metadata->'namespaceHash','cutoverEvidenceHash',prepared.metadata->'cutoverEvidenceHash',
  'verificationPageId',page.id,'verificationHash',page.proof_hash,
  'reverifiedIntentCount',(SELECT count(*) FROM platform.audit_logs intent WHERE intent.occurred_at<=at AND (
    (intent.event_type='account.deletion-ephemeral-prepared.v1' AND intent.subject_id=root_id)
    OR (intent.event_type='platform.legacy-opaque-retirement-authorized.v1' AND intent.metadata->'namespaceHash'=prepared.metadata->'legacyNamespaceHash')
    OR (intent.event_type='queue.legacy-reference-prepared.v1' AND intent.metadata->'queueHash'=prepared.metadata->'queueHash'))),
  'intentSetHash',(SELECT encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(((to_jsonb(intent)-'occurred_at')||jsonb_build_object('atEpoch',extract(epoch FROM intent.occurred_at)))::text,'UTF8')),'hex'),'' ORDER BY intent.id),''),'UTF8')),'hex')
    FROM platform.audit_logs intent WHERE intent.occurred_at<=at AND (
    (intent.event_type='account.deletion-ephemeral-prepared.v1' AND intent.subject_id=root_id)
    OR (intent.event_type='platform.legacy-opaque-retirement-authorized.v1' AND intent.metadata->'namespaceHash'=prepared.metadata->'legacyNamespaceHash')
    OR (intent.event_type='queue.legacy-reference-prepared.v1' AND intent.metadata->'queueHash'=prepared.metadata->'queueHash'))))
 FROM identity.account_deletion_ephemeral_pages page JOIN platform.audit_logs prepared ON prepared.id=page.id
 WHERE page.deletion_record_id=root_id AND page.next_stage=6
  AND EXISTS(SELECT 1 FROM platform.audit_logs observed WHERE observed.id=page.audit_id AND observed.occurred_at<=at) ORDER BY page.revision DESC LIMIT 1 $$;
CREATE FUNCTION identity.deletion_verification_blocker(root_id uuid,subject uuid) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
 IF identity.deletion_retention_blocker(root_id,subject) IS NOT NULL THEN RETURN 'retention'; END IF;
 IF EXISTS(SELECT 1 FROM identity.telegram_identities WHERE user_id=subject AND username IS NOT NULL) THEN RETURN 'stable_identity'; END IF;
 IF NOT EXISTS(SELECT 1 FROM identity.account_deletion_ephemeral_pages p JOIN platform.audit_logs a ON a.id=p.id
  WHERE p.deletion_record_id=root_id AND p.revision=(SELECT max(revision) FROM identity.account_deletion_ephemeral_pages WHERE deletion_record_id=root_id)
  AND p.next_stage=6 AND a.metadata->'checkpointVersion'='7'::jsonb) THEN RETURN 'fresh_provider_pass'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION identity.guard_deletion_phase_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'deletion phase receipt requires controlled release' USING ERRCODE='55000';
  END IF;
  IF NEW.completed_phase='verification' AND (identity.deletion_verification_blocker(NEW.deletion_record_id,(SELECT user_id FROM identity.account_deletion_records WHERE id=NEW.deletion_record_id)) IS NOT NULL OR NOT identity.ephemeral_reconciliation_valid(NEW.deletion_record_id,NEW.verified_at)) THEN RAISE EXCEPTION 'final verification incomplete' USING ERRCODE='23514'; END IF;
  IF NEW.completed_phase='retention_manifest' AND identity.deletion_retention_blocker(NEW.deletion_record_id,(SELECT user_id FROM identity.account_deletion_records WHERE id=NEW.deletion_record_id)) IS NOT NULL THEN RAISE EXCEPTION 'retention verification incomplete' USING ERRCODE='23514'; END IF;
  IF NEW.completed_phase='ephemeral_access' AND (identity.deletion_ephemeral_blocker(NEW.deletion_record_id,(SELECT user_id FROM identity.account_deletion_records WHERE id=NEW.deletion_record_id)) IS NOT NULL OR NOT identity.ephemeral_reconciliation_valid(NEW.deletion_record_id,NEW.verified_at)) THEN RAISE EXCEPTION 'ephemeral verification incomplete' USING ERRCODE='23514'; END IF;
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
        OR (NEW.completed_phase='verification' AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=record.id AND prior.completed_phase='retention_manifest'))
        OR (NEW.completed_phase='retention_manifest' AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=record.id AND prior.completed_phase='ephemeral_access'))
        OR (NEW.completed_phase='ephemeral_access' AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=record.id AND prior.completed_phase='media_objects'))
        OR (NEW.completed_phase='media_objects' AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=record.id AND prior.completed_phase='product_data'))
        OR (NEW.completed_phase='product_data' AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=record.id AND prior.completed_phase='evidence_capture')))
      AND (NEW.completed_phase<>'verification' OR (identity.deletion_verification_blocker(record.id,record.user_id) IS NULL AND identity.ephemeral_reconciliation_valid(record.id,NEW.verified_at)))
      AND (NEW.completed_phase<>'retention_manifest' OR identity.deletion_retention_blocker(record.id,record.user_id) IS NULL)
      AND (NEW.completed_phase<>'ephemeral_access' OR (identity.deletion_ephemeral_blocker(record.id,record.user_id) IS NULL AND identity.ephemeral_reconciliation_valid(record.id,NEW.verified_at)))
      AND (NEW.completed_phase<>'media_objects' OR identity.deletion_media_blocker(record.id,record.user_id) IS NULL)
      AND (NEW.completed_phase<>'product_data' OR identity.deletion_product_blocker(record.id,record.user_id) IS NULL)
      AND ((NEW.completed_phase='verification' AND record.product_purged_at=NEW.verified_at AND record.completed_at=NEW.verified_at) OR (NEW.completed_phase<>'verification' AND record.product_purged_at IS NULL AND record.completed_at IS NULL))
      AND record.checklist_version=NEW.checklist_version AND record.purge_started_at IS NOT NULL
      AND record.last_error_code IS NULL AND NOT record.reactivation_allowed
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
    OR ((NEW.product_purged_at IS DISTINCT FROM OLD.product_purged_at OR NEW.completed_at IS DISTINCT FROM OLD.completed_at)
      AND NOT (OLD.phase='verification' AND NEW.phase='completed' AND OLD.checkpoint_version=7 AND NEW.checkpoint_version=8
        AND OLD.product_purged_at IS NULL AND OLD.completed_at IS NULL AND NEW.product_purged_at=NEW.completed_at
        AND NEW.completed_at>=NEW.requested_at AND NEW.completed_at<=clock_timestamp()))
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
      OR (OLD.phase='media_objects' AND NEW.phase='ephemeral_access' AND OLD.checkpoint_version=4 AND NEW.checkpoint_version=5)
      OR (OLD.phase='ephemeral_access' AND NEW.phase='retention_manifest' AND OLD.checkpoint_version=5 AND NEW.checkpoint_version=6)
      OR (OLD.phase='retention_manifest' AND NEW.phase='verification' AND OLD.checkpoint_version=6 AND NEW.checkpoint_version=7)
      OR (OLD.phase='verification' AND NEW.phase='completed' AND OLD.checkpoint_version=7 AND NEW.checkpoint_version=8))
    OR NOT EXISTS (SELECT 1 FROM identity.account_deletion_phase_receipts receipt
      WHERE receipt.deletion_record_id=NEW.id AND receipt.completed_phase=OLD.phase
        AND receipt.next_phase=NEW.phase AND receipt.from_checkpoint_version=OLD.checkpoint_version
        AND receipt.next_checkpoint_version=NEW.checkpoint_version
        AND (OLD.phase<>'verification' OR (NEW.completed_at=receipt.verified_at AND NEW.product_purged_at=receipt.verified_at))
        AND ((OLD.phase='shared_closure' AND NEW.shared_closed_at=receipt.verified_at)
          OR (OLD.phase IN('evidence_capture','product_data','media_objects','ephemeral_access','retention_manifest','verification') AND NEW.shared_closed_at IS NOT DISTINCT FROM OLD.shared_closed_at))) THEN
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
      OR (OLD.phase='media_objects' AND NEW.phase='ephemeral_access' AND OLD.checkpoint_version=4 AND NEW.checkpoint_version=5)
      OR (OLD.phase='ephemeral_access' AND NEW.phase='retention_manifest' AND OLD.checkpoint_version=5 AND NEW.checkpoint_version=6)
      OR (OLD.phase='retention_manifest' AND NEW.phase='verification' AND OLD.checkpoint_version=6 AND NEW.checkpoint_version=7)
      OR (OLD.phase='verification' AND NEW.phase='completed' AND OLD.checkpoint_version=7 AND NEW.checkpoint_version=8))
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
ALTER TABLE identity.account_deletion_phase_receipts DROP CONSTRAINT deletion_phase_receipt_transition_check,
 ADD CONSTRAINT deletion_phase_receipt_transition_check CHECK(
  (completed_phase='shared_closure' AND from_checkpoint_version=1 AND next_phase='evidence_capture' AND next_checkpoint_version=2)
  OR (completed_phase='evidence_capture' AND from_checkpoint_version=2 AND next_phase='product_data' AND next_checkpoint_version=3)
  OR (completed_phase='product_data' AND from_checkpoint_version=3 AND next_phase='media_objects' AND next_checkpoint_version=4)
  OR (completed_phase='media_objects' AND from_checkpoint_version=4 AND next_phase='ephemeral_access' AND next_checkpoint_version=5)
  OR (completed_phase='ephemeral_access' AND from_checkpoint_version=5 AND next_phase='retention_manifest' AND next_checkpoint_version=6)
  OR (completed_phase='retention_manifest' AND from_checkpoint_version=6 AND next_phase='verification' AND next_checkpoint_version=7)
  OR (completed_phase='verification' AND from_checkpoint_version=7 AND next_phase='completed' AND next_checkpoint_version=8));

CREATE OR REPLACE FUNCTION identity.finish_deletion_verification_phase(deletion_id uuid, subject uuid, worker uuid, generation integer, checkpoint integer)
RETURNS TABLE(phase text, checkpoint_version integer, replayed boolean, waiting_for text) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work;
  receipt identity.account_deletion_phase_receipts; at timestamptz; audit uuid; event uuid; blocker text; writes integer;
BEGIN
  IF deletion_id IS NULL OR subject IS NULL OR worker IS NULL OR generation IS NULL OR generation<1 OR checkpoint IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
  END IF;
  PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=deletion_id AND user_id=subject FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001'; END IF;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=deletion_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted' AND version=root.account_version AND product_epoch=root.product_epoch) THEN
    RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
  END IF;
  SELECT * INTO receipt FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=deletion_id AND completed_phase='verification';
  IF FOUND THEN
    IF receipt.lease_owner<>worker OR receipt.lease_generation<>generation OR receipt.from_checkpoint_version<>checkpoint THEN
      RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
    END IF;
    RETURN QUERY SELECT receipt.next_phase,receipt.next_checkpoint_version,true,NULL::text; RETURN;
  END IF;
  at:=clock_timestamp();
  IF root.phase<>'verification' OR root.checkpoint_version<>7 OR checkpoint<>7
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS DISTINCT FROM worker OR job.lease_generation<>generation OR job.lease_expires_at IS NULL OR job.lease_expires_at<=at
    OR NOT EXISTS (SELECT 1 FROM platform.user_counters WHERE user_id=subject AND pending_nakh_count=0)
    OR identity.deletion_has_open_shared_scopes(subject) THEN
    RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
  END IF;
  blocker:=identity.deletion_verification_blocker(deletion_id,subject);
  IF blocker IS NOT NULL THEN RETURN QUERY SELECT 'verification'::text,7,false,blocker; RETURN; END IF;
  INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,
    metadata_schema_version,metadata,command_id,request_id,occurred_at)
  VALUES(gen_random_uuid(),'account','account.deletion-ephemeral-reverified.v1','system',NULL,NULL,'account_deletion',deletion_id,'ephemeral_reverified',1,
    identity.ephemeral_reconciliation_payload(deletion_id,at),root.command_id,root.request_id,at);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'final reconciliation audit missing' USING ERRCODE='23514'; END IF;
  audit:=gen_random_uuid(); event:=gen_random_uuid();
  INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,
    metadata_schema_version,metadata,command_id,request_id,occurred_at)
  VALUES(audit,'account','account.deletion-phase-completed.v1','system',NULL,NULL,'account_deletion',deletion_id,'phase_completed',1,
    jsonb_build_object('phase','verification','checkpointVersion',7),root.command_id,root.request_id,at);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'final checkpoint audit missing' USING ERRCODE='23514'; END IF;
  INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
  VALUES(event,'account_deletion',deletion_id,'account.deletion-phase-completed.v1',1,
    jsonb_build_object('deletionRecordId',deletion_id,'completedPhase','verification','nextPhase','completed','checkpointVersion',8),at,at,root.request_id,root.command_id);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'final checkpoint event missing' USING ERRCODE='23514'; END IF;
  INSERT INTO identity.account_deletion_phase_receipts(deletion_record_id,completed_phase,from_checkpoint_version,next_phase,next_checkpoint_version,
    checklist_version,lease_owner,lease_generation,lease_expires_at,verified_at,audit_id,event_id)
  VALUES(deletion_id,'verification',7,'completed',8,root.checklist_version,worker,generation,job.lease_expires_at,at,audit,event);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'final checkpoint receipt missing' USING ERRCODE='23514'; END IF;
  UPDATE identity.account_deletion_records SET phase='completed',checkpoint_version=8,product_purged_at=at,completed_at=at,last_error_code=NULL WHERE id=deletion_id;
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'final checkpoint root update missing' USING ERRCODE='23514'; END IF;
  UPDATE identity.account_deletion_work SET phase='completed',checkpoint_version=8,available_at=at,
    lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE deletion_record_id=deletion_id;
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'final checkpoint work update missing' USING ERRCODE='23514'; END IF;
  RETURN QUERY SELECT 'completed'::text,8,false,NULL::text;
END $$;
