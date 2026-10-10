-- Every delivered Nakh has an original ledger spend or captured-charge chain.
-- Retain only identity/owning lives; all ordinary text and lifecycle stay live.
CREATE TABLE nakh.nakh_reference_anchors (
  id uuid PRIMARY KEY,
  nakh_flow_id uuid NOT NULL,
  sender_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  receiver_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  sender_product_epoch integer NOT NULL CHECK(sender_product_epoch>=0),
  receiver_product_epoch integer NOT NULL CHECK(receiver_product_epoch>=0),
  CHECK(sender_user_id<>receiver_user_id)
);
CREATE INDEX nakh_reference_sender_idx ON nakh.nakh_reference_anchors(sender_user_id,id);
CREATE INDEX nakh_reference_receiver_idx ON nakh.nakh_reference_anchors(receiver_user_id,id);
INSERT INTO nakh.nakh_reference_anchors
SELECT source.id,source.nakh_flow_id,source.sender_user_id,source.receiver_user_id,
  flow.sender_product_epoch,flow.receiver_product_epoch
FROM nakh.nakhes source JOIN nakh.nakh_flows flow ON flow.id=source.nakh_flow_id;

CREATE FUNCTION nakh.guard_original_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'original Nakh reference requires controlled retained release' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM nakh.nakhes source JOIN nakh.nakh_flows flow ON flow.id=source.nakh_flow_id
    WHERE source.id=NEW.id AND source.nakh_flow_id=NEW.nakh_flow_id
      AND source.sender_user_id=NEW.sender_user_id AND source.receiver_user_id=NEW.receiver_user_id
      AND flow.sender_product_epoch=NEW.sender_product_epoch AND flow.receiver_product_epoch=NEW.receiver_product_epoch) THEN
    RAISE EXCEPTION 'Nakh reference lacks its exact original source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nakh_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON nakh.nakh_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_original_reference();
CREATE CONSTRAINT TRIGGER nakh_reference_committed AFTER INSERT ON nakh.nakh_reference_anchors
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.guard_original_reference();

CREATE FUNCTION nakh.create_original_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO nakh.nakh_reference_anchors
    SELECT NEW.id,NEW.nakh_flow_id,NEW.sender_user_id,NEW.receiver_user_id,
      flow.sender_product_epoch,flow.receiver_product_epoch
    FROM nakh.nakh_flows flow WHERE flow.id=NEW.nakh_flow_id
    ON CONFLICT(id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER nakh_original_reference AFTER INSERT ON nakh.nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.create_original_reference();
CREATE FUNCTION nakh.require_original_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM nakh.nakh_reference_anchors anchor
    JOIN nakh.nakh_flows flow ON flow.id=NEW.nakh_flow_id
    WHERE anchor.id=NEW.id AND anchor.nakh_flow_id=NEW.nakh_flow_id
      AND anchor.sender_user_id=NEW.sender_user_id AND anchor.receiver_user_id=NEW.receiver_user_id
      AND anchor.sender_product_epoch=flow.sender_product_epoch AND anchor.receiver_product_epoch=flow.receiver_product_epoch) THEN
    RAISE EXCEPTION 'original Nakh reference chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER nakh_original_reference_required AFTER INSERT ON nakh.nakhes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.require_original_reference();
CREATE FUNCTION nakh.reject_original_identity_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM nakh.nakh_reference_anchors WHERE id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM nakh.nakhes WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'original referenced Nakh identity cannot be reused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nakh_original_identity_guard BEFORE INSERT ON nakh.nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.reject_original_identity_reuse();
COMMENT ON TABLE nakh.nakh_reference_anchors IS
  'Minimal original funded Nakh identity and owning lives; no prose, status, deadlines, funding reset, product access, source archival, fresh return or retained release authority. Original source foreign keys remain unchanged.';
