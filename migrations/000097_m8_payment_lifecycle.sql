-- Existing rows belong to the initial product life. M8 return is still disabled;
-- do not infer later-life ownership from mutable timestamps or transport rows.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM identity.account_deletion_records WHERE completed_at IS NOT NULL OR reactivation_allowed) THEN
    RAISE EXCEPTION 'legacy return requires explicit financial lifecycle provenance' USING ERRCODE='55000';
  END IF;
END $$;
ALTER TABLE identity.accounts ADD COLUMN product_epoch integer NOT NULL DEFAULT 0 CHECK(product_epoch>=0);
ALTER TABLE billing.pending_payments ADD COLUMN product_epoch integer NOT NULL DEFAULT 0 CHECK(product_epoch>=0);

CREATE FUNCTION identity.guard_account_product_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'stable account lifecycle cannot be deleted' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND NEW.user_id<>OLD.user_id THEN
    RAISE EXCEPTION 'account lifecycle owner is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.product_epoch<>0 THEN RAISE EXCEPTION 'account lifecycle admission invalid' USING ERRCODE='23514'; END IF;
  ELSIF OLD.state='deleted' AND NEW.state<>'deleted' THEN
    SELECT * INTO root FROM identity.account_deletion_records WHERE user_id=OLD.user_id ORDER BY requested_at DESC,id DESC LIMIT 1;
    IF NEW.state<>'guest' OR NEW.product_epoch<>OLD.product_epoch+1 OR NEW.version<>OLD.version+1
      OR root.id IS NULL OR root.phase<>'completed' OR root.checkpoint_version<>8 OR root.completed_at IS NULL
      OR NOT root.reactivation_allowed OR root.safety_bar<>'none'
      OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_work WHERE deletion_record_id=root.id AND phase='completed' AND checkpoint_version=8)
      OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=root.id
        AND completed_phase='verification' AND next_phase='completed' AND next_checkpoint_version=8) THEN
      RAISE EXCEPTION 'account return lacks verified lifecycle authority' USING ERRCODE='55000';
    END IF;
  ELSIF NEW.product_epoch<>OLD.product_epoch THEN
    RAISE EXCEPTION 'account lifecycle is immutable outside verified return' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_product_epoch_guard BEFORE INSERT OR UPDATE OR DELETE ON identity.accounts
  FOR EACH ROW EXECUTE FUNCTION identity.guard_account_product_epoch();

CREATE FUNCTION billing.guard_intent_product_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner identity.accounts;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.product_epoch<>OLD.product_epoch THEN
      RAISE EXCEPTION 'payment lifecycle is immutable' USING ERRCODE='55000';
    END IF;
  ELSE
    -- Normal paired writers already hold these locks; raw admission cannot
    -- commit a new intent behind a committing tombstone either.
    PERFORM id FROM identity.users WHERE id=NEW.user_id FOR NO KEY UPDATE;
    SELECT * INTO owner FROM identity.accounts WHERE user_id=NEW.user_id FOR UPDATE;
    IF owner.user_id IS NULL OR owner.state<>'active'
      OR (NEW.product_epoch<>0 AND NEW.product_epoch<>owner.product_epoch) THEN
      RAISE EXCEPTION 'payment lifecycle admission unavailable' USING ERRCODE='40001';
    END IF;
    NEW.product_epoch:=owner.product_epoch;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pending_payments_product_epoch_guard BEFORE INSERT OR UPDATE ON billing.pending_payments
  FOR EACH ROW EXECUTE FUNCTION billing.guard_intent_product_epoch();

