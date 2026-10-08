-- Identity only: no source Likes/Nakh, product status, timestamps or preferences.
CREATE TABLE matching.match_reference_anchors (
  id uuid PRIMARY KEY,
  user_low_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  user_high_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  UNIQUE(user_low_id,user_high_id),
  CHECK(user_low_id<user_high_id)
);
CREATE INDEX match_reference_anchors_high_idx ON matching.match_reference_anchors(user_high_id,id);
INSERT INTO matching.match_reference_anchors SELECT id,user_low_id,user_high_id FROM matching.matches;

CREATE FUNCTION matching.guard_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'match reference requires controlled release' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM matching.matches source
    JOIN identity.accounts low_account ON low_account.user_id=source.user_low_id
    JOIN identity.accounts high_account ON high_account.user_id=source.user_high_id
    WHERE source.id=NEW.id AND source.user_low_id=NEW.user_low_id AND source.user_high_id=NEW.user_high_id
      AND low_account.state<>'deleted' AND high_account.state<>'deleted') THEN
    RAISE EXCEPTION 'match reference lacks owning live source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER match_reference_anchor_guard BEFORE INSERT OR UPDATE OR DELETE ON matching.match_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION matching.guard_reference_anchor();
CREATE FUNCTION matching.create_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO matching.match_reference_anchors(id,user_low_id,user_high_id)
    VALUES(NEW.id,NEW.user_low_id,NEW.user_high_id);
  RETURN NULL;
END $$;
CREATE TRIGGER match_reference_anchor_required AFTER INSERT ON matching.matches
  FOR EACH ROW EXECUTE FUNCTION matching.create_reference_anchor();
CREATE FUNCTION matching.require_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM matching.match_reference_anchors
    WHERE id=NEW.id AND user_low_id=NEW.user_low_id AND user_high_id=NEW.user_high_id) THEN
    RAISE EXCEPTION 'match reference chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER match_reference_anchor_committed AFTER INSERT ON matching.matches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION matching.require_reference_anchor();

-- Move retained identities to minimal anchors. Live sessions, participants and
-- feature unlocks still reference the product source. No archival is authorized.
ALTER TABLE chat.chat_reference_anchors DROP CONSTRAINT chat_reference_anchors_match_id_fkey;
ALTER TABLE chat.chat_reference_anchors ADD CONSTRAINT chat_reference_anchors_match_id_fkey
  FOREIGN KEY(match_id) REFERENCES matching.match_reference_anchors(id) ON DELETE RESTRICT;
ALTER TABLE matching.unmatch_records DROP CONSTRAINT unmatch_records_match_id_fkey;
ALTER TABLE matching.unmatch_records ADD CONSTRAINT unmatch_records_match_id_fkey
  FOREIGN KEY(match_id) REFERENCES matching.match_reference_anchors(id) ON DELETE RESTRICT;

-- Preserve the former live-source FK protection until verified Match archival
-- can replace it. An anchor alone cannot justify losing a report source.
CREATE FUNCTION matching.require_archival_before_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM chat.chat_reference_anchors WHERE match_id=OLD.id)
    OR EXISTS (SELECT 1 FROM matching.unmatch_records WHERE match_id=OLD.id) THEN
    RAISE EXCEPTION 'match source requires verified archival' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER match_archival_delete_guard BEFORE DELETE ON matching.matches
  FOR EACH ROW EXECUTE FUNCTION matching.require_archival_before_delete();
COMMENT ON TABLE matching.match_reference_anchors IS
  'Exact original Match and normalized participants only; no product access, new report authority, archival or retained-data release.';
