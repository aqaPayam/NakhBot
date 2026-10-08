-- Minimal stable source identity, never an archived Profile body. Existing live
-- references are preserved exactly; no evidence capture is reconstructed.
CREATE TABLE profile.profile_reference_anchors (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT
);
CREATE INDEX profile_reference_anchors_user_idx ON profile.profile_reference_anchors(user_id);
INSERT INTO profile.profile_reference_anchors SELECT id,user_id FROM profile.profiles;
CREATE FUNCTION profile.guard_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'profile reference requires controlled release' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profile.profiles source JOIN identity.accounts account ON account.user_id=source.user_id
    WHERE source.id=NEW.id AND source.user_id=NEW.user_id AND account.state<>'deleted') THEN
    RAISE EXCEPTION 'profile reference lacks owning live source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profile_reference_anchor_guard BEFORE INSERT OR UPDATE OR DELETE ON profile.profile_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION profile.guard_reference_anchor();
CREATE FUNCTION profile.create_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id THEN
      RAISE EXCEPTION 'profile source identity is immutable' USING ERRCODE='23514';
    END IF;
  ELSE
    INSERT INTO profile.profile_reference_anchors(id,user_id) VALUES(NEW.id,NEW.user_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER profile_reference_anchor_required AFTER INSERT OR UPDATE ON profile.profiles
  FOR EACH ROW EXECUTE FUNCTION profile.create_reference_anchor();
ALTER TABLE moderation.report_evidence DROP CONSTRAINT report_evidence_profile_id_fkey;
ALTER TABLE moderation.report_evidence ADD CONSTRAINT report_evidence_profile_id_fkey
  FOREIGN KEY(profile_id) REFERENCES profile.profile_reference_anchors(id) ON DELETE RESTRICT;
ALTER TABLE media.profile_photos DROP CONSTRAINT profile_photos_profile_id_fkey;
ALTER TABLE media.profile_photos ADD CONSTRAINT profile_photos_profile_id_fkey
  FOREIGN KEY(profile_id) REFERENCES profile.profile_reference_anchors(id) ON DELETE RESTRICT;

CREATE TABLE identity.account_deletion_profile_receipts (
  deletion_record_id uuid PRIMARY KEY REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  profile_id uuid NOT NULL UNIQUE REFERENCES profile.profile_reference_anchors(id) ON DELETE RESTRICT,
  checklist_version integer NOT NULL CHECK(checklist_version=1),
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE
);
CREATE FUNCTION identity.profile_captures_verified(root_id uuid,source_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM moderation.report_evidence evidence
    WHERE (evidence.profile_id=source_id OR EXISTS (SELECT 1 FROM media.profile_photos photo
      WHERE photo.id=evidence.profile_photo_id AND photo.profile_id=source_id))
    AND NOT EXISTS (SELECT 1 FROM identity.account_deletion_evidence_receipts receipt
      JOIN LATERAL identity.deletion_evidence_capture(evidence.id) capture ON true
      WHERE receipt.deletion_record_id=root_id AND receipt.report_evidence_id=evidence.id
        AND receipt.snapshot_id=capture.snapshot_id AND receipt.capture_fingerprint=capture.fingerprint
        AND receipt.content_sha256=capture.content_sha256)
  )
$$;
CREATE FUNCTION identity.guard_profile_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'profile archival receipt requires controlled release' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN profile.profiles source ON source.user_id=root.user_id AND source.id=NEW.profile_id
    JOIN profile.profile_reference_anchors anchor ON anchor.id=source.id AND anchor.user_id=source.user_id
    WHERE root.id=NEW.deletion_record_id AND root.phase='evidence_capture' AND root.checkpoint_version=2
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND root.checklist_version=NEW.checklist_version AND account.state='deleted' AND account.version=root.account_version
      AND work.lease_owner=NEW.lease_owner AND work.lease_generation=NEW.lease_generation
      AND work.lease_expires_at=NEW.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND NEW.archived_at>=root.requested_at AND NEW.archived_at<=clock_timestamp()
      AND identity.profile_captures_verified(root.id,source.id)) THEN
    RAISE EXCEPTION 'profile archival lacks owning captures and fence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profile_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_profile_receipts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_profile_archival_receipt();
CREATE FUNCTION profile.require_archival_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.account_deletion_profile_receipts receipt
    JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    WHERE receipt.profile_id=OLD.id AND root.user_id=OLD.user_id AND root.phase='evidence_capture'
      AND root.checkpoint_version=2 AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND identity.profile_captures_verified(root.id,OLD.id)) THEN
    RAISE EXCEPTION 'profile source requires verified archival' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER profile_archival_delete_guard BEFORE DELETE ON profile.profiles
  FOR EACH ROW EXECUTE FUNCTION profile.require_archival_before_delete();
CREATE FUNCTION identity.require_profile_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM profile.profiles WHERE id=NEW.profile_id) OR NOT EXISTS (
    SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN profile.profile_reference_anchors anchor ON anchor.id=NEW.profile_id AND anchor.user_id=root.user_id
    JOIN platform.audit_logs audit ON audit.id=NEW.audit_id JOIN platform.outbox_events event ON event.id=NEW.event_id
    WHERE root.id=NEW.deletion_record_id AND root.phase='evidence_capture' AND root.checkpoint_version=2
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version
      AND work.lease_owner=NEW.lease_owner AND work.lease_generation=NEW.lease_generation
      AND work.lease_expires_at=NEW.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND identity.profile_captures_verified(root.id,NEW.profile_id)
      AND audit.category='account' AND audit.event_type='account.deletion-profile-archived.v1'
      AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
      AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='profile_archived'
      AND audit.metadata_schema_version=1 AND audit.metadata='{"kind":"profile_source"}'::jsonb
      AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=NEW.archived_at
      AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
      AND event.event_type='account.deletion-profile-archived.v1' AND event.schema_version=1
      AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','profile_source')
      AND event.correlation_id=root.request_id AND event.causation_id=root.command_id AND event.occurred_at=NEW.archived_at
  ) THEN
    RAISE EXCEPTION 'profile archival chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER profile_archival_receipt_required AFTER INSERT ON identity.account_deletion_profile_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_profile_archival_receipt();
