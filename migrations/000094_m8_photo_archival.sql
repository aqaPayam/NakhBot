-- Original identities only. Asset ID deliberately has no FK: ordinary provider
-- assets may be removed after verified object absence; exact holds keep their own FKs.
CREATE TABLE media.photo_reference_anchors (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES profile.profile_reference_anchors(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL UNIQUE
);
CREATE INDEX photo_reference_anchors_profile_idx ON media.photo_reference_anchors(profile_id,id);
INSERT INTO media.photo_reference_anchors SELECT id,profile_id,asset_id FROM media.profile_photos;
CREATE FUNCTION media.guard_photo_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'photo reference requires controlled release' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM media.profile_photos source
    JOIN profile.profile_reference_anchors profile ON profile.id=source.profile_id
    JOIN identity.accounts account ON account.user_id=profile.user_id
    JOIN media.media_assets asset ON asset.id=source.asset_id AND asset.owner_user_id=profile.user_id
    WHERE source.id=NEW.id AND source.profile_id=NEW.profile_id AND source.asset_id=NEW.asset_id AND account.state<>'deleted') THEN
    RAISE EXCEPTION 'photo reference lacks owning live source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER photo_reference_anchor_guard BEFORE INSERT OR UPDATE OR DELETE ON media.photo_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION media.guard_photo_reference_anchor();
CREATE FUNCTION media.create_photo_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO media.photo_reference_anchors(id,profile_id,asset_id) VALUES(NEW.id,NEW.profile_id,NEW.asset_id);
  RETURN NULL;
END $$;
CREATE TRIGGER photo_reference_anchor_required AFTER INSERT ON media.profile_photos
  FOR EACH ROW EXECUTE FUNCTION media.create_photo_reference_anchor();
CREATE FUNCTION media.require_photo_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM media.photo_reference_anchors WHERE id=NEW.id AND profile_id=NEW.profile_id AND asset_id=NEW.asset_id) THEN
    RAISE EXCEPTION 'photo reference chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER photo_reference_anchor_committed AFTER INSERT ON media.profile_photos
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION media.require_photo_reference_anchor();
ALTER TABLE media.photo_moderation_records DROP CONSTRAINT photo_moderation_records_photo_id_fkey;
ALTER TABLE media.photo_moderation_records ADD CONSTRAINT photo_moderation_records_photo_id_fkey
  FOREIGN KEY(photo_id) REFERENCES media.photo_reference_anchors(id) ON DELETE RESTRICT;
ALTER TABLE media.report_photo_evidence_holds DROP CONSTRAINT report_photo_evidence_holds_photo_id_fkey;
ALTER TABLE media.report_photo_evidence_holds ADD CONSTRAINT report_photo_evidence_holds_photo_id_fkey
  FOREIGN KEY(photo_id) REFERENCES media.photo_reference_anchors(id) ON DELETE RESTRICT;
ALTER TABLE moderation.moderation_actions DROP CONSTRAINT moderation_actions_target_photo_id_fkey;
ALTER TABLE moderation.moderation_actions ADD CONSTRAINT moderation_actions_target_photo_id_fkey
  FOREIGN KEY(target_photo_id) REFERENCES media.photo_reference_anchors(id) ON DELETE RESTRICT;
ALTER TABLE moderation.report_evidence DROP CONSTRAINT report_evidence_profile_photo_id_fkey;
ALTER TABLE moderation.report_evidence ADD CONSTRAINT report_evidence_profile_photo_id_fkey
  FOREIGN KEY(profile_photo_id) REFERENCES media.photo_reference_anchors(id) ON DELETE RESTRICT;

CREATE TABLE identity.account_deletion_photo_receipts (
  photo_id uuid PRIMARY KEY REFERENCES media.photo_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  checklist_version integer NOT NULL CHECK(checklist_version=1),
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE
);
CREATE INDEX deletion_photo_receipts_root_idx ON identity.account_deletion_photo_receipts(deletion_record_id,photo_id);
CREATE FUNCTION identity.photo_captures_verified(root_id uuid,source_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM moderation.report_evidence evidence
    WHERE (evidence.profile_photo_id=source_id OR EXISTS(SELECT 1 FROM media.report_photo_evidence_holds hold
      WHERE hold.report_evidence_id=evidence.id AND hold.photo_id=source_id))
      AND NOT EXISTS(SELECT 1 FROM identity.account_deletion_evidence_receipts receipt
        JOIN LATERAL identity.deletion_evidence_capture(evidence.id) capture ON true
        WHERE receipt.deletion_record_id=root_id AND receipt.report_evidence_id=evidence.id
          AND receipt.snapshot_id=capture.snapshot_id AND receipt.capture_fingerprint=capture.fingerprint
          AND receipt.content_sha256=capture.content_sha256))
