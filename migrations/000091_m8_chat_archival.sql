-- Stable reference only: no chat preferences, allocator or message content.
CREATE TABLE chat.chat_reference_anchors (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL UNIQUE REFERENCES matching.matches(id) ON DELETE RESTRICT
);
INSERT INTO chat.chat_reference_anchors SELECT id,match_id FROM chat.chat_sessions;
CREATE FUNCTION chat.guard_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'chat reference requires controlled release' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM chat.chat_sessions source JOIN matching.matches relationship ON relationship.id=source.match_id
    JOIN identity.accounts low_account ON low_account.user_id=relationship.user_low_id
    JOIN identity.accounts high_account ON high_account.user_id=relationship.user_high_id
    WHERE source.id=NEW.id AND source.match_id=NEW.match_id
      AND low_account.state<>'deleted' AND high_account.state<>'deleted') THEN
    RAISE EXCEPTION 'chat reference lacks owning live source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_reference_anchor_guard BEFORE INSERT OR UPDATE OR DELETE ON chat.chat_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION chat.guard_reference_anchor();
CREATE FUNCTION chat.create_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN INSERT INTO chat.chat_reference_anchors(id,match_id) VALUES(NEW.id,NEW.match_id); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER chat_reference_anchor_required AFTER INSERT ON chat.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION chat.create_reference_anchor();
ALTER TABLE moderation.report_evidence DROP CONSTRAINT report_evidence_chat_session_id_fkey;
ALTER TABLE moderation.report_evidence ADD CONSTRAINT report_evidence_chat_session_id_fkey
  FOREIGN KEY(chat_session_id) REFERENCES chat.chat_reference_anchors(id) ON DELETE RESTRICT;

CREATE TABLE identity.account_deletion_chat_receipts (
  id uuid PRIMARY KEY,
  deletion_record_id uuid NOT NULL REFERENCES identity.account_deletion_records(id) ON DELETE RESTRICT,
  chat_session_id uuid NOT NULL REFERENCES chat.chat_reference_anchors(id) ON DELETE RESTRICT,
  original_message_ids uuid[] NOT NULL CHECK(cardinality(original_message_ids)<=500 AND array_position(original_message_ids,NULL) IS NULL),
  final_batch boolean NOT NULL,
  closed_at timestamptz NOT NULL,
  closed_reason text NOT NULL CHECK(closed_reason IN ('unmatch','account_deleted','user_banned','admin_action','internal_block')),
  checklist_version integer NOT NULL CHECK(checklist_version=1),
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  archived_at timestamptz NOT NULL CHECK(archived_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE,
  CHECK(final_batch OR cardinality(original_message_ids)>0)
);
CREATE INDEX deletion_chat_receipts_root_idx ON identity.account_deletion_chat_receipts(deletion_record_id,chat_session_id);
CREATE UNIQUE INDEX deletion_chat_final_receipt_uq ON identity.account_deletion_chat_receipts(chat_session_id) WHERE final_batch;
CREATE FUNCTION identity.chat_captures_verified(root_id uuid,source_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM moderation.report_evidence evidence
    WHERE (evidence.chat_session_id=source_id
      OR evidence.unmatch_record_id=(SELECT match_id FROM chat.chat_reference_anchors WHERE id=source_id)
      OR EXISTS (SELECT 1 FROM chat.chat_messages message WHERE message.chat_session_id=source_id AND message.id=evidence.chat_message_id)
      OR EXISTS (SELECT 1 FROM chat.chat_message_snapshots snapshot WHERE snapshot.chat_session_id=source_id
        AND snapshot.original_message_id=evidence.chat_message_id AND snapshot.report_id=evidence.report_id)
      OR EXISTS (SELECT 1 FROM chat.chat_message_snapshot_requests request WHERE request.chat_session_id=source_id
        AND request.original_message_id=evidence.chat_message_id AND request.report_id=evidence.report_id))
    AND NOT EXISTS (SELECT 1 FROM identity.account_deletion_evidence_receipts receipt
      JOIN LATERAL identity.deletion_evidence_capture(evidence.id) capture ON true
      WHERE receipt.deletion_record_id=root_id AND receipt.report_evidence_id=evidence.id
        AND receipt.snapshot_id=capture.snapshot_id AND receipt.capture_fingerprint=capture.fingerprint
        AND receipt.content_sha256=capture.content_sha256)
  ) AND NOT EXISTS (
    SELECT 1 FROM chat.chat_message_snapshot_requests request WHERE request.chat_session_id=source_id
      AND (request.captured_at IS NULL OR NOT EXISTS (
        SELECT 1 FROM moderation.report_evidence evidence JOIN identity.account_deletion_evidence_receipts receipt
          ON receipt.report_evidence_id=evidence.id AND receipt.deletion_record_id=root_id
        JOIN LATERAL identity.deletion_evidence_capture(evidence.id) capture ON true
        WHERE evidence.report_id=request.report_id AND evidence.evidence_type='message'
          AND evidence.chat_message_id=request.original_message_id AND receipt.snapshot_id=capture.snapshot_id
          AND receipt.capture_fingerprint=capture.fingerprint AND receipt.content_sha256=capture.content_sha256))
  )
$$;
CREATE FUNCTION identity.chat_receipt_fence(receipt identity.account_deletion_chat_receipts) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    JOIN identity.accounts account ON account.user_id=root.user_id
    JOIN chat.chat_reference_anchors anchor ON anchor.id=receipt.chat_session_id
    JOIN matching.matches relationship ON relationship.id=anchor.match_id
    WHERE root.id=receipt.deletion_record_id AND root.user_id IN (relationship.user_low_id,relationship.user_high_id)
      AND root.phase='evidence_capture' AND root.checkpoint_version=2 AND root.checklist_version=receipt.checklist_version
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND account.state='deleted' AND account.version=root.account_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.archived_at>=root.requested_at AND receipt.archived_at<=clock_timestamp()
      AND relationship.status<>'active' AND identity.chat_captures_verified(root.id,anchor.id))
