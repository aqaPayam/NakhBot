DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
    WHERE oid = 'moderation.admin_pair_target_id(uuid,uuid)'::regprocedure
      AND proparallel = 's' AND provolatile = 'i' AND proisstrict AND NOT prosecdef) THEN
    RAISE EXCEPTION 'canonical admin pair target execution properties are missing';
  END IF;
  IF moderation.admin_pair_target_id('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002')
    <> 'a2105599-16da-54f2-940a-967fe0a81907'::uuid THEN
    RAISE EXCEPTION 'canonical admin pair target binding changed';
  END IF;
END $$;
