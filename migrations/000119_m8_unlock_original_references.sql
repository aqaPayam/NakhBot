-- Original financial identity only. Live product access still requires the raw
-- unlock, current Like/Match scope and both current Accounts.
CREATE TABLE interaction.feature_unlock_reference_anchors (
  id uuid PRIMARY KEY,
  payer_user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  payer_product_epoch integer NOT NULL CHECK(payer_product_epoch>=0),
  feature_type text NOT NULL CHECK(feature_type IN ('liked_by_profile_unlock','chat_unlock')),
  like_id uuid REFERENCES interaction.like_reference_anchors(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  match_id uuid REFERENCES matching.match_reference_anchors(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  payment_record_id uuid REFERENCES billing.payment_records(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  credit_transaction_id uuid REFERENCES billing.credit_transactions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK((feature_type='liked_by_profile_unlock' AND like_id IS NOT NULL AND match_id IS NULL)
    OR (feature_type='chat_unlock' AND match_id IS NOT NULL AND like_id IS NULL)),
  CHECK((payment_record_id IS NULL)<>(credit_transaction_id IS NULL))
);
CREATE UNIQUE INDEX unlock_reference_like_once_idx ON interaction.feature_unlock_reference_anchors(like_id) WHERE like_id IS NOT NULL;
CREATE UNIQUE INDEX unlock_reference_match_once_idx ON interaction.feature_unlock_reference_anchors(match_id) WHERE match_id IS NOT NULL;
CREATE UNIQUE INDEX unlock_reference_payment_once_idx ON interaction.feature_unlock_reference_anchors(payment_record_id) WHERE payment_record_id IS NOT NULL;
CREATE UNIQUE INDEX unlock_reference_credit_once_idx ON interaction.feature_unlock_reference_anchors(credit_transaction_id) WHERE credit_transaction_id IS NOT NULL;
CREATE INDEX unlock_reference_payer_epoch_idx ON interaction.feature_unlock_reference_anchors(payer_user_id,payer_product_epoch,id);

-- Financial source epochs, never today's Account state, identify a legacy grant.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM interaction.feature_unlocks original
    LEFT JOIN billing.credit_transactions credit ON credit.id=original.credit_transaction_id
    LEFT JOIN billing.payment_records payment ON payment.id=original.payment_record_id
    LEFT JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
    LEFT JOIN interaction.like_reference_anchors like_ref ON like_ref.id=original.like_id
    LEFT JOIN matching.match_reference_anchors match_ref ON match_ref.id=original.match_id
    WHERE COALESCE(credit.product_epoch,intent.product_epoch) IS NULL
      OR (original.credit_transaction_id IS NOT NULL AND credit.user_id IS DISTINCT FROM original.payer_user_id)
      OR (original.payment_record_id IS NOT NULL AND (payment.user_id IS DISTINCT FROM original.payer_user_id OR intent.user_id IS DISTINCT FROM original.payer_user_id))
      OR (original.like_id IS NOT NULL AND (like_ref.receiver_user_id IS DISTINCT FROM original.payer_user_id
        OR like_ref.receiver_product_epoch IS DISTINCT FROM COALESCE(credit.product_epoch,intent.product_epoch)))
      OR (original.match_id IS NOT NULL AND (match_ref.id IS NULL OR original.payer_user_id NOT IN (match_ref.user_low_id,match_ref.user_high_id)))) THEN
    RAISE EXCEPTION 'legacy unlock original owner, scope or financial life is unprovable' USING ERRCODE='23514';
  END IF;
END $$;
INSERT INTO interaction.feature_unlock_reference_anchors
SELECT original.id,original.payer_user_id,COALESCE(credit.product_epoch,intent.product_epoch),original.feature_type,
  original.like_id,original.match_id,original.payment_record_id,original.credit_transaction_id
FROM interaction.feature_unlocks original
LEFT JOIN billing.credit_transactions credit ON credit.id=original.credit_transaction_id
LEFT JOIN billing.payment_records payment ON payment.id=original.payment_record_id
LEFT JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id;

CREATE FUNCTION interaction.unlock_reference_matches_source(anchor interaction.feature_unlock_reference_anchors)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM interaction.feature_unlocks original WHERE original.id=anchor.id
    AND original.payer_user_id=anchor.payer_user_id AND original.feature_type=anchor.feature_type
    AND original.like_id IS NOT DISTINCT FROM anchor.like_id AND original.match_id IS NOT DISTINCT FROM anchor.match_id
    AND original.payment_record_id IS NOT DISTINCT FROM anchor.payment_record_id
    AND original.credit_transaction_id IS NOT DISTINCT FROM anchor.credit_transaction_id)
$$;
CREATE FUNCTION interaction.unlock_reference_financial_life_valid(anchor interaction.feature_unlock_reference_anchors)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT ((anchor.credit_transaction_id IS NOT NULL AND EXISTS(SELECT 1 FROM billing.credit_transactions credit
      WHERE credit.id=anchor.credit_transaction_id AND credit.user_id=anchor.payer_user_id AND credit.product_epoch=anchor.payer_product_epoch))
    OR (anchor.payment_record_id IS NOT NULL AND EXISTS(SELECT 1 FROM billing.payment_records payment
      JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
      WHERE payment.id=anchor.payment_record_id AND payment.user_id=anchor.payer_user_id
        AND intent.user_id=anchor.payer_user_id AND intent.product_epoch=anchor.payer_product_epoch)))
    AND ((anchor.like_id IS NOT NULL AND EXISTS(SELECT 1 FROM interaction.like_reference_anchors original
      WHERE original.id=anchor.like_id AND original.receiver_user_id=anchor.payer_user_id AND original.receiver_product_epoch=anchor.payer_product_epoch))
      OR (anchor.match_id IS NOT NULL AND EXISTS(SELECT 1 FROM matching.match_reference_anchors original
        WHERE original.id=anchor.match_id AND anchor.payer_user_id IN (original.user_low_id,original.user_high_id))))
$$;

CREATE FUNCTION interaction.guard_unlock_original_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE counterpart uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM interaction.feature_unlock_reference_anchors WHERE id=NEW.id) THEN
    RAISE EXCEPTION 'retired unlock identity cannot be reused' USING ERRCODE='23514'; END IF;
  IF NEW.like_id IS NOT NULL THEN
    SELECT sender_user_id INTO counterpart FROM interaction.likes WHERE id=NEW.like_id AND receiver_user_id=NEW.payer_user_id;
  ELSE
    SELECT CASE WHEN user_low_id=NEW.payer_user_id THEN user_high_id ELSE user_low_id END INTO counterpart
      FROM matching.matches WHERE id=NEW.match_id AND NEW.payer_user_id IN (user_low_id,user_high_id);
  END IF;
  IF counterpart IS NULL THEN RAISE EXCEPTION 'new unlock needs its original live owning scope' USING ERRCODE='23514'; END IF;
  -- Paid-action writers already own the pair before insertion. Unlock creation
  -- does not mutate Nakh counters; never acquire a counter after that pair.
  PERFORM interaction.lock_user_pair(LEAST(NEW.payer_user_id,counterpart),GREATEST(NEW.payer_user_id,counterpart));
  PERFORM id FROM identity.users WHERE id IN (NEW.payer_user_id,counterpart) ORDER BY id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id IN (NEW.payer_user_id,counterpart) ORDER BY user_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=NEW.payer_user_id AND state='active')
    OR NOT ((NEW.like_id IS NOT NULL AND EXISTS(SELECT 1 FROM interaction.current_like_lives WHERE id=NEW.like_id AND receiver_user_id=NEW.payer_user_id))
      OR (NEW.match_id IS NOT NULL AND EXISTS(SELECT 1 FROM matching.current_match_lives WHERE id=NEW.match_id AND NEW.payer_user_id IN (user_low_id,user_high_id)))) THEN
    RAISE EXCEPTION 'unlock lacks its exact current original lives' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER feature_unlock_original_source_guard BEFORE INSERT ON interaction.feature_unlocks
  FOR EACH ROW EXECUTE FUNCTION interaction.guard_unlock_original_source();

