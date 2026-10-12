DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='chat.chat_cleanup_checkpoints'::regclass
    AND contype='f' AND confrelid='chat.chat_sessions'::regclass AND NOT condeferrable)
    OR position('FOR NO KEY UPDATE' in pg_get_functiondef('identity.guard_verified_product_write()'::regprocedure))=0
    OR position('lock_user_pair' in pg_get_functiondef('identity.guard_verified_product_write()'::regprocedure))=0 THEN
    RAISE EXCEPTION 'product write lock order or live-parent fence missing'; END IF;
END $$;
