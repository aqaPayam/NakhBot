DO $$ BEGIN
  IF position('BETWEEN 0 AND 10' in pg_get_functiondef('identity.require_deletion_product_batch()'::regprocedure))=0
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass AND tgname='account_deletion_product_batch_required'
      AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'typed transport batch authority incomplete'; END IF;
END $$;
