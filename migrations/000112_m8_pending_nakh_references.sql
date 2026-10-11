-- Original pending identities survive later body archival, but grant no new
-- delivery, credit, refund, source deletion, phase completion or fresh Return.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM nakh.pending_nakhes pending
    LEFT JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
    LEFT JOIN billing.pending_payments intent ON intent.id=pending.pending_payment_id
    WHERE flow.id IS NULL OR intent.id IS NULL
      OR pending.sender_user_id IS DISTINCT FROM flow.sender_user_id
      OR intent.user_id IS DISTINCT FROM pending.sender_user_id
      OR intent.product_epoch IS DISTINCT FROM flow.sender_product_epoch
      OR intent.reason IS DISTINCT FROM 'send_nakh'
      OR intent.target_type IS DISTINCT FROM 'pending_nakh'
      OR intent.target_id IS DISTINCT FROM pending.id
      OR intent.expires_at IS DISTINCT FROM pending.expires_at
      OR EXISTS(SELECT 1 FROM nakh.nakh_reference_anchors delivered WHERE delivered.nakh_flow_id=flow.id
        AND (delivered.sender_user_id IS DISTINCT FROM flow.sender_user_id
          OR delivered.receiver_user_id IS DISTINCT FROM flow.receiver_user_id
          OR delivered.sender_product_epoch IS DISTINCT FROM flow.sender_product_epoch
          OR delivered.receiver_product_epoch IS DISTINCT FROM flow.receiver_product_epoch))) THEN
    RAISE EXCEPTION 'legacy pending Nakh original identity is unproven' USING ERRCODE='23514';
  END IF;
END $$;

CREATE TABLE nakh.pending_nakh_reference_anchors (
  id uuid PRIMARY KEY,
  nakh_flow_id uuid NOT NULL UNIQUE,
  sender_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  receiver_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  sender_product_epoch integer NOT NULL CHECK(sender_product_epoch>=0),
  receiver_product_epoch integer NOT NULL CHECK(receiver_product_epoch>=0),
  pending_payment_id uuid NOT NULL UNIQUE REFERENCES billing.pending_payments(id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK(sender_user_id<>receiver_user_id)
);
CREATE INDEX pending_nakh_reference_sender_idx ON nakh.pending_nakh_reference_anchors(sender_user_id,id);
CREATE INDEX pending_nakh_reference_receiver_idx ON nakh.pending_nakh_reference_anchors(receiver_user_id,id);
INSERT INTO nakh.pending_nakh_reference_anchors
SELECT pending.id,pending.nakh_flow_id,pending.sender_user_id,flow.receiver_user_id,
  flow.sender_product_epoch,flow.receiver_product_epoch,pending.pending_payment_id
FROM nakh.pending_nakhes pending JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id;

CREATE FUNCTION nakh.original_pending_reference_valid(subject uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.pending_nakhes pending
    JOIN nakh.pending_nakh_reference_anchors anchor ON anchor.id=pending.id
    JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
    JOIN billing.pending_payments intent ON intent.id=pending.pending_payment_id
    WHERE pending.id=subject AND anchor.nakh_flow_id=flow.id
      AND anchor.sender_user_id=pending.sender_user_id AND flow.sender_user_id=pending.sender_user_id
      AND anchor.receiver_user_id=flow.receiver_user_id
      AND anchor.sender_product_epoch=flow.sender_product_epoch
      AND anchor.receiver_product_epoch=flow.receiver_product_epoch
      AND anchor.pending_payment_id=intent.id
      AND intent.user_id=pending.sender_user_id AND intent.product_epoch=flow.sender_product_epoch
      AND intent.reason='send_nakh' AND intent.target_type='pending_nakh' AND intent.target_id=pending.id
      AND intent.expires_at=pending.expires_at)
$$;

CREATE FUNCTION nakh.guard_pending_original_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'pending Nakh reference requires controlled retained release' USING ERRCODE='55000';
  END IF;
  -- The intent may be written later in the same creation transaction. Its
  -- complete binding is checked by the deferred trigger and deferred FK.
  IF NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes pending JOIN nakh.nakh_flows flow ON flow.id=pending.nakh_flow_id
    WHERE pending.id=NEW.id AND pending.nakh_flow_id=NEW.nakh_flow_id
      AND pending.sender_user_id=NEW.sender_user_id AND flow.sender_user_id=NEW.sender_user_id
      AND flow.receiver_user_id=NEW.receiver_user_id AND pending.pending_payment_id=NEW.pending_payment_id
      AND flow.sender_product_epoch=NEW.sender_product_epoch AND flow.receiver_product_epoch=NEW.receiver_product_epoch) THEN
    RAISE EXCEPTION 'pending Nakh reference lacks its exact original source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pending_nakh_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON nakh.pending_nakh_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_pending_original_reference();

CREATE FUNCTION nakh.require_pending_original_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT nakh.original_pending_reference_valid(NEW.id) THEN
    RAISE EXCEPTION 'pending Nakh original reference chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pending_nakh_reference_committed AFTER INSERT ON nakh.pending_nakh_reference_anchors
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.require_pending_original_reference();
CREATE CONSTRAINT TRIGGER pending_nakh_original_reference_required AFTER INSERT OR UPDATE ON nakh.pending_nakhes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.require_pending_original_reference();

CREATE FUNCTION nakh.create_pending_original_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO nakh.pending_nakh_reference_anchors
    SELECT NEW.id,NEW.nakh_flow_id,NEW.sender_user_id,flow.receiver_user_id,
      flow.sender_product_epoch,flow.receiver_product_epoch,NEW.pending_payment_id
    FROM nakh.nakh_flows flow WHERE flow.id=NEW.nakh_flow_id
    ON CONFLICT(id) DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER pending_nakh_original_reference AFTER INSERT ON nakh.pending_nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.create_pending_original_reference();

CREATE FUNCTION nakh.reject_pending_original_identity_reuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM nakh.pending_nakh_reference_anchors anchor
    WHERE (anchor.id=NEW.id OR anchor.nakh_flow_id=NEW.nakh_flow_id OR anchor.pending_payment_id=NEW.pending_payment_id)
      AND NOT EXISTS(SELECT 1 FROM nakh.pending_nakhes source WHERE source.id=anchor.id)) THEN
    RAISE EXCEPTION 'pending Nakh original identity cannot be reused' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_pending_nakh_original_identity_guard BEFORE INSERT ON nakh.pending_nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.reject_pending_original_identity_reuse();

COMMENT ON TABLE nakh.pending_nakh_reference_anchors IS
  'Minimal immutable original pending identity, intent and participant lives; no body, action keys, lifecycle grants, deletion authority or retained release. Deploy before later pending archival.';