CREATE FUNCTION billing.require_package_lifecycle_fulfillment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment billing.payment_records; intent billing.pending_payments; purchase billing.credit_transactions;
BEGIN
  IF OLD.state<>'fulfillment_pending' OR NEW.state NOT IN ('fulfilled','correction_required') THEN RETURN NULL; END IF;
  SELECT * INTO payment FROM billing.payment_records WHERE id=NEW.payment_record_id;
  IF payment.payment_type<>'buy_credit_package' THEN RETURN NULL; END IF;
  -- Application workers acquire these first. Deferred checks also serialize any
  -- direct SQL terminal transition with deletion rather than trusting a snapshot.
  PERFORM id FROM identity.users WHERE id=payment.user_id FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id=payment.user_id FOR UPDATE;
  SELECT * INTO intent FROM billing.pending_payments WHERE id=payment.pending_payment_id;
  IF OLD.lease_owner IS NULL OR OLD.lease_expires_at IS NULL OR clock_timestamp()>=OLD.lease_expires_at
    OR NEW.fence_token<>OLD.fence_token OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR intent.id IS NULL OR intent.user_id IS DISTINCT FROM payment.user_id OR intent.status<>'paid' OR payment.status<>'paid'
    OR intent.target_type<>'credit_package' OR intent.target_id IS DISTINCT FROM payment.credit_package_id
    OR payment.package_credit_amount_snapshot IS NULL
    OR intent.package_credit_amount_snapshot IS DISTINCT FROM payment.package_credit_amount_snapshot
    OR NOT EXISTS(SELECT 1 FROM billing.telegram_stars_receipts WHERE payment_record_id=payment.id
      AND payer_user_id=payment.user_id AND stars_amount=payment.stars_amount AND telegram_charge_id=payment.provider_payment_id) THEN
    RAISE EXCEPTION 'package fulfillment lifecycle chain incomplete' USING ERRCODE='23514';
  END IF;
  IF NEW.state='fulfilled' THEN
    SELECT * INTO purchase FROM billing.credit_transactions WHERE payment_record_id=payment.id AND transaction_type='purchase';
    IF purchase.id IS NULL OR purchase.user_id<>payment.user_id OR purchase.credit_account_id<>payment.user_id
      OR purchase.amount<>payment.package_credit_amount_snapshot
      OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=payment.user_id AND state='active' AND product_epoch=intent.product_epoch)
      OR NOT EXISTS(SELECT 1 FROM platform.outbox_events WHERE aggregate_type='credit_account' AND aggregate_id=payment.user_id
        AND event_type='billing.credit-increased.v1' AND payload=jsonb_build_object('creditTransactionId',purchase.id,
          'amount',purchase.amount::text,'balanceAfter',purchase.balance_after::text))
      OR NOT EXISTS(SELECT 1 FROM platform.outbox_events WHERE aggregate_type='payment_record' AND aggregate_id=payment.id
        AND event_type='billing.payment-fulfilled.v1' AND payload=jsonb_build_object('paymentRecordId',payment.id)) THEN
      RAISE EXCEPTION 'package purchase lacks current lifecycle or required events' USING ERRCODE='23514';
    END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=payment.user_id AND state='active' AND product_epoch=intent.product_epoch)
      OR EXISTS(SELECT 1 FROM billing.credit_transactions WHERE payment_record_id=payment.id AND transaction_type='purchase')
      OR NOT EXISTS(SELECT 1 FROM billing.refund_records WHERE payment_record_id=payment.id AND user_id=payment.user_id
        AND funding_type='telegram_stars' AND stars_amount=payment.stars_amount AND telegram_charge_id=payment.provider_payment_id
        AND reason_code='target_unavailable' AND idempotency_key='stars-refund:'||payment.id::text)
      OR NOT EXISTS(SELECT 1 FROM platform.outbox_events WHERE aggregate_type='payment_record' AND aggregate_id=payment.id
        AND event_type='billing.payment-correction-required.v1' AND payload=jsonb_build_object('paymentRecordId',payment.id)) THEN
      RAISE EXCEPTION 'unavailable package lacks original payment correction' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER package_lifecycle_fulfillment_required AFTER UPDATE ON billing.payment_fulfillments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.require_package_lifecycle_fulfillment();