$$;
CREATE FUNCTION identity.guard_chat_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'chat archival receipt requires controlled release' USING ERRCODE='55000'; END IF;
  IF NOT identity.chat_receipt_fence(NEW) OR NOT EXISTS (
    SELECT 1 FROM chat.chat_sessions source WHERE source.id=NEW.chat_session_id AND source.status='closed'
      AND source.closed_at=NEW.closed_at AND source.closed_reason=NEW.closed_reason)
    OR cardinality(NEW.original_message_ids)<>(SELECT count(DISTINCT id) FROM unnest(NEW.original_message_ids) AS ids(id))
    OR cardinality(NEW.original_message_ids)<>(SELECT count(*) FROM chat.chat_messages
      WHERE chat_session_id=NEW.chat_session_id AND id=ANY(NEW.original_message_ids))
    OR NEW.final_batch IS DISTINCT FROM (cardinality(NEW.original_message_ids)=(SELECT count(*) FROM chat.chat_messages
      WHERE chat_session_id=NEW.chat_session_id)) THEN
    RAISE EXCEPTION 'chat archival lacks owning captures and fence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER chat_archival_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.account_deletion_chat_receipts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_chat_archival_receipt();
CREATE FUNCTION chat.require_archival_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM identity.account_deletion_chat_receipts receipt
    WHERE receipt.chat_session_id=OLD.id AND receipt.final_batch AND receipt.closed_at=OLD.closed_at
      AND receipt.closed_reason=OLD.closed_reason AND identity.chat_receipt_fence(receipt)) THEN
    RAISE EXCEPTION 'chat source requires verified archival' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER chat_archival_delete_guard BEFORE DELETE ON chat.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION chat.require_archival_before_delete();
