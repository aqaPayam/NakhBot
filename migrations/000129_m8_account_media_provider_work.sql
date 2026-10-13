-- Provider work is internal. No retained-data release, phase completion or Return.
-- Return has never been enabled: existing media can only belong to epoch zero.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM media.media_assets asset JOIN identity.accounts account ON account.user_id=asset.owner_user_id
    WHERE account.product_epoch<>0) THEN RAISE EXCEPTION 'legacy media life is unproven' USING ERRCODE='23514'; END IF;
END $$;
CREATE TABLE media.asset_reference_anchors (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  product_epoch integer NOT NULL CHECK(product_epoch>=0)
);
CREATE INDEX asset_reference_owner_life_idx ON media.asset_reference_anchors(owner_user_id,product_epoch,id);
CREATE TABLE media.variant_reference_anchors (
  id uuid PRIMARY KEY,
  asset_id uuid NOT NULL REFERENCES media.asset_reference_anchors(id) ON DELETE RESTRICT,
  variant_type text NOT NULL CHECK(variant_type IN('thumbnail','blurred_preview')),
  transformation_version integer NOT NULL CHECK(transformation_version>0),
  sha256 bytea NOT NULL CHECK(octet_length(sha256)=32),
  UNIQUE(asset_id,variant_type,transformation_version)
);
INSERT INTO media.asset_reference_anchors SELECT id,owner_user_id,0 FROM media.media_assets;
INSERT INTO media.variant_reference_anchors SELECT id,asset_id,variant_type,transformation_version,sha256 FROM media.photo_variants;
CREATE FUNCTION media.guard_asset_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM media.media_assets source WHERE source.id=NEW.id AND source.owner_user_id=NEW.owner_user_id)
    OR NEW.product_epoch IS DISTINCT FROM COALESCE((SELECT product_epoch FROM identity.accounts WHERE user_id=NEW.owner_user_id),0) THEN
    RAISE EXCEPTION 'media reference lacks exact original source' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER asset_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON media.asset_reference_anchors
 FOR EACH ROW EXECUTE FUNCTION media.guard_asset_reference();
CREATE FUNCTION media.capture_asset_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO media.asset_reference_anchors VALUES(NEW.id,NEW.owner_user_id,COALESCE((SELECT product_epoch FROM identity.accounts WHERE user_id=NEW.owner_user_id),0));
  RETURN NULL;
END $$;
CREATE TRIGGER asset_reference_capture AFTER INSERT ON media.media_assets FOR EACH ROW EXECUTE FUNCTION media.capture_asset_reference();
CREATE FUNCTION media.guard_variant_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR NOT EXISTS(SELECT 1 FROM media.photo_variants source WHERE source.id=NEW.id
    AND source.asset_id=NEW.asset_id AND source.variant_type=NEW.variant_type
    AND source.transformation_version=NEW.transformation_version AND source.sha256=NEW.sha256) THEN
    RAISE EXCEPTION 'variant reference lacks exact original source' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER variant_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON media.variant_reference_anchors
 FOR EACH ROW EXECUTE FUNCTION media.guard_variant_reference();
CREATE FUNCTION media.capture_variant_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO media.variant_reference_anchors VALUES(NEW.id,NEW.asset_id,NEW.variant_type,NEW.transformation_version,NEW.sha256);
  RETURN NULL;
END $$;
CREATE TRIGGER variant_reference_capture AFTER INSERT ON media.photo_variants FOR EACH ROW EXECUTE FUNCTION media.capture_variant_reference();
CREATE FUNCTION media.guard_original_asset_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM media.asset_reference_anchors WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'retired media identity cannot be reused' USING ERRCODE='23514'; END IF;
  PERFORM id FROM identity.users WHERE id=NEW.owner_user_id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id=NEW.owner_user_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=NEW.owner_user_id AND state='deleted') THEN
    RAISE EXCEPTION 'deleted owner cannot create media' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_original_asset_birth BEFORE INSERT ON media.media_assets FOR EACH ROW EXECUTE FUNCTION media.guard_original_asset_birth();
CREATE FUNCTION media.guard_original_variant_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM media.variant_reference_anchors WHERE id=NEW.id)
    OR NOT EXISTS(SELECT 1 FROM media.media_assets asset WHERE asset.id=NEW.asset_id AND asset.deleted_at IS NULL AND asset.storage_deleted_at IS NULL) THEN
    RAISE EXCEPTION 'variant source is retired' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_original_variant_birth BEFORE INSERT ON media.photo_variants FOR EACH ROW EXECUTE FUNCTION media.guard_original_variant_birth();

