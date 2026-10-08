DO $$ BEGIN
  IF to_regprocedure('identity.require_deletion_product_batch()') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform.audit_logs'::regclass
      AND tgname='account_deletion_product_batch_required' AND tgenabled='O' AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'deletion product batch commit fence missing';
  END IF;
END $$;
