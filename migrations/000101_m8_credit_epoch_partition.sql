-- Keep original financial facts in a per-life namespace. Current product
-- projection cutover is available only to a verified phase-3 deletion worker.
CREATE TABLE billing.credit_epoch_accounts (
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE RESTRICT,
  product_epoch integer NOT NULL CHECK(product_epoch>=0),
  balance bigint NOT NULL CHECK(balance>=0),
  version integer NOT NULL CHECK(version>=1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,product_epoch)
);
INSERT INTO billing.credit_epoch_accounts(user_id,product_epoch,balance,version,created_at,updated_at)
SELECT user_id,product_epoch,balance,version,created_at,updated_at FROM billing.credit_accounts;

-- Do not bless a historical gap or fabricated balance when moving namespaces.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM (
    SELECT account_version,balance_before,
      row_number() OVER(PARTITION BY credit_account_id,product_epoch ORDER BY account_version)+1 AS expected_version,
      lag(balance_after,1,0::bigint) OVER(PARTITION BY credit_account_id,product_epoch ORDER BY account_version) AS expected_before
    FROM billing.credit_transactions) chain
    WHERE account_version<>expected_version OR balance_before<>expected_before)
    OR EXISTS(SELECT 1 FROM billing.credit_epoch_accounts epoch
      LEFT JOIN LATERAL (SELECT account_version,balance_after FROM billing.credit_transactions credit
        WHERE credit.credit_account_id=epoch.user_id AND credit.product_epoch=epoch.product_epoch
        ORDER BY account_version DESC LIMIT 1) head ON true
      WHERE epoch.version<>COALESCE(head.account_version,1) OR epoch.balance<>COALESCE(head.balance_after,0)) THEN
    RAISE EXCEPTION 'legacy credit epoch chain is unexplained' USING ERRCODE='23514';
  END IF;
END $$;
ALTER TABLE billing.credit_transactions DROP CONSTRAINT credit_transactions_credit_account_id_account_version_key;
ALTER TABLE billing.credit_transactions ADD CONSTRAINT credit_transactions_epoch_version_unique
  UNIQUE(credit_account_id,product_epoch,account_version);
ALTER TABLE billing.credit_transactions ADD CONSTRAINT credit_transactions_epoch_account_fk
  FOREIGN KEY(credit_account_id,product_epoch) REFERENCES billing.credit_epoch_accounts(user_id,product_epoch) ON DELETE RESTRICT;

CREATE TABLE billing.credit_epoch_closures (
  deletion_record_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  product_epoch integer NOT NULL CHECK(product_epoch>=0),
  next_product_epoch integer NOT NULL CHECK(next_product_epoch=product_epoch+1),
  balance bigint NOT NULL CHECK(balance>=0),
  account_version integer NOT NULL CHECK(account_version>=1),
  projection_created_at timestamptz NOT NULL,
  projection_updated_at timestamptz NOT NULL,
  lease_owner uuid NOT NULL,
  lease_generation integer NOT NULL CHECK(lease_generation>=1),
  lease_expires_at timestamptz NOT NULL,
  prepared_at timestamptz NOT NULL CHECK(prepared_at<lease_expires_at),
  audit_id uuid NOT NULL UNIQUE REFERENCES platform.audit_logs(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  event_id uuid NOT NULL UNIQUE,
  UNIQUE(user_id,product_epoch),
  FOREIGN KEY(deletion_record_id,user_id) REFERENCES identity.account_deletion_records(id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY(user_id,product_epoch) REFERENCES billing.credit_epoch_accounts(user_id,product_epoch) ON DELETE RESTRICT
);

CREATE FUNCTION billing.deletion_credit_epoch_authority(receipt billing.credit_epoch_closures)
RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT 1 FROM identity.account_deletion_records root
    JOIN identity.accounts owner ON owner.user_id=root.user_id
    JOIN identity.account_deletion_work work ON work.deletion_record_id=root.id
    WHERE root.id=receipt.deletion_record_id AND root.user_id=receipt.user_id AND root.product_epoch=receipt.product_epoch
      AND owner.state='deleted' AND owner.product_epoch=root.product_epoch AND owner.version=root.account_version
      AND root.phase='product_data' AND root.checkpoint_version=3 AND root.checklist_version=1
      AND root.completed_at IS NULL AND root.product_purged_at IS NULL AND NOT root.reactivation_allowed
      AND work.phase=root.phase AND work.checkpoint_version=root.checkpoint_version
      AND work.lease_owner=receipt.lease_owner AND work.lease_generation=receipt.lease_generation
      AND work.lease_expires_at=receipt.lease_expires_at AND work.lease_expires_at>clock_timestamp()
      AND receipt.prepared_at>=root.requested_at AND receipt.prepared_at<=clock_timestamp()
      AND receipt.next_product_epoch=receipt.product_epoch+1
      AND EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts prior
        WHERE prior.deletion_record_id=root.id AND prior.completed_phase='evidence_capture'
          AND prior.next_phase='product_data' AND prior.from_checkpoint_version=2 AND prior.next_checkpoint_version=3))
