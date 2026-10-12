-- Code-owned operational event policy. No legal retention period or release
-- approval is supplied by this migration. Payload policy is parity-tested.
CREATE FUNCTION platform.deletion_event_policy() RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT $policy${"shapes":{"identity.telegram-identity-registered.v1":{"required":"userId accountState"},"telegram.start-route-requested.v1":{"required":"userId entryRoute uiLocale"},"identity.signup-started.v1":{"required":"userId currentStep draftVersion"},"identity.signup-step-saved.v1":{"required":"userId completedStep currentStep draftVersion"},"identity.locale-changed.v1":{"required":"userId uiLocale visibilityEnabled settingsVersion"},"identity.visibility-changed.v1":{"required":"userId uiLocale visibilityEnabled settingsVersion"},"identity.guest-preview-consumed.v1":{"required":"userId count limit remaining"},"identity.account-state-changed.v1":[{"required":"userId previousState nextState reasonCode accountVersion"},{"required":"userId profileId accountState"}],"profile.confirmed.v1":{"required":"userId profileId accountState"},"profile.updated.v1":{"required":"userId profileId version"},"profile.profile-completed.v1":{"required":"profileId"},"profile.profile-invalidated.v1":{"required":"profileId"},"profile.protected-change-requested.v1":{"required":"profileChangeRequestId userId field status"},"profile.protected-change-reviewed.v1":{"required":"profileChangeRequestId userId field decision profileVersion"},"discovery.filter-saved.v1":{"required":"userId version"},"discovery.candidate-reserved.v1":{"required":"deliveryId viewerUserId targetUserId mode filterVersion"},"discovery.candidate-delivered.v1":{"required":"deliveryId viewerUserId targetUserId mode"},"discovery.candidate-delivery-failed.v1":{"required":"deliveryId viewerUserId targetUserId mode reasonCode"},"discovery.consumption-created.v1":{"required":"viewerUserId targetUserId reason"},"interaction.like-created.v1":{"required":"likeId senderUserId receiverUserId notificationEligible","optional":"source"},"interaction.like-closed.v1":{"required":"reason","optional":"likeId likeIds matchId"},"interaction.not-interested-created.v1":{"required":"rejectionId senderUserId receiverUserId source"},"matching.match-created.v1":{"required":"matchId userLowId userHighId source","optional":"nakhId"},"matching.unmatched.v1":{"required":"matchId chatSessionId"},"telegram.liked-by-delivery-requested.v1":{"required":"deliveryId"},"notification.delivery-requested.v1":{"required":"notificationId deliveryId channel"},"chat.message-created.v1":{"required":"chatSessionId messageId messageType"},"chat.read-advanced.v1":{"required":"chatSessionId throughSequenceNumber"},"chat.mute-changed.v1":{"required":"chatSessionId muted version"},"nakh.flow-created.v1":{"required":"flowId senderUserId receiverUserId"},"nakh.pending-created.v1":{"required":"pendingNakhId senderUserId"},"nakh.pending-updated.v1":{"required":"pendingNakhId senderUserId"},"nakh.pending-reminder-requested.v1":{"required":"pendingNakhId reminderNumber"},"nakh.delivered.v1":{"required":"nakhId receiverUserId"},"nakh.cancelled.v1":{"required":"pendingNakhId senderUserId resolution"},"nakh.status-changed.v1":{"required":"status","optional":"nakhId pendingNakhId matchId"},"billing.payment-receipt-recorded.v1":{"required":"paymentRecordId"},"billing.payment-correction-required.v1":{"required":"paymentRecordId"},"billing.payment-fulfilled.v1":{"required":"paymentRecordId"},"billing.payment-corrected.v1":{"required":"paymentRecordId refundRecordId"},"billing.credit-increased.v1":{"required":"creditTransactionId amount balanceAfter"},"entitlement.feature-unlocked.v1":{"required":"featureUnlockId featureType"},"moderation.report-submitted.v1":{"required":"reportId evidenceTypes status"},"moderation.threshold-reached.v1":{"required":"restrictionEpisodeId targetUserId distinctReporterCount"},"moderation.review-decided.v1":{"required":"reviewId status version"},"moderation.appeal-changed.v1":{"required":"appealId status version"},"support.thread-changed.v1":{"required":"supportThreadId userId status version unansweredUserMessages"},"moderation.action-recorded.v1":{"required":"actionId actionType","optional":"targetUserId accountVersion restrictionEpisodeId photoId photoVersion profileVersion pairTargetId"},"moderation.internal-block-changed.v1":{"required":"actionId action pairTargetId pairVersion closedLikeCount revokedUnlockCount","optional":"closedMatchId closedChatSessionId"},"account.deletion-requested.v1":{"required":"deletionRecordId step"},"account.shared-scope-closed.v1":{"required":"deletionRecordId recipientUserId","optional":"matchId"},"account.deletion-phase-completed.v1":{"required":"deletionRecordId completedPhase nextPhase checkpointVersion"},"account.deletion-credit-epoch-prepared.v1":{"required":"deletionRecordId kind"},"account.deletion-product-batch.v1":{"required":"deletionRecordId resource rows auditId"},"account.deletion-operational-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-evidence-verified.v1":{"required":"deletionRecordId kind"},"account.deletion-profile-archived.v1":{"required":"deletionRecordId kind"},"account.deletion-photo-archived.v1":{"required":"deletionRecordId kind"},"account.deletion-match-archived.v1":{"required":"deletionRecordId kind"},"account.deletion-chat-archived.v1":{"required":"deletionRecordId kind final deletedCount"},"account.deletion-support-closed.v1":{"required":"deletionRecordId kind count"},"account.deletion-nakh-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-paid-pending-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-terminal-pending-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-flow-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-like-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-unlock-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-pair-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-notice-batch.v1":{"required":"deletionRecordId kind rows auditId"},"media.quarantine-uploaded.v1":{"required":"assetId bytes"},"media.ingestion-requested.v1":{"required":"assetId validationState"},"media.ingestion-rejected.v1":{"required":"assetId","optional":"errorCode validationState"},"media.asset-cleanup-completed.v1":{"required":"assetId deletionGeneration"},"media.photo-hidden.v1":{"required":"profileId photoId"},"media.photo-visible.v1":{"required":"profileId photoId"},"media.photo-deleted.v1":{"required":"profileId photoId"},"media.photo-primary-selected.v1":{"required":"profileId photoId"},"media.photos-reordered.v1":{"required":"profileId"},"media.photo-validated.v1":{"required":"assetId resultCode"},"media.validation-rejected.v1":{"required":"assetId resultCode"}},"machineValues":["guest","incomplete","active","restricted","banned","deleted","continue_signup","main","main_discovery_paused","fix_profile","ban_appeal","return_decision","age_confirmation","name","birth_year","gender","relationship_gender_preference","interests","location","relationship_goal","primary_photo","additional_photos","highlight","optional_details","confirm_profile","completed","pending","pending_payment","paid_and_sent","cancelled","expired","closed_by_system","sent","seen","accepted","rejected","closed","submitted","pending_review","dismissed","actioned","open","in_review","approved","explore","guest_preview","liked_by","like","not_interested","matched","reciprocal_likes","nakh","direct","pending_nakh","mutual_like","cancelled_pending_nakh","send_nakh","nakh_flow","converted_to_like","converted_to_not_interested","text","predefined_question","predefined_answer","system","chat","photo","profile","chat_unlock","liked_by_profile_unlock","telegram","restrict_user","ban_user","unrestrict_user","unban_user","hide_photo","restore_photo","delete_photo","create_internal_block","remove_internal_block","create","remove","shared_closure","evidence_capture","product_data","media_objects","ephemeral_access","retention_manifest","verification","credit_epoch","quarantined","validating","valid","invalid","uploaded","capture_integrity","profile_source","photo_source","chat_source","match_source","support_scope","nakh_source","paid_pending_source","terminal_pending_source","flow_source","like_source","unlock_source","pair_source","notice_source","outbox_cancel"],"booleanFields":["notificationEligible","muted","visibilityEnabled","final"],"quantityFields":["amount","balanceAfter","throughSequenceNumber","bytes"],"codeFields":["reasonCode","errorCode","resultCode"],"counterFields":["version","draftVersion","settingsVersion","accountVersion","filterVersion","photoVersion","profileVersion","pairVersion","checkpointVersion","count","limit","remaining","reminderNumber","distinctReporterCount","unansweredUserMessages","closedLikeCount","revokedUnlockCount","deletionGeneration","resource","rows","deletedCount"]}$policy$::jsonb
$fn$;