CREATE TABLE identity.account_deletion_media_operations (
  id uuid PRIMARY KEY,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES media.asset_reference_anchors(id) ON DELETE RESTRICT,
  environment text NOT NULL CHECK(environment IN('development','test','staging','production')),
  kind text NOT NULL CHECK(kind IN('retain_photo','delete_public')),
  evidence_id uuid REFERENCES moderation.report_evidence(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES media.variant_reference_anchors(id) ON DELETE RESTRICT,
  key_role text CHECK(key_role IN('quarantine','validated','variant','scope')),
  prepared_at timestamptz NOT NULL,
  verified_at timestamptz,
  verified_bytes integer CHECK(verified_bytes BETWEEN 1 AND 10485760),
  verified_sha256 text CHECK(verified_sha256~'^[0-9a-f]{64}$'),
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  verification_transaction xid8,
  audit_id uuid REFERENCES platform.audit_logs(id) ON DELETE RESTRICT,
  event_id uuid REFERENCES platform.outbox_events(id) ON DELETE RESTRICT,
  CHECK((kind='retain_photo' AND evidence_id IS NOT NULL AND variant_id IS NOT NULL AND key_role IS NULL)
    OR (kind='delete_public' AND evidence_id IS NULL AND key_role IS NOT NULL AND ((key_role='variant')=(variant_id IS NOT NULL)))),
  CHECK((verified_at IS NULL AND verified_bytes IS NULL AND verified_sha256 IS NULL AND audit_id IS NULL AND event_id IS NULL AND verification_transaction IS NULL)
    OR (verified_at IS NOT NULL AND audit_id IS NOT NULL AND event_id IS NOT NULL AND verification_transaction IS NOT NULL
      AND ((kind='retain_photo' AND verified_bytes IS NOT NULL AND verified_sha256 IS NOT NULL)
        OR (kind='delete_public' AND verified_bytes IS NULL AND verified_sha256 IS NULL))))
);
CREATE UNIQUE INDEX deletion_media_copy_uq ON identity.account_deletion_media_operations(evidence_id) WHERE kind='retain_photo';
CREATE UNIQUE INDEX deletion_media_original_uq ON identity.account_deletion_media_operations(deletion_record_id,asset_id,key_role) WHERE kind='delete_public' AND key_role<>'variant';
CREATE UNIQUE INDEX deletion_media_variant_uq ON identity.account_deletion_media_operations(deletion_record_id,variant_id) WHERE kind='delete_public' AND key_role='variant';
CREATE INDEX deletion_media_root_pending_idx ON identity.account_deletion_media_operations(deletion_record_id,prepared_at,id) WHERE verified_at IS NULL;

ALTER TABLE identity.account_deletion_media_operations ADD CONSTRAINT deletion_media_times CHECK(
  prepared_at<lease_expires_at AND (verified_at IS NULL OR (verified_at>=prepared_at AND verified_at<lease_expires_at)));
CREATE FUNCTION identity.deletion_media_fence(operation identity.account_deletion_media_operations) RETURNS boolean
LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work job ON job.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN media.asset_reference_anchors asset ON asset.id=operation.asset_id
    WHERE root.id=operation.deletion_record_id AND root.phase='media_objects' AND root.checkpoint_version=4
      AND root.checklist_version=1 AND root.completed_at IS NULL AND NOT root.reactivation_allowed
      AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
      AND asset.owner_user_id=root.user_id AND asset.product_epoch=root.product_epoch
      AND job.phase=root.phase AND job.checkpoint_version=root.checkpoint_version
      AND job.lease_owner=operation.lease_owner AND job.lease_generation=operation.lease_generation
      AND job.lease_expires_at=operation.lease_expires_at AND job.lease_expires_at>clock_timestamp()
      AND operation.prepared_at>=root.requested_at AND operation.prepared_at<=clock_timestamp()
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior WHERE prior.deletion_record_id=root.id
        AND prior.completed_phase='product_data' AND prior.next_phase='media_objects' AND prior.next_checkpoint_version=4))