$$;

CREATE FUNCTION billing.guard_credit_epoch_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'credit epoch closure is immutable' USING ERRCODE='55000'; END IF;
  IF NOT billing.deletion_credit_epoch_authority(NEW)
    OR NOT EXISTS(SELECT 1 FROM billing.credit_accounts projection
      JOIN billing.credit_epoch_accounts epoch ON epoch.user_id=projection.user_id AND epoch.product_epoch=projection.product_epoch
      WHERE projection.user_id=NEW.user_id AND projection.product_epoch=NEW.product_epoch
        AND projection.balance=NEW.balance AND projection.version=NEW.account_version
        AND projection.created_at=NEW.projection_created_at AND projection.updated_at=NEW.projection_updated_at
        AND epoch.balance=projection.balance AND epoch.version=projection.version
        AND epoch.created_at=projection.created_at AND epoch.updated_at=projection.updated_at) THEN
    RAISE EXCEPTION 'credit epoch closure lacks original financial authority' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_epoch_closure_guard BEFORE INSERT OR UPDATE OR DELETE ON billing.credit_epoch_closures
FOR EACH ROW EXECUTE FUNCTION billing.guard_credit_epoch_closure();

CREATE OR REPLACE FUNCTION billing.guard_credit_projection_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner identity.accounts; receipt billing.credit_epoch_closures;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'financial projection cannot be deleted' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND (NEW.user_id<>OLD.user_id OR NEW.created_at<>OLD.created_at) THEN
    RAISE EXCEPTION 'financial projection identity is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM id FROM identity.users WHERE id=NEW.user_id FOR NO KEY UPDATE;
  SELECT * INTO owner FROM identity.accounts WHERE user_id=NEW.user_id FOR UPDATE;
  IF TG_OP='UPDATE' AND NEW.product_epoch<>OLD.product_epoch THEN
    SELECT * INTO receipt FROM billing.credit_epoch_closures WHERE user_id=OLD.user_id AND product_epoch=OLD.product_epoch;
    IF receipt.deletion_record_id IS NULL OR NOT billing.deletion_credit_epoch_authority(receipt)
      OR NEW.product_epoch<>receipt.next_product_epoch OR NEW.balance<>0 OR NEW.version<>1
      OR NEW.updated_at<>receipt.prepared_at OR OLD.balance<>receipt.balance OR OLD.version<>receipt.account_version
      OR OLD.created_at<>receipt.projection_created_at OR OLD.updated_at<>receipt.projection_updated_at
      OR EXISTS(SELECT 1 FROM billing.credit_epoch_accounts WHERE user_id=NEW.user_id AND product_epoch=NEW.product_epoch)
      OR EXISTS(SELECT 1 FROM billing.credit_transactions WHERE credit_account_id=NEW.user_id AND product_epoch=NEW.product_epoch) THEN
      RAISE EXCEPTION 'financial cutover requires original verified deletion authority' USING ERRCODE='55000';
    END IF;
  ELSIF owner.user_id IS NULL OR owner.product_epoch<>NEW.product_epoch
    OR (TG_OP='INSERT' AND (owner.state='deleted' OR NEW.balance<>0 OR NEW.version<>1))
    OR (TG_OP='UPDATE' AND owner.state<>'active' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'financial projection lacks current lifecycle authority' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION billing.guard_credit_epoch_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'financial epoch requires controlled release' USING ERRCODE='55000'; END IF;
  IF TG_OP='UPDATE' AND (NEW.user_id<>OLD.user_id OR NEW.product_epoch<>OLD.product_epoch OR NEW.created_at<>OLD.created_at) THEN
    RAISE EXCEPTION 'financial epoch identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM billing.credit_accounts projection WHERE projection.user_id=NEW.user_id
    AND projection.product_epoch=NEW.product_epoch AND projection.balance=NEW.balance AND projection.version=NEW.version
    AND projection.created_at=NEW.created_at AND projection.updated_at=NEW.updated_at) THEN
    RAISE EXCEPTION 'financial epoch cannot be changed outside its current projection' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_epoch_account_guard BEFORE INSERT OR UPDATE OR DELETE ON billing.credit_epoch_accounts