$$;
CREATE OR REPLACE FUNCTION identity.profile_captures_verified(root_id uuid,source_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM moderation.report_evidence evidence
    WHERE (evidence.profile_id=source_id OR EXISTS (SELECT 1 FROM media.photo_reference_anchors photo
      WHERE photo.id=evidence.profile_photo_id AND photo.profile_id=source_id))
    AND NOT EXISTS (SELECT 1 FROM identity.account_deletion_evidence_receipts receipt
      JOIN LATERAL identity.deletion_evidence_capture(evidence.id) capture ON true
      WHERE receipt.deletion_record_id=root_id AND receipt.report_evidence_id=evidence.id
        AND receipt.snapshot_id=capture.snapshot_id AND receipt.capture_fingerprint=capture.fingerprint
        AND receipt.content_sha256=capture.content_sha256))
$$;
CREATE FUNCTION identity.photo_receipt_fence(receipt identity.account_deletion_photo_receipts) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN media.photo_reference_anchors anchor ON anchor.id=receipt.photo_id
    JOIN profile.profile_reference_anchors profile ON profile.id=anchor.profile_id AND profile.user_id=root.user_id
    WHERE root.id=receipt.deletion_record_id AND root.phase='evidence_capture' AND root.checkpoint_version=2
      AND root.checklist_version=receipt.checklist_version AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<=clock_timestamp()
      AND identity.photo_captures_verified(root.id,anchor.id))
$$;
CREATE FUNCTION identity.guard_photo_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'photo archival receipt requires controlled release' USING ERRCODE='55000'; END IF;
  IF NOT identity.photo_receipt_fence(NEW) OR NOT EXISTS(SELECT 1 FROM media.profile_photos source
    JOIN media.photo_reference_anchors anchor ON anchor.id=source.id
      AND anchor.profile_id=source.profile_id AND anchor.asset_id=source.asset_id
    WHERE source.id=NEW.photo_id) THEN
    RAISE EXCEPTION 'photo archival lacks owning captures and fence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER photo_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_photo_receipts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_photo_archival_receipt();
CREATE FUNCTION media.require_photo_archival_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM identity.account_deletion_photo_receipts receipt
    JOIN media.photo_reference_anchors anchor ON anchor.id=receipt.photo_id
    WHERE receipt.photo_id=OLD.id AND anchor.profile_id=OLD.profile_id AND anchor.asset_id=OLD.asset_id
      AND identity.photo_receipt_fence(receipt)) THEN
    RAISE EXCEPTION 'photo source requires verified archival' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER photo_archival_delete_guard BEFORE DELETE ON media.profile_photos
  FOR EACH ROW EXECUTE FUNCTION media.require_photo_archival_before_delete();
CREATE FUNCTION identity.require_photo_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT identity.photo_receipt_fence(NEW) OR EXISTS(SELECT 1 FROM media.profile_photos WHERE id=NEW.photo_id)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_records root
      JOIN platform.audit_logs audit ON audit.id=NEW.audit_id JOIN platform.outbox_events event ON event.id=NEW.event_id
      WHERE root.id=NEW.deletion_record_id
        AND audit.category='account' AND audit.event_type='account.deletion-photo-archived.v1'
        AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
        AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='photo_archived'
        AND audit.metadata_schema_version=1 AND audit.metadata='{"kind":"photo_source"}'::jsonb
        AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=NEW.archived_at
        AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
        AND event.event_type='account.deletion-photo-archived.v1' AND event.schema_version=1
        AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','photo_source')
        AND event.correlation_id=root.request_id AND event.causation_id=root.command_id AND event.occurred_at=NEW.archived_at) THEN
    RAISE EXCEPTION 'photo archival chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER photo_archival_receipt_required AFTER INSERT ON identity.account_deletion_photo_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_photo_archival_receipt();
CREATE OR REPLACE FUNCTION media.validate_report_photo_hold_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM moderation.report_evidence evidence
    JOIN moderation.reports report ON report.id=evidence.report_id
    JOIN media.photo_reference_anchors photo ON photo.id=NEW.photo_id AND photo.asset_id=NEW.asset_id
    JOIN profile.profile_reference_anchors profile ON profile.id=photo.profile_id
    WHERE evidence.id=NEW.report_evidence_id AND evidence.evidence_type='photo'
      AND evidence.profile_photo_id=NEW.photo_id AND profile.user_id=report.target_user_id) THEN
    RAISE EXCEPTION 'photo hold does not match its governing evidence'
      USING ERRCODE='23514',CONSTRAINT='report_photo_hold_binding_valid';
  END IF;
  RETURN NULL;
END $$;
COMMENT ON TABLE media.photo_reference_anchors IS
  'Original Photo/Profile/asset IDs only; no provider keys, product state, access authority or retained-data release.';
COMMENT ON TABLE identity.account_deletion_photo_receipts IS
  'Immutable verified product-source archival proof; no provider absence assertion, hold release, phase completion or return authority.';