$$;
CREATE FUNCTION identity.deletion_private_photo_valid(subject uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_media_operations operation
    JOIN identity.account_deletion_records root ON root.id=operation.deletion_record_id
    JOIN media.asset_reference_anchors asset ON asset.id=operation.asset_id
    JOIN media.variant_reference_anchors variant ON variant.id=operation.variant_id
    JOIN media.report_photo_evidence_holds hold ON hold.report_evidence_id=operation.evidence_id
    JOIN platform.audit_logs audit ON audit.id=operation.audit_id
    WHERE operation.evidence_id=subject AND operation.kind='retain_photo' AND operation.verified_at IS NOT NULL
      AND asset.owner_user_id=root.user_id AND asset.product_epoch=root.product_epoch
      AND operation.variant_id=hold.variant_id AND operation.asset_id=hold.asset_id
      AND variant.asset_id=asset.id AND variant.variant_type='thumbnail' AND variant.transformation_version=1
      AND encode(variant.sha256,'hex')=hold.content_sha256 AND operation.verified_sha256=hold.content_sha256
      AND operation.verified_bytes BETWEEN 1 AND 10485760 AND operation.verified_at>=operation.prepared_at
      AND operation.prepared_at>=root.requested_at AND operation.verified_at<operation.lease_expires_at
      AND operation.verification_transaction IS NOT NULL
      AND audit.category='account' AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.event_type='account.deletion-media-operation.v1' AND audit.result_code='media_verified' AND audit.metadata_schema_version=1
      AND audit.metadata=jsonb_build_object('kind','media_copy','operationId',operation.id,'assetId',asset.id,
        'bytes',operation.verified_bytes,'sha256',operation.verified_sha256)
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=operation.verified_at)
$$;
CREATE FUNCTION identity.guard_deletion_media_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.verified_at IS NOT NULL) THEN
    RAISE EXCEPTION 'media provider history requires controlled release' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.deletion_record_id,NEW.asset_id,NEW.environment,NEW.kind,NEW.evidence_id,NEW.variant_id,NEW.key_role,NEW.prepared_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.deletion_record_id,OLD.asset_id,OLD.environment,OLD.kind,OLD.evidence_id,OLD.variant_id,OLD.key_role,OLD.prepared_at) THEN
    RAISE EXCEPTION 'provider scope is immutable' USING ERRCODE='23514'; END IF;
  IF identity.deletion_media_fence(NEW) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM media.media_assets source
      WHERE source.id=NEW.asset_id AND split_part(source.quarantine_key,'/',2)=NEW.environment AND source.deleted_at IS NOT NULL)
    OR (NEW.variant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM media.variant_reference_anchors variant WHERE variant.id=NEW.variant_id AND variant.asset_id=NEW.asset_id)) THEN
    RAISE EXCEPTION 'provider work lacks owning source and lease' USING ERRCODE='23514'; END IF;
  IF NEW.kind='retain_photo' AND NOT EXISTS(SELECT 1 FROM media.report_photo_evidence_holds hold
    JOIN media.variant_reference_anchors variant ON variant.id=hold.variant_id AND variant.asset_id=hold.asset_id
    WHERE hold.report_evidence_id=NEW.evidence_id AND hold.asset_id=NEW.asset_id AND hold.variant_id=NEW.variant_id
      AND variant.variant_type='thumbnail' AND variant.transformation_version=1 AND encode(variant.sha256,'hex')=hold.content_sha256) THEN
    RAISE EXCEPTION 'private copy source binding missing' USING ERRCODE='23514'; END IF;
  IF NEW.kind='delete_public' AND EXISTS(SELECT 1 FROM media.report_photo_evidence_holds hold WHERE hold.asset_id=NEW.asset_id
    AND identity.deletion_private_photo_valid(hold.report_evidence_id) IS NOT TRUE) THEN
    RAISE EXCEPTION 'public deletion requires every private copy' USING ERRCODE='23514'; END IF;
  IF NEW.verified_at IS NOT NULL AND (NEW.verified_at>clock_timestamp() OR NEW.verification_transaction IS DISTINCT FROM pg_current_xact_id()
    OR (NEW.kind='retain_photo' AND NEW.verified_sha256 IS DISTINCT FROM
      (SELECT content_sha256 FROM media.report_photo_evidence_holds WHERE report_evidence_id=NEW.evidence_id))) THEN
    RAISE EXCEPTION 'media provider observation lacks current transaction' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deletion_media_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_media_operations
 FOR EACH ROW EXECUTE FUNCTION identity.guard_deletion_media_operation();
CREATE FUNCTION identity.require_deletion_media_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; expected jsonb; kind text;
BEGIN
  IF NEW.verified_at IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=NEW.deletion_record_id;
  kind:=CASE NEW.kind WHEN 'retain_photo' THEN 'media_copy' ELSE 'media_delete' END;
  expected:=jsonb_build_object('kind',kind,'operationId',NEW.id,'assetId',NEW.asset_id);
  IF NEW.kind='retain_photo' THEN expected:=expected||jsonb_build_object('bytes',NEW.verified_bytes,'sha256',NEW.verified_sha256); END IF;
  IF identity.deletion_media_fence(NEW) IS NOT TRUE OR NEW.verification_transaction IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS(SELECT 1 FROM platform.audit_logs audit WHERE audit.id=NEW.audit_id AND audit.category='account'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.event_type='account.deletion-media-operation.v1' AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
      AND audit.result_code='media_verified' AND audit.metadata_schema_version=1 AND audit.metadata=expected
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=NEW.verified_at)
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events event WHERE event.id=NEW.event_id AND event.aggregate_type='account_deletion'
      AND event.aggregate_id=root.id AND event.event_type='account.deletion-media-operation.v1' AND event.schema_version=1
      AND event.payload=jsonb_build_object('deletionRecordId',root.id,'operationId',NEW.id,'kind',kind)
      AND event.occurred_at=NEW.verified_at AND event.available_at=NEW.verified_at
      AND event.correlation_id=root.request_id AND event.causation_id=root.command_id) THEN
    RAISE EXCEPTION 'provider observation audit chain incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER deletion_media_operation_required AFTER INSERT OR UPDATE ON identity.account_deletion_media_operations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_deletion_media_operation();
