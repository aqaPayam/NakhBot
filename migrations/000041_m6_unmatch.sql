CREATE TABLE matching.unmatch_records (
  match_id uuid PRIMARY KEY REFERENCES matching.matches(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[a-z][a-z0-9_]{0,79}$'),
  command_id uuid NOT NULL UNIQUE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  unmatched_at timestamptz NOT NULL,
  report_window_expires_at timestamptz NOT NULL,
  CONSTRAINT unmatch_report_window_ck CHECK (
    report_window_expires_at = unmatched_at + interval '24 hours'
  )
);

CREATE UNIQUE INDEX unmatch_records_actor_idempotency_uq
  ON matching.unmatch_records (actor_user_id, idempotency_key);
CREATE INDEX unmatch_records_report_window_idx
  ON matching.unmatch_records (report_window_expires_at, match_id);

CREATE FUNCTION matching.reject_unmatch_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'unmatch records are immutable' USING ERRCODE = '55000';
END $$;

CREATE TRIGGER unmatch_records_immutable
BEFORE UPDATE OR DELETE ON matching.unmatch_records
FOR EACH ROW EXECUTE FUNCTION matching.reject_unmatch_record_change();

CREATE FUNCTION matching.verify_unmatch_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
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
      JOIN chat.chat_sessions session ON session.match_id = match.id
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

CREATE CONSTRAINT TRIGGER unmatch_record_consistent
AFTER INSERT ON matching.unmatch_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION matching.verify_unmatch_consistency();
CREATE CONSTRAINT TRIGGER unmatched_match_consistent
AFTER UPDATE ON matching.matches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.status = 'unmatched') EXECUTE FUNCTION matching.verify_unmatch_consistency();
CREATE CONSTRAINT TRIGGER unmatched_pair_consistent
AFTER UPDATE ON interaction.user_pair_states
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.state = 'unmatched') EXECUTE FUNCTION matching.verify_unmatch_consistency();
CREATE CONSTRAINT TRIGGER unmatched_chat_consistent
AFTER UPDATE ON chat.chat_sessions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.closed_reason = 'unmatch') EXECUTE FUNCTION matching.verify_unmatch_consistency();

COMMENT ON TABLE matching.unmatch_records IS
  'Immutable permanent symmetric Unmatch fact with an exact 24-hour report window.';
