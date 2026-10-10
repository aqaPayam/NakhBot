-- Original funding must belong to the original sender life, independently of
-- current Account state. Existing complete funding/receipt guards remain.
CREATE FUNCTION nakh.original_funding_life_valid(source nakh.nakhes) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM nakh.nakh_flows flow
    WHERE flow.id=source.nakh_flow_id AND flow.sender_user_id=source.sender_user_id
      AND flow.receiver_user_id=source.receiver_user_id
      AND ((source.funding_type='credits' AND EXISTS(SELECT 1 FROM billing.credit_transactions credit
        WHERE credit.id=source.credit_transaction_id AND credit.nakh_id=source.id
          AND credit.user_id=source.sender_user_id AND credit.product_epoch=flow.sender_product_epoch))
        OR (source.funding_type='telegram_stars' AND EXISTS(SELECT 1 FROM billing.payment_records payment
          JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
          WHERE payment.id=source.payment_record_id AND payment.user_id=source.sender_user_id
            AND intent.user_id=source.sender_user_id
            AND intent.product_epoch=flow.sender_product_epoch))))
$$;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM nakh.nakhes source WHERE NOT nakh.original_funding_life_valid(source)) THEN
    RAISE EXCEPTION 'legacy Nakh original funding life is unproven' USING ERRCODE='23514';
  END IF;
END $$;
CREATE FUNCTION nakh.require_original_funding_life() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT nakh.original_funding_life_valid(NEW) THEN
    RAISE EXCEPTION 'Nakh original funding life is unproven' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER nakh_original_funding_life_required AFTER INSERT OR UPDATE ON nakh.nakhes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nakh.require_original_funding_life();
COMMENT ON FUNCTION nakh.original_funding_life_valid(nakh.nakhes) IS
  'Read-only exact original funding ownership/life proof; existing money/receipt/source guards remain. No new spend, archival, return, projection reset or retained release authority.';