CREATE FUNCTION platform.deletion_event_field_minimal(field text,value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE policy jsonb:=platform.deletion_event_policy(); item jsonb; text_value text:=value#>>'{}';
BEGIN
  IF field LIKE '%Id' THEN RETURN jsonb_typeof(value)='string' AND text_value~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'; END IF;
  IF field IN('likeIds','evidenceTypes') THEN
    IF jsonb_typeof(value)<>'array' THEN RETURN false; END IF;
    IF jsonb_array_length(value)<1 OR jsonb_array_length(value)>(CASE WHEN field='likeIds' THEN 100 ELSE 4 END) THEN RETURN false; END IF;
    FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
      IF field='likeIds' THEN
        IF platform.deletion_event_field_minimal('likeId',item) IS NOT TRUE THEN RETURN false; END IF;
      ELSIF jsonb_typeof(item)<>'string' OR item#>>'{}' NOT IN('profile','photo','chat','unmatch') THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF (policy->'booleanFields')?field THEN RETURN jsonb_typeof(value)='boolean'; END IF;
  IF (policy->'quantityFields')?field THEN
    IF jsonb_typeof(value)='string' THEN RETURN text_value~'^(0|[1-9][0-9]{0,18})$'; END IF;
    IF jsonb_typeof(value)<>'number' THEN RETURN false; END IF;
    RETURN text_value::numeric=trunc(text_value::numeric) AND text_value::numeric BETWEEN 0 AND 9007199254740991;
  END IF;
  IF field='uiLocale' THEN RETURN jsonb_typeof(value)='string' AND text_value~'^[a-z]{2}(-[A-Z]{2})?$'; END IF;
  IF (policy->'codeFields')?field THEN RETURN jsonb_typeof(value)='string' AND text_value~'^[a-z][a-z0-9_]{0,79}$'; END IF;
  IF (policy->'counterFields')?field THEN
    IF jsonb_typeof(value)<>'number' THEN RETURN false; END IF;
    RETURN text_value::numeric=trunc(text_value::numeric) AND text_value::numeric BETWEEN 0 AND 2147483647;
  END IF;
  RETURN jsonb_typeof(value)='string' AND (policy->'machineValues')?text_value;
END $$;

CREATE FUNCTION platform.deletion_event_disposition(event_type text,version integer,payload jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE definition jsonb; alternative jsonb; field record; required text[]; allowed text[]; valid boolean;
BEGIN
  IF version IS DISTINCT FROM 1 OR jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN RETURN 'unclassified'; END IF;
  IF event_type='platform.sample-effect-created.v1' THEN RETURN 'ordinary_content'; END IF;
  definition:=platform.deletion_event_policy()->'shapes'->event_type;
  IF definition IS NULL THEN RETURN 'unclassified'; END IF;
  IF jsonb_typeof(definition)<>'array' THEN definition:=jsonb_build_array(definition); END IF;
  valid:=false;
  FOR alternative IN SELECT * FROM jsonb_array_elements(definition) LOOP
    required:=regexp_split_to_array(alternative->>'required',' +');
    allowed:=required||regexp_split_to_array(COALESCE(alternative->>'optional',''),' +');
    IF NOT payload?&required THEN CONTINUE; END IF;
    valid:=true;
    FOR field IN SELECT * FROM jsonb_each(payload) LOOP
      IF NOT field.key=ANY(allowed) OR platform.deletion_event_field_minimal(field.key,field.value) IS NOT TRUE THEN valid:=false; EXIT; END IF;
    END LOOP;
    IF valid THEN EXIT; END IF;
  END LOOP;
  IF NOT valid THEN RETURN 'unclassified'; END IF;
  IF event_type='nakh.status-changed.v1' AND (payload?'nakhId')::integer+(payload?'pendingNakhId')::integer<>1 THEN RETURN 'unclassified'; END IF;
  IF event_type='interaction.like-closed.v1' AND (payload?'likeId')::integer+(payload?'likeIds')::integer<>1 THEN RETURN 'unclassified'; END IF;
  IF event_type LIKE 'account.%' OR event_type='media.asset-cleanup-completed.v1'
    OR (event_type='telegram.start-route-requested.v1' AND payload->>'entryRoute'='return_decision') THEN RETURN 'lifecycle_proof'; END IF;
  IF event_type LIKE 'billing.%' OR event_type LIKE 'entitlement.%' THEN RETURN 'financial_proof'; END IF;
  IF event_type LIKE 'moderation.%' OR event_type LIKE 'support.%' THEN RETURN 'safety_proof'; END IF;
  RETURN 'product_transport';
END $$;

-- Original references survive ordinary source removal. This view resolves
-- ownership only; it never grants access to an old product life or evidence.
CREATE VIEW platform.deletion_original_subjects AS
  SELECT 'user'::text AS resource,id AS source_id,id AS user_id FROM identity.users
  UNION ALL SELECT 'account',user_id,user_id FROM identity.accounts
  UNION ALL SELECT 'credit_account',user_id,user_id FROM billing.credit_accounts
  UNION ALL SELECT 'explore_filter',user_id,user_id FROM discovery.explore_filters
  UNION ALL SELECT 'profile',id,user_id FROM profile.profile_reference_anchors
  UNION ALL SELECT 'profile_photo',photo.id,profile.user_id FROM media.photo_reference_anchors photo JOIN profile.profile_reference_anchors profile ON profile.id=photo.profile_id
  UNION ALL SELECT 'media_asset',photo.asset_id,profile.user_id FROM media.photo_reference_anchors photo JOIN profile.profile_reference_anchors profile ON profile.id=photo.profile_id
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
  UNION ALL SELECT 'sample_effect',id,actor_user_id FROM platform.sample_effects;

CREATE FUNCTION platform.deletion_event_owned(subject uuid,event platform.outbox_events)
RETURNS boolean LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM (VALUES('userId'),('senderUserId'),('receiverUserId'),('viewerUserId'),('targetUserId'),('userLowId'),('userHighId'),('recipientUserId')) field(key)
    WHERE lower(event.payload->>field.key)=subject::text) THEN RETURN true; END IF;
  IF event.aggregate_type IN('user','account','credit_account') AND event.aggregate_id=subject THEN RETURN true; END IF;
  RETURN EXISTS(SELECT 1 FROM platform.deletion_original_subjects original
      JOIN LATERAL (VALUES (event.aggregate_type,event.aggregate_id::text),
        ('profile',lower(event.payload->>'profileId')),('profile_photo',lower(event.payload->>'photoId')),
        ('media_asset',lower(event.payload->>'assetId')),('chat_session',lower(event.payload->>'chatSessionId')),
        ('match',lower(event.payload->>'matchId')),('like',lower(event.payload->>'likeId')),
        ('nakh_flow',lower(event.payload->>'flowId')),('nakh',lower(event.payload->>'nakhId')),
        ('pending_nakh',lower(event.payload->>'pendingNakhId')),('notification',lower(event.payload->>'notificationId')),
        ('account_deletion',lower(event.payload->>'deletionRecordId')),('sample_effect',lower(event.payload->>'effectId'))
      ) candidate(resource,id) ON original.resource=candidate.resource AND original.source_id::text=candidate.id
      WHERE original.user_id=subject)
    OR EXISTS(SELECT 1 FROM interaction.like_reference_anchors original WHERE subject IN(original.sender_user_id,original.receiver_user_id)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(event.payload->'likeIds')='array' THEN event.payload->'likeIds' ELSE '[]'::jsonb END) members(value) WHERE lower(members.value)=original.id::text));
