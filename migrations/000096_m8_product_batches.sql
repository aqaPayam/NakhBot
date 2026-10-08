-- Bounded ordinary-product batches are not phase completion. Their content-free
-- audit/event must commit under the same live phase-3 deletion fence.
CREATE FUNCTION identity.require_deletion_product_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE root identity.account_deletion_records; job identity.account_deletion_work;
  resource integer; removed integer; event uuid;
BEGIN
  IF NEW.event_type<>'account.deletion-product-batch.v1' THEN RETURN NULL; END IF;
  SELECT * INTO root FROM identity.account_deletion_records WHERE id=NEW.subject_id;
  SELECT * INTO job FROM identity.account_deletion_work WHERE deletion_record_id=root.id;
  resource:=(NEW.metadata->>'resource')::integer;
  removed:=(NEW.metadata->>'rows')::integer;
  event:=(NEW.metadata->>'eventId')::uuid;
  IF root.id IS NULL OR job.deletion_record_id IS NULL OR resource IS NULL OR resource NOT BETWEEN 0 AND 7
    OR removed IS NULL OR removed NOT BETWEEN 1 AND 100 OR event IS NULL
    OR root.phase<>'product_data' OR root.checkpoint_version<>3 OR root.checklist_version<>1
    OR root.product_purged_at IS NOT NULL OR root.completed_at IS NOT NULL OR root.reactivation_allowed
    OR job.phase<>root.phase OR job.checkpoint_version<>root.checkpoint_version
    OR job.lease_owner IS NULL OR job.lease_expires_at IS NULL OR job.lease_expires_at<=clock_timestamp()
    OR NEW.category<>'account' OR NEW.actor_type<>'system' OR NEW.actor_user_id IS NOT NULL OR NEW.actor_admin_id IS NOT NULL
    OR NEW.subject_type<>'account_deletion' OR NEW.result_code<>'product_batch_purged' OR NEW.metadata_schema_version<>1
    OR NEW.command_id IS DISTINCT FROM root.command_id OR NEW.request_id IS DISTINCT FROM root.request_id
    OR NEW.occurred_at>=job.lease_expires_at
    OR NEW.metadata IS DISTINCT FROM jsonb_build_object('resource',resource,'rows',removed,'eventId',event,
      'owner',job.lease_owner,'generation',job.lease_generation,'leaseExpiresAt',job.lease_expires_at)
    OR NOT EXISTS(SELECT 1 FROM identity.accounts WHERE user_id=root.user_id AND state='deleted' AND version=root.account_version)
    OR NOT EXISTS(SELECT 1 FROM identity.account_deletion_phase_receipts
      WHERE deletion_record_id=root.id AND completed_phase='evidence_capture' AND next_phase='product_data'
        AND from_checkpoint_version=2 AND next_checkpoint_version=3)
    OR NOT EXISTS(SELECT 1 FROM platform.outbox_events outbox WHERE outbox.id=event
      AND outbox.aggregate_type='account_deletion' AND outbox.aggregate_id=root.id
      AND outbox.event_type=NEW.event_type AND outbox.schema_version=1
      AND outbox.payload=jsonb_build_object('deletionRecordId',root.id,'resource',resource,'rows',removed,'auditId',NEW.id)
      AND outbox.occurred_at=NEW.occurred_at AND outbox.available_at=NEW.occurred_at
      AND outbox.correlation_id=root.request_id AND outbox.causation_id=root.command_id) THEN
    RAISE EXCEPTION 'deletion product batch chain incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_deletion_product_batch_required AFTER INSERT ON platform.audit_logs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.require_deletion_product_batch();
