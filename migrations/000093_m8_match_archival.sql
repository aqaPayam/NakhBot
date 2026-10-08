CREATE TABLE identity.account_deletion_match_receipts (
  match_id uuid PRIMARY KEY REFERENCES matching.match_reference_anchors(id) ON DELETE RESTRICT,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK(status IN ('unmatched','closed')),
  closed_at timestamptz NOT NULL,
  source text NOT NULL CHECK(source IN ('mutual_like','nakh_accept')),
  source_nakh_id uuid,
  checklist_version integer NOT NULL CHECK(checklist_version=1),
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE,
  CHECK((source='nakh_accept')=(source_nakh_id IS NOT NULL))
);
CREATE INDEX deletion_match_receipts_root_idx ON identity.account_deletion_match_receipts(deletion_record_id,match_id);
CREATE INDEX deletion_match_receipts_nakh_idx ON identity.account_deletion_match_receipts(source_nakh_id) WHERE source_nakh_id IS NOT NULL;
-- Internal consistency facts only. Ordinary access continues to require a live Match.
CREATE VIEW matching.match_lifecycle_facts AS
  SELECT id,user_low_id,user_high_id,status,closed_at,source,source_nakh_id FROM matching.matches
  UNION ALL
  SELECT anchor.id,anchor.user_low_id,anchor.user_high_id,receipt.status,receipt.closed_at,receipt.source,receipt.source_nakh_id
    FROM matching.match_reference_anchors anchor JOIN identity.account_deletion_match_receipts receipt ON receipt.match_id=anchor.id
    WHERE NOT EXISTS(SELECT 1 FROM matching.matches WHERE id=anchor.id);
ALTER TABLE interaction.feature_unlocks DROP CONSTRAINT feature_unlocks_match_id_fkey;
ALTER TABLE interaction.feature_unlocks ADD CONSTRAINT feature_unlocks_match_id_fkey
  FOREIGN KEY(match_id) REFERENCES matching.match_reference_anchors(id) ON DELETE RESTRICT;

CREATE FUNCTION identity.match_captures_verified(root_id uuid,source_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM chat.chat_sessions WHERE match_id=source_id)
    AND NOT EXISTS(SELECT 1 FROM interaction.feature_unlocks WHERE match_id=source_id AND status='active')
    AND NOT EXISTS(SELECT 1 FROM chat.chat_reference_anchors anchor WHERE anchor.match_id=source_id
      AND (NOT EXISTS(SELECT 1 FROM identity.account_deletion_chat_receipts receipt WHERE receipt.chat_session_id=anchor.id AND receipt.final_batch)
        OR NOT identity.chat_captures_verified(root_id,anchor.id)))
$$;
CREATE FUNCTION identity.match_receipt_fence(receipt identity.account_deletion_match_receipts) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN matching.match_reference_anchors anchor ON anchor.id=receipt.match_id
    WHERE root.id=receipt.deletion_record_id AND root.user_id IN (anchor.user_low_id,anchor.user_high_id)
      AND root.phase='evidence_capture' AND root.checkpoint_version=2 AND root.checklist_version=receipt.checklist_version
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<=clock_timestamp()
      AND identity.match_captures_verified(root.id,anchor.id))
$$;
CREATE FUNCTION identity.guard_match_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'match archival receipt requires controlled release' USING ERRCODE='55000'; END IF;
  IF NOT identity.match_receipt_fence(NEW) OR NOT EXISTS(SELECT 1 FROM matching.matches source
    WHERE source.id=NEW.match_id AND source.status=NEW.status AND source.closed_at=NEW.closed_at
      AND source.source=NEW.source AND source.source_nakh_id IS NOT DISTINCT FROM NEW.source_nakh_id) THEN
    RAISE EXCEPTION 'match archival lacks owning captures and fence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER match_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_match_receipts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_match_archival_receipt();
CREATE OR REPLACE FUNCTION matching.require_archival_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM identity.account_deletion_match_receipts receipt
    WHERE receipt.match_id=OLD.id AND receipt.status=OLD.status AND receipt.closed_at=OLD.closed_at
      AND receipt.source=OLD.source AND receipt.source_nakh_id IS NOT DISTINCT FROM OLD.source_nakh_id
      AND identity.match_receipt_fence(receipt)) THEN
    RAISE EXCEPTION 'match source requires verified archival' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE FUNCTION identity.require_match_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT identity.match_receipt_fence(NEW)
    OR EXISTS(SELECT 1 FROM matching.matches WHERE id=NEW.match_id)
    OR EXISTS(SELECT 1 FROM matching.match_participants WHERE match_id=NEW.match_id)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_records root
      JOIN platform.audit_logs audit ON audit.id=NEW.audit_id JOIN platform.outbox_events event ON event.id=NEW.event_id
      WHERE root.id=NEW.deletion_record_id
        AND audit.category='account' AND audit.event_type='account.deletion-match-archived.v1'
        AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
        AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='match_archived'
        AND audit.metadata_schema_version=1 AND audit.metadata='{"kind":"match_source"}'::jsonb
        AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=NEW.archived_at
        AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
        AND event.event_type='account.deletion-match-archived.v1' AND event.schema_version=1
        AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','match_source')
        AND event.correlation_id=root.request_id AND event.causation_id=root.command_id AND event.occurred_at=NEW.archived_at) THEN
    RAISE EXCEPTION 'match archival chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER match_archival_receipt_required AFTER INSERT ON identity.account_deletion_match_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_match_archival_receipt();