END $$;

ALTER TABLE platform.outbox_events ADD COLUMN deletion_cancellation_audit_id uuid
  REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX outbox_deletion_cancellation_idx ON platform.outbox_events(deletion_cancellation_audit_id,id)
  WHERE deletion_cancellation_audit_id IS NOT NULL;

CREATE FUNCTION platform.deletion_event_digest(event platform.outbox_events) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object('id',event.id,'aggregateType',event.aggregate_type,
    'aggregateId',event.aggregate_id,'type',event.event_type,'version',event.schema_version,'payload',event.payload,
    'occurredAt',(extract(epoch FROM event.occurred_at)*1000000)::bigint,
    'availableAt',(extract(epoch FROM event.available_at)*1000000)::bigint,
    'publishedAt',(extract(epoch FROM event.published_at)*1000000)::bigint,
    'attemptCount',event.attempt_count,'lastErrorCode',event.last_error_code,
    'correlationId',event.correlation_id,'causationId',event.causation_id)::text,'UTF8')),'hex')
$$;

CREATE FUNCTION identity.operational_cancellation_fence(audit platform.audit_logs) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    WHERE root.id=audit.subject_id AND root.phase='product_data' AND root.checkpoint_version=3
      AND root.checklist_version=1 AND root.product_purged_at IS NULL AND root.completed_at IS NULL AND NOT root.reactivation_allowed
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
      AND work.lease_owner IS NOT NULL AND work.lease_expires_at>clock_timestamp()
      AND audit.occurred_at>=root.requested_at AND audit.occurred_at<=clock_timestamp()
      AND audit.category='account' AND audit.event_type='account.deletion-operational-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.result_code='outbox_cancelled' AND audit.metadata_schema_version=1
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id
      AND audit.metadata->>'kind'='outbox_cancel' AND jsonb_typeof(audit.metadata->'sourceHashes')='object'
      AND (audit.metadata->>'rows')::integer BETWEEN 1 AND 100
      AND audit.metadata=jsonb_build_object('kind','outbox_cancel','rows',(audit.metadata->>'rows')::integer,
        'sourceHashes',audit.metadata->'sourceHashes','eventId',(audit.metadata->>'eventId')::uuid,
        'owner',work.lease_owner,'generation',work.lease_generation,'leaseExpiresAt',work.lease_expires_at,
        'transaction',pg_current_xact_id()::text)
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      )
$$;

