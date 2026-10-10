-- Initial-life provenance is added without changing any original Nakh text,
-- funding, status, version or timestamp. Ambiguous prior return fails closed.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM nakh.nakh_flows flow
    LEFT JOIN identity.accounts sender ON sender.user_id=flow.sender_user_id
    LEFT JOIN identity.accounts receiver ON receiver.user_id=flow.receiver_user_id
    WHERE sender.product_epoch IS DISTINCT FROM 0 OR receiver.product_epoch IS DISTINCT FROM 0) THEN
    RAISE EXCEPTION 'legacy Nakh flow lacks exact original lives' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE nakh.nakh_flows ADD COLUMN sender_product_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE nakh.nakh_flows ADD COLUMN receiver_product_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE nakh.nakh_flows ADD CONSTRAINT nakh_flow_original_lives_ck
  CHECK(sender_product_epoch>=0 AND receiver_product_epoch>=0);

-- Set joins expose current scope without a per-row scalar permission function.
-- This is a derived product read, not a retained entity or return authority.
CREATE VIEW nakh.current_flow_lives AS
SELECT flow.* FROM nakh.nakh_flows flow
JOIN identity.accounts sender ON sender.user_id=flow.sender_user_id
JOIN identity.accounts receiver ON receiver.user_id=flow.receiver_user_id
WHERE sender.state<>'deleted' AND receiver.state<>'deleted'
  AND sender.product_epoch=flow.sender_product_epoch
  AND receiver.product_epoch=flow.receiver_product_epoch;

CREATE FUNCTION nakh.guard_flow_original_lives() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sender_epoch integer; receiver_epoch integer;
BEGIN
  PERFORM 1 FROM identity.users WHERE id IN (NEW.sender_user_id,NEW.receiver_user_id) ORDER BY id FOR NO KEY UPDATE;
  PERFORM 1 FROM identity.accounts WHERE user_id IN (NEW.sender_user_id,NEW.receiver_user_id) ORDER BY user_id FOR UPDATE;
  SELECT product_epoch INTO sender_epoch FROM identity.accounts WHERE user_id=NEW.sender_user_id AND state<>'deleted';
  SELECT product_epoch INTO receiver_epoch FROM identity.accounts WHERE user_id=NEW.receiver_user_id AND state<>'deleted';
  IF sender_epoch IS NULL OR receiver_epoch IS NULL
    OR NEW.sender_product_epoch IS DISTINCT FROM sender_epoch OR NEW.receiver_product_epoch IS DISTINCT FROM receiver_epoch THEN
    RAISE EXCEPTION 'Nakh flow requires exact current owning lives' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER nakh_flow_original_lives_guard BEFORE INSERT ON nakh.nakh_flows
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_flow_original_lives();

CREATE FUNCTION nakh.guard_product_original_flow() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original nakh.nakh_flows;
BEGIN
  SELECT * INTO original FROM nakh.nakh_flows WHERE id=NEW.nakh_flow_id;
  IF original.id IS NULL OR original.sender_user_id IS DISTINCT FROM NEW.sender_user_id THEN
    RAISE EXCEPTION 'Nakh lacks its original owning flow' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM identity.users WHERE id IN (original.sender_user_id,original.receiver_user_id) ORDER BY id FOR NO KEY UPDATE;
  PERFORM 1 FROM identity.accounts WHERE user_id IN (original.sender_user_id,original.receiver_user_id) ORDER BY user_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM nakh.current_flow_lives WHERE id=original.id) THEN
    RAISE EXCEPTION 'Nakh requires exact current original lives' USING ERRCODE='40001';
  END IF;
  IF TG_TABLE_NAME='nakhes' THEN
    IF NEW.receiver_user_id IS DISTINCT FROM original.receiver_user_id THEN
      RAISE EXCEPTION 'delivered Nakh receiver differs from its original flow' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pending_nakh_original_lives_guard BEFORE INSERT ON nakh.pending_nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_product_original_flow();
CREATE TRIGGER delivered_nakh_original_lives_guard BEFORE INSERT ON nakh.nakhes
  FOR EACH ROW EXECUTE FUNCTION nakh.guard_product_original_flow();
-- Preserve the original deferred intent/source insertion contract.
CREATE FUNCTION nakh.require_pending_original_funding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM nakh.nakh_flows flow
    JOIN billing.pending_payments intent ON intent.id=NEW.pending_payment_id
    WHERE flow.id=NEW.nakh_flow_id AND flow.sender_user_id=NEW.sender_user_id
      AND intent.user_id=flow.sender_user_id AND intent.product_epoch=flow.sender_product_epoch) THEN
    RAISE EXCEPTION 'pending Nakh funding differs from its original sender life' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pending_nakh_original_funding_required AFTER INSERT ON nakh.pending_nakhes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.require_pending_original_funding();
COMMENT ON VIEW nakh.current_flow_lives IS
  'Original Nakh flow identity/lives joined to current owning Accounts; no archival, retained release, fresh return or renewed funding authority.';
