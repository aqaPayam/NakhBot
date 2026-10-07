ALTER TABLE identity.account_deletion_work ADD COLUMN lease_generation integer NOT NULL DEFAULT 0
  CHECK (lease_generation >= 0);
ALTER TABLE identity.account_deletion_work ADD CONSTRAINT account_deletion_work_safe_error
  CHECK (last_error_code IS NULL OR last_error_code IN ('deletion_phase_failed',
    'deletion_provider_unavailable','deletion_evidence_pending','deletion_verification_failed'));
ALTER TABLE identity.account_deletion_records ADD CONSTRAINT account_deletion_record_safe_error
  CHECK (last_error_code IS NULL OR last_error_code IN ('deletion_phase_failed',
    'deletion_provider_unavailable','deletion_evidence_pending','deletion_verification_failed'));

CREATE FUNCTION identity.guard_deletion_work_lease() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.phase<>'shared_closure' OR NEW.checkpoint_version<>1 OR NEW.lease_generation<>0
      OR NEW.attempt_count<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
      OR NEW.last_error_code IS NOT NULL THEN
      RAISE EXCEPTION 'deletion work admission invalid' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  -- No phase executor is enabled yet. Verified phase receipts must be installed
  -- before phase advancement is available; leasing alone cannot complete purge.
  IF NEW.deletion_record_id<>OLD.deletion_record_id OR OLD.phase='completed'
    OR NEW.phase<>OLD.phase OR NEW.checkpoint_version<>OLD.checkpoint_version THEN
    RAISE EXCEPTION 'deletion work phase requires verified executor' USING ERRCODE='55000';
  END IF;
  IF NEW.lease_generation<>OLD.lease_generation THEN
    IF NEW.lease_generation<>OLD.lease_generation+1 OR NEW.attempt_count<>OLD.attempt_count+1
      OR (OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>at)
      OR NEW.lease_owner IS NULL OR NEW.lease_expires_at<=at
      OR NEW.lease_expires_at>at+interval '120 seconds'
      OR NEW.available_at IS DISTINCT FROM OLD.available_at
      OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code THEN
      RAISE EXCEPTION 'deletion work acquisition invalid' USING ERRCODE='55000';
    END IF;
  ELSE
    IF NEW.attempt_count<>OLD.attempt_count
      OR (NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS DISTINCT FROM OLD.lease_owner)
      OR (NEW.lease_owner IS NOT NULL AND (OLD.lease_expires_at<=at OR NEW.lease_expires_at<OLD.lease_expires_at
        OR NEW.lease_expires_at<=at OR NEW.lease_expires_at>at+interval '120 seconds'
        OR NEW.available_at IS DISTINCT FROM OLD.available_at
        OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code)) THEN
      RAISE EXCEPTION 'deletion work lease mutation invalid' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_deletion_work_lease_guard BEFORE INSERT OR UPDATE ON identity.account_deletion_work
  FOR EACH ROW EXECUTE FUNCTION identity.guard_deletion_work_lease();

CREATE FUNCTION identity.require_deletion_work_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE deletion_id uuid;
BEGIN
  IF TG_TABLE_NAME='account_deletion_work' THEN deletion_id := NEW.deletion_record_id;
  ELSE deletion_id := NEW.id; END IF;
  IF NOT EXISTS (SELECT 1 FROM identity.account_deletion_records record
    JOIN identity.account_deletion_work work ON work.deletion_record_id=record.id
    WHERE record.id=deletion_id AND record.phase=work.phase
      AND record.checkpoint_version=work.checkpoint_version
      AND record.last_error_code IS NOT DISTINCT FROM work.last_error_code) THEN
    RAISE EXCEPTION 'deletion work checkpoint mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_deletion_work_checkpoint_required AFTER INSERT OR UPDATE ON identity.account_deletion_work
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_deletion_work_checkpoint();
CREATE CONSTRAINT TRIGGER account_deletion_record_work_required AFTER INSERT OR UPDATE ON identity.account_deletion_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_deletion_work_checkpoint();

-- Fail migration on an unexplained legacy mismatch rather than inventing progress.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM identity.account_deletion_records record
    LEFT JOIN identity.account_deletion_work work ON work.deletion_record_id=record.id
    WHERE work.deletion_record_id IS NULL OR record.phase<>work.phase
      OR record.checkpoint_version<>work.checkpoint_version
      OR record.last_error_code IS DISTINCT FROM work.last_error_code) THEN
    RAISE EXCEPTION 'legacy deletion work checkpoint mismatch' USING ERRCODE='23514';
  END IF;
END $$;
