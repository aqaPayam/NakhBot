-- Fingerprints authenticate the exact persisted capture envelope, never a fresh
-- reconstruction of product content. No private content is copied into receipts.
CREATE FUNCTION identity.deletion_evidence_capture(subject uuid)
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
      SELECT 1 FROM media.photo_variants variant
      WHERE hold.photo_id=evidence.profile_photo_id AND variant.id=hold.variant_id
        AND variant.asset_id=hold.asset_id AND variant.variant_type='thumbnail' AND variant.transformation_version=1
        AND variant.storage_deleted_at IS NULL AND encode(variant.sha256,'hex')=hold.content_sha256))
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

CREATE TABLE identity.account_deletion_evidence_receipts (
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  report_evidence_id uuid NOT NULL REFERENCES moderation.report_evidence(id) ON DELETE RESTRICT,
  snapshot_id uuid NOT NULL,
  capture_fingerprint text NOT NULL CHECK (capture_fingerprint ~ '^[0-9a-f]{64}$'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  checklist_version integer NOT NULL CHECK (checklist_version=1),
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK (lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL CHECK (verified_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE,
  PRIMARY KEY(deletion_record_id,report_evidence_id)
);

CREATE FUNCTION identity.guard_deletion_evidence_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'deletion evidence receipt requires controlled release' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN moderation.report_evidence evidence ON evidence.id=NEW.report_evidence_id
    JOIN moderation.reports report ON report.id=evidence.report_id
    JOIN LATERAL identity.deletion_evidence_capture(evidence.id) capture ON true
    WHERE root.id=NEW.deletion_record_id AND root.phase='evidence_capture' AND root.checkpoint_version=2
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version
      AND root.checklist_version=NEW.checklist_version
      AND root.user_id IN (report.reporter_user_id,report.target_user_id)
      AND work.lease_owner=NEW.lease_owner AND work.lease_generation=NEW.lease_generation
      AND work.lease_expires_at=NEW.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND NEW.verified_at>=root.requested_at AND NEW.verified_at<=clock_timestamp()
      AND capture.snapshot_id=NEW.snapshot_id AND capture.fingerprint=NEW.capture_fingerprint
      AND capture.content_sha256=NEW.content_sha256
  ) THEN
    RAISE EXCEPTION 'deletion evidence receipt lacks owning capture and fence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deletion_evidence_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
  ON identity.account_deletion_evidence_receipts FOR EACH ROW EXECUTE FUNCTION identity.guard_deletion_evidence_receipt();

CREATE FUNCTION identity.require_deletion_evidence_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN LATERAL identity.deletion_evidence_capture(NEW.report_evidence_id) capture ON true
    JOIN platform.audit_logs audit ON audit.id=NEW.audit_id
    JOIN platform.outbox_events event ON event.id=NEW.event_id
    WHERE root.id=NEW.deletion_record_id AND root.phase='evidence_capture' AND root.checkpoint_version=2
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version
      AND work.lease_owner=NEW.lease_owner AND work.lease_generation=NEW.lease_generation
      AND work.lease_expires_at=NEW.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND capture.snapshot_id=NEW.snapshot_id AND capture.fingerprint=NEW.capture_fingerprint
      AND capture.content_sha256=NEW.content_sha256
      AND audit.category='account' AND audit.event_type='account.deletion-evidence-verified.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='capture_verified'
      AND audit.metadata_schema_version=1 AND audit.metadata='{"kind":"capture_integrity"}'::jsonb
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=NEW.verified_at
      AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
      AND event.event_type='account.deletion-evidence-verified.v1' AND event.schema_version=1
      AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','capture_integrity')
      AND event.correlation_id=root.request_id AND event.causation_id=root.command_id AND event.occurred_at=NEW.verified_at
  ) THEN
    RAISE EXCEPTION 'deletion evidence verification chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER deletion_evidence_receipt_required AFTER INSERT
  ON identity.account_deletion_evidence_receipts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION identity.require_deletion_evidence_receipt();