-- Media operation events are minimum lifecycle facts, never provider keys or image bytes.
CREATE OR REPLACE FUNCTION platform.deletion_event_policy() RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT $policy${"shapes":{"identity.telegram-identity-registered.v1":{"required":"userId accountState"},"telegram.start-route-requested.v1":{"required":"userId entryRoute uiLocale"},"identity.signup-started.v1":{"required":"userId currentStep draftVersion"},"identity.signup-step-saved.v1":{"required":"userId completedStep currentStep draftVersion"},"identity.locale-changed.v1":{"required":"userId uiLocale visibilityEnabled settingsVersion"},"identity.visibility-changed.v1":{"required":"userId uiLocale visibilityEnabled settingsVersion"},"identity.guest-preview-consumed.v1":{"required":"userId count limit remaining"},"identity.account-state-changed.v1":[{"required":"userId previousState nextState reasonCode accountVersion"},{"required":"userId profileId accountState"}],"profile.confirmed.v1":{"required":"userId profileId accountState"},"profile.updated.v1":{"required":"userId profileId version"},"profile.profile-completed.v1":{"required":"profileId"},"profile.profile-invalidated.v1":{"required":"profileId"},"profile.protected-change-requested.v1":{"required":"profileChangeRequestId userId field status"},"profile.protected-change-reviewed.v1":{"required":"profileChangeRequestId userId field decision profileVersion"},"discovery.filter-saved.v1":{"required":"userId version"},"discovery.candidate-reserved.v1":{"required":"deliveryId viewerUserId targetUserId mode filterVersion"},"discovery.candidate-delivered.v1":{"required":"deliveryId viewerUserId targetUserId mode"},"discovery.candidate-delivery-failed.v1":{"required":"deliveryId viewerUserId targetUserId mode reasonCode"},"discovery.consumption-created.v1":{"required":"viewerUserId targetUserId reason"},"interaction.like-created.v1":{"required":"likeId senderUserId receiverUserId notificationEligible","optional":"source"},"interaction.like-closed.v1":{"required":"reason","optional":"likeId likeIds matchId"},"interaction.not-interested-created.v1":{"required":"rejectionId senderUserId receiverUserId source"},"matching.match-created.v1":{"required":"matchId userLowId userHighId source","optional":"nakhId"},"matching.unmatched.v1":{"required":"matchId chatSessionId"},"telegram.liked-by-delivery-requested.v1":{"required":"deliveryId"},"notification.delivery-requested.v1":{"required":"notificationId deliveryId channel"},"chat.message-created.v1":{"required":"chatSessionId messageId messageType"},"chat.read-advanced.v1":{"required":"chatSessionId throughSequenceNumber"},"chat.mute-changed.v1":{"required":"chatSessionId muted version"},"nakh.flow-created.v1":{"required":"flowId senderUserId receiverUserId"},"nakh.pending-created.v1":{"required":"pendingNakhId senderUserId"},"nakh.pending-updated.v1":{"required":"pendingNakhId senderUserId"},"nakh.pending-reminder-requested.v1":{"required":"pendingNakhId reminderNumber"},"nakh.delivered.v1":{"required":"nakhId receiverUserId"},"nakh.cancelled.v1":{"required":"pendingNakhId senderUserId resolution"},"nakh.status-changed.v1":{"required":"status","optional":"nakhId pendingNakhId matchId"},"billing.payment-receipt-recorded.v1":{"required":"paymentRecordId"},"billing.payment-correction-required.v1":{"required":"paymentRecordId"},"billing.payment-fulfilled.v1":{"required":"paymentRecordId"},"billing.payment-corrected.v1":{"required":"paymentRecordId refundRecordId"},"billing.credit-increased.v1":{"required":"creditTransactionId amount balanceAfter"},"entitlement.feature-unlocked.v1":{"required":"featureUnlockId featureType"},"moderation.report-submitted.v1":{"required":"reportId evidenceTypes status"},"moderation.threshold-reached.v1":{"required":"restrictionEpisodeId targetUserId distinctReporterCount"},"moderation.review-decided.v1":{"required":"reviewId status version"},"moderation.appeal-changed.v1":{"required":"appealId status version"},"support.thread-changed.v1":{"required":"supportThreadId userId status version unansweredUserMessages"},"moderation.action-recorded.v1":{"required":"actionId actionType","optional":"targetUserId accountVersion restrictionEpisodeId photoId photoVersion profileVersion pairTargetId"},"moderation.internal-block-changed.v1":{"required":"actionId action pairTargetId pairVersion closedLikeCount revokedUnlockCount","optional":"closedMatchId closedChatSessionId"},"account.deletion-requested.v1":{"required":"deletionRecordId step"},"account.shared-scope-closed.v1":{"required":"deletionRecordId recipientUserId","optional":"matchId"},"account.deletion-phase-completed.v1":{"required":"deletionRecordId completedPhase nextPhase checkpointVersion"},"account.deletion-credit-epoch-prepared.v1":{"required":"deletionRecordId kind"},"account.deletion-product-batch.v1":{"required":"deletionRecordId resource rows auditId"},"account.deletion-media-archived.v1":{"required":"deletionRecordId kind assetId"},"account.deletion-media-operation.v1":{"required":"deletionRecordId operationId kind"},"account.deletion-operational-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-evidence-verified.v1":{"required":"deletionRecordId kind"},"account.deletion-profile-archived.v1":{"required":"deletionRecordId kind"},"account.deletion-photo-archived.v1":{"required":"deletionRecordId kind"},"account.deletion-match-archived.v1":{"required":"deletionRecordId kind"},"account.deletion-chat-archived.v1":{"required":"deletionRecordId kind final deletedCount"},"account.deletion-support-closed.v1":{"required":"deletionRecordId kind count"},"account.deletion-nakh-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-paid-pending-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-terminal-pending-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-flow-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-like-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-unlock-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-pair-batch.v1":{"required":"deletionRecordId kind rows auditId"},"account.deletion-notice-batch.v1":{"required":"deletionRecordId kind rows auditId"},"media.quarantine-uploaded.v1":{"required":"assetId bytes"},"media.ingestion-requested.v1":{"required":"assetId validationState"},"media.ingestion-rejected.v1":{"required":"assetId","optional":"errorCode validationState"},"media.asset-cleanup-completed.v1":{"required":"assetId deletionGeneration"},"media.photo-hidden.v1":{"required":"profileId photoId"},"media.photo-visible.v1":{"required":"profileId photoId"},"media.photo-deleted.v1":{"required":"profileId photoId"},"media.photo-primary-selected.v1":{"required":"profileId photoId"},"media.photos-reordered.v1":{"required":"profileId"},"media.photo-validated.v1":{"required":"assetId resultCode"},"media.validation-rejected.v1":{"required":"assetId resultCode"}},"machineValues":["guest","incomplete","active","restricted","banned","deleted","continue_signup","main","main_discovery_paused","fix_profile","ban_appeal","return_decision","age_confirmation","name","birth_year","gender","relationship_gender_preference","interests","location","relationship_goal","primary_photo","additional_photos","highlight","optional_details","confirm_profile","completed","pending","pending_payment","paid_and_sent","cancelled","expired","closed_by_system","sent","seen","accepted","rejected","closed","submitted","pending_review","dismissed","actioned","open","in_review","approved","explore","guest_preview","liked_by","like","not_interested","matched","reciprocal_likes","nakh","direct","pending_nakh","mutual_like","cancelled_pending_nakh","send_nakh","nakh_flow","converted_to_like","converted_to_not_interested","text","predefined_question","predefined_answer","system","chat","photo","profile","chat_unlock","liked_by_profile_unlock","telegram","restrict_user","ban_user","unrestrict_user","unban_user","hide_photo","restore_photo","delete_photo","create_internal_block","remove_internal_block","create","remove","shared_closure","evidence_capture","product_data","media_objects","ephemeral_access","retention_manifest","verification","credit_epoch","quarantined","validating","valid","invalid","uploaded","capture_integrity","profile_source","photo_source","chat_source","match_source","support_scope","nakh_source","paid_pending_source","terminal_pending_source","flow_source","like_source","unlock_source","pair_source","notice_source","media_source","media_copy","media_delete","outbox_cancel"],"booleanFields":["notificationEligible","muted","visibilityEnabled","final"],"quantityFields":["amount","balanceAfter","throughSequenceNumber","bytes"],"codeFields":["reasonCode","errorCode","resultCode"],"counterFields":["version","draftVersion","settingsVersion","accountVersion","filterVersion","photoVersion","profileVersion","pairVersion","checkpointVersion","count","limit","remaining","reminderNumber","distinctReporterCount","unansweredUserMessages","closedLikeCount","revokedUnlockCount","deletionGeneration","resource","rows","deletedCount"]}$policy$::jsonb $$;

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
  UNION ALL SELECT 'sample_effect',id,actor_user_id FROM platform.sample_effects;


