DO $$ BEGIN
 IF to_regprocedure('identity.finish_deletion_media_phase(uuid,uuid,uuid,integer,integer)') IS NULL
  OR position('media_objects' in pg_get_functiondef('identity.guard_deletion_checkpoint()'::regprocedure))=0
  OR position('deletion_media_blocker' in pg_get_functiondef('identity.require_deletion_phase_receipt()'::regprocedure))=0 THEN
  RAISE EXCEPTION 'verified media checkpoint executor or commit fence missing';
 END IF;
END $$;
