-- Keep only original directional identity and participant lives before later
-- ordinary Flow archival. This migration grants no removal or fresh Return.
DO $$ BEGIN
  IF EXISTS(
    SELECT 1 FROM (
      SELECT nakh_flow_id,sender_user_id,receiver_user_id,sender_product_epoch,receiver_product_epoch
      FROM nakh.nakh_reference_anchors
      UNION ALL
      SELECT nakh_flow_id,sender_user_id,receiver_user_id,sender_product_epoch,receiver_product_epoch
      FROM nakh.pending_nakh_reference_anchors
    ) anchor LEFT JOIN nakh.nakh_flows flow ON flow.id=anchor.nakh_flow_id
    WHERE flow.id IS NULL OR flow.sender_user_id IS DISTINCT FROM anchor.sender_user_id
      OR flow.receiver_user_id IS DISTINCT FROM anchor.receiver_user_id
      OR flow.sender_product_epoch IS DISTINCT FROM anchor.sender_product_epoch
      OR flow.receiver_product_epoch IS DISTINCT FROM anchor.receiver_product_epoch
  ) THEN
    RAISE EXCEPTION 'legacy Flow original references disagree' USING ERRCODE='23514';
  END IF;
END $$;

CREATE TABLE nakh.flow_reference_anchors (
  id uuid PRIMARY KEY,
  sender_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  receiver_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  sender_product_epoch integer NOT NULL CHECK(sender_product_epoch>=0),
  receiver_product_epoch integer NOT NULL CHECK(receiver_product_epoch>=0),
  CHECK(sender_user_id<>receiver_user_id),
  UNIQUE(sender_user_id,receiver_user_id,sender_product_epoch,receiver_product_epoch)
);
CREATE INDEX flow_reference_receiver_idx ON nakh.flow_reference_anchors(receiver_user_id,id);
INSERT INTO nakh.flow_reference_anchors
SELECT id,sender_user_id,receiver_user_id,sender_product_epoch,receiver_product_epoch FROM nakh.nakh_flows;

CREATE FUNCTION nakh.original_flow_reference_valid(subject uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.nakh_flows flow JOIN nakh.flow_reference_anchors anchor ON anchor.id=flow.id
    WHERE flow.id=subject AND anchor.sender_user_id=flow.sender_user_id
      AND anchor.receiver_user_id=flow.receiver_user_id
      AND anchor.sender_product_epoch=flow.sender_product_epoch
      AND anchor.receiver_product_epoch=flow.receiver_product_epoch)
$$;

CREATE FUNCTION nakh.guard_flow_original_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Flow reference requires controlled retained release' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM nakh.nakh_flows flow WHERE flow.id=NEW.id
      AND flow.sender_user_id=NEW.sender_user_id AND flow.receiver_user_id=NEW.receiver_user_id
      AND flow.sender_product_epoch=NEW.sender_product_epoch AND flow.receiver_product_epoch=NEW.receiver_product_epoch) THEN
    RAISE EXCEPTION 'Flow reference lacks its exact original source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER flow_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON nakh.flow_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_flow_original_reference();

CREATE FUNCTION nakh.require_flow_original_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT nakh.original_flow_reference_valid(NEW.id) THEN
    RAISE EXCEPTION 'Flow original reference chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER flow_reference_committed AFTER INSERT ON nakh.flow_reference_anchors
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.require_flow_original_reference();
CREATE CONSTRAINT TRIGGER flow_original_reference_required AFTER INSERT ON nakh.nakh_flows
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.require_flow_original_reference();

CREATE FUNCTION nakh.create_flow_original_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO nakh.flow_reference_anchors
    VALUES(NEW.id,NEW.sender_user_id,NEW.receiver_user_id,NEW.sender_product_epoch,NEW.receiver_product_epoch);
  RETURN NULL;
END $$;
CREATE TRIGGER flow_original_reference AFTER INSERT ON nakh.nakh_flows
  FOR EACH ROW EXECUTE FUNCTION nakh.create_flow_original_reference();

CREATE FUNCTION nakh.reject_flow_original_identity_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM nakh.flow_reference_anchors WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'original referenced Flow identity cannot be reused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_flow_original_identity_guard BEFORE INSERT ON nakh.nakh_flows
  FOR EACH ROW EXECUTE FUNCTION nakh.reject_flow_original_identity_reuse();

COMMENT ON TABLE nakh.flow_reference_anchors IS
  'Minimal immutable original Flow identity and participant lives; no text, timestamp, action key, funding grant, archival, phase completion, fresh Return or retained release authority.';