FOR EACH ROW EXECUTE FUNCTION billing.guard_credit_epoch_account();
CREATE FUNCTION billing.mirror_credit_epoch_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing.credit_epoch_accounts(user_id,product_epoch,balance,version,created_at,updated_at)
  VALUES(NEW.user_id,NEW.product_epoch,NEW.balance,NEW.version,NEW.created_at,NEW.updated_at)
  ON CONFLICT(user_id,product_epoch) DO UPDATE SET balance=EXCLUDED.balance,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at;
  RETURN NULL;
END $$;
CREATE TRIGGER credit_projection_epoch_required AFTER INSERT OR UPDATE ON billing.credit_accounts
FOR EACH ROW EXECUTE FUNCTION billing.mirror_credit_epoch_account();

CREATE FUNCTION billing.require_credit_epoch_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE epoch billing.credit_epoch_accounts;
BEGIN
  -- Original User/Account admission is locked by credit_lifecycle_guard first.
  PERFORM user_id FROM billing.credit_accounts WHERE user_id=NEW.credit_account_id FOR UPDATE;
  SELECT * INTO epoch FROM billing.credit_epoch_accounts WHERE user_id=NEW.credit_account_id AND product_epoch=NEW.product_epoch FOR UPDATE;
  IF epoch.user_id IS NULL OR NEW.account_version<>epoch.version+1 OR NEW.balance_before<>epoch.balance THEN
    RAISE EXCEPTION 'credit epoch sequence is discontinuous' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credit_transaction_epoch_sequence_guard BEFORE INSERT ON billing.credit_transactions
FOR EACH ROW EXECUTE FUNCTION billing.require_credit_epoch_sequence();

CREATE OR REPLACE FUNCTION billing.verify_credit_account_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid; life integer; epoch billing.credit_epoch_accounts; projection billing.credit_accounts;
  latest_balance bigint; latest_version integer;
BEGIN
  subject:=COALESCE((to_jsonb(NEW)->>'credit_account_id')::uuid,(to_jsonb(NEW)->>'user_id')::uuid);
  life:=NEW.product_epoch;
  SELECT * INTO epoch FROM billing.credit_epoch_accounts WHERE user_id=subject AND product_epoch=life;
  SELECT balance_after,account_version INTO latest_balance,latest_version FROM billing.credit_transactions
    WHERE credit_account_id=subject AND product_epoch=life ORDER BY account_version DESC LIMIT 1;
  IF epoch.user_id IS NULL OR epoch.balance<>COALESCE(latest_balance,0) OR epoch.version<>COALESCE(latest_version,1) THEN
    RAISE EXCEPTION 'credit epoch and original ledger diverged' USING ERRCODE='23514';
  END IF;
  SELECT * INTO projection FROM billing.credit_accounts WHERE user_id=subject;
  IF projection.user_id IS NULL OR (projection.product_epoch=life AND
    (projection.balance<>epoch.balance OR projection.version<>epoch.version OR projection.created_at<>epoch.created_at OR projection.updated_at<>epoch.updated_at)) THEN
    RAISE EXCEPTION 'current credit projection and epoch diverged' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER credit_epoch_chain_guard AFTER INSERT OR UPDATE ON billing.credit_epoch_accounts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.verify_credit_account_chain();

