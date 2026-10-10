-- Shared, set-based historical proof. No transcript, receipt or audit is changed.
-- Actual insertion/commit authority still uses the original volatile lease guard.
CREATE VIEW support.verified_deletion_thread_closures AS
SELECT receipt.support_thread_id,receipt.source_version
FROM support.deletion_thread_closures receipt
JOIN support.support_threads thread ON thread.id=receipt.support_thread_id
JOIN identity.account_deletion_records root ON root.id=receipt.deletion_record_id
JOIN platform.audit_logs audit ON audit.id=receipt.audit_id
WHERE thread.user_id=receipt.user_id AND thread.product_epoch=receipt.product_epoch
  AND thread.status='closed' AND thread.version=receipt.source_version+1 AND thread.closed_at=receipt.closed_at
  AND thread.last_message_at=receipt.source_last_message_at AND thread.created_at=receipt.source_created_at
  AND thread.open_command_id=receipt.source_open_command_id AND thread.open_request_digest=receipt.source_open_request_digest
  AND root.user_id=receipt.user_id AND root.product_epoch=receipt.product_epoch AND root.requested_at<=receipt.closed_at
  AND audit.category='account' AND audit.event_type='account.deletion-support-closed.v1'
  AND audit.actor_type='system' AND audit.actor_user_id IS NULL AND audit.actor_admin_id IS NULL
  AND audit.subject_type='account_deletion' AND audit.subject_id=root.id AND audit.result_code='support_scope_closed'
  AND audit.command_id=root.command_id AND audit.request_id=root.request_id AND audit.metadata_schema_version=1
  AND audit.metadata='{"kind":"support_scope","count":1}'::jsonb AND audit.occurred_at=receipt.closed_at;

CREATE OR REPLACE FUNCTION support.deletion_thread_has_bound_closure(subject uuid,original_version integer)
RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT EXISTS(SELECT 1 FROM support.verified_deletion_thread_closures proof
    WHERE proof.support_thread_id=subject AND proof.source_version=original_version)
$$;
COMMENT ON VIEW support.verified_deletion_thread_closures IS
  'Original closed-thread metadata, owning deletion life and exact content-free audit proof only; no live lease, transport lifetime, product access or retained release authority.';
