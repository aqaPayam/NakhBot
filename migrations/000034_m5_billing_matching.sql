ALTER TABLE nakh.nakhes
  ADD CONSTRAINT nakhes_credit_transaction_fk
  FOREIGN KEY (credit_transaction_id) REFERENCES billing.credit_transactions(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE nakh.nakhes
  ADD CONSTRAINT nakhes_payment_record_fk
  FOREIGN KEY (payment_record_id) REFERENCES billing.payment_records(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE billing.credit_transactions
  ADD CONSTRAINT credit_transactions_nakh_fk
  FOREIGN KEY (nakh_id) REFERENCES nakh.nakhes(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE matching.matches
  ADD CONSTRAINT matches_source_nakh_fk
  FOREIGN KEY (source_nakh_id) REFERENCES nakh.nakhes(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX nakhes_funding_reconciliation_idx
  ON nakh.nakhes (funding_type, sent_at, id);
CREATE INDEX pending_nakhes_settlement_idx
  ON nakh.pending_nakhes (sender_user_id, created_at, id, pending_payment_id)
  WHERE status = 'pending_payment';
CREATE INDEX matches_source_nakh_idx
  ON matching.matches (source_nakh_id)
  WHERE source = 'nakh_accept';

ALTER TABLE billing.reconciliation_anomalies
  DROP CONSTRAINT reconciliation_anomalies_entity_type_check;
ALTER TABLE billing.reconciliation_anomalies
  ADD CONSTRAINT reconciliation_anomalies_entity_type_check CHECK (entity_type IN (
    'payment_record','payment_fulfillment','credit_account','credit_transaction',
    'feature_unlock','refund_record','provider_event','nakh_flow','pending_nakh','nakh'
  ));

CREATE FUNCTION nakh.verify_nakh_funding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_nakh_id uuid;
  delivered nakh.nakhes%ROWTYPE;
  proof_count integer;
BEGIN
  IF TG_TABLE_SCHEMA = 'nakh' THEN
    checked_nakh_id := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME = 'credit_transactions' THEN
    checked_nakh_id := COALESCE(NEW.nakh_id, OLD.nakh_id);
  ELSE
    SELECT id INTO checked_nakh_id FROM nakh.nakhes
      WHERE payment_record_id = COALESCE(NEW.id, OLD.id);
  END IF;
  IF checked_nakh_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO delivered FROM nakh.nakhes WHERE id = checked_nakh_id;
  IF delivered.id IS NULL THEN RETURN NULL; END IF;

  IF delivered.funding_type = 'credits' THEN
    SELECT count(*) INTO proof_count FROM billing.credit_transactions credit
      WHERE credit.id = delivered.credit_transaction_id
        AND credit.nakh_id = delivered.id
        AND credit.user_id = delivered.sender_user_id
        AND credit.transaction_type = 'spend_nakh'
        AND credit.amount = -2
        AND credit.payment_record_id IS NULL
        AND credit.feature_unlock_id IS NULL
        AND (
          credit.pending_payment_id IS NULL
          OR EXISTS (
            SELECT 1 FROM nakh.pending_nakhes pending_nakh
            WHERE pending_nakh.pending_payment_id = credit.pending_payment_id
              AND pending_nakh.nakh_flow_id = delivered.nakh_flow_id
              AND pending_nakh.status = 'paid_and_sent'
          )
        );
  ELSE
    SELECT count(*) INTO proof_count FROM billing.payment_records payment
      JOIN billing.pending_payments pending ON pending.id = payment.pending_payment_id
      WHERE payment.id = delivered.payment_record_id
        AND payment.user_id = delivered.sender_user_id
        AND payment.payment_type = 'pay_pending_action'
        AND payment.paid_action_reason = 'send_nakh'
        AND payment.status = 'paid' AND payment.stars_amount = 2
        AND pending.user_id = delivered.sender_user_id
        AND pending.reason = 'send_nakh' AND pending.target_type = 'pending_nakh'
        AND pending.status = 'paid' AND pending.required_stars = 2
        AND EXISTS (
          SELECT 1 FROM nakh.pending_nakhes pending_nakh
          WHERE pending_nakh.id = pending.target_id
            AND pending_nakh.pending_payment_id = pending.id
            AND pending_nakh.nakh_flow_id = delivered.nakh_flow_id
            AND pending_nakh.status = 'paid_and_sent'
        );
  END IF;
  IF proof_count <> 1 THEN
    RAISE EXCEPTION 'delivered Nakh funding proof is missing or inconsistent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER nakhes_funding_guard
AFTER INSERT OR UPDATE ON nakh.nakhes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_nakh_funding();
CREATE CONSTRAINT TRIGGER credit_transactions_nakh_guard
AFTER INSERT OR UPDATE ON billing.credit_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_nakh_funding();
CREATE CONSTRAINT TRIGGER payment_records_nakh_guard
AFTER INSERT OR UPDATE ON billing.payment_records
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_nakh_funding();

CREATE FUNCTION nakh.verify_nakh_match() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  checked_nakh_id uuid;
  delivered nakh.nakhes%ROWTYPE;
  matching_count integer;
BEGIN
  IF TG_TABLE_SCHEMA = 'nakh' THEN
    checked_nakh_id := COALESCE(NEW.id, OLD.id);
  ELSE
    checked_nakh_id := COALESCE(NEW.source_nakh_id, OLD.source_nakh_id);
  END IF;
  IF checked_nakh_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO delivered FROM nakh.nakhes WHERE id = checked_nakh_id;
  IF delivered.id IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO matching_count FROM matching.matches match
    WHERE match.source = 'nakh_accept' AND match.source_nakh_id = delivered.id
      AND match.user_low_id = LEAST(delivered.sender_user_id, delivered.receiver_user_id)
      AND match.user_high_id = GREATEST(delivered.sender_user_id, delivered.receiver_user_id);
  IF (delivered.status = 'accepted' AND matching_count <> 1)
    OR (delivered.status <> 'accepted' AND matching_count <> 0) THEN
    RAISE EXCEPTION 'Nakh acceptance and Match source diverged' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER nakhes_match_guard
AFTER INSERT OR UPDATE ON nakh.nakhes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_nakh_match();
CREATE CONSTRAINT TRIGGER matches_nakh_source_guard
AFTER INSERT OR UPDATE ON matching.matches
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nakh.verify_nakh_match();

COMMENT ON CONSTRAINT credit_transactions_nakh_fk ON billing.credit_transactions IS
  'Deferred because one transaction creates the immutable spend and delivered Nakh together.';
COMMENT ON CONSTRAINT matches_source_nakh_fk ON matching.matches IS
  'Nakh acceptance and Match creation commit together under deferred cross-module verification.';