CREATE OR REPLACE FUNCTION platform.deletion_operational_blocker(subject uuid) RETURNS boolean
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
      'schemaVersion','keyVersion','keyId','resultCode','operationId','assetId','bytes','sha256','delivered','grants','pending']) IS NOT TRUE))
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


ALTER TABLE media.report_photo_evidence_holds DROP CONSTRAINT report_photo_evidence_holds_asset_id_fkey,
  ADD CONSTRAINT report_photo_evidence_holds_asset_id_fkey FOREIGN KEY(asset_id) REFERENCES media.asset_reference_anchors(id) ON DELETE RESTRICT;
ALTER TABLE media.report_photo_evidence_holds DROP CONSTRAINT report_photo_evidence_holds_variant_id_fkey,
  ADD CONSTRAINT report_photo_evidence_holds_variant_id_fkey FOREIGN KEY(variant_id) REFERENCES media.variant_reference_anchors(id) ON DELETE RESTRICT;

-- Only the separately verified private copy substitutes for original provider
-- bytes. A lost or corrupt copy witness must not fall back to ordinary storage.
CREATE VIEW media.report_photo_source_facts AS
 SELECT hold.report_evidence_id,hold.asset_id,hold.variant_id,variant.storage_key,variant.sha256,
   variant.variant_type,variant.transformation_version
 FROM media.report_photo_evidence_holds hold
 JOIN media.photo_variants variant ON variant.id=hold.variant_id AND variant.asset_id=hold.asset_id
 JOIN media.media_assets asset ON asset.id=hold.asset_id
 WHERE asset.validation_state='valid' AND asset.storage_provider='r2' AND variant.storage_provider='r2'
   AND asset.storage_deleted_at IS NULL AND asset.cleanup_lease_owner IS NULL AND variant.storage_deleted_at IS NULL
   AND variant.variant_type='thumbnail' AND variant.transformation_version=1
   AND encode(variant.sha256,'hex')=hold.content_sha256
   AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_media_operations operation WHERE operation.evidence_id=hold.report_evidence_id
     AND operation.kind='retain_photo' AND operation.verified_at IS NOT NULL)
 UNION ALL
 SELECT hold.report_evidence_id,hold.asset_id,hold.variant_id,
   'evidence/'||operation.environment||'/'||hold.report_evidence_id::text||'/thumbnail-v1.webp',variant.sha256,
   variant.variant_type,variant.transformation_version
 FROM media.report_photo_evidence_holds hold
 JOIN media.variant_reference_anchors variant ON variant.id=hold.variant_id AND variant.asset_id=hold.asset_id
 JOIN identity.account_deletion_media_operations operation ON operation.evidence_id=hold.report_evidence_id AND operation.kind='retain_photo'
 WHERE identity.deletion_private_photo_valid(hold.report_evidence_id);

