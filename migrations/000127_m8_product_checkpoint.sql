-- Only verified product_data/3 -> media_objects/4. Media/provider absence,
-- ephemeral invalidation, manifests, completion and fresh Return are still required.
CREATE FUNCTION platform.deletion_operational_metadata_minimal(data jsonb,allowed text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE field record; member record; text_value text;
BEGIN
  IF jsonb_typeof(data) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  FOR field IN SELECT * FROM jsonb_each(data) LOOP
    IF NOT field.key=ANY(allowed) THEN RETURN false; END IF;
    IF field.key='sourceHashes' THEN
      IF jsonb_typeof(field.value)<>'object' THEN RETURN false; END IF;
      FOR member IN SELECT * FROM jsonb_each(field.value) LOOP
        IF member.key!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          OR jsonb_typeof(member.value)<>'string' OR member.value#>>'{}'!~'^[0-9a-f]{64}$' THEN RETURN false; END IF;
      END LOOP;
    ELSIF jsonb_typeof(field.value)='number' THEN
      IF (field.value#>>'{}')::numeric<>trunc((field.value#>>'{}')::numeric)
        OR abs((field.value#>>'{}')::numeric)>9007199254740991 THEN RETURN false; END IF;
    ELSIF jsonb_typeof(field.value)='boolean' THEN CONTINUE;
    ELSIF jsonb_typeof(field.value)='string' THEN
      text_value:=field.value#>>'{}';
      IF field.key IN('fields') THEN
        IF length(text_value)>256 OR text_value!~'^[a-z_]+(,[a-z_]+)*$' THEN RETURN false; END IF;
      ELSIF field.key IN('leaseExpiresAt') THEN
        IF text_value!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false; END IF;
      ELSIF field.key IN('operatorId','keyId') THEN
        IF text_value!~'^[a-zA-Z0-9_-]{1,80}$' THEN RETURN false; END IF;
      ELSIF text_value!~'^[a-z][a-z0-9_]{0,79}$' AND text_value!~'^[0-9a-f]{64}$'
        AND text_value!~'^[0-9]{1,20}$'
        AND text_value!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false; END IF;
    ELSE RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION identity.guard_verified_product_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document jsonb:=to_jsonb(NEW); subject uuid;
BEGIN
  -- A blocked pair is retained safety state, not reopened ordinary interaction.
  IF TG_TABLE_SCHEMA='interaction' AND TG_TABLE_NAME='user_pair_states' AND document->>'state'='blocked' THEN RETURN NEW; END IF;
  FOR subject IN SELECT DISTINCT account.user_id FROM identity.accounts account JOIN (
    SELECT (document->>field.key)::uuid AS user_id FROM (VALUES('user_id'),('viewer_user_id'),('target_user_id'),('sender_user_id'),('receiver_user_id'),
      ('payer_user_id'),('actor_user_id'),('user_low_id'),('user_high_id')) field(key) WHERE document->>field.key IS NOT NULL
    UNION SELECT original.user_id FROM platform.deletion_original_subjects original
      JOIN LATERAL(VALUES('profile',(document->>'profile_id')::uuid),('chat_session',(document->>'chat_session_id')::uuid),
        ('match',(document->>'match_id')::uuid),('nakh',(document->>'nakh_id')::uuid),('nakh_flow',(document->>'nakh_flow_id')::uuid))
        parent(resource,id) ON original.resource=parent.resource AND original.source_id=parent.id
    ) owner ON owner.user_id=account.user_id ORDER BY account.user_id
  LOOP
    PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
    IF EXISTS(SELECT 1 FROM identity.accounts account JOIN identity.account_deletion_records root
      ON root.user_id=account.user_id AND root.product_epoch=account.product_epoch
      WHERE account.user_id=subject AND account.state='deleted' AND root.checkpoint_version>=4) THEN
      RAISE EXCEPTION 'ordinary write cannot reopen verified product data' USING ERRCODE='40001'; END IF;
  END LOOP;
  RETURN NEW;
END $$;

DO $$ DECLARE target record; BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('identity','signup_drafts'),('identity','signup_progress'),('identity','user_settings'),
    ('profile','profiles'),('profile','profile_optional_details'),('profile','profile_interests'),
    ('profile','profile_languages'),('profile','profile_personality_tags'),
    ('discovery','explore_filters'),('discovery','explore_filter_genders'),('discovery','candidate_deliveries'),
    ('discovery','explore_consumptions'),('interaction','likes'),('interaction','not_interested'),('interaction','user_pair_states'),
    ('matching','matches'),('matching','match_participants'),('chat','chat_sessions'),('chat','chat_participants'),
    ('chat','chat_messages'),('chat','chat_cleanup_checkpoints'),('nakh','nakh_flows'),('nakh','pending_nakhes'),
    ('nakh','nakhes'),('nakh','nakh_receiver_actions'),('nakh','nakh_status_history'),('notification','notification_preferences')) tables(schema_name,table_name)
  LOOP
    EXECUTE format('CREATE TRIGGER verified_product_write_guard BEFORE INSERT OR UPDATE ON %I.%I FOR EACH ROW EXECUTE FUNCTION identity.guard_verified_product_write()',target.schema_name,target.table_name);
  END LOOP;
END $$;

CREATE FUNCTION platform.deletion_operational_blocker(subject uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT
  EXISTS(SELECT 1 FROM platform.audit_logs audit WHERE (audit.actor_user_id=subject
    OR (audit.subject_type IN('user','account') AND audit.subject_id=subject)
    OR EXISTS(SELECT 1 FROM platform.deletion_original_subjects original
      WHERE original.user_id=subject AND original.resource=audit.subject_type AND original.source_id=audit.subject_id))
    AND (audit.metadata_schema_version<>1 OR platform.deletion_operational_metadata_minimal(audit.metadata,ARRAY[
      'action','actionType','channel','closedChat','closedLikeCount','closedMatch','completedStep','completionStatus',
      'consumptionCreated','count','currentStep','decision','deletionGeneration','distinctReporterCount','evidenceDigest',
      'field','fields','genderCount','limit','mode','nakhId','nextStep','observedOutcome','operatorId','outcome','pendingNakhId',
      'reasonCode','receiverUserId','requestDigest','resolution','revokedUnlockCount','source','status','targetUserId',
      'unansweredUserMessages','validationState','version','kind','rows','receiptDigest','phase','checkpointVersion',
      'resource','eventId','owner','generation','leaseExpiresAt','transaction','sourceHashes','final','deletedCount',
      'chats','matches','likes','pairs','unlocks','pendingNakhes','nakhes','photoId','profileId','targetVersion',
      'schemaVersion','keyVersion','keyId','resultCode']) IS NOT TRUE))
  OR EXISTS(SELECT 1 FROM platform.inbox_messages WHERE payload_hash!~'^[0-9a-f]{64}$'
    OR consumer!~'^[a-z][a-z0-9_.-]{0,99}$'
    OR (result_code IS NOT NULL AND result_code!~'^[a-z][a-z0-9_]{0,79}$'))
  OR EXISTS(SELECT 1 FROM platform.scheduled_jobs WHERE job_type!~'^[a-z][a-z0-9_.-]{0,99}$' OR schedule_config<>'{}'::jsonb)
  OR EXISTS(SELECT 1 FROM platform.job_run_logs WHERE metadata<>'{}'::jsonb OR run_key!~'^[a-zA-Z0-9_.:-]{1,160}$'
    OR (error_code IS NOT NULL AND error_code!~'^[a-z][a-z0-9_]{0,79}$'))
  OR EXISTS(SELECT 1 FROM billing.reconciliation_anomalies WHERE platform.deletion_operational_metadata_minimal(safe_detail,
    ARRAY['status','providerProgress','errorCode','fulfillmentState','leaseState']) IS NOT TRUE)
  OR EXISTS(SELECT 1 FROM billing.reconciliation_runs WHERE platform.deletion_operational_metadata_minimal(cursor,
    ARRAY['phase','lastId','complete']) IS NOT TRUE)
$$;

CREATE FUNCTION identity.deletion_product_selectors() RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$ SELECT $selectors$[{"table":"chat.chat_cleanup_checkpoints","predicate":"EXISTS (SELECT 1 FROM chat.chat_reference_anchors session JOIN matching.match_reference_anchors governing ON governing.id=session.match_id WHERE session.id=row.chat_session_id AND $1 IN (governing.user_low_id,governing.user_high_id))"},{"table":"chat.chat_messages","predicate":"EXISTS (SELECT 1 FROM chat.chat_reference_anchors session JOIN matching.match_reference_anchors governing ON governing.id=session.match_id WHERE session.id=row.chat_session_id AND $1 IN (governing.user_low_id,governing.user_high_id))"},{"table":"chat.chat_participants","predicate":"EXISTS (SELECT 1 FROM chat.chat_reference_anchors session JOIN matching.match_reference_anchors governing ON governing.id=session.match_id WHERE session.id=row.chat_session_id AND $1 IN (governing.user_low_id,governing.user_high_id))"},{"table":"chat.chat_sessions","predicate":"EXISTS (SELECT 1 FROM matching.match_reference_anchors governing WHERE governing.id=row.match_id AND $1 IN (governing.user_low_id,governing.user_high_id))"},{"table":"discovery.candidate_deliveries","predicate":"$1 IN (row.viewer_user_id,row.target_user_id)"},{"table":"discovery.explore_consumptions","predicate":"$1 IN (row.viewer_user_id,row.target_user_id)"},{"table":"discovery.explore_filter_genders","predicate":"row.user_id=$1"},{"table":"discovery.explore_filters","predicate":"row.user_id=$1"},{"table":"identity.signup_drafts","predicate":"row.user_id=$1"},{"table":"identity.signup_progress","predicate":"row.user_id=$1"},{"table":"identity.user_settings","predicate":"row.user_id=$1"},{"table":"interaction.likes","predicate":"$1 IN (row.sender_user_id,row.receiver_user_id)"},{"table":"interaction.not_interested","predicate":"$1 IN (row.sender_user_id,row.receiver_user_id)"},{"table":"interaction.user_pair_states","predicate":"$1 IN (row.user_low_id,row.user_high_id) AND row.state<>'blocked'"},{"table":"matching.match_participants","predicate":"EXISTS (SELECT 1 FROM matching.match_reference_anchors governing WHERE governing.id=row.match_id AND $1 IN (governing.user_low_id,governing.user_high_id))"},{"table":"matching.matches","predicate":"$1 IN (row.user_low_id,row.user_high_id)"},{"table":"nakh.nakh_flows","predicate":"$1 IN (row.sender_user_id,row.receiver_user_id)"},{"table":"nakh.nakh_receiver_actions","predicate":"EXISTS (SELECT 1 FROM nakh.nakh_reference_anchors governing WHERE governing.id=row.nakh_id AND $1 IN (governing.sender_user_id,governing.receiver_user_id))"},{"table":"nakh.nakh_status_history","predicate":"EXISTS (SELECT 1 FROM nakh.nakh_reference_anchors governing WHERE governing.id=row.nakh_id AND $1 IN (governing.sender_user_id,governing.receiver_user_id))"},{"table":"nakh.nakhes","predicate":"$1 IN (row.sender_user_id,row.receiver_user_id)"},{"table":"nakh.pending_nakhes","predicate":"row.sender_user_id=$1 OR EXISTS (SELECT 1 FROM nakh.flow_reference_anchors governing WHERE governing.id=row.nakh_flow_id AND $1 IN (governing.sender_user_id,governing.receiver_user_id))"},{"table":"notification.notification_preferences","predicate":"row.user_id=$1"},{"table":"profile.profile_interests","predicate":"EXISTS (SELECT 1 FROM profile.profile_reference_anchors governing WHERE governing.id=row.profile_id AND governing.user_id=$1)"},{"table":"profile.profile_languages","predicate":"EXISTS (SELECT 1 FROM profile.profile_reference_anchors governing WHERE governing.id=row.profile_id AND governing.user_id=$1)"},{"table":"profile.profile_optional_details","predicate":"EXISTS (SELECT 1 FROM profile.profile_reference_anchors governing WHERE governing.id=row.profile_id AND governing.user_id=$1)"},{"table":"profile.profile_personality_tags","predicate":"EXISTS (SELECT 1 FROM profile.profile_reference_anchors governing WHERE governing.id=row.profile_id AND governing.user_id=$1)"},{"table":"profile.profiles","predicate":"row.user_id=$1"},{"table":"interaction.feature_unlocks","predicate":"row.payer_user_id=$1"},{"table":"notification.notifications","predicate":"row.user_id=$1"},{"table":"media.delivery_grants","predicate":"$1 IN(row.actor_user_id,row.owner_user_id)"},{"table":"platform.idempotency_records","predicate":"row.actor_user_id=$1 OR (row.scope='identity.register-telegram-identity' AND row.response_json#>>'{context,userId}'=$1::text)"},{"table":"platform.sample_effects","predicate":"row.actor_user_id=$1"},{"table":"platform.sample_projections","predicate":"EXISTS(SELECT 1 FROM platform.sample_effects parent WHERE parent.id=row.effect_id AND parent.actor_user_id=$1)"}]$selectors$::jsonb $fn$;

CREATE FUNCTION billing.deletion_credit_cutover_valid(root_id uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM billing.credit_epoch_closures receipt
    JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    JOIN billing.credit_epoch_accounts previous ON previous.user_id=receipt.user_id AND previous.product_epoch=receipt.product_epoch
    JOIN billing.credit_epoch_accounts next_epoch ON next_epoch.user_id=receipt.user_id AND next_epoch.product_epoch=receipt.next_product_epoch
    JOIN billing.credit_accounts current_account ON current_account.user_id=receipt.user_id
    JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
    WHERE root.id=root_id AND receipt.user_id=root.user_id AND receipt.product_epoch=root.product_epoch
      AND receipt.next_product_epoch=receipt.product_epoch+1 AND receipt.prepared_at>=root.requested_at
      AND receipt.prepared_at<receipt.lease_expires_at
      AND previous.balance=receipt.balance AND previous.version=receipt.account_version
      AND previous.created_at=receipt.projection_created_at AND previous.updated_at=receipt.projection_updated_at
      AND next_epoch.balance=0 AND next_epoch.version=1 AND next_epoch.created_at=receipt.projection_created_at AND next_epoch.updated_at=receipt.prepared_at
      AND current_account.product_epoch=receipt.next_product_epoch AND current_account.balance=0 AND current_account.version=1
      AND current_account.created_at=receipt.projection_created_at AND current_account.updated_at=receipt.prepared_at
      AND audit.category='account' AND audit.event_type='account.deletion-credit-epoch-prepared.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='credit_epoch_prepared'
      AND audit.metadata_schema_version=1 AND audit.metadata='{"kind":"credit_epoch"}'::jsonb
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=receipt.prepared_at
      AND NOT EXISTS(SELECT 1 FROM billing.credit_transactions WHERE credit_account_id=root.user_id AND product_epoch=receipt.next_product_epoch))
$$;

CREATE FUNCTION identity.deletion_pair_proofs_valid(root_id uuid,subject uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root WHERE root.id=root_id AND root.user_id=subject
    AND NOT EXISTS(SELECT 1 FROM matching.match_reference_anchors anchor
      WHERE ((anchor.user_low_id=subject AND anchor.low_product_epoch=root.product_epoch)
        OR (anchor.user_high_id=subject AND anchor.high_product_epoch=root.product_epoch))
      AND NOT EXISTS(SELECT 1 FROM interaction.user_pair_states retained
        WHERE retained.user_low_id=anchor.user_low_id AND retained.user_high_id=anchor.user_high_id AND retained.state='blocked')
      AND (interaction.pair_source_archivable(anchor.id) IS NOT TRUE
        OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_pair_receipts proof
          WHERE proof.match_id=anchor.id AND identity.pair_receipt_proof_valid(proof))))
    AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_pair_receipts proof
      JOIN identity.account_deletion_records owner ON owner.id=proof.deletion_record_id
      WHERE owner.user_id=subject AND identity.pair_receipt_proof_valid(proof) IS NOT TRUE))
$$;

CREATE FUNCTION identity.deletion_product_blocker(root_id uuid,subject uuid) RETURNS text
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

ALTER TABLE identity.account_deletion_phase_receipts DROP CONSTRAINT deletion_phase_receipt_transition_check,
  ADD CONSTRAINT deletion_phase_receipt_transition_check CHECK(
    (completed_phase='shared_closure' AND from_checkpoint_version=1 AND next_phase='evidence_capture' AND next_checkpoint_version=2)
    OR (completed_phase='evidence_capture' AND from_checkpoint_version=2 AND next_phase='product_data' AND next_checkpoint_version=3)
    OR (completed_phase='product_data' AND from_checkpoint_version=3 AND next_phase='media_objects' AND next_checkpoint_version=4));
CREATE OR REPLACE FUNCTION identity.guard_deletion_phase_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'deletion phase receipt requires controlled release' USING ERRCODE='55000';
  END IF;
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
        OR (NEW.completed_phase='product_data' AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=record.id AND prior.completed_phase='evidence_capture')))
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
      OR (OLD.phase='product_data' AND NEW.phase='media_objects' AND OLD.checkpoint_version=3 AND NEW.checkpoint_version=4))
    OR NOT EXISTS (SELECT 1 FROM identity.account_deletion_phase_receipts receipt
      WHERE receipt.deletion_record_id=NEW.id AND receipt.completed_phase=OLD.phase
        AND receipt.next_phase=NEW.phase AND receipt.from_checkpoint_version=OLD.checkpoint_version
        AND receipt.next_checkpoint_version=NEW.checkpoint_version
        AND ((OLD.phase='shared_closure' AND NEW.shared_closed_at=receipt.verified_at)
          OR (OLD.phase IN('evidence_capture','product_data') AND NEW.shared_closed_at IS NOT DISTINCT FROM OLD.shared_closed_at))) THEN
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
      OR (OLD.phase='product_data' AND NEW.phase='media_objects' AND OLD.checkpoint_version=3 AND NEW.checkpoint_version=4))
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