COMMENT ON TABLE identity.account_deletion_match_receipts IS
  'Exact terminal Match status/time and Nakh funding identity with owning fence/audit; no source Likes, prose, product access, phase completion or retained-data release.';

CREATE OR REPLACE FUNCTION matching.verify_unmatch_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_match_id uuid;
BEGIN
  IF (TG_TABLE_SCHEMA = 'matching' AND TG_TABLE_NAME = 'unmatch_records') OR (TG_TABLE_SCHEMA='identity' AND TG_TABLE_NAME='account_deletion_match_receipts') THEN
    checked_match_id := NEW.match_id;
  ELSIF TG_TABLE_SCHEMA = 'matching' AND TG_TABLE_NAME = 'matches' THEN
    checked_match_id := NEW.id;
  ELSIF TG_TABLE_SCHEMA = 'chat' AND TG_TABLE_NAME = 'chat_sessions' THEN
    checked_match_id := NEW.match_id;
  ELSE
    SELECT id INTO checked_match_id FROM matching.match_reference_anchors
    WHERE user_low_id = NEW.user_low_id AND user_high_id = NEW.user_high_id;
  END IF;

  IF EXISTS (SELECT 1 FROM matching.unmatch_records WHERE match_id = checked_match_id)
    OR EXISTS (SELECT 1 FROM matching.matches WHERE id = checked_match_id AND status = 'unmatched')
  THEN
    IF NOT EXISTS (
      SELECT 1
      FROM matching.unmatch_records record
      JOIN matching.match_lifecycle_facts match ON match.id = record.match_id
      JOIN interaction.user_pair_states pair
        ON pair.user_low_id = match.user_low_id AND pair.user_high_id = match.user_high_id
      JOIN LATERAL (
        SELECT live.status,live.closed_reason,live.closed_at FROM chat.chat_sessions live WHERE live.match_id=match.id
        UNION ALL
        SELECT 'closed',receipt.closed_reason,receipt.closed_at FROM chat.chat_reference_anchors anchor
          JOIN identity.account_deletion_chat_receipts receipt ON receipt.chat_session_id=anchor.id AND receipt.final_batch
          WHERE anchor.match_id=match.id AND NOT EXISTS (SELECT 1 FROM chat.chat_sessions WHERE id=anchor.id)
      ) session ON true
      WHERE record.match_id = checked_match_id
        AND record.actor_user_id IN (match.user_low_id, match.user_high_id)
        AND match.status = 'unmatched' AND match.closed_at = record.unmatched_at
        AND pair.state = 'unmatched' AND pair.changed_at = record.unmatched_at
        AND session.status = 'closed' AND session.closed_reason = 'unmatch'
        AND session.closed_at = record.unmatched_at
        AND NOT EXISTS (
          SELECT 1 FROM interaction.likes like_row
          WHERE ((like_row.sender_user_id = match.user_low_id AND like_row.receiver_user_id = match.user_high_id)
            OR (like_row.sender_user_id = match.user_high_id AND like_row.receiver_user_id = match.user_low_id))
            AND like_row.status IN ('active','closed_by_match')
        )
    ) THEN
      RAISE EXCEPTION 'unmatch lifecycle is inconsistent' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION nakh.verify_nakh_match() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_nakh_id uuid;
  delivered nakh.nakhes%ROWTYPE;
  matching_count integer;
BEGIN
  IF TG_TABLE_SCHEMA = 'nakh' THEN
    checked_nakh_id := COALESCE(NEW.id, OLD.id);
  ELSE
    checked_nakh_id := COALESCE(NEW.source_nakh_id, OLD.source_nakh_id);
  END IF;
  IF checked_nakh_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO delivered FROM nakh.nakhes WHERE id = checked_nakh_id;
  IF delivered.id IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO matching_count FROM matching.match_lifecycle_facts match
    WHERE match.source = 'nakh_accept' AND match.source_nakh_id = delivered.id
      AND match.user_low_id = LEAST(delivered.sender_user_id, delivered.receiver_user_id)
      AND match.user_high_id = GREATEST(delivered.sender_user_id, delivered.receiver_user_id);
  IF (delivered.status = 'accepted' AND matching_count <> 1)
    OR (delivered.status <> 'accepted' AND matching_count <> 0) THEN
    RAISE EXCEPTION 'Nakh acceptance and Match source diverged' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION moderation.validate_report_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  report_row moderation.reports%ROWTYPE;
  related boolean;