CREATE OR REPLACE FUNCTION media.guard_photo_evidence_asset_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.storage_deleted_at IS DISTINCT FROM OLD.storage_deleted_at
      OR (NEW.cleanup_lease_owner IS NOT NULL AND NEW.cleanup_lease_owner IS DISTINCT FROM OLD.cleanup_lease_owner))
    AND EXISTS(SELECT 1 FROM media.report_photo_evidence_holds hold WHERE hold.asset_id=NEW.id
      AND identity.deletion_private_photo_valid(hold.report_evidence_id) IS NOT TRUE) THEN
    RAISE EXCEPTION 'media asset retained without verified private evidence' USING ERRCODE='23514',CONSTRAINT='report_photo_asset_retained'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION media.guard_photo_evidence_variant_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_deleted_at IS DISTINCT FROM OLD.storage_deleted_at
    AND EXISTS(SELECT 1 FROM media.report_photo_evidence_holds hold WHERE hold.variant_id=NEW.id
      AND identity.deletion_private_photo_valid(hold.report_evidence_id) IS NOT TRUE) THEN
    RAISE EXCEPTION 'media variant retained without verified private evidence' USING ERRCODE='23514',CONSTRAINT='report_photo_variant_retained'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION identity.deletion_evidence_capture(subject uuid)
RETURNS TABLE(snapshot_id uuid,fingerprint text,content_sha256 text) LANGUAGE sql STABLE AS $$
  SELECT snapshot.id,encode(sha256(convert_to(jsonb_build_array(
    evidence.id,evidence.report_id,evidence.evidence_type,evidence.profile_id,evidence.profile_photo_id,
    evidence.chat_session_id,evidence.chat_message_id,evidence.unmatch_record_id,
    snapshot.id,snapshot.snapshot_type,snapshot.schema_version,snapshot.encryption_key_id,
    snapshot.encryption_key_version,encode(snapshot.nonce,'hex'),encode(snapshot.ciphertext,'hex'),
    snapshot.content_sha256,extract(epoch from snapshot.created_at),
    hold.photo_id,hold.asset_id,hold.variant_id,hold.content_sha256,hold.captured_primary
  )::text,'UTF8')),'hex'),snapshot.content_sha256
  FROM moderation.report_evidence evidence
  JOIN moderation.report_snapshots snapshot ON snapshot.report_evidence_id=evidence.id
    AND snapshot.report_id=evidence.report_id AND snapshot.snapshot_type=evidence.evidence_type
  LEFT JOIN media.report_photo_evidence_holds hold ON hold.report_evidence_id=evidence.id
  WHERE evidence.id=subject AND evidence.evidence_type<>'message' AND snapshot.schema_version=1
    AND (evidence.evidence_type<>'photo' OR EXISTS (
      SELECT 1 FROM media.report_photo_source_facts variant WHERE variant.report_evidence_id=evidence.id
      AND hold.photo_id=evidence.profile_photo_id AND variant.variant_id=hold.variant_id
      AND variant.asset_id=hold.asset_id AND variant.variant_type='thumbnail' AND variant.transformation_version=1
      AND encode(variant.sha256,'hex')=hold.content_sha256))
  UNION ALL
  SELECT snapshot.id,encode(sha256(convert_to(jsonb_build_array(
    evidence.id,evidence.report_id,evidence.evidence_type,evidence.chat_message_id,
    snapshot.id,snapshot.chat_session_id,snapshot.original_message_id,snapshot.sender_user_id,
    snapshot.message_type,snapshot.content,extract(epoch from snapshot.original_created_at),extract(epoch from snapshot.snapshotted_at),
    snapshot.integrity_sha256,extract(epoch from request.requested_at),extract(epoch from request.captured_at)
  )::text,'UTF8')),'hex'),snapshot.integrity_sha256
  FROM moderation.report_evidence evidence
  JOIN chat.chat_message_snapshots snapshot ON snapshot.report_id=evidence.report_id
    AND snapshot.original_message_id=evidence.chat_message_id
  JOIN chat.chat_message_snapshot_requests request ON request.report_id=snapshot.report_id
    AND request.original_message_id=snapshot.original_message_id AND request.chat_session_id=snapshot.chat_session_id
  WHERE evidence.id=subject AND evidence.evidence_type='message' AND request.captured_at IS NOT NULL
    AND request.captured_at>=snapshot.snapshotted_at