CREATE FUNCTION identity.finish_deletion_product_phase(deletion_id uuid, subject uuid, worker uuid, generation integer, checkpoint integer)
RETURNS TABLE(phase text, checkpoint_version integer, replayed boolean, waiting_for text) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work;
  receipt identity.account_deletion_phase_receipts; at timestamptz; audit uuid; event uuid; blocker text; writes integer;
BEGIN
  IF deletion_id IS NULL OR subject IS NULL OR worker IS NULL OR generation IS NULL OR generation<1 OR checkpoint IS DISTINCT FROM 3 THEN
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
  SELECT * INTO receipt FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=deletion_id AND completed_phase='product_data';
  IF FOUND THEN
    IF receipt.lease_owner<>worker OR receipt.lease_generation<>generation OR receipt.from_checkpoint_version<>checkpoint THEN
      RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
    END IF;
    RETURN QUERY SELECT receipt.next_phase,receipt.next_checkpoint_version,true,NULL::text; RETURN;
  END IF;
  at:=clock_timestamp();
  IF root.phase<>'product_data' OR root.checkpoint_version<>3 OR checkpoint<>3
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS DISTINCT FROM worker OR job.lease_generation<>generation OR job.lease_expires_at IS NULL OR job.lease_expires_at<=at
    OR NOT EXISTS (SELECT 1 FROM platform.user_counters WHERE user_id=subject AND pending_nakh_count=0)
    OR identity.deletion_has_open_shared_scopes(subject) THEN
    RAISE EXCEPTION 'deletion work conflict' USING ERRCODE='40001';
  END IF;
  blocker:=identity.deletion_product_blocker(deletion_id,subject);
  IF blocker IS NOT NULL THEN RETURN QUERY SELECT 'product_data'::text,3,false,blocker; RETURN; END IF;
  audit:=gen_random_uuid(); event:=gen_random_uuid();
  INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,
    metadata_schema_version,metadata,command_id,request_id,occurred_at)
  VALUES(audit,'account','account.deletion-phase-completed.v1','system',NULL,NULL,'account_deletion',deletion_id,'phase_completed',1,
    jsonb_build_object('phase','product_data','checkpointVersion',3),root.command_id,root.request_id,at);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'product checkpoint audit missing' USING ERRCODE='23514'; END IF;
  INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,correlation_id,causation_id)
  VALUES(event,'account_deletion',deletion_id,'account.deletion-phase-completed.v1',1,
    jsonb_build_object('deletionRecordId',deletion_id,'completedPhase','product_data','nextPhase','media_objects','checkpointVersion',4),at,at,root.request_id,root.command_id);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'product checkpoint event missing' USING ERRCODE='23514'; END IF;
  INSERT INTO identity.account_deletion_phase_receipts(deletion_record_id,completed_phase,from_checkpoint_version,next_phase,next_checkpoint_version,
    checklist_version,lease_owner,lease_generation,lease_expires_at,verified_at,audit_id,event_id)
  VALUES(deletion_id,'product_data',3,'media_objects',4,root.checklist_version,worker,generation,job.lease_expires_at,at,audit,event);
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'product checkpoint receipt missing' USING ERRCODE='23514'; END IF;
  UPDATE identity.account_deletion_records SET phase='media_objects',checkpoint_version=4,last_error_code=NULL WHERE id=deletion_id;
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'product checkpoint root update missing' USING ERRCODE='23514'; END IF;
  UPDATE identity.account_deletion_work SET phase='media_objects',checkpoint_version=4,available_at=at,
    lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL WHERE deletion_record_id=deletion_id;
  GET DIAGNOSTICS writes=ROW_COUNT; IF writes<>1 THEN RAISE EXCEPTION 'product checkpoint work update missing' USING ERRCODE='23514'; END IF;
  RETURN QUERY SELECT 'media_objects'::text,4,false,NULL::text;
END $$;
