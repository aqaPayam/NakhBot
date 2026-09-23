ALTER TABLE billing.reconciliation_runs
  DROP CONSTRAINT reconciliation_runs_run_type_check;
ALTER TABLE billing.reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_run_type_check
  CHECK (run_type IN ('billing','nakh'));

ALTER TABLE billing.reconciliation_anomalies
  DROP CONSTRAINT reconciliation_anomalies_entity_type_check;
ALTER TABLE billing.reconciliation_anomalies
  ADD CONSTRAINT reconciliation_anomalies_entity_type_check CHECK (entity_type IN (
    'payment_record','payment_fulfillment','credit_account','credit_transaction',
    'feature_unlock','refund_record','provider_event','nakh_flow','pending_nakh','nakh',
    'user_counter'
  ));

CREATE UNIQUE INDEX reconciliation_runs_active_type_idx
  ON billing.reconciliation_runs (run_type)
  WHERE status = 'started';

COMMENT ON INDEX billing.reconciliation_runs_active_type_idx IS
  'At most one resumable reconciliation cursor is active for each bounded scanner.';