CREATE FUNCTION interaction.guard_unlock_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'unlock reference requires controlled retained release' USING ERRCODE='55000'; END IF;
  IF NOT interaction.unlock_reference_matches_source(NEW) OR NOT EXISTS(SELECT 1 FROM identity.accounts
    WHERE user_id=NEW.payer_user_id AND product_epoch=NEW.payer_product_epoch AND state='active') THEN
    RAISE EXCEPTION 'unlock reference lacks its exact admitted source and life' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER unlock_reference_guard BEFORE INSERT OR UPDATE OR DELETE ON interaction.feature_unlock_reference_anchors
  FOR EACH ROW EXECUTE FUNCTION interaction.guard_unlock_reference();
CREATE FUNCTION interaction.create_unlock_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO interaction.feature_unlock_reference_anchors
    SELECT NEW.id,NEW.payer_user_id,account.product_epoch,NEW.feature_type,NEW.like_id,NEW.match_id,NEW.payment_record_id,NEW.credit_transaction_id
    FROM identity.accounts account WHERE account.user_id=NEW.payer_user_id AND account.state='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'unlock original reference missing' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER feature_unlock_original_reference AFTER INSERT ON interaction.feature_unlocks
  FOR EACH ROW EXECUTE FUNCTION interaction.create_unlock_reference();
CREATE FUNCTION interaction.require_unlock_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE anchor interaction.feature_unlock_reference_anchors;
BEGIN
  SELECT * INTO anchor FROM interaction.feature_unlock_reference_anchors WHERE id=NEW.id;
  IF anchor.id IS NULL OR NOT interaction.unlock_reference_matches_source(anchor)
    OR NOT interaction.unlock_reference_financial_life_valid(anchor) THEN
    RAISE EXCEPTION 'unlock original reference chain incomplete' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER feature_unlock_original_reference_committed AFTER INSERT ON interaction.feature_unlocks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION interaction.require_unlock_reference();
COMMENT ON TABLE interaction.feature_unlock_reference_anchors IS
  'Minimal original funded identity and payer life; no grant status, timestamps, administrator, active access, restoration, source removal or retained release authority.';
