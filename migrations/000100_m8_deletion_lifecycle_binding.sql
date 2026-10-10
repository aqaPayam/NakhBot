-- Return is still disabled. Every existing deletion belongs to the initial
-- product life; reject unexplained legacy provenance rather than guessing it.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM identity.accounts WHERE product_epoch<>0)
    OR EXISTS(SELECT 1 FROM identity.account_deletion_records root
      LEFT JOIN identity.accounts owner ON owner.user_id=root.user_id
      WHERE root.completed_at IS NOT NULL OR root.reactivation_allowed OR owner.user_id IS NULL
        OR owner.state<>'deleted' OR owner.version<>root.account_version) THEN
    RAISE EXCEPTION 'legacy deletion lifecycle requires explicit provenance' USING ERRCODE='55000';
  END IF;
END $$;
ALTER TABLE identity.account_deletion_records ADD COLUMN product_epoch integer NOT NULL DEFAULT 0 CHECK(product_epoch>=0);
CREATE UNIQUE INDEX account_deletion_product_life_idx ON identity.account_deletion_records(user_id,product_epoch);

CREATE FUNCTION identity.guard_deletion_record_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner identity.accounts;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.product_epoch<>OLD.product_epoch THEN
      RAISE EXCEPTION 'original deletion lifecycle is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM id FROM identity.users WHERE id=NEW.user_id FOR NO KEY UPDATE;
  SELECT * INTO owner FROM identity.accounts WHERE user_id=NEW.user_id FOR UPDATE;
  IF owner.user_id IS NULL OR owner.state<>'deleted' OR owner.version<>NEW.account_version
    OR (NEW.product_epoch<>0 AND NEW.product_epoch<>owner.product_epoch) THEN
    RAISE EXCEPTION 'deletion lacks original lifecycle admission' USING ERRCODE='40001';
  END IF;
  -- The owning locked Account, never an input timestamp or caller value, stamps
  -- the original epoch. Zero is the legacy/default sentinel, not authority.
  NEW.product_epoch:=owner.product_epoch;
  RETURN NEW;
END $$;
CREATE TRIGGER account_deletion_epoch_guard BEFORE INSERT OR UPDATE ON identity.account_deletion_records
FOR EACH ROW EXECUTE FUNCTION identity.guard_deletion_record_epoch();

CREATE FUNCTION identity.require_pending_deletion_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject uuid;
BEGIN
  subject:=NEW.user_id;
  IF EXISTS(SELECT 1 FROM identity.account_deletion_records root
    LEFT JOIN identity.accounts owner ON owner.user_id=root.user_id
    WHERE root.user_id=subject AND root.completed_at IS NULL
      AND (owner.user_id IS NULL OR owner.state<>'deleted' OR owner.version<>root.account_version
        OR owner.product_epoch<>root.product_epoch)) THEN
    RAISE EXCEPTION 'pending deletion lifecycle authority changed' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_deletion_lifecycle_commit_guard AFTER INSERT OR UPDATE ON identity.account_deletion_records
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_pending_deletion_lifecycle();
CREATE CONSTRAINT TRIGGER accounts_pending_deletion_commit_guard AFTER UPDATE ON identity.accounts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_pending_deletion_lifecycle();

-- Keep the existing verified-return requirements, but select the exact original
-- lifecycle instead of whichever deletion sorts last by mutable chronology.
CREATE OR REPLACE FUNCTION identity.guard_account_product_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
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
    SELECT * INTO root FROM identity.account_deletion_records WHERE user_id=OLD.user_id AND product_epoch=OLD.product_epoch;
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

COMMENT ON COLUMN identity.account_deletion_records.product_epoch IS
  'Immutable original product life, stamped from the locked owning Account; never inferred from dates or reused for a later life.';
