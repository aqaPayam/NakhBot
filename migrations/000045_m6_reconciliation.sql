ALTER TABLE billing.reconciliation_runs
  DROP CONSTRAINT reconciliation_runs_run_type_check;
ALTER TABLE billing.reconciliation_runs
  ADD CONSTRAINT reconciliation_runs_run_type_check
  CHECK (run_type IN ('billing','nakh','chat'));

ALTER TABLE billing.reconciliation_anomalies
  DROP CONSTRAINT reconciliation_anomalies_entity_type_check;
ALTER TABLE billing.reconciliation_anomalies
  ADD CONSTRAINT reconciliation_anomalies_entity_type_check CHECK (entity_type IN (
    'payment_record','payment_fulfillment','credit_account','credit_transaction',
    'feature_unlock','refund_record','provider_event','nakh_flow','pending_nakh','nakh',
    'user_counter','chat_session','chat_message','match','notification_delivery'
  ));

COMMENT ON CONSTRAINT reconciliation_runs_run_type_check
  ON billing.reconciliation_runs IS
  'Permits the independently resumable billing, Nakh, and M6 chat integrity scanners.';