CREATE FUNCTION platform.guard_outbox_deletion_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit platform.audit_logs; subject uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.deletion_cancellation_audit_id IS NOT NULL THEN
      RAISE EXCEPTION 'new event cannot borrow a deletion cancellation' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.deletion_cancellation_audit_id IS NOT NULL THEN
      RAISE EXCEPTION 'cancelled operational proof requires controlled release' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.deletion_cancellation_audit_id IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'cancelled operational identity is immutable' USING ERRCODE='55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.deletion_cancellation_audit_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO audit FROM platform.audit_logs WHERE id=NEW.deletion_cancellation_audit_id;
  SELECT user_id INTO subject FROM identity.account_deletion_records WHERE id=audit.subject_id;
  IF audit.id IS NULL OR identity.operational_cancellation_fence(audit) IS NOT TRUE
    OR (to_jsonb(NEW)-'deletion_cancellation_audit_id'-'lease_owner'-'lease_expires_at')
       IS DISTINCT FROM (to_jsonb(OLD)-'deletion_cancellation_audit_id'-'lease_owner'-'lease_expires_at')
    OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR OLD.lease_expires_at>clock_timestamp()
    OR platform.deletion_event_disposition(OLD.event_type,OLD.schema_version,OLD.payload)<>'product_transport'
    OR platform.deletion_event_owned(subject,OLD) IS NOT TRUE
    OR audit.metadata->'sourceHashes'->>OLD.id::text IS DISTINCT FROM platform.deletion_event_digest(OLD) THEN
    RAISE EXCEPTION 'outbox cancellation lacks exact source and live owning transaction' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_deletion_cancellation_guard BEFORE INSERT OR UPDATE OR DELETE ON platform.outbox_events
  FOR EACH ROW EXECUTE FUNCTION platform.guard_outbox_deletion_cancellation();

