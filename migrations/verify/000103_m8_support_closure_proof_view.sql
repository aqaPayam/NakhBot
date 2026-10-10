DO $$ BEGIN
  IF to_regclass('support.verified_deletion_thread_closures') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_proc
      WHERE oid='support.deletion_thread_has_bound_closure(uuid,integer)'::regprocedure
        AND provolatile='s' AND proparallel='s'
        AND prosrc LIKE '%support.verified_deletion_thread_closures%')
    OR NOT EXISTS(SELECT 1 FROM pg_proc
      WHERE oid='support.deletion_thread_lease_authority(support.deletion_thread_closures)'::regprocedure
        AND provolatile='v' AND proparallel='u') THEN
    RAISE EXCEPTION 'M8 shared support closure proof or actual lease authority is incomplete';
  END IF;
END $$;