CREATE FUNCTION billing.require_credit_epoch_closure_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT billing.deletion_credit_epoch_authority(NEW)
    OR NOT EXISTS(SELECT 1 FROM billing.credit_epoch_accounts epoch WHERE epoch.user_id=NEW.user_id AND epoch.product_epoch=NEW.product_epoch
      AND epoch.balance=NEW.balance AND epoch.version=NEW.account_version
      AND epoch.created_at=NEW.projection_created_at AND epoch.updated_at=NEW.projection_updated_at)
    OR NOT EXISTS(SELECT 1 FROM billing.credit_accounts projection WHERE projection.user_id=NEW.user_id
      AND projection.product_epoch=NEW.next_product_epoch AND projection.balance=0 AND projection.version=1
      AND projection.created_at=NEW.projection_created_at AND projection.updated_at=NEW.prepared_at)
    OR NOT EXISTS(SELECT 1 FROM billing.credit_epoch_accounts epoch WHERE epoch.user_id=NEW.user_id AND epoch.product_epoch=NEW.next_product_epoch
      AND epoch.balance=0 AND epoch.version=1 AND epoch.created_at=NEW.projection_created_at AND epoch.updated_at=NEW.prepared_at)
    OR EXISTS(SELECT 1 FROM billing.credit_transactions WHERE credit_account_id=NEW.user_id AND product_epoch=NEW.next_product_epoch)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_records root
      JOIN platform.audit_logs audit ON audit.id=NEW.audit_id JOIN platform.outbox_events event ON event.id=NEW.event_id
      WHERE root.id=NEW.deletion_record_id AND audit.category='account' AND audit.event_type='account.deletion-credit-epoch-prepared.v1'
        AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
        AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='credit_epoch_prepared'
        AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.metadata_schema_version=1
        AND audit.metadata='{"kind":"credit_epoch"}'::jsonb AND audit.occurred_at=NEW.prepared_at
        AND event.aggregate_type='account_deletion' AND event.aggregate_id=root.id
        AND event.event_type=audit.event_type AND event.schema_version=1
        AND event.payload=jsonb_build_object('deletionRecordId',root.id,'kind','credit_epoch')
        AND event.causation_id=root.command_id AND event.correlation_id=root.request_id
        AND event.occurred_at=NEW.prepared_at AND event.available_at=NEW.prepared_at) THEN
    RAISE EXCEPTION 'credit epoch preparation chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER credit_epoch_closure_commit_guard AFTER INSERT ON billing.credit_epoch_closures
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION billing.require_credit_epoch_closure_commit();

CREATE FUNCTION billing.prepare_deletion_credit_epoch(deletion_id uuid,subject uuid,worker uuid,generation integer,checkpoint integer)
RETURNS TABLE(replayed boolean) LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; work identity.account_deletion_work; projection billing.credit_accounts;
  epoch billing.credit_epoch_accounts; receipt billing.credit_epoch_closures; at timestamptz; audit uuid; event uuid;