CREATE FUNCTION identity.require_operational_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE removed integer; hashes jsonb; root identity.account_deletion_records;
BEGIN
  IF NEW.event_type<>'account.deletion-operational-batch.v1' THEN RETURN NULL; END IF;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=NEW.subject_id;
  SELECT count(*)::integer,COALESCE(jsonb_object_agg(event.id::text,platform.deletion_event_digest(event)),'{}'::jsonb)
    INTO removed,hashes FROM platform.outbox_events event WHERE event.deletion_cancellation_audit_id=NEW.id
      AND platform.deletion_event_disposition(event.event_type,event.schema_version,event.payload)='product_transport'
      AND platform.deletion_event_owned(root.user_id,event) AND event.lease_owner IS NULL AND event.lease_expires_at IS NULL;
  IF identity.operational_cancellation_fence(NEW) IS NOT TRUE
    OR identity.deletion_evidence_blocker(root.id,root.user_id) IS NOT NULL
    OR removed IS DISTINCT FROM (NEW.metadata->>'rows')::integer
    OR hashes IS DISTINCT FROM NEW.metadata->'sourceHashes'
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.id=(NEW.metadata->>'eventId')::uuid
      AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
      AND event.event_type=NEW.event_type AND event.schema_version=1 AND event.deletion_cancellation_audit_id IS NULL
      AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','outbox_cancel','rows',removed,'auditId',NEW.id)
      AND event.correlation_id=root.request_id AND event.causation_id=root.command_id
      AND event.occurred_at=NEW.occurred_at AND event.available_at=NEW.occurred_at) THEN
    RAISE EXCEPTION 'outbox cancellation or mandatory proof incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER operational_cancellation_required AFTER INSERT ON platform.audit_logs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_operational_cancellation();