$$;


CREATE FUNCTION identity.deletion_media_operation_valid(operation identity.account_deletion_media_operations) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT operation.verified_at IS NOT NULL AND operation.verification_transaction IS NOT NULL
  AND operation.verified_at>=operation.prepared_at AND operation.verified_at<operation.lease_expires_at
  AND EXISTS(SELECT 1 FROM identity.account_deletion_records root JOIN media.asset_reference_anchors asset ON asset.id=operation.asset_id
   JOIN platform.audit_logs audit ON audit.id=operation.audit_id
   WHERE root.id=operation.deletion_record_id AND asset.owner_user_id=root.user_id AND asset.product_epoch=root.product_epoch
    AND operation.prepared_at>=root.requested_at AND audit.category='account' AND audit.actor_type='system'
    AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
    AND audit.event_type='account.deletion-media-operation.v1' AND audit.result_code='media_verified' AND audit.metadata_schema_version=1
    AND audit.metadata=jsonb_build_object('kind',CASE operation.kind WHEN 'retain_photo' THEN 'media_copy' ELSE 'media_delete' END,
      'operationId',operation.id,'assetId',operation.asset_id)||CASE operation.kind WHEN 'retain_photo' THEN
      jsonb_build_object('bytes',operation.verified_bytes,'sha256',operation.verified_sha256) ELSE '{}'::jsonb END
    AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=operation.verified_at)
  AND (operation.kind<>'retain_photo' OR identity.deletion_private_photo_valid(operation.evidence_id))
$$;
CREATE FUNCTION identity.deletion_asset_provider_valid(subject uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM identity.account_deletion_media_operations operation WHERE operation.asset_id=subject
   AND operation.kind='delete_public' AND operation.key_role='scope' AND identity.deletion_media_operation_valid(operation))
  AND EXISTS(SELECT 1 FROM identity.account_deletion_media_operations operation WHERE operation.asset_id=subject
   AND operation.kind='delete_public' AND operation.key_role='quarantine' AND identity.deletion_media_operation_valid(operation))
  AND EXISTS(SELECT 1 FROM identity.account_deletion_media_operations operation WHERE operation.asset_id=subject
   AND operation.kind='delete_public' AND operation.key_role='validated' AND identity.deletion_media_operation_valid(operation))
  AND NOT EXISTS(SELECT 1 FROM media.variant_reference_anchors variant WHERE variant.asset_id=subject
   AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_media_operations operation WHERE operation.variant_id=variant.id
     AND operation.kind='delete_public' AND identity.deletion_media_operation_valid(operation)))
  AND NOT EXISTS(SELECT 1 FROM media.report_photo_evidence_holds hold WHERE hold.asset_id=subject
    AND identity.deletion_private_photo_valid(hold.report_evidence_id) IS NOT TRUE)
$$;
CREATE TABLE identity.account_deletion_media_receipts (
 asset_id uuid PRIMARY KEY REFERENCES media.asset_reference_anchors(id) ON DELETE RESTRICT,
 deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
 source_version integer NOT NULL CHECK(source_version>0),
 source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 variant_count integer NOT NULL CHECK(variant_count>=0),
 archived_at timestamptz NOT NULL,
 lease_owner uuid NOT NULL,
 lease_generation integer NOT NULL CHECK(lease_generation>0),
 lease_expires_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
 batch_transaction xid8 NOT NULL,
 audit_id uuid NOT NULL REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 event_id uuid NOT NULL REFERENCES platform.outbox_events(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX deletion_media_receipts_root_idx ON identity.account_deletion_media_receipts(deletion_record_id,asset_id);
CREATE FUNCTION identity.deletion_media_receipt_digest(receipt identity.account_deletion_media_receipts) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(receipt.asset_id,receipt.deletion_record_id,receipt.source_version,
   receipt.source_digest,receipt.variant_count,(extract(epoch FROM receipt.archived_at)*1000000)::bigint,receipt.lease_owner,receipt.lease_generation,
   (extract(epoch FROM receipt.lease_expires_at)*1000000)::bigint,receipt.batch_transaction)::text,'UTF8')),'hex')