CREATE FUNCTION chat.require_deleted_message_archival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM chat.chat_reference_anchors anchor JOIN matching.matches relationship ON relationship.id=anchor.match_id
    JOIN identity.accounts account ON account.user_id IN (relationship.user_low_id,relationship.user_high_id)
    WHERE anchor.id=OLD.chat_session_id AND account.state='deleted') AND NOT EXISTS (
    SELECT 1 FROM identity.account_deletion_chat_receipts receipt WHERE receipt.chat_session_id=OLD.chat_session_id
      AND OLD.id=ANY(receipt.original_message_ids) AND identity.chat_receipt_fence(receipt)) THEN
    RAISE EXCEPTION 'deleted chat message requires verified archival' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER deleted_message_archival_guard BEFORE DELETE ON chat.chat_messages
  FOR EACH ROW EXECUTE FUNCTION chat.require_deleted_message_archival();
CREATE FUNCTION identity.require_chat_archival_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT identity.chat_receipt_fence(NEW)
    OR EXISTS (SELECT 1 FROM chat.chat_messages WHERE id=ANY(NEW.original_message_ids))
    OR (NEW.final_batch AND (EXISTS (SELECT 1 FROM chat.chat_sessions WHERE id=NEW.chat_session_id)
      OR EXISTS (SELECT 1 FROM chat.chat_participants WHERE chat_session_id=NEW.chat_session_id)
      OR EXISTS (SELECT 1 FROM chat.chat_cleanup_checkpoints WHERE chat_session_id=NEW.chat_session_id)))
    OR (NOT NEW.final_batch AND NOT EXISTS (SELECT 1 FROM chat.chat_sessions WHERE id=NEW.chat_session_id
      AND status='closed' AND closed_at=NEW.closed_at AND closed_reason=NEW.closed_reason))
    OR NOT EXISTS (
      SELECT 1 FROM identity.account_deletion_records root JOIN platform.audit_logs audit ON audit.id=NEW.audit_id
      JOIN platform.outbox_events event ON event.id=NEW.event_id WHERE root.id=NEW.deletion_record_id
        AND audit.category='account' AND audit.event_type='account.deletion-chat-archived.v1'
        AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
        AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='chat_archived'
        AND audit.metadata_schema_version=1
        AND audit.metadata=jsonb_build_object('kind','chat_source','final',NEW.final_batch,'deletedCount',cardinality(NEW.original_message_ids))
        AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.occurred_at=NEW.archived_at
        AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
        AND event.event_type='account.deletion-chat-archived.v1' AND event.schema_version=1
        AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','chat_source','final',NEW.final_batch,'deletedCount',cardinality(NEW.original_message_ids))
        AND event.correlation_id=root.request_id AND event.causation_id=root.command_id AND event.occurred_at=NEW.archived_at
    ) THEN RAISE EXCEPTION 'chat archival chain incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER chat_archival_receipt_required AFTER INSERT ON identity.account_deletion_chat_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_chat_archival_receipt();
COMMENT ON TABLE chat.chat_reference_anchors IS 'Exact original Chat/Match identities only; never authority for new evidence or normal chat access.';
COMMENT ON TABLE identity.account_deletion_chat_receipts IS 'Immutable bounded source archival proof; no message prose, preference state, phase completion or retained-data release.';

-- Preserve every original Unmatch predicate; archived chats use their verified terminal receipt.
CREATE OR REPLACE FUNCTION matching.verify_unmatch_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_match_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA = 'matching' AND TG_TABLE_NAME = 'unmatch_records' THEN
    checked_match_id := NEW.match_id;
  ELSIF TG_TABLE_SCHEMA = 'matching' AND TG_TABLE_NAME = 'matches' THEN
    checked_match_id := NEW.id;
  ELSIF TG_TABLE_SCHEMA = 'chat' AND TG_TABLE_NAME = 'chat_sessions' THEN
    checked_match_id := NEW.match_id;
  ELSE
    SELECT id INTO checked_match_id FROM matching.matches
    WHERE user_low_id = NEW.user_low_id AND user_high_id = NEW.user_high_id;
  END IF;

  IF EXISTS (SELECT 1 FROM matching.unmatch_records WHERE match_id = checked_match_id)
    OR EXISTS (SELECT 1 FROM matching.matches WHERE id = checked_match_id AND status = 'unmatched')
  THEN
    IF NOT EXISTS (
      SELECT 1
      FROM matching.unmatch_records record
      JOIN matching.matches match ON match.id = record.match_id
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

