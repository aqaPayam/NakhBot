-- Financial and Match identities must survive ordinary-source archival.
-- This routing change does not permit source/history removal or new grants.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM nakh.nakhes source WHERE NOT EXISTS(
    SELECT 1 FROM nakh.nakh_reference_anchors anchor
    JOIN nakh.nakh_flows flow ON flow.id=source.nakh_flow_id
    WHERE anchor.id=source.id AND anchor.nakh_flow_id=source.nakh_flow_id
      AND anchor.sender_user_id=source.sender_user_id AND anchor.receiver_user_id=source.receiver_user_id
      AND anchor.sender_product_epoch=flow.sender_product_epoch
      AND anchor.receiver_product_epoch=flow.receiver_product_epoch)
    OR NOT nakh.original_funding_life_valid(source)) THEN
    RAISE EXCEPTION 'retained Nakh routing lacks original source proof' USING ERRCODE='23514';
  END IF;
END $$;

ALTER TABLE billing.credit_transactions DROP CONSTRAINT credit_transactions_nakh_fk;
ALTER TABLE billing.credit_transactions ADD CONSTRAINT credit_transactions_nakh_fk
  FOREIGN KEY(nakh_id) REFERENCES nakh.nakh_reference_anchors(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE matching.matches DROP CONSTRAINT matches_source_nakh_fk;
ALTER TABLE matching.matches ADD CONSTRAINT matches_source_nakh_fk
  FOREIGN KEY(source_nakh_id) REFERENCES nakh.nakh_reference_anchors(id) DEFERRABLE INITIALLY DEFERRED;

-- An anchor is historical identity, never authority for a new spend or Match.
-- Check after all original source/anchor writes in the transaction are visible.
CREATE FUNCTION nakh.require_live_funded_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_id uuid; source nakh.nakhes; anchor nakh.nakh_reference_anchors;
BEGIN
  IF TG_TABLE_SCHEMA='billing' THEN source_id:=NEW.nakh_id;
  ELSE source_id:=NEW.source_nakh_id; END IF;
  IF source_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO source FROM nakh.nakhes WHERE id=source_id;
  SELECT * INTO anchor FROM nakh.nakh_reference_anchors WHERE id=source_id;
  IF source.id IS NULL OR anchor.id IS NULL
    OR anchor.nakh_flow_id IS DISTINCT FROM source.nakh_flow_id
    OR anchor.sender_user_id IS DISTINCT FROM source.sender_user_id
    OR anchor.receiver_user_id IS DISTINCT FROM source.receiver_user_id
    OR NOT EXISTS(SELECT 1 FROM nakh.nakh_flows flow WHERE flow.id=source.nakh_flow_id
      AND flow.sender_product_epoch=anchor.sender_product_epoch
      AND flow.receiver_product_epoch=anchor.receiver_product_epoch)
    OR NOT nakh.original_funding_life_valid(source) THEN
    RAISE EXCEPTION 'new Nakh reference requires its original live funded source' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_SCHEMA='billing' THEN
    IF source.funding_type<>'credits' OR source.credit_transaction_id IS DISTINCT FROM NEW.id
      OR NEW.user_id<>anchor.sender_user_id OR NEW.product_epoch<>anchor.sender_product_epoch
      OR NEW.transaction_type<>'spend_nakh' OR NEW.amount<>-2 THEN
      RAISE EXCEPTION 'new Nakh spend lacks exact original source' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.source<>'nakh_accept' OR source.status<>'accepted'
      OR NEW.user_low_id<>LEAST(anchor.sender_user_id,anchor.receiver_user_id)
      OR NEW.user_high_id<>GREATEST(anchor.sender_user_id,anchor.receiver_user_id) THEN
      RAISE EXCEPTION 'new Nakh Match lacks exact original acceptance' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER credit_original_nakh_reference AFTER INSERT ON billing.credit_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.require_live_funded_reference();
CREATE CONSTRAINT TRIGGER match_original_nakh_reference AFTER INSERT ON matching.matches
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.require_live_funded_reference();

COMMENT ON CONSTRAINT credit_transactions_nakh_fk ON billing.credit_transactions IS
  'Retained exact original Nakh identity. New spends still require their original live funded source; ordinary archival, balance reset and retained release are not authorized.';
COMMENT ON CONSTRAINT matches_source_nakh_fk ON matching.matches IS
  'Retained exact original Nakh identity. New Match creation still requires the original live accepted source; source removal remains forbidden until verified archival.';
