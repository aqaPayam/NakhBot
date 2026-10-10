-- Preserve every legacy financial fact in the initial product life. This fence
-- does not reset a balance, partition the ledger or authorize fresh return.
ALTER TABLE billing.credit_accounts ADD COLUMN product_epoch integer NOT NULL DEFAULT 0 CHECK(product_epoch>=0);
ALTER TABLE billing.credit_transactions ADD COLUMN product_epoch integer NOT NULL DEFAULT 0 CHECK(product_epoch>=0);

CREATE FUNCTION billing.guard_credit_projection_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner identity.accounts;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'financial projection cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.user_id<>OLD.user_id OR NEW.product_epoch<>OLD.product_epoch OR NEW.created_at<>OLD.created_at) THEN
    RAISE EXCEPTION 'financial projection lifecycle is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM id FROM identity.users WHERE id=NEW.user_id FOR NO KEY UPDATE;
  SELECT * INTO owner FROM identity.accounts WHERE user_id=NEW.user_id FOR UPDATE;
  IF owner.user_id IS NULL OR owner.product_epoch<>NEW.product_epoch
    OR (TG_OP='INSERT' AND (owner.state='deleted' OR NEW.balance<>0 OR NEW.version<>1))
    OR (TG_OP='UPDATE' AND owner.state<>'active' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'financial projection lacks current lifecycle authority' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_projection_lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON billing.credit_accounts
FOR EACH ROW EXECUTE FUNCTION billing.guard_credit_projection_lifecycle();

CREATE FUNCTION billing.credit_lifecycle_source_is_current(credit billing.credit_transactions)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(
    SELECT 1 FROM identity.accounts owner JOIN billing.credit_accounts projection ON projection.user_id=owner.user_id
    WHERE owner.user_id=credit.user_id AND credit.credit_account_id=owner.user_id AND owner.state='active'
      AND owner.product_epoch=credit.product_epoch AND projection.product_epoch=credit.product_epoch
      AND (credit.pending_payment_id IS NULL OR EXISTS(
        SELECT 1 FROM billing.pending_payments intent WHERE intent.id=credit.pending_payment_id
          AND intent.user_id=credit.user_id AND intent.product_epoch=credit.product_epoch))
      AND (credit.payment_record_id IS NULL OR EXISTS(
        SELECT 1 FROM billing.payment_records payment JOIN billing.pending_payments intent ON intent.id=payment.pending_payment_id
        WHERE payment.id=credit.payment_record_id AND payment.user_id=credit.user_id
          AND intent.user_id=credit.user_id AND intent.product_epoch=credit.product_epoch))
  );
$$;

CREATE FUNCTION billing.guard_credit_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM identity.users WHERE id=NEW.user_id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id=NEW.user_id FOR UPDATE;
  IF NOT billing.credit_lifecycle_source_is_current(NEW) THEN
    RAISE EXCEPTION 'credit lacks original current lifecycle authority' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_lifecycle_guard BEFORE INSERT ON billing.credit_transactions
FOR EACH ROW EXECUTE FUNCTION billing.guard_credit_lifecycle();

CREATE FUNCTION billing.require_credit_lifecycle_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT billing.credit_lifecycle_source_is_current(NEW) THEN
    RAISE EXCEPTION 'credit lifecycle authority changed before commit' USING ERRCODE='40001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER credit_lifecycle_commit_guard AFTER INSERT ON billing.credit_transactions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.require_credit_lifecycle_commit();

COMMENT ON COLUMN billing.credit_transactions.product_epoch IS
  'Immutable original product-life provenance. Legacy financial facts remain epoch zero; no balance reset or history rewrite.';