BEGIN
  SELECT * INTO report_row FROM moderation.reports WHERE id = NEW.report_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report evidence has no governing report' USING ERRCODE = '23503';
  END IF;

  IF NEW.evidence_type IN ('profile','photo') THEN
    related := EXISTS (
      SELECT 1 FROM discovery.candidate_deliveries delivery
      WHERE delivery.viewer_user_id = report_row.reporter_user_id
        AND delivery.target_user_id = report_row.target_user_id
        AND delivery.state = 'delivered'
    ) OR EXISTS (
      SELECT 1 FROM matching.matches match
      WHERE report_row.reporter_user_id IN (match.user_low_id, match.user_high_id)
        AND report_row.target_user_id IN (match.user_low_id, match.user_high_id)
    ) OR EXISTS (
      SELECT 1 FROM nakh.nakhes nakh
      WHERE nakh.receiver_user_id = report_row.reporter_user_id
        AND nakh.sender_user_id = report_row.target_user_id
    ) OR EXISTS (
      SELECT 1 FROM interaction.likes like_row
      WHERE like_row.receiver_user_id = report_row.reporter_user_id
        AND like_row.sender_user_id = report_row.target_user_id
    );
    IF NOT related OR (
      NEW.evidence_type = 'profile' AND NOT EXISTS (
        SELECT 1 FROM profile.profiles profile
        WHERE profile.id = NEW.profile_id AND profile.user_id = report_row.target_user_id
      )
    ) OR (
      NEW.evidence_type = 'photo' AND NOT EXISTS (
        SELECT 1 FROM media.profile_photos photo
        JOIN profile.profiles profile ON profile.id = photo.profile_id
        WHERE photo.id = NEW.profile_photo_id AND profile.user_id = report_row.target_user_id
      )
    ) THEN
      RAISE EXCEPTION 'profile or photo evidence is not authorized' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.evidence_type = 'chat' THEN
    IF NOT EXISTS (
      SELECT 1 FROM chat.chat_sessions session
      JOIN matching.matches match ON match.id = session.match_id
      WHERE session.id = NEW.chat_session_id
        AND report_row.reporter_user_id IN (match.user_low_id, match.user_high_id)
        AND report_row.target_user_id IN (match.user_low_id, match.user_high_id)
    ) THEN
      RAISE EXCEPTION 'chat evidence is not authorized' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.evidence_type = 'message' THEN
    IF NOT EXISTS (
      SELECT 1 FROM chat.chat_messages message
      JOIN chat.chat_sessions session ON session.id = message.chat_session_id
      JOIN matching.matches match ON match.id = session.match_id
      WHERE message.id = NEW.chat_message_id
        AND report_row.reporter_user_id IN (match.user_low_id, match.user_high_id)
        AND report_row.target_user_id IN (match.user_low_id, match.user_high_id)
    ) THEN
      RAISE EXCEPTION 'message evidence is not authorized' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.evidence_type = 'unmatched_user' THEN
    IF NOT EXISTS (
      SELECT 1 FROM matching.unmatch_records unmatch
      JOIN matching.match_lifecycle_facts match ON match.id = unmatch.match_id
      WHERE unmatch.match_id = NEW.unmatch_record_id AND match.status='unmatched' AND match.closed_at=unmatch.unmatched_at
        AND report_row.reporter_user_id IN (match.user_low_id, match.user_high_id)
        AND report_row.target_user_id IN (match.user_low_id, match.user_high_id)
        AND transaction_timestamp() < unmatch.report_window_expires_at
    ) THEN
      RAISE EXCEPTION 'unmatched user evidence is not authorized or its window expired'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION identity.chat_receipt_fence(receipt identity.account_deletion_chat_receipts) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN chat.chat_reference_anchors anchor ON anchor.id=receipt.chat_session_id
    JOIN matching.match_lifecycle_facts relationship ON relationship.id=anchor.match_id
    WHERE root.id=receipt.deletion_record_id AND root.user_id IN (relationship.user_low_id,relationship.user_high_id)
      AND root.phase='evidence_capture' AND root.checkpoint_version=2 AND root.checklist_version=receipt.checklist_version
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<=clock_timestamp()
      AND relationship.status<>'active' AND identity.chat_captures_verified(root.id,anchor.id))
$$;
CREATE CONSTRAINT TRIGGER match_archival_unmatch_consistent AFTER INSERT ON identity.account_deletion_match_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION matching.verify_unmatch_consistency();
CREATE CONSTRAINT TRIGGER match_archival_nakh_consistent AFTER INSERT ON identity.account_deletion_match_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.verify_nakh_match();
CREATE FUNCTION interaction.require_live_match_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.match_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM matching.matches WHERE id=NEW.match_id) THEN
    RAISE EXCEPTION 'new grant requires live match source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feature_unlock_live_match_required BEFORE INSERT ON interaction.feature_unlocks
  FOR EACH ROW EXECUTE FUNCTION interaction.require_live_match_grant();