BEGIN
  IF deletion_id IS NULL OR subject IS NULL OR worker IS NULL OR generation IS NULL OR generation<1 OR checkpoint IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'deletion financial work conflict' USING ERRCODE='40001';
  END IF;
  PERFORM id FROM identity.users WHERE id=subject FOR NO KEY UPDATE;
  PERFORM user_id FROM identity.accounts WHERE user_id=subject FOR UPDATE;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=deletion_id AND user_id=subject FOR UPDATE;
  IF root.id IS NULL THEN RAISE EXCEPTION 'deletion financial work conflict' USING ERRCODE='40001'; END IF;
  SELECT * INTO work FROM identity.account_deletion_work WHERE deletion_record_id=deletion_id FOR UPDATE;
  IF work.deletion_record_id IS NULL OR root.phase<>'product_data' OR root.checkpoint_version<>3 OR root.completed_at IS NOT NULL
    OR work.phase<>root.phase OR work.checkpoint_version<>root.checkpoint_version
    OR work.lease_owner IS DISTINCT FROM worker OR work.lease_generation<>generation
    OR work.lease_expires_at IS NULL OR work.lease_expires_at<=clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=subject AND state='deleted' AND version=root.account_version AND product_epoch=root.product_epoch) THEN
    RAISE EXCEPTION 'deletion financial work conflict' USING ERRCODE='40001';
  END IF;
  SELECT * INTO projection FROM billing.credit_accounts WHERE user_id=subject FOR UPDATE;
  SELECT * INTO epoch FROM billing.credit_epoch_accounts WHERE user_id=subject AND product_epoch=root.product_epoch FOR UPDATE;
  IF projection.user_id IS NULL OR epoch.user_id IS NULL THEN
    RAISE EXCEPTION 'deletion financial projection missing' USING ERRCODE='23514';
  END IF;
  SELECT * INTO receipt FROM billing.credit_epoch_closures WHERE deletion_record_id=deletion_id;
  IF receipt.deletion_record_id IS NOT NULL THEN
    IF receipt.user_id<>subject OR receipt.product_epoch<>root.product_epoch
      OR epoch.balance<>receipt.balance OR epoch.version<>receipt.account_version
      OR epoch.created_at<>receipt.projection_created_at OR epoch.updated_at<>receipt.projection_updated_at
      OR projection.product_epoch<>receipt.next_product_epoch OR projection.balance<>0 OR projection.version<>1
      OR projection.created_at<>receipt.projection_created_at OR projection.updated_at<>receipt.prepared_at
      OR NOT EXISTS(SELECT 1 FROM billing.credit_epoch_accounts next_epoch WHERE next_epoch.user_id=subject
        AND next_epoch.product_epoch=receipt.next_product_epoch AND next_epoch.balance=0 AND next_epoch.version=1
        AND next_epoch.created_at=receipt.projection_created_at AND next_epoch.updated_at=receipt.prepared_at)
      OR EXISTS(SELECT 1 FROM billing.credit_transactions WHERE credit_account_id=subject AND product_epoch=receipt.next_product_epoch) THEN
      RAISE EXCEPTION 'deletion financial replay binding changed' USING ERRCODE='23514';
    END IF;
    IF work.lease_expires_at<=clock_timestamp() THEN
      RAISE EXCEPTION 'deletion financial work conflict' USING ERRCODE='40001';
    END IF;
    RETURN QUERY SELECT true; RETURN;
  END IF;
  IF projection.product_epoch<>root.product_epoch OR epoch.balance<>projection.balance OR epoch.version<>projection.version
    OR epoch.created_at<>projection.created_at OR epoch.updated_at<>projection.updated_at THEN
    RAISE EXCEPTION 'deletion financial projection is unexplained' USING ERRCODE='23514';
  END IF;
  at:=clock_timestamp(); audit:=gen_random_uuid(); event:=gen_random_uuid();
  INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
  VALUES(audit,'account','account.deletion-credit-epoch-prepared.v1','system','account_deletion',root.id,'credit_epoch_prepared',1,
    '{"kind":"credit_epoch"}'::jsonb,root.command_id,root.request_id,at);
  INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,schema_version,payload,occurred_at,available_at,causation_id,correlation_id)
  VALUES(event,'account_deletion',root.id,'account.deletion-credit-epoch-prepared.v1',1,
    jsonb_build_object('deletionRecordId',root.id,'kind','credit_epoch'),at,at,root.command_id,root.request_id);
  INSERT INTO billing.credit_epoch_closures(deletion_record_id,user_id,product_epoch,next_product_epoch,balance,account_version,
    projection_created_at,projection_updated_at,lease_owner,lease_generation,lease_expires_at,prepared_at,audit_id,event_id)
  VALUES(root.id,subject,root.product_epoch,root.product_epoch+1,projection.balance,projection.version,
    projection.created_at,projection.updated_at,worker,generation,work.lease_expires_at,at,audit,event);
  UPDATE billing.credit_accounts SET product_epoch=root.product_epoch+1,balance=0,version=1,updated_at=at WHERE user_id=subject;
  RETURN QUERY SELECT false;
END $$;

COMMENT ON TABLE billing.credit_epoch_accounts IS 'Original per-product-life financial projection; closed-life balances and immutable transactions survive current-product reset.';
COMMENT ON TABLE billing.credit_epoch_closures IS 'Immutable original financial cutover under verified phase-3 work; does not complete deletion or grant return.';
