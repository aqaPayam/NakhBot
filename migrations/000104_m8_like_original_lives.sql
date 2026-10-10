-- Legacy Like ownership is provable only before the first verified fresh return.
-- Preserve all original product fields and reject an ambiguous legacy life.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM interaction.likes source
    LEFT JOIN identity.accounts sender ON sender.user_id=source.sender_user_id
    LEFT JOIN identity.accounts receiver ON receiver.user_id=source.receiver_user_id
    WHERE sender.product_epoch IS DISTINCT FROM 0 OR receiver.product_epoch IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'legacy Like lacks exact original account lives' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE interaction.likes ADD COLUMN sender_product_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE interaction.likes ADD COLUMN receiver_product_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE interaction.likes ADD CONSTRAINT likes_original_lives_ck
  CHECK(sender_product_epoch>=0 AND receiver_product_epoch>=0);

-- Retain only identities actually referenced by a Match or funded unlock.
-- No status, access grant, timestamp, preference or transcript is retained here.
CREATE TABLE interaction.like_reference_anchors (
  id uuid PRIMARY KEY,
  sender_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  receiver_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  sender_product_epoch integer NOT NULL CHECK(sender_product_epoch>=0),
  receiver_product_epoch integer NOT NULL CHECK(receiver_product_epoch>=0),
  CHECK(sender_user_id<>receiver_user_id)
);
CREATE INDEX like_reference_anchors_sender_idx ON interaction.like_reference_anchors(sender_user_id,id);
CREATE INDEX like_reference_anchors_receiver_idx ON interaction.like_reference_anchors(receiver_user_id,id);
INSERT INTO interaction.like_reference_anchors
SELECT source.id,source.sender_user_id,source.receiver_user_id,source.sender_product_epoch,source.receiver_product_epoch
FROM interaction.likes source
WHERE EXISTS(SELECT 1 FROM matching.matches original WHERE source.id IN (original.source_like_a_id,original.source_like_b_id))
  OR EXISTS(SELECT 1 FROM interaction.feature_unlocks original WHERE original.like_id=source.id);

CREATE FUNCTION interaction.guard_like_original_lives() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sender_epoch integer; receiver_epoch integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.sender_product_epoch<>OLD.sender_product_epoch OR NEW.receiver_product_epoch<>OLD.receiver_product_epoch THEN
      RAISE EXCEPTION 'original Like lives are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  -- Stable identities precede sorted Accounts, as in the existing pair writers.
  PERFORM 1 FROM identity.users WHERE id IN (NEW.sender_user_id,NEW.receiver_user_id) ORDER BY id FOR NO KEY UPDATE;
  PERFORM 1 FROM identity.accounts WHERE user_id IN (NEW.sender_user_id,NEW.receiver_user_id) ORDER BY user_id FOR UPDATE;
  SELECT product_epoch INTO sender_epoch FROM identity.accounts WHERE user_id=NEW.sender_user_id AND state<>'deleted';
  SELECT product_epoch INTO receiver_epoch FROM identity.accounts WHERE user_id=NEW.receiver_user_id AND state<>'deleted';
  IF sender_epoch IS NULL OR receiver_epoch IS NULL
    OR NEW.sender_product_epoch IS DISTINCT FROM sender_epoch
    OR NEW.receiver_product_epoch IS DISTINCT FROM receiver_epoch THEN
    RAISE EXCEPTION 'Like requires its exact current owning lives' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM interaction.like_reference_anchors WHERE id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM interaction.likes WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'original referenced Like identity cannot be reused' USING ERRCODE='23514';
  END IF;
  NEW.sender_product_epoch:=sender_epoch;
  NEW.receiver_product_epoch:=receiver_epoch;
  RETURN NEW;
END $$;
CREATE TRIGGER likes_original_lives_guard BEFORE INSERT OR UPDATE ON interaction.likes
  FOR EACH ROW EXECUTE FUNCTION interaction.guard_like_original_lives();

CREATE FUNCTION interaction.guard_like_reference_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'original Like reference requires controlled retained release' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM interaction.likes source WHERE source.id=NEW.id
      AND source.sender_user_id=NEW.sender_user_id AND source.receiver_user_id=NEW.receiver_user_id
      AND source.sender_product_epoch=NEW.sender_product_epoch AND source.receiver_product_epoch=NEW.receiver_product_epoch
      AND (EXISTS(SELECT 1 FROM matching.matches original WHERE source.id IN (original.source_like_a_id,original.source_like_b_id))
        OR EXISTS(SELECT 1 FROM interaction.feature_unlocks original WHERE original.like_id=source.id))) THEN
    RAISE EXCEPTION 'Like reference lacks its exact original referenced source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER like_reference_anchor_guard BEFORE INSERT OR UPDATE OR DELETE ON interaction.like_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION interaction.guard_like_reference_anchor();
CREATE CONSTRAINT TRIGGER like_reference_anchor_committed AFTER INSERT ON interaction.like_reference_anchors
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION interaction.guard_like_reference_anchor();

CREATE FUNCTION interaction.create_original_like_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_ids uuid[];
BEGIN
  IF TG_TABLE_SCHEMA='matching' THEN
    source_ids:=ARRAY[NEW.source_like_a_id,NEW.source_like_b_id];
  ELSE
    source_ids:=ARRAY[NEW.like_id];
  END IF;
  INSERT INTO interaction.like_reference_anchors
    SELECT source.id,source.sender_user_id,source.receiver_user_id,source.sender_product_epoch,source.receiver_product_epoch
    FROM interaction.likes source WHERE source.id=ANY(source_ids)
    ON CONFLICT(id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER match_original_like_references AFTER INSERT ON matching.matches
  FOR EACH ROW EXECUTE FUNCTION interaction.create_original_like_references();
CREATE TRIGGER unlock_original_like_reference AFTER INSERT ON interaction.feature_unlocks
  FOR EACH ROW EXECUTE FUNCTION interaction.create_original_like_references();

CREATE FUNCTION interaction.require_original_like_references() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_ids uuid[];
BEGIN
  IF TG_TABLE_SCHEMA='matching' THEN source_ids:=ARRAY[NEW.source_like_a_id,NEW.source_like_b_id];
  ELSE source_ids:=ARRAY[NEW.like_id]; END IF;
  IF EXISTS(SELECT 1 FROM interaction.likes source LEFT JOIN interaction.like_reference_anchors anchor ON anchor.id=source.id
    WHERE source.id=ANY(source_ids)
      AND (anchor.sender_user_id IS DISTINCT FROM source.sender_user_id OR anchor.receiver_user_id IS DISTINCT FROM source.receiver_user_id
        OR anchor.sender_product_epoch IS DISTINCT FROM source.sender_product_epoch OR anchor.receiver_product_epoch IS DISTINCT FROM source.receiver_product_epoch)) THEN
    RAISE EXCEPTION 'original Like reference chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER match_original_like_references_committed AFTER INSERT ON matching.matches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION interaction.require_original_like_references();
CREATE CONSTRAINT TRIGGER unlock_original_like_reference_committed AFTER INSERT ON interaction.feature_unlocks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION interaction.require_original_like_references();
COMMENT ON TABLE interaction.like_reference_anchors IS
  'Exact original Like ownership/lives for existing Match or funded-unlock references only; no access, source archival, fresh return or retained release authority. Original live-source foreign keys remain unchanged.';