$$;
CREATE FUNCTION identity.deletion_media_receipt_valid(receipt identity.account_deletion_media_receipts) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM media.media_assets WHERE id=receipt.asset_id)
  AND NOT EXISTS(SELECT 1 FROM media.photo_variants WHERE asset_id=receipt.asset_id)
  AND receipt.variant_count=(SELECT count(*) FROM media.variant_reference_anchors WHERE asset_id=receipt.asset_id)
  AND identity.deletion_asset_provider_valid(receipt.asset_id)
  AND EXISTS(SELECT 1 FROM identity.account_deletion_records root JOIN media.asset_reference_anchors asset ON asset.id=receipt.asset_id
   JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
   WHERE root.id=receipt.deletion_record_id AND asset.owner_user_id=root.user_id AND asset.product_epoch=root.product_epoch
    AND receipt.archived_at>=root.requested_at AND receipt.archived_at<receipt.lease_expires_at
    AND audit.category='account' AND audit.event_type='account.deletion-media-archived.v1' AND audit.actor_type='system'
    AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL AND audit.subject_type='account_deletion' AND audit.subject_id=root.id
    AND audit.result_code='media_archived' AND audit.metadata_schema_version=1
    AND audit.metadata=jsonb_build_object('kind','media_source','receiptDigest',identity.deletion_media_receipt_digest(receipt))
    AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=receipt.archived_at)
$$;
CREATE FUNCTION identity.deletion_media_receipt_fence(receipt identity.account_deletion_media_receipts) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT receipt.batch_transaction=pg_current_xact_id() AND EXISTS(SELECT 1 FROM identity.account_deletion_records root
  JOIN identity.account_deletion_work job ON job.deletion_record_id=root.id JOIN identity.accounts account ON account.user_id=root.user_id
  JOIN media.asset_reference_anchors asset ON asset.id=receipt.asset_id
  WHERE root.id=receipt.deletion_record_id AND root.phase='media_objects' AND root.checkpoint_version=4
   AND root.checklist_version=1 AND root.completed_at IS NULL AND NOT root.reactivation_allowed
   AND account.state='deleted' AND account.version=root.account_version AND account.product_epoch=root.product_epoch
   AND asset.owner_user_id=root.user_id AND asset.product_epoch=root.product_epoch
   AND job.phase=root.phase AND job.checkpoint_version=root.checkpoint_version
   AND job.lease_owner=receipt.lease_owner AND job.lease_generation=receipt.lease_generation
   AND job.lease_expires_at=receipt.lease_expires_at AND job.lease_expires_at>clock_timestamp()
   AND receipt.archived_at>=root.requested_at AND receipt.archived_at<=clock_timestamp())
$$;
CREATE FUNCTION identity.guard_deletion_media_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'media source proof requires controlled release' USING ERRCODE='55000'; END IF;
 IF identity.deletion_media_receipt_fence(NEW) IS NOT TRUE OR identity.deletion_asset_provider_valid(NEW.asset_id) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM media.media_assets source WHERE source.id=NEW.asset_id AND source.version=NEW.source_version
    AND encode(sha256(convert_to(to_jsonb(source)::text,'UTF8')),'hex')=NEW.source_digest)
  OR NEW.variant_count<>(SELECT count(*) FROM media.photo_variants WHERE asset_id=NEW.asset_id) THEN
  RAISE EXCEPTION 'media archival lacks original source and verified provider work' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deletion_media_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_media_receipts
 FOR EACH ROW EXECUTE FUNCTION identity.guard_deletion_media_receipt();
CREATE FUNCTION media.require_account_media_removal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_id uuid;
BEGIN
 original_id:=CASE TG_TABLE_NAME WHEN 'media_assets' THEN (to_jsonb(OLD)->>'id')::uuid ELSE (to_jsonb(OLD)->>'asset_id')::uuid END;
 IF NOT EXISTS(SELECT 1 FROM identity.account_deletion_media_receipts receipt WHERE receipt.asset_id=original_id
   AND identity.deletion_media_receipt_fence(receipt) AND identity.deletion_asset_provider_valid(original_id)) THEN
  RAISE EXCEPTION 'media removal lacks owning archive transaction' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER account_media_removal_guard BEFORE DELETE ON media.media_assets FOR EACH ROW EXECUTE FUNCTION media.require_account_media_removal();
CREATE TRIGGER account_variant_removal_guard BEFORE DELETE ON media.photo_variants FOR EACH ROW EXECUTE FUNCTION media.require_account_media_removal();
CREATE FUNCTION identity.require_deletion_media_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF identity.deletion_media_receipt_fence(NEW) IS NOT TRUE OR identity.deletion_media_receipt_valid(NEW) IS NOT TRUE
  OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_records root JOIN platform.outbox_events event ON event.id=NEW.event_id
   WHERE root.id=NEW.deletion_record_id AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
    AND event.event_type='account.deletion-media-archived.v1' AND event.schema_version=1
    AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','media_source','assetId',NEW.asset_id)
    AND event.occurred_at=NEW.archived_at AND event.available_at=NEW.archived_at
    AND event.correlation_id=root.request_id AND event.causation_id=root.command_id) THEN
  RAISE EXCEPTION 'media archival audit or source absence incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER deletion_media_receipt_required AFTER INSERT ON identity.account_deletion_media_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_deletion_media_receipt();
