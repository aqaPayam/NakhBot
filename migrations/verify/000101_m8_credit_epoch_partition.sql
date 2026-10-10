DO $$ BEGIN
  IF to_regclass('billing.credit_epoch_accounts') IS NULL OR to_regclass('billing.credit_epoch_closures') IS NULL
    OR to_regprocedure('billing.prepare_deletion_credit_epoch(uuid,uuid,uuid,integer,integer)') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='billing.credit_transactions'::regclass AND conname='credit_transactions_epoch_version_unique')
    OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='billing.credit_transactions'::regclass AND conname='credit_transactions_epoch_account_fk')
    OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='billing.credit_transactions'::regclass AND conname='credit_transactions_credit_account_id_account_version_key')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_epoch_accounts'::regclass AND tgname='credit_epoch_account_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_accounts'::regclass AND tgname='credit_projection_epoch_required' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_transactions'::regclass AND tgname='credit_transaction_epoch_sequence_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_epoch_accounts'::regclass AND tgname='credit_epoch_chain_guard' AND tgdeferrable AND tginitdeferred AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_epoch_closures'::regclass AND tgname='credit_epoch_closure_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.credit_epoch_closures'::regclass AND tgname='credit_epoch_closure_commit_guard' AND tgdeferrable AND tginitdeferred AND tgenabled='O') THEN
    RAISE EXCEPTION 'M8 original credit epoch partition is incomplete';
  END IF;
END $$;
