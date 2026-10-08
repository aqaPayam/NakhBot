DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='identity' AND table_name='accounts' AND column_name='product_epoch' AND is_nullable='NO')
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='billing' AND table_name='pending_payments' AND column_name='product_epoch' AND is_nullable='NO')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='identity.accounts'::regclass AND tgname='accounts_product_epoch_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.pending_payments'::regclass AND tgname='pending_payments_product_epoch_guard' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='billing.payment_fulfillments'::regclass
      AND tgname='package_lifecycle_fulfillment_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'payment product lifecycle safeguards missing';
  END IF;
END $$;
