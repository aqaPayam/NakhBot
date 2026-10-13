DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'identity.deletion_private_photo_valid(uuid)'::regprocedure
      AND provolatile = 's' AND proparallel = 's'
  ) THEN
    RAISE EXCEPTION 'private photo custody read must be stable and parallel safe';
  END IF;
END $$;