CREATE FUNCTION platform.guard_post_product_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid; disposition text;
BEGIN
  disposition:=platform.deletion_event_disposition(NEW.event_type,NEW.schema_version,NEW.payload);
  IF disposition IN('financial_proof','safety_proof','lifecycle_proof') THEN RETURN NEW; END IF;
  FOR subject IN SELECT DISTINCT account.user_id FROM identity.accounts account JOIN (
    SELECT CASE WHEN NEW.payload->>field.key~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN (NEW.payload->>field.key)::uuid END AS user_id
      FROM (VALUES('userId'),('senderUserId'),('receiverUserId'),('viewerUserId'),('targetUserId'),('userLowId'),('userHighId'),('recipientUserId')) field(key)
    UNION SELECT NEW.aggregate_id WHERE NEW.aggregate_type IN('user','account','credit_account')
    UNION SELECT original.user_id FROM platform.deletion_original_subjects original
      JOIN LATERAL(VALUES(NEW.aggregate_type,NEW.aggregate_id::text),('profile',NEW.payload->>'profileId'),('profile_photo',NEW.payload->>'photoId'),
        ('media_asset',NEW.payload->>'assetId'),('chat_session',NEW.payload->>'chatSessionId'),('match',NEW.payload->>'matchId'),
        ('like',NEW.payload->>'likeId'),('nakh_flow',NEW.payload->>'flowId'),('nakh',NEW.payload->>'nakhId'),
        ('pending_nakh',NEW.payload->>'pendingNakhId'),('notification',NEW.payload->>'notificationId'),
        ('account_deletion',NEW.payload->>'deletionRecordId'),('sample_effect',NEW.payload->>'effectId')) candidate(resource,id)
        ON original.resource=candidate.resource AND original.source_id=CASE WHEN candidate.id~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN candidate.id::uuid END
    UNION SELECT original.sender_user_id FROM interaction.like_reference_anchors original
      JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(NEW.payload->'likeIds')='array' THEN NEW.payload->'likeIds' ELSE '[]'::jsonb END) member(value)
        ON original.id=CASE WHEN member.value~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN member.value::uuid END
    UNION SELECT original.receiver_user_id FROM interaction.like_reference_anchors original
      JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(NEW.payload->'likeIds')='array' THEN NEW.payload->'likeIds' ELSE '[]'::jsonb END) member(value)
        ON original.id=CASE WHEN member.value~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN member.value::uuid END
    ) owner ON owner.user_id=account.user_id ORDER BY account.user_id
  LOOP
    PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
    IF EXISTS(SELECT 1 FROM identity.accounts account JOIN identity.account_deletion_records root
      ON root.user_id=account.user_id AND root.product_epoch=account.product_epoch
      WHERE account.user_id=subject AND account.state='deleted' AND root.checkpoint_version>=4) THEN
      RAISE EXCEPTION 'ordinary event cannot reopen a verified product life' USING ERRCODE='40001'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_post_product_guard BEFORE INSERT ON platform.outbox_events
  FOR EACH ROW EXECUTE FUNCTION platform.guard_post_product_event();

