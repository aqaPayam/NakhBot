DO $$ BEGIN
  IF to_regprocedure('billing.pending_nakh_has_bound_closure(uuid)') IS NULL
    OR to_regprocedure('identity.deletion_has_unresolved_shared_payments(uuid)') IS NULL
    OR position('deletion_has_unresolved_shared_payments' IN pg_get_functiondef(
      'identity.deletion_has_open_shared_scopes(uuid)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'deletion financial closure verification missing';
  END IF;
END $$;