-- Historical authenticity survives worker expiry and later checkpoints. It
-- never authorizes another update, publish, retained-data release or return.
CREATE FUNCTION platform.deletion_cancellation_audit_valid(audit_id uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM platform.audit_logs audit
    JOIN identity.account_deletion_records root ON root.id=audit.subject_id
    CROSS JOIN LATERAL(SELECT count(*)::integer AS rows,
      jsonb_object_agg(source.id::text,platform.deletion_event_digest(source)) AS hashes,
      bool_and(source.lease_owner IS NULL AND source.lease_expires_at IS NULL
        AND platform.deletion_event_owned(root.user_id,source)) AS valid
      FROM platform.outbox_events source WHERE source.deletion_cancellation_audit_id=audit.id) actual
    WHERE audit.id=$1
      AND audit.category='account' AND audit.event_type='account.deletion-operational-batch.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.result_code='outbox_cancelled' AND audit.metadata_schema_version=1
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at>=root.requested_at
      AND audit.occurred_at<(audit.metadata->>'leaseExpiresAt')::timestamptz
      AND (audit.metadata->>'generation')::integer>=1
      AND audit.metadata->>'transaction'~'^[1-9][0-9]{0,19}$'
      AND audit.metadata=jsonb_build_object('kind','outbox_cancel','rows',(audit.metadata->>'rows')::integer,
        'sourceHashes',audit.metadata->'sourceHashes','eventId',(audit.metadata->>'eventId')::uuid,
        'owner',(audit.metadata->>'owner')::uuid,'generation',(audit.metadata->>'generation')::integer,
        'leaseExpiresAt',audit.metadata->'leaseExpiresAt','transaction',audit.metadata->>'transaction')
      AND (audit.metadata->>'rows')::integer BETWEEN 1 AND 100
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts phase WHERE phase.deletion_record_id=root.id
        AND phase.completed_phase='evidence_capture' AND phase.next_phase='product_data'
        AND phase.from_checkpoint_version=2 AND phase.next_checkpoint_version=3)
      AND actual.valid IS TRUE AND actual.hashes=audit.metadata->'sourceHashes'
      AND actual.rows=(audit.metadata->>'rows')::integer)
$$;

CREATE FUNCTION platform.deletion_event_cancellation_valid(event platform.outbox_events) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT event.deletion_cancellation_audit_id IS NOT NULL
    AND platform.deletion_cancellation_audit_valid(event.deletion_cancellation_audit_id)
    AND EXISTS(SELECT 1 FROM platform.audit_logs audit WHERE audit.id=event.deletion_cancellation_audit_id
      AND audit.metadata->'sourceHashes'->>event.id::text=platform.deletion_event_digest(event))
$$;
